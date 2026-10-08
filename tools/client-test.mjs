/**
 * Test for the dsh-codefall browser half.
 *
 *   node tools/client-test.mjs
 *
 * The bundle is loaded exactly the way the host serves it — through a
 * `window.__ModuleLoader__.load({id, factory})` capture — then the factory is
 * run with a minimal React stub so the settings row can actually be rendered and
 * driven, and `apply()` is exercised against fake slot registries.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`)
}
const flush = () => new Promise((r) => setImmediate(r))
async function settle() {
  for (let i = 0; i < 6; i++) await flush()
}

/* ------------------------------------------------------------------ *
 * a very small React stub: enough for hook order, state and effects
 * ------------------------------------------------------------------ */
function makeReact() {
  let states = []
  let effects = []
  let cursor = 0
  return {
    createElement(type, props) {
      return { type, props: props || {}, children: Array.prototype.slice.call(arguments, 2) }
    },
    useState(init) {
      const i = cursor++
      if (!(i in states)) states[i] = typeof init === 'function' ? init() : init
      return [
        states[i],
        (next) => {
          states[i] = typeof next === 'function' ? next(states[i]) : next
        }
      ]
    },
    useEffect(fn) {
      // Hooks are called in order: two useState calls precede this one, so the
      // effect list must be independent of the state cursor.
      effects.push(fn)
      cursor++
    },
    begin() {
      cursor = 0
      effects = []
    },
    /** The first mount effect of the last render. */
    mountEffect: () => effects[0],
    effectCount: () => effects.length,
    stateAt: (i) => states[i]
  }
}

/** All text under a rendered tree. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) return node.map(textOf).join(' ')
  return node.children ? node.children.map(textOf).join(' ') : ''
}
/** Every button prop bag in a rendered tree (children included, as React would). */
function buttonsOf(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => buttonsOf(n, out))
    return out
  }
  if (node.type === 'button') out.push(Object.assign({}, node.props, { children: node.children || [] }))
  if (node.children) node.children.forEach((n) => buttonsOf(n, out))
  return out
}
/** Every <input type="range"> prop bag in a rendered tree. */
function rangesOf(node, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    node.forEach((n) => rangesOf(n, out))
    return out
  }
  if (node.type === 'input' && node.props && node.props.type === 'range') out.push(node.props)
  if (node.children) node.children.forEach((n) => rangesOf(n, out))
  return out
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ------------------------------------------------------------------ *
 * load the bundle the way the host does
 * ------------------------------------------------------------------ */
const calls = []
/** Server-side settings the fake route answers with, and lets a test mutate. */
const server = {
  dismiss: 'ready',
  minDisplayMs: 3000,
  density: 0.6,
  speed: 1.25,
  quality: 'high',
  appearance: 'dark',
  theme: true
}
const sandbox = {
  console: { log() {}, warn() {}, debug() {}, error() {} },
  fetch(url, init) {
    calls.push({ url, init })
    const method = (init && init.method) || 'GET'
    if (method === 'POST') {
      const body = JSON.parse(init.body)
      if (body.patch) Object.assign(server, body.patch)
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: Object.assign({}, server) }) })
    }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: Object.assign({}, server) }) })
  }
}
sandbox.window = sandbox

let captured = null
sandbox.__ModuleLoader__ = {
  load(spec) {
    captured = spec
  }
}

const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
new Function('window', source)(sandbox)

check('bundle registers itself with __ModuleLoader__', !!captured, captured ? captured.id : 'nothing captured')
check('bundle id is the package name', captured.id === 'dsh-codefall', captured.id)

const React = makeReact()
const exports_ = captured.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})
check('factory exports apply/inject', typeof exports_.apply === 'function' && Array.isArray(exports_.inject), JSON.stringify(exports_.inject))
check('factory exposes the client handle', !!sandbox.__codefallClient)

/* ------------------------------------------------------------------ *
 * a client context that behaves like DSH's
 *
 * `declared` is taken FROM THE PLUGIN (`exports.inject`), so the invariant the
 * framework enforces — everything you read must be declared — is enforced here
 * by construction. Reading an undeclared service throws, because that is what
 * the real guard does —
 *
 *   service "theme" is not injected. Declare it: inject: ['theme', …]
 *
 * — and that rejection is fatal to plugin activation. An earlier version of the
 * theme code read `ctx.theme` while declaring only `slots`, and took the whole
 * app's web boot down. A fake that let that pass would hide exactly the failure
 * this file exists to catch.
 * ------------------------------------------------------------------ */
