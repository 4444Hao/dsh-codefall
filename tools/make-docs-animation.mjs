/**
 * Render the README's animated hero as a GIF.
 *
 *   node tools/make-docs-animation.mjs [--width 800] [--frames 32] [--fps 12] [--colors 48]
 *
 * GitHub renders animated GIFs inline and nothing else reliably: `<video>` is
 * stripped from READMEs, and while @napi-rs/canvas writes PNG/JPEG/WebP/AVIF it
 * has no GIF or multi-frame encoder at all. So frames come from the same
 * renderer the plugin ships, and `gifenc` packs them.
 *
 * Two things keep the file small, and both matter because this asset lives in
 * git forever and every reader downloads it:
 *
 *   - a GLOBAL palette (the rain only ever uses a dark background plus one green
 *     ramp) instead of a per-frame palette;
 *   - transparency for unchanged pixels with disposal "do not dispose", so each
 *     frame only has to encode what actually moved.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_HINT, loadCanvas, registerMonoFont } from './canvas-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT = resolve(REPO, 'docs/images')

const argv = process.argv.slice(2)
const num = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : fallback
}

const WIDTH = num('width', 800)
const HEIGHT = Math.round((WIDTH / 16) * 9)
const FRAMES = num('frames', 32)
const FPS = num('fps', 12)
const COLORS = num('colors', 48)

const canvasApi = loadCanvas()
if (canvasApi === null) {
  console.error('make-docs-animation.mjs: no canvas backend.\n\n' + CANVAS_HINT)
  process.exit(1)
}
const { createCanvas, GlobalFonts } = canvasApi
const MONO = registerMonoFont(GlobalFonts) || 'monospace'

let gifenc
try {
  gifenc = createRequire(import.meta.url)('gifenc')
} catch {
  console.error('make-docs-animation.mjs needs the optional dev dependency gifenc:')
  console.error('    npm i -D gifenc')
  process.exit(1)
}
const { GIFEncoder, quantize, applyPalette } = gifenc

;(0, eval)(readFileSync(join(REPO, 'lib', 'renderer.js'), 'utf8'))
const R = globalThis.CodefallRenderer

/* ---------------------------------------------------------------- *
 * frames
 * ---------------------------------------------------------------- */
const canvas = createCanvas(WIDTH, HEIGHT)
const ctx = canvas.getContext('2d')
const scene = R.create(canvas, { createCanvas, fontFamily: MONO, appearance: 'dark', seed: 20261008 })
scene.resize(WIDTH, HEIGHT, 1)

const step = 1000 / FPS
const frames = []
for (let i = 0; i < FRAMES; i++) {
  scene.frameAt(i * step)
  // Copy out: the canvas is reused for the next frame.
  frames.push(ctx.getImageData(0, 0, WIDTH, HEIGHT).data.slice())
}

/* ---------------------------------------------------------------- *
 * one palette for the whole animation, built from a few sampled frames
 *
 * Sampled sparsely on purpose: 800x450x4 is 1.4M values per frame, and spreading
 * that into an array overflows the call stack. Every 7th pixel is far more than
 * enough to characterise a palette that only has to cover one green ramp.
 * ---------------------------------------------------------------- */
const sampleStride = Math.max(1, Math.floor(FRAMES / 4))
const sampled = []
for (let i = 0; i < FRAMES; i += sampleStride) {
  const f = frames[i]
  for (let q = 0; q < f.length; q += 4 * 7) sampled.push(f[q], f[q + 1], f[q + 2], 255)
}
const palette = quantize(Uint8ClampedArray.from(sampled), COLORS, { format: 'rgb565' })

/* ---------------------------------------------------------------- *
 * encode, with unchanged pixels transparent and no disposal between frames
 * ---------------------------------------------------------------- */
const encoder = GIFEncoder()
const TRANSPARENT = 0 // gifenc reserves index 0 when `transparent` is set
let previous = null
for (let i = 0; i < frames.length; i++) {
  const rgba = frames[i]
  const indexed = applyPalette(rgba, palette, 'rgb565')
  if (previous !== null) {
    // Anything identical to the previous frame becomes transparent, so the
    // encoder emits long runs instead of those pixels again.
    for (let p = 0, q = 0; p < indexed.length; p++, q += 4) {
      if (
        previous[q] === rgba[q] &&
        previous[q + 1] === rgba[q + 1] &&
        previous[q + 2] === rgba[q + 2]
      ) {
        indexed[p] = TRANSPARENT
      }
    }
  }
  encoder.writeFrame(indexed, WIDTH, HEIGHT, {
    palette: i === 0 ? palette : undefined,
    delay: Math.round(1000 / FPS),
    transparent: true,
    transparentIndex: TRANSPARENT,
    dispose: 1,
    first: i === 0,
    repeat: 0
  })
  previous = rgba
}
encoder.finish()

mkdirSync(OUT, { recursive: true })
const bytes = encoder.bytes()
const file = join(OUT, 'boot-dark.gif')
writeFileSync(file, bytes)

const kb = (bytes.length / 1024).toFixed(0)
console.log(`boot-dark.gif   ${WIDTH}x${HEIGHT}  ${FRAMES} frames @ ${FPS}fps  ${COLORS} colours`)
console.log(`  ${bytes.length} bytes (${kb} KB)`)
console.log(`  budget check: ${bytes.length < 1_500_000 ? 'under 1.5 MB' : 'OVER 1.5 MB — lower --frames/--width/--colors'}`)
