#!/usr/bin/env node
/**
 * Read the app's own front-end assets out of its packaged app.asar.
 *
 *   node tools/extract-app-assets.mjs                 # auto-detect app.asar
 *   node tools/extract-app-assets.mjs --asar <path>
 *   node tools/extract-app-assets.mjs --find <root>   # search a root for app.asar
 *   node tools/extract-app-assets.mjs --list          # show what would be written
 *
 * WHY THIS EXISTS
 * ---------------
 * tools/extract-theme-css.mjs, tools/green-map.mjs and tools/theme-reach.mjs need
 * the token stylesheets and the SPA bundle that ship INSIDE the DeepSeek Harness
 * desktop app. Those files belong to DeepSeek, so this repository neither commits
 * nor redistributes them — this script reads them out of the copy you already
 * have installed. Everything it writes lands in `tools/out/`, which is gitignored,
 * so proprietary content cannot be committed by accident.
 *
 * The asar format is simple enough to read directly: a 16-byte header gives the
 * size of a JSON directory, and each file entry carries an offset into the data
 * section that follows it.
 */
import { readFileSync, mkdirSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')
const OUT_DIR = resolve(REPO, 'tools/out')

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const flag = (name) => argv.includes('--' + name)

/* ---------------------------------------------------------------- *
 * what the pipeline needs, and the stable name to give each file
 * ---------------------------------------------------------------- */
const TARGETS = [
  {
    // The three-layer token stylesheets and the theme runtime live here.
    match: /^dsh\/node_modules\/@deepseek-ai\/dsh-client-ui-theme\/lib\/client\.js$/u,
    to: 'ui-theme-client.js',
    why: 'token stylesheets + ThemeRuntime (extract-theme-css, green-map)'
  },
  {
    match: /^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-[\w-]+\.css$/u,
    to: 'app-index.css',
    why: 'component styles: 436 var(--dsw-*) consumers (theme-reach)'
  },
  {
    match: /^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/vendor-[\w-]+\.css$/u,
    to: 'app-vendor.css',
    why: 'vendor styles (theme-reach)'
  },
  {
    match: /^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/assets\/index-[\w-]+\.js$/u,
    to: 'spa-index.js',
    why: 'the app shell bundle: currentColor/icon audit (theme-reach)'
  },
  {
    match: /^dsh\/node_modules\/@deepseek-ai\/dsh-web-frontend\/dist\/index\.html$/u,
    to: 'app-index.html',
    why: 'the shell HTML the injections target'
  }
]

/* ---------------------------------------------------------------- *
 * locate app.asar
 * ---------------------------------------------------------------- */
const CANDIDATES = [
  process.env.DSH_ASAR,
  process.platform === 'win32'
    ? join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek Harness', 'resources', 'app.asar')
    : undefined,
  process.platform === 'win32'
    ? join(process.env.PROGRAMFILES || '', 'DeepSeek Harness', 'resources', 'app.asar')
    : undefined,
  process.platform === 'darwin'
    ? '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar'
    : undefined,
  '/opt/DeepSeek Harness/resources/app.asar'
].filter(Boolean)

/** Bounded search for `resources/app.asar` under a root. */
function findAsar(root, depth = 4) {
  if (depth < 0) return undefined
  let entries
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return undefined
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(root, entry.name)
    if (entry.name === 'app.asar' || full.endsWith('app.asar')) return full
    if (entry.name === 'resources') {
      const guess = join(full, 'app.asar')
      if (existsSync(guess)) return guess
    }
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const found = findAsar(join(root, entry.name), depth - 1)
    if (found) return found
  }
  return undefined
}

const explicit = opt('asar', undefined)
const searchRoot = opt('find', undefined)
let asarPath = explicit

if (!asarPath && searchRoot) asarPath = findAsar(resolve(searchRoot))
if (!asarPath) asarPath = CANDIDATES.find((p) => p && existsSync(p))
if (!asarPath) {
  console.error('Could not find app.asar. Pass one explicitly:\n')
  console.error('  node tools/extract-app-assets.mjs --asar "<install>/resources/app.asar"\n')
  console.error('or search for it:\n')
  console.error('  node tools/extract-app-assets.mjs --find "<install root>"\n')
  console.error('Known places it lives:')
  for (const p of CANDIDATES) console.error('  ' + p)
  console.error('\nYou can also set DSH_ASAR. This is only needed for the theme')
  console.error('tooling; the plugin itself needs nothing from the app bundle.')
  process.exit(1)
}

/* ---------------------------------------------------------------- *
 * read the asar directory
 * ---------------------------------------------------------------- */
const file = readFileSync(asarPath)
const pickleSize = file.readUInt32LE(4)
const jsonSize = file.readUInt32LE(8)
// The JSON is padded by 4 bytes, and the data section starts after the header.
const directory = JSON.parse(file.subarray(16, 16 + jsonSize - 4).toString('utf8'))
const dataStart = 8 + pickleSize

const files = []
;(function walk(node, prefix) {
  if (!node || !node.files) return
  for (const [name, child] of Object.entries(node.files)) {
    const path = prefix ? `${prefix}/${name}` : name
    if (child.files) walk(child, path)
    else if (typeof child.offset === 'string' || typeof child.offset === 'number') {
      files.push({ path, offset: Number(child.offset), size: Number(child.size) })
    }
  }
})(directory, '')

if (flag('list')) {
  console.log(`asar: ${asarPath}`)
  console.log(`entries: ${files.length}\n`)
  for (const target of TARGETS) {
    const hit = files.filter((f) => target.match.test(f.path))
    console.log(`${hit.length ? 'found  ' : 'MISSING'} ${target.to.padEnd(20)} ${target.why}`)
    for (const h of hit) console.log(`          ${h.path}  (${h.size} bytes)`)
  }
  process.exit(0)
}

/* ---------------------------------------------------------------- *
 * extract
 * ---------------------------------------------------------------- */
mkdirSync(OUT_DIR, { recursive: true })
let written = 0
for (const target of TARGETS) {
  const hit = files.filter((f) => target.match.test(f.path)).sort((a, b) => b.size - a.size)[0]
  if (!hit) {
    console.warn(`missing: ${target.to}  (no entry matching ${target.match})`)
    continue
  }
  const bytes = file.subarray(dataStart + hit.offset, dataStart + hit.offset + hit.size)
  writeFileSync(join(OUT_DIR, target.to), bytes)
  written++
  console.log(`${target.to.padEnd(20)} ${String(bytes.length).padStart(8)} bytes  <- ${hit.path}`)
}

console.log(`\n${written}/${TARGETS.length} assets written to tools/out/ (gitignored).`)
if (written < TARGETS.length) {
  console.log('Some were missing; the theme tooling needs the ones listed above.')
}
console.log('\nNext: node tools/extract-theme-css.mjs && node tools/green-map.mjs')
