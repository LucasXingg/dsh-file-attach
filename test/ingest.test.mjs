import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyFile,
  isRasterImage,
  rasterMediaType,
  partitionIntake,
  modelSupportsVisual,
  sanitizeFileName,
  sanitizeSessionId,
  checkAdmission,
  defaultLimits,
  resolveDshHome,
  vaultUploadDir,
  modelForm,
  displayForm,
  stripExtractForDisplay,
  humanSize,
  chunkPlan,
  parseAttachLine,
} from '../lib/ingest.js'

test('classifyFile: built-in raster MIMEs are image, everything else is file', () => {
  assert.equal(classifyFile('image/png'), 'image')
  assert.equal(classifyFile('image/gif'), 'image')
  assert.equal(classifyFile('application/pdf'), 'file')
  assert.equal(classifyFile('text/x-python'), 'file')
  assert.equal(classifyFile(''), 'file')
})

test('isRasterImage and rasterMediaType honor MIME and filename extension', () => {
  assert.equal(isRasterImage({ mime: 'image/png', name: 'a.bin' }), true)
  assert.equal(isRasterImage({ mime: 'application/octet-stream', name: 'shot.PNG' }), true)
  assert.equal(isRasterImage({ mime: 'application/pdf', name: 'doc.pdf' }), false)
  assert.equal(rasterMediaType({ mime: 'image/webp', name: 'x' }), 'image/webp')
  assert.equal(rasterMediaType({ mime: '', name: 'photo.jpeg' }), 'image/jpeg')
  assert.equal(rasterMediaType({ mime: '', name: 'notes.txt' }), undefined)
})

test('partitionIntake splits rasters from other files', () => {
  const { images, others } = partitionIntake([
    { name: 'a.png', type: 'image/png' },
    { name: 'b.pdf', type: 'application/pdf' },
    { name: 'c.jpg', type: '' },
  ])
  assert.deepEqual(images.map((f) => f.name), ['a.png', 'c.jpg'])
  assert.deepEqual(others.map((f) => f.name), ['b.pdf'])
})

test('modelSupportsVisual is true only for an explicit image modality', () => {
  assert.equal(modelSupportsVisual({ inputModalities: ['text', 'image'] }), true)
  assert.equal(modelSupportsVisual({ inputModalities: ['image'] }), true)
  assert.equal(modelSupportsVisual({ inputModalities: ['text'] }), false)
  assert.equal(modelSupportsVisual({}), false)
  assert.equal(modelSupportsVisual(undefined), false)
})

test('sanitizeFileName: strips paths, control chars, leading dots; caps length; falls back', () => {
  assert.equal(sanitizeFileName('report.pdf'), 'report.pdf')
  assert.equal(sanitizeFileName('/etc/passwd'), 'passwd')
  assert.equal(sanitizeFileName('..\\..\\evil.exe'), 'evil.exe')
  assert.equal(sanitizeFileName('../.hidden'), 'hidden')
  assert.equal(sanitizeFileName('a\u0000b\u001fc.txt'), 'abc.txt')
  assert.equal(sanitizeFileName(''), 'file')
  assert.equal(sanitizeFileName('   '), 'file')
  assert.equal(sanitizeFileName('x'.repeat(500)), 'x'.repeat(200))
  assert.equal(sanitizeFileName(undefined), 'file')
})

test('checkAdmission: refuses empty and oversized; accepts images and others with a safe name', () => {
  const limits = defaultLimits({ maxFileBytes: 100 })
  assert.equal(checkAdmission({ name: 'a.png', mime: 'image/png', size: 10 }, limits).ok, true)
  assert.equal(checkAdmission({ name: 'a.pdf', mime: 'application/pdf', size: 0 }, limits).code, 'empty-file')
  assert.equal(checkAdmission({ name: 'a.pdf', mime: 'application/pdf', size: 101 }, limits).code, 'file-too-large')
  const ok = checkAdmission({ name: '/tmp/a.pdf', mime: 'application/pdf', size: 100 }, limits)
  assert.equal(ok.ok, true)
  assert.equal(ok.name, 'a.pdf')
  assert.equal(checkAdmission({ name: 'a.pdf', mime: 'application/pdf', size: NaN }, limits).code, 'invalid-size')
})

