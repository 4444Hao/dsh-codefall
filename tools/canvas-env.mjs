/**
 * Shared canvas + font bootstrap for the offline tools.
 *
 * `@napi-rs/canvas` is an OPTIONAL dev dependency: the plugin's runtime needs no
 * npm packages at all, and two of the three test suites (host, client) run on
 * plain Node. Only the pixel-level tools need a canvas, so it is resolved here
 * once — and the monospace font comes from a per-platform candidate list rather
 * than a hard-coded Windows path, so the tools run on macOS and Linux too.
 *
 *   npm i -D @napi-rs/canvas        # or: pnpm add -D @napi-rs/canvas
 */
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/** Resolve the optional canvas backend, or null when it is not installed. */
export function loadCanvas() {
  // An explicit hint wins: DSH_CODEFALL_CANVAS_PATH may point at a node_modules
  // directory that already contains @napi-rs/canvas (the DSH runtime ships one).
  // Otherwise resolve normally from this repository, i.e. the devDependency.
  const anchors = []
  if (process.env.DSH_CODEFALL_CANVAS_PATH) {
    anchors.push(join(process.env.DSH_CODEFALL_CANVAS_PATH, 'noop.js'))
  }
  anchors.push(import.meta.url)

  for (const anchor of anchors) {
    try {
      const require = createRequire(anchor)
      const canvas = require('@napi-rs/canvas')
      if (canvas && typeof canvas.createCanvas === 'function') return canvas
    } catch {
      /* try the next anchor */
    }
  }
  return null
}

/** How to install the optional dependency, for the tools' error messages. */
export const CANVAS_HINT =
  'The pixel-level tools need the optional dev dependency @napi-rs/canvas:\n' +
  '    npm i -D @napi-rs/canvas\n' +
  '    pnpm add -D @napi-rs/canvas\n' +
  'The host and client suites need nothing at all:\n' +
  '    node tools/host-test.mjs && node tools/client-test.mjs'

const FONT_DIRS = {
  win32: ['C:/Windows/Fonts/consola.ttf', 'C:/Windows/Fonts/cour.ttf', 'C:/Windows/Fonts/lucon.ttf'],
  darwin: [
    '/System/Library/Fonts/Menlo.ttc',
    '/System/Library/Fonts/SFNSMono.ttf',
    '/Library/Fonts/Courier New.ttf'
  ],
  linux: [
    '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf',
    '/usr/share/fonts/truetype/liberation/LiberationMono-Regular.ttf',
    '/usr/share/fonts/TTF/DejaVuSansMono.ttf'
  ]
}

/**
 * Register a monospace family for deterministic glyph metrics.
 *
 * @returns the family name to pass as `fontFamily`, or null when no candidate
 *   font exists (the caller falls back to the platform default and the
 *   font-sensitive assertions get more tolerance).
 */
export function registerMonoFont(GlobalFonts) {
  const override = process.env.DSH_CODEFALL_FONT
  const candidates = override
    ? [{ path: override, family: 'CodefallMono' }]
    : (FONT_DIRS[process.platform] || FONT_DIRS.linux).map((path) => ({ path, family: 'CodefallMono' }))

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate.path)) continue
      GlobalFonts.registerFromPath(candidate.path, candidate.family)
      return candidate.family
    } catch {
      /* try the next candidate */
    }
  }
  return null
}
