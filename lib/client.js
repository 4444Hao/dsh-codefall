/**
 * dsh-codefall — browser half
 *
 * Hand-written `__ModuleLoader__` bundle, exactly the shape the shipped ui-*
 * packages are built into, so this plugin needs no bundler and no build step.
 * Three jobs:
 *
 *   1. Readiness hand-off. The boot overlay is removed when the client tree has
 *      settled, and the only client-side signal that actually means "the UI is
 *      up" is a first mount into `shell.overlay`: the shell renders the app (and
 *      therefore that overlay) only after every plugin fiber is active.
 *
 *   2. A settings surface. The host does not expose third-party settings
 *      namespaces (`settings-not-exposed`), so this plugin brings its own
 *      controls and reads/writes its own route.
 *
 * Placement is section-first with a fallback, because "where do I control this
 * plugin" should be answerable from the settings navigation itself:
 *
 *   - preferred: our own section in the settings nav (`settings.section`) with a
 *     label we choose. That is the pattern the shipped third-party skin plugin
 *     uses, and it leaves room for a theme switch and a preview later.
 *   - fallback: a row inside the official 通用设置 list (`settings.general.item`),
 *     so a section-contract mismatch can never leave the user with no UI at all.
 *
 * Theme overrides (stage C) will attach here too.
 */
