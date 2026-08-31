import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** Load the two plain client sources exactly as the build script inlines them. */
function loadClient() {
  const core = readFileSync(path.join(root, 'src', 'client-core.js'), 'utf8')
  const app = readFileSync(path.join(root, 'src', 'client-app.js'), 'utf8')
  // eslint-disable-next-line no-new-func
  const factory = new Function(`${core}\n${app}\n;return { Core: FileAttachCore, build: buildFileAttachPlugin }`)
  return factory()
}

const { Core, build } = loadClient()

// ── pure core ───────────────────────────────────────────────────────────────

test('Core.classifyFile mirrors the built-in image MIME set', () => {
  assert.equal(Core.classifyFile('image/png'), 'image')
  assert.equal(Core.classifyFile('image/gif'), 'image')
  assert.equal(Core.classifyFile('application/pdf'), 'file')
  assert.equal(Core.classifyFile(''), 'file')
})

test('Core.partitionIntake and modelSupportsVisual gate the native vision path', () => {
  const { images, others } = Core.partitionIntake([
    { name: 'a.png', type: 'image/png' },
    { name: 'b.pdf', type: 'application/pdf' },
  ])
  assert.deepEqual(images.map((f) => f.name), ['a.png'])
  assert.deepEqual(others.map((f) => f.name), ['b.pdf'])
  assert.equal(Core.isRasterImage({ name: 'shot.jpg', type: '' }), true)
  assert.equal(Core.rasterMediaType({ name: 'shot.jpg', type: '' }), 'image/jpeg')
  assert.equal(Core.modelSupportsVisual({ inputModalities: ['text', 'image'] }), true)
  assert.equal(Core.modelSupportsVisual({ inputModalities: ['text'] }), false)
  assert.equal(Core.modelSupportsVisual({}), false)
})

test('Core.humanSize formats compactly', () => {
  assert.equal(Core.humanSize(0), '0 B')
  assert.equal(Core.humanSize(1024), '1.0 KB')
  assert.equal(Core.humanSize(50 * 1024 * 1024), '50.0 MB')
})

