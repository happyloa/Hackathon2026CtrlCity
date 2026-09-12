#!/usr/bin/env node
/**
 * Guards the nine-step type scale defined in `assets/css/main.css`.
 *
 * The scale is only "unified" if it cannot be bypassed, and there are exactly
 * two ways to bypass it: a literal `font-size` in CSS, or one of Tailwind's
 * own size utilities in a template. Tailwind's scale is already deleted
 * (`--text-*: initial`), so `text-sm` silently renders nothing -- which is
 * worse than an error. This script turns both into a build failure.
 *
 * Run via `npm run type:validate`; also runs as part of `npm test`.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const SKIP_DIRS = new Set(['node_modules', '.nuxt', '.output', '.git', 'dist'])

/** The nine roles, plus the documented non-type escapes. */
const ALLOWED_FONT_SIZE = new Set([
  'var(--type-display)',
  'var(--type-h1)',
  'var(--type-h2)',
  'var(--type-h3)',
  'var(--type-h4)',
  'var(--type-h5)',
  'var(--type-h6)',
  'var(--type-body1)',
  'var(--type-body2)',
  // Icon boxes and map/chart marker labels -- not type. See main.css.
  'var(--icon-sm)',
  'var(--icon-md)',
  'var(--icon-lg)',
  'var(--icon-xl)',
  'var(--marker-label)',
  'var(--marker-label-lg)',
  // Inheriting is always fine.
  'inherit',
  '1em',
])

/** Tailwind's deleted size utilities, which must not appear in templates. */
const BANNED_CLASS = /(?<![\w-])(?:(?:sm|md|lg|xl|2xl|min-\[[^\]]+\]|max-\[[^\]]+\]):)*text-(?:xs|sm|base|lg|xl|2xl|3xl|4xl|5xl|6xl|7xl|8xl|9xl|\[[^\]]*(?:px|rem|em|pt)[^\]]*\])(?![\w-])/g

/** `main.css` owns the scale itself, so its own declarations are exempt. */
const SCALE_SOURCE = 'assets/css/main.css'

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(vue|css|ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

const lineOf = (text, index) => text.slice(0, index).split('\n').length

/**
 * Blanks out comments and `<code>` spans while preserving offsets, so line
 * numbers stay right and prose that merely *names* a banned utility -- this
 * file, main.css's own header, the design-system reference page -- is not
 * reported as a usage.
 */
const blankProse = (text) =>
  text.replace(
    /\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|<code\b[^>]*>[\s\S]*?<\/code>/g,
    (block) => block.replace(/[^\n]/g, ' '),
  )

const problems = []
for (const file of walk(root)) {
  const path = relative(root, file)
  const text = blankProse(readFileSync(file, 'utf8'))

  if (path !== SCALE_SOURCE) {
    for (const match of text.matchAll(/font-size:\s*([^;}"'\n]+)/g)) {
      const value = match[1].trim()
      if (ALLOWED_FONT_SIZE.has(value)) continue
      problems.push({
        path,
        line: lineOf(text, match.index),
        detail: `off-scale font-size: ${value}`,
        hint: 'use var(--type-h1) … var(--type-body2), or var(--icon-*) for an icon box',
      })
    }
  }

  for (const match of text.matchAll(BANNED_CLASS)) {
    problems.push({
      path,
      line: lineOf(text, match.index),
      detail: `removed Tailwind size utility: ${match[0]}`,
      hint: 'use text-display / text-h1 … text-h6 / text-body1 / text-body2',
    })
  }
}

if (problems.length === 0) {
  console.log('✓ type scale: every font size resolves to one of the nine steps')
  process.exit(0)
}

console.error(`✗ type scale: ${problems.length} off-scale font size${problems.length === 1 ? '' : 's'}\n`)
for (const { path, line, detail, hint } of problems) {
  console.error(`  ${path}:${line}\n    ${detail}\n    → ${hint}`)
}
process.exit(1)
