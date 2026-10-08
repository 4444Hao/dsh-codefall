/**
 * Smoke test for the dsh-codefall renderer.
 *
 *   node tools/smoke.mjs
 *
 * These are the claims the boot animation makes that can be checked without a
 * browser: the first frame is already raining, a window resize does not restart
 * the scene, ready() actually hands off inside the documented budget, and
 * teardown is safe to call twice.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CANVAS_HINT, loadCanvas, registerMonoFont } from './canvas-env.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

// Canvas is an optional dev dependency: the plugin's runtime has none, and the
// host/client suites run on plain Node. Only the pixel checks here need it.
const canvasApi = loadCanvas()
if (canvasApi === null) {
  console.error('smoke.mjs: no canvas backend.\n\n' + CANVAS_HINT)
  if (process.env.DSH_CODEFALL_SKIP_CANVAS === '1') {
    console.error('\nDSH_CODEFALL_SKIP_CANVAS=1 is set, so this suite is skipped.')
    process.exit(0)
  }
  process.exit(1)
}
const { createCanvas, GlobalFonts } = canvasApi
// A family that actually exists on this platform, rather than a Windows path.
const MONO = registerMonoFont(GlobalFonts) || 'monospace'

;(0, eval)(readFileSync(join(REPO, 'lib', 'renderer.js'), 'utf8'))
const R = globalThis.CodefallRenderer

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`)
}

const W = 1280
const H = 800
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
const r = R.create(canvas, {
  createCanvas,
  fontFamily: MONO,
  appearance: 'dark',
  seed: 424242,
  // The shipped default is pure rain (empty title), so the converging-title
  // behaviour has to be requested explicitly here to be tested.
  titleText: 'HARNESS'
})
r.resize(W, H, 1)

/* --- 1. the very first frame is already a rain scene ------------------- */
r.frameAt(0)
let s = r.state()
const bg = [21, 21, 23] // #151517
function coverage(y0, y1) {
  const d = ctx.getImageData(0, y0, W, y1 - y0).data
  let lit = 0
  const total = d.length / 4
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - bg[0]) > 6 || Math.abs(d[i + 1] - bg[1]) > 6 || Math.abs(d[i + 2] - bg[2]) > 6) lit++
  }
  return lit / total
}
const topCoverage = coverage(0, Math.floor(H * 0.3))
check('first frame paints rain (draw calls > 100)', s.drawCalls > 100, `draws=${s.drawCalls}`)
check(
  'first frame is raining in the TOP third (pre-seeded, not falling in from zero)',
  topCoverage > 0.01,
  `coverage=${(topCoverage * 100).toFixed(2)}%`
)
check('grid is in the expected range (60-120 columns)', s.cols >= 60 && s.cols <= 120, `cols=${s.cols}`)
check(
  'title convergence lands between 400ms and 1200ms',
  s.titleCompleteAt >= 400 && s.titleCompleteAt <= 1200,
  `completeAt=${Math.round(s.titleCompleteAt)}ms`
)

/* --- 2. a resize keeps the scene running ------------------------------- */
const before = { cols: s.cols, draws: s.drawCalls }
r.resize(1000, 620, 1)
r.frameAt(400)
s = r.state()
check('resize does not throw and re-renders', s.drawCalls > 100, `draws=${s.drawCalls} cols=${s.cols}`)
check('resize changed the column count', s.cols !== before.cols, `${before.cols} -> ${s.cols}`)
check('resize kept the rain lit', coverage(0, Math.floor(620 * 0.3)) > 0.01)

/* --- 3. drain hands off on a timer, not on a lucky column -------------- */
r.frameAt(600)
r.beginDrain(180)
r.frameAt(700) // the drain clock starts on the first frame after beginDrain()
check('drain starts at full brightness', r.state().drainFactor === 1, `factor=${r.state().drainFactor}`)
r.frameAt(790)
const mid = r.state().drainFactor
check('about half faded 90ms into a 180ms drain', mid > 0.3 && mid < 0.7, `factor=${mid.toFixed(2)}`)
check('still not drained mid-fade', r.isDrained() === false)
r.frameAt(900)
check('drained after the drain window', r.isDrained() === true, `factor=${r.state().drainFactor}`)
r.frameAt(1600)
s = r.state()
check('after drain nothing is drawn', s.drawCalls === 0, `draws=${s.drawCalls}`)

