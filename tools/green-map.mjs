/**
 * Generate the green token override layer.
 *
 *   node tools/green-map.mjs              # review: every blue ramp step and its green
 *   node tools/green-map.mjs --emit       # write lib/theme-tokens.js
 *   node tools/green-map.mjs --emit --out <file>
 *
 * Rule (decided with the product owner):
 *   - KEEP lightness. Every contrast relationship in the design system rests on
 *     it, so preserving L is what makes a hue swap safe instead of a redesign.
 *   - CHANGE hue to the digital rain's own green (145 deg).
 *   - CLAMP saturation into the rain's band (55-80%) for accent colours; the blue
 *     ramp runs at 77-100% and carried over verbatim it reads as neon. Tints that
 *     are already muted (the 6-14% interactive hover layers) keep their own
 *     saturation — boosting those would turn a whisper into a wash.
 *   - PRESERVE alpha, including the 8-digit hex form.
 *
 * Deliberately NOT touched, and the generator asserts it:
 *   - `--dsw-static-neutral-bluish-*` — this ramp IS the white text and the black
 *     background. It measures as faintly blue (hue 210-222, saturation 17-28) so a
 *     naive "hue says blue" pass would tint the ink. That is why this is measured
 *     rather than eyeballed.
 *   - `--dsw-alias-state-success|warn|error-*`, `--dsw-alias-code-diff-*`,
 *     `--dsw-alias-file-diff-*`, `--dsw-alias-interactive-bg-hover-danger` —
 *     semantic state colours stay honest (owner's decision).
 *   - `--dsw-static-amber-*`, `--dsw-static-red-*`, `--dsw-static-green-*`.
 *
 * Syntax highlighting: Shiki is configured in CSS-variables mode, so its palette
 * IS overridable (`--shiki-token-*`). Only its two blues are greened; the rest is
 * a functional legend (keyword pink, parameter orange, function purple, comment
 * grey) and flattening it to green would cost readability, not gain theme.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const TOKENS = resolve(REPO, 'tools/out/theme-tokens.css')
const DEFAULT_OUT = resolve(REPO, 'lib/client.js')
/** Path reported when emitting into the default target. */
const CLIENT = DEFAULT_OUT
/** Committed fixture: the remap's output at the default hue. */
const GOLDEN = resolve(REPO, 'tools/fixtures/green-145.json')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const emit = argv.includes('--emit')
const OUT = resolve(REPO, opt('out', DEFAULT_OUT))

/* ---------------------------------------------------------------- *
 * rule
 * ---------------------------------------------------------------- */
/** The rain's mid greens: #22c55e (145), #4ade80 (142), #86efac (141). */
const TARGET_HUE = 145
const NEUTRAL_SAT = 8
const ACCENT_SAT = 0.5
const SAT_MIN = 0.55
const SAT_MAX = 0.8

/** Static ramp families whose blue end is the theme accent. */
const STATIC_BLUE = /^--dsw-static-(?:deepseek|blue)-/u
/**
 * Alias tokens that hard-code a blue instead of referencing the ramp.
 * Everything else in the alias layer is a `var()` reference and follows the
 * static overrides for free.
 */
const ALIAS_PATCHES = new Set([
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover'
])
/** Shiki's palette, in CSS-variables mode. Only its blues move. */
const SHIKI_PATCHES = new Set(['--shiki-token-constant', '--shiki-token-link'])

/** Tokens that must never appear in the output — asserted, not assumed. */
const FORBIDDEN = [
  /^--dsw-static-neutral/u,
  /^--dsw-static-amber/u,
  /^--dsw-static-red/u,
  /^--dsw-static-green/u,
  /^--dsw-alias-state-(success|warn|error)/u,
  /^--dsw-alias-code-diff/u,
  /^--dsw-alias-file-diff/u,
  /danger/u,
  /^--dsw-alias-label/u,
  /^--dsw-alias-bg-base$/u
]

/* ---------------------------------------------------------------- *
 * parse: top-level blocks give the palette, declarations give values
 * ---------------------------------------------------------------- */
const css = readFileSync(TOKENS, 'utf8')

function topLevelBlocks(text) {
  const blocks = []
  let depth = 0
  let start = 0
  let selector = ''
  let declStart = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (c === '{') {
      if (depth === 0) {
        selector = text.slice(start, i).trim()
        declStart = i + 1
      }
      depth++
    } else if (c === '}') {
      depth--
      if (depth === 0) {
        blocks.push({ selector, body: text.slice(declStart, i) })
        start = i + 1
      }
    }
  }
  return blocks
}

function toRgb(value) {
  const v = value.trim().toLowerCase()
  let m = /^#([\da-f]{3,8})$/u.exec(v)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
    }
  }
  m = /^rgba?\(([^)]+)\)$/u.exec(v)
  if (!m) return null
  const p = m[1].split(/[,\s/]+/u).filter(Boolean).map(Number)
  return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }
}

