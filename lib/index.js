/**
 * dsh-codefall — host half
 *
 * Registers one `webserver/index-inject` subscriber that inlines the boot
 * renderer and the overlay controller into the first frame of every served
 * index.html, plus a small settings route for the browser half.
 *
 * Two deliberate choices worth keeping:
 *
 * 1. The rows are APPENDED, not prepended. The host's own theme bootstrap
 *    (dsh-client-ui-theme) prepends a body script at the same anchor that
 *    resolves the durable light/dark preference onto <body>. Appending means
 *    that script has already run when ours does, so `auto` appearance can read
 *    the real answer instead of guessing from the OS.
 *
 * 2. The renderer and controller are read from disk on every index render
 *    through an mtime cache. Editing the animation therefore needs only a
 *    browser refresh — no desktop-app restart. Only changes to THIS file
 *    (the loader row itself) require a restart.
 *
 * @module dsh-codefall
 */
import { readFileSync, statSync, writeFileSync, renameSync, mkdirSync, unlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'dsh-codefall'

const HERE = dirname(fileURLToPath(import.meta.url))
const RENDERER_FILE = join(HERE, 'renderer.js')
const BOOT_FILE = join(HERE, 'boot.js')

/** Settings route owned by this plugin (the host exposes no third-party settings namespace). */
const API_PATH = '/codefall/api'
const MAX_BODY_BYTES = 64 * 1024

/**
 * Marker that a rendered index already carries our boot script. It exists so the
 * two injection mechanisms below can share one response without doubling up.
 */
const SENTINEL = '__codefallOptions'

/**
 * Live counters, readable at `GET /codefall/api?diag=1`.
 *
 * This deployment has two ways to reach the first frame — a structured
 * `webserver/index-inject` row, and the raw `tapIndex` transform — and which
 * one is actually wired is not something to guess at. Both are registered with
 * an idempotence guard, and these counters report which one carried the page.
 */
const diag = {
  loadedAt: new Date().toISOString(),
  structuredRows: 0,
  tapRenders: 0,
  tapSkipped: 0,
  lastInjectAt: null,
  lastScriptBytes: 0,
  lastError: null,
  /** Reports POSTed back by the injected page script (see DEFAULTS.beacon). */
  beacons: []
}

/** Everything the boot needs, with the deployment defaults. */
const DEFAULTS = {
  animation: true,
  theme: true,
  appearance: 'auto', // 'auto' follows the host's resolved theme
  quality: 'standard', // 'high' | 'standard' | 'economy'
  density: 0.85,
  ghostShare: 0.15,
  speed: 1,
  fontSize: 18,
  columnSpacing: 1.35,
  glyphs: 'code', // 'code' | 'katakana' | 'mixed'
  charset: '',
  /**
   * Empty by default: the product is PURE digital rain — no title, no status
   * line, no hint. Both stay configurable: set `titleText` for the converging
   * title treatment, or `hintReady` for an affordance line.
   */
  titleText: '',
  titleScale: 3.3,
  /**
   * Dismissal policy.
   *   'interaction' — the rain stays until the user moves the pointer, clicks,
   *                   scrolls or presses a key (a boot screen you acknowledge).
   *   'ready'       — the rain leaves once the host is ready and the display
   *                   floor has passed. `'ready'` + `minDisplayMs: 3000` is
   *                   exactly the "3 秒" choice.
   */
  dismiss: 'interaction',
  /** Floor on the visible time. */
  minDisplayMs: 900,
  /** Optional status line once the host is ready — empty, so only rain shows. */
  hintReady: '',
  /** Optional status line for an early interaction — empty by default. */
  hintWaitingAcknowledged: '',
  /** Idle power tiers: slow the rain past this age, then stop drawing at all. */
  idleSlowMs: 20000,
  idleStaticMs: 60000,
  /** Fires only when the host never reports ready — never a display cap. */
  timeoutMs: 15000,
  readyElementThreshold: 80,
  /**
   * Windows desktop only: hide the caption glyphs (minimize / maximize / close)
   * while the boot overlay is up. They are Chromium's title-bar overlay, drawn
   * ABOVE the page, so this works by painting them in the caption fill color —
   * invisible but still clickable. See the caption notes in lib/boot.js.
   */
  hideWindowControls: true,
  /**
   * Green theme: replace the blue brand ramps with green at this hue. The
   * browser half remaps the shipped source colours at runtime, so changing this
   * takes effect immediately rather than at the next launch.
   */
  greenHue: 145,
  /**
   * Page-side self-check. Off by default; when on, the injected script POSTs a
   * small report back to this plugin's own route on the first painted frame and
   * again at hand-off. It is the only way to observe real-browser execution from
   * the host side, and it costs one loopback request.
   */
  beacon: false
}

const ENUM = {
  appearance: ['auto', 'dark', 'light'],
  quality: ['high', 'standard', 'economy'],
  glyphs: ['code', 'katakana', 'mixed'],
  dismiss: ['interaction', 'ready']
}

const RANGE = {
  density: [0.15, 1],
  ghostShare: [0, 0.5],
  speed: [0.2, 4],
  fontSize: [10, 48],
  columnSpacing: [1, 2.5],
  titleScale: [1, 6],
  minDisplayMs: [0, 10000],
  idleSlowMs: [0, 3600000],
  idleStaticMs: [0, 3600000],
  timeoutMs: [1500, 60000],
  readyElementThreshold: [20, 400],
  /**
   * Green theme hue. Lightness and alpha are preserved from the source blue, so
   * the hue is the only degree of freedom that needs a range. 145 is the digital
   * rain's own green; 110 leans yellow-green, 175 leans cyan.
   */
  greenHue: [110, 175]
}

/** Keys the client half may write. Anything else is dropped, not merged. */
const WRITABLE = Object.keys(DEFAULTS)

/* ------------------------------------------------------------------ *
 * settings
 * ------------------------------------------------------------------ */
function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh')
}

