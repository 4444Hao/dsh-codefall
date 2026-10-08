/**
 * What can a token-level theme actually reach?
 *
 *   node tools/theme-reach.mjs
 *
 * The green theme can only change what is expressed through `--dsw-*` tokens.
 * Anything hard-coded in a component stylesheet, an inline SVG, or a third-party
 * syntax-highlighting theme stays blue no matter what we override. This measures
 * that boundary so the scope statement is evidence rather than optimism.
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const read = (p) => {
  try {
    return readFileSync(resolve(REPO, p), 'utf8')
  } catch {
    return ''
  }
}

const css = read('tools/out/app-index.css')
const vendor = read('tools/out/app-vendor.css')
const spa = read('tools/out/spa-index.js')
const tokens = read('tools/out/theme-tokens.css')

const count = (haystack, needle, flags = 'gu') => (haystack.match(new RegExp(needle, flags)) || []).length

console.log('=== syntax highlighting: token-driven or bundled theme? ===')
for (const needle of ['hljs', '\\.token\\b', 'prism', 'shiki', 'chroma']) {
  console.log(`  ${needle.padEnd(12)} app-css=${count(css, needle)}  vendor-css=${count(vendor, needle)}`)
}

console.log('')
console.log('=== icons: currentColor (themeable) vs hard-coded fills ===')
console.log(`  currentColor in SPA bundle      ${count(spa, 'currentColor')}`)
console.log(`  fill="#..."  in SPA bundle      ${count(spa, 'fill=\\\\"#')}`)
console.log(`  stroke="#..." in SPA bundle     ${count(spa, 'stroke=\\\\"#')}`)

console.log('')
console.log('=== blue hexes that exist OUTSIDE the token layer ===')
const blues = ['#4176e6', '#3b82f6', '#2563eb', '#60a5fa', '#7aaaff', '#5686fe', '#8b5cf6', '#a855f7', '#4d93f8']
for (const hex of blues) {
  const inComponents = count(css, hex, 'gi') + count(vendor, hex, 'gi')
  const inSpa = count(spa, hex, 'gi')
  const inTokens = count(tokens, hex, 'gi')
  if (inComponents + inSpa + inTokens > 0) {
    console.log(`  ${hex}  tokens=${inTokens}  app-css=${inComponents}  spa=${inSpa}`)
  }
}

console.log('')
console.log('=== how much of the SPA is token-driven at all ===')
console.log(`  var(--dsw-...) usages in SPA    ${count(spa, 'var\\(--dsw-')}`)
console.log(`  var(--dsw-...) usages in app-css ${count(css, 'var\\(--dsw-')}`)