test('sanitizeSessionId and vaultUploadDir stay inside the vault', () => {
  assert.equal(sanitizeSessionId('s1'), 's1')
  assert.equal(sanitizeSessionId('../evil'), '___evil')
  assert.equal(sanitizeSessionId(''), 'session')
  assert.equal(
    vaultUploadDir('/tmp/dsh', 'file-attach', 's1', 'aaaaaaaaaaaa'),
    '/tmp/dsh/file-attach/s1/aaaaaaaaaaaa',
  )
  assert.equal(resolveDshHome({ env: { DSH_HOME: '/custom/home' }, home: '/Users/x' }), '/custom/home')
  assert.equal(resolveDshHome({ env: {}, home: '/Users/x' }), '/Users/x/.dsh')
})

test('modelForm: extract text is fenced; no vault path; degraded form names the id', () => {
  const rich = modelForm({
    id: 'ab12cd34',
    name: 'report.pdf',
    size: 2.4 * 1024 * 1024,
    extract: { kind: 'pdf', text: 'Hello PDF', truncated: false, notes: [] },
  })
  assert.match(rich, /\[attached file "report\.pdf" \(2\.4 MB\) id=ab12cd34\]/)
  assert.match(rich, /Hello PDF/)
  assert.doesNotMatch(rich, /pypdf|python-docx|openpyxl|file-attach|attachments\//)
  const plain = modelForm({ id: 'ab12cd34', name: 'main.py', size: 80 })
  assert.match(plain, /main\.py/)
  assert.doesNotMatch(plain, /attachments\/|file-attach/)
  const degraded = modelForm({ id: 'ab12cd34' })
  assert.match(degraded, /id=ab12cd34/)
  assert.match(degraded, /attach_\*/)
  assert.doesNotMatch(degraded, /attachments\/|file-attach/)
})

test('displayForm and stripExtractForDisplay hide extract from the UI projection', () => {
  const meta = {
    id: 'ab12cd34',
    name: 'report.pdf',
    size: 2.4 * 1024 * 1024,
    extract: { kind: 'pdf', text: 'Hello PDF', truncated: false, notes: [] },
  }
  const shown = displayForm(meta)
  assert.equal(shown, '[attached file "report.pdf" (2.4 MB) id=ab12cd34]')
  assert.doesNotMatch(shown, /Hello PDF|extracted content/)
  const stripped = stripExtractForDisplay('Ask about this\n' + modelForm(meta))
  assert.equal(stripped, 'Ask about this\n[attached file "report.pdf" (2.4 MB) id=ab12cd34]')
})

test('humanSize formats byte counts compactly', () => {
  assert.equal(humanSize(0), '0 B')
  assert.equal(humanSize(900), '900 B')
  assert.equal(humanSize(1024), '1.0 KB')
  assert.equal(humanSize(2.4 * 1024 * 1024), '2.4 MB')
})

test('chunkPlan splits into bounded ranges', () => {
  assert.deepEqual(chunkPlan(0, 10), [])
  assert.deepEqual(chunkPlan(5, 10), [{ start: 0, end: 5 }])
  const plan = chunkPlan(2500, 1000)
  assert.deepEqual(plan, [
    { start: 0, end: 1000 },
    { start: 1000, end: 2000 },
    { start: 2000, end: 2500 },
  ])
})

test('parseAttachLine extracts the ref from a leading /attach line', () => {
  assert.equal(parseAttachLine('/attach ab12cd34'), 'ab12cd34')
  assert.equal(parseAttachLine('/attach ab12cd34 '), 'ab12cd34')
  assert.equal(parseAttachLine('summarize /attach ab12cd34'), null)
  assert.equal(parseAttachLine('/goal build it'), null)
  assert.equal(parseAttachLine('/attach'), null)
})