function settingsFile() {
  return join(dshHome(), 'codefall.json')
}

/**
 * mtime-keyed file cache. Keeps the per-request cost of inlining ~37 KB of
 * source at roughly one stat() per file, while still picking up an edit on the
 * very next render (which is what makes the refresh-only dev loop work).
 */
function createCache() {
  const files = new Map()
  return {
    read(file) {
      try {
        const st = statSync(file)
        const hit = files.get(file)
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.text
        const text = readFileSync(file, 'utf8')
        files.set(file, { mtimeMs: st.mtimeMs, size: st.size, text })
        return text
      } catch {
        return ''
      }
    },
    invalidate(file) {
      files.delete(file)
    }
  }
}

function clampNumber(value, fallback, [lo, hi]) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(hi, Math.max(lo, n))
}

/** Whitelist, coerce and clamp an untrusted settings object. */
export function normalize(input) {
  const src = input && typeof input === 'object' ? input : {}
  const out = {}
  for (const key of WRITABLE) {
    const raw = src[key]
    const fallback = DEFAULTS[key]
    if (typeof fallback === 'boolean') {
      out[key] = typeof raw === 'boolean' ? raw : fallback
    } else if (typeof fallback === 'number') {
      out[key] = raw === undefined ? fallback : clampNumber(raw, fallback, RANGE[key] || [0, 1])
    } else if (ENUM[key]) {
      out[key] = ENUM[key].includes(raw) ? raw : fallback
    } else {
      out[key] = typeof raw === 'string' ? raw.slice(0, 400) : fallback
    }
  }
  return out
}

function readSettings(cache) {
  const text = cache.read(settingsFile())
  if (!text) return { ...DEFAULTS }
  try {
    return normalize(JSON.parse(text))
  } catch {
    // A corrupt settings file must never break the boot: fall back to defaults.
    return { ...DEFAULTS }
  }
}

function writeSettings(next) {
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const body = JSON.stringify(next, null, 2)
  writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 })
  try {
    renameSync(tmp, file) // atomic replace
  } catch {
    // Windows can refuse a replace while another handle is open; last resort.
    try {
      unlinkSync(file)
    } catch {
      /* nothing to remove */
    }
    renameSync(tmp, file)
  }
}

/* ------------------------------------------------------------------ *
 * first-frame injection
 * ------------------------------------------------------------------ */
/** The subset of options the browser half is allowed to see. */
function bootPayload(options) {
  const out = {}
  for (const key of WRITABLE) out[key] = options[key]
  return out
}

/**
 * Build the body script: renderer + controller + one boot call, all inline so
 * the first frame needs no second request. Wrapped in try/catch because a boot
 * animation must never be able to break the host page.
 */
export function buildScript(options, cache) {
  const renderer = cache.read(RENDERER_FILE)
  const boot = cache.read(BOOT_FILE)
  if (!renderer || !boot) return ''
  const payload = JSON.stringify(
    Object.assign({}, bootPayload(options), {
      // "D": the boot script refreshes only the POLICY keys from this route once
      // the first frame is up, so a setting change does not have to wait for the
      // host's start-time snapshot to be rebuilt.
      configUrl: API_PATH
    })
  )
  const code =
    '(function(){"use strict";try{\n' +
    renderer +
    '\n' +
    boot +
    '\nvar __codefallOptions=' +
    payload +
    ';\n' +
    'if(typeof window!=="undefined"&&window.Codefall){window.Codefall.boot(__codefallOptions)}\n' +
    '}catch(e){try{console.warn("[dsh-codefall] boot failed:",e)}catch(_){}}})();'
  // Defensive: an inline script must not be able to close its own element.
  return code.replace(/<\/(script)/gi, '<\\/$1')
}

/** Insert the boot script immediately after the opening body tag. */
export function injectIntoHtml(html, script) {
  if (typeof html !== 'string') return html
  const tag = '<script>' + script + '</scr' + 'ipt>'
  const body = /<body(?:\s[^>]*)?>/i.exec(html)
  if (!body) return html + tag
  const at = body.index + body[0].length
  return html.slice(0, at) + tag + html.slice(at)
}

/**
 * Register the index transform and the settings route.
 *
 * `webServer` is injected rather than required so the plugin still loads in a
 * composition without an HTTP server (headless, Electron-native) instead of
 * failing the whole profile.
 */