function makeClientCtx(options = {}) {
  const declared = options.declareOverride || exports_.inject.slice()
  const registrations = options.registrations || []
  const disposers = options.disposers || []
  const parked = options.parked || []
  const services = {
    slots: {
      inject(name, cb) {
        cb()
      },
      register(entry, component) {
        if (options.refuseSections && entry.name === 'settings.section') throw new Error('section slot refused')
        registrations.push({ entry, component })
        return () => {}
      }
    },
    theme: 'theme' in options ? options.theme : { overrideTokens: () => () => {} }
  }

  const missing = declared.filter((name) => services[name] === undefined)
  if (missing.length > 0) parked.push(missing.join(','))

  const api = {
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push({ label, d: dispose })
      return () => {}
    }
  }
  return new Proxy(api, {
    get(target, prop) {
      if (typeof prop !== 'string') return target[prop]
      if (prop in target) return target[prop]
      if (services[prop] !== undefined || declared.indexOf(prop) >= 0) {
        if (declared.indexOf(prop) < 0) {
          throw new Error(`service "${prop}" is not injected. Declare it: inject: ['${prop}', …] on your plugin`)
        }
        return services[prop]
      }
      return undefined
    }
  })
}

{
  // The guard itself: a service that EXISTS but is not declared must throw.
  const bare = makeClientCtx({ declareOverride: ['slots'] })
  let threw = false
  try {
    void bare.theme
  } catch (e) {
    threw = /is not injected/u.test(e.message)
  }
  check('the fake context reproduces the framework service guard', threw)
  check(
    'the plugin declares every service it reads',
    exports_.inject.indexOf('slots') >= 0 && exports_.inject.indexOf('theme') >= 0,
    JSON.stringify(exports_.inject)
  )
}

/* ------------------------------------------------------------------ *
 * apply(): placement is section-first, with a working fallback
 * ------------------------------------------------------------------ */
{
  const registrations = []
  const ctx = makeClientCtx({ registrations })
  exports_.apply(ctx)
  check('the hand-off probe goes into shell.overlay', registrations[0].entry.name === 'shell.overlay', registrations[0].entry.name)
  check(
    'a dedicated settings section is the preferred placement',
    registrations.length === 2 && registrations[1].entry.name === 'settings.section',
    registrations.map((r) => r.entry.name).join(', ')
  )
  check(
    'the section is named by our own label',
    registrations[1].entry.label === exports_.SECTION_LABEL,
    String(registrations[1].entry.label)
  )
  check(
    'the label names both the function and the plugin',
    /开机动画/.test(exports_.SECTION_LABEL) && /codefall/.test(exports_.SECTION_LABEL),
    exports_.SECTION_LABEL
  )
  check('the section carries our id and an order', registrations[1].entry.id === 'dsh-codefall' && registrations[1].entry.order === 40)
}
{
  // The section slot rejects our entry -> fall back to the official General row.
  const registrations = []
  const ctx = makeClientCtx({ registrations, refuseSections: true })
  let threw = false
  try {
    exports_.apply(ctx)
  } catch (e) {
    threw = true
  }
  check('a refused section registration does not break apply()', !threw)
  check('the hand-off probe survives it', registrations.some((r) => r.entry.name === 'shell.overlay'))
  check(
    'it falls back to the 通用设置 row',
    registrations.some((r) => r.entry.name === 'settings.general.item'),
    registrations.map((r) => r.entry.name).join(', ')
  )
}
{
  // The section slot is not offered at all -> same fallback.
  const registered = []
  const ctx = {
    slots: {
      inject(name, cb) {
        if (name === 'settings.section') throw new Error('slot missing')
        cb()
      },
      register(entry) {
        registered.push(entry)
        return () => {}
      }
    }
  }
  let threw = false
  try {
    exports_.apply(ctx)
  } catch (e) {
    threw = true
  }
  check('a missing section slot does not break apply()', !threw)
  check(
    'a missing section slot also falls back to the row',
    registered.some((r) => r.name === 'settings.general.item'),
    registered.map((r) => r.name).join(', ')
  )
}

