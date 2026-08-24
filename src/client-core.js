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
  var EXTRACT_FENCE_RE = /\r?\n----- extracted content -----\r?\n[\s\S]*?\r?\n----- end -----/g

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

  /** Drop extract fences so conversation UI can show the header without the prompt body. */
  function stripExtractForDisplay(text) {
    EXTRACT_FENCE_RE.lastIndex = 0
    return String(text).replace(EXTRACT_FENCE_RE, '')
  }

  /**
   * Rewrite text nodes under `root` so extract fences never paint.
   * Skips the composer (chips already hide the model form).
   */
  function hideExtractInTree(root) {
    if (root === undefined || root === null) return false
    if (inComposer(root)) return false
    if (root.nodeType === 3) {
      var value = root.nodeValue
      if (typeof value !== 'string' || value.indexOf(EXTRACT_FENCE_START) === -1) return false
      var next = stripExtractForDisplay(value)
      if (next === value) return false
      root.nodeValue = next
      return true
    }
    var changed = false
    if (typeof root.textContent === 'string' && root.textContent.indexOf(EXTRACT_FENCE_START) !== -1) {
      var child = root.firstChild
      if (child !== null && child.nextSibling === null && child.nodeType === 3) {
        return hideExtractInTree(child)
      }
      var onlyText = true
      var cursor = root.firstChild
      while (cursor !== null) {
        if (cursor.nodeType === 1) { onlyText = false; break }
        cursor = cursor.nextSibling
      }
      if (onlyText && root.firstChild !== null) {
        var stripped = stripExtractForDisplay(root.textContent)
        if (stripped !== root.textContent) {
          root.textContent = stripped
          return true
        }
      }
    }
    var walk = root.firstChild
    while (walk !== null) {
      var sibling = walk.nextSibling
      if (hideExtractInTree(walk)) changed = true
      walk = sibling
    }
    return changed
  }

  function inComposer(node) {
    var el = node
    if (el !== undefined && el !== null && el.nodeType === 3) el = el.parentElement || el.parentNode
    if (el === undefined || el === null || typeof el.closest !== 'function') return false
    return el.closest('[data-composer-card], textarea, [data-input-backdrop], [data-input-mirror]') !== null
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
