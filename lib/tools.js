/**
 * Model-facing attach_* tools. Resolves originals from the session vault
 * under `$DSH_HOME/<vaultDir>/<sessionId>/`. Domain failures throw with a
 * clear message (isError path). attach_save is the only path into cwd.
 */

import { promises as fsp } from 'node:fs'
import path from 'node:path'
import { sanitizeSessionId } from './ingest.js'
import { extensionOf, formatNotebookCellFull, ocrPdfPage } from './extract.js'

export const UPLOAD_ID_RE = /^[0-9a-f]{12}$/

function defineTool({ name, description, parameters, execute }) {
  const properties = {}
  const required = []
  for (const [key, spec] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = spec
    properties[key] = rest
    if (isRequired) required.push(key)
  }
  const schema = { type: 'object', properties, required, additionalProperties: false }
  return {
    name,
    description,
    parameters: schema,
    inputSchema: schema,
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    execute,
  }
}

export function sessionCwd(exec) {
  return exec?.agent?.session?.header?.cwd
}

export function sessionIdOf(exec) {
  const id = exec?.agent?.session?.id ?? exec?.sessionId ?? exec?.agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function sessionVaultOf(vaultRoot, exec) {
  const sessionId = sessionIdOf(exec)
  if (sessionId === undefined) throw new Error('no session for this agent')
  return path.join(vaultRoot, sanitizeSessionId(sessionId))
}

export async function resolveUpload(sessionVault, id) {
  if (typeof id !== 'string' || id.trim() === '') {
    throw new Error('attachment id is required (12-character hex from the [attached file ... id=...] header, e.g. a1b2c3d4e5f6)')
  }
  const token = id.trim()
  if (UPLOAD_ID_RE.test(token)) {
    const dir = path.join(sessionVault, token)
    let names
    try {
      names = await fsp.readdir(dir)
    } catch {
      throw new Error(`unknown attachment id "${token}"`)
    }
    const file = names.find((n) => n !== 'extract.json' && n !== '.part')
    if (file === undefined) throw new Error(`attachment "${token}" has no file`)
    return {
      dir,
      name: file,
      abs: path.join(dir, file),
      id: token,
    }
  }
  return resolveUploadByName(sessionVault, token)
}

async function resolveUploadByName(sessionVault, nameOrPath) {
  const base = path.basename(String(nameOrPath).replace(/\\/g, '/'))
  if (base === '' || base === '.' || base === '..') {
    throw new Error(`unknown attachment "${nameOrPath}" — pass the hex id from the [attached file ... id=...] header (example: a1b2c3d4e5f6), not only the filename`)
  }
  let dirs
  try {
    dirs = await fsp.readdir(sessionVault)
  } catch {
    throw new Error(`unknown attachment "${base}"`)
  }
  const matches = []
  for (const dir of dirs) {
    if (!UPLOAD_ID_RE.test(dir)) continue
    const abs = path.join(sessionVault, dir, base)
    try {
      await fsp.stat(abs)
    } catch {
      continue
    }
    matches.push({
      dir: path.join(sessionVault, dir),
      name: base,
      abs,
      id: dir,
    })
  }
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    throw new Error(`unknown attachment "${base}" — use the 12-character hex id from the [attached file ... id=...] header (example: a1b2c3d4e5f6)`)
  }
  throw new Error(`multiple uploads named "${base}"; pass a hex id: ${matches.map((m) => m.id).join(', ')}`)
}

/** Resolve dest against cwd; refuse anything that escapes the workspace. */
export function resolveInsideCwd(cwd, dest) {
  const raw = String(dest ?? '')
  if (raw.trim() === '') throw new Error('path is required')
  const resolved = path.resolve(cwd, raw)
  const rel = path.relative(cwd, resolved)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`path "${dest}" escapes the session workspace`)
  }
  return { abs: resolved, rel: rel.split(path.sep).join('/') }
}

function requireCwd(exec) {
  const cwd = sessionCwd(exec)
  if (typeof cwd !== 'string' || cwd === '') {
    throw new Error('no session workspace for this agent')
  }
  return cwd
}

function requireUpload(vaultRoot, exec, id) {
  return resolveUpload(sessionVaultOf(vaultRoot, exec), id)
}

