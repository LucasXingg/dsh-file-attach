/**
 * Host-side extraction: turn uploaded bytes into model-visible text.
 *
 * Heavy backends (tesseract, unpdf, mammoth, exceljs) are loaded lazily so
 * unit tests can stub `recognizeImage` / `rasterPdfPage` without downloading
 * OCR data. Extract failure is never fatal — callers persist the notes.
 */

import { IMAGE_MEDIA_TYPES } from './ingest.js'

const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'css',
  'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt',
  'c', 'h', 'cc', 'cpp', 'hpp', 'cs', 'php', 'sh', 'bash', 'zsh', 'fish',
  'yml', 'yaml', 'toml', 'ini', 'cfg', 'env', 'log', 'sql', 'r', 'swift',
  'lua', 'vue', 'svelte', 'scss', 'less', 'gradle', 'properties', 'gitignore',
])

/** @type {(bytes: Uint8Array, langs: string) => Promise<string>} */
export let recognizeImage = recognizeImageDefault
/** @type {(bytes: Uint8Array, page: number) => Promise<Uint8Array>} */
export let rasterPdfPage = rasterPdfPageDefault

export function setRecognizeImage(fn) {
  recognizeImage = fn ?? recognizeImageDefault
}

export function setRasterPdfPage(fn) {
  rasterPdfPage = fn ?? rasterPdfPageDefault
}

/** Last two lines of a text blob (trailing whitespace stripped first). */
export function lastTwoLines(text) {
  const trimmed = String(text).replace(/\s+$/u, '')
  if (trimmed === '') return ''
  const lines = trimmed.split('\n')
  return lines.slice(-2).join('\n')
}

export function extensionOf(name) {
  const base = String(name ?? '')
  const dot = base.lastIndexOf('.')
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
}

/**
 * pdf.js/unpdf reject Node Buffer even though it subclasses Uint8Array.
 * Copy into a standalone Uint8Array so pooled Buffers cannot leak extra bytes.
 */
export function asUint8Array(bytes) {
  if (bytes instanceof Uint8Array && bytes.constructor === Uint8Array
      && bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes
  }
  return Uint8Array.from(bytes)
}

export function capText(text, maxChars) {
  const value = String(text ?? '')
  if (!Number.isFinite(maxChars) || maxChars <= 0 || value.length <= maxChars) {
    return { text: value, truncated: false }
  }
  return {
    text: `${value.slice(0, maxChars)}\n…[truncated at ${maxChars} characters]`,
    truncated: true,
  }
}

/** Decode bytes as UTF-8, replacing invalid sequences rather than throwing. */
export function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

function estimateMimeBytes(value) {
  if (typeof value === 'string') return Buffer.byteLength(value)
  if (Array.isArray(value)) return Buffer.byteLength(value.join(''))
  try {
    return Buffer.byteLength(JSON.stringify(value))
  } catch {
    return 0
  }
}

function sourceOf(cell) {
  return Array.isArray(cell.source) ? cell.source.join('') : String(cell.source ?? '')
}

function textFromOutput(output) {
  if (output == null || typeof output !== 'object') return ''
  if (output.output_type === 'stream') {
    return Array.isArray(output.text) ? output.text.join('') : String(output.text ?? '')
  }
  if (output.output_type === 'execute_result' || output.output_type === 'display_data') {
    const data = output.data ?? {}
    const plain = data['text/plain']
    if (typeof plain === 'string') return plain
    if (Array.isArray(plain)) return plain.join('')
    return ''
  }
  if (output.output_type === 'error') {
    const trace = Array.isArray(output.traceback) ? output.traceback.join('\n') : ''
    return trace || [output.ename, output.evalue].filter(Boolean).join(': ')
  }
  return ''
}

function omittedMimeLines(output) {
  const lines = []
  const data = output?.data
  if (data == null || typeof data !== 'object') return lines
  for (const [mime, value] of Object.entries(data)) {
    if (mime === 'text/plain') continue
    lines.push(`[${mime} omitted, ${estimateMimeBytes(value)} bytes]`)
  }
  return lines
}

/**
 * Full text of one notebook cell, including every text output.
 * Binary mime bundles are listed by type and size, not dumped as base64.
 */
export function formatNotebookCellFull(cell, index) {
  const kind = cell?.cell_type || 'code'
  const parts = [`## cell ${index} (${kind})`, sourceOf(cell || {})]
  for (const output of cell?.outputs ?? []) {
    const text = textFromOutput(output)
    if (text !== '') {
      parts.push('--- output ---', text)
    }
    parts.push(...omittedMimeLines(output))
  }
  return parts.filter((part, i) => part !== '' || i === 0).join('\n')
}