test('Core.modelForm: extract fence, no python hints, no vault path', () => {
  const rich = Core.modelForm({
    id: 'ab12cd34',
    name: 'book.pdf',
    size: 2048,
    extract: { kind: 'pdf', text: 'Chapter 1', truncated: false, notes: [] },
  })
  assert.match(rich, /book\.pdf/)
  assert.match(rich, /id=ab12cd34/)
  assert.match(rich, /Chapter 1/)
  assert.match(rich, /----- extracted content -----/)
  assert.doesNotMatch(rich, /pypdf|read with the read tool|attachments\/|file-attach/)
  const plain = Core.modelForm({ id: 'x', name: 'app.py', size: 10 })
  assert.match(plain, /app\.py/)
  assert.doesNotMatch(plain, /attachments\//)
  const degraded = Core.modelForm({ id: 'ab12cd34' })
  assert.match(degraded, /id=ab12cd34/)
  assert.match(degraded, /attach_\*/)
  assert.doesNotMatch(degraded, /attachments\//)
})

test('Core.displayForm omits the extract fence; stripExtractForDisplay hides it', () => {
  const meta = {
    id: 'ab12cd34',
    name: 'book.pdf',
    size: 2048,
    extract: { kind: 'pdf', text: 'Chapter 1 secret', truncated: false, notes: [] },
  }
  const shown = Core.displayForm(meta)
  assert.match(shown, /book\.pdf/)
  assert.match(shown, /id=ab12cd34/)
  assert.doesNotMatch(shown, /Chapter 1|extracted content/)
  const model = Core.modelForm(meta)
  const stripped = Core.stripExtractForDisplay('Please summarize\n' + model + '\nThanks')
  assert.match(stripped, /Please summarize/)
  assert.match(stripped, /\[attached file "book\.pdf"/)
  assert.match(stripped, /Thanks/)
  assert.doesNotMatch(stripped, /Chapter 1 secret|extracted content/)
})

test('Core.stripExtractForDisplay tolerates collapsed and repeated fences', () => {
  // Two attachments in one message: the composer joins reference forms with a
  // space, so a fence start is not always preceded by a newline.
  const two = Core.modelForm({ id: 'a1', name: 'a.jpg', size: 1024, extract: { text: 'secret one' } })
    + ' '
    + Core.modelForm({ id: 'b2', name: 'b.jpg', size: 2048, extract: { text: 'secret two' } })
  const stripped = Core.stripExtractForDisplay(two)
  assert.equal(stripped, '[attached file "a.jpg" (1.0 KB) id=a1] [attached file "b.jpg" (2.0 KB) id=b2]')

  // A whitespace-collapsing surface (the queue preview) still loses the body.
  const collapsed = Core.stripExtractForDisplay(
    '[attached file "a.pdf" id=x] ----- extracted content ----- Chapter 1 secret ----- end ----- ask away',
  )
  assert.equal(collapsed, '[attached file "a.pdf" id=x] ask away')

  // A preview truncated mid-fence drops everything after the start marker.
  const truncated = Core.stripExtractForDisplay('[attached file "a.pdf" id=x] ----- extracted content ----- Chapter…')
  assert.equal(truncated, '[attached file "a.pdf" id=x]')
})

// ── DOM stand-in for the fence scrub ────────────────────────────────────────

/** Match a comma-separated selector list of `tag` and `[attr]` terms. */
function selectorMatches(node, selector) {
  return String(selector).split(',').some((raw) => {
    const term = raw.trim()
    if (term === '') return false
    if (term.startsWith('[')) return node.attrs[term.slice(1, -1)] !== undefined
    return node.tag === term
  })
}

/** Element stand-in exposing only what Core.hideExtractInTree touches. */
function el(tag, attrs, ...children) {
  const node = {
    nodeType: 1,
    tag,
    attrs: { ...attrs },
    style: {},
    firstChild: null,
    nextSibling: null,
    parentNode: null,
    parentElement: null,
    getAttribute: (name) => (node.attrs[name] === undefined ? null : node.attrs[name]),
    setAttribute: (name, value) => { node.attrs[name] = value },
    querySelector: (selector) => {
      const walk = (current) => {
        for (let child = current.firstChild; child !== null; child = child.nextSibling) {
          if (child.nodeType !== 1) continue
          if (selectorMatches(child, selector)) return child
          const found = walk(child)
          if (found !== null) return found
        }
        return null
      }
      return walk(node)
    },
    closest: (selector) => {
      for (let current = node; current !== null; current = current.parentElement) {
        if (selectorMatches(current, selector)) return current
      }
      return null
    },
  }
  Object.defineProperty(node, 'textContent', {
    get() {
      let out = ''
      for (let child = node.firstChild; child !== null; child = child.nextSibling) {
        out += child.nodeType === 3 ? child.nodeValue : child.textContent
      }
      return out
    },
  })
  let previous = null
  for (const child of children) {
    child.parentNode = node
    child.parentElement = node
    if (previous === null) node.firstChild = child
    else previous.nextSibling = child
    previous = child
  }
  return node
}

/** Text-node stand-in. */
function txt(value) {
  const node = { nodeType: 3, nodeValue: value, nextSibling: null, parentNode: null, parentElement: null }
  Object.defineProperty(node, 'textContent', { get: () => node.nodeValue })
  return node
}

test('Core.hideExtractInTree hides a fence split across sibling nodes', () => {
  // The conversation splits a user bubble at every `/name` token, so one fence
  // can start in one text node, cross a decoration chip, and end in another.
  const chip = el('span', { 'data-ref-chip': 'skill' }, txt('/9'))
  const bubble = el(
    'div',
    { class: 'bubble' },
    txt('[attached file "a.jpg" (1.0 KB) id=a1]\n----- extracted content -----\nOCR: 8'),
    chip,
    txt(' SECRET ONE\n----- end ----- [attached file "b.jpg" (2.0 KB) id=b2]\n'
      + '----- extracted content -----\nSECRET TWO\n----- end -----'),
  )
  const row = el('div', { 'data-time-hover-root': '' }, bubble, el('div', {}, txt('10:24')))

  assert.equal(Core.hideExtractInTree(row), true)
  assert.match(row.textContent, /\[attached file "a\.jpg" \(1\.0 KB\) id=a1\]/)
  assert.match(row.textContent, /\[attached file "b\.jpg" \(2\.0 KB\) id=b2\]/)
  assert.match(row.textContent, /10:24/)
  assert.doesNotMatch(row.textContent, /SECRET|OCR|extracted content|----- end -----/)
  assert.equal(chip.style.display, 'none', 'a chip made of fenced text is collapsed')
  assert.equal(Core.hideExtractInTree(row), false, 'a second pass finds nothing left to do')
})

test('Core.hideExtractInTree keeps a truncated fence inside its own text node', () => {
  const preview = el('span', {}, txt('[attached file "a.pdf" id=x] ----- extracted content ----- SECRET…'))
  const remove = el('button', {}, txt('Remove'))
  const later = el('div', {}, txt('[attached file "b.pdf" id=y]\n----- extracted content -----\nSECRET\n----- end -----'))
  const row = el('li', {}, preview, remove, later)

  assert.equal(Core.hideExtractInTree(row), true)
  assert.equal(preview.textContent, '[attached file "a.pdf" id=x]')
  assert.equal(remove.textContent, 'Remove', 'a sibling outside the fence is untouched')
  assert.equal(remove.style.display, undefined)
  assert.equal(later.textContent, '[attached file "b.pdf" id=y]', 'a whole fence after a truncated one still goes')
})

test('Core.hideExtractInTree scrubs messages without touching composer text', () => {
  const draftText = txt('[attached file "a.pdf" id=x]\n----- extracted content -----\nSECRET\n----- end -----')
  const composer = el('div', { 'data-composer-card': '' }, el('div', { 'data-input-mirror': '' }, draftText))
  const message = el('div', {}, txt('[attached file "b.pdf" id=y]\n----- extracted content -----\nSECRET\n----- end -----'))
  const app = el('div', {}, message, composer)

  assert.equal(Core.hideExtractInTree(app), true)
  assert.equal(message.textContent, '[attached file "b.pdf" id=y]')
  assert.match(draftText.nodeValue, /SECRET/, 'the draft mirror stays byte-identical to the draft')
})

test('Core.hideExtractInTree rewrites text nodes and skips the composer', () => {
  const text = {
    nodeType: 3,
    nodeValue: '[attached file "a.pdf" id=x]\n----- extracted content -----\nSECRET\n----- end -----',
    parentElement: { closest: () => null },
  }
  assert.equal(Core.hideExtractInTree(text), true)
  assert.equal(text.nodeValue, '[attached file "a.pdf" id=x]')

  const composerText = {
    nodeType: 3,
    nodeValue: '[attached file "a.pdf" id=x]\n----- extracted content -----\nSECRET\n----- end -----',
    parentElement: { closest: (sel) => (String(sel).includes('data-composer-card') ? {} : null) },
  }
  assert.equal(Core.hideExtractInTree(composerText), false)
  assert.match(composerText.nodeValue, /SECRET/)
})

test('Core.composerAlignedBox tracks the composer card max-width axis', () => {
  const box = Core.composerAlignedBox()
  assert.equal(box.width, '100%')
  assert.equal(box.boxSizing, 'border-box')
  assert.match(box.maxWidth, /--dsh-composer-card-max-width/)
  assert.equal(box.marginLeft, 'auto')
  assert.equal(box.marginRight, 'auto')
})

test('Core.endOfDraftSpan appends at the draft end with the CAS revision', () => {
  assert.deepEqual(Core.endOfDraftSpan('hello', 7), { start: 5, end: 5, draftRev: 7 })
  assert.deepEqual(Core.endOfDraftSpan('', 0), { start: 0, end: 0, draftRev: 0 })
})

test('Core.parseAttachLine only matches a leading /attach token', () => {
  assert.equal(Core.parseAttachLine('/attach ab12cd34'), 'ab12cd34')
  assert.equal(Core.parseAttachLine('x /attach ab12cd34'), null)
})

test('Core.chunkPlan splits byte ranges', () => {
  assert.equal(Core.chunkPlan(0, 10).length, 0)
  assert.deepEqual(Core.chunkPlan(2500, 1000), [
    { start: 0, end: 1000 },
    { start: 1000, end: 2000 },
    { start: 2000, end: 2500 },
  ])
})

// ── plugin behavior with stubbed ctx and browser ────────────────────────────

/** Minimal browser/document/fetch stand-ins for apply(). */
function stubBrowser({ visual = false, body = undefined } = {}) {
  const listeners = new Map()
  const state = {
    prevented: false,
    stopped: false,
    dragends: 0,
    fetches: [],
    prompts: [],
    bailCalls: [],
    notifies: [],
    sources: [],
    commands: [],
    slots: [],
    visual,
    draftImages: [],
    disposers: [],
    observers: [],
  }
  const Event = class Event {
    constructor(type) { this.type = type }
  }
  globalThis.Event = Event
  globalThis.window = {
    dispatchEvent: () => { state.dragends += 1 },
  }
  globalThis.document = {
    addEventListener: (type, fn) => { listeners.set(type, fn) },
    removeEventListener: () => {},
    createElement: () => {
      const el = { click: () => {}, remove: () => {} }
      el.setAttribute = () => {}
      return el
    },
    body,
    documentElement: body,
  }
  globalThis.MutationObserver = body === undefined ? undefined : class MutationObserver {
    constructor(callback) {
      this.callback = callback
      state.observers.push(this)
    }

    observe(root, options) { this.observing = { root, options } }

    disconnect() { this.observing = undefined }
  }
  globalThis.fetch = async (url, options = {}) => {
    state.fetches.push({ url, options })
    if (String(url).includes('/config')) {
      return { ok: true, json: async () => ({ maxFileBytes: 12345, maxFilesPerMessage: 3, vaultDir: 'file-attach' }) }
    }
    if (String(url).includes('/vision')) {
      const model = options.headers && options.headers['x-model']
      const visual = state.visual || (typeof model === 'string' && /vision/i.test(model))
      return { ok: true, json: async () => ({ visual, model: model || undefined }) }
    }
    if (String(url).includes('/extract')) {
      return { ok: true, json: async () => ({ kind: 'text', text: 'reloaded-extract', truncated: false, notes: [] }) }
    }
    // Echo the requested file name back so each upload resolves its own meta.
    const encoded = (options.headers && options.headers['x-file-name']) || encodeURIComponent('a.pdf')
    const name = decodeURIComponent(encoded)
    const meta = {
      id: 'ab12cd34',
      name,
      size: 5,
      extract: { kind: 'text', text: 'extracted:' + name, truncated: false, notes: [] },
    }
    return { ok: true, json: async () => meta }
  }
  return { listeners, state }
}

/** A stub ctx shaped like the client services the plugin declares. */
function stubCtx(browser) {
  const actx = {
    bail(self, name, payload) {
      browser.state.bailCalls.push({ name, payload })
      return true
    },
  }
  const input = {
    state: { getSnapshot: () => ({ draft: 'hello', draftRev: 3, phase: 'plain' }) },
    notify(level, text) { browser.state.notifies.push({ level, text }) },
    addImages(ids) {
      browser.state.draftImages.push(...ids)
      return true
    },
    setDraft(text) { this.state = { getSnapshot: () => ({ draft: text, draftRev: 4, phase: 'plain' }) } },
  }
  const session = {
    prompt: async (content, mode) => {
      browser.state.prompts.push({ content, mode })
      return { ok: true }
    },
  }
  const ctx = {
    locale: {
      register: () => () => {},
      bind: () => (key, params) => key + (params === undefined ? '' : `:${JSON.stringify(params)}`),
    },
    sessions: {
      list: { getSnapshot: () => ({ current: 's1' }) },
      scope: (id) => (id === 's1' ? actx : undefined),
      sessionOf: () => session,
      subagentAddress: () => undefined,
    },
    conversation: {
      input: { for: () => input },
      createDraftImages(files) {
        return files.map((file, index) => ({ id: 'img-' + index, file }))
      },
      releaseDraftImages() {},
    },
    get(name) {
      if (name === 'modelDirectories') {
        return {
          directoryFor: () => ({
            store: {
              getSnapshot: () => ({
                current: browser.state.selection || null,
              }),
            },
          }),
        }
      }
      return undefined
    },
    inputTriggers: { registerSource: (source) => { browser.state.sources.push(source); return () => {} } },
    commandUi: {
      register: (contribution) => {
        browser.state.commands.push(contribution)
        return () => {}
      },
    },
    slots: {
      inject: (name, callback) => {
        browser.state.slots.push({ name, options: null, component: null })
        return callback()
      },
      register: (options, component) => {
        const last = browser.state.slots[browser.state.slots.length - 1]
        last.options = options
        last.component = component
        return () => {}
      },
    },
    effect: (callback) => {
      const disposer = callback()
      const dispose = typeof disposer === 'function' ? disposer : () => {}
      browser.state.disposers.push(dispose)
      return dispose
    },
  }
  return { ctx, actx, input }
}

function fileLike(name, type, size) {
  return {
    name,
    type,
    size,
    slice: () => ({ arrayBuffer: async () => new ArrayBuffer(size) }),
  }
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('apply registers the attach source; codec serializes the rich model form', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  const plugin = build({ React: {}, Core })
  assert.equal(plugin.name, 'file-attach')
  assert.deepEqual(plugin.inject, ['slots', 'locale', 'inputTriggers', 'sessions', 'conversation', 'commandUi'])
  plugin.apply(ctx)

  const source = browser.state.sources[0]
  assert.equal(source.trigger, '/')
  assert.equal(source.name, 'attach')
  assert.equal(typeof source.codec, 'object')
  assert.equal(browser.state.commands.length, 1)
  assert.equal(browser.state.commands[0].name, 'attach')

  // Drive a drop: upload is stubbed to resolve a file meta, then a chip is
  // inserted through the scoped input event.
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [fileLike('a.pdf', 'application/pdf', 5)] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()

  assert.equal(browser.state.prevented, true)
  assert.equal(browser.state.stopped, true)
  assert.equal(browser.state.dragends, 1, 'built-in overlay reset via synthetic dragend')
  assert.equal(browser.state.bailCalls.length, 1)
  const insert = browser.state.bailCalls[0]
  assert.equal(insert.name, 'slash/input-insert-reference')
  assert.equal(insert.payload.reference.source, 'attach')
  assert.equal(insert.payload.reference.ref, 'ab12cd34')
  assert.equal(insert.payload.reference.label, 'a.pdf')
  assert.deepEqual(insert.payload.span, { start: 5, end: 5, draftRev: 3 })

  const form = await source.codec.serialize('ab12cd34')
  assert.match(form, /a\.pdf/)
  assert.match(form, /extracted:a\.pdf/)
  assert.doesNotMatch(form, /pypdf|attachments\/|file-attach/)
  assert.equal(browser.state.notifies.filter((n) => n.level === 'info').length, 0)
})

test('registers the attach strip into conversation.input.dock at composer width', async () => {
  const created = []
  const React = {
    useState: (value) => [value, () => {}],
    useEffect: (fn) => {
      fn()
      return undefined
    },
    createElement: (type, props, ...children) => {
      created.push({ type, props: props || {}, children })
      return { type, props: props || {}, children }
    },
  }
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  build({ React, Core }).apply(ctx)
  assert.equal(browser.state.slots.length, 1)
  const slot = browser.state.slots[0]
  assert.equal(slot.name, 'conversation.input.dock')
  assert.equal(slot.options.name, 'conversation.input.dock')
  assert.equal(slot.options.id, 'file-attach')
  assert.equal(typeof slot.component, 'function')
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [fileLike('a.pdf', 'application/pdf', 5)] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  created.length = 0
  const Dock = browser.state.slots[0].component
  Dock({ sessionId: 's1', attach: () => {} })
  const root = created.find((node) => (
    node.props.style
    && typeof node.props.style.maxWidth === 'string'
    && node.props.style.maxWidth.includes('--dsh-composer-card-max-width')
  ))
  assert.ok(root, 'dock root rendered')
  assert.match(root.props.style.maxWidth, /--dsh-composer-card-max-width/)
  assert.equal(root.props.style.width, '100%')
  assert.equal(root.props.style.marginLeft, 'auto')
  assert.equal(root.props.style.marginRight, 'auto')
})

test('image-only drops are claimed by this plugin when the model is not visual', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [fileLike('photo.png', 'image/png', 5)] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  assert.equal(browser.state.prevented, true)
  assert.equal(browser.state.stopped, true)
  assert.equal(browser.state.bailCalls.length, 1)
  assert.equal(browser.state.bailCalls[0].payload.reference.label, 'photo.png')
  assert.equal(browser.state.draftImages.length, 0)
})

test('image-only drops use the built-in vision pipeline when the model is visual', async () => {
  const browser = stubBrowser({ visual: true })
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [fileLike('photo.png', 'image/png', 5)] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  assert.equal(browser.state.prevented, true)
  assert.equal(browser.state.draftImages.length, 1)
  assert.equal(browser.state.draftImages[0], 'img-0')
  assert.equal(browser.state.bailCalls.length, 0, 'native vision path does not insert an attach chip')
  assert.equal(
    browser.state.fetches.filter((f) => String(f.url).includes('/upload')).length,
    0,
    'native vision path does not upload through the plugin',
  )
})

test('mixed drops on a visual model send images native and files through the plugin', async () => {
  const browser = stubBrowser({ visual: true })
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('drop')({
    dataTransfer: {
      types: ['Files'],
      files: [fileLike('photo.png', 'image/png', 5), fileLike('notes.pdf', 'application/pdf', 5)],
    },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  assert.equal(browser.state.draftImages.length, 1)
  assert.equal(browser.state.bailCalls.length, 1)
  assert.equal(browser.state.bailCalls[0].payload.reference.label, 'notes.pdf')
})

test('composer model-seat selection is sent on the vision lookup', async () => {
  const browser = stubBrowser()
  browser.state.selection = { provider: 'deepseek', model: 'flash-vision-exp' }
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [fileLike('photo.png', 'image/png', 5)] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  const vision = browser.state.fetches.find((f) => String(f.url).includes('/vision'))
  assert.ok(vision, 'vision lookup ran')
  assert.equal(vision.options.headers['x-model'], 'flash-vision-exp')
  assert.equal(vision.options.headers['x-provider'], 'deepseek')
  assert.equal(browser.state.draftImages.length, 1, 'hinted vision model uses the native rail')
  assert.equal(browser.state.bailCalls.length, 0)
})

test('image paste uses the plugin when the model is not visual', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('paste')({
    clipboardData: {
      items: [{ kind: 'file', getAsFile: () => fileLike('clip.png', 'image/png', 5) }],
      getData: () => '',
    },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  assert.equal(browser.state.bailCalls.length, 1)
  assert.equal(browser.state.bailCalls[0].payload.reference.label, 'clip.png')
  assert.equal(browser.state.draftImages.length, 0)
})

test('mixed drops attach every file including images', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  browser.listeners.get('drop')({
    dataTransfer: {
      types: ['Files'],
      files: [fileLike('photo.png', 'image/png', 5), fileLike('notes.pdf', 'application/pdf', 5)],
    },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  await tick()
  assert.equal(browser.state.bailCalls.length, 2)
  const labels = browser.state.bailCalls.map((c) => c.payload.reference.label).sort()
  assert.deepEqual(labels, ['notes.pdf', 'photo.png'])
})

test('matchEnter claims a plain /attach line and sends the model form as a message', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  const plugin = build({ React: {}, Core })
  plugin.apply(ctx)
  const source = browser.state.sources[0]

  const outcome = await source.matchEnter({ sessionId: 's1' }, '/attach ab12cd34')
  assert.ok(outcome !== undefined)
  const claimResult = await outcome.claim.submit('ab12cd34')
  assert.deepEqual(claimResult, { kind: 'success' })
  assert.equal(browser.state.prompts.length, 1)
  assert.equal(browser.state.prompts[0].mode, 'queue')
  assert.match(browser.state.prompts[0].content[0].text, /id=ab12cd34/)
  assert.doesNotMatch(browser.state.prompts[0].content[0].text, /attachments\//)

  // Non-attach slash lines are not claimed.
  assert.equal(await source.matchEnter({ sessionId: 's1' }, '/goal build it'), undefined)
})

test('a rendered message loses its extract fence on the first mutation batch', () => {
  const bubble = el('div', { class: 'bubble' })
  const body = el('div', {}, el('div', { class: 'transcript' }, bubble), el('div', { 'data-composer-card': '' }))
  const browser = stubBrowser({ body })
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)

  assert.equal(browser.state.observers.length, 1, 'the scrub observer is installed')
  assert.equal(browser.state.observers[0].observing.root, body)

  // Render the sent message the way the conversation does, then hand the
  // observer the batch that inserted it.
  const model = Core.modelForm({ id: 'a1', name: 'a.jpg', size: 1024, extract: { text: 'SECRET' } })
  const rendered = el('div', {}, txt(model))
  bubble.firstChild = rendered
  rendered.parentNode = bubble
  rendered.parentElement = bubble
  browser.state.observers[0].callback([{ type: 'childList', addedNodes: [rendered] }])

  assert.equal(bubble.textContent, '[attached file "a.jpg" (1.0 KB) id=a1]')
  for (const dispose of browser.state.disposers) dispose()
})

test('oversized drops are rejected with a toast and no chip', async () => {
  const browser = stubBrowser()
  const { ctx } = stubCtx(browser)
  build({ React: {}, Core }).apply(ctx)
  await tick() // let the config fetch land (maxFileBytes 12345)
  await tick()
  const big = fileLike('big.pdf', 'application/pdf', 999999)
  browser.listeners.get('drop')({
    dataTransfer: { types: ['Files'], files: [big] },
    preventDefault: () => { browser.state.prevented = true },
    stopPropagation: () => { browser.state.stopped = true },
  })
  await tick()
  await tick()
  assert.equal(browser.state.bailCalls.length, 0)
  assert.ok(browser.state.notifies.some((n) => n.level === 'error' && /tooLarge/.test(n.text)))
})
