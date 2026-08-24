<p align="center">
  <img src="docs/assets/cover.jpg" alt="dsh-file-attach — Files in. Context ready." width="100%">
</p>

# dsh-file-attach

[![CI](https://github.com/lucadxingg/unified-file-reader/actions/workflows/ci.yml/badge.svg)](https://github.com/lucadxingg/unified-file-reader/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/lucadxingg/unified-file-reader)](https://github.com/lucadxingg/unified-file-reader/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH plugin](https://img.shields.io/badge/topic-dsh--plugin-6f5cff)](https://github.com/topics/dsh-plugin)

Drag-and-drop **any file type** into a DSH conversation — PDF, Office
(DOCX / PPTX / XLSX), raster images, and plain text / code files (`.py`,
`.js`, `.html`, `.ipynb`, `.md`, `.csv`, …). The **host plugin extracts**
the file (and OCRs / explains images on text-only models) at upload time and splices that text
into the user message so the model can read it without python-docx / pypdf
hints. Raster images take DSH's built-in composer vision path when the current
model declares `image` input; otherwise they use this extract path. Originals live under `$DSH_HOME/file-attach/<sessionId>/<id>/`
(outside the session workspace). The model sees extract text; `attach_save`
is the only way to copy a file into the working directory.

This is a dual-half bundle: one npm package that ships a **host plugin** (the
ingest HTTP routes + tools, package `main` → `lib/index.js`) and a **web
client half** (`dsh.client` + `exports["./client"]` → `lib/client.js`, served
by the web shell at `/plugins/<id>/client.js`).

## Highlights

- One drop target for documents, spreadsheets, notebooks, source code, and images.
- Native DSH vision for image-capable models, with OCR/extraction fallback for
  text-only models.
- Chunked uploads, progress feedback, configurable limits, and session-scoped
  storage outside the agent workspace.
- Focused `attach_*` tools for saving originals, inspecting notebook output,
  OCRing individual PDF pages, and describing images.

## How it works

```
user drops file or image → capture-phase drop listener (client)
  → if the file is a raster image and the current model declares image input:
       DSH composer vision path (draft thumbnails → ImageBlock on send)
  → otherwise chunked binary upload → POST /api/dsh-file-attach/upload (host)
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

Images use the built-in ComposerAttachment vision path when the session model
lists `image` in `inputModalities`. Text-only or unknown models keep the
plugin OCR / explain extract so the model still sees the picture as text.

## Install

Requires Node.js 22.13 or newer and a DSH installation. Download and extract a
tarball from [GitHub Releases](https://github.com/lucadxingg/unified-file-reader/releases),
or clone this repository, then install the extracted project directory:

```sh
dsh plugin --profile <profile-name> add /path/to/dsh-file-attach
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

- Drop a file or image anywhere on the page while a session is active. Images
  land on the composer vision rail when the current model is visual; otherwise
  they upload, extract, and a chip appears in the draft.
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
npm ci
npm test
npm run build:client   # regenerate lib/client.js from src/
```

Pull requests run the same tests on Node.js 22 and 24. To inspect the exact
artifact that a tagged GitHub release will publish:

```sh
npm pack --dry-run
```

## Releases

Releases follow semantic versioning and are recorded in
[CHANGELOG.md](CHANGELOG.md). Update the changelog and `version` in
`package.json` and `package-lock.json`, commit the change, then push a matching
`v*` tag (for example, `v0.1.0`). The release workflow tests the tag, verifies
that the generated client bundle is current, packs the npm tarball, and
publishes it to GitHub Releases with generated notes.

See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance and
[SECURITY.md](SECURITY.md) for private vulnerability reporting.

Layout:

```
lib/index.js          host plugin: routes, extraction at ingest, tools
lib/extract.js        host extractors (text/PDF/Office/notebook/OCR)
lib/ingest.js         sanitize / admission / model form / chunk plan / vault paths
lib/vision.js         current-model visual capability (inputModalities)
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
- **Image pixels follow the current model.** Visual models (`inputModalities`
  includes `image`) use DSH's built-in composer image pipeline. Other models
  still see OCR/description text. `attach_describe_image` can start a
  vision-capable subagent when `ctx.subagents` is mounted.
- **Drop is page-wide.** Any drop attaches to the current session.
- **Trust posture.** Ingest routes are same-origin and verify the session
  exists, but carry no bearer credential. Bind the host to `127.0.0.1`.