function notebookPreview(nb) {
  const cells = Array.isArray(nb?.cells) ? nb.cells : []
  const parts = []
  cells.forEach((cell, index) => {
    const kind = cell.cell_type || 'code'
    parts.push(`## cell ${index} (${kind})`)
    parts.push(sourceOf(cell))
    const texts = (cell.outputs ?? [])
      .filter((output) => output?.output_type !== 'display_data')
      .map(textFromOutput)
      .filter((t) => t !== '')
    if (texts.length > 0) {
      const preview = lastTwoLines(texts.join('\n'))
      if (preview !== '') parts.push('--- output (last 2 lines) ---', preview)
    }
  })
  return parts.join('\n')
}

function probeImage(bytes) {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: view.getUint32(16), height: view.getUint32(20), format: 'png' }
  }
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: bytes[6] + bytes[7] * 256, height: bytes[8] + bytes[9] * 256, format: 'gif' }
  }
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    return { format: 'webp' }
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return { format: 'jpeg' }
  }
  return {}
}

async function extractPdfText(bytes) {
  const { extractText } = await import('unpdf')
  const result = await extractText(asUint8Array(bytes), { mergePages: true })
  const text = typeof result.text === 'string' ? result.text : (result.text ?? []).join('\n\n')
  return { text: text.trim(), totalPages: result.totalPages }
}

async function extractDocx(bytes) {
  const mammoth = (await import('mammoth')).default ?? await import('mammoth')
  const result = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
  return String(result.value ?? '').trim()
}

async function extractXlsx(bytes) {
  const ExcelJS = (await import('exceljs')).default
  const workbook = new ExcelJS.Workbook()
  // exceljs accepts a Buffer; Uint8Array is fine on Node 22+.
  await workbook.xlsx.load(Buffer.from(bytes))
  const sheets = []
  workbook.eachSheet((sheet) => {
    const rows = []
    sheet.eachRow((row) => {
      const cells = []
      row.eachCell({ includeEmpty: true }, (cell) => {
        const v = cell.value
        cells.push(v == null ? '' : typeof v === 'object' && v.text != null ? String(v.text) : String(v))
      })
      rows.push(cells.join('\t'))
    })
    sheets.push(`# ${sheet.name}\n${rows.join('\n')}`)
  })
  return sheets.join('\n\n')
}

async function extractPptx(bytes) {
  const JSZip = (await import('jszip')).default
  const zip = await JSZip.loadAsync(bytes)
  const names = Object.keys(zip.files)
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/i.test(n))
    .sort((a, b) => {
      const na = Number(/slide(\d+)\.xml/i.exec(a)?.[1] ?? 0)
      const nb = Number(/slide(\d+)\.xml/i.exec(b)?.[1] ?? 0)
      return na - nb
    })
  const slides = []
  for (const name of names) {
    const xml = await zip.files[name].async('string')
    const text = xml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    const n = /slide(\d+)\.xml/i.exec(name)?.[1] ?? '?'
    slides.push(`# slide ${n}\n${text}`)
  }
  return slides.join('\n\n')
}

let ocrWorker
let ocrLangs

async function recognizeImageDefault(bytes, langs) {
  const { createWorker } = await import('tesseract.js')
  if (ocrWorker === undefined || ocrLangs !== langs) {
    if (ocrWorker !== undefined) {
      try { await ocrWorker.terminate() } catch { /* ignore */ }
    }
    ocrLangs = langs
    ocrWorker = await createWorker(langs)
  }
  const { data } = await ocrWorker.recognize(Buffer.from(bytes))
  return String(data?.text ?? '').trim()
}

async function rasterPdfPageDefault(bytes, page) {
  const { renderPageAsImage } = await import('unpdf')
  const buffer = await renderPageAsImage(asUint8Array(bytes), page, {
    canvasImport: () => import('@napi-rs/canvas'),
    scale: 2,
  })
  return new Uint8Array(buffer)
}

function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return String(blocks ?? '')
  return blocks.map((block) => {
    if (typeof block === 'string') return block
    if (block == null) return ''
    if (typeof block.text === 'string') return block.text
    if (block.type === 'text' && typeof block.text === 'string') return block.text
    return ''
  }).filter(Boolean).join('\n')
}

/**
 * Best-effort one-shot vision caption. Never attached to a session id, so it
 * does not become a conversation turn. Returns '' when llm/attachments/model
 * identity are missing or the call fails.
 */
