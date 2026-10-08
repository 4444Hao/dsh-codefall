/**
 * Offline integration test for the dsh-codefall host half.
 *
 *   node tools/host-test.mjs
 *
 * It fakes the Cordis context, the webserver and enough of the DOM to actually
 * RUN the injected first-frame script, so the wiring (loader row -> index row ->
 * boot -> hand-off -> teardown) is verified without installing anything into a
 * live profile.
 */
import vm from 'node:vm'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

/** The Windows caption probe's resolved colors (the shell's dark defaults). */
const CAPTION_FILL = 'rgba(27, 27, 28, 1)'
const CAPTION_FILL_LIGHT = 'rgba(249, 250, 251, 1)'
const CAPTION_SYMBOL = 'rgba(249, 250, 251, 1)'
const CAPTION_CSS =
  'position: fixed; visibility: hidden; pointer-events: none; ' +
  'background-color: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary)'

/* Isolate the settings file from the real one. */
const HOME = mkdtempSync(join(tmpdir(), 'codefall-test-'))
process.env.DSH_HOME = HOME

const host = await import(pathToFileURL(join(REPO, 'lib', 'index.js')).href)
const { internals } = host

let failures = 0
function check(name, ok, detail) {
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? '   ' + detail : ''}`)
}

/* ------------------------------------------------------------------ *
 * 1. normalize(): untrusted input must be whitelisted and clamped
 * ------------------------------------------------------------------ */
const messy = internals.normalize({
  density: 99,
  quality: 'nonsense',
  appearance: 'sepia',
  titleText: 'x'.repeat(900),
  speed: -3,
  evil: 'dropped',
  animation: 'yes'
})
check('normalize clamps numbers into range', messy.density === 1 && messy.speed === 0.2, `density=${messy.density} speed=${messy.speed}`)
check('normalize rejects unknown enum values', messy.quality === 'standard' && messy.appearance === 'auto')
check('normalize drops unknown keys', !('evil' in messy))
check('normalize enforces boolean type', messy.animation === true)
check('normalize truncates long strings', messy.titleText.length === 400)
check(
  'the green hue is clamped to its own range',
  internals.normalize({ greenHue: 300 }).greenHue === 175 &&
    internals.normalize({ greenHue: 20 }).greenHue === 110 &&
    internals.normalize({ greenHue: 'nonsense' }).greenHue === 145,
  `300->${internals.normalize({ greenHue: 300 }).greenHue} 20->${internals.normalize({ greenHue: 20 }).greenHue} bogus->${
    internals.normalize({ greenHue: 'nonsense' }).greenHue
  }`
)

/* ------------------------------------------------------------------ *
 * 2. apply(): registers one index subscriber plus the settings route
 * ------------------------------------------------------------------ */
const indexHandlers = []
const routes = []
const taps = []
const fakeCtx = {
  // The structured listener is registered on the plugin's own context: the event
  // needs no service, so it must not be gated behind a service inject.
  on(event, handler, options) {
    indexHandlers.push({ event, handler, options })
  },
  inject(deps, cb) {
    cb({
      on(event, handler, options) {
        indexHandlers.push({ event, handler, options })
      },
      effect(fn) {
        const disposer = fn()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      webServer: {
        register(route) {
          routes.push(route)
          return () => {}
        },
        tapIndex(fn) {
          taps.push(fn)
          return () => {}
        }
      }
    })
  }
}
host.apply(fakeCtx)
check('registered exactly one index-inject subscriber', indexHandlers.length === 1, `event=${indexHandlers[0] && indexHandlers[0].event}`)
check(
  'listener options are an options object, not a misused label string',
  indexHandlers[0].options === undefined || typeof indexHandlers[0].options === 'object',
  JSON.stringify(indexHandlers[0].options)
)
check('registered the tap fallback', taps.length === 1)
check('registered the settings route', routes.length === 1 && routes[0].path === internals.API_PATH, routes[0] && routes[0].path)

/* ------------------------------------------------------------------ *
 * 3. the emitted index rows
 * ------------------------------------------------------------------ */
const cache = internals.createCache()
const options = internals.normalize({ ...internals.DEFAULTS, appearance: 'auto' })
const script = host.buildScript(options, cache)
check('buildScript produced code', script.length > 20000, `${script.length} bytes`)
check('script carries the renderer', script.includes('CodefallRenderer'))
check('script carries the controller', script.includes('window.Codefall.boot'))
check('script cannot close its own tag', !/<\/script/i.test(script))
let compiles = true
try {
  new vm.Script(script)
} catch (e) {
  compiles = false
  console.log('      compile error: ' + e.message)
}
check('inlined script compiles as one unit', compiles)

/* A deployment that turns the animation off must emit nothing at all. */
writeFileSync(join(HOME, 'codefall.json'), JSON.stringify({ animation: false }))
const offTable = []
indexHandlers[0].handler(offTable)
check('animation:false emits no rows', offTable.length === 0, `rows=${offTable.length}`)
rmSync(join(HOME, 'codefall.json'), { force: true })

/* And by default it emits exactly one body script row. */
const table = []
indexHandlers[0].handler(table)
check('default emits one body script row', table.length === 1 && table[0].kind === 'script' && table[0].placement === 'body', JSON.stringify(table.map((r) => r.kind)))

/* --- the tap fallback and the shared sentinel -------------------------- */
const rawIndex = '<!doctype html><html><head><title>t</title></head><body><div id="root"></div></body></html>'
const tapped = taps[0](rawIndex)
check('tap fallback injects right after the opening body tag', tapped.indexOf('<script>') === tapped.indexOf('<body>') + 6, `script@${tapped.indexOf('<script>')} body@${tapped.indexOf('<body>')}`)
check('tap fallback carries the boot script', tapped.includes(internals.SENTINEL))
check('tap fallback is idempotent (sentinel guard)', taps[0](tapped) === tapped)
check('structured row also carries the sentinel', table[0].text.includes(internals.SENTINEL))

/* ------------------------------------------------------------------ *
 * 4. run the injected script against a fake DOM
 * ------------------------------------------------------------------ */
function makeFake2d() {
  return {
    measureText: () => ({ width: 9 }),
    setTransform() {},
    fillRect() {},
    drawImage() {},
    fillText() {},
    imageSmoothingEnabled: true,
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    shadowColor: '',
    shadowBlur: 0,
    globalAlpha: 1
  }
}

function makeSandbox({ darkTheme, themeSource, systemDark = false, reducedMotion = false, policy }) {
  const listeners = {}
  const timers = new Map()
  let nextTimer = 1
  let pendingRaf = null
  let rafId = 1
  const clock = { now: 0 }
  /** The caption fill as the shell's stylesheet currently resolves it. */
  let captionFill = CAPTION_FILL

  /**
   * A style object with a real `cssText` round-trip plus set/get/removeProperty,
   * because the caption logic depends on all three.
   */
  const makeStyle = () => {
    const props = {}
    const style = {
      setProperty(k, v) {
        props[k] = String(v)
      },
      removeProperty(k) {
        delete props[k]
      },
      getPropertyValue: (k) => (Object.prototype.hasOwnProperty.call(props, k) ? props[k] : '')
    }
    Object.defineProperty(style, '__props', { value: props })
    Object.defineProperty(style, 'cssText', {
      get: () => Object.keys(props).map((k) => k + ': ' + props[k]).join('; '),
      set: (text) => {
        Object.keys(props).forEach((k) => delete props[k])
        String(text)
          .split(';')
          .forEach((decl) => {
            const at = decl.indexOf(':')
            if (at > 0) props[decl.slice(0, at).trim()] = decl.slice(at + 1).trim()
          })
      }
    })
    return style
  }

  const element = (tag) => {
    const attrs = {}
    return {
      tagName: tag,
      style: makeStyle(),
      children: [],
      parentNode: null,
      className: '',
      clientWidth: 1280,
      clientHeight: 800,
      setAttribute(k, v) {
        attrs[k] = v === undefined ? '' : v
      },
      // Presence, not truthiness: `data-ds-dark-theme` is an empty attribute.
      hasAttribute: (k) => Object.prototype.hasOwnProperty.call(attrs, k),
      appendChild(c) {
        this.children.push(c)
        c.parentNode = this
        return c
      },
      append(c) {
        return this.appendChild(c)
      },
      removeChild(c) {
        this.children = this.children.filter((x) => x !== c)
        c.parentNode = null
        return c
      },
      addEventListener(t, fn) {
        ;(listeners[t] = listeners[t] || []).push(fn)
      },
      removeEventListener() {},
      querySelectorAll: () => [],
      getContext: () => makeFake2d()
    }
  }

  const body = element('body')
  if (darkTheme) body.setAttribute('data-ds-dark-theme', '')
  const root = element('div')
  const documentElement = element('html')
  documentElement.dataset = themeSource ? { dsThemeSource: themeSource } : {}

  const document = {
    body,
    documentElement,
    hidden: false,
    createElement: element,
    getElementById: (id) => (id === 'root' ? root : null),
    addEventListener(t, fn) {
      ;(listeners[t] = listeners[t] || []).push(fn)
    },
    removeEventListener() {}
  }

  const sandbox = {
    document,
    // Forward page-level complaints: the injected script is required to swallow
    // its own failures, so this is the only way to see them.
    console: {
      log: (...a) => console.log('        [page]', ...a),
      warn: (...a) => console.log('        [page:warn]', ...a),
      error: (...a) => console.log('        [page:error]', ...a),
      debug: () => {}
    },
    devicePixelRatio: 1,
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(t, fn) {
      ;(listeners[t] = listeners[t] || []).push(fn)
    },
    removeEventListener() {},
    matchMedia: (query) => {
      if (query.includes('prefers-reduced-motion')) return { matches: !!reducedMotion }
      if (query.includes('prefers-color-scheme: dark')) return { matches: !!systemDark }
      if (query.includes('prefers-color-scheme: light')) return { matches: !systemDark }
      return { matches: false }
    },
    performance: { now: () => clock.now },
    /**
     * Minimal computed-style resolution: the caption probe's inline declarations
     * name design tokens, and a real browser resolves them.
     */
    getComputedStyle: (el) => {
      const props = (el.style && el.style.__props) || {}
      const resolve = (value, fallback) => {
        if (!value) return fallback
        if (value.indexOf('--dsw-specific-sidebar-fill') >= 0) return captionFill
        if (value.indexOf('--dsw-alias-label-primary') >= 0) return CAPTION_SYMBOL
        return value
      }
      return {
        backgroundColor: resolve(props['background-color'], 'rgba(0, 0, 0, 0)'),
        color: resolve(props['color'], CAPTION_SYMBOL)
      }
    },
    requestAnimationFrame(fn) {
      pendingRaf = fn
      return rafId++
    },
    cancelAnimationFrame() {
      pendingRaf = null
    },
    setTimeout(fn, ms) {
      const id = nextTimer++
      timers.set(id, { fn, at: clock.now + (ms || 0) })
      return id
    },
    clearTimeout(id) {
      timers.delete(id)
    },
    MutationObserver: undefined
  }
  sandbox.window = sandbox

  // Only wired when a test asks for a live policy, so the default path keeps
  // exercising "no fetch available".
  const fetchCalls = []
  if (policy !== undefined) {
    sandbox.fetch = (url) => {
      fetchCalls.push(url)
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ ok: true, value: policy })
      })
    }
  }

  return {
    sandbox,
    body,
    root,
    fetchCalls,
    setCaptionFill: (value) => {
      captionFill = value
    },
    /** Advance the clock and fire the pending animation frame. */
    tick(ms) {
      clock.now += ms
      const fn = pendingRaf
      pendingRaf = null
      if (fn) fn(clock.now)
    },
    /** Advance the clock in realistic frame steps (the loop throttles to 30fps). */
    advance(ms, step = 17) {
      let left = ms
      while (left > 0) {
        this.tick(Math.min(step, left))
        left -= step
      }
    },
    runDueTimers() {
      const due = [...timers.entries()].filter(([, t]) => t.at <= clock.now).sort((a, b) => a[1].at - b[1].at)
      for (const [id, t] of due) {
        timers.delete(id)
        t.fn()
      }
    },
    hasPendingRaf: () => !!pendingRaf,
    /** Dispatch a DOM event to the listeners the overlay registered. */
    fire(type, event) {
      for (const fn of listeners[type] || []) fn({ ...event, type })
    }
  }
}

/* --- dark + the new dismissal contract ---------------------------------- */
const scriptReadyDismiss = host.buildScript({ ...internals.DEFAULTS, dismiss: 'ready' }, cache)
const scriptIdle = host.buildScript({ ...internals.DEFAULTS, idleSlowMs: 600, idleStaticMs: 1200 }, cache)
function bootInto(env, code) {
  vm.createContext(env.sandbox)
  new vm.Script(code).runInContext(env.sandbox)
  return env.sandbox.__codefallController
}
/**
 * Drive a released overlay all the way to teardown: drain, fade, timer.
 * Release is frame-driven, but the drain backstop and the fade are timers, so
 * both clocks have to be advanced.
 */
function settle(env) {
  env.advance(800)
  env.runDueTimers()
  env.advance(400)
  env.runDueTimers()
  env.advance(400)
  env.runDueTimers()
}

{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, script)

  check('injected script boots the overlay', !!ctl, ctl ? `phase=${ctl.state().phase}` : 'no controller')
  check('appearance follows the host theme bootstrap (dark)', ctl.state().appearance === 'dark', ctl.state().appearance)
  check('overlay element is in the document', env.body.children.length === 1 && env.body.children[0].style)
  check('a frame loop is scheduled', env.hasPendingRaf())

  env.tick(50)
  env.tick(50)
  check('frames advance the clock', ctl.state().elapsed >= 100, `elapsed=${ctl.state().elapsed}`)
  check('waits for the host before ready()', ctl.state().waitingFor === 'host')

  ctl.ready()
  check(
    'ready() alone does NOT release under dismiss:interaction',
    ctl.state().phase === 'playing' && ctl.state().waitingFor === 'interaction',
    `${ctl.state().phase}/${ctl.state().waitingFor}`
  )
  check(
    'pure rain by default: empty title and no hint text',
    internals.DEFAULTS.titleText === '' && ctl.state().hint === '',
    `title='${internals.DEFAULTS.titleText}' hint='${ctl.state().hint}'`
  )
  env.advance(1500)
  check('the rain keeps falling while waiting for interaction', ctl.state().phase === 'playing' && env.body.children.length === 1, `elapsed=${ctl.state().elapsed}`)

  ctl.interact('test')
  check('interaction starts the exit', ctl.state().phase === 'draining', ctl.state().phase)
  settle(env)
  check('overlay is removed after interaction', env.body.children.length === 0)
  check('controller is released', env.sandbox.__codefallController === undefined)
}

/* --- hints are still available when asked for --------------------------- */
{
  const withHints = host.buildScript(
    { ...internals.DEFAULTS, hintReady: 'READY-HINT', hintWaitingAcknowledged: 'WAIT-HINT' },
    cache
  )
  // (a) no interaction yet -> the ready hint invites the user.
  {
    const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
    const ctl = bootInto(env, withHints)
    ctl.ready()
    check('the ready hint is opt-in and shows when configured', ctl.state().hint === 'READY-HINT', ctl.state().hint)
  }
  // (b) the user already acted -> the hint clears, and it releases after the floor.
  {
    const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
    const ctl = bootInto(env, withHints)
    env.advance(100)
    ctl.interact('early')
    check('the waiting hint shows for an early interaction', ctl.state().hint === 'WAIT-HINT', ctl.state().hint)
    ctl.ready()
    check('once the user has acted, the hint clears', ctl.state().hint === '', ctl.state().hint)
    env.advance(1100)
    check('and the overlay releases after the display floor', ctl.state().phase !== 'playing', ctl.state().phase)
  }
}

/* --- the "3s" choice = dismiss:ready + minDisplayMs: 3000 ---------------- */
{
  const threeSeconds = host.buildScript({ ...internals.DEFAULTS, dismiss: 'ready', minDisplayMs: 3000 }, cache)
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, threeSeconds)
  ctl.ready()
  env.advance(2000)
  check('3s mode still shows rain at 2.0s', ctl.state().phase === 'playing', ctl.state().phase)
  env.advance(1400)
  check('3s mode has released by 3.4s', ctl.state().phase !== 'playing', ctl.state().phase)
  settle(env)
  check('3s mode removes the overlay', env.body.children.length === 0)
}

/* --- dismiss:'ready' still hands off on its own ------------------------- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, scriptReadyDismiss)
  ctl.ready()
  check('dismiss:ready holds until the display floor passes', ctl.state().phase === 'playing', ctl.state().phase)
  env.advance(1100)
  check('dismiss:ready releases after the floor', ctl.state().phase !== 'playing', ctl.state().phase)
  settle(env)
  check('dismiss:ready removes the overlay', env.body.children.length === 0)
}

/* --- interacting before the host is ready: acknowledged, never trapped --- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, script)
  env.advance(100)
  ctl.interact('early')
  check('an early interaction is acknowledged in the hint', ctl.state().hint === internals.DEFAULTS.hintWaitingAcknowledged, ctl.state().hint)
  check('an early interaction does not release before ready', ctl.state().phase === 'playing')
  env.advance(2700)
  env.runDueTimers() // the grace period is a timer, not a frame
  check('an early interaction hands over after the grace period', ctl.state().phase !== 'playing', ctl.state().phase)
  settle(env)
  check('the grace hand-over removes the overlay', env.body.children.length === 0)
}

/* --- idle power tiers: stop drawing, keep listening --------------------- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, scriptIdle)
  ctl.ready()
  env.advance(1400)
  check('the idle tier stops producing frames', ctl.state().idleStopped === true)
  check('the idle overlay is still up, waiting for the user', env.body.children.length === 1)
  ctl.interact('after-idle')
  check('an idle-stopped overlay still dismisses', ctl.state().phase === 'draining', ctl.state().phase)
  settle(env)
  check('the idle overlay is removed after interaction', env.body.children.length === 0)
}

/* --- pointer movement must be deliberate ------------------------------- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, script)
  ctl.ready()
  env.fire('mousemove', { clientX: 0, clientY: 0 }) // inside the arm window: ignored
  env.advance(600)
  env.fire('mousemove', { clientX: 0, clientY: 0 }) // first armed sample only seeds the origin
  env.fire('mousemove', { clientX: 3, clientY: 3 }) // 6px, below the threshold
  check('tiny pointer jitter does not dismiss', ctl.state().interacted === false, ctl.state().hint)
  env.fire('mousemove', { clientX: 20, clientY: 20 })
  check('deliberate pointer movement dismisses', ctl.state().interacted === true)
}

/* --- light: attribute absent but the bootstrap ran -> trust it ---------- */
{
  const env = makeSandbox({ darkTheme: false, themeSource: 'light' })
  vm.createContext(env.sandbox)
  new vm.Script(script).runInContext(env.sandbox)
  const ctl = env.sandbox.__codefallController
  check('appearance follows the host theme bootstrap (light)', ctl.state().appearance === 'light', ctl.state().appearance)
}

/* --- no theme plugin at all -> fall back to the OS query ---------------- */
{
  const env = makeSandbox({ darkTheme: false, themeSource: null, systemDark: false })
  vm.createContext(env.sandbox)
  new vm.Script(script).runInContext(env.sandbox)
  const ctl = env.sandbox.__codefallController
  check('falls back to the OS query when no theme bootstrap ran (light)', ctl.state().appearance === 'light', ctl.state().appearance)
}
{
  const env = makeSandbox({ darkTheme: false, themeSource: null, systemDark: true })
  vm.createContext(env.sandbox)
  new vm.Script(script).runInContext(env.sandbox)
  const ctl = env.sandbox.__codefallController
  check('falls back to the OS query when no theme bootstrap ran (dark)', ctl.state().appearance === 'dark', ctl.state().appearance)
}

/* --- escape hatch: a host that never reports ready must not trap -------- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, script)
  env.advance(16000)
  env.runDueTimers() // the watchdog is a timer
  settle(env)
  check('watchdog releases a host that never reports ready', env.body.children.length === 0, ctl.state().phase)
}

/* --- reduced motion: one settled frame, no loop, still releasable ------- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark', reducedMotion: true })
  const ctl = bootInto(env, script)
  check('reduced motion is detected', ctl.reducedMotion === true)
  check('reduced motion renders a frame without starting a loop', !env.hasPendingRaf())
  check('reduced-motion overlay is in the DOM', env.body.children.length === 1)
  ctl.ready()
  env.advance(1000)
  check('reduced motion still waits for the user', ctl.state().phase === 'playing', ctl.state().phase)
  ctl.interact('reduced')
  env.advance(700) // no loop in this path: the drain backstop is the only clock
  env.runDueTimers()
  check('reduced-motion drain falls back to its backstop', ctl.state().phase === 'closing' || ctl.state().phase === 'done', ctl.state().phase)
  env.advance(200)
  env.runDueTimers()
  check('reduced-motion overlay still hands off', env.body.children.length === 0, ctl.state().phase)
}

/* --- D: policy keys are refreshed from the plugin route at runtime ------ */
const settleMicrotasks = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}
{
  const env = makeSandbox({
    darkTheme: true,
    themeSource: 'dark',
    // The snapshot says 'interaction' + standard; the live config says
    // "3 seconds" plus a thinner, cheaper, katakana rain.
    policy: { dismiss: 'ready', minDisplayMs: 3000, density: 0.3, quality: 'economy', glyphs: 'katakana' }
  })
  const ctl = bootInto(env, script)
  check(
    'the overlay is up and no policy request has been made yet',
    env.body.children.length === 1 && env.fetchCalls.length === 0,
    `children=${env.body.children.length} calls=${env.fetchCalls.length}`
  )
  check('the snapshot value is in charge initially', ctl.state().dismiss === 'interaction', ctl.state().dismiss)
  const revBefore = ctl.state().sceneRevision

  env.advance(60) // one frame goes out, which is what triggers the pull
  check('a policy request is issued once the frame is up', env.fetchCalls.length === 1, `calls=${env.fetchCalls.length}`)
  check('the policy request targets the plugin route', env.fetchCalls[0] === internals.API_PATH, env.fetchCalls[0])
  await settleMicrotasks()
  check(
    'the live policy replaces the snapshot value',
    ctl.state().dismiss === 'ready' && ctl.state().minDisplayMs === 3000,
    `${ctl.state().dismiss}/${ctl.state().minDisplayMs}`
  )
  check(
    'live visual parameters are applied too',
    ctl.state().density === 0.3 && ctl.state().quality === 'economy' && ctl.state().glyphs === 'katakana',
    `density=${ctl.state().density} quality=${ctl.state().quality} glyphs=${ctl.state().glyphs}`
  )
  check(
    'applying them did NOT restart the scene',
    ctl.state().sceneRevision === revBefore,
    `rev ${revBefore} -> ${ctl.state().sceneRevision}`
  )
  check('the overlay is still running after the config landed', ctl.state().phase === 'playing' && env.body.children.length === 1)
  // The policy decides WHEN, but the host must still report ready: releasing
  // earlier would drop the user onto a half-built UI.
  env.advance(2000)
  check('no release before the host reports ready', ctl.state().phase === 'playing', ctl.state().phase)

  ctl.ready()
  env.advance(600)
  check('still up at ~2.7s under the live 3s policy', ctl.state().phase === 'playing', `elapsed=${ctl.state().elapsed}`)
  env.advance(900)
  check('and it releases past 3s with no interaction at all', ctl.state().phase !== 'playing', `elapsed=${ctl.state().elapsed}`)
  settle(env)
  check('the live-policy overlay is removed', env.body.children.length === 0)
}

/* --- Windows caption: the strip and its glyphs both take the rain bg --- */
{
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark', policy: { appearance: 'light' } })
  const probe = env.sandbox.document.createElement('span')
  probe.style.cssText = CAPTION_CSS
  env.body.appendChild(probe)

  const ctl = bootInto(env, script)
  check(
    'the caption gains a background instead of keeping the shell neutral',
    probe.style.getPropertyValue('background-color') === '#151517',
    probe.style.getPropertyValue('background-color') || '(untouched)'
  )
  check(
    'the caption glyphs are painted in the same color',
    probe.style.getPropertyValue('color') === '#151517',
    probe.style.getPropertyValue('color')
  )
  check('the nudge leaves no residue on body.style', env.body.style.cssText === '', `[${env.body.style.cssText}]`)

  // A theme change moves the rain background, so the hidden strip must follow it.
  env.advance(60) // first frame -> the config refresh is requested
  await settleMicrotasks()
  check(
    'the strip follows the rain background into light mode',
    probe.style.getPropertyValue('background-color') === '#ffffff' && probe.style.getPropertyValue('color') === '#ffffff',
    `${probe.style.getPropertyValue('background-color')} / ${probe.style.getPropertyValue('color')}`
  )

  ctl.ready()
  ctl.interact('after-caption')
  settle(env)
  check('the caption declarations are restored byte-exactly', probe.style.cssText === CAPTION_CSS, probe.style.cssText)
}
{
  // The preload may append the probe after this script has already run.
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const ctl = bootInto(env, script)
  check('without a probe nothing is touched', env.body.children.length === 1)
  const probe = env.sandbox.document.createElement('span')
  probe.style.cssText = CAPTION_CSS
  env.body.appendChild(probe)
  env.advance(150)
  env.runDueTimers()
  check(
    'a late probe is picked up by the retry',
    probe.style.getPropertyValue('color') === '#151517' && probe.style.getPropertyValue('background-color') === '#151517',
    probe.style.getPropertyValue('color') || '(untouched)'
  )
  ctl.ready()
  ctl.interact('late-probe')
  settle(env)
  check('the late probe is restored too', probe.style.cssText === CAPTION_CSS, probe.style.cssText)
}
{
  // The watchdog path must restore as well: a host that never reports ready.
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const probe = env.sandbox.document.createElement('span')
  probe.style.cssText = CAPTION_CSS
  env.body.appendChild(probe)
  bootInto(env, script)
  env.advance(16000)
  env.runDueTimers() // the watchdog fires here, starting the exit
  settle(env) // the exit needs frames to drain and fade
  check('an interrupted boot still restores the caption', probe.style.cssText === CAPTION_CSS, probe.style.cssText)
}
{
  // The switch must really switch it off.
  const env = makeSandbox({ darkTheme: true, themeSource: 'dark' })
  const probe = env.sandbox.document.createElement('span')
  probe.style.cssText = CAPTION_CSS
  env.body.appendChild(probe)
  const off = host.buildScript({ ...internals.DEFAULTS, hideWindowControls: false }, cache)
  const ctl = bootInto(env, off)
  check('hideWindowControls:false leaves the caption alone', probe.style.cssText === CAPTION_CSS, probe.style.cssText)
  ctl.interact('off')
  settle(env)
  check('and nothing changes at hand-off', probe.style.cssText === CAPTION_CSS, probe.style.cssText)
}

/* ------------------------------------------------------------------ *
 * 5. the settings route
 * ------------------------------------------------------------------ */
function fakeReq({ method = 'GET', contentType, body, remote = '127.0.0.1', url = '/codefall/api' }) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url,
    headers: contentType ? { 'content-type': contentType } : {},
    socket: { remoteAddress: remote },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c
    }
  }
}
function fakeRes() {
  const out = { code: 0, headers: null, body: '' }
  return {
    out,
    writeHead(code, headers) {
      out.code = code
      out.headers = headers
    },
    end(text) {
      out.body = text || ''
    }
  }
}

const handler = internals.createSettingsHandler(internals.createCache())

{
  const res = fakeRes()
  await handler(fakeReq({}), res)
  const parsed = JSON.parse(res.out.body)
  check('GET returns defaults', res.out.code === 200 && parsed.ok && parsed.value.quality === 'standard')
}
{
  const res = fakeRes()
  await handler(fakeReq({ url: '/codefall/api?diag=1' }), res)
  const parsed = JSON.parse(res.out.body)
  check(
    'diag route reports both injection mechanisms',
    res.out.code === 200 && parsed.diag && 'structuredRows' in parsed.diag && 'tapRenders' in parsed.diag,
    JSON.stringify(parsed.diag)
  )
  check('diag confirms the boot files are readable', !!(parsed.files && parsed.files.bootReadable))
}
{
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', contentType: 'text/plain', body: '{}' }), res)
  check('POST without JSON content-type is refused', res.out.code === 415, `code=${res.out.code}`)
}
{
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', contentType: 'application/json', body: '{', }), res)
  check('POST with broken JSON is refused', res.out.code === 400, `code=${res.out.code}`)
}
{
  const res = fakeRes()
  await handler(fakeReq({ method: 'POST', contentType: 'application/json', body: '{"patch":{"theme":false,"density":0.5}}' }), res)
  const parsed = JSON.parse(res.out.body)
  check('POST writes the settings file', res.out.code === 200 && parsed.value.theme === false, `code=${res.out.code}`)
  const onDisk = JSON.parse(readFileSync(internals.settingsFile(), 'utf8'))
  check('settings file round-trips', onDisk.theme === false && onDisk.density === 0.5)
  const res2 = fakeRes()
  await handler(fakeReq({}), res2)
  check('next GET sees the write (cache invalidated)', JSON.parse(res2.out.body).value.density === 0.5)
}
{
  const res = fakeRes()
  await handler(fakeReq({ remote: '10.0.0.7' }), res)
  check('non-loopback peers are refused', res.out.code === 403, `code=${res.out.code}`)
}
{
  const res = fakeRes()
  await handler(fakeReq({ method: 'DELETE' }), res)
  check('unsupported methods are refused', res.out.code === 405, `code=${res.out.code}`)
}

rmSync(HOME, { recursive: true, force: true })
console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`)
process.exit(failures === 0 ? 0 : 1)
