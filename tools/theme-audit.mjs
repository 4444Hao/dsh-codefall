/**
 * Theme token audit.
 *
 *   node tools/theme-audit.mjs                 # classify every --dsw-* token
 *   node tools/theme-audit.mjs --family blue   # only the blue ones
 *   node tools/theme-audit.mjs --json          # machine-readable
 *
 * Why this exists: "change the blue colors to green" is only actionable once we
 * know WHICH tokens are blue in the shipped stylesheet, and which are the white
 * text / black background that must not move. Guessing that from token names is
 * how a theme ends up looking wrong in places nobody checked.
 *
 * It also runs as a check later: after the green override is applied, the blue
 * family should be empty.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const DEFAULT_CSS = resolve(REPO, 'tools/out/app-index.css')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes('--' + name)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const CSS = resolve(REPO, opt('css', DEFAULT_CSS))
const css = readFileSync(CSS, 'utf8')

/* ---------------------------------------------------------------- *
 * parse `--dsw-name: value` with its enclosing block as context
 * ---------------------------------------------------------------- */
const decls = []
const re = /(--[\w-]+)\s*:\s*([^;}]+)[;}]/g
let m
while ((m = re.exec(css)) !== null) {
  if (!m[1].startsWith('--dsw-')) continue
  const brace = css.lastIndexOf('{', m.index)
  const selector = brace > 0 ? css.slice(brace + 1, m.index).trim() : ''
  const context = css
    .slice(Math.max(0, brace - 160), brace)
    .replace(/\s+/g, ' ')
    .trim()
  decls.push({ name: m[1], value: m[2].trim(), selector, context, at: m.index })
}

/* ---------------------------------------------------------------- *
 * color classification
 * ---------------------------------------------------------------- */
function toRgb(value) {
  const v = value.trim().toLowerCase()
  let r
  let g
  let b
  let a = 1
  let mm = /^#([\da-f]{3,8})$/u.exec(v)
  if (mm) {
    let h = mm[1]
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('')
    r = parseInt(h.slice(0, 2), 16)
    g = parseInt(h.slice(2, 4), 16)
    b = parseInt(h.slice(4, 6), 16)
    if (h.length === 8) a = parseInt(h.slice(6, 8), 16) / 255
    return { r, g, b, a }
  }
  mm = /^rgba?\(([^)]+)\)$/u.exec(v)
  if (mm) {
    const parts = mm[1].split(/[,\s/]+/u).filter(Boolean).map(Number)
    r = parts[0]
    g = parts[1]
    b = parts[2]
    if (parts.length > 3) a = parts[3]
    return { r, g, b, a }
  }
  return null
}

function classify(value) {
  if (/^var\(/u.test(value)) return { family: 'alias', hue: null, sat: null, note: 'var() reference' }
  const rgb = toRgb(value)
  if (!rgb) return { family: 'other', hue: null, sat: null, note: value.slice(0, 24) }
  if (rgb.a === 0) return { family: 'transparent', hue: null, sat: 0, note: '' }
  const r = rgb.r / 255
  const g = rgb.g / 255
  const b = rgb.b / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === r) h = 60 * (((g - b) / d) % 6)
    else if (max === g) h = 60 * ((b - r) / d + 2)
    else h = 60 * ((r - g) / d + 4)
  }
  if (h < 0) h += 360
  const sat = Math.round(s * 100)
  const light = Math.round(l * 100)
  let family
  if (sat < 12) family = l > 0.9 ? 'white' : l < 0.12 ? 'black' : 'neutral'
  else if (h >= 175 && h < 265) family = 'blue'
  else if (h >= 265 && h < 330) family = 'purple'
  else if (h >= 90 && h < 175) family = 'green'
  else if (h >= 30 && h < 90) family = 'amber'
  else family = 'red'
  return { family, hue: Math.round(h), sat, light, note: `hsl(${Math.round(h)} ${sat}% ${light}%)` }
}

const tokens = new Map()
for (const d of decls) {
  if (!tokens.has(d.name)) tokens.set(d.name, [])
  tokens.get(d.name).push({ ...d, ...classify(d.value) })
}

const isDark = (t) => /dark/u.test(t.context + ' ' + t.selector)
const isLight = (t) => /light/u.test(t.context + ' ' + t.selector)

/** The value that applies in dark mode, falling back to the last declaration. */
function darkValue(list) {
  const d = list.filter(isDark)
  if (d.length) return d[d.length - 1]
  const l = list.filter((x) => !isLight(x))
  return (l.length ? l[l.length - 1] : list[list.length - 1])
}

const rows = [...tokens.entries()].map(([name, list]) => {
  const dark = darkValue(list)
  const light = list.filter(isLight).slice(-1)[0] || dark
  return { name, dark: dark.value, light: light.value, ...dark, variants: list.length }
})

const family = opt('family', null)
const shown = family ? rows.filter((r) => r.family === family) : rows

if (flag('json')) {
  console.log(JSON.stringify({ css: CSS, total: rows.length, tokens: shown }, null, 2))
} else {
  const counts = {}
  for (const r of rows) counts[r.family] = (counts[r.family] || 0) + 1
  console.log(`stylesheet: ${CSS}`)
  console.log(`tokens: ${rows.length}`)
  console.log(
    'families: ' +
      Object.entries(counts)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join('  ')
  )
  console.log('')
  const pad = Math.max(...shown.map((r) => r.name.length), 8)
  for (const r of shown.sort((a, b) => a.family.localeCompare(b.family) || a.name.localeCompare(b.name))) {
    console.log(
      `${r.family.padEnd(11)} ${r.name.padEnd(pad)}  ${String(r.dark || '').padEnd(24)} ${
        r.hue === null ? '' : `h=${String(r.hue).padStart(3)} s=${String(r.sat).padStart(3)}`
      }`
    )
  }
}
