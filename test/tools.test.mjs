import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createAttachTools, resolveInsideCwd, resolveUpload } from '../lib/tools.js'
import { setRecognizeImage, setRasterPdfPage } from '../lib/extract.js'

function toolMap(vaultRoot) {
  const list = createAttachTools({
    vaultRoot,
    ocrLanguages: 'eng',
    describeProvider: 'spawn',
  })
  return Object.fromEntries(list.map((t) => [t.name, t]))
}

function execFor(cwd, extra = {}) {
  return {
    agent: { session: { id: extra.sessionId ?? 's1', header: { cwd } } },
    signal: AbortSignal.timeout(5_000),
    ...extra,
  }
}

async function seedUpload(vaultRoot, sessionId, id, name, contents) {
  const dir = path.join(vaultRoot, sessionId, id)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, name), contents)
  return path.join(dir, name)
}

test('resolveInsideCwd refuses parent-directory escape', () => {
  const cwd = '/tmp/ws'
  assert.equal(resolveInsideCwd(cwd, 'out/a.txt').rel, 'out/a.txt')
  assert.throws(() => resolveInsideCwd(cwd, '../secret'), /escapes/)
  assert.throws(() => resolveInsideCwd(cwd, '/etc/passwd'), /escapes/)
})

test('attach_notebook_output returns full cell text including omitted mime notes', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  const nb = {
    cells: [
      {
        cell_type: 'code',
        source: 'print("hi")',
        outputs: [
          { output_type: 'stream', name: 'stdout', text: 'line-a\nline-b\nline-c\n' },
          { output_type: 'display_data', data: { 'image/png': 'xxxx' } },
        ],
      },
    ],
  }
  await seedUpload(vaultRoot, 's1', 'aaaaaaaaaaaa', 'nb.ipynb', JSON.stringify(nb))
  const out = await toolMap(vaultRoot).attach_notebook_output.execute(
    { id: 'aaaaaaaaaaaa', cell: 0 },
    execFor(cwd),
  )
  assert.match(out, /line-a/)
  assert.match(out, /line-c/)
  assert.match(out, /image\/png omitted/)
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})

test('attach_pdf_ocr_page rasterizes then OCRs via hooks', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'bbbbbbbbbbbb', 'scan.pdf', '%PDF-fake')
  setRasterPdfPage(async (_bytes, page) => {
    assert.equal(page, 2)
    return new Uint8Array([1, 2, 3])
  })
  setRecognizeImage(async () => 'PAGE TWO TEXT')
  const out = await toolMap(vaultRoot).attach_pdf_ocr_page.execute(
    { id: 'bbbbbbbbbbbb', page: 2 },
    execFor(cwd),
  )
  assert.equal(out, 'PAGE TWO TEXT')
  setRasterPdfPage(null)
  setRecognizeImage(null)
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})

test('attach_describe_image starts a subagent with the LLM prompt', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'cccccccccccc', 'cat.png', 'png-bytes')
  const starts = []
  const subagents = {
    async start(provider, request) {
      starts.push({ provider, request })
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          output: [{ type: 'text', text: 'a tabby cat' }],
        }),
      }
    },
  }
  const out = await toolMap(vaultRoot).attach_describe_image.execute(
    { id: 'cccccccccccc', prompt: 'What animal is this?' },
    execFor(cwd, { subagents }),
  )
  assert.equal(out, 'a tabby cat')
  assert.equal(starts.length, 1)
  assert.equal(starts[0].provider, 'spawn')
  const promptText = starts[0].request.prompt.map((b) => b.text).join(' ')
  assert.match(promptText, /What animal is this/)
  assert.match(promptText, /cat\.png/)
  assert.doesNotMatch(promptText, /file-attach|\/s1\/|attachments\//)
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})

test('attach_describe_image fails loud when subagents are missing', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'dddddddddddd', 'cat.png', 'png')
  await assert.rejects(
    () => toolMap(vaultRoot).attach_describe_image.execute(
      { id: 'dddddddddddd', prompt: 'describe' },
      execFor(cwd),
    ),
    /subagent capability is not mounted/,
  )
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})

test('attach_save copies from the vault into cwd and refuses cwd escape', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'eeeeeeeeeeee', 'report.pdf', 'PDFBYTES')
  const tools = toolMap(vaultRoot)
  const saved = await tools.attach_save.execute(
    { id: 'eeeeeeeeeeee', path: 'kept/report.pdf' },
    execFor(cwd),
  )
  assert.equal(saved, 'kept/report.pdf')
  assert.equal(await readFile(path.join(cwd, saved), 'utf8'), 'PDFBYTES')
  await assert.rejects(
    () => tools.attach_save.execute({ id: 'eeeeeeeeeeee', path: '../out.pdf' }, execFor(cwd)),
    /escapes/,
  )
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})

test('resolveUpload rejects missing names and accepts a unique filename', async () => {
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'eeeeeeeeeeee', 'report.pdf', 'PDFBYTES')
  const sessionVault = path.join(vaultRoot, 's1')
  await assert.rejects(() => resolveUpload(sessionVault, 'nope'), /unknown attachment/)
  const byName = await resolveUpload(sessionVault, 'report.pdf')
  assert.equal(byName.name, 'report.pdf')
  assert.equal(byName.id, 'eeeeeeeeeeee')
  await rm(vaultRoot, { recursive: true, force: true })
})

test('attach_save accepts a unique filename as id', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'attach-tools-'))
  const vaultRoot = await mkdtemp(path.join(tmpdir(), 'attach-vault-'))
  await seedUpload(vaultRoot, 's1', 'ffffffffffff', 'SlideScholar_PreProposal.pdf', 'PDFBYTES')
  const saved = await toolMap(vaultRoot).attach_save.execute(
    { id: 'SlideScholar_PreProposal.pdf', path: 'SlideScholar_PreProposal.pdf' },
    execFor(cwd),
  )
  assert.equal(saved, 'SlideScholar_PreProposal.pdf')
  assert.equal(await readFile(path.join(cwd, saved), 'utf8'), 'PDFBYTES')
  await rm(cwd, { recursive: true, force: true })
  await rm(vaultRoot, { recursive: true, force: true })
})
