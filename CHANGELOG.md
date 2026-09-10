# Changelog

All notable changes to this project are documented in this file. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Develop mode on the Plugins settings card. When it is on, the conversation
  UI no longer hides extract text this plugin sends to the model. YAML
  `developMode` is only the inherited default; already-hidden bubbles stay
  compact until the page reloads.

## [0.1.2] - 2026-09-10

### Fixed

- Ready files in the composer dock now include a remove control. **×** removes
  the matching blue filename from the composer (vault files are kept). After
  the message is sent, or when that filename is deleted with Backspace, the
  dock entry disappears instead of lingering above the input.

### Changed

- The blue filename in the composer is only a short reference for the model.
  Every extract is appended behind the user prompt at send time, no matter
  where that filename sits in the composer. The file list above the composer
  is the set of files in that end section. Extract fences stay hidden in the
  conversation UI.

## [0.1.1] - 2026-08-31

### Added

- One-button releases: the release workflow now bumps the version, dates the
  Unreleased changelog entries, commits and tags, publishes to npm with
  provenance (trusted publishing, or `NPM_TOKEN` when that secret exists), and
  publishes the GitHub Release. Pushing a `v*` tag still releases the committed
  version, and both paths are safe to re-run.

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

[Unreleased]: https://github.com/LucasXingg/dsh-file-attach/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/LucasXingg/dsh-file-attach/releases/tag/v0.1.2
[0.1.1]: https://github.com/LucasXingg/dsh-file-attach/releases/tag/v0.1.1
[0.1.0]: https://github.com/LucasXingg/dsh-file-attach/releases/tag/v0.1.0
