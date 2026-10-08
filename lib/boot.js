/*!
 * dsh-codefall — boot overlay controller
 *
 * The DOM half of the boot animation. It owns the overlay element, the
 * animation loop, the skip gesture, the watchdog and the hand-off, and it
 * drives lib/renderer.js (which owns nothing but pixels).
 *
 * Same constraints as the renderer: a classic script with no imports, so the
 * host half can inline renderer.js + boot.js into the first-frame <script>.
 *
 * Contract with the rest of the plugin:
 *   root.Codefall.styleText({appearance})  -> head <style> text (anti-flash)
 *   root.Codefall.boot({...})              -> controller, idempotent
 *   controller.ready()   app is interactive -> drain, fade, remove
 *   controller.skip()    user dismissed it  -> fade, remove
 *   controller.fail(why) never block the host -> fast fade, remove
 *   controller.destroy() hard teardown (unload)
 */
;(function (root) {
  'use strict'

  var VERSION = '0.1.0'
  var ID = 'codefall-boot'
  // The watchdog only covers "the host never reported ready". A cold desktop
  // start can take several seconds, so this is deliberately generous; it is not
  // a display cap — waiting for the user is a legitimate state.
  var DEFAULT_TIMEOUT_MS = 15000
  var MAX_TIMEOUT_MS = 60000
  var FADE_MS = 120 // visual exit after the trails have faded
  var DRAIN_MS = 180 // trail fade-out after ready(); 180 + 120 = 300ms budget
  var MAX_DRAIN_MS = 600 // backstop if the loop stalls
  var MAX_READY_MS = 300 // README budget for the hand-off

  // Interaction-to-dismiss tuning.
  var INTERACTION_ARM_MS = 350 // ignore mousemove this soon after start: the
  // window can open underneath the pointer, which would otherwise dismiss instantly.
  var INTERACTION_MOVE_PX = 14 // cumulative movement that counts as intent
  var INTERACTION_GRACE_MS = 2500 // after an early interaction, keep waiting for
  // the host this much longer; the user asked to get in, so do not hold them.

  var DARK_BG = '#151517' // must match the host's own dark boot canvas
  var LIGHT_BG = '#ffffff' // ...and its light one

  function bgFor(appearance) {
    return appearance === 'light' ? LIGHT_BG : DARK_BG
  }

  /**
   * Resolve 'auto' the honest way.
   *
   * The host's own theme bootstrap runs as a body script at the same anchor as
   * ours and resolves the *durable* preference onto the document before we run
   * (it also stamps `data-ds-theme-source`). Reading that beats asking the OS:
   * a user whose stored preference is dark on a light desktop must still get the
   * dark rain. Only when no theme bootstrap ran do we fall back to the media
   * query it would itself have used.
   */
  function autoAppearance(doc, root) {
    try {
      var booted = doc.documentElement && doc.documentElement.dataset && doc.documentElement.dataset.dsThemeSource
      if (booted && doc.body) return doc.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light'
      if (root.matchMedia && root.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark'
      if (root.matchMedia && root.matchMedia('(prefers-color-scheme: light)').matches) return 'light'
    } catch (e) {
      /* fall through to the product default */
    }
    return 'dark' // the harness is dark-first
  }

  function overlayRules(bg) {
    return (
      '#' + ID + '{position:fixed;inset:0;z-index:2147483000;background:' + bg +
      ';opacity:1;transition:opacity ' + FADE_MS + 'ms linear;touch-action:none;' +
      'contain:layout paint;will-change:opacity}' +
      '#' + ID + '.codefall-out{opacity:0;pointer-events:none}' +
      '#' + ID + '>canvas{display:block;width:100%;height:100%}'
    )
  }

  /**
   * The anti-flash stylesheet. Deliberately does NOT touch html/body
   * background: the host's own boot theme already paints the canvas before any
   * script runs, and re-declaring it here would fight that. Only the overlay
   * is styled, and it is styled by id so it wins over body-level rules.
   */
  function styleText(options) {
    var appearance = (options && options.appearance) || 'auto'
    if (appearance === 'auto') {
      // Mirrors the host's own `system` handling so the pre-JS instant already
      // carries a plausible canvas colour in either scheme.
      return (
        overlayRules(DARK_BG) +
        '@media (prefers-color-scheme:light){' + overlayRules(LIGHT_BG) + '}' +
        '@media (prefers-reduced-motion:reduce){#' + ID + '{transition:none}}'
      )
    }
    return overlayRules(bgFor(appearance)) + '@media (prefers-reduced-motion:reduce){#' + ID + '{transition:none}}'
  }

  function now() {
    return root.performance && root.performance.now ? root.performance.now() : Date.now()
  }

  function boot(options) {
    var o = options || {}
    var doc = root.document

    // Idempotent: a second boot (hot reload, duplicate injection) attaches to
    // the live controller instead of stacking a second overlay.
    if (root.__codefallController) return root.__codefallController
    if (!doc || !root.CodefallRenderer) return null

    var appearance = o.appearance === 'light' || o.appearance === 'dark' ? o.appearance : autoAppearance(doc, root)
    var start = now()
    var phase = 'playing' // playing -> draining -> closing -> done
    var reason = null
    var paused = false
    var frames = 0
    var fps = 0
    var fpsAt = start
    var raf = 0
    var lastFrame = 0
    var fadeTimer = 0
    var drainTimer = 0
    var watchdog = 0
    var resizeTimer = 0
    var observer = null
    var heuristicTimer = 0
    var beaconed = false
    var HEURISTIC_MIN_MS = 500

    // Dismissal state. `dismiss: 'interaction'` keeps the rain up until the user
    // does something, which is the whole point of a boot screen — but it must
    // never become a trap, hence hostReady/interacted and the grace timer below.
    // NOTE: readiness is a BOOLEAN, not the timestamp: `now()` is 0 at t=0, so
    // testing the timestamp for truthiness silently misreads a ready-at-zero host.
    var hostReady = false
    var interacted = false
    var readyAt = 0
    var interactedAt = 0
    var moveAccum = 0
    var lastX = null
    var lastY = null
    var minTimer = 0
    var graceTimer = 0
    var idleStopped = false

    // The overlay styles itself inline and depends on no stylesheet row: an
    // earlier version relied on a separate <style> injection, and when that was
    // dropped the overlay silently lost position:fixed (and with it its size),
    // rendering a 155px strip in normal document flow.
    var mount = o.host && o.host.nodeType === 1 ? o.host : doc.body || doc.documentElement
    var fixed = mount === doc.body || mount === doc.documentElement

    var wrap = doc.createElement('div')
    wrap.id = ID
    wrap.setAttribute('aria-hidden', 'true')
    var ws = wrap.style
    ws.position = fixed ? 'fixed' : 'absolute'
    if (fixed) {
      ws.top = '0'
      ws.right = '0'
      ws.bottom = '0'
      ws.left = '0'
      ws.zIndex = '2147483000'
    } else {
      ws.top = '0'
      ws.left = '0'
      ws.width = '100%'
      ws.height = '100%'
    }
    ws.background = bgFor(appearance)
    ws.opacity = '1'
    ws.transition = 'opacity ' + FADE_MS + 'ms linear'
    ws.touchAction = 'none'
    ws.contain = 'layout paint'
    ws.willChange = 'opacity'

    var canvas = doc.createElement('canvas')
    canvas.style.display = 'block'
    canvas.style.width = '100%'
    canvas.style.height = '100%'
    wrap.appendChild(canvas)
    mount.appendChild(wrap)

    var renderer = root.CodefallRenderer.create(canvas, {
      appearance: appearance,
      quality: o.quality || 'standard',
      seed: o.seed || 0,
      glyphs: o.glyphs || 'code',
      charset: o.charset || '',
      density: o.density == null ? undefined : o.density,
      ghostShare: o.ghostShare == null ? undefined : o.ghostShare,
      speed: o.speed == null ? undefined : o.speed,
      fontSize: o.fontSize || undefined,
      fontFamily: o.fontFamily || undefined,
      columnSpacing: o.columnSpacing || undefined,
      titleText: o.titleText == null ? undefined : o.titleText,
      titleY: o.titleY == null ? undefined : o.titleY,
      statusText: o.statusText || ''
    })

    var reduced
    if (o.reducedMotion === true) reduced = true
    else if (o.reducedMotion === false) reduced = false
    else {
      try {
        reduced = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches)
      } catch (e) {
        reduced = false
      }
    }

    function emit(name, payload) {
      if (typeof o.onEvent === 'function') {
        try {
          o.onEvent(name, payload)
        } catch (e) {
          /* an observer must never break the boot path */
        }
      }
    }

    /**
     * Opt-in page-side self-check: report back to the route that injected us.
     * Failure is ignored — diagnostics must never affect the boot.
     */
    function beacon(payload) {
      if (!o.beacon) return
      try {
        if (typeof root.fetch !== 'function') return
        root
          .fetch('/codefall/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ beacon: payload }),
            keepalive: true
          })
          .catch(function () {})
      } catch (e) {
        /* ignore */
      }
    }

    /**
     * One-shot diagnosis of the caption area, reported through the beacon.
     *
     * It answers the question code alone cannot: at the pixel where the caption
     * buttons sit, what is the topmost element IN THE DOCUMENT? If it is this
     * overlay, then nothing page-level is above us and the buttons must be a
     * native/Chromium layer (only a color change can touch them). If something
     * else is on top, the buttons are page elements after all and can be covered.
     */
    function captionReport() {
      var report = {
        probeFound: !!findCaptionProbe(),
        applied: captionProbe ? captionProbe.style.getPropertyValue('color') : '',
        fill: captionProbe ? captionProbe.style.getPropertyValue('background-color') : '',
        rainBg: bgFor(appearance),
        wco: !!(root.navigator && root.navigator.windowControlsOverlay),
        points: []
      }
      try {
        var probe = findCaptionProbe()
        if (probe) report.probeCss = String(probe.style.cssText || '').slice(0, 120)
      } catch (e) {
        /* ignore */
      }
      var w = root.innerWidth || 0
      var candidates = [
        ['close', w - 30, 20],
        ['max', w - 90, 20],
        ['min', w - 150, 20],
        ['mid', Math.round(w / 2), 20],
        ['left', 8, 8]
      ]
      for (var i = 0; i < candidates.length; i++) {
        var x = candidates[i][1]
        var y = candidates[i][2]
        var stack = []
        try {
          var list =
            typeof doc.elementsFromPoint === 'function'
              ? doc.elementsFromPoint(x, y)
              : doc.elementFromPoint
                ? [doc.elementFromPoint(x, y)]
                : []
          for (var k = 0; k < list.length && k < 5; k++) {
            var el = list[k]
            if (!el) continue
            stack.push(
              String(el.tagName || '?').toLowerCase() +
                (el.id ? '#' + el.id : '') +
                (typeof el.className === 'string' && el.className ? '.' + el.className.split(/\s+/)[0] : '')
            )
          }
        } catch (e) {
          stack.push('error')
        }
        report.points.push({ at: candidates[i][0], stack: stack })
      }
      return report
    }

    function sizeNow() {
      // A fixed overlay IS the viewport, by definition. Measuring the element
      // instead ties the canvas to whatever its CSS box happens to be, which is
      // how a missing positioning rule became a 155px-tall rain strip.
      if (!fixed) {
        return { w: mount.clientWidth || 1, h: mount.clientHeight || 1, dpr: root.devicePixelRatio || 1 }
      }
      return {
        w: root.innerWidth || wrap.clientWidth || 1,
        h: root.innerHeight || wrap.clientHeight || 1,
        dpr: root.devicePixelRatio || 1
      }
    }

    function measure() {
      var s = sizeNow()
      renderer.resize(s.w, s.h, s.dpr)
    }

    /* ------------------------------------------------------------------ *
     * lifecycle
     * ------------------------------------------------------------------ */
    function clearTimers() {
      if (raf) root.cancelAnimationFrame(raf)
      if (fadeTimer) root.clearTimeout(fadeTimer)
      if (drainTimer) root.clearTimeout(drainTimer)
      if (watchdog) root.clearTimeout(watchdog)
      if (resizeTimer) root.clearTimeout(resizeTimer)
      if (minTimer) root.clearTimeout(minTimer)
      if (graceTimer) root.clearTimeout(graceTimer)
      if (heuristicTimer) root.clearTimeout(heuristicTimer)
      raf = fadeTimer = drainTimer = watchdog = resizeTimer = minTimer = graceTimer = heuristicTimer = 0
    }

    function finish(why) {
      if (phase === 'done') return
      phase = 'done'
      clearTimers()
      removeListeners()
      stopHeuristic()
      // Always, whatever the exit path: the caption glyphs must never be left
      // invisible by an interrupted boot.
      restoreCaption()
      try {
        renderer.destroy()
      } catch (e) {
        /* teardown must be safe to call twice */
      }
      if (wrap.parentNode) wrap.parentNode.removeChild(wrap)
      if (root.__codefallController === ctl) delete root.__codefallController
      emit('finished', { reason: why || reason, elapsed: now() - start })
    }

    /**
     * Last-resort readiness guess.
     *
     * The accurate hand-off is the client half calling ready() when the client
     * tree settles. This observer exists only so that a composition where the
     * client half never loads (or its slot never mounts) still releases the
     * overlay on its own. The 500ms floor keeps it from firing on the host's own
     * loading placeholder, and the element threshold keeps it from firing on a stub.
     *
     * NOTE: the root element may not exist yet. On the HTTP path this script is
     * injected immediately after the opening <body> tag, so `#root` is still
     * unparsed; attaching later (or not at all) silently disabled the fallback.
     */
    function startHeuristic() {
      if (o.readyHeuristic === false) return
      if (!root.MutationObserver) return
      var threshold = o.readyElementThreshold || 80
      var attempts = 0
      var check = function (target) {
        if (phase !== 'playing') return
        if (now() - start < HEURISTIC_MIN_MS) return
        if (target.querySelectorAll('*').length < threshold) return
        readyFrom('dom-growth')
      }
      var attach = function () {
        heuristicTimer = 0
        if (phase !== 'playing') return
        var target = doc.getElementById('root')
        if (!target) {
          // ~5s of looking; past that the not-ready watchdog owns the outcome.
          if (++attempts > 50) return
          heuristicTimer = root.setTimeout(attach, 100)
          return
        }
        observer = new root.MutationObserver(function () {
          check(target)
        })
        observer.observe(target, { childList: true, subtree: true })
        check(target)
      }
      attach()
    }

    function stopHeuristic() {
      if (heuristicTimer) {
        root.clearTimeout(heuristicTimer)
        heuristicTimer = 0
      }
      if (observer) {
        try {
          observer.disconnect()
        } catch (e) {
          /* already gone */
        }
        observer = null
      }
    }

    function fadeOutThenFinish(why) {
      if (phase === 'done' || phase === 'closing') return
      phase = 'closing'
      reason = why || reason
      if (raf) {
        root.cancelAnimationFrame(raf)
        raf = 0
      }
      wrap.className = 'codefall-out'
      wrap.style.opacity = '0' // belt and braces: some engines ignore the class
      wrap.style.pointerEvents = 'none'
      fadeTimer = root.setTimeout(function () {
        finish(why)
      }, FADE_MS + 40)
      emit('closing', { reason: reason })
    }

    function onDrained() {
      fadeOutThenFinish('drained')
    }

    /**
     * Runtime policy refresh (the "D" half of settings).
     *
     * The injected snapshot is captured when the host starts, so on the desktop
     * it goes stale the moment a setting changes. Visual parameters must stay
     * from the snapshot — re-reading them mid-boot would visibly change the rain
     * — but the POLICY parameters have no such constraint, so they are refreshed
     * from the plugin's own route once the first frame is on screen. The first
     * frame never waits for this request.
     */
    var policyPulled = false
    /** Tier 0 of the settings: cheap to apply at any moment. */
    var POLICY_KEYS = [
      'dismiss',
      'minDisplayMs',
      'hintReady',
      'hintWaitingAcknowledged',
      'idleSlowMs',
      'idleStaticMs'
    ]
    /**
     * Tier A/B of the renderer's live reconfiguration — instant retunes and
     * atlas-only rebuilds, neither of which restarts the rain. The grid-moving
     * parameters (fontSize, spacing) are deliberately NOT here: re-seeding the
     * scene mid-boot would be visible, so they stay snapshot-only.
     */
    var VISUAL_KEYS = {
      density: function (v) {
        return typeof v === 'number' && isFinite(v) && v >= 0.05 && v <= 1
      },
      speed: function (v) {
        return typeof v === 'number' && isFinite(v) && v >= 0.1 && v <= 6
      },
      ghostShare: function (v) {
        return typeof v === 'number' && isFinite(v) && v >= 0 && v <= 0.6
      },
      quality: function (v) {
        return v === 'high' || v === 'standard' || v === 'economy'
      },
      glyphs: function (v) {
        return v === 'code' || v === 'katakana' || v === 'mixed'
      },
      appearance: function (v) {
        return v === 'auto' || v === 'dark' || v === 'light'
      }
    }

    function pullPolicy() {
      if (policyPulled) return
      policyPulled = true
      if (!o.configUrl || typeof root.fetch !== 'function') return
      try {
        root
          .fetch(o.configUrl, { headers: { accept: 'application/json' }, cache: 'no-store' })
          .then(function (response) {
            return response && response.ok ? response.json() : null
          })
          .then(function (payload) {
            if (!payload || !payload.value || typeof payload.value !== 'object') return
            applyConfig(payload.value)
          })
          .catch(function () {
            /* a failed refresh simply leaves the snapshot in charge */
          })
      } catch (e) {
        /* ignore */
      }
    }

    function applyConfig(value) {
      if (phase !== 'playing') return
      var changed = false
      var visual = null
      var i
      for (i = 0; i < POLICY_KEYS.length; i++) {
        var pkey = POLICY_KEYS[i]
        var pnext = value[pkey]
        if (pnext === undefined) continue
        if (pkey === 'dismiss') {
          if (pnext !== 'interaction' && pnext !== 'ready') continue
        } else if (typeof pnext === 'number') {
          if (!isFinite(pnext) || pnext < 0) continue
        } else if (typeof pnext !== 'string') {
          continue
        }
        if (o[pkey] !== pnext) {
          o[pkey] = pnext
          changed = true
        }
      }
      for (var vkey in VISUAL_KEYS) {
        var vnext = value[vkey]
        if (vnext === undefined || !VISUAL_KEYS[vkey](vnext)) continue
        if (vkey === 'appearance') {
          var resolved = vnext === 'auto' ? autoAppearance(doc, root) : vnext
          if (resolved === appearance) continue
          appearance = resolved
          wrap.style.background = bgFor(appearance)
          if (!visual) visual = {}
          visual.appearance = resolved
          changed = true
          refreshCaptionColor()
          continue
        }
        if (o[vkey] === vnext) continue
        o[vkey] = vnext
        if (!visual) visual = {}
        visual[vkey] = vnext
        changed = true
      }
      if (visual) {
        try {
          renderer.setOptions(visual)
        } catch (e) {
          emit('config-error', { message: String((e && e.message) || e) })
        }
      }
      if (!changed) return
      emit('config', { dismiss: o.dismiss, minDisplayMs: o.minDisplayMs, visual: !!visual })
      refreshHint()
      // A raised idle ceiling, or a policy that is already satisfied, can both
      // take effect immediately.
      if (idleStopped && currentTargetFps() > 0) {
        idleStopped = false
        if (!raf) {
          lastFrame = 0
          raf = root.requestAnimationFrame(loop)
        }
      }
      maybeRelease()
    }

    /**
     * Hide the Windows caption glyphs (minimize / maximize / close) while the
     * boot overlay is up.
     *
     * Those buttons are NOT page elements. The shell creates the window with
     * `titleBarStyle:'hidden'` + `titleBarOverlay:{height:40,...}`, so Chromium
     * draws them in the window caption, ABOVE the web contents — no z-index can
     * cover them, and the shell only ever exposes `setTitleBarOverlay({color,
     * symbolColor})`, never visibility.
     *
     * The one lever the page has is the preload's caption probe
     * (lib/preload-windows.js):
     *
     *   probe.style.cssText = "position:fixed;visibility:hidden;pointer-events:none;
     *                          background-color:var(--dsw-specific-sidebar-fill);
     *                          color:var(--dsw-alias-label-primary)"
     *
     * The preload reads those two computed colors and sends them to the shell as
     * the caption fill and the symbol color, re-sending whenever `document.body`'s
     * style attribute changes. Setting the probe's color to its own background
     * therefore paints the glyphs in the fill color: invisible, still clickable,
     * and the window stays fully operable. Restoring the probe's inline cssText
     * and nudging body.style brings them straight back.
     *
     * Windows-only and strictly best-effort: where the probe does not exist this
     * is a no-op, and the restore runs on every terminal path.
     */
    var captionProbe = null
    var captionCss = null
    var captionTimer = null
    var captionTries = 0

    /** The preload's observer watches this attribute; touch it to force a re-send. */
    function captionNudge() {
      try {
        var b = doc.body
        if (!b || !b.style || typeof b.style.setProperty !== 'function') return
        var before = b.style.getPropertyValue('--codefall-caption-nudge')
        b.style.setProperty('--codefall-caption-nudge', '1')
        b.style.removeProperty('--codefall-caption-nudge')
        if (before) b.style.setProperty('--codefall-caption-nudge', before)
      } catch (e) {
        /* ignore */
      }
    }

    /**
     * The probe is a hidden `<span>` appended to body by the preload. It is
     * identified by its own inline declarations rather than by a CSS selector, so
     * the lookup needs no selector engine and is trivially testable.
     */
    function findCaptionProbe() {
      try {
        var list = doc.body && doc.body.children
        if (!list) return null
        for (var i = 0; i < list.length; i++) {
          var el = list[i]
          if (!el || String(el.tagName).toUpperCase() !== 'SPAN') continue
          var css = (el.style && el.style.cssText) || ''
          if (css.indexOf('--dsw-specific-sidebar-fill') >= 0 && css.indexOf('visibility') >= 0) return el
        }
      } catch (e) {
        /* ignore */
      }
      return null
    }

    function hideCaption() {
      if (!o.hideWindowControls || captionProbe || phase !== 'playing') return
      var probe = findCaptionProbe()
      if (!probe) return
      try {
        // NOT the shell's own computed fill: that neutral (#1b1b1c) is visibly
        // lighter than the rain background (#151517) and shows up as a grey band
        // across the top of the boot screen. Both the caption fill AND its glyphs
        // take the rain's own background, so the strip is chromatically identical
        // to the field behind it — the icons are not merely recolored, they and
        // their backdrop disappear into the rain.
        var bg = bgFor(appearance)
        captionCss = probe.style.cssText
        captionProbe = probe
        probe.style.setProperty('background-color', bg)
        probe.style.setProperty('color', bg)
        captionNudge()
        emit('caption-hidden', { background: bg, color: bg })
      } catch (e) {
        captionProbe = null
        captionCss = null
      }
    }

    function restoreCaption() {
      if (captionTimer) {
        root.clearTimeout(captionTimer)
        captionTimer = null
      }
      if (!captionProbe) return
      try {
        if (captionCss !== null) captionProbe.style.cssText = captionCss
        captionNudge()
      } catch (e) {
        /* ignore */
      }
      captionProbe = null
      captionCss = null
      emit('caption-restored', {})
    }

    /** A theme change moves the rain background, so the hidden strip follows it. */
    function refreshCaptionColor() {
      if (!captionProbe) return
      try {
        var bg = bgFor(appearance)
        captionProbe.style.setProperty('background-color', bg)
        captionProbe.style.setProperty('color', bg)
        captionNudge()
      } catch (e) {
        /* ignore */
      }
    }

    /** The preload appends the probe on its own schedule, so retry briefly. */
    function scheduleCaptionHide() {
      if (!o.hideWindowControls || captionProbe || captionTimer || phase !== 'playing') return
      hideCaption()
      if (captionProbe || captionTries++ > 30) return
      captionTimer = root.setTimeout(function () {
        captionTimer = null
        scheduleCaptionHide()
      }, 100)
    }

    /** Swap the one line of honest status under the title. */
    function setHint(text) {
      renderer.setOptions({ statusText: text || '' })
    }

    function hintForState() {
      if (!hostReady) {
        // Not ready: never invite the user in, but do acknowledge an early
        // interaction so their click is visibly not lost.
        return interacted ? o.hintWaitingAcknowledged || o.statusText || '' : o.statusText || ''
      }
      if (o.dismiss === 'interaction' && !interacted) return o.hintReady || ''
      return o.statusText || ''
    }

    function refreshHint() {
      setHint(hintForState())
    }

    /**
     * The single release decision.
     *
     * Landing the user on a half-built UI is the failure mode to avoid, so a
     * release always requires the host to have reported ready; after that it is
     * either the configured dismiss mode or the user having asked to get in.
     */
    function maybeRelease() {
      if (phase !== 'playing') return
      if (!hostReady) return
      var elapsed = now() - start
      var floor = o.minDisplayMs || 0
      if (elapsed < floor) {
        if (!minTimer) {
          minTimer = root.setTimeout(function () {
            minTimer = 0
            maybeRelease()
          }, floor - elapsed + 10)
        }
        return
      }
      if (o.dismiss === 'interaction' && !interacted) return
      beginExit(o.dismiss === 'interaction' ? 'dismissed:interaction' : 'dismissed:ready')
    }

    function beginExit(why) {
      if (phase !== 'playing') return
      phase = 'draining'
      reason = why
      stopHeuristic()
      setHint('')
      // An idle-stopped overlay has no running loop, so restart it: the drain is
      // an animation and needs frames.
      if (idleStopped) {
        idleStopped = false
        if (!raf) {
          lastFrame = 0
          raf = root.requestAnimationFrame(loop)
        }
      }
      renderer.beginDrain(DRAIN_MS)
      emit('release', { reason: why, elapsed: Math.round(now() - start) })
      beacon({ phase: 'release', reason: why, elapsed: Math.round(now() - start), caption: captionReport() })
      drainTimer = root.setTimeout(function () {
        if (phase === 'draining') fadeOutThenFinish('drain-timeout')
      }, MAX_DRAIN_MS)
    }

    function readyFrom(source) {
      if (hostReady || phase !== 'playing') return
      hostReady = true
      readyAt = now()
      stopHeuristic()
      refreshHint()
      emit('ready', { elapsed: Math.round(readyAt - start), source: source })
      beacon({ phase: 'ready', source: source, elapsed: Math.round(readyAt - start) })
      maybeRelease()
    }

    function ready() {
      readyFrom('client')
    }

    /**
     * Register user intent. Under `dismiss: 'interaction'` this is what ends the
     * boot screen. Before the host is ready it only arms a grace timer: a
     * premature click must not dump the user onto a half-loaded app, and must
     * not leave them stuck behind the rain either.
     */
    function markInteraction(source) {
      if (interacted || phase !== 'playing') return
      interacted = true
      interactedAt = now()
      refreshHint()
      emit('interaction', { source: source, elapsed: Math.round(interactedAt - start) })
      beacon({ phase: 'interaction', source: source, elapsed: Math.round(interactedAt - start) })
      if (!hostReady) {
        graceTimer = root.setTimeout(function () {
          graceTimer = 0
          if (phase !== 'playing') return
          beginExit('interaction-before-ready')
        }, INTERACTION_GRACE_MS)
        return
      }
      maybeRelease()
    }

    function skip() {
      markInteraction('skip')
    }

    function fail(why) {
      // Never let the overlay hide a host error: fade fast and get out.
      if (phase === 'playing' || phase === 'draining') fadeOutThenFinish('fail:' + (why || 'unknown'))
    }

    /* ------------------------------------------------------------------ *
     * loop
     * ------------------------------------------------------------------ */
    /**
     * Idle power management. A splash that waits for the user can sit on screen
     * for a long time, so it must not render at full rate forever: past
     * `idleSlowMs` it drops to a slow tier, past `idleStaticMs` it stops
     * producing frames altogether and simply holds the last one. Neither affects
     * dismissal — the interaction listeners are independent of the loop.
     */
    function currentTargetFps() {
      if (phase !== 'playing') return renderer.targetFps() // a draining exit always animates
      var e = now() - start
      if (o.idleStaticMs > 0 && e >= o.idleStaticMs) return 0
      if (o.idleSlowMs > 0 && e >= o.idleSlowMs) return Math.min(12, renderer.targetFps())
      return renderer.targetFps()
    }

    function loop(ts) {
      raf = root.requestAnimationFrame(loop)
      if (paused) {
        lastFrame = ts
        return
      }
      var target = currentTargetFps()
      if (target <= 0) {
        if (raf) {
          root.cancelAnimationFrame(raf)
          raf = 0
        }
        idleStopped = true
        emit('idle-static', { elapsed: Math.round(ts - start) })
        return
      }
      var minFrameMs = 1000 / target - 1.5
      if (ts - lastFrame < minFrameMs) return
      lastFrame = ts
      renderer.frameAt(ts - start)
      if (!beaconed) {
        beaconed = true
        var st = renderer.state()
        beacon({
          phase: 'first-frame',
          appearance: st.appearance,
          cols: st.cols,
          rows: st.rows,
          drawCalls: st.drawCalls,
          elapsed: Math.round(ts - start)
        })
      }
      frames++
      if (!policyPulled) pullPolicy()
      if (ts - fpsAt >= 1000) {
        fps = Math.round((frames * 1000) / (ts - fpsAt))
        frames = 0
        fpsAt = ts
        emit('tick', { fps: fps, elapsed: ts - start })
      }
      if (phase === 'draining' && renderer.isDrained()) onDrained()
      // Frame-driven release so a satisfied dismissal does not have to wait for
      // the minDisplay timer to fire.
      if (phase === 'playing') maybeRelease()
    }

    /* ------------------------------------------------------------------ *
     * listeners
     * ------------------------------------------------------------------ */
    function onKey(e) {
      if (o.ignoreSelector && e.target && e.target.closest && e.target.closest(o.ignoreSelector)) return
      if (e.key === 'Escape' || e.key === 'Esc') markInteraction('escape')
      else markInteraction('key')
    }
    function onPointer(e) {
      // Let the surrounding UI (the preview harness, for instance) keep its
      // own controls clickable while the overlay plays.
      if (o.ignoreSelector && e.target && e.target.closest && e.target.closest(o.ignoreSelector)) return
      markInteraction('pointerdown')
    }
    function onWheel() {
      markInteraction('wheel')
    }
    /**
     * Pointer movement dismisses too, but only deliberate movement: the window
     * can open underneath the cursor, so early movement is ignored and the rest
     * must accumulate past a small threshold.
     */
    function onMouseMove(e) {
      if (interacted) return
      if (o.ignoreSelector && e.target && e.target.closest && e.target.closest(o.ignoreSelector)) return
      if (now() - start < INTERACTION_ARM_MS) return
      if (lastX === null) {
        lastX = e.clientX
        lastY = e.clientY
        return
      }
      moveAccum += Math.abs(e.clientX - lastX) + Math.abs(e.clientY - lastY)
      lastX = e.clientX
      lastY = e.clientY
      if (moveAccum >= INTERACTION_MOVE_PX) markInteraction('mousemove')
    }
    function onVisibility() {
      paused = !!doc.hidden
      emit('visibility', { hidden: paused })
    }
    function onResize() {
      if (resizeTimer) root.clearTimeout(resizeTimer)
      resizeTimer = root.setTimeout(function () {
        resizeTimer = 0
        measure()
      }, 140)
    }
    function addListeners() {
      wrap.addEventListener('pointerdown', onPointer, true)
      wrap.addEventListener('click', onPointer, true)
      wrap.addEventListener('wheel', onWheel, { passive: true })
      root.addEventListener('keydown', onKey, true)
      root.addEventListener('mousemove', onMouseMove, { passive: true })
      root.addEventListener('resize', onResize)
      doc.addEventListener('visibilitychange', onVisibility)
    }
    function removeListeners() {
      wrap.removeEventListener('pointerdown', onPointer, true)
      wrap.removeEventListener('click', onPointer, true)
      wrap.removeEventListener('wheel', onWheel)
      root.removeEventListener('keydown', onKey, true)
      root.removeEventListener('mousemove', onMouseMove)
      root.removeEventListener('resize', onResize)
      doc.removeEventListener('visibilitychange', onVisibility)
    }

    /* ------------------------------------------------------------------ *
     * go
     * ------------------------------------------------------------------ */
    // Everything after the DOM insert lives inside this guard. If any of it
    // throws, the overlay has no controller yet and would be orphaned on the
    // page with nothing able to remove it — so clean up before rethrowing.
    try {
      measure()
      refreshHint()
      if (reduced) {
        // Honour the user's system setting: no loop at all, one settled frame.
        // The interaction wait still applies — it is a dismissal rule, not motion.
        renderer.frameAt(renderer.state().titleCompleteAt + 60)
        addListeners()
        emit('reduced-motion', {})
        beacon({ phase: 'reduced-motion', elapsed: 0 })
      } else {
        addListeners()
        startHeuristic()
        lastFrame = 0
        raf = root.requestAnimationFrame(loop)
      }

      // The caption glyphs are painted above the page, so they cannot be covered:
      // repaint them in the caption fill color instead. Independently of the
      // frame loop, and a no-op wherever the probe does not exist.
      scheduleCaptionHide()
      beacon({ phase: 'caption', elapsed: Math.round(now() - start), caption: captionReport() })

      // This watchdog covers exactly one thing: the host never reported ready.
      // Once it has, waiting for the user IS the intended state, not a timeout.
      watchdog = root.setTimeout(function () {
        watchdog = 0
        if (phase === 'playing' && !hostReady) fail('host-not-ready')
      }, Math.min(o.timeoutMs || DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS))
    } catch (error) {
      try {
        if (wrap.parentNode) wrap.parentNode.removeChild(wrap)
      } catch (e) {
        /* already detached */
      }
      try {
        renderer.destroy()
      } catch (e) {
        /* nothing to release */
      }
      throw error
    }

    var ctl = {
      version: VERSION,
      ready: ready,
      skip: skip,
      /** Register interaction programmatically (used by the preview harness). */
      interact: markInteraction,
      fail: fail,
      destroy: function () {
        finish('destroyed')
      },
      reducedMotion: reduced,
      /** Truthful status only: the caller decides what is actually known. */
      setStatus: function (text) {
        o.statusText = text || ''
        refreshHint()
      },
      state: function () {
        var s = renderer.state()
        return {
          phase: phase,
          reason: reason,
          elapsed: Math.round(now() - start),
          fps: fps,
          hidden: paused,
          width: s.width,
          height: s.height,
          cols: s.cols,
          rows: s.rows,
          drawCalls: s.drawCalls,
          appearance: s.appearance,
          quality: s.quality,
          density: s.density,
          speed: s.speed,
          glyphs: s.glyphs,
          sceneRevision: s.sceneRevision,
          activeColumns: s.activeColumns,
          titleCompleteAt: Math.round(s.titleCompleteAt),
          dismiss: o.dismiss,
          minDisplayMs: o.minDisplayMs,
          hostReady: hostReady,
          interacted: interacted,
          waitingFor: !hostReady ? 'host' : o.dismiss === 'interaction' && !interacted ? 'interaction' : 'release',
          idleStopped: idleStopped,
          hint: hintForState()
        }
      }
    }

    root.__codefallController = ctl
    emit('started', ctl.state())
    return ctl
  }

  root.Codefall = {
    version: VERSION,
    OVERLAY_ID: ID,
    FADE_MS: FADE_MS,
    READY_BUDGET_MS: MAX_READY_MS,
    styleText: styleText,
    boot: boot
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
