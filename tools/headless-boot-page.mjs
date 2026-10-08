/**
 * Build a standalone page that carries the exact first-frame script the host
 * injects, so the boot overlay can be exercised in a real browser (headless Edge
 * or just by opening the file) with no harness and no profile involved.
 *
 *   node tools/headless-boot-page.mjs --out tools/out/boot-test.html \
 *        --dismiss interaction --timeout 15000 --interact-at 1500 --ready-at 700
 *
 * `--ready-at <ms>` fakes the host's readiness signal by filling #root past the
 * DOM-growth heuristic threshold; `--interact-at <ms>` dispatches a keydown.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const OUT = resolve(REPO, arg('out', 'tools/out/boot-test.html'))
const DIST_INDEX = resolve(REPO, arg('dist', 'tools/out/dist-index.html'))
const overrides = {}
if (arg('dismiss')) overrides.dismiss = arg('dismiss')
if (arg('timeout')) overrides.timeoutMs = Number(arg('timeout'))
if (arg('min-display')) overrides.minDisplayMs = Number(arg('min-display'))
if (arg('idle-static')) overrides.idleStaticMs = Number(arg('idle-static'))
if (arg('idle-slow')) overrides.idleSlowMs = Number(arg('idle-slow'))
if (arg('hint')) overrides.hintReady = arg('hint')

const host = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href)
const cache = host.internals.createCache()
const options = host.internals.normalize({ ...host.internals.DEFAULTS, ...overrides })
const script = host.buildScript(options, cache)
if (!script) throw new Error('buildScript produced nothing')

const dist = readFileSync(DIST_INDEX, 'utf8')
// Drop the SPA entry: this page exists only to exercise the overlay, and the
// real bundle would hold a WebSocket open (which also freezes Chromium's
// virtual clock, making headless runs hang).
const stripped = dist
  .replace(/<script type="module"[^>]*><\/script>/i, '')
  .replace(/<link rel="modulepreload"[^>]*>/i, '')

const assist = []
const readyAt = Number(arg('ready-at', 0))
if (readyAt > 0) {
  assist.push(
    `setTimeout(function(){var r=document.getElementById('root');if(!r)return;` +
      `for(var i=0;i<120;i++){var d=document.createElement('div');d.textContent='x';r.appendChild(d)}},${readyAt});`
  )
}
const interactAt = Number(arg('interact-at', 0))
if (interactAt > 0) {
  assist.push(`setTimeout(function(){window.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}))},${interactAt});`)
}
if (arg('interact-kind') === 'move') {
  assist.push(
    `setTimeout(function(){for(var i=0;i<8;i++){window.dispatchEvent(new MouseEvent('mousemove',{clientX:i*6,clientY:i*6}))}},${interactAt || 1000});`
  )
}
// Headless can only be observed through the DOM: keep a live dump of the
// controller state so a --dump-dom run shows exactly why the overlay is or is
// not still there.
assist.push(
  `setInterval(function(){var c=window.__codefallController;var p=document.getElementById('cf-probe');` +
    `if(!p){p=document.createElement('pre');p.id='cf-probe';document.body.appendChild(p)}` +
    `p.textContent=c?JSON.stringify(c.state()):'no-controller'},200);`
)

const html = host.injectIntoHtml(stripped, script).replace(
  '</body>',
  '<script>' + assist.join('') + '</script></body>'
)

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, html, 'utf8')
console.log(`${OUT}  (${Buffer.byteLength(html)} bytes)  dismiss=${options.dismiss}`)
