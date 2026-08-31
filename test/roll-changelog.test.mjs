import test from 'node:test'
import assert from 'node:assert/strict'
import { repoWebUrl, rollChangelog, utcDate } from '../scripts/roll-changelog.mjs'

const repoUrl = 'git+https://github.com/LucasXingg/dsh-file-attach.git'
const web = 'https://github.com/LucasXingg/dsh-file-attach'

const changelog = [
  '# Changelog',
  '',
  'All notable changes to this project are documented in this file.',
  '',
  '## [Unreleased]',
  '',
  '### Fixed',
  '',
  '- Hide the extract fence when a bubble is split across nodes.',
  '',
  '## [0.1.0] - 2026-08-24',
  '',
  '### Added',
  '',
  '- First release.',
  '',
  `[Unreleased]: ${web}/compare/v0.1.0...HEAD`,
  `[0.1.0]: ${web}/releases/tag/v0.1.0`,
  '',
].join('\n')

test('repoWebUrl normalizes the package.json repository field', () => {
  assert.equal(repoWebUrl(repoUrl), web)
  assert.equal(repoWebUrl({ url: repoUrl }), web)
  assert.throws(() => repoWebUrl({}), /repository url/)
})

test('utcDate formats the day in UTC', () => {
  assert.equal(utcDate(new Date('2026-08-31T23:59:00Z')), '2026-08-31')
})

test('rollChangelog dates the entries and repoints the links', () => {
  const rolled = rollChangelog(changelog, { version: '0.1.1', date: '2026-08-31', repoUrl })
  assert.match(rolled, /## \[Unreleased\]\n\n## \[0\.1\.1\] - 2026-08-31\n\n### Fixed\n\n- Hide the extract fence/)
  assert.match(rolled, /- Hide the extract fence when a bubble is split across nodes\.\n\n## \[0\.1\.0\] - 2026-08-24/)
  assert.match(rolled, new RegExp(`\\[Unreleased\\]: ${web}/compare/v0\\.1\\.1\\.\\.\\.HEAD`))
  assert.match(rolled, new RegExp(`\\[0\\.1\\.1\\]: ${web}/releases/tag/v0\\.1\\.1`))
  assert.match(rolled, new RegExp(`\\[0\\.1\\.0\\]: ${web}/releases/tag/v0\\.1\\.0`))
  assert.equal(rolled.match(/## \[0\.1\.1\]/g).length, 1)

  // Rolling twice for the same version, or with nothing recorded, is refused.
  assert.throws(() => rollChangelog(rolled, { version: '0.1.1', date: '2026-08-31', repoUrl }), /already has a 0\.1\.1/)
  assert.throws(() => rollChangelog(rolled, { version: '0.1.2', date: '2026-09-01', repoUrl }), /nothing to release/)
})

test('rollChangelog handles a first release with no link section', () => {
  const first = ['# Changelog', '', '## [Unreleased]', '', '### Added', '', '- Everything.', ''].join('\n')
  const rolled = rollChangelog(first, { version: '0.1.0', date: '2026-08-24', repoUrl })
  assert.match(rolled, /## \[0\.1\.0\] - 2026-08-24\n\n### Added\n\n- Everything\./)
  assert.match(rolled, new RegExp(`\\[Unreleased\\]: ${web}/compare/v0\\.1\\.0\\.\\.\\.HEAD`))
  assert.match(rolled, new RegExp(`\\[0\\.1\\.0\\]: ${web}/releases/tag/v0\\.1\\.0`))
})

test('rollChangelog rejects a changelog with no Unreleased section', () => {
  assert.throws(
    () => rollChangelog('# Changelog\n\n## [0.1.0] - 2026-08-24\n', { version: '0.1.1', date: 'x', repoUrl }),
    /no "## \[Unreleased\]" section/,
  )
})
