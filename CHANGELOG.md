# Changelog

All notable changes to this project are documented in this file. The project
follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[0.1.0]: https://github.com/lucadxingg/unified-file-reader/releases/tag/v0.1.0
