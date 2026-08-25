/**
 * dsh-file-attach client core — pure, environment-agnostic helpers.
 *
 * This is a PLAIN SCRIPT (no import/export statements): scripts/build-client.mjs
 * inlines it verbatim into the web bundle factory, and tests load it through
 * `new Function`. The few functions that overlap with the host side
 * (lib/ingest.js) are intentionally mirrored here so the browser bundle stays
 * self-contained; keep the two copies in sync.
 */
var FileAttachCore = (function () {
  var IMAGE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  var IMAGE_EXTENSIONS = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }

  function extensionOfName(name) {
    var base = String(name == null ? '' : name).replace(/\\/g, '/').split('/').pop() || ''
    var dot = base.lastIndexOf('.')
    return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase()
  }

  /** 'image' for raster MIMEs, else 'file'. */
  function classifyFile(mime) {
    return IMAGE_MEDIA_TYPES.indexOf(mime) !== -1 ? 'image' : 'file'
  }

  /** True when declared MIME or filename is a PNG/JPEG/WebP/GIF raster. */
  function isRasterImage(file) {
    if (file == null) return false
    var mime = file.type || file.mime
    if (IMAGE_MEDIA_TYPES.indexOf(mime) !== -1) return true
    return Object.prototype.hasOwnProperty.call(IMAGE_EXTENSIONS, extensionOfName(file.name))
  }

  /** Canonical raster MIME from declared type or filename extension. */
  function rasterMediaType(file) {
    if (file == null) return undefined
    var mime = file.type || file.mime
    if (IMAGE_MEDIA_TYPES.indexOf(mime) !== -1) return mime
    var mapped = IMAGE_EXTENSIONS[extensionOfName(file.name)]
    return mapped === undefined ? undefined : mapped
  }

  /** Split a File-like list into rasters vs everything else. */
  function partitionIntake(files) {
    var images = []
    var others = []
    var list = files == null ? [] : files
    for (var i = 0; i < list.length; i += 1) {
      if (isRasterImage(list[i])) images.push(list[i])
      else others.push(list[i])
    }
    return { images: images, others: others }
  }

  /**
   * True only when the catalog entry explicitly lists `image` input.
   * Missing inputModalities is unknown, not visual.
   */
  function modelSupportsVisual(info) {
    return info != null && Array.isArray(info.inputModalities) && info.inputModalities.indexOf('image') !== -1
  }

  /** Compact human-readable byte count (e.g. "2.4 MB"). */
  function humanSize(bytes) {
    if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
    if (bytes < 1024) return bytes + ' B'
    var units = ['KB', 'MB', 'GB', 'TB']
    var value = bytes
    var unit = -1
    do {
      value /= 1024
      unit += 1
    } while (value >= 1024 && unit < units.length - 1)
    return (value >= 100 ? Math.round(value) : value.toFixed(1)) + ' ' + units[unit]
  }

  /** Marker wrapping extract text in the model form. Hidden in the conversation UI. */
  var EXTRACT_FENCE_START = '----- extracted content -----'
  var EXTRACT_FENCE_END = '----- end -----'
  /** Composer surfaces whose text belongs to the draft machine, never to this scrub. */
  var COMPOSER_SELECTOR = '[data-composer-card], textarea, [data-input-backdrop], [data-input-mirror]'
  /** Attribute marking elements this plugin collapsed, so repeat passes are idempotent. */
  var HIDDEN_ATTR = 'data-file-attach-hidden'

  /** Header line shared by the model form and the user-visible display form. */
  function attachHeader(meta) {
    var idBit = meta && meta.id ? ' id=' + meta.id : ''
    if (!meta || meta.name === undefined) {
      return '[attached file' + idBit + ' — extraction unavailable after reload; use attach_* tools with id ' + (meta && meta.id) + ']'
    }
    var sizeBit = meta.size !== undefined ? ' (' + humanSize(meta.size) + ')' : ''
    return '[attached file "' + meta.name + '"' + sizeBit + idBit + ']'
  }

  /**
   * User-visible form of one attachment: the header only, never the extract
   * fence. Vault paths are never included.
   */
  function displayForm(meta) {
    return attachHeader(meta)
  }

  /**
   * The model-visible form of one attachment: extracted text when present,
   * otherwise a degraded id hint. Vault paths are never included.
   */
  function modelForm(meta) {
    var header = attachHeader(meta)
    var extractText = meta && meta.extract && typeof meta.extract.text === 'string' ? meta.extract.text : undefined
    if (extractText !== undefined && meta && meta.name !== undefined) {
      return header + '\n' + EXTRACT_FENCE_START + '\n' + extractText + '\n' + EXTRACT_FENCE_END
    }
    return header
  }

  /**
   * First character to drop for a fence whose start marker sits at `at`: the
   * marker plus the whitespace that separated it from the attachment header,
   * so the header keeps its own line (or its single separating space when the
   * renderer collapsed the newline).
   */
  function fenceCutFrom(text, at) {
    var i = at
    while (i > 0 && (text.charAt(i - 1) === ' ' || text.charAt(i - 1) === '\t')) i -= 1
    if (i > 0 && text.charAt(i - 1) === '\n') {
      i -= 1
      if (i > 0 && text.charAt(i - 1) === '\r') i -= 1
    }
    return i
  }

  /**
   * Character ranges of `text` covered by extract fences. Markers are matched
   * as plain substrings: a renderer may collapse the newlines around them.
   *
   * A start marker whose end marker never arrives is cut only to the end of
   * the `bounds` slice that holds it (one DOM text node), so a truncated
   * preview loses its fence body while text belonging to another message is
   * never blanked. Without bounds the cut runs to the end of the string.
   */
  function fenceRanges(text, bounds) {
    var ranges = []
    var cursor = 0
    while (cursor <= text.length) {
      var start = text.indexOf(EXTRACT_FENCE_START, cursor)
      if (start === -1) break
      var body = start + EXTRACT_FENCE_START.length
      var end = text.indexOf(EXTRACT_FENCE_END, body)
      var next = text.indexOf(EXTRACT_FENCE_START, body)
      var from = fenceCutFrom(text, start)
      // Fences never nest: a start marker before the next end marker means
      // this fence lost its end (a truncated preview), not that it wraps one.
      if (end === -1 || (next !== -1 && next < end)) {
        var stop = boundEndAt(bounds, start, text.length)
        ranges.push({ start: from, end: stop })
        // A later sibling may still carry a whole fence of its own.
        cursor = stop > body ? stop : body
        continue
      }
      ranges.push({ start: from, end: end + EXTRACT_FENCE_END.length })
      cursor = end + EXTRACT_FENCE_END.length
    }
    return ranges
  }

  /** End offset of the bound slice holding `offset`, or `fallback`. */
  function boundEndAt(bounds, offset, fallback) {
    var list = bounds === undefined || bounds === null ? [] : bounds
    for (var i = 0; i < list.length; i += 1) {
      if (offset >= list[i].start && offset < list[i].end) return list[i].end
    }
    return fallback
  }

  /** `value` (which starts at `offset` in the scanned text) minus every covered slice. */
  function textOutsideRanges(value, offset, ranges) {
    var out = ''
    var cursor = 0
    for (var i = 0; i < ranges.length; i += 1) {
      var from = ranges[i].start - offset
      var to = ranges[i].end - offset
      if (to <= 0 || from >= value.length) continue
      if (from < cursor) from = cursor
      if (to > value.length) to = value.length
      if (to <= from) continue
      if (from > cursor) out += value.slice(cursor, from)
      cursor = to
    }
    return cursor < value.length ? out + value.slice(cursor) : out
  }

  /** Drop extract fences so conversation UI can show the header without the prompt body. */
  function stripExtractForDisplay(text) {
    var input = String(text)
    var ranges = fenceRanges(input, [])
    return ranges.length === 0 ? input : textOutsideRanges(input, 0, ranges)
  }

  function isElement(node) {
    return node !== undefined && node !== null && node.nodeType === 1
  }

  function isText(node) {
    return node !== undefined && node !== null && node.nodeType === 3
  }

  /**
   * Collect the text nodes, element extents, and concatenated text of one
   * subtree in document order, so a fence can be located across siblings.
   */
  function scanSubtree(node, state) {
    if (isText(node)) {
      var value = typeof node.nodeValue === 'string' ? node.nodeValue : ''
      state.texts.push({ node: node, start: state.length, end: state.length + value.length })
      state.chunks.push(value)
      state.length += value.length
      return
    }
    if (!isElement(node)) return
    var start = state.length
    var child = node.firstChild
    while (child !== undefined && child !== null) {
      var sibling = child.nextSibling
      scanSubtree(child, state)
      child = sibling
    }
    state.elements.push({ el: node, start: start, end: state.length })
  }

  /** True when an element's whole text extent sits inside one fence range. */
  function insideRanges(extent, ranges) {
    for (var i = 0; i < ranges.length; i += 1) {
      var range = ranges[i]
      if (extent.end > extent.start) {
        if (range.start <= extent.start && extent.end <= range.end) return true
      } else if (range.start < extent.start && extent.start < range.end) return true
    }
    return false
  }

  /** Collapse one element whose entire content was fenced (chips, empty lines). */
  function hideElement(el) {
    if (typeof el.getAttribute === 'function' && el.getAttribute(HIDDEN_ATTR) !== null) return false
    if (el.style !== undefined && el.style !== null) el.style.display = 'none'
    if (typeof el.setAttribute === 'function') el.setAttribute(HIDDEN_ATTR, '')
    return true
  }

  /**
   * Rewrite one fence-bearing subtree as a single character stream: blank the
   * fenced text and collapse the nodes that held nothing else.
   */
  function scrubSubtree(root) {
    var state = { texts: [], elements: [], chunks: [], length: 0 }
    scanSubtree(root, state)
    var ranges = fenceRanges(state.chunks.join(''), state.texts)
    if (ranges.length === 0) return false
    var changed = false
    for (var i = 0; i < state.texts.length; i += 1) {
      var entry = state.texts[i]
      var value = typeof entry.node.nodeValue === 'string' ? entry.node.nodeValue : ''
      var next = textOutsideRanges(value, entry.start, ranges)
      if (next === value) continue
      entry.node.nodeValue = next
      changed = true
    }
    for (var j = 0; j < state.elements.length; j += 1) {
      var extent = state.elements[j]
      if (extent.el === root) continue
      if (!insideRanges(extent, ranges)) continue
      if (hideElement(extent.el)) changed = true
    }
    return changed
  }

  /**
   * Rewrite `root` so extract fences never paint.
   *
   * A fence is not confined to one text node: the conversation renders a user
   * bubble as several nodes (it decorates `/name` and `@name` tokens, and a
   * markdown surface would split blocks), so the scrub runs over the widest
   * fence-bearing subtree that holds no composer surface and treats that
   * subtree as one character stream. The composer is skipped entirely — its
   * chips already hide the model form, and its text belongs to the draft.
   */
  function hideExtractInTree(root) {
    if (root === undefined || root === null) return false
    if (inComposer(root)) return false
    if (isText(root)) {
      var value = root.nodeValue
      if (typeof value !== 'string' || value.indexOf(EXTRACT_FENCE_START) === -1) return false
      var next = stripExtractForDisplay(value)
      if (next === value) return false
      root.nodeValue = next
      return true
    }
    if (!isElement(root)) return false
    var text = typeof root.textContent === 'string' ? root.textContent : ''
    if (text.indexOf(EXTRACT_FENCE_START) === -1) return false
    if (!holdsComposer(root)) return scrubSubtree(root)
    var changed = false
    var child = root.firstChild
    while (child !== undefined && child !== null) {
      var sibling = child.nextSibling
      if (hideExtractInTree(child)) changed = true
      child = sibling
    }
    return changed
  }

  function inComposer(node) {
    var el = node
    if (el !== undefined && el !== null && el.nodeType === 3) el = el.parentElement || el.parentNode
    if (el === undefined || el === null || typeof el.closest !== 'function') return false
    return el.closest(COMPOSER_SELECTOR) !== null
  }

  /** True when the subtree contains a composer surface, so it cannot be scrubbed whole. */
  function holdsComposer(el) {
    if (!isElement(el) || typeof el.querySelector !== 'function') return false
    return el.querySelector(COMPOSER_SELECTOR) !== null
  }

  /**
   * Geometry that tracks the composer card: DSH publishes
   * `--dsh-composer-card-max-width` on the conversation root (content width +
   * 32px). The file-list dock sits in the full-width `conversation.input.dock`
   * slot above that card, so it must opt into the same cap and centering.
   */
  function composerAlignedBox() {
    return {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: 'var(--dsh-composer-card-max-width, 780px)',
      alignSelf: 'center',
      marginLeft: 'auto',
      marginRight: 'auto',
    }
  }

  /**
   * End-of-draft insertion span for a reference chip.
   * @returns a TokenSpan placing the placeholder at the end of the draft.
   */
  function endOfDraftSpan(draft, draftRev) {
    var at = typeof draft === 'string' ? draft.length : 0
    return { start: at, end: at, draftRev: draftRev }
  }

  /** Parse a trimmed draft line as a plain-text `/attach <id>` reference; null when not one. */
  function parseAttachLine(line) {
    var m = /^\/attach\s+(\S+)\s*$/.exec(String(line).trim())
    return m === null ? null : m[1]
  }

  /** Chunk plan for one file: zero-based [start, end) byte ranges of at most chunkBytes. */
  function chunkPlan(size, chunkBytes) {
    var plan = []
    if (size <= 0) return plan
    for (var start = 0; start < size; start += chunkBytes) {
      plan.push({ start: start, end: Math.min(size, start + chunkBytes) })
    }
    return plan
  }

  return {
    classifyFile: classifyFile,
    isRasterImage: isRasterImage,
    rasterMediaType: rasterMediaType,
    partitionIntake: partitionIntake,
    modelSupportsVisual: modelSupportsVisual,
    humanSize: humanSize,
    displayForm: displayForm,
    modelForm: modelForm,
    stripExtractForDisplay: stripExtractForDisplay,
    hideExtractInTree: hideExtractInTree,
    composerAlignedBox: composerAlignedBox,
    EXTRACT_FENCE_START: EXTRACT_FENCE_START,
    EXTRACT_FENCE_END: EXTRACT_FENCE_END,
    endOfDraftSpan: endOfDraftSpan,
    parseAttachLine: parseAttachLine,
    chunkPlan: chunkPlan,
  }
})()
