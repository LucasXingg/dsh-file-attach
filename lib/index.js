/**
 * dsh-file-attach — HOST half.
 *
 * Registers ingest HTTP routes on `ctx.webServer` and attach_* tools on
 * `ctx.tools`. After a successful upload the host extracts file/image text
 * into extract.json. The composer filename is a short model reference; at
 * `agent/pre-step` the host appends every matching extract behind the user
 * prompt. The conversation UI hides that appendix.
 * Raster images skip this path when the session model declares image input
 * and use DSH's built-in composer vision pipeline instead.
 *
 *   POST /api/dsh-file-attach/upload
 *   POST /api/dsh-file-attach/abort
 *   GET  /api/dsh-file-attach/extract
 *   GET  /api/dsh-file-attach/config
 *   GET  /api/dsh-file-attach/vision
 *
 * Trust posture: the routes are same-origin with the web app and verify that
 * the target session exists, but carry no bearer credential — matching the
 * harness's local-loopback development posture. See README.
 */
import { randomUUID } from 'node:crypto'
import { promises as fsp } from 'node:fs'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'
import { checkAdmission, defaultLimits, resolveDshHome, vaultUploadDir, attachIdsInText, appendExtractsBehindPrompt } from './ingest.js'
import { extractUpload } from './extract.js'
import { registerAttachTools, UPLOAD_ID_RE } from './tools.js'
import { resolveSessionVisual } from './vision.js'

export const name = 'file-attach'

/** Required services: the host web server and the tool registry. */
export const inject = ['webServer', 'tools']

/** Deployment limits; all optional with defaults. */
export const Config = z.object({
  /** Maximum encoded bytes accepted for one file. */
  maxFileBytes: z.number().min(1).default(50 * 1024 * 1024),
  /** Maximum files admitted to one message (client-enforced; host mirrors it). */
  maxFilesPerMessage: z.number().min(1).default(20),
  /** Maximum concurrent upload sessions per host process. */
  maxConcurrentUploads: z.number().min(1).default(20),
  /** Subdirectory of `$DSH_HOME` that receives originals (outside the session cwd). */
  vaultDir: z.string().default('file-attach'),
  /** Maximum characters spliced into the model form. */
  maxExtractChars: z.number().min(1).default(80_000),
  /** Run a one-shot vision caption for images when ctx.llm is available. */
  explainImages: z.boolean().default(true),
  /** Tesseract language pack ids, e.g. eng+chi_sim. */
  ocrLanguages: z.string().default('eng+chi_sim'),
  /** Timeout for the optional image-explain LLM call. */
  explainTimeoutMs: z.number().min(1).default(30_000),
  /** Subagent provider name used by attach_describe_image. */
  describeProvider: z.string().default('spawn'),
  /** Composition default for the user-facing Develop mode setting. */
  developMode: z.boolean().default(false),
})

/** Settings namespace / Plugins-card key. Must match the browser half. */
export const SETTINGS_NS = 'file-attach'

/** User-editable subset served on the Plugins settings card. */
export const Settings = z.object({
  /** When true, the web client leaves plugin extract text visible in the conversation. */
  developMode: z.boolean().default(false),
})

/** How long an abandoned upload session lives before its partial file is swept. */
const UPLOAD_TTL_MS = 10 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 1000

/**
 * Mount the ingest routes.
 * @param ctx - cordis context with `webServer` injected.
 * @param rawConfig - parsed config (schemastery defaults applied by the loader).
 */
