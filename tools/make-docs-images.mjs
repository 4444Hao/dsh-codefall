/**
 * Generate the images the README shows.
 *
 *   node tools/make-docs-images.mjs
 *
 * Everything here is produced by this repository's own renderer and by the same
 * remap the plugin uses at runtime — no app assets are involved, so the output is
 * ours to publish. The real-app screenshots are the maintainer's to add.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_HINT, loadCanvas, registerMonoFont } from './canvas-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT = resolve(REPO, 'docs/images')
mkdirSync(OUT, { recursive: true })

const canvasApi = loadCanvas()
if (canvasApi === null) {
  console.error('make-docs-images.mjs: no canvas backend.\n\n' + CANVAS_HINT)
  process.exit(1)
}
const { createCanvas, GlobalFonts } = canvasApi
const MONO = registerMonoFont(GlobalFonts) || 'monospace'

/* ---------------------------------------------------------------- *
 * 1. the boot animation's first frame (pure rain, dark)
 * ---------------------------------------------------------------- */
;(0, eval)(readFileSync(join(REPO, 'lib', 'renderer.js'), 'utf8'))
const R = globalThis.CodefallRenderer

const W = Number(process.env.DSH_CODEFALL_DOC_WIDTH || 1000)
const H = Math.round((W / 16) * 9)
const canvas = createCanvas(W, H)
const scene = R.create(canvas, { createCanvas, fontFamily: MONO, appearance: 'dark', seed: 20261008 })
scene.resize(W, H, 1)
scene.frameAt(0)
scene.frameAt(900)
writeFileSync(join(OUT, 'boot-dark.png'), canvas.toBuffer('image/png'))
console.log('boot-dark.png         pure rain, first frame, 1280x720')

const lightCanvas = createCanvas(W, H)
const lightScene = R.create(lightCanvas, { createCanvas, fontFamily: MONO, appearance: 'light', seed: 20261008 })
lightScene.resize(W, H, 1)
lightScene.frameAt(0)
lightScene.frameAt(900)
writeFileSync(join(OUT, 'boot-light.png'), lightCanvas.toBuffer('image/png'))
console.log('boot-light.png        the same scene in light mode')

/* ---------------------------------------------------------------- *
 * 2. the hue stops, computed with the plugin's own remap
 * ---------------------------------------------------------------- */
const HUE_PRESETS = [
  { hue: 120, label: 'classic 120' },
  { hue: 145, label: 'rain 145 (default)' },
  { hue: 165, label: 'teal 165' }
]
const SOURCE = ['#4176e6', '#7aaaff', '#3b82f6', '#2631481a']

/** The exact arithmetic the browser half runs (lib/client.js). */
function hexToRgb(value) {
  const v = String(value).trim().toLowerCase()
  const m = /^#([\da-f]{3,8})$/u.exec(v)
  if (!m) return null
  let h = m[1]
  if (h.length === 3 || h.length === 4) {
    h = h
      .split('')
      .map((c) => c + c)
      .join('')
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
  }
}
function rgbToHsl({ r, g, b }) {
  const R1 = r / 255
  const G1 = g / 255
  const B1 = b / 255
  const max = Math.max(R1, G1, B1)
  const min = Math.min(R1, G1, B1)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  let h = 0
  if (d !== 0) {
    if (max === R1) h = 60 * (((G1 - B1) / d) % 6)
    else if (max === G1) h = 60 * ((B1 - R1) / d + 2)
    else h = 60 * ((R1 - G1) / d + 4)
  }
  return { h: h < 0 ? h + 360 : h, s, l }
}
const byte2hex = (v) => {
  const n = Math.round(v * 255).toString(16)
  return n.length < 2 ? '0' + n : n
}
function hslToHex(h, s, l, a) {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = l - c / 2
  const seg = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor((((h % 360) + 360) % 360) / 60) % 6
  ]
  const hex = '#' + byte2hex(seg[0] + m) + byte2hex(seg[1] + m) + byte2hex(seg[2] + m)
  return a >= 1 ? hex : hex + byte2hex(a)
}
function remap(value, hue) {
  const rgb = hexToRgb(value)
  if (!rgb) return value
  const hsl = rgbToHsl(rgb)
  if (!(hsl.h >= 175 && hsl.h < 265) || hsl.s * 100 < 8) return value
  const s = hsl.s < 0.5 ? hsl.s : Math.min(0.8, Math.max(0.55, hsl.s))
  return hslToHex(hue, s, hsl.l, rgb.a)
}

// Deliberately ASCII-only labels: the registered monospace font has no CJK
// coverage, so Chinese labels render as tofu boxes. ASCII also makes the image
// byte-identical on every platform.
const COL = 660
const ROW = 74
const swatch = createCanvas(COL, ROW * (HUE_PRESETS.length + 1) + 52)
const g = swatch.getContext('2d')
g.fillStyle = '#151517'
g.fillRect(0, 0, swatch.width, swatch.height)
g.font = `600 16px ${MONO}`
g.fillStyle = '#9ca3af'
g.fillText('source blue', 16, 32)
g.fillText('remapped: same lightness and alpha, new hue', 190, 32)

const samples = [
  { label: 'source', hue: null },
  ...HUE_PRESETS.map((p) => ({ label: p.label, hue: p.hue }))
]
samples.forEach((sample, row) => {
  const y = 52 + row * ROW
  g.fillStyle = '#d1d5db'
  g.font = `500 14px ${MONO}`
  g.fillText(sample.label, 16, y + 20)
  SOURCE.forEach((src, i) => {
    const colour = sample.hue === null ? src : remap(src, sample.hue)
    g.fillStyle = colour
    g.fillRect(16 + i * 160, y + 30, 144, 26)
    g.fillStyle = '#6b7280'
    g.font = `12px ${MONO}`
    g.fillText(colour, 16 + i * 160, y + 70)
  })
})
writeFileSync(join(OUT, 'theme-hues.png'), swatch.toBuffer('image/png'))
console.log('theme-hues.png        the same source colours at each hue stop')
