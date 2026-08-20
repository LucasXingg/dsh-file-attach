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

  /** 'image' for raster MIMEs, else 'file'. */
  function classifyFile(mime) {
    return IMAGE_MEDIA_TYPES.indexOf(mime) !== -1 ? 'image' : 'file'
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

  /**
   * The model-visible form of one attachment: extracted text when present,
   * otherwise a degraded id hint. Vault paths are never included.
   */
  function modelForm(meta) {
    var extractText = meta && meta.extract && typeof meta.extract.text === 'string' ? meta.extract.text : undefined
    var idBit = meta && meta.id ? ' id=' + meta.id : ''
    if (extractText !== undefined && meta.name !== undefined) {
      var sizeBit = meta.size !== undefined ? ' (' + humanSize(meta.size) + ')' : ''
      return '[attached file "' + meta.name + '"' + sizeBit + idBit + ']\n----- extracted content -----\n' + extractText + '\n----- end -----'
    }
    if (!meta || meta.name === undefined) {
      return '[attached file' + idBit + ' — extraction unavailable after reload; use attach_* tools with id ' + (meta && meta.id) + ']'
    }
    var plainSize = meta.size !== undefined ? ' (' + humanSize(meta.size) + ')' : ''
    return '[attached file "' + meta.name + '"' + plainSize + idBit + ']'
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
    humanSize: humanSize,
    modelForm: modelForm,
    endOfDraftSpan: endOfDraftSpan,
    parseAttachLine: parseAttachLine,
    chunkPlan: chunkPlan,
  }
})()
