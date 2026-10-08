/**
 * Tiny fixture server for verifying the "D" policy refresh in a real browser.
 *
 *   node tools/serve-fixture.mjs --file tools/out/boot-test.html --port 8123 \
 *        --policy '{"dismiss":"ready","minDisplayMs":3000}'
 *
 * Serves the page at `/` and the plugin route at `/codefall/api`, reproducing
 * the Web surface's same-origin shape (the desktop reaches the same route
 * through the shell's protocol forwarder).
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..')

const argv = process.argv.slice(2)
function arg(name, fallback) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}

const FILE = resolve(REPO, arg('file', 'tools/out/boot-test.html'))
const PORT = Number(arg('port', 8123))
const policy = JSON.parse(arg('policy', '{"dismiss":"ready","minDisplayMs":3000}'))

createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1')
  if (url.pathname === '/codefall/api') {
    const body = JSON.stringify({ ok: true, value: policy })
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
    return
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    const html = readFileSync(FILE, 'utf8')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(html)
    return
  }
  res.writeHead(404)
  res.end()
}).listen(PORT, '127.0.0.1', () => {
  console.log(`fixture on http://127.0.0.1:${PORT}/  policy=${JSON.stringify(policy)}`)
})