window.__ModuleLoader__.load({
  id: 'dsh-codefall',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    var React = require('react')
    var version = '0.1.0'
    var PARENT = 'shell.overlay'
    var SETTINGS_SECTION = 'settings.section'
    var SETTINGS_ROW = 'settings.general.item'
    var API = '/codefall/api'
    /**
     * The name shown in the settings navigation. One string, deliberately:
     * "function + package" so the entry explains itself while still carrying
     * the brand (official entries are function-named, e.g. 通用设置).
     */
    var SECTION_LABEL = '开机动画codefall'
    var h = React.createElement

    /** Dismissal is two underlying keys, not a third invented concept. */
    var DISMISS_MODES = [
      { id: 'interaction', label: '交互后结束', patch: { dismiss: 'interaction', minDisplayMs: 900 } },
      { id: 'ready', label: '3 秒后自动继续', patch: { dismiss: 'ready', minDisplayMs: 3000 } }
    ]
    var QUALITIES = [
      { id: 'high', label: '高' },
      { id: 'standard', label: '标准' },
      { id: 'economy', label: '省电' }
    ]
    var APPEARANCES = [
      { id: 'auto', label: '跟随' },
      { id: 'dark', label: '深色' },
      { id: 'light', label: '浅色' }
    ]

    var done = false
    // Module scope on purpose: there is exactly one settings instance, and these
    // must outlive re-renders so a debounced write is not lost.
    var pendingPatch = null
    var pendingTimer = 0

    function log(level, message, extra) {
      try {
        if (window.console && window.console[level]) window.console[level]('[dsh-codefall] ' + message, extra || '')
      } catch (e) {
        /* logging must never throw */
      }
    }

    /** Tiny helper so call sites read as "set one key". */
    function one(key, next) {
      var patch = {}
      patch[key] = next
      return patch
    }

    /* ------------------------------------------------------------------ *
     * readiness hand-off
     * ------------------------------------------------------------------ */
    /**
     * Idempotent: the renderer's own fallback (or the user skipping) may already
     * have finished the boot, in which case there is no controller left.
     */
    function signal(source) {
      if (done) return
      done = true
      var controller = window.__codefallController
      if (controller && typeof controller.ready === 'function') {
        try {
          controller.ready()
        } catch (e) {
          log('warn', 'ready() threw', e)
        }
      }
      log('debug', 'handoff via ' + source)
    }

    function ReadyProbe() {
      React.useEffect(function () {
        signal(PARENT)
      }, [])
      return null
    }

    /* ------------------------------------------------------------------ *
     * settings surface
     * ------------------------------------------------------------------ */
    function request(method, body) {
      var init = { method: method, cache: 'no-store' }
      if (body) {
        init.headers = { 'content-type': 'application/json' }
        init.body = JSON.stringify(body)
      } else {
        init.headers = { accept: 'application/json' }
      }
      return window
        .fetch(API, init)
        .then(function (response) {
          return response && response.ok ? response.json() : null
        })
        .then(function (payload) {
          return payload && payload.ok && payload.value ? payload.value : null
        })
        .catch(function () {
          return null
        })
    }

    /* ------------------------------------------------------------------ *
     * green theme — mechanism A: the hue is a live setting
     * ------------------------------------------------------------------
     * What ships here is the RAW SOURCE COLOURS of the blue brand ramps, not a
     * finished green. The remap is pure arithmetic — keep lightness, set the hue,
     * clamp saturation into the rain's band, preserve alpha — so a hue change
     * costs one re-registration of the override layer instead of a rebuild.
     *
     * Lightness is the part that must not move: every contrast relationship in
     * the design system rests on it, which is what makes a hue swap safe rather
     * than a redesign.
     *
     * Regenerate the table with: node tools/green-map.mjs --emit
     * This arithmetic is pinned to that generator by tools/fixtures/green-145.json
     * (same input, same hue, byte-identical output).
     */
    /* --- BEGIN GENERATED: source colours to remap (tools/green-map.mjs --emit) --- */
    var SOURCE_TOKENS = {
    '--dsw-alias-brand-primary-new-colorprimary-new-color': { light: '#4176e6', dark: '#5686fe' },
    '--dsw-alias-interactive-bg-active': { light: '#2631481a', dark: '#ffffff24' },
    '--dsw-alias-interactive-bg-hover': { light: '#2631480f', dark: '#ffffff14' },
    '--dsw-alias-interactive-bg-hover-accent': { light: '#26314824', dark: '#ffffff3d' },
    '--dsw-static-blue-100': { light: '#dbeafe', dark: '#dbeafe' },
    '--dsw-static-blue-300': { light: '#93c5fd', dark: '#93c5fd' },
    '--dsw-static-blue-400': { light: '#60a5fa', dark: '#60a5fa' },
    '--dsw-static-blue-450': { light: '#4d93f8', dark: '#4d93f8' },
    '--dsw-static-blue-50': { light: '#eff6ff', dark: '#eff6ff' },
    '--dsw-static-blue-500': { light: '#3b82f6', dark: '#3b82f6' },
    '--dsw-static-blue-50p': { light: '#eaf3ff', dark: '#eaf3ff' },
    '--dsw-static-blue-600': { light: '#2563eb', dark: '#2563eb' },
    '--dsw-static-blue-75': { light: '#e5f0ff', dark: '#e5f0ff' },
    '--dsw-static-blue-800': { light: '#1e40af', dark: '#1e40af' },
    '--dsw-static-blue-900': { light: '#0e3074', dark: '#0e3074' },
    '--dsw-static-blue-950': { light: '#172554', dark: '#172554' },
    '--dsw-static-deepseek-100': { light: '#e4edfd', dark: '#e4edfd' },
    '--dsw-static-deepseek-200': { light: '#d3e2ff', dark: '#d3e2ff' },
    '--dsw-static-deepseek-300': { light: '#b7c8fe', dark: '#b7c8fe' },
    '--dsw-static-deepseek-400': { light: '#7aaaff', dark: '#7aaaff' },
    '--dsw-static-deepseek-450': { light: '#5686fe', dark: '#5686fe' },
    '--dsw-static-deepseek-50': { light: '#edf3fe', dark: '#edf3fe' },
    '--dsw-static-deepseek-500': { light: '#4176e6', dark: '#4176e6' },
    '--dsw-static-deepseek-600': { light: '#4868b2', dark: '#4868b2' },
    '--dsw-static-deepseek-700-delete': { light: '#2f4c8f', dark: '#2f4c8f' },
    '--dsw-static-deepseek-800': { light: '#34415b', dark: '#34415b' },
    '--dsw-static-deepseek-900': { light: '#283142', dark: '#283142' },
    '--shiki-token-constant': { light: '#1c7ed6', dark: '#4dabf7' },
    '--shiki-token-link': { light: '#1971c2', dark: '#74c0fc' }
    }
    /* --- END GENERATED: source colours --- */

    /** Source identity; re-registering replaces the layer instead of stacking. */
    var THEME_SOURCE = 'dsh-codefall:green'
    var HUE_DEFAULT = 145
    var HUE_MIN = 110
    var HUE_MAX = 175
    /** Named stops. 145 is the digital rain's own green (#22c55e family). */
    var HUE_PRESETS = [
      { hue: 145, label: '雨绿' },
      { hue: 120, label: '经典' },
      { hue: 165, label: '青碧' }
    ]
    /** Below this saturation a colour is ink, not accent — leave it alone. */
    var NEUTRAL_SAT = 8
    /** Above this the source is an accent and its saturation gets clamped. */
    var ACCENT_SAT = 0.5
    var SAT_MIN = 0.55
    var SAT_MAX = 0.8

    function hexToRgb(value) {
      var v = String(value).trim().toLowerCase()
      var m = /^#([\da-f]{3,8})$/u.exec(v)
      if (m) {
        var h = m[1]
        if (h.length === 3 || h.length === 4) {
          h =
            h.charAt(0) + h.charAt(0) + h.charAt(1) + h.charAt(1) + h.charAt(2) + h.charAt(2) +
            (h.length === 4 ? h.charAt(3) + h.charAt(3) : '')
        }
        return {
          r: parseInt(h.slice(0, 2), 16),
          g: parseInt(h.slice(2, 4), 16),
          b: parseInt(h.slice(4, 6), 16),
          a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1
        }
      }
      m = /^rgba?\(([^)]+)\)$/u.exec(v)
      if (!m) return null
      var parts = m[1].split(/[,\s/]+/u).filter(Boolean)
      if (parts.length < 3) return null
      return {
        r: Number(parts[0]),
        g: Number(parts[1]),
        b: Number(parts[2]),
        a: parts.length > 3 ? Number(parts[3]) : 1
      }
    }

    function rgbToHsl(rgb) {
      var r = rgb.r / 255
      var g = rgb.g / 255
      var b = rgb.b / 255
      var max = Math.max(r, g, b)
      var min = Math.min(r, g, b)
      var l = (max + min) / 2
      var d = max - min
      var s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
      var h = 0
      if (d !== 0) {
        if (max === r) h = 60 * (((g - b) / d) % 6)
        else if (max === g) h = 60 * ((b - r) / d + 2)
        else h = 60 * ((r - g) / d + 4)
      }
      return { h: h < 0 ? h + 360 : h, s: s, l: l }
    }

    function byte2hex(v) {
      var n = Math.round(v * 255).toString(16)
      return n.length < 2 ? '0' + n : n
    }

    function hslToHex(h, s, l, alpha) {
      var c = (1 - Math.abs(2 * l - 1)) * s
      var x = c * (1 - Math.abs(((h / 60) % 2) - 1))
      var m = l - c / 2
      var seg = [
        [c, x, 0],
        [x, c, 0],
        [0, c, x],
        [0, x, c],
        [x, 0, c],
        [c, 0, x]
      ][Math.floor((((h % 360) + 360) % 360) / 60) % 6]
      var hex = '#' + byte2hex(seg[0] + m) + byte2hex(seg[1] + m) + byte2hex(seg[2] + m)
      if (alpha === undefined || alpha >= 1) return hex
      return hex + byte2hex(alpha)
    }

    /**
     * Blue accent -> green at `hue`. Anything that is not a saturated blue comes
     * back untouched, which is how the neutral ink, the amber, the red and the
     * semantic state colours stay exactly as shipped.
     */
    function remapSource(value, hue) {
      var rgb = hexToRgb(value)
      if (!rgb) return value
      var hsl = rgbToHsl(rgb)
      if (!(hsl.h >= 175 && hsl.h < 265) || hsl.s * 100 < NEUTRAL_SAT) return value
      var s = hsl.s < ACCENT_SAT ? hsl.s : Math.min(SAT_MAX, Math.max(SAT_MIN, hsl.s))
      return hslToHex(hue, s, hsl.l, rgb.a)
    }

    /** The override layer for one hue: every value a `{ light, dark }` pair. */
    function buildTokens(hue) {
      var out = {}
      for (var name in SOURCE_TOKENS) {
        if (!Object.prototype.hasOwnProperty.call(SOURCE_TOKENS, name)) continue
        var pair = SOURCE_TOKENS[name]
        out[name] = { light: remapSource(pair.light, hue), dark: remapSource(pair.dark, hue) }
      }
      return out
    }

    function clampHue(value) {
      var n = Math.round(Number(value))
      if (!isFinite(n)) return HUE_DEFAULT
      return Math.min(HUE_MAX, Math.max(HUE_MIN, n))
    }

    /* ------------------------------------------------------------------ *
     * green theme layer
     * ------------------------------------------------------------------ */
    /**
     * `ctx.theme` is a BROWSER-side service (the theme runtime and the token
     * stylesheets live in ui-theme's client bundle), so the override has to be
     * registered from this half.
     *
     * It is only ever touched through a context that DECLARES the service. DSH's
     * guard rejects an undeclared property read outright —
     *   service "theme" is not injected. Declare it: inject: ['theme', …]
     * — and that rejection is fatal to plugin activation. Going through
     * `ctx.inject(['theme'], …)` declares it without making the boot animation
     * depend on the theme provider being present.
     */
    var themeService = null
    var themeDispose = null
    var themeApplied = false
    var themeHue = HUE_DEFAULT

    function themeOff() {
      if (themeDispose !== null) {
        try {
          themeDispose()
        } catch (e) {
          /* the layer may already be gone if another source re-overrode it */
        }
        themeDispose = null
      }
      themeApplied = false
      return false
    }

    /**
     * Install, re-install for a new hue, or remove the layer.
     * A rejected override is contained: the app keeps its own colours rather
     * than the plugin failing to activate.
     */
    function syncTheme(on, hue) {
      if (!themeService) return false
      var next = hue === undefined ? themeHue : clampHue(hue)
      var hueChanged = next !== themeHue
      themeHue = next
      if (on !== true) return themeOff()
      if (themeApplied && !hueChanged) return true
      themeOff()
      try {
        themeDispose = themeService.overrideTokens(THEME_SOURCE, buildTokens(themeHue))
        themeApplied = true
      } catch (e) {
        themeDispose = null
        themeApplied = false
        log('warn', 'the green theme override was rejected', e)
      }
      return themeApplied
    }

    /**
     * The settings are read once at activation. They cannot come from the boot
     * snapshot: the boot script runs before any plugin code, and the overlay it
     * puts up covers this window anyway.
     */
    function loadThemeSetting() {
      if (!themeService) return
      request('GET').then(function (next) {
        if (next) syncTheme(next.theme === true, next.greenHue)
      })
    }

    var S = {
      group: { display: 'flex', flexDirection: 'column', gap: '2px', padding: '6px 0' },
      intro: {
        fontSize: '13px',
        lineHeight: '20px',
        paddingBottom: '8px',
        color: 'var(--dsw-alias-label-secondary)'
      },
      row: { display: 'flex', alignItems: 'center', gap: '10px', padding: '5px 0' },
      label: { flex: '0 0 76px', fontSize: '14px', color: 'var(--dsw-alias-label-primary)' },
      seg: { display: 'inline-flex', gap: '6px', flexWrap: 'wrap' },
      range: { width: '150px', accentColor: 'var(--dsw-alias-state-business-primary)' },
      readout: { fontSize: '12px', minWidth: '46px', color: 'var(--dsw-alias-label-tertiary)' },
      note: { fontSize: '12px', lineHeight: '18px', paddingTop: '4px', color: 'var(--dsw-alias-label-tertiary)' }
    }

    function optionStyle(active) {
      return {
        padding: '4px 11px',
        fontSize: '13px',
        lineHeight: '18px',
        cursor: 'pointer',
        borderRadius: 'var(--dsw-radius-md, 8px)',
        border:
          '0.5px solid ' +
          (active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l2)'),
        background: 'transparent',
        color: active ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-label-primary)'
      }
    }

    function noteFor(status) {
      if (status === 'error') return '读取或保存失败；可直接编辑 $DSH_HOME/codefall.json'
      if (status === 'saving') return '保存中…'
      if (status === 'saved') return '已保存 · 桌面端下次启动生效，Web 版刷新生效'
      return '桌面端下次启动生效，Web 版刷新生效'
    }

    /**
     * One component, two placements. In our own section the navigation already
     * names it; only the fallback row needs its own leading label.
     */
    function makeSettings(placement) {
      var asRow = placement === 'row'
      return function CodefallSettings() {
        var valueState = React.useState(null)
        var value = valueState[0]
        var setValue = valueState[1]
        var statusState = React.useState('loading')
        var status = statusState[0]
        var setStatus = statusState[1]

        React.useEffect(function () {
          var alive = true
          request('GET').then(function (next) {
            if (!alive) return
            if (next) {
              setValue(next)
              setStatus('ready')
            } else {
              setStatus('error')
            }
          })
          return function () {
            alive = false
            // Do not lose a debounced write when Settings closes.
            if (pendingTimer) {
              clearTimeout(pendingTimer)
              pendingTimer = 0
            }
            if (pendingPatch) {
              var patch = pendingPatch
              pendingPatch = null
              request('POST', { patch: patch })
            }
          }
        }, [])

        /**
         * Optimistic local update, then one write for the whole burst.
         *
         * A slider drag must not post per pixel, but a discrete choice must not
         * be swallowed into a later debounce either — so an immediate save
         * flushes synchronously, taking any pending drag with it.
         */
        function flush() {
          if (pendingTimer) {
            clearTimeout(pendingTimer)
            pendingTimer = 0
          }
          var patch = pendingPatch
          pendingPatch = null
          if (!patch) return
          request('POST', { patch: patch }).then(function (next) {
            if (next) {
              setValue(next)
              setStatus('saved')
              // Keep the live layer in step with what was actually stored, and
              // land a theme toggle immediately rather than at the next launch.
              syncTheme(next.theme === true, next.greenHue)
            } else {
              setStatus('error')
            }
          })
        }

        /**
         * @param hue when given, the override layer is re-registered with it right
         *   away — before the debounced write lands. That immediacy is the whole
         *   point of mechanism A: the app itself is the preview.
         */
        function save(patch, immediate, hue) {
          setValue(function (prev) {
            return Object.assign({}, prev || {}, patch)
          })
          setStatus('saving')
          if (hue !== undefined) {
            var current = value || {}
            syncTheme(current.theme !== false, hue)
          }
          pendingPatch = Object.assign({}, pendingPatch || {}, patch)
          if (immediate) {
            flush()
            return
          }
          if (pendingTimer) clearTimeout(pendingTimer)
          pendingTimer = setTimeout(flush, 220)
        }

        /** Hue slider plus the named stops; the slider applies as it is dragged. */
        function hueRow(current) {
          var hue = clampHue(current.greenHue === undefined ? HUE_DEFAULT : current.greenHue)
          return h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, '绿色色调'),
            h('input', {
              type: 'range',
              min: HUE_MIN,
              max: HUE_MAX,
              step: 1,
              value: hue,
              style: S.range,
              'aria-label': '绿色色调',
              onChange: function (event) {
                var next = clampHue(event.target.value)
                save(one('greenHue', next), false, next)
              }
            }),
            h('span', { style: S.readout }, hue + '°'),
            h(
              'div',
              { style: S.seg },
              HUE_PRESETS.map(function (preset) {
                return h(
                  'button',
                  {
                    key: preset.hue,
                    type: 'button',
                    style: optionStyle(hue === preset.hue),
                    'aria-pressed': hue === preset.hue,
                    onClick: function () {
                      save(one('greenHue', preset.hue), true, preset.hue)
                    }
                  },
                  preset.label
                )
              })
            )
          )
        }

        function segRow(label, options, activeId, patchOf) {
          return h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, label),
            h(
              'div',
              { style: S.seg },
              options.map(function (option) {
                return h(
                  'button',
                  {
                    key: option.id,
                    type: 'button',
                    style: optionStyle(activeId === option.id),
                    'aria-pressed': activeId === option.id,
                    onClick: function () {
                      save(patchOf(option), true)
                    }
                  },
                  option.label
                )
              })
            )
          )
        }

        function rangeRow(label, key, min, max, step, format) {
          var current = value ? value[key] : min
          return h(
            'div',
            { style: S.row },
            h('span', { style: S.label }, label),
            h('input', {
              type: 'range',
              min: min,
              max: max,
              step: step,
              value: current,
              style: S.range,
              'aria-label': label,
              onChange: function (event) {
                save(one(key, Number(event.target.value)), false)
              }
            }),
            h('span', { style: S.readout }, format(current))
          )
        }

        if (!value) {
          return h(
            'div',
            { style: S.group },
            asRow
              ? h(
                  'div',
                  { style: S.row },
                  h('span', { style: S.label }, '开机动画'),
                  h('span', { style: S.note }, noteFor(status))
                )
              : h('div', { style: S.note }, noteFor(status))
          )
        }

        var percent = function (v) {
          return Math.round((v || 0) * 100) + '%'
        }
        var times = function (v) {
          return '×' + Number(v || 1).toFixed(2)
        }

        return h(
          'div',
          { style: S.group },
          asRow ? null : h('div', { style: S.intro }, '开机时的绿色数字雨：无标题、无文字。'),
          segRow('结束方式', DISMISS_MODES, value.dismiss === 'ready' ? 'ready' : 'interaction', function (option) {
            return option.patch
          }),
          rangeRow('雨密度', 'density', 0.3, 1, 0.05, percent),
          rangeRow('雨速', 'speed', 0.4, 2.5, 0.05, times),
          segRow('画质', QUALITIES, value.quality, function (option) {
            return one('quality', option.id)
          }),
          segRow('明暗', APPEARANCES, value.appearance, function (option) {
            return one('appearance', option.id)
          }),
          segRow(
            '绿色主题',
            [
              { id: 'on', label: '开' },
              { id: 'off', label: '关' }
            ],
            value.theme === false ? 'off' : 'on',
            function (option) {
              return one('theme', option.id === 'on')
            }
          ),
          hueRow(value),
          h('div', { style: S.note }, noteFor(status))
        )
      }
    }

    var SettingsSection = makeSettings('section')
    var SettingsRow = makeSettings('row')

    /* ------------------------------------------------------------------ *
     * plugin
     * ------------------------------------------------------------------ */
    /**
     * Services this half reads. `theme` must stay here: the framework's guard
     * makes an undeclared service read fatal to activation, so removing it while
     * still touching `ctx.theme` breaks the app's boot rather than the theme.
     */
    var inject = ['slots', 'theme']

    function apply(ctx) {
      done = false

      // `theme` is DECLARED in this plugin's inject list, not merely read: DSH's
      // guard rejects an undeclared service property outright —
      //   service "theme" is not injected. Declare it: inject: ['theme', …]
      // — and that rejection is fatal to plugin activation. It is exactly how an
      // earlier version of this file took the whole app's web boot down.
      // Declaring it also lets cordis park this plugin if ui-theme ever goes away.
      // This is the shape the shipped third-party skin plugin uses
      // (`inject = ['slots','locale','theme']` + `ctx.theme`), which is why it is
      // preferred over a scoped ctx.inject here.
      try {
        themeService = ctx.theme && typeof ctx.theme.overrideTokens === 'function' ? ctx.theme : null
      } catch (e) {
        themeService = null
      }
      if (themeService) {
        loadThemeSetting()
        try {
          if (typeof ctx.effect === 'function') {
            ctx.effect(function () {
              return function () {
                themeOff()
                themeService = null
              }
            }, 'dsh-codefall: green theme')
          }
        } catch (e) {
          log('warn', 'could not register the theme disposal', e)
        }
      }

      // The hand-off is the critical path: keep it isolated from the settings
      // surface so a slot-registration failure cannot leave the user behind rain.
      try {
        ctx.slots.inject(PARENT, function () {
          return ctx.slots.register({ name: PARENT, id: 'dsh-codefall-ready', order: -1000 }, ReadyProbe)
        })
      } catch (e) {
        log('warn', PARENT + ' registration failed; relying on the renderer fallback', e)
      }

      function registerGeneralRow() {
        try {
          ctx.slots.inject(SETTINGS_ROW, function () {
            return ctx.slots.register({ name: SETTINGS_ROW, id: 'dsh-codefall', order: 60 }, SettingsRow)
          })
          return true
        } catch (e) {
          log('warn', SETTINGS_ROW + ' registration failed; settings stay file-only', e)
          return false
        }
      }

      try {
        ctx.slots.inject(SETTINGS_SECTION, function () {
          try {
            return ctx.slots.register(
              { name: SETTINGS_SECTION, id: 'dsh-codefall', order: 40, label: SECTION_LABEL },
              SettingsSection
            )
          } catch (e) {
            log('warn', SETTINGS_SECTION + ' registration failed; falling back to the 通用设置 row', e)
            registerGeneralRow()
            return undefined
          }
        })
      } catch (e) {
        log('warn', SETTINGS_SECTION + ' inject failed; falling back to the 通用设置 row', e)
        registerGeneralRow()
      }

      log('debug', 'client half active')
    }

    exports.name = 'dsh-codefall'
    exports.apply = apply
    exports.inject = inject
    exports.makeSettings = makeSettings
    exports.SETTINGS_SECTION = SETTINGS_SECTION
    exports.SETTINGS_ROW = SETTINGS_ROW
    exports.SECTION_LABEL = SECTION_LABEL
    exports.THEME_SOURCE = THEME_SOURCE
    exports.HUE_DEFAULT = HUE_DEFAULT
    exports.HUE_MIN = HUE_MIN
    exports.HUE_MAX = HUE_MAX
    exports.HUE_PRESETS = HUE_PRESETS

    window.__codefallClient = {
      version: version,
      state: function () {
        return {
          version: version,
          handedOff: done,
          controller: !!window.__codefallController,
          themeApplied: themeApplied,
          themeService: !!themeService,
          themeHue: themeHue,
          sourceTokens: Object.keys(SOURCE_TOKENS).length
        }
      },
      signal: signal,
      request: request,
      // Exposed for the offline test: the arithmetic here must reproduce the
      // generator's golden fixture byte for byte.
      buildTokens: buildTokens,
      remapSource: remapSource,
      clampHue: clampHue,
      syncTheme: syncTheme,
      sourceTokens: SOURCE_TOKENS,
      THEME_SOURCE: THEME_SOURCE,
      HUE_DEFAULT: HUE_DEFAULT,
      HUE_MIN: HUE_MIN,
      HUE_MAX: HUE_MAX,
      HUE_PRESETS: HUE_PRESETS
    }

    return module.exports
  }
})