export function createAttachTools({ vaultRoot, ocrLanguages, describeProvider }) {
  return [
    defineTool({
      name: 'attach_notebook_output',
      description: 'Return the full text output of one cell in an attached Jupyter notebook. Example: {"id":"a1b2c3d4e5f6","cell":0}. id is the hex attachment_id from the [attached file ... id=...] header, not the .ipynb filename. The original stays outside the workspace until attach_save.',
      parameters: {
        id: { type: 'string', required: true, description: '12-character hex attachment id from the user message header (id=a1b2c3d4e5f6). A unique notebook filename is also accepted.' },
        cell: { type: 'number', required: true, description: '0-based cell index in the notebook cells array.' },
      },
      async execute(args, exec) {
        const file = await requireUpload(vaultRoot, exec, args.id)
        if (extensionOf(file.name) !== 'ipynb') {
          throw new Error(`attachment "${args.id}" is not a Jupyter notebook (got ${file.name})`)
        }
        const nb = JSON.parse(await fsp.readFile(file.abs, 'utf8'))
        const cells = Array.isArray(nb.cells) ? nb.cells : []
        const index = Number(args.cell)
        if (!Number.isInteger(index) || index < 0 || index >= cells.length) {
          throw new Error(`cell ${args.cell} is out of range (0–${Math.max(0, cells.length - 1)})`)
        }
        return formatNotebookCellFull(cells[index], index)
      },
    }),
    defineTool({
      name: 'attach_pdf_ocr_page',
      description: 'OCR one page of an attached PDF (scanned pages with no text layer). Example: {"id":"a1b2c3d4e5f6","page":1}. id is the hex attachment_id from the [attached file ... id=...] header, not the PDF filename.',
      parameters: {
        id: { type: 'string', required: true, description: '12-character hex attachment id from the user message header (id=a1b2c3d4e5f6). A unique PDF filename is also accepted.' },
        page: { type: 'number', required: true, description: '1-based page number to rasterize and OCR.' },
      },
      async execute(args, exec) {
        const file = await requireUpload(vaultRoot, exec, args.id)
        if (extensionOf(file.name) !== 'pdf') {
          throw new Error(`attachment "${args.id}" is not a PDF (got ${file.name})`)
        }
        const bytes = await fsp.readFile(file.abs)
        const result = await ocrPdfPage(bytes, Number(args.page), ocrLanguages)
        return result.text === '' ? `(no OCR text on page ${result.page})` : result.text
      },
    }),
    defineTool({
      name: 'attach_describe_image',
      description: 'Ask a subagent to describe an attached image using your prompt. Example: {"id":"a1b2c3d4e5f6","prompt":"List every visible UI label"}. id is the hex attachment_id from the [attached file ... id=...] header, not the image filename.',
      parameters: {
        id: { type: 'string', required: true, description: '12-character hex attachment id from the user message header (id=a1b2c3d4e5f6). A unique image filename is also accepted.' },
        prompt: { type: 'string', required: true, description: 'What the subagent should look for or describe in the image.' },
      },
      async execute(args, exec) {
        const file = await requireUpload(vaultRoot, exec, args.id)
        const subagents = exec?.ctx?.get?.('subagents') ?? exec?.agent?.ctx?.get?.('subagents')
        const runtime = exec?.subagents ?? subagents
        if (runtime == null || typeof runtime.start !== 'function') {
          throw new Error('subagent capability is not mounted')
        }
        if (typeof args.prompt !== 'string' || args.prompt.trim() === '') {
          throw new Error('prompt is required')
        }
        const bytes = await fsp.readFile(file.abs)
        const content = [{ type: 'text', text: args.prompt }]
        const attachments = exec?.attachments ?? exec?.ctx?.get?.('attachments')
        if (attachments != null && typeof attachments.saveImage === 'function') {
          const mime = mimeFromName(file.name)
          const attachment = await attachments.saveImage({
            data: new Uint8Array(bytes),
            mediaType: mime,
            name: file.name,
          })
          content.unshift({ type: 'image', attachment })
        } else {
          content.push({ type: 'text', text: `\nAttached image: ${file.name}` })
        }
        const parent = exec.agent
        const signal = exec.signal ?? new AbortController().signal
        const run = await runtime.start(describeProvider, {
          parent,
          signal,
          label: `describe ${file.name}`,
          prompt: content,
        })
        const result = await run.result
        if (result?.stopReason && result.stopReason !== 'completed') {
          const extra = result.diagnostic ? `: ${result.diagnostic}` : ''
          throw new Error(`subagent stopped (${result.stopReason})${extra}`)
        }
        return blocksToText(result?.output) || '(empty description)'
      },
    }),
    defineTool({
      name: 'attach_save',
      description: 'Copy an attached upload from the vault into the session workspace. Example: {"id":"a1b2c3d4e5f6","path":"docs/report.pdf"}. id is the hex attachment_id from the [attached file ... id=...] header (a unique filename also works). path is the destination inside the workspace.',
      parameters: {
        id: { type: 'string', required: true, description: '12-character hex attachment id from the user message header (id=a1b2c3d4e5f6). A unique original filename is also accepted.' },
        path: { type: 'string', required: true, description: 'Destination path relative to the session workspace, e.g. "docs/report.pdf".' },
      },
      async execute(args, exec) {
        const cwd = requireCwd(exec)
        const file = await requireUpload(vaultRoot, exec, args.id)
        const dest = resolveInsideCwd(cwd, args.path)
        await fsp.mkdir(path.dirname(dest.abs), { recursive: true })
        await fsp.copyFile(file.abs, dest.abs)
        return dest.rel
      },
    }),
  ]
}

function mimeFromName(name) {
  switch (extensionOf(name)) {
    case 'png': return 'image/png'
    case 'jpg':
    case 'jpeg': return 'image/jpeg'
    case 'webp': return 'image/webp'
    case 'gif': return 'image/gif'
    default: return 'application/octet-stream'
  }
}

function blocksToText(blocks) {
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return ''
  return blocks.map((block) => {
    if (typeof block === 'string') return block
    if (block?.type === 'text' && typeof block.text === 'string') return block.text
    if (typeof block?.text === 'string') return block.text
    return ''
  }).filter(Boolean).join('\n')
}

/**
 * Register the four attach_* tools. Returns a disposer that unregisters all.
 * `getSubagents` / `getAttachments` close over the plugin ctx so execute can
 * reach optional services without putting them on inject.
 */
export function registerAttachTools(ctx, limits) {
  const tools = createAttachTools({
    vaultRoot: limits.vaultRoot,
    ocrLanguages: limits.ocrLanguages,
    describeProvider: limits.describeProvider,
  })
  const disposers = tools.map((tool) => {
    const wrapped = {
      ...tool,
      execute: async (args, exec) => tool.execute(args, {
        ...exec,
        ctx,
        subagents: ctx.get?.('subagents'),
        attachments: ctx.get?.('attachments'),
      }),
    }
    return ctx.tools.register(wrapped)
  })
  return () => {
    for (const dispose of disposers) {
      if (typeof dispose === 'function') dispose()
    }
  }
}
