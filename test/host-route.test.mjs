import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'
import { setRecognizeImage } from '../lib/extract.js'

setRecognizeImage(async () => 'stub-ocr')

/**
 * Drive the real host plugin apply() with a stub ctx: a fake webServer that
 * captures registered routes, and fake agents/sessions that resolve one live
 * session ("s1") to a temp workspace cwd. Requests are simulated with a
 * Readable + minimal ServerResponse stand-in, so the route handlers run for
 * real (headers, chunk assembly, fs writes, atomic rename, JSON responses).
 */
function harness({ cwd, dshHome, config = {}, llm, agent }) {
  const routes = new Map()
  const disposers = []
  const tools = []
  const liveAgent = agent ?? { session: { header: { cwd } } }
  const ctx = {
    get(name) {
      if (name === 'agents') {
        return {
          get: (id) => (id === 's1' ? liveAgent : undefined),
        }
      }
      if (name === 'llm') return llm
      return undefined
    },
    webServer: {
      register(route) {
        assert(!routes.has(route.path), `duplicate route ${route.path}`)
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    tools: {
      register(def) {
        tools.push(def)
        return () => {}
      },
    },
    effect(callback) {
      const disposer = callback()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  apply(ctx, { dshHome, ...config })
  return { ctx, routes, disposers, tools, cwd, dshHome }
}

async function withDirs() {
  const cwd = await mkdtemp(path.join(tmpdir(), 'dsh-file-attach-cwd-'))
  const dshHome = await mkdtemp(path.join(tmpdir(), 'dsh-file-attach-home-'))
  return { cwd, dshHome }
}

async function cleanupDirs(cwd, dshHome) {
  await rm(cwd, { recursive: true, force: true })
  await rm(dshHome, { recursive: true, force: true })
}

function req({ method = 'POST', headers = {}, body = Buffer.alloc(0) }) {
  const stream = Readable.from([Buffer.isBuffer(body) ? body : Buffer.from(body)])
  stream.method = method
  stream.headers = headers
  return stream
}

function res() {
  const out = { statusCode: 0, headers: {}, body: '' }
  out.setHeader = (key, value) => { out.headers[key] = value }
  out.end = (data) => { out.body = data }
  return out
}

function uploadHeaders(sessionId, name, mime, size, index, count, uploadId) {
  const headers = {
    'x-session-id': sessionId,
    'x-file-name': encodeURIComponent(name),
    'x-file-type': mime,
    'x-file-size': String(size),
    'x-chunk-index': String(index),
    'x-chunk-count': String(count),
  }
  if (uploadId !== undefined) headers['x-upload-id'] = uploadId
  return headers
}

async function uploadAll(route, sessionId, name, mime, bytes, chunkBytes, uploadId) {
  const chunks = []
  for (let start = 0; start < bytes.length; start += chunkBytes) {
    chunks.push(bytes.subarray(start, Math.min(bytes.length, start + chunkBytes)))
  }
  let id = uploadId
  let last = null
  for (let i = 0; i < chunks.length; i += 1) {
    const response = res()
    await route.handler(req({ headers: uploadHeaders(sessionId, name, mime, bytes.length, i, chunks.length, id), body: chunks[i] }), response)
    assert.equal(response.statusCode, 200, `chunk ${i} failed: ${response.body}`)
    last = JSON.parse(response.body)
    if (id === undefined) id = last.id
  }
  return last
}

test('host plugin registers the three routes and teardown removes them', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome })
  assert.deepEqual([...h.routes.keys()].sort(), [
    '/api/dsh-file-attach/abort',
    '/api/dsh-file-attach/config',
    '/api/dsh-file-attach/extract',
    '/api/dsh-file-attach/upload',
    '/api/dsh-file-attach/vision',
  ])
  assert.equal(h.tools.length, 4)
  assert.equal(h.disposers.length, 1)
  h.disposers[0]()
  assert.equal(h.routes.size, 0)
  await cleanupDirs(cwd, dshHome)
})

test('chunked upload writes into the vault, not the session cwd', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const payload = Buffer.from('hello world, this is a pdf payload '.repeat(50))
  const result = await uploadAll(route, 's1', '../notes.txt', 'text/plain', payload, 127)
  assert.equal(result.name, 'notes.txt')
  assert.equal(result.relPath, undefined)
  assert.equal(result.extract.kind, 'text')
  assert.match(result.extract.text, /hello world/)
  const onDisk = await readFile(path.join(dshHome, 'file-attach', 's1', result.id, 'notes.txt'))
  assert.deepEqual(onDisk, payload)
  const extractOnDisk = JSON.parse(await readFile(path.join(dshHome, 'file-attach', 's1', result.id, 'extract.json'), 'utf8'))
  assert.equal(extractOnDisk.kind, 'text')
  await assert.rejects(() => access(path.join(cwd, 'attachments')), /ENOENT/)
  const cwdFiles = await readdirRecursive(cwd)
  assert.equal(cwdFiles.length, 0, 'session cwd stays empty')
  await cleanupDirs(cwd, dshHome)
})

test('unknown session is refused', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const response = res()
  await route.handler(req({ headers: uploadHeaders('nope', 'a.pdf', 'application/pdf', 5, 0, 1) }), response)
  assert.equal(response.statusCode, 404)
  const body = JSON.parse(response.body)
  assert.equal(body.error.code, 'session-not-found')
  await cleanupDirs(cwd, dshHome)
})