function rgbToHsl({ r, g, b }) {
  const R = r / 255
  const G = g / 255
  const B = b / 255
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === R) h = 60 * (((G - B) / d) % 6)
    else if (max === G) h = 60 * ((B - R) / d + 2)
    else h = 60 * ((R - G) / d + 4)
  }
  return { h: h < 0 ? h + 360 : h, s, l }
}

function hslToHex(h, s, l, alpha) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor((((h % 360) + 360) % 360) / 60) % 6
  ]
  const to = (v) => Math.round((v + m) * 255).toString(16).padStart(2, '0')
  const hex = '#' + to(seg[0]) + to(seg[1]) + to(seg[2])
  if (alpha === undefined || alpha >= 1) return hex
  return hex + Math.round(alpha * 255).toString(16).padStart(2, '0')
}

/** The remap itself; `null` means "leave this token alone". */
function remap(value) {
  const rgb = toRgb(value)
  if (!rgb) return null
  const hsl = rgbToHsl(rgb)
  const sat = hsl.s * 100
  if (!(hsl.h >= 175 && hsl.h < 265) || sat < NEUTRAL_SAT) return null
  const s = hsl.s < ACCENT_SAT ? hsl.s : Math.min(SAT_MAX, Math.max(SAT_MIN, hsl.s))
  return { next: hslToHex(TARGET_HUE, s, hsl.l, rgb.a), from: value, hue: Math.round(hsl.h), sat: Math.round(sat) }
}

/* ---------------------------------------------------------------- *
 * collect, one entry per token with its light and dark value
 * ---------------------------------------------------------------- */
const table = new Map()
const review = []

for (const block of topLevelBlocks(css)) {
  const dark = /data-ds-dark-theme/u.test(block.selector)
  const macOS = /darwin/u.test(block.selector)
  if (macOS) continue
  // NOTE: the terminator is optional — a block's LAST declaration is closed by
  // the block's own brace, which is not part of the extracted body. Requiring
  // `[;}]` silently dropped one declaration per block.
  const re = /(--[\w-]+)\s*:\s*([^;}]+)(?:[;}]|$)/gu
  let m
  while ((m = re.exec(block.body)) !== null) {
    const name = m[1]
    const value = m[2].trim()
    const interesting =
      STATIC_BLUE.test(name) || ALIAS_PATCHES.has(name) || SHIKI_PATCHES.has(name) || /^--dsw-static-amber/u.test(name)
    if (!interesting) continue
    const mapped = remap(value)
    if (!table.has(name)) table.set(name, {})
    // Keep the raw declaration next to its replacement: re-running remap() on an
    // already-remapped value finds no blue and silently drops the token.
    table.get(name)[dark ? 'dark' : 'light'] = { raw: value, next: mapped ? mapped.next : value }
    if (STATIC_BLUE.test(name) || ALIAS_PATCHES.has(name) || SHIKI_PATCHES.has(name)) {
      review.push({ name, mode: dark ? 'dark' : 'light', value, ...(mapped || {}) })
    }
  }
}

/* ---------------------------------------------------------------- *
 * resolve var() indirection on the RAW values
 *
 * Some aliases point at a ramp entry rather than carrying a literal (the dark
 * `--dsw-alias-brand-primary-new-colorprimary-new-color` is
 * `var(--dsw-static-deepseek-450)`). The generated table ships the concrete
 * source colour, because the client half remaps whatever it is handed and a
 * `var()` string would have no hue to remap.
 * ---------------------------------------------------------------- */
function resolveRaw(value, mode, depth = 0) {
  const m = /^var\((--[\w-]+)\)$/u.exec(String(value).trim())
  if (!m || depth > 3) return value
  const target = table.get(m[1])
  const step = target && (target[mode] || target.light || target.dark)
  return step ? resolveRaw(step.raw, mode, depth + 1) : value
}