export async function explainImageWithLlm(ctx, bytes, mime, name, limits) {
  const llm = ctx?.get?.('llm')
  if (llm == null || typeof llm.stream !== 'function') return ''
  const attachments = ctx?.get?.('attachments')
  const providers = typeof llm.listProviders === 'function' ? llm.listProviders() : []
  const provider = providers[0]?.id ?? providers[0]?.name ?? providers[0]
  if (provider == null || provider === '') return ''
  let model
  if (typeof llm.listModels === 'function') {
    const models = await llm.listModels(String(provider))
    model = models?.[0]?.id ?? models?.[0]?.name ?? models?.[0]
  }
  if (model == null || model === '') return ''

  const prompt = 'Describe this image for a colleague who cannot see it. Include visible text, layout, and notable objects. Be concise.'
  let content
  if (attachments != null && typeof attachments.saveImage === 'function') {
    const attachment = await attachments.saveImage({
      data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
      mediaType: mime || 'image/png',
      name,
    })
    content = [
      { type: 'image', attachment },
      { type: 'text', text: prompt },
    ]
  } else {
    return ''
  }

  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), limits.explainTimeoutMs ?? 30_000)
  try {
    const messages = [{ role: 'user', content }]
    let text = ''
    for await (const chunk of llm.stream({
      provider: String(provider),
      model: String(model),
      messages,
      signal: ac.signal,
    })) {
      if (chunk?.type === 'text-delta') text += chunk.text ?? ''
      if (chunk?.type === 'finish') break
    }
    return text.trim()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Extract one uploaded file into `{ kind, truncated, notes, text }`.
 */
export async function extractUpload(bytes, { name, mime, limits, ctx } = {}) {
  bytes = asUint8Array(bytes)
  const notes = []
  const maxChars = limits?.maxExtractChars ?? 80_000
  const ext = extensionOf(name)
  const isImage = IMAGE_MEDIA_TYPES.includes(mime) || ['png', 'jpg', 'jpeg', 'webp', 'gif'].includes(ext)

  const finish = (kind, raw) => {
    const capped = capText(raw, maxChars)
    if (capped.truncated) notes.push(`truncated at ${maxChars} characters`)
    return { kind, truncated: capped.truncated, notes, text: capped.text }
  }

  try {
    if (ext === 'ipynb') {
      const nb = JSON.parse(decodeUtf8(bytes))
      return finish('ipynb', notebookPreview(nb))
    }
    if (ext === 'pdf' || mime === 'application/pdf') {
      const { text, totalPages } = await extractPdfText(bytes)
      if (text === '') {
        notes.push(`PDF has no text layer (${totalPages} page(s)); it may be scanned. Use attach_pdf_ocr_page for a page.`)
      }
      return finish('pdf', text === '' ? notes[notes.length - 1] : text)
    }
    if (ext === 'docx' || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
      return finish('docx', await extractDocx(bytes))
    }
    if (ext === 'xlsx' || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') {
      return finish('xlsx', await extractXlsx(bytes))
    }
    if (ext === 'pptx' || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
      return finish('pptx', await extractPptx(bytes))
    }
    if (isImage) {
      const probe = probeImage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))
      const header = [
        `image ${probe.format ?? mime ?? 'raster'}`,
        probe.width && probe.height ? `${probe.width}×${probe.height}` : null,
      ].filter(Boolean).join(', ')
      let ocr = ''
      try {
        ocr = await recognizeImage(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), limits?.ocrLanguages ?? 'eng+chi_sim')
      } catch (error) {
        notes.push(`OCR failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      let explanation = ''
      if (limits?.explainImages !== false) {
        try {
          explanation = await explainImageWithLlm(ctx, bytes, mime, name, limits)
        } catch (error) {
          notes.push(`image explain skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
      const body = [
        header,
        ocr ? `OCR:\n${ocr}` : 'OCR: (no text)',
        explanation ? `Description:\n${explanation}` : null,
      ].filter(Boolean).join('\n\n')
      return finish('image', body)
    }
    if (TEXT_EXTENSIONS.has(ext) || (typeof mime === 'string' && mime.startsWith('text/'))) {
      return finish('text', decodeUtf8(bytes))
    }
    notes.push(`no text extractor for .${ext || 'unknown'} (${mime || 'application/octet-stream'})`)
    return finish('binary', notes[notes.length - 1])
  } catch (error) {
    notes.push(`extraction failed: ${error instanceof Error ? error.message : String(error)}`)
    return { kind: 'error', truncated: false, notes, text: notes.join('\n') }
  }
}

/** Rasterize one PDF page (1-based) and OCR it. */
export async function ocrPdfPage(bytes, page, langs = 'eng+chi_sim') {
  if (!Number.isInteger(page) || page < 1) {
    throw new Error('page must be a 1-based integer')
  }
  const png = await rasterPdfPage(asUint8Array(bytes), page)
  const text = await recognizeImage(png, langs)
  return { page, text: text.trim() }
}
