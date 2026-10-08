/*!
 * dsh-codefall — boot renderer
 *
 * A dependency-free digital-rain renderer: characters sit on a FIXED grid and
 * what travels down each column is a BRIGHTNESS WAVE, not the glyph positions.
 * Glyphs only swap occasionally, at a low rate. This is the look of the
 * reference material, and it is also the cheap way to draw it: only the
 * currently lit cells of a column are painted, from a pre-tinted glyph atlas.
 *
 * Design constraints (see README §4, §6.4):
 *   - no imports, no network, no build step: this file is a classic script so
 *     the host half can inline it verbatim into the first-frame <script>.
 *   - no DOM globals: the canvas is injected, so the same code runs headlessly
 *     under node + @napi-rs/canvas for offline frame verification.
 *   - deterministic when given a seed, so rendered frames are reproducible.
 *
 * Usage:
 *   const r = CodefallRenderer.create(canvas, options)
 *   r.resize(1280, 800, 2)      // css px + devicePixelRatio
 *   r.frameAt(0)                // first frame (pre-seeded, already raining)
 *   r.frameAt(16.7)             // advance and draw
 *   r.beginDrain()              // app is ready: stop respawning columns
 *   r.isDrained()               // true once the last trail has run off
 *   r.destroy()
 */
;(function (root) {
  'use strict'

  var VERSION = '0.1.0'

  /* ------------------------------------------------------------------ *
   * Palettes. Ramps run faint (trail end) -> strong (rain head).
   * Light mode is NOT a tint of dark mode: on a light canvas the "strong"
   * end must be dark ink, otherwise the rain reads as glow on paper.
   * ------------------------------------------------------------------ */
  var PALETTES = {
    dark: {
      bg: '#151517',
      ramp: ['#0e2a1c', '#16452a', '#1c7a44', '#22c55e', '#4ade80', '#86efac'],
      head: '#e9fff3',
      title: '#d8ffe5',
      titleGlow: '#22c55e',
      progress: 'rgba(134,239,172,0.85)'
    },
    light: {
      // Ink on paper: contrast comes from DARKNESS, so the ramp's faint end
      // must still be visible against white and the head must be near-black.
      // A washed-out pale ramp reads as fog, not as rain.
      bg: '#ffffff',
      ramp: ['#e9f2ec', '#b9d5c5', '#7cae92', '#3f8862', '#1d6142'],
      head: '#052b14',
      title: '#0f3d22',
      titleGlow: '#15803d',
      progress: 'rgba(21,128,61,0.9)'
    }
  }

  /* Glyph sets. 'code' is the plugin's own identity (falling code); katakana
   * is available because it is the reference look, but it is not the default. */
  var GLYPHS = {
    code: '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ{}[]()<>/*+-=;:$#@%&!?|\\^~_',
    katakana:
      '\uFF71\uFF72\uFF73\uFF74\uFF75\uFF76\uFF77\uFF78\uFF79\uFF7A\uFF7B\uFF7C\uFF7D\uFF7E\uFF7F\uFF80\uFF81\uFF82\uFF83\uFF84\uFF85\uFF86\uFF87\uFF88\uFF89\uFF8A\uFF8B\uFF8C\uFF8D\uFF8E\uFF8F\uFF90\uFF91\uFF92\uFF93\uFF94\uFF95\uFF96\uFF97\uFF98\uFF99\uFF9A\uFF9B\uFF9C\uFF9D',
    mixed: ''
  }
  GLYPHS.mixed =
    '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ' + GLYPHS.katakana.slice(0, 24)

  /* Quality tiers: cheaper tiers shorten the trail, drop brightness levels and
   * lower the target frame rate. The wrapper may drop a tier at runtime. */
  /* `glow` is a glyph-atlas blur, paid once at build time, not per frame. */
  var PRESETS = {
    high: { levels: 10, trail: [14, 32], fps: 30, glyphMs: [700, 1500], glow: 4 },
    standard: { levels: 8, trail: [10, 22], fps: 30, glyphMs: [700, 1500], glow: 3 },
    economy: { levels: 6, trail: [8, 17], fps: 24, glyphMs: [900, 1900], glow: 0 }
  }

  var DEFAULTS = {
    seed: 1,
    appearance: 'dark', // 'dark' | 'light'
    quality: 'standard', // key of PRESETS, or {levels,trail,fps,glyphMs,glow}
    glyphs: 'code', // 'code' | 'katakana' | 'mixed'
    charset: '', // overrides `glyphs` when non-empty
    fontSize: 18,
    fontFamily: 'Consolas, "Cascadia Mono", "DejaVu Sans Mono", monospace',
    // Horizontal breathing room between columns. A monospace advance alone
    // packs ~140 columns into 1280px and the result reads as a wall of text,
    // not as rain; the classic look is ~80-100 columns.
    columnSpacing: 1.35,
    rowSpacing: 1,
    density: 0.85, // 0.3 .. 1 : share of grid columns that carry rain
    ghostShare: 0.15, // share of columns pushed down to a barely-there glow
    speed: 1, // global speed multiplier
    titleText: '', // empty = pure rain; the boot controller passes its own value
    titleScale: 3.3, // title size = fontSize * titleScale
    titleY: 0.4, // vertical centre, fraction of height
    titleDim: 0.3, // rain brightness multiplier inside the title band
    titleLockStartMs: 240,
    titleLockStaggerMs: 52,
    titleSettleMs: 170,
    dprCap: 2,
    maxPixels: 2600000, // css px * dpr^2 budget for the backing store
    columnsCap: 170,
    statusText: '', // optional short truthful status line under the title
    createCanvas: null // injected factory (node); defaults to document.createElement
  }

  /* ------------------------------------------------------------------ *
   * Tiny deterministic RNG (xorshift32) so seeded renders reproduce.
   * ------------------------------------------------------------------ */
  function makeRng(seed) {
    var s = (seed | 0) || 0x9e3779b9
    return function () {
      s ^= s << 13
      s ^= s >>> 17
      s ^= s << 5
      s |= 0
      return ((s >>> 0) % 100000) / 100000
    }
  }

  /* ------------------------------------------------------------------ *
   * Colour helpers
   * ------------------------------------------------------------------ */
  function hexToRgb(hex) {
    var h = hex.replace('#', '')
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
    var n = parseInt(h, 16)
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
  }
  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t)
    ]
  }
  function rgbCss(c) {
    return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'
  }
  /** Expand a handful of ramp stops into `n` evenly spaced colours. */
  function buildRamp(stops, n) {
    var rgbs = stops.map(hexToRgb)
    var out = []
    for (var i = 0; i < n; i++) {
      var p = (n === 1 ? 0 : i / (n - 1)) * (rgbs.length - 1)
      var i0 = Math.floor(p)
      var i1 = Math.min(rgbs.length - 1, i0 + 1)
      out.push(rgbCss(mix(rgbs[i0], rgbs[i1], p - i0)))
    }
    return out
  }

  function resolvePreset(quality) {
    if (typeof quality === 'string' && PRESETS[quality]) return PRESETS[quality]
    if (quality && typeof quality === 'object') {
      return {
        levels: quality.levels || PRESETS.standard.levels,
        trail: quality.trail || PRESETS.standard.trail,
        fps: quality.fps || PRESETS.standard.fps,
        glyphMs: quality.glyphMs || PRESETS.standard.glyphMs,
        glow: quality.glow || 0
      }
    }
    return PRESETS.standard
  }

  /* ------------------------------------------------------------------ *
   * create()
   * ------------------------------------------------------------------ */
  function create(canvas, options) {
    if (!canvas) throw new Error('codefall: a canvas is required')

    var o = {}
    for (var k in DEFAULTS) o[k] = DEFAULTS[k]
    if (options) for (var k2 in options) if (options[k2] !== undefined) o[k2] = options[k2]

    var createCanvasImpl =
      o.createCanvas ||
      function (w, h) {
        var c = root.document.createElement('canvas')
        c.width = w
        c.height = h
        return c
      }

    var ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('codefall: 2d context unavailable')

    var rng = makeRng(o.seed)
    var preset = resolvePreset(o.quality)
    var palette = PALETTES[o.appearance] || PALETTES.dark
    var charset = o.charset || GLYPHS[o.glyphs] || GLYPHS.code
    var levels = preset.levels

    var W = 0
    var H = 0
    var dpr = 1
    var cellW = 8
    var cellH = 12
    var pad = 0
    var tileW = 8
    var tileH = 12
    var gpc = 1 // glyphs per atlas row
    var atlas = []
    var rampColors = []
    var columns = []
    var cells = null // Int16Array, column-major: [col * rows + row]
    var cellNext = null // Float32Array, next glyph swap time per cell
    var rows = 0
    var cols = 0
    var title = null
    var lastT = null
    var started = false
    var draining = false
    var drained = false
    var drainStart = null // set on the first frame after beginDrain()
    var drainMs = 240
    var drainFactor = 1
    var destroyed = false
    var lastDrawCalls = 0
    /** Bumped on every re-seed, so callers can tell "retuned" from "restarted". */
    var sceneRevision = 0
    var scratch = createCanvasImpl(8, 8).getContext('2d')

    /* ---------------------------------------------------------------- *
     * Layout
     * ---------------------------------------------------------------- */
    function fontAt(size) {
      return size + 'px ' + o.fontFamily
    }

    function measureAdvance(size) {
      scratch.font = fontAt(size)
      return scratch.measureText('M').width
    }

    /** Fill a grid rectangle with fresh glyphs and swap timers. */
    function seedCells(fromCol, toCol) {
      for (var c = fromCol; c < toCol; c++) {
        for (var r = 0; r < rows; r++) {
          var i = c * rows + r
          cells[i] = (rng() * charset.length) | 0
          cellNext[i] = rng() * 1400
        }
      }
    }

    /** Tile geometry depends on the active preset's glow, not on the grid. */
    function computeTile() {
      pad = preset.glow ? Math.ceil(preset.glow) : 0
      tileW = cellW + pad * 2
      tileH = cellH + pad * 2
    }

    /**
     * Rebuild the grid geometry.
     *
     * `keep` preserves the running scene across a window resize: without it a
     * resize restarts the whole rain mid-boot, which reads as a glitch. Column
     * head positions are carried over in row units (scaled), so the fall simply
     * continues in the new geometry.
     */
    function layout(keep) {
      var prevCols = cols
      var prevRows = rows
      var prevColumns = columns
      var prevCells = cells
      var prevCellNext = cellNext
      var prevCellW = cellW
      var prevCellH = cellH

      cellW = Math.max(4, Math.ceil(measureAdvance(o.fontSize) * o.columnSpacing))
      cellH = Math.max(6, Math.round(o.fontSize * 1.16 * o.rowSpacing))
      computeTile()

      var wanted = Math.floor(W / cellW)
      cols = Math.max(1, Math.min(o.columnsCap, wanted))
      rows = Math.max(1, Math.ceil(H / cellH) + 2)

      // A font change moves the cell geometry, so glyph positions cannot be
      // carried over even when the caller asked to keep the scene.
      var geometrySame = prevCellW === cellW && prevCellH === cellH
      var reuse = keep === true && geometrySame && prevColumns && prevColumns.length > 0

      cells = new Int16Array(cols * rows)
      cellNext = new Float32Array(cols * rows)
      columns = new Array(cols)
      sceneRevision++

      if (reuse) {
        var cN = Math.min(prevCols, cols)
        var rN = Math.min(prevRows, rows)
        for (var c = 0; c < cN; c++) {
          for (var r = 0; r < rN; r++) {
            var dst = c * rows + r
            var src = c * prevRows + r
            cells[dst] = prevCells[src]
            cellNext[dst] = prevCellNext[src]
          }
          var col = prevColumns[c]
          if (col) {
            col.head = col.head * (rows / prevRows)
            columns[c] = col
            continue
          }
          columns[c] = newColumn(c, true)
        }
        seedCells(cN, cols)
        for (var c2 = 0; c2 < cN; c2++) if (!columns[c2]) columns[c2] = newColumn(c2, true)
      } else {
        seedCells(0, cols)
        for (var c3 = 0; c3 < cols; c3++) columns[c3] = newColumn(c3, true)
      }

      buildAtlas()
      buildTitle()
    }

    /** A fresh column state. `firstFrame` pre-seeds roughly half the columns
     *  mid-screen so the very first painted frame is already a full rain
     *  scene instead of an empty screen waiting for drops to fall in. */
    function newColumn(index, firstFrame) {
      // The two rolls are kept ON the column so density and ghost share can be
      // retuned later without re-rolling the scene (see retuneColumns).
      var roll = rng()
      var ghostRoll = rng()
      var carryRain = o.density >= 1 || roll < o.density
      // A few columns are pushed down to a barely-there glow. Uniform
      // brightness across every column is what makes a rain scene read as a
      // wall of text instead of as depth.
      var ghost = carryRain && ghostRoll < o.ghostShare
      var trail = preset.trail[0] + Math.floor(rng() * (preset.trail[1] - preset.trail[0] + 1))
      return {
        on: carryRain,
        roll: roll,
        ghostRoll: ghostRoll,
        ghost: ghost,
        head: firstFrame
          ? rng() < 0.55
            ? rng() * rows * 0.9
            : -(1 + rng() * 10)
          : -(1 + rng() * 8),
        speed: (7 + rng() * 15) * o.speed,
        trail: trail,
        bright: 0.62 + rng() * 0.38,
        phase: rng() * 6.283
      }
    }

    /**
     * Apply density / ghost-share changes to the LIVE scene.
     *
     * Re-seeding would make the whole picture jump, which is exactly what a
     * settings slider must not do. Instead a column that becomes active is
     * started above the top edge and falls in, and one that becomes inactive
     * simply stops being drawn. The result is that the field thickens or thins
     * the way a real downpour would.
     */
    function retuneColumns() {
      for (var c = 0; c < cols; c++) {
        var col = columns[c]
        if (!col) continue
        var on = o.density >= 1 || col.roll < o.density
        if (on === col.on) {
          if (on) col.ghost = col.ghostRoll < o.ghostShare
          continue
        }
        col.on = on
        if (on) {
          col.ghost = col.ghostRoll < o.ghostShare
          col.head = -(1 + rng() * 10) // enter from above, never pop into place
          col.speed = (7 + rng() * 15) * o.speed
          col.trail = preset.trail[0] + Math.floor(rng() * (preset.trail[1] - preset.trail[0] + 1))
          col.bright = 0.62 + rng() * 0.38
        }
      }
    }

    function buildAtlas() {
      var n = charset.length
      gpc = Math.max(1, Math.ceil(Math.sqrt(n)))
      var rowsA = Math.ceil(n / gpc)
      var aw = gpc * tileW
      var ah = rowsA * tileH

      rampColors = buildRamp(palette.ramp, levels)
      rampColors[levels - 1] = palette.head

      atlas = []
      for (var l = 0; l < levels; l++) {
        var cv = createCanvasImpl(aw, ah)
        var g = cv.getContext('2d')
        g.font = fontAt(o.fontSize)
        g.textAlign = 'center'
        g.textBaseline = 'middle'
        g.fillStyle = rampColors[l]
        if (preset.glow && l >= levels - 2) {
          g.shadowColor = rampColors[l]
          g.shadowBlur = preset.glow
        }
        for (var i = 0; i < n; i++) {
          var cx = (i % gpc) * tileW + pad + cellW / 2
          var cy = Math.floor(i / gpc) * tileH + pad + cellH / 2
          g.fillText(charset[i], cx, cy)
        }
        atlas.push(cv)
      }
    }

    function buildTitle() {
      var text = String(o.titleText || '')
      var size = Math.max(12, Math.round(o.fontSize * o.titleScale))
      scratch.font = fontAt(size)
      var adv = scratch.measureText('M').width
      var lockAt = new Float32Array(text.length)
      for (var i = 0; i < text.length; i++) {
        lockAt[i] = o.titleLockStartMs + i * o.titleLockStaggerMs + rng() * o.titleLockStaggerMs * 0.7
      }
      title = {
        text: text,
        size: size,
        advance: adv,
        lockAt: lockAt,
        font: fontAt(size),
        width: adv * text.length,
        // Time at which the last character has finished settling.
        // With no title there is nothing to converge, so "complete" is zero
        // rather than the settle time.
        completeAt: text.length ? lockAt[text.length - 1] + o.titleSettleMs : 0
      }
    }

    /* ---------------------------------------------------------------- *
     * Drawing
     * ---------------------------------------------------------------- */
    function headLevel(b) {
      var l = Math.round(b * (levels - 1))
      return l < 0 ? 0 : l > levels - 1 ? levels - 1 : l
    }

    function flickerGlyph(i, t) {
      var slot = Math.floor(t / 70)
      var h = (i * 2654435761 + slot * 40503) ^ (o.seed * 2246822519)
      h = (h ^ (h >>> 15)) >>> 0
      return charset[h % charset.length]
    }

    function statusY() {
      return H * o.titleY + Math.max(30, title.size * 0.82)
    }

    function titleBand() {
      if (!title || !title.text) return null
      var cy = H * o.titleY
      var h = title.size * 0.86
      // The band that gets its rain dimmed must also cover the status line,
      // otherwise the honest-status text is unreadable over the rain.
      var y1 = cy + h
      if (o.statusText) y1 = Math.max(y1, statusY() + title.size * 0.55)
      return {
        x0: (W - title.width) / 2 - cellW,
        x1: (W + title.width) / 2 + cellW,
        y0: cy - h,
        y1: y1,
        feather: cellH * 4
      }
    }

    function drawRain(t, band) {
      var calls = 0
      for (var c = 0; c < cols; c++) {
        var col = columns[c]
        if (!col.on) continue
        var top = col.head - col.trail
        if (top > rows) continue
        var r0 = Math.max(0, Math.floor(top))
        var r1 = Math.min(rows - 1, Math.floor(col.head))
        var x = c * cellW
        for (var r = r0; r <= r1; r++) {
          var d = col.head - r
          if (d < 0) continue
          // Exponential falloff, not a near-linear ramp: only the few cells
          // right behind the head should be bright, and the tail must actually
          // reach black. A gentle curve leaves a broad mid-brightness plateau
          // that reads as a uniform sheet.
          var b = col.bright * Math.exp(-2.6 * (d / (col.trail + 1)))
          // Two-cell head: the top cell is the near-white "landing" glyph, the
          // one behind it stays light. A single lit cell is easy to miss at
          // 91 columns; the pair is what makes the eye read a falling head.
          if (d < 0.9) b = Math.max(b, col.ghost ? 0.6 : 0.97)
          else if (d < 1.9) b = Math.max(b, col.ghost ? 0.42 : 0.72)
          // Drain AFTER the head boost, or the boosted head cells survive the
          // fade-out and the overlay never actually goes dark.
          b *= drainFactor
          if (b < 0.055) continue

          var y = r * cellH
          if (band && x + cellW > band.x0 && x < band.x1) {
            // Taper the dimming instead of cutting a hard rectangle out of the
            // rain: a crisp band edge is visible as a box around the title.
            var dy = 0
            if (y + cellH < band.y0) dy = band.y0 - (y + cellH)
            else if (y > band.y1) dy = y - band.y1
            var k = dy <= 0 ? 1 : Math.max(0, 1 - dy / band.feather)
            b *= 1 - (1 - o.titleDim) * k
          }

          var lvl = headLevel(b)
          // Level 0 is the faintest ramp stop on purpose: it is the long,
          // barely-there tail. Skipping it truncates every column to a stub.
          if (lvl < 0) continue

          var idx = c * rows + r
          if (t >= cellNext[idx]) {
            cells[idx] = (rng() * charset.length) | 0
            cellNext[idx] = t + preset.glyphMs[0] + rng() * (preset.glyphMs[1] - preset.glyphMs[0])
          }
          var gi = cells[idx]
          var sx = (gi % gpc) * tileW
          var sy = Math.floor(gi / gpc) * tileH
          ctx.drawImage(atlas[lvl], sx, sy, tileW, tileH, x - pad, y - pad, tileW, tileH)
          calls++
        }
      }
      return calls
    }

    function drawTitle(t) {
      if (!title || !title.text) return
      var cy = H * o.titleY
      var x0 = (W - title.width) / 2
      ctx.font = title.font
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = palette.title
      for (var i = 0; i < title.text.length; i++) {
        var locked = t >= title.lockAt[i]
        var ch
        var alpha
        if (locked) {
          ch = title.text[i]
          var k = Math.min(1, (t - title.lockAt[i]) / o.titleSettleMs)
          alpha = 0.55 + 0.45 * k
          if (preset.glow) {
            ctx.shadowColor = palette.titleGlow
            ctx.shadowBlur = title.size * 0.16 * k
          }
        } else {
          ch = flickerGlyph(i, t)
          alpha = 0.42 + 0.22 * Math.abs(Math.sin(t / 90 + i))
        }
        ctx.globalAlpha = alpha
        ctx.fillText(ch, x0 + (i + 0.5) * title.advance, cy)
        if (ctx.shadowBlur) ctx.shadowBlur = 0
      }
      ctx.globalAlpha = 1
    }

    function drawStatus() {
      if (!o.statusText) return
      var size = Math.max(13, Math.round(o.fontSize * 0.95))
      ctx.font = fontAt(size)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillStyle = palette.progress
      ctx.globalAlpha = 0.9
      ctx.fillText(o.statusText, W / 2, statusY())
      ctx.globalAlpha = 1
    }

    /* ---------------------------------------------------------------- *
     * Frame
     * ---------------------------------------------------------------- */
    function frameAt(t) {
      if (destroyed || !cells) return
      if (lastT === null) lastT = t
      var dt = t - lastT
      lastT = t
      if (dt < 0) dt = 0
      if (dt > 120) dt = 120 // never accumulate a backlog after a pause

      var alive = 0
      for (var c = 0; c < cols; c++) {
        var col = columns[c]
        if (!col.on) continue
        col.head += (col.speed * dt) / 1000
        if (col.head - col.trail > rows) {
          if (draining) {
            col.on = false
            continue
          }
          columns[c] = newColumn(c, false)
        } else {
          alive++
        }
      }

      // Draining is a timed brightness decay, NOT a wait for every head to run
      // off the bottom: the slowest column would need ~9s at 7 rows/s, which
      // would blow the hand-off budget and just trip the watchdog instead.
      // Heads stop being spawned above; here the remaining trails fade out.
      if (draining) {
        if (drainStart === null) drainStart = t
        if (drainMs <= 0) {
          drainFactor = 0
        } else {
          drainFactor = 1 - (t - drainStart) / drainMs
        }
        if (drainFactor <= 0.02) {
          drainFactor = 0
          drained = true
        }
      }
      drained = drained || (draining && alive === 0 && drainStart !== null)

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.imageSmoothingEnabled = false
      ctx.fillStyle = palette.bg
      ctx.fillRect(0, 0, W, H)

      var band = titleBand()
      lastDrawCalls = drawRain(t, band)
      drawTitle(t)
      drawStatus()
      started = true
    }

    /* ---------------------------------------------------------------- *
     * Public API
     * ---------------------------------------------------------------- */
    function resize(cssW, cssH, ratio) {
      if (destroyed) return
      var w = Math.max(1, Math.floor(cssW))
      var h = Math.max(1, Math.floor(cssH))
      var want = Math.max(1, ratio || 1)
      // Respect both the explicit DPR cap and the total pixel budget.
      var capped = Math.min(want, o.dprCap)
      while (capped > 1 && w * h * capped * capped > o.maxPixels) capped -= 0.25
      var changed = w !== W || h !== H || capped !== dpr
      var first = W === 0 || H === 0
      W = w
      H = h
      dpr = Math.max(1, capped)
      canvas.width = Math.round(W * dpr)
      canvas.height = Math.round(H * dpr)
      if (canvas.style) {
        canvas.style.width = W + 'px'
        canvas.style.height = H + 'px'
      }
      layout(!first)
      lastT = null
      return { width: W, height: H, dpr: dpr, cols: cols, rows: rows, changed: changed }
    }

    /**
     * Live reconfiguration, split into three tiers by how much of the scene has
     * to be rebuilt. This split is what makes an animation-parameter UI possible
     * at all: a slider must not restart the rain.
     *
     *   A. instant   — `speed`, `density`, `ghostShare`: applied to the running
     *                  scene (speed scales existing columns; density lets new
     *                  columns fall in from above).
     *   B. atlas only — `quality`, `appearance`, `glyphs`, `charset`: the glyph
     *                  atlas is rebuilt and the fall continues uninterrupted.
     *   C. re-seed   — `fontSize`, `fontFamily`, `columnSpacing`, `rowSpacing`:
     *                  the grid itself moves, so the scene is rebuilt.
     */
    function setOptions(patch) {
      var needAtlas = false
      var needLayout = false
      var needRetune = false
      for (var key in patch) {
        var value = patch[key]
        if (value === undefined || o[key] === value) continue
        if (key === 'quality') {
          o.quality = value
          preset = resolvePreset(value)
          needAtlas = true
        } else if (key === 'appearance') {
          o.appearance = value
          palette = PALETTES[o.appearance] || PALETTES.dark
          needAtlas = true
        } else if (key === 'charset' || key === 'glyphs') {
          o[key] = value
          charset = o.charset || GLYPHS[o.glyphs] || GLYPHS.code
          needAtlas = true
        } else if (key === 'density' || key === 'ghostShare') {
          o[key] = value
          needRetune = true
        } else if (key === 'speed') {
          var ratio = o.speed ? value / o.speed : 1
          o.speed = value
          for (var c = 0; c < columns.length; c++) {
            if (columns[c] && columns[c].on) columns[c].speed *= ratio
          }
        } else if (
          key === 'fontSize' ||
          key === 'fontFamily' ||
          key === 'columnSpacing' ||
          key === 'rowSpacing'
        ) {
          o[key] = value
          needLayout = true
        } else if (
          key === 'titleText' ||
          key === 'titleScale' ||
          key === 'titleLockStartMs' ||
          key === 'titleLockStaggerMs'
        ) {
          o[key] = value
          buildTitle()
        } else {
          o[key] = value
        }
      }
      if (needLayout) {
        rng = makeRng(o.seed)
        layout(false)
        lastT = null
      } else if (needAtlas) {
        computeTile()
        buildAtlas()
      }
      if (needRetune) retuneColumns()
      return state()
    }

    function state() {
      return {
        version: VERSION,
        width: W,
        height: H,
        dpr: dpr,
        cols: cols,
        rows: rows,
        levels: levels,
        cellW: cellW,
        cellH: cellH,
        quality: typeof o.quality === 'string' ? o.quality : 'custom',
        appearance: o.appearance,
        density: o.density,
        speed: o.speed,
        ghostShare: o.ghostShare,
        glyphs: o.glyphs,
        /** Bumped on every re-seed: lets callers tell "retuned" from "restarted". */
        sceneRevision: sceneRevision,
        activeColumns: (function () {
          var n = 0
          for (var i = 0; i < columns.length; i++) if (columns[i] && columns[i].on) n++
          return n
        })(),
        draining: draining,
        drained: drained,
        drainFactor: drainFactor,
        started: started,
        titleCompleteAt: title ? title.completeAt : 0,
        drawCalls: lastDrawCalls,
        bytes: { atlas: atlas.length }
      }
    }

    return {
      version: VERSION,
      resize: resize,
      frameAt: frameAt,
      setOptions: setOptions,
      /**
       * Restart the scene from scratch with the current options. Draining is
       * terminal by design, so a replay (a settings preview, a manual replay)
       * asks for it explicitly instead of any option write silently reviving a
       * finished boot.
       */
      reset: function () {
        draining = false
        drained = false
        drainStart = null
        drainFactor = 1
        lastT = null
        rng = makeRng(o.seed)
        layout(false)
        return state()
      },
      state: state,
      beginDrain: function (ms) {
        if (draining) return
        draining = true
        drained = false
        drainStart = null
        drainMs = ms == null ? 240 : Math.max(0, ms)
      },
      isDraining: function () {
        return draining
      },
      isDrained: function () {
        return drained
      },
      palette: function () {
        return palette
      },
      targetFps: function () {
        return preset.fps
      },
      destroy: function () {
        destroyed = true
        atlas = []
        columns = []
        cells = null
        cellNext = null
        title = null
        ctx = null
        scratch = null
      }
    }
  }

  root.CodefallRenderer = {
    version: VERSION,
    PALETTES: PALETTES,
    PRESETS: PRESETS,
    GLYPHS: GLYPHS,
    DEFAULTS: DEFAULTS,
    create: create
  }
})(typeof globalThis !== 'undefined' ? globalThis : this)
