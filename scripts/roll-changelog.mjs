#!/usr/bin/env node
/**
 * Roll CHANGELOG.md for a release.
 *
 * Moves everything under `## [Unreleased]` into a dated `## [x.y.z]` section,
 * leaves an empty Unreleased section behind, and repoints the link
 * definitions at the bottom of the file.
 *
 * The release workflow runs this right after `npm version`, so the version and
 * the repository URL both come from package.json. An empty Unreleased section
 * is an error: a release with no recorded changes is a mistake, not a no-op.
 *
 * Usage: node scripts/roll-changelog.mjs [version] [YYYY-MM-DD]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const UNRELEASED = '## [Unreleased]'

/** `owner/repo` web URL from a package.json repository field. */
export function repoWebUrl(repository) {
  const raw = typeof repository === 'string' ? repository : repository?.url
  if (typeof raw !== 'string' || raw === '') throw new Error('package.json has no repository url')
  return raw.replace(/^git\+/, '').replace(/\.git$/, '')
}

/** True for a link definition line such as `[0.1.0]: https://…`. */
function isLinkDefinition(line) {
  return /^\[[^\]]+\]:\s/.test(line)
}

/**
 * Move the Unreleased entries under `version`.
 * @param text - current CHANGELOG.md contents.
 * @param options - `{ version, date, repoUrl }`.
 * @returns the rolled contents.
 */
export function rollChangelog(text, { version, date, repoUrl }) {
  const heading = `## [${version}]`
  if (text.includes(heading)) throw new Error(`CHANGELOG.md already has a ${version} section`)
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === UNRELEASED)
  if (at === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED}" section`)

  let end = lines.length
  for (let i = at + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ') || isLinkDefinition(lines[i])) {
      end = i
      break
    }
  }
  const body = lines.slice(at + 1, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
  if (body === '') throw new Error(`${UNRELEASED} is empty — nothing to release`)

  const rolled = [
    UNRELEASED,
    '',
    `${heading} - ${date}`,
    '',
    body,
    '',
  ]
  const out = [...lines.slice(0, at), ...rolled, ...lines.slice(end)]

  // Link definitions: Unreleased now compares against the new tag, and the new
  // version gets its own release link above the older ones.
  const unreleasedLink = `[Unreleased]: ${repoWebUrl(repoUrl)}/compare/v${version}...HEAD`
  const versionLink = `[${version}]: ${repoWebUrl(repoUrl)}/releases/tag/v${version}`
  const linkAt = out.findIndex((line) => line.startsWith('[Unreleased]:'))
  if (linkAt === -1) {
    const trailing = out[out.length - 1] === '' ? out.length - 1 : out.length
    out.splice(trailing, 0, unreleasedLink, versionLink)
  } else {
    out.splice(linkAt, 1, unreleasedLink, versionLink)
  }
  return out.join('\n')
}

/** Today in UTC as `YYYY-MM-DD`. */
export function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10)
}

if (process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = process.argv[2] ?? pkg.version
  const date = process.argv[3] ?? utcDate()
  const file = path.join(root, 'CHANGELOG.md')
  const rolled = rollChangelog(readFileSync(file, 'utf8'), { version, date, repoUrl: pkg.repository })
  writeFileSync(file, rolled)
  console.log(`rolled CHANGELOG.md for ${version} (${date})`)
}
