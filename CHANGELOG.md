# Changelog

All notable changes to this project are documented in this file. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- Keep extract text out of the rendered conversation when a message holds
  several attachments. The conversation splits a user bubble into several
  nodes (it decorates `/name` and `@name` tokens), so a fence could start in
  one node and end in another; the previous single-node, newline-anchored
  match then left the whole OCR and description body on screen. The scrub now
  reads a fence-bearing subtree as one character stream, matches the markers
  without requiring the surrounding newlines, collapses nodes that carried
  nothing but fenced text, and installs before the plugin's other
  registrations so it cannot be skipped.

## [0.1.0] - 2026-08-24

### Added

- Drag-and-drop uploads for PDF, Office, notebook, text, code, and raster image
  files.
- Chunked, session-scoped storage with configurable upload and extraction
  limits.
- Document extraction, OCR fallback, and native DSH vision routing for
  image-capable models.
- Composer attachment chips, progress feedback, file picker integration, and
  persisted `/attach` token support.
- Agent tools for notebook output, PDF page OCR, image description, and saving
  original files into the workspace.
- Automated tests, Node.js 22/24 CI, and tag-driven GitHub Release packaging.
- npm package name `@lucasxingg/dsh-file-attach` (the unscoped name is taken).

[Unreleased]: https://github.com/LucasXingg/dsh-file-attach/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/LucasXingg/dsh-file-attach/releases/tag/v0.1.0
