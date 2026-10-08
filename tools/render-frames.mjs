/**
 * Offline frame renderer for dsh-codefall.
 *
 * Renders deterministic stills of the boot animation through @napi-rs/canvas,
 * so the visual can be reviewed (and regressions caught) without a browser and
 * without the harness.
 *
 *   node tools/render-frames.mjs
 *   node tools/render-frames.mjs --appearance light --quality high --w 1000 --h 640
 *   node tools/render-frames.mjs --at 0,150,320,700 --tag firstlook
 *
 * Output: tools/out/<tag>-<appearance>-<ms>ms.png plus a small index.txt.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_HINT, loadCanvas, registerMonoFont } from './canvas-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/* ------------------------------------------------------------------ *
 * arguments
 * ------------------------------------------------------------------ */
const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const WIDTH = Number(arg('w', 1280))
const HEIGHT = Number(arg('h', 800))
const QUALITY = arg('quality', 'standard')
const TAG = arg('tag', 'look')
const APPEARANCES = arg('appearance', 'dark,light').split(',')
const TIMES = arg('at', '0,140,320,620,1100,2200')
  .split(',')
  .map((s) => Number(s.trim()))
const TITLE = arg('title', 'HARNESS')
/* A fixed seed keeps every run byte-comparable. */
const SEED = Number(arg('seed', 20261008))

/* ------------------------------------------------------------------ *
 * canvas backend (optional dev dependency; see tools/canvas-env.mjs)
 * ------------------------------------------------------------------ */
const canvasApi = loadCanvas()
if (canvasApi === null) {
  console.error('render-frames.mjs: no canvas backend.\n\n' + CANVAS_HINT)
  process.exit(1)
}
const { createCanvas, GlobalFonts } = canvasApi
const MONO = registerMonoFont(GlobalFonts) || 'monospace'

/* ------------------------------------------------------------------ *
 * load the renderer exactly the way the host half will: as a classic script
 * ------------------------------------------------------------------ */
const rendererSrc = readFileSync(join(REPO, 'lib', 'renderer.js'), 'utf8')
;(0, eval)(rendererSrc)
const CodefallRenderer = globalThis.CodefallRenderer
if (!CodefallRenderer) throw new Error('lib/renderer.js did not register CodefallRenderer')

const OUT = join(HERE, 'out')
mkdirSync(OUT, { recursive: true })

const index = []
for (const appearance of APPEARANCES) {
  const canvas = createCanvas(WIDTH, HEIGHT)
  const r = CodefallRenderer.create(canvas, {
    createCanvas,
    // NOTE: @napi-rs/canvas does not parse a CSS font fallback list, so the
    // headless runs must name a single, present family or they silently fall
    // back to the default sans font (which is proportional and misaligns the grid).
    fontFamily: MONO,
    appearance,
    quality: QUALITY,
    seed: SEED,
    titleText: TITLE,
    statusText: appearance === 'dark' ? '正在加载插件…' : 'loading plugins…'
  })

  r.resize(WIDTH, HEIGHT, 1)
  let prev = 0
  for (const t of TIMES) {
    r.frameAt(t)
    prev = t
    const file = join(OUT, `${TAG}-${appearance}-${String(t).padStart(5, '0')}ms.png`)
    writeFileSync(file, canvas.toBuffer('image/png'))
    const s = r.state()
    index.push(
      `${file}  ${s.width}x${s.height} dpr=${s.dpr} cols=${s.cols} rows=${s.rows} ` +
        `levels=${s.levels} cell=${s.cellW}x${s.cellH} draws=${s.drawCalls}`
    )
  }
  // final state after ready() + drain: the last trail should have left the screen
  r.beginDrain()
  r.frameAt(prev + 3000)
  writeFileSync(join(OUT, `${TAG}-${appearance}-drained.png`), canvas.toBuffer('image/png'))
  index.push(`${join(OUT, `${TAG}-${appearance}-drained.png`)}  drained=${r.isDrained()} draws=${r.state().drawCalls}`)
  r.destroy()
}

writeFileSync(join(OUT, `${TAG}-index.txt`), index.join('\n') + '\n')
console.log(index.join('\n'))
