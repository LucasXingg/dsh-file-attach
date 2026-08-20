# dsh-file-attach

Drag-and-drop **any file type** into a DSH conversation — PDF, Office
(DOCX / PPTX / XLSX), raster images, and plain text / code files (`.py`,
`.js`, `.html`, `.ipynb`, `.md`, `.csv`, …). The **host plugin extracts**
the file (and OCRs / explains images) at upload time and splices that text
into the user message so the model can read it without python-docx / pypdf
hints. Originals live under `$DSH_HOME/file-attach/<sessionId>/<id>/`
(outside the session workspace). The model sees extract text; `attach_save`
is the only way to copy a file into the working directory.

This is a dual-half bundle: one npm package that ships a **host plugin** (the
ingest HTTP routes + tools, package `main` → `lib/index.js`) and a **web
client half** (`dsh.client` + `exports["./client"]` → `lib/client.js`, served
by the web shell at `/plugins/<id>/client.js`).

## How it works

```
user drops file or image → capture-phase drop listener (client)
  → chunked binary upload → POST /api/dsh-file-attach/upload (host)
       → host writes $DSH_HOME/file-attach/<sessionId>/<id>/<sanitized-name>
       → host extracts text (PDF/Office/notebook/OCR/explain)
       → writes extract.json; returns { id, name, size, extract }
  → client shows progress in conversation.input.dock, inserts an inline chip
  → on send, codec serialize splices the extract into the user message:
         [attached file "report.pdf" (2.4 MB) id=a1b2c3d4e5f6]
         ----- extracted content -----
         …
         ----- end -----
```

Images are claimed by this plugin (not the built-in ComposerAttachment vision
path). The model sees OCR text plus an optional short description, not pixels.

## Install

The bundle installs into a profile with the documented community flow:

```sh
# from the directory containing this package
dsh plugin --profile <profile-name> add .
```

The patch (`cordis.patch.yml`) inserts one row (`id: file-attach`) which both
mounts the host routes/tools and registers the web client half. **Restart the
host process** (`dsh web`) and refresh the page — the running GUI cannot
hot-install bundles. After a restart the client bundle is served from the boot
graph (`window.__DSH_BOOT__`).

## Config (row `config` in cordis.patch.yml)

| Key | Default | Meaning |
|---|---|---|
| `maxFileBytes` | 52428800 (50 MB) | Maximum encoded bytes per file |
| `maxFilesPerMessage` | 20 | Maximum files admitted to one message (client-mirrored) |
| `maxConcurrentUploads` | 20 | Maximum concurrent upload sessions host-side |
| `vaultDir` | `file-attach` | Subdirectory of `$DSH_HOME` (or `~/.dsh`) receiving originals |
| `maxExtractChars` | 80000 | Cap on text spliced into the model form |
| `explainImages` | true | One-shot vision caption when `ctx.llm` is available |
| `ocrLanguages` | `eng+chi_sim` | Tesseract language packs |
| `explainTimeoutMs` | 30000 | Timeout for the optional image-explain call |
| `describeProvider` | `spawn` | Subagent provider used by `attach_describe_image` |

## What the agent sees

The model form is spliced into the user message at send time:

```
[attached file "report.pdf" (2.4 MB) id=a1b2c3d4e5f6]
----- extracted content -----
…extracted text…
----- end -----
```

`id=` is the 12-character hex upload id. Pass that to `attach_*` tools
(not the filename). A unique original filename is also accepted as `id`.
Vault paths are never included in the prompt. The conversation transcript
hides the `----- extracted content -----` fence and shows the header line
only; copy/log still contain the model form.

Notebook ingest keeps **the last two lines** of each cell's text output.
Scanned PDFs with an empty text layer note that and point at
`attach_pdf_ocr_page`. Image ingest includes OCR and, when possible, a short
description.

## Tools

| Tool | Arguments | Purpose |
|---|---|---|
| `attach_notebook_output` | `id`, `cell` (0-based) | Full text output of one notebook cell. Example: `{"id":"a1b2c3d4e5f6","cell":0}` |
| `attach_pdf_ocr_page` | `id`, `page` (1-based) | Rasterize that PDF page and OCR it. Example: `{"id":"a1b2c3d4e5f6","page":1}` |
| `attach_describe_image` | `id`, `prompt` | One-shot subagent describes the image. Example: `{"id":"a1b2c3d4e5f6","prompt":"List every label"}` |
| `attach_save` | `id`, `path` | Copy the original from the vault into the session workspace. Example: `{"id":"a1b2c3d4e5f6","path":"docs/report.pdf"}` |

## UI

- Drop a file or image anywhere on the page while a session is active → it
  uploads, is extracted, and a chip appears in the draft.
- A strip above the composer (`conversation.input.dock`) lists attached files
  and shows a determinate progress bar while a file is uploading or extracting.
  The strip uses DSH's composer width axis (`--dsh-composer-card-max-width`)
  so it lines up with the input card. An **Add** control on that strip opens
  the file picker.
- After send, the model still receives the extracted-content fence; the
  conversation UI shows only the `[attached file …]` header (the extract body
  is stripped before paint).
- The `/` menu offers an "Attach files…" entry.
- After a page reload, a persisted `/attach <id>` token is still understood;
  serialize fetches `GET /api/dsh-file-attach/extract` to recover the text.

## Development

```sh
npm install
npm test
npm run build:client   # regenerate lib/client.js from src/
```

Layout:

```
lib/index.js          host plugin: routes, extraction at ingest, tools
lib/extract.js        host extractors (text/PDF/Office/notebook/OCR)
lib/ingest.js         sanitize / admission / model form / chunk plan / vault paths
lib/tools.js          attach_* tool definitions
lib/client.js         web bundle (generated; module-table load handoff)
src/client-core.js    client pure logic (plain script, inlined)
src/client-app.js     client plugin body (plain script, inlined)
scripts/build-client.mjs  assembly script
test/                 node:test suites
```

## Known limitations and deferred work

- **Post-reload in-draft chips.** Occurrence chips restore as plain text; send
  still recovers extract.json via the extract route / `matchEnter`.
- **Committed files are not garbage-collected.** Removing a chip does not
  delete the original from the vault. Partial uploads are cleaned up.
- **Scanned PDFs are not OCR'd at ingest.** Use `attach_pdf_ocr_page` per page.
- **Image pixels are not sent on the built-in vision path.** The model sees
  OCR/description text. `attach_describe_image` can start a vision-capable
  subagent when `ctx.subagents` is mounted.
- **Drop is page-wide.** Any drop attaches to the current session.
- **Trust posture.** Ingest routes are same-origin and verify the session
  exists, but carry no bearer credential. Bind the host to `127.0.0.1`.