test('images are admitted and OCR text is returned on the extract', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome, config: { explainImages: false } })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
  const result = await uploadAll(route, 's1', 'a.png', 'image/png', payload, payload.length)
  assert.equal(result.name, 'a.png')
  assert.equal(result.extract.kind, 'image')
  assert.match(result.extract.text, /stub-ocr/)
  const extractRoute = h.routes.get('/api/dsh-file-attach/extract')
  const response = res()
  await extractRoute.handler(req({
    method: 'GET',
    headers: { 'x-session-id': 's1', 'x-upload-id': result.id },
  }), response)
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).kind, 'image')
  await cleanupDirs(cwd, dshHome)
})

test('oversized files are refused and the partial file is cleaned up', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome, config: { maxFileBytes: 100 } })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const response = res()
  await route.handler(req({ headers: uploadHeaders('s1', 'big.pdf', 'application/pdf', 101, 0, 1) }), response)
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error.code, 'file-too-large')
  await cleanupDirs(cwd, dshHome)
})

test('size mismatch on the final chunk is refused and cleaned up', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const response = res()
  await route.handler(req({ headers: uploadHeaders('s1', 'a.txt', 'text/plain', 10, 0, 1), body: Buffer.from('12345') }), response)
  assert.equal(response.statusCode, 400)
  assert.equal(JSON.parse(response.body).error.code, 'size-mismatch')
  const leftovers = await readdirRecursive(dshHome)
  assert.equal(leftovers.length, 0, 'no vault artifacts remain after a failed upload')
  await cleanupDirs(cwd, dshHome)
})

test('abort removes the partial upload from the vault', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome })
  const route = h.routes.get('/api/dsh-file-attach/upload')
  const first = res()
  await route.handler(req({ headers: uploadHeaders('s1', 'a.pdf', 'application/pdf', 2000, 0, 2), body: Buffer.alloc(1000) }), first)
  assert.equal(first.statusCode, 200)
  const id = JSON.parse(first.body).id
  const abort = res()
  await h.routes.get('/api/dsh-file-attach/abort').handler(req({ headers: { 'x-upload-id': id } }), abort)
  assert.equal(abort.statusCode, 200)
  const leftovers = await readdirRecursive(dshHome)
  assert.equal(leftovers.length, 0, 'aborted upload leaves no vault artifacts')
  await cleanupDirs(cwd, dshHome)
})

test('config route reports the deployment limits', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({ cwd, dshHome, config: { maxFileBytes: 123 } })
  const route = h.routes.get('/api/dsh-file-attach/config')
  const response = res()
  await route.handler(req({ method: 'GET' }), response)
  assert.equal(response.statusCode, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.maxFileBytes, 123)
  assert.equal(body.vaultDir, 'file-attach')
  assert.equal(body.uploadDir, undefined)
  await cleanupDirs(cwd, dshHome)
})

test('vision route reports explicit image-input models as visual', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({
    cwd,
    dshHome,
    agent: {
      options: { provider: 'deepseek', model: 'flash-vision' },
      session: {
        header: { cwd },
        requestHeader: () => ({ config: { provider: 'deepseek', model: 'flash-vision' } }),
      },
    },
    llm: {
      resolveModelInfo: async (provider, model) => ({
        provider,
        id: model,
        inputModalities: ['text', 'image'],
      }),
    },
  })
  const route = h.routes.get('/api/dsh-file-attach/vision')
  const ok = res()
  await route.handler(req({ method: 'GET', headers: { 'x-session-id': 's1' } }), ok)
  assert.equal(ok.statusCode, 200)
  assert.deepEqual(JSON.parse(ok.body), {
    visual: true,
    provider: 'deepseek',
    model: 'flash-vision',
  })

  const missing = res()
  await route.handler(req({ method: 'GET' }), missing)
  assert.equal(missing.statusCode, 400)
  assert.equal(JSON.parse(missing.body).error.code, 'missing-session')

  const unknown = res()
  await route.handler(req({ method: 'GET', headers: { 'x-session-id': 'nope' } }), unknown)
  assert.equal(unknown.statusCode, 404)
  await cleanupDirs(cwd, dshHome)
})

test('vision route is false for text-only models', async () => {
  const { cwd, dshHome } = await withDirs()
  const h = harness({
    cwd,
    dshHome,
    agent: {
      options: { provider: 'deepseek', model: 'flash' },
      session: { header: { cwd }, requestHeader: () => undefined },
    },
    llm: {
      resolveModelInfo: async () => ({ inputModalities: ['text'] }),
    },
  })
  const response = res()
  await h.routes.get('/api/dsh-file-attach/vision').handler(
    req({ method: 'GET', headers: { 'x-session-id': 's1' } }),
    response,
  )
  assert.equal(response.statusCode, 200)
  assert.equal(JSON.parse(response.body).visual, false)
  await cleanupDirs(cwd, dshHome)
})

async function readdirRecursive(dir) {
  const out = []
  const { readdir } = await import('node:fs/promises')
  async function walk(d) {
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(d, entry.name)
      if (entry.isDirectory()) await walk(full)
      else out.push(full)
    }
  }
  await walk(dir)
  return out
}
