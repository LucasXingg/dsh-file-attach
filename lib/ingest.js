/**
 * Pure, harness-free ingest logic for dsh-file-attach.
 *
 * Everything here is deterministic and side-effect free (or takes a directory
 * root as an argument) so it can be unit-tested without booting the harness.
 * The plugin (lib/index.js) owns the route plumbing, session-cwd resolution,
 * and the fs calls; this module owns the decisions.
 */

import path from 'node:path'
import { homedir } from 'node:os'

/** Raster image MIME types this plugin OCRs and explains (no longer passed through). */
export const IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** Default limits, overridable by plugin config. */
export function defaultLimits(overrides = {}) {
  const limits = {
    maxFileBytes: 50 * 1024 * 1024,
    maxFilesPerMessage: 20,
    maxConcurrentUploads: 20,
    vaultDir: 'file-attach',
    chunkBytes: 1024 * 1024,
    maxExtractChars: 80_000,
    explainImages: true,
    ocrLanguages: 'eng+chi_sim',
    explainTimeoutMs: 30_000,
    describeProvider: 'spawn',
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) limits[key] = value
  }
  return limits
}

/** Harness home: `$DSH_HOME` or `~/.dsh`. */
export function resolveDshHome({ env = process.env, home = homedir() } = {}) {
  const fromEnv = env?.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(home, '.dsh')
}

/**
 * Reduce a session id to a single path segment. Drops separators and `..`
 * so the vault cannot escape `$DSH_HOME/<vaultDir>`.
 */
export function sanitizeSessionId(sessionId) {
  const cleaned = String(sessionId ?? '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 200)
  return cleaned === '' || cleaned === '_' ? 'session' : cleaned
}

/** `$DSH_HOME/<vaultDir>/<sessionId>/<uploadId>`. */
export function vaultUploadDir(dshHome, vaultDir, sessionId, uploadId) {
  return path.join(dshHome, vaultDir, sanitizeSessionId(sessionId), uploadId)
}

/** 'image' when the declared MIME is one of the built-in raster types, else 'file'. */
export function classifyFile(mime) {
  return IMAGE_MEDIA_TYPES.includes(mime) ? 'image' : 'file'
}

/**
 * Reduce a user-supplied file name to a safe basename: strips any directory
 * components (both separators), control characters, and leading dots; caps the
 * length; falls back to "file". Never returns a path, only a basename.
 */
export function sanitizeFileName(name) {
  const raw = String(name ?? '')
  const base = raw.replace(/\\/g, '/').split('/').pop() ?? ''
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').replace(/^\.+/, '').trim()
  const capped = cleaned.slice(0, 200)
  return capped === '' ? 'file' : capped
}

/**
 * Admission decision for one file before any bytes are accepted.
 * Images are admitted — this plugin OCRs and explains them.
 */
export function checkAdmission({ name, mime, size }, limits) {
  const safeName = sanitizeFileName(name)
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
    return { ok: false, code: 'invalid-size', message: 'file size is not a valid number' }
  }
  if (size === 0) {
    return { ok: false, code: 'empty-file', message: `"${safeName}" is empty` }
  }
  if (size > limits.maxFileBytes) {
    return {
      ok: false, code: 'file-too-large', message: `"${safeName}" exceeds ${limits.maxFileBytes} bytes`,
      max: limits.maxFileBytes,
    }
  }
  return { ok: true, name: safeName }
}

/** Marker wrapping extract text in the model form. Hidden in the conversation UI. */
export const EXTRACT_FENCE_START = '----- extracted content -----'
export const EXTRACT_FENCE_END = '----- end -----'
const EXTRACT_FENCE_RE = /\r?\n----- extracted content -----\r?\n[\s\S]*?\r?\n----- end -----/g

/** Header line shared by the model form and the user-visible display form. */
function attachHeader(meta) {
  const idBit = meta.id ? ` id=${meta.id}` : ''
  if (meta.name === undefined) {
    return `[attached file${idBit} — extraction unavailable after reload; use attach_* tools with id ${meta.id}]`
  }
  const sizeBit = meta.size !== undefined ? ` (${humanSize(meta.size)})` : ''
  return `[attached file "${meta.name}"${sizeBit}${idBit}]`
}

/**
 * User-visible form of one attachment: the header only, never the extract
 * fence. Vault paths are never included.
 * @param meta - `{ id, name, size, extract }`.
 */
export function displayForm(meta) {
  return attachHeader(meta)
}

/**
 * The model-visible form of one attachment: extracted text when present,
 * otherwise a degraded id hint. Vault paths are never included.
 * @param meta - `{ id, name, size, extract }`.
 */
export function modelForm(meta) {
  const header = attachHeader(meta)
  const extractText = meta?.extract?.text
  if (typeof extractText === 'string' && meta.name !== undefined) {
    return `${header}\n${EXTRACT_FENCE_START}\n${extractText}\n${EXTRACT_FENCE_END}`
  }
  return header
}

/** Drop extract fences so conversation UI can show the header without the prompt body. */
export function stripExtractForDisplay(text) {
  EXTRACT_FENCE_RE.lastIndex = 0
  return String(text).replace(EXTRACT_FENCE_RE, '')
}

/** Compact human-readable byte count (e.g. "2.4 MB"). */
export function humanSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`
}

/** Chunk plan for one file: zero-based [start, end) byte ranges of at most chunkBytes. */
export function chunkPlan(size, chunkBytes) {
  const plan = []
  if (size <= 0) return plan
  for (let start = 0; start < size; start += chunkBytes) {
    plan.push({ start, end: Math.min(size, start + chunkBytes) })
  }
  return plan
}

/**
 * End-of-draft insertion span for a reference chip.
 * @param draft - the live draft text.
 * @param draftRev - the live monotonic draft revision (CAS guard).
 * @returns a TokenSpan placing the placeholder at the end of the draft.
 */
export function endOfDraftSpan(draft, draftRev) {
  const at = typeof draft === 'string' ? draft.length : 0
  return { start: at, end: at, draftRev }
}

/**
 * Parse a trimmed draft line as a plain-text `/attach <id>` reference.
 * @returns the ref, or null when the line is not an attach line.
 */
export function parseAttachLine(line) {
  const m = /^\/attach\s+(\S+)\s*$/.exec(String(line).trim())
  return m === null ? null : m[1]
}
