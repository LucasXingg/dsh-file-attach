/**
 * dsh-file-attach CLIENT plugin body.
 *
 * Plain script (no imports/exports): scripts/build-client.mjs inlines this
 * file and src/client-core.js into the web bundle factory, where
 * `buildFileAttachPlugin(env)` returns the cordis plugin { name, inject, apply }.
 * `env.React` and `env.Core` (FileAttachCore) are provided by the build.
 *
 * What it does:
 *  1. Capture-phase drop interception: every dropped file (including images)
 *     is claimed by this plugin.
 *  2. Chunked binary upload to the host half (POST /api/dsh-file-attach/upload).
 *  3. On success, inserts a reference chip into the composer draft through the
 *     scoped `slash/input-insert-reference` event. The host extract is spliced
 *     into the model form at serialize time. The conversation UI strips the
 *     extract fence and shows only the `[attached file …]` header.
 *  4. A `conversation.input.dock` strip aligned to the composer card width:
 *     upload progress + the session's attached files + an Add picker.
 *  5. A `/attach` input-trigger source whose `matchEnter` recovers a plain-text
 *     `/attach <id>` line after a page reload.
 */
function buildFileAttachPlugin(env) {
  var React = env.React
  var Core = env.Core

  var NS = 'fileAttach'
  var SOURCE_NAME = 'attach'
  var ROUTE_UPLOAD = '/api/dsh-file-attach/upload'
  var ROUTE_ABORT = '/api/dsh-file-attach/abort'
  var ROUTE_CONFIG = '/api/dsh-file-attach/config'
  var ROUTE_EXTRACT = '/api/dsh-file-attach/extract'
  var DEFAULT_LIMITS = {
    maxFileBytes: 50 * 1024 * 1024,
    maxFilesPerMessage: 20,
    maxConcurrentUploads: 20,
    chunkBytes: 1024 * 1024,
  }

  var dictionaries = {
    zh: {
      attach: '上传文件',
      menuAttach: '上传文件…',
      addFiles: '添加',
      extracting: '正在提取 {name}',
      failed: '上传 {name} 失败：{message}',
      tooLarge: '{name} 超过大小限制 {size}',
      empty: '{name} 是空文件',
      noSession: '没有可附加文件的会话',
      busy: '正在处理中，请稍后再附加文件',
      insertFailed: '无法插入 {name} 的引用',
    },
    en: {
      attach: 'Attach files',
      menuAttach: 'Attach files…',
      addFiles: 'Add',
      extracting: 'Extracting {name}',
      failed: 'Upload of {name} failed: {message}',
      tooLarge: '{name} exceeds the {size} limit',
      empty: '{name} is empty',
      noSession: 'No active session to attach files to',
      busy: 'The conversation is busy; attach files in a moment',
      insertFailed: 'Could not insert the reference for {name}',
    },
  }

  return {
    name: 'file-attach',
    inject: ['slots', 'locale', 'inputTriggers', 'sessions', 'conversation'],

    apply: function apply(ctx) {
      var t = ctx.locale.bind(NS)
      ctx.effect(function () {
        return ctx.locale.register(NS, dictionaries)
      }, 'file-attach: dictionaries')

      /** ref (upload id) -> { id, name, size, extract } for codec serialization. */
      var metaByRef = new Map()
      /** Live upload AbortControllers, aborted on plugin disposal. */
      var activeUploads = new Set()
      /** Client-mirrored limits (refreshed from the host config route, best effort). */
      var limitsRef = { current: DEFAULT_LIMITS }

      /** Session-scoped dock rows: uploading / extracting / ready. */
      var dockItems = []
      var dockListeners = new Set()
      var dockSeq = 0

      function dockPing() {
        dockListeners.forEach(function (fn) { fn() })
      }

      function dockUpsert(partial) {
        var found = -1
        for (var i = 0; i < dockItems.length; i += 1) {
          if (dockItems[i].key === partial.key) { found = i; break }
        }
        if (found === -1) dockItems.push(partial)
        else dockItems[found] = Object.assign({}, dockItems[found], partial)
        dockPing()
      }

      function dockRemove(key) {
        dockItems = dockItems.filter(function (item) { return item.key !== key })
        dockPing()
      }

      function dockForSession(sessionId) {
        return dockItems.filter(function (item) { return item.sessionId === sessionId })
      }

      // ── host config mirror ──────────────────────────────────────────────
      fetch(ROUTE_CONFIG)
        .then(function (resp) { return resp.ok ? resp.json() : null })
        .then(function (body) {
          if (body === null || typeof body !== 'object') return
          limitsRef.current = {
            maxFileBytes: numberOr(body.maxFileBytes, limitsRef.current.maxFileBytes),
            maxFilesPerMessage: numberOr(body.maxFilesPerMessage, limitsRef.current.maxFilesPerMessage),
            maxConcurrentUploads: numberOr(body.maxConcurrentUploads, limitsRef.current.maxConcurrentUploads),
            chunkBytes: limitsRef.current.chunkBytes,
          }
        })
        .catch(function () { /* defaults stand */ })

      function numberOr(value, fallback) {
        return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
      }

      // ── session addressing ──────────────────────────────────────────────
      function currentSessionId() {
        var list = ctx.sessions.list.getSnapshot()
        return list === undefined || list === null ? undefined : list.current
      }

      function sessionFace(sessionId) {
        if (sessionId === undefined || sessionId === null) return undefined
        var actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return undefined
        var input = ctx.conversation.input.for(actx)
        return { actx: actx, input: input }
      }

      function toast(sessionId, level, text) {
        var face = sessionFace(sessionId)
        if (face !== undefined) face.input.notify(level, text)
      }

      // ── upload ──────────────────────────────────────────────────────────
      function uploadFile(sessionId, file, limits, signal, onProgress) {
        var plan = Core.chunkPlan(file.size, limits.chunkBytes)
        var uploadId = null
        var index = 0
        var step = function () {
          if (signal !== undefined && signal.aborted) {
            return Promise.reject(abortError())
          }
          var range = plan[index]
          var last = index === plan.length - 1
          if (last && typeof onProgress === 'function') {
            onProgress({
              id: uploadId,
              received: Math.max(range.start, Math.floor(file.size * 0.95)),
              total: file.size,
              phase: 'extracting',
            })
          }
          var headers = {
            'content-type': 'application/octet-stream',
            'x-session-id': sessionId,
            'x-file-name': encodeURIComponent(file.name),
            'x-file-type': file.type || 'application/octet-stream',
            'x-file-size': String(file.size),
            'x-chunk-index': String(index),
            'x-chunk-count': String(plan.length),
          }
          if (uploadId !== null) headers['x-upload-id'] = uploadId
          return file
            .slice(range.start, range.end)
            .arrayBuffer()
            .then(function (buffer) {
              return fetch(ROUTE_UPLOAD, {
                method: 'POST',
                headers: headers,
                body: buffer,
                signal: signal,
              })
            })
            .then(function (resp) {
              return resp.json().catch(function () { return {} }).then(function (body) {
                if (!resp.ok) {
                  var err = new Error((body.error && body.error.message) || ('upload failed with status ' + resp.status))
                  err.code = body.error && body.error.code
                  throw err
                }
                if (uploadId === null) uploadId = body.id
                if (last) return body
                if (typeof onProgress === 'function') {
                  onProgress({
                    id: uploadId,
                    received: typeof body.received === 'number' ? body.received : range.end,
                    total: typeof body.total === 'number' ? body.total : file.size,
                    phase: 'uploading',
                  })
                }
                index += 1
                return step()
              })
            })
        }
        var run = step()
        run.catch(function () {
          if (uploadId !== null) abortUpload(uploadId)
        })
        return run
      }

      function abortError() {
        var err = new Error('aborted')
        err.name = 'AbortError'
        return err
      }

      function abortUpload(uploadId) {
        void fetch(ROUTE_ABORT, {
          method: 'POST',
          headers: { 'x-upload-id': uploadId },
          keepalive: true,
        }).catch(function () { /* best effort */ })
      }

      // ── intake ──────────────────────────────────────────────────────────
      function intake(sessionId, file) {
        var limits = limitsRef.current
        if (file.size === 0) return toast(sessionId, 'error', t('empty', { name: file.name }))
        if (file.size > limits.maxFileBytes) {
          return toast(sessionId, 'error', t('tooLarge', { name: file.name, size: Core.humanSize(limits.maxFileBytes) }))
        }
        var face = sessionFace(sessionId)
        if (face !== undefined) {
          var phase = face.input.state.getSnapshot().phase
          if (phase !== 'plain' && phase !== 'claimed') {
            return toast(sessionId, 'error', t('busy'))
          }
        }
        var controller = new AbortController()
        activeUploads.add(controller)
        dockSeq += 1
        var key = 'up-' + dockSeq
        dockUpsert({
          key: key,
          sessionId: sessionId,
          name: file.name,
          size: file.size,
          phase: 'uploading',
          received: 0,
          total: file.size,
        })
        uploadFile(sessionId, file, limits, controller.signal, function (progress) {
          dockUpsert({
            key: key,
            sessionId: sessionId,
            name: file.name,
            size: file.size,
            id: progress.id,
            phase: progress.phase,
            received: progress.received,
            total: progress.total,
          })
        })
          .then(function (meta) {
            activeUploads.delete(controller)
            dockUpsert({
              key: key,
              sessionId: sessionId,
              id: meta.id,
              name: meta.name,
              size: meta.size,
              phase: 'ready',
              received: meta.size,
              total: meta.size,
            })
            insertChip(sessionId, meta)
          })
          .catch(function (error) {
            activeUploads.delete(controller)
            dockRemove(key)
            if (error !== null && error !== undefined && error.name === 'AbortError') return
            toast(sessionId, 'error', t('failed', {
              name: file.name,
              message: error !== null && error !== undefined && error.message !== undefined ? error.message : String(error),
            }))
          })
      }

      // ── chip insertion ───────────────────────────────────────────────────
      function insertChip(sessionId, meta) {
        var face = sessionFace(sessionId)
        if (face === undefined) return false
        metaByRef.set(meta.id, meta)
        var reference = {
          source: SOURCE_NAME,
          ref: meta.id,
          label: meta.name,
          clipboardText: '/attach ' + meta.id,
        }
        for (var attempt = 0; attempt < 2; attempt += 1) {
          var state = face.input.state.getSnapshot()
          var span = Core.endOfDraftSpan(state.draft, state.draftRev)
          var applied = face.actx.bail(face.actx, 'slash/input-insert-reference', { reference: reference, span: span }) === true
          if (applied) return true
        }
        toast(sessionId, 'error', t('insertFailed', { name: meta.name }))
        return false
      }

      // ── model form ───────────────────────────────────────────────────────
      function modelFormOf(ref) {
        var meta = metaByRef.get(ref)
        return Core.modelForm(meta === undefined ? { id: ref } : meta)
      }

      function fetchExtract(sessionId, ref) {
        return fetch(ROUTE_EXTRACT, {
          method: 'GET',
          headers: { 'x-session-id': sessionId, 'x-upload-id': ref },
        }).then(function (resp) {
          return resp.ok ? resp.json() : null
        }).catch(function () { return null })
      }

      function serializeRef(ref) {
        var meta = metaByRef.get(ref)
        if (meta !== undefined && meta.extract !== undefined) {
          return Promise.resolve(modelFormOf(ref))
        }
        var sessionId = currentSessionId()
        if (sessionId === undefined || sessionId === null) {
          return Promise.resolve(modelFormOf(ref))
        }
        return fetchExtract(sessionId, ref).then(function (extract) {
          if (extract !== null && typeof extract === 'object') {
            var merged = Object.assign({ id: ref }, meta || {}, { extract: extract })
            if (meta !== undefined) {
              merged.name = meta.name
              merged.size = meta.size
            }
            metaByRef.set(ref, merged)
          }
          return modelFormOf(ref)
        })
      }

      // ── input-trigger source ─────────────────────────────────────────────
      var source = {
        trigger: '/',
        name: SOURCE_NAME,
        order: 90,
        candidates: function () {
          return Promise.resolve([{ name: 'attach', description: t('menuAttach'), icon: '📎' }])
        },
        onPick: function (pick) {
          pickFiles(pick.session.sessionId)
          return 'handled'
        },
        lexicon: function () {
          return Array.from(metaByRef.keys())
        },
        matchEnter: function (session, line) {
          var ref = Core.parseAttachLine(line)
          if (ref === null) return undefined
          return {
            claim: {
              token: '/attach ',
              submit: function (args) {
                return sendRecovered(session.sessionId, modelFormOf(args.trim()))
              },
            },
          }
        },
        codec: {
          clipboardText: function (ref) { return '/attach ' + ref },
          serialize: function (ref, signal) {
            return serializeRef(ref)
          },
        },
      }
      ctx.effect(function () {
        return ctx.inputTriggers.registerSource(source)
      }, 'file-attach: input-trigger source')

      function sendRecovered(sessionId, text) {
        var face = sessionFace(sessionId)
        if (face === undefined) return Promise.resolve({ kind: 'error', text: 'no active session' })
        var session = ctx.sessions.sessionOf(face.actx)
        if (session === undefined) return Promise.resolve({ kind: 'error', text: 'no session object' })
        return session.prompt([{ type: 'text', text: text }], 'queue').then(function (result) {
          if (!result.ok) return { kind: 'error', text: result.error.code + ': ' + result.error.message }
          return { kind: 'success' }
        }, function (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        })
      }

      // ── file picker (dock Add + '/' menu entry) ─────────────────────────
      function pickFiles(sessionId) {
        var input = document.createElement('input')
        input.type = 'file'
        input.multiple = true
        input.onchange = function () {
          var files = input.files
          if (files !== null) {
            for (var i = 0; i < files.length; i += 1) {
              intake(sessionId, files[i])
            }
          }
          input.remove()
        }
        input.click()
      }

      // ── drop interception (capture phase: runs before the built-in listener) ──
      function hasFileDrag(event) {
        var dt = event.dataTransfer
        if (dt === null || dt === undefined) return false
        var types = dt.types
        if (types === undefined || types === null) return false
        for (var i = 0; i < types.length; i += 1) {
          if (types[i] === 'Files') return true
        }
        return false
      }

      var onDragOverCapture = function (event) {
        if (!hasFileDrag(event)) return
        event.preventDefault()
        if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'copy'
      }

      var onDropCapture = function (event) {
        var dt = event.dataTransfer
        if (dt === null || dt === undefined || dt.files === undefined || dt.files === null || dt.files.length === 0) return
        var files = []
        for (var i = 0; i < dt.files.length; i += 1) files.push(dt.files[i])
        event.preventDefault()
        event.stopPropagation()
        window.dispatchEvent(new Event('dragend'))
        var sessionId = currentSessionId()
        if (sessionId === undefined || sessionId === null) {
          console.warn('[file-attach] drop ignored: no active session')
          return
        }
        for (var j = 0; j < files.length; j += 1) intake(sessionId, files[j])
      }

      document.addEventListener('dragover', onDragOverCapture, true)
      document.addEventListener('drop', onDropCapture, true)

      // ── dock: progress + file list (conversation.input.dock) ────────────
      // The dock slot is a full-width row above the composer card. Opt into
      // DSH's shared composer width axis so the file list matches the card.
      var aligned = Core.composerAlignedBox()
      var dockStyle = {
        root: Object.assign({
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          padding: '4px 0',
          color: 'var(--dsw-fg, inherit)',
          fontSize: '12px',
        }, aligned),
        row: {
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          minWidth: 0,
        },
        chips: {
          display: 'flex',
          flexWrap: 'wrap',
          gap: '6px',
          flex: '1 1 auto',
          minWidth: 0,
        },
        chip: {
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: '6px',
          maxWidth: '100%',
          padding: '2px 8px',
          border: '1px solid var(--dsw-border, currentColor)',
          borderRadius: '999px',
          lineHeight: '1.4',
          overflow: 'hidden',
        },
        chipName: {
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        },
        chipSize: {
          opacity: 0.65,
          flex: '0 0 auto',
        },
        barWrap: {
          flex: '1 1 auto',
          minWidth: 0,
        },
        bar: {
          display: 'block',
          width: '100%',
          height: '4px',
          accentColor: 'var(--dsw-accent, currentColor)',
        },
        status: {
          flex: '0 0 auto',
          opacity: 0.75,
          whiteSpace: 'nowrap',
        },
        add: {
          flex: '0 0 auto',
          marginLeft: 'auto',
          padding: '2px 8px',
          border: '1px solid var(--dsw-border, currentColor)',
          borderRadius: '6px',
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: '12px',
        },
      }

      function AttachDock(props) {
        var sessionId = props.sessionId
        var bump = React.useState(0)
        var setRev = bump[1]
        React.useEffect(function () {
          function ping() { setRev(function (n) { return n + 1 }) }
          dockListeners.add(ping)
          return function () { dockListeners.delete(ping) }
        }, [])
        var items = dockForSession(sessionId)
        if (items.length === 0) return null
        var inflight = items.filter(function (item) {
          return item.phase === 'uploading' || item.phase === 'extracting'
        })
        var ready = items.filter(function (item) { return item.phase === 'ready' })
        var children = []
        if (inflight.length > 0) {
          var received = 0
          var total = 0
          for (var i = 0; i < inflight.length; i += 1) {
            received += inflight[i].received || 0
            total += inflight[i].total || 0
          }
          var extracting = inflight.some(function (item) { return item.phase === 'extracting' })
          var label = extracting
            ? t('extracting', { name: inflight[0].name })
            : Core.humanSize(received) + ' / ' + Core.humanSize(total)
          children.push(React.createElement('div', { key: 'progress', style: dockStyle.row },
            React.createElement('div', { style: dockStyle.barWrap },
              React.createElement('progress', {
                style: dockStyle.bar,
                value: total > 0 ? received : 0,
                max: total > 0 ? total : 1,
              }),
            ),
            React.createElement('span', { style: dockStyle.status }, label),
          ))
        }
        var chipNodes = ready.map(function (item) {
          return React.createElement('span', { key: item.id || item.key, style: dockStyle.chip },
            React.createElement('span', { style: dockStyle.chipName }, item.name),
            item.size !== undefined
              ? React.createElement('span', { style: dockStyle.chipSize }, Core.humanSize(item.size))
              : null,
          )
        })
        children.push(React.createElement('div', { key: 'files', style: dockStyle.row },
          React.createElement('div', { style: dockStyle.chips }, chipNodes),
          React.createElement('button', {
            type: 'button',
            style: dockStyle.add,
            'aria-label': t('attach'),
            title: t('attach'),
            onClick: function () { props.attach(sessionId) },
          }, t('addFiles')),
        ))
        return React.createElement('div', { style: dockStyle.root }, children)
      }

      ctx.slots.inject('conversation.input.dock', function () {
        return ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'file-attach',
          locale: NS,
          inject: function () {
            return {
              attach: function (sessionId) { pickFiles(sessionId) },
            }
          },
        }, AttachDock)
      })

      // ── hide extract fences in conversation UI (model form stays intact) ──
      function hideExtractFromUi(target) {
        Core.hideExtractInTree(target === undefined || target === null ? document.body : target)
      }

      var extractObserver = null
      var extractPoll = null
      if (typeof MutationObserver === 'function' && document.body !== undefined && document.body !== null) {
        extractObserver = new MutationObserver(function (records) {
          for (var r = 0; r < records.length; r += 1) {
            var record = records[r]
            if (record.type === 'characterData') {
              hideExtractFromUi(record.target)
              continue
            }
            var added = record.addedNodes
            if (added === undefined || added === null) continue
            for (var n = 0; n < added.length; n += 1) hideExtractFromUi(added[n])
          }
        })
        extractObserver.observe(document.documentElement || document.body, {
          childList: true,
          subtree: true,
          characterData: true,
        })
        hideExtractFromUi(document.body)
        extractPoll = setInterval(function () { hideExtractFromUi(document.body) }, 1000)
        if (typeof extractPoll === 'object' && extractPoll !== null && typeof extractPoll.unref === 'function') {
          extractPoll.unref()
        }
      }

      // ── teardown ──────────────────────────────────────────────────────────
      ctx.effect(function () {
        return function () {
          document.removeEventListener('dragover', onDragOverCapture, true)
          document.removeEventListener('drop', onDropCapture, true)
          if (extractObserver !== null) extractObserver.disconnect()
          if (extractPoll !== null) clearInterval(extractPoll)
          for (var controller of activeUploads) controller.abort()
          activeUploads.clear()
          dockItems = []
          dockListeners.clear()
        }
      }, 'file-attach: teardown')
    },
  }
}