/* ------------------------------------------------------------------ *
 * the settings surface renders and saves
 * ------------------------------------------------------------------ */
{
  const Section = exports_.makeSettings('section')
  const Row = exports_.makeSettings('row')

  calls.length = 0
  // (a) loading state: the fallback row names itself, the section must not.
  React.begin()
  check('the fallback row renders its own label immediately', textOf(Row()).includes('开机动画'))
  React.begin()
  const sectionLoading = Section()
  check('the section variant does not repeat the nav label', !textOf(sectionLoading).includes('开机动画'), textOf(sectionLoading).trim())

  // (b) mount: the effect issues the GET.
  React.begin()
  Section()
  check('the settings component declares exactly one mount effect', React.effectCount() === 1, `effects=${React.effectCount()}`)
  React.mountEffect()()
  await settle()
  check('it loads the stored value', React.stateAt(0) && React.stateAt(0).dismiss === 'ready', JSON.stringify(React.stateAt(0)))
  check('the GET went to the plugin route', calls[0].url === '/codefall/api' && calls[0].init.method === 'GET', calls[0].url)

  // (c) loaded state.
  React.begin()
  const loaded = Section()
  const text = textOf(loaded)
  check('the section variant states what it configures', text.includes('无标题、无文字'), text.trim())
  check(
    'the dismissal, quality and appearance choices are all rendered',
    text.includes('交互后结束') &&
      text.includes('3 秒后自动继续') &&
      text.includes('高') &&
      text.includes('省电') &&
      text.includes('跟随') &&
      text.includes('浅色'),
    text.trim()
  )
  check(
    'the animation parameters are labelled',
    text.includes('雨密度') && text.includes('雨速') && text.includes('绿色主题') && text.includes('绿色色调'),
    text.trim()
  )
  const buttons = buttonsOf(loaded)
  check('four segmented groups plus the hue stops (13 buttons)', buttons.length === 13, `buttons=${buttons.length}`)
  const active = buttons.filter((b) => b['aria-pressed'] === true).map((b) => b.children.join(''))
  check('exactly one option is active per group', active.length === 5, active.join(' | '))
  check(
    'the stored values are the active ones',
    active.includes('3 秒后自动继续') &&
      active.includes('高') &&
      active.includes('深色') &&
      active.includes('开') &&
      active.includes('雨绿'),
    active.join(' | ')
  )

  const ranges = rangesOf(loaded)
  check('three sliders are offered', ranges.length === 3, `ranges=${ranges.length}`)
  check('the density slider reflects the stored value', ranges[0].value === 0.6, `value=${ranges[0].value}`)
  check('the speed slider reflects the stored value', ranges[1].value === 1.25, `value=${ranges[1].value}`)
  check('the sliders carry their bounds', ranges[0].min === 0.3 && ranges[0].max === 1 && ranges[1].max === 2.5)
  check(
    'the hue slider covers exactly the allowed range',
    ranges[2].min === exports_.HUE_MIN && ranges[2].max === exports_.HUE_MAX && ranges[2].value === exports_.HUE_DEFAULT,
    `${ranges[2].min}-${ranges[2].max} @ ${ranges[2].value}`
  )

  // Clicking a dismissal choice writes both underlying keys, immediately.
  calls.length = 0
  buttons[0].onClick()
  await settle()
  const post = calls.find((c) => c.init.method === 'POST')
  check('choosing posts to the plugin route', !!post && post.url === '/codefall/api', post ? post.url : 'no POST')
  const body = post ? JSON.parse(post.init.body) : {}
  check(
    'the choice writes dismiss + minDisplayMs together',
    body.patch && body.patch.dismiss === 'interaction' && body.patch.minDisplayMs === 900,
    JSON.stringify(body)
  )
  check('the value is refreshed from the response', React.stateAt(0).dismiss === 'interaction', JSON.stringify(React.stateAt(0)))

  // A quality choice writes exactly one key.
  calls.length = 0
  buttons.find((b) => b.children.join('') === '省电').onClick()
  await settle()
  const qPost = calls.find((c) => c.init.method === 'POST')
  check(
    'a quality choice writes just that key',
    !!qPost && JSON.parse(qPost.init.body).patch.quality === 'economy',
    qPost ? qPost.init.body : 'no POST'
  )

  // A slider drag is debounced into one write, not one per pixel.
  calls.length = 0
  ranges[0].onChange({ target: { value: '0.4' } })
  ranges[0].onChange({ target: { value: '0.35' } })
  ranges[0].onChange({ target: { value: '0.3' } })
  check('a slider drag does not post on every step', calls.filter((c) => c.init.method === 'POST').length === 0, `posts=${calls.length}`)
  await sleep(320)
  const dragPosts = calls.filter((c) => c.init.method === 'POST')
  check('the drag is collapsed into a single write', dragPosts.length === 1, `posts=${dragPosts.length}`)
  check(
    'the write carries the final slider value',
    dragPosts.length === 1 && JSON.parse(dragPosts[0].init.body).patch.density === 0.3,
    dragPosts.length ? dragPosts[0].init.body : 'none'
  )
}