// Only tokens that actually move are worth emitting.
const emitted = {}
const rawEmitted = {}
let blueLeft = 0
const darkOnly = []
for (const [name, pair] of [...table.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  const light = pair.light
  let dark = pair.dark
  if (!light && !dark) continue
  // A token declared once in `:root` and not re-declared for dark has the same
  // effective value in both schemes, so the pair repeats that value. (Shiki's
  // sheet relies on inheritance this way.) A DARK-only declaration would be a
  // different situation and is reported instead of silently guessed.
  if (!light) {
    darkOnly.push(name)
    continue
  }
  if (!dark) dark = light
  const rawLight = resolveRaw(light.raw, 'light')
  const rawDark = resolveRaw(dark.raw, 'dark')
  const lightRemap = remap(rawLight)
  const darkRemap = remap(rawDark)
  const mappedLight = lightRemap ? lightRemap.next : rawLight
  const mappedDark = darkRemap ? darkRemap.next : rawDark
  if (!lightRemap && !darkRemap) continue
  if (lightRemap && remap(mappedLight)) blueLeft++
  if (darkRemap && remap(mappedDark)) blueLeft++
  rawEmitted[name] = { light: rawLight, dark: rawDark }
  emitted[name] = { light: mappedLight, dark: mappedDark }
}

/* ---------------------------------------------------------------- *
 * review output first, so a failing assertion still shows what happened
 * ---------------------------------------------------------------- */
if (!emit) {
  console.log(`source: ${TOKENS}`)
  console.log(`target hue ${TARGET_HUE} deg, sat band ${SAT_MIN * 100}-${SAT_MAX * 100}%\n`)
  const pad = Math.max(...review.map((r) => r.name.length))
  for (const r of review) {
    console.log(
      `${(r.next ? '->' : '  ')} ${r.mode.padEnd(5)} ${r.name.padEnd(pad)}  ${r.value.padEnd(10)}${
        r.next ? `=>  ${r.next}   (was h=${r.hue} s=${r.sat})` : '   (kept)'
      }`
    )
  }
  console.log(`\ntable: ${table.size} tokens collected   review rows: ${review.length}`)
  console.log(`emitted: ${Object.keys(emitted).length} tokens would be overridden   still-blue: ${blueLeft}`)
}

/* ---------------------------------------------------------------- *
 * assertions — a generated file that quietly grew a wrong token is worse
 * than no file, so the invariants are enforced here
 * ---------------------------------------------------------------- */
const problems = []
for (const name of Object.keys(emitted)) {
  for (const bad of FORBIDDEN) {
    if (bad.test(name)) problems.push(`${name} matches forbidden ${bad}`)
  }
  for (const mode of ['light', 'dark']) {
    const v = emitted[name][mode]
    if (typeof v !== 'string' || v.length === 0) problems.push(`${name}.${mode} is not a string`)
  }
}
for (const name of [...ALIAS_PATCHES, ...SHIKI_PATCHES]) {
  if (!emitted[name]) problems.push(`${name} was expected to move but did not`)
}
if (blueLeft > 0) problems.push(`${blueLeft} emitted values are still measurable as blue — expected 0`)
for (const name of darkOnly) problems.push(`${name} is declared only for the dark palette; refusing to guess its light value`)
if (problems.length > 0) {
  console.error('GENERATOR ASSERTIONS FAILED:')
  for (const p of problems) console.error('  - ' + p)
  process.exit(1)
}
if (!emit) {
  console.log(`all ${Object.keys(emitted).length} overridden values measure as non-blue`)
  process.exit(0)
}

/* ---------------------------------------------------------------- *
 * emit — into the browser half, between sentinels
 *
 * The plugin ships no build step and its browser half is a single file, so a
 * relative ESM import is not available there. The table is generated into that
 * file instead, and this tool owns the block between the markers.
 *
 * What ships is the RAW SOURCE COLOURS, not the greens. The hue is a live
 * setting (mechanism A), so the browser half remaps at override time and a hue
 * change costs a re-registration rather than a rebuild. The greens this tool
 * would have written are emitted as a golden fixture instead, so the browser
 * half's arithmetic is pinned to this one's.
 * ---------------------------------------------------------------- */
{
  const names = Object.keys(rawEmitted)
  const lines = names.map((n) => `    '${n}': { light: '${rawEmitted[n].light}', dark: '${rawEmitted[n].dark}' }`)
  const block =
    `    /* --- BEGIN GENERATED: source colours to remap (tools/green-map.mjs --emit) --- */\n` +
    `    var SOURCE_TOKENS = {\n${lines.join(',\n')}\n    }\n` +
    `    /* --- END GENERATED: source colours --- */`

  const BEGIN = '    /* --- BEGIN GENERATED: source colours to remap (tools/green-map.mjs --emit) --- */'
  const END = '    /* --- END GENERATED: source colours --- */'
  const target = readFileSync(OUT === DEFAULT_OUT ? CLIENT : OUT, 'utf8')
  const from = target.indexOf(BEGIN)
  const to = target.indexOf(END)
  if (from < 0 || to < 0 || to < from) {
    console.error(`sentinels not found in ${OUT === DEFAULT_OUT ? CLIENT : OUT}`)
    process.exit(1)
  }
  const next = target.slice(0, from) + block + target.slice(to + END.length)
  writeFileSync(OUT === DEFAULT_OUT ? CLIENT : OUT, next, 'utf8')
  console.log(`wrote ${OUT === DEFAULT_OUT ? CLIENT : OUT}`)
  console.log(`${names.length} source tokens  (${block.length} bytes)`)

  // Golden fixture: what the remap must produce at the default hue.
  const golden = {
    note: 'GENERATED by tools/green-map.mjs --emit. The browser half must reproduce this byte-for-byte at GREEN_HUE_DEFAULT.',
    hue: TARGET_HUE,
    satBand: [SAT_MIN, SAT_MAX],
    accentSat: ACCENT_SAT,
    tokens: emitted
  }
  writeFileSync(GOLDEN, JSON.stringify(golden, null, 2) + '\n', 'utf8')
  console.log(`wrote ${GOLDEN}  (${Object.keys(emitted).length} tokens at hue ${TARGET_HUE})`)
  console.log(`kept out: neutrals (ink/background), success/warn/error, code-diff, file-diff, amber, red`)
}
