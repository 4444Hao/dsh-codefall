/**
 * Extract the design-token stylesheet out of the theme plugin.
 *
 *   node tools/extract-theme-css.mjs [--from <ui-theme/lib/client.js>] [--out <file>]
 *
 * The whole three-layer token system (static palette → semantic aliases → the
 * component stylesheets that consume them) ships as one CSS string inside the
 * theme client bundle. Pulling it out makes the token inventory auditable —
 * see tools/theme-audit.mjs — instead of guessing which tokens are blue.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const FROM = resolve(REPO, opt('from', 'tools/out/ui-theme-client.js'))
const OUT = resolve(REPO, opt('out', 'tools/out/theme-tokens.css'))

const src = readFileSync(FROM, 'utf8')

/** Pull one `var <name>_css_default = "..."` string literal out by hand. */
function grabString(name) {
  const at = src.indexOf(`var ${name} = "`)
  if (at < 0) return null
  const open = src.indexOf('"', at + `var ${name} = `.length)
  let out = ''
  for (let i = open + 1; i < src.length; i++) {
    const ch = src[i]
    if (ch === '\\') {
      const next = src[i + 1]
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next
      i++
      continue
    }
    if (ch === '"') break
    out += ch
  }
  return out
}

const sheets = [...src.matchAll(/var (\w*_css_default)\s*=\s*"/gu)].map((m) => m[1])
if (sheets.length === 0) {
  console.error(`no *_css_default stylesheets in ${FROM}`)
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 * every sheet, individually and concatenated in injection order
 * ---------------------------------------------------------------- */
const parts = []
const report = []
for (const name of sheets) {
  const css = grabString(name)
  if (css === null) continue
  const short = name.replace(/_css_default$/u, '').replace(/_/gu, '-')
  parts.push(`/* ===== ${short} ===== */\n${css}`)
  report.push({ short, length: css.length, tokens: (css.match(/--dsw-/gu) || []).length })
}

writeFileSync(OUT, parts.join('\n'), 'utf8')
for (const r of report) {
  const single = OUT.replace(/\.css$/u, `.${r.short}.css`)
  const css = grabString(`${r.short.replace(/-/gu, '_')}_css_default`)
  if (css !== null) writeFileSync(single, css, 'utf8')
}

console.log(`from: ${FROM}`)
console.log(`out : ${OUT}  (${parts.join('\n').length} chars, ${sheets.length} sheets)`)
for (const r of report) {
  console.log(`  ${r.short.padEnd(24)} ${String(r.length).padStart(6)} chars  ${String(r.tokens).padStart(3)} --dsw- refs`)
}
const all = parts.join('\n')
const count = (re) => (all.match(re) || []).length
console.log(
  `total: static=${count(/--dsw-static-/gu)} alias=${count(/--dsw-alias-/gu)} specific=${count(
    /--dsw-specific-/gu
  )} shiki=${count(/--shiki-/gu)}`
)
console.log(`palettes: body=${count(/body\{/gu)} dark=${count(/body\[data-ds-dark-theme\]/gu)} root=${count(/:root\{/gu)}`)