/* ------------------------------------------------------------------ *
 * the green theme — mechanism A
 *
 * The hue is a live setting: the browser half remaps the shipped source colours
 * and re-registers the override layer, so nothing here needs a rebuild. The
 * arithmetic is pinned to the generator by tools/fixtures/green-145.json.
 * ------------------------------------------------------------------ */
{
  const names = Object.keys(sandbox.__codefallClient.sourceTokens)
  check('the source table was generated into the bundle', names.length === 29, `tokens=${names.length}`)
  check(
    'every source entry is a { light, dark } pair of strings',
    names.every((n) => {
      const p = sandbox.__codefallClient.sourceTokens[n]
      return typeof p.light === 'string' && typeof p.dark === 'string' && p.light && p.dark
    })
  )
  check(
    'the shipped values are the SOURCE colours, not greens',
    sandbox.__codefallClient.sourceTokens['--dsw-static-deepseek-500'].light === '#4176e6',
    sandbox.__codefallClient.sourceTokens['--dsw-static-deepseek-500'].light
  )

  const forbidden = [
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
  check(
    'no semantic, neutral or ink token is shipped for remapping',
    names.filter((n) => forbidden.some((re) => re.test(n))).length === 0,
    names.filter((n) => forbidden.some((re) => re.test(n))).join(', ')
  )

  // The golden fixture: same input, same hue, byte-identical output.
  const golden = JSON.parse(readFileSync(join(REPO, 'tools/fixtures/green-145.json'), 'utf8'))
  const built = sandbox.__codefallClient.buildTokens(golden.hue)
  const mismatches = Object.keys(golden.tokens).filter(
    (n) => !built[n] || built[n].light !== golden.tokens[n].light || built[n].dark !== golden.tokens[n].dark
  )
  check(
    'the runtime remap reproduces the generator exactly at the default hue',
    mismatches.length === 0 && Object.keys(built).length === Object.keys(golden.tokens).length,
    mismatches.length ? `${mismatches.length} mismatch(es): ${mismatches.slice(0, 3).join(', ')}` : `${Object.keys(built).length} tokens`
  )
  check(
    'alpha survives the remap',
    built['--dsw-alias-interactive-bg-active'].light.endsWith('1a') &&
      built['--dsw-alias-interactive-bg-active'].light !==
        sandbox.__codefallClient.sourceTokens['--dsw-alias-interactive-bg-active'].light,
    `${sandbox.__codefallClient.sourceTokens['--dsw-alias-interactive-bg-active'].light} -> ${built['--dsw-alias-interactive-bg-active'].light}`
  )
  check(
    'a non-blue source is passed through untouched',
    built['--dsw-alias-interactive-bg-hover'].dark === '#ffffff14',
    built['--dsw-alias-interactive-bg-hover'].dark
  )

  // Hue is the only knob, and it is clamped to the allowed range.
  const clamp = sandbox.__codefallClient.clampHue
  check('the hue below the range clamps up', clamp(90) === exports_.HUE_MIN, String(clamp(90)))
  check('the hue above the range clamps down', clamp(300) === exports_.HUE_MAX, String(clamp(300)))
  check('a nonsense hue falls back to the default', clamp('nope') === exports_.HUE_DEFAULT && clamp(undefined) === exports_.HUE_DEFAULT)
  check('the presets sit inside the range', exports_.HUE_PRESETS.every((p) => p.hue >= exports_.HUE_MIN && p.hue <= exports_.HUE_MAX))

  // Different hues must actually produce different colours...
  const at120 = sandbox.__codefallClient.remapSource('#4176e6', 120)
  const at165 = sandbox.__codefallClient.remapSource('#4176e6', 165)
  check('a different hue yields a different colour', at120 !== at165, `${at120} vs ${at165}`)
  // ...and the same HSL lightness, which is what keeps contrast intact. (The
  // mean of R,G,B is NOT lightness — the middle channel moves with the hue.)
  const hslLightness = (hex) => {
    const n = parseInt(hex.slice(1, 7), 16)
    const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
    return (Math.max(...ch) + Math.min(...ch)) / 2 / 255
  }
  check(
    'the remap preserves HSL lightness across hues',
    Math.abs(hslLightness(at120) - hslLightness(at165)) < 0.005 &&
      Math.abs(hslLightness(at120) - hslLightness('#4176e6')) < 0.005,
    `${hslLightness('#4176e6').toFixed(3)} / ${hslLightness(at120).toFixed(3)} / ${hslLightness(at165).toFixed(3)}`
  )
}

/* --- install / re-register / remove ------------------------------------ */
{
  const installed = []
  const disposers = []
  const theme = {
    overrideTokens(source, tokens) {
      const record = { source, count: Object.keys(tokens).length, sample: tokens['--dsw-static-deepseek-500'].light }
      installed.push(record)
      return () => installed.push({ disposed: true })
    }
  }
  const ctx = makeClientCtx({ theme, disposers })
  server.theme = true
  server.greenHue = 145
  exports_.apply(ctx)
  await settle()

  check('theme:true installs the layer through a declared context', installed.length === 1, JSON.stringify(installed))
  check('the layer carries every source token', installed[0].count === 29, `count=${installed[0].count}`)
  check('the source identity is namespaced', installed[0].source === 'dsh-codefall:green', installed[0].source)
  check('it installs the default hue', installed[0].sample === '#41e686', installed[0].sample)
  check('the client reports the layer as applied', sandbox.__codefallClient.state().themeApplied === true)

  // A hue change re-registers immediately: no restart, no rebuild.
  sandbox.__codefallClient.syncTheme(true, 120)
  check('a hue change re-registers the layer', installed.length === 3 && installed[1].disposed === true, JSON.stringify(installed.map(() => 0)))
  check('the new hue is in the layer', installed[2].sample !== installed[0].sample, `${installed[0].sample} -> ${installed[2].sample}`)
  check('the applied hue is reported', sandbox.__codefallClient.state().themeHue === 120, String(sandbox.__codefallClient.state().themeHue))

  // Same hue again is a no-op, not a churn of registrations.
  sandbox.__codefallClient.syncTheme(true, 120)
  check('re-syncing the same hue is a no-op', installed.length === 3, `installs=${installed.length}`)

  // Off disposes.
  sandbox.__codefallClient.syncTheme(false)
  check('syncTheme(false) disposes the layer', installed[installed.length - 1].disposed === true)
  check('the client reports the layer as removed', sandbox.__codefallClient.state().themeApplied === false)

  // The plugin's own disposal removes the layer.
  check('a disposer was registered through ctx.effect', disposers.length === 1, `disposers=${disposers.length}`)
  disposers[0].d()
  check('unloading the plugin removes the layer', installed[installed.length - 1].disposed === true)
}
{
  // A rejected override must not break activation.
  const ctx = makeClientCtx({
    theme: {
      overrideTokens() {
        throw new Error('nope')
      }
    }
  })
  server.theme = true
  server.greenHue = 145
  let threw = false
  try {
    exports_.apply(ctx)
    await settle()
  } catch (e) {
    threw = true
  }
  check('a rejected override does not break apply()', !threw)
  check('the failed override is not reported as applied', sandbox.__codefallClient.state().themeApplied === false)
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