export function apply(ctx, config = {}) {
  // The loader validates `config` against Config (schemastery) before calling
  // apply, so defaults are already materialized; the spread below is only a
  // defensive fallback for loaders that skip schema validation.
  const limits = defaultLimits({
    ...config,
    vaultDir: config.vaultDir ?? 'file-attach',
    maxExtractChars: config.maxExtractChars,
    explainImages: config.explainImages,
    ocrLanguages: config.ocrLanguages,
    explainTimeoutMs: config.explainTimeoutMs,
    describeProvider: config.describeProvider,
  })
  let settingsSource = () => ({ developMode: config.developMode === true })
  const resolvedDevelopMode = () => {
    try {
      const value = settingsSource()
      return value != null && typeof value === 'object' && value.developMode === true
    } catch {
      return config.developMode === true
    }
  }
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (settingsCtx) => {
      if (settingsCtx?.settings == null || typeof settingsCtx.settings.installSection !== 'function') return
      settingsCtx.settings.installSection(ctx, SETTINGS_NS, Settings, {
        developMode: config.developMode === true,
      }, {
        setSource: (current) => { settingsSource = current },
        onChange: () => {},
      })
    })
  }
  const dshHome = typeof config.dshHome === 'string' && config.dshHome !== ''
    ? config.dshHome
    : resolveDshHome()
  const vaultRoot = path.join(dshHome, limits.vaultDir)
  /** uploadId -> upload session record */
  const uploads = new Map()

  /** Resolve the absolute workspace cwd of one session, or undefined. */
  const cwdOf = (sessionId) => {
    const agent = ctx.get('agents')?.get(sessionId)
    const cwd = agent?.session?.header?.cwd
    if (cwd !== undefined) return cwd
    const session = ctx.get('sessions')?.get(sessionId)
    return session?.header?.cwd
  }

  const respond = (res, status, body) => {
    res.statusCode = status
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }

  const reject = (res, status, code, message, extra = {}) =>
    respond(res, status, { error: { code, message, ...extra } })

  /** Read the request body up to a byte cap (protects against runaway bodies). */
  const readBody = (req, cap) => new Promise((resolve, reject) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > cap) {
        req.destroy()
        reject(new Error('request body exceeds cap'))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })

  const header = (req, name) => {
    const value = req.headers[name.toLowerCase()]
    return typeof value === 'string' ? value : undefined
  }

  const decodeName = (req) => {
    const raw = header(req, 'x-file-name')
    if (raw === undefined) return undefined
    try {
      return decodeURIComponent(raw)
    } catch {
      return undefined
    }
  }

  /** Remove every artifact of one upload session (partial + dir). */
  const cleanup = async (record) => {
    if (record === undefined) return
    uploads.delete(record.uploadId)
    try {
      await fsp.rm(record.dirPath, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }

  /** Serialize chunk appends per upload so interleaved requests cannot corrupt the file. */
  const appendChunk = (record, bytes) => {
    const chain = record.lock.then(async () => {
      await fsp.mkdir(record.dirPath, { recursive: true })
      await fsp.appendFile(record.partPath, bytes)
      record.received += bytes.length
      record.updatedAt = Date.now()
    })
    record.lock = chain.catch(() => {})
    return chain
  }

  const handleUpload = async (req, res) => {
    if (req.method !== 'POST') return reject(res, 405, 'method-not-allowed', 'use POST')
    const sessionId = header(req, 'x-session-id')
    if (sessionId === undefined) return reject(res, 400, 'missing-session', 'x-session-id header required')
    const cwd = cwdOf(sessionId)
    if (cwd === undefined) {
      return reject(res, 404, 'session-not-found', `session "${sessionId}" is not live`)
    }

    const chunkIndex = Number(header(req, 'x-chunk-index'))
    const chunkCount = Number(header(req, 'x-chunk-count'))
    if (!Number.isInteger(chunkIndex) || !Number.isInteger(chunkCount) || chunkIndex < 0 || chunkCount < 1 || chunkIndex >= chunkCount) {
      return reject(res, 400, 'invalid-chunk', 'x-chunk-index/x-chunk-count must be valid integers')
    }

    const uploadId = header(req, 'x-upload-id')
    let record = uploadId === undefined ? undefined : uploads.get(uploadId)

    if (record === undefined) {
      // First chunk: admit the file.
      if (uploads.size >= limits.maxConcurrentUploads) {
        return reject(res, 429, 'too-many-uploads', 'too many concurrent uploads')
      }
      const size = Number(header(req, 'x-file-size'))
      const name = decodeName(req)
      const admission = checkAdmission({ name, mime: header(req, 'x-file-type') ?? 'application/octet-stream', size }, limits)
      if (!admission.ok) {
        return reject(res, 400, admission.code, admission.message, admission.max === undefined ? {} : { max: admission.max })
      }
      if (chunkIndex !== 0) {
        return reject(res, 400, 'missing-upload', 'first chunk must carry index 0 to open an upload session')
      }
      const id = randomUUID().replace(/-/g, '').slice(0, 12)
      const dirPath = vaultUploadDir(dshHome, limits.vaultDir, sessionId, id)
      const partPath = path.join(dirPath, '.part')
      const finalPath = path.join(dirPath, admission.name)
      record = {
        uploadId: id, sessionId, size,
        name: admission.name,
        mime: header(req, 'x-file-type') ?? 'application/octet-stream',
        dirPath, partPath, finalPath,
        chunkCount, received: 0, updatedAt: Date.now(),
        lock: Promise.resolve(),
      }
      uploads.set(id, record)
    } else if (record.chunkCount !== chunkCount) {
      return reject(res, 400, 'chunk-mismatch', 'chunk-count does not match the open upload session')
    }

    if (chunkIndex > 0 && header(req, 'x-upload-id') === undefined) {
      return reject(res, 400, 'missing-upload-id', 'continuation chunks require x-upload-id')
    }

    try {
      const bytes = await readBody(req, limits.maxFileBytes + 1024 * 1024)
      await appendChunk(record, bytes)
      if (record.received > limits.maxFileBytes) {
        await cleanup(record)
        return reject(res, 413, 'file-too-large', `upload exceeds ${limits.maxFileBytes} bytes`)
      }
      if (chunkIndex === record.chunkCount - 1) {
        if (record.size > 0 && record.received !== record.size) {
          await cleanup(record)
          return reject(res, 400, 'size-mismatch', `received ${record.received} bytes, expected ${record.size}`)
        }
        await fsp.rename(record.partPath, record.finalPath)
        let extract
        try {
          const stored = await fsp.readFile(record.finalPath)
          extract = await extractUpload(stored, {
            name: record.name,
            mime: record.mime,
            limits,
            ctx,
          })
        } catch (error) {
          extract = {
            kind: 'error',
            truncated: false,
            notes: [`extraction failed: ${error instanceof Error ? error.message : String(error)}`],
            text: error instanceof Error ? error.message : String(error),
          }
        }
        await fsp.writeFile(path.join(record.dirPath, 'extract.json'), JSON.stringify(extract), 'utf8')
        const result = { id: record.uploadId, name: record.name, size: record.received, extract }
        uploads.delete(record.uploadId)
        return respond(res, 200, result)
      }
      return respond(res, 200, { id: record.uploadId, received: record.received, total: record.size })
    } catch (error) {
      await cleanup(record)
      return reject(res, 500, 'upload-failed', error instanceof Error ? error.message : String(error))
    }
  }

  const handleAbort = async (req, res) => {
    if (req.method !== 'POST') return reject(res, 405, 'method-not-allowed', 'use POST')
    const uploadId = header(req, 'x-upload-id')
    if (uploadId === undefined) return reject(res, 400, 'missing-upload-id', 'x-upload-id header required')
    await cleanup(uploads.get(uploadId))
    return respond(res, 200, { aborted: true })
  }

  const handleExtract = async (req, res) => {
    if (req.method !== 'GET') return reject(res, 405, 'method-not-allowed', 'use GET')
    const sessionId = header(req, 'x-session-id')
    if (sessionId === undefined) return reject(res, 400, 'missing-session', 'x-session-id header required')
    const cwd = cwdOf(sessionId)
    if (cwd === undefined) {
      return reject(res, 404, 'session-not-found', `session "${sessionId}" is not live`)
    }
    const uploadId = header(req, 'x-upload-id')
    if (uploadId === undefined || !UPLOAD_ID_RE.test(uploadId)) {
      return reject(res, 400, 'missing-upload-id', 'x-upload-id header required')
    }
    const extractPath = path.join(vaultUploadDir(dshHome, limits.vaultDir, sessionId, uploadId), 'extract.json')
    try {
      const raw = await fsp.readFile(extractPath, 'utf8')
      return respond(res, 200, JSON.parse(raw))
    } catch {
      return reject(res, 404, 'extract-not-found', `no extract for "${uploadId}"`)
    }
  }

  const handleConfig = (req, res) => {
    if (req.method !== 'GET') return reject(res, 405, 'method-not-allowed', 'use GET')
    return respond(res, 200, {
      maxFileBytes: limits.maxFileBytes,
      maxFilesPerMessage: limits.maxFilesPerMessage,
      maxConcurrentUploads: limits.maxConcurrentUploads,
      vaultDir: limits.vaultDir,
      maxExtractChars: limits.maxExtractChars,
      explainImages: limits.explainImages,
      ocrLanguages: limits.ocrLanguages,
      developMode: resolvedDevelopMode(),
      imageMediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    })
  }

  const handleVision = async (req, res) => {
    if (req.method !== 'GET') return reject(res, 405, 'method-not-allowed', 'use GET')
    const sessionId = header(req, 'x-session-id')
    if (sessionId === undefined) return reject(res, 400, 'missing-session', 'x-session-id header required')
    const cwd = cwdOf(sessionId)
    if (cwd === undefined) {
      return reject(res, 404, 'session-not-found', `session "${sessionId}" is not live`)
    }
    try {
      const hinted = {
        provider: header(req, 'x-provider'),
        model: header(req, 'x-model'),
      }
      const result = await resolveSessionVisual(ctx, sessionId, hinted)
      return respond(res, 200, result)
    } catch (error) {
      return reject(res, 500, 'vision-lookup-failed', error instanceof Error ? error.message : String(error))
    }
  }

  const uploadRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-file-attach/upload',
    handler: handleUpload,
  })
  const abortRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-file-attach/abort',
    handler: handleAbort,
  })
  const extractRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-file-attach/extract',
    handler: handleExtract,
  })
  const configRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-file-attach/config',
    handler: handleConfig,
  })
  const visionRoute = ctx.webServer.register({
    kind: 'exact',
    path: '/api/dsh-file-attach/vision',
    handler: handleVision,
  })

  const unregisterTools = registerAttachTools(ctx, { ...limits, vaultRoot })

  async function loadVaultMeta(sessionId, uploadId) {
    if (!UPLOAD_ID_RE.test(uploadId)) return undefined
    const dir = vaultUploadDir(dshHome, limits.vaultDir, sessionId, uploadId)
    let extract
    try {
      extract = JSON.parse(await fsp.readFile(path.join(dir, 'extract.json'), 'utf8'))
    } catch {
      return undefined
    }
    let names
    try {
      names = await fsp.readdir(dir)
    } catch {
      return undefined
    }
    const name = names.find((entry) => entry !== 'extract.json' && entry !== '.part')
    if (name === undefined) return undefined
    let size
    try {
      size = (await fsp.stat(path.join(dir, name))).size
    } catch {
      size = undefined
    }
    return { id: uploadId, name, size, extract }
  }

  function collectMessageText(content) {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .map((block) => (block != null && block.type === 'text' && typeof block.text === 'string' ? block.text : ''))
      .join('\n')
  }

  function putMessageText(message, nextText) {
    const content = message.content
    if (typeof content === 'string') {
      return Object.assign({}, message, { content: nextText })
    }
    if (!Array.isArray(content)) {
      return Object.assign({}, message, { content: [{ type: 'text', text: nextText }] })
    }
    const others = content.filter((block) => block != null && block.type !== 'text')
    return Object.assign({}, message, { content: [{ type: 'text', text: nextText }, ...others] })
  }

  function agentSessionId(agent) {
    const id = agent?.session?.id ?? agent?.id
    return typeof id === 'string' && id !== '' ? id : undefined
  }

  async function rewriteUserMessage(sessionId, message) {
    const original = collectMessageText(message.content)
    const ids = attachIdsInText(original)
    if (ids.length === 0) return message
    const metas = []
    for (const id of ids) {
      const meta = await loadVaultMeta(sessionId, id)
      if (meta !== undefined) metas.push(meta)
    }
    const next = appendExtractsBehindPrompt(original, metas)
    if (next === original) return message
    return putMessageText(message, next)
  }

  const offPreStep = typeof ctx.on === 'function'
    ? ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()
      if (decision == null || decision.kind !== 'enter' || !Array.isArray(decision.messages)) {
        return decision
      }
      const sessionId = agentSessionId(payload && payload.agent)
      if (sessionId === undefined) return decision
      const messages = []
      for (const message of decision.messages) {
        messages.push(await rewriteUserMessage(sessionId, message))
      }
      return Object.assign({}, decision, { messages })
    })
    : undefined

  // Sweep abandoned upload sessions (partial files) periodically. unref so the
  // timer never pins the process; plugin teardown clears it explicitly.
  const sweep = setInterval(() => {
    const now = Date.now()
    for (const record of uploads.values()) {
      if (now - record.updatedAt > UPLOAD_TTL_MS) void cleanup(record)
    }
  }, SWEEP_INTERVAL_MS)
  sweep.unref?.()

  ctx.effect(() => () => {
    clearInterval(sweep)
    uploadRoute()
    abortRoute()
    extractRoute()
    configRoute()
    visionRoute()
    unregisterTools()
    if (typeof offPreStep === 'function') offPreStep()
    for (const record of uploads.values()) void cleanup(record)
  }, 'file-attach: routes + sweep teardown')
}