export function apply(ctx) {
  const cache = createCache()

  /** The current boot script, or '' when the animation is off or unreadable. */
  function currentScript() {
    try {
      const options = readSettings(cache)
      if (!options.animation) return ''
      return buildScript(options, cache)
    } catch (error) {
      diag.lastError = String((error && error.message) || error)
      return ''
    }
  }

  // Mechanism 1 — the structured injection table. Registered on the plugin's own
  // context (the event needs no service) and APPENDED, not prepended: see the
  // module header. `ctx.on(name, listener, options?)` takes an options object;
  // it has no label parameter.
  ctx.on(
    'webserver/index-inject',
    (table) => {
      const script = currentScript()
      if (!script || !table || typeof table.push !== 'function') return
      table.push({ kind: 'script', placement: 'body', text: script })
      diag.structuredRows++
      diag.lastInjectAt = new Date().toISOString()
      diag.lastScriptBytes = script.length
    },
    { prepend: false }
  )

  ctx.inject(['webServer'], (http) => {
    // Mechanism 2 — the raw index transform, kept as a fallback for a build
    // where the structured table is not rendered. The sentinel makes it a no-op
    // whenever mechanism 1 already carried the response.
    http.effect(
      () =>
        http.webServer.tapIndex((html) => {
          try {
            if (typeof html === 'string' && html.indexOf(SENTINEL) !== -1) {
              diag.tapSkipped++
              return html
            }
            const script = currentScript()
            if (!script) return html
            diag.tapRenders++
            diag.lastInjectAt = new Date().toISOString()
            diag.lastScriptBytes = script.length
            return injectIntoHtml(html, script)
          } catch (error) {
            diag.lastError = String((error && error.message) || error)
            return html
          }
        }),
      'dsh-codefall: first-frame boot (tap fallback)'
    )

    http.effect(
      () =>
        http.webServer.register({
          kind: 'exact',
          path: API_PATH,
          handler: createSettingsHandler(cache)
        }),
      'dsh-codefall: settings route'
    )
  })
}

/* ------------------------------------------------------------------ *
 * settings route
 * ------------------------------------------------------------------ */
function isLoopback(address) {
  if (!address) return true // no socket info: the server itself is loopback-bound
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  )
}

function createSettingsHandler(cache) {
  return async function handler(req, res) {
    const send = (code, body) => {
      const text = JSON.stringify(body)
      res.writeHead(code, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(text)
      })
      res.end(text)
    }

    const remote = req.socket && req.socket.remoteAddress
    if (!isLoopback(remote)) return send(403, { ok: false, error: 'loopback-only' })

    // Self-report: which injection mechanism is actually carrying the page.
    try {
      const url = new URL(req.url || '/', 'http://codefall.local')
      if (url.searchParams.has('diag')) {
        return send(200, {
          ok: true,
          diag,
          files: { renderer: RENDERER_FILE, boot: BOOT_FILE, bootReadable: !!cache.read(BOOT_FILE) }
        })
      }
    } catch {
      /* a malformed URL is not worth failing over */
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      return send(200, { ok: true, value: readSettings(cache), defaults: DEFAULTS })
    }
    if (req.method !== 'POST') return send(405, { ok: false, error: 'method-not-allowed' })

    const contentType = String(req.headers['content-type'] || '')
    if (!contentType.includes('application/json')) return send(415, { ok: false, error: 'json-required' })

    let raw = ''
    try {
      for await (const chunk of req) {
        raw += chunk
        if (raw.length > MAX_BODY_BYTES) {
          send(413, { ok: false, error: 'payload-too-large' })
          req.destroy()
          return
        }
      }
    } catch {
      return send(400, { ok: false, error: 'unreadable-body' })
    }

    let patch
    try {
      patch = JSON.parse(raw || '{}')
    } catch {
      return send(400, { ok: false, error: 'bad-json' })
    }

    // `{patch:{...}}` mirrors the shape other DSH plugins use; a bare object
    // is accepted too so the route is easy to poke by hand.
    const delta = patch && typeof patch === 'object' && patch.patch ? patch.patch : patch

    // Page-side self-check reports are recorded, never persisted.
    if (patch && typeof patch === 'object' && patch.beacon && typeof patch.beacon === 'object') {
      const report = { ...patch.beacon, receivedAt: new Date().toISOString() }
      diag.beacons.push(report)
      if (diag.beacons.length > 20) diag.beacons.shift()
      return send(200, { ok: true, diag: { beacons: diag.beacons.length } })
    }

    const next = normalize({ ...readSettings(cache), ...(delta && typeof delta === 'object' ? delta : {}) })

    try {
      writeSettings(next)
      cache.invalidate(settingsFile())
    } catch {
      return send(500, { ok: false, error: 'write-failed' })
    }
    return send(200, { ok: true, value: next })
  }
}

/** Exported for the offline host test. */
export const internals = {
  DEFAULTS,
  ENUM,
  RANGE,
  API_PATH,
  SENTINEL,
  diag,
  normalize,
  readSettings,
  writeSettings,
  createCache,
  settingsFile,
  createSettingsHandler,
  injectIntoHtml
}