/* --- 4. replay, then appearance / quality switches --------------------- */
r.reset()
r.frameAt(1000)
check('reset() revives a finished boot', r.state().drawCalls > 50, `draws=${r.state().drawCalls}`)
r.setOptions({ appearance: 'light' })
check('appearance switch applies', r.state().appearance === 'light')
r.frameAt(1100)
check('light mode paints', r.state().drawCalls > 50, `draws=${r.state().drawCalls}`)
r.setOptions({ quality: 'economy' })
r.frameAt(1200)
check('quality switch applies', r.state().quality === 'economy')
check('economy still paints after a rebuild', r.state().drawCalls > 20, `draws=${r.state().drawCalls}`)

/* --- 5. teardown is safe twice ---------------------------------------- */
r.destroy()
let threw = false
try {
  r.destroy()
  r.frameAt(2000)
} catch (e) {
  threw = true
}
check('destroy() is idempotent and frameAt() after it is a no-op', !threw)

/* --- 6. pure rain: an empty title draws no title -------------=========== */
{
  const c2 = createCanvas(W, H)
  const plain = R.create(c2, { createCanvas, fontFamily: MONO, appearance: 'dark', seed: 7 })
  plain.resize(W, H, 1)
  plain.frameAt(0)
  plain.frameAt(1200)
  const st = plain.state()
  check('an empty title requests no convergence time', st.titleCompleteAt === 0, `completeAt=${st.titleCompleteAt}`)
  check('pure rain still draws frames', st.drawCalls > 100, `draws=${st.drawCalls}`)
  // With no title band, the vertical middle must be as busy as the top.
  const mid = (() => {
    const d = c2.getContext('2d').getImageData(0, Math.floor(H * 0.4), W, Math.floor(H * 0.2)).data
    let lit = 0
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) > 6 || Math.abs(d[i + 1] - bg[1]) > 6 || Math.abs(d[i + 2] - bg[2]) > 6) lit++
    }
    return lit / (d.length / 4)
  })()
  check('no dimmed title band is cut into the rain', mid > 0.01, `mid coverage=${(mid * 100).toFixed(2)}%`)
  plain.destroy()
}

/* --- 7. live re-tuning must not restart the rain ----------------------- */
{
  const c3 = createCanvas(W, H)
  const live = R.create(c3, { createCanvas, fontFamily: MONO, appearance: 'dark', seed: 11 })
  live.resize(W, H, 1)
  live.frameAt(0)
  live.frameAt(400)
  const rev = live.state().sceneRevision
  const before = live.state().activeColumns

  live.setOptions({ quality: 'economy' })
  check('a quality change rebuilds the atlas only', live.state().sceneRevision === rev, `rev ${rev} -> ${live.state().sceneRevision}`)
  live.setOptions({ appearance: 'light' })
  check('an appearance change rebuilds the atlas only', live.state().sceneRevision === rev, `rev=${live.state().sceneRevision}`)
  live.setOptions({ glyphs: 'katakana' })
  check('a glyph-set change rebuilds the atlas only', live.state().sceneRevision === rev, `rev=${live.state().sceneRevision}`)
  live.setOptions({ speed: 2 })
  check('a speed change is instant', live.state().sceneRevision === rev && live.state().speed === 2, `speed=${live.state().speed}`)

  live.setOptions({ density: 0.2 })
  check('a density change retunes without re-seeding', live.state().sceneRevision === rev, `rev=${live.state().sceneRevision}`)
  live.frameAt(1200)
  const after = live.state().activeColumns
  check('a lower density actually thins the field', after < before, `active ${before} -> ${after}`)
  check('the re-tuned scene still draws', live.state().drawCalls > 0, `draws=${live.state().drawCalls}`)

  live.setOptions({ fontSize: 24 })
  check('only a grid change re-seeds the scene', live.state().sceneRevision > rev, `rev=${live.state().sceneRevision}`)
  live.destroy()
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
