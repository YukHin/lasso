// Local server for the lasso mod: serves the reader (pdf.js for PDFs, a plain
// viewer for images), watches each opened file for changes, and hands clips
// back to the mod as JSON lines on stdout. Binds 127.0.0.1 only; every API
// call needs the session token.
import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PDFJS_VERSION = '5.4.624'
const HERE = path.dirname(fileURLToPath(import.meta.url))
const WEB = path.join(HERE, 'web')
const HOME = process.env.LASSO_HOME || path.join(os.homedir(), '.claude', 'lasso')
const VENDOR_ROOT = path.join(HOME, 'vendor')
const PDFJS = path.join(VENDOR_ROOT, 'node_modules', 'pdfjs-dist')
const CLIPS = path.join(HOME, 'clips')
const DOCS_FILE = path.join(HOME, 'docs.json')
const SERVER_FILE = path.join(HOME, 'server.json')
const IDLE_EXIT_MS = 5 * 60 * 1000
let lastPageAt = Date.now()

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, arg, i, all) => {
    if (arg.startsWith('--')) pairs.push([arg.slice(2), all[i + 1]])
    return pairs
  }, []),
)
const TOKEN = args.token || randomBytes(16).toString('hex')
const WANTED_PORT = Number(args.port) || 0
// a standalone server (from Explorer) speaks what the last session's did
const LANG_FILE = path.join(HOME, 'lang.json')
const savedLang = () => {
  try {
    return JSON.parse(fs.readFileSync(LANG_FILE, 'utf8')).lang
  } catch {
    return undefined
  }
}
let lang = (args.lang ?? savedLang()) === 'zh' ? 'zh' : 'en'

const emit = msg => process.stdout.write(JSON.stringify(msg) + '\n')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.ftl': 'text/plain; charset=utf-8',
}
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg', '.avif'])
const kindOf = file => {
  const ext = path.extname(file).toLowerCase()
  return ext === '.pdf' ? 'pdf' : IMAGE_EXTS.has(ext) ? 'image' : null
}

function ensureVendor() {
  if (fs.existsSync(path.join(PDFJS, 'build', 'pdf.mjs'))) return
  fs.mkdirSync(VENDOR_ROOT, { recursive: true })
  emit({ type: 'log', message: `installing pdfjs-dist@${PDFJS_VERSION}` })
  execFileSync(
    process.platform === 'win32' ? 'npm.cmd' : 'npm',
    ['install', '--no-audit', '--no-fund', '--silent', `pdfjs-dist@${PDFJS_VERSION}`],
    { cwd: VENDOR_ROOT, stdio: 'ignore', shell: process.platform === 'win32' },
  )
}

function pruneClips() {
  fs.mkdirSync(CLIPS, { recursive: true })
  const cutoff = Date.now() - 14 * 24 * 3600 * 1000
  for (const name of fs.readdirSync(CLIPS)) {
    const file = path.join(CLIPS, name)
    try {
      if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file)
    } catch {}
  }
}

// --- documents -------------------------------------------------------------

/** id -> { id, path, name, kind, mtimeMs, size, clients: Set<res>, timer } */
const docs = new Map()
/** every open reader page, for language changes */
const pages = new Set()

function docId(file) {
  return createHash('sha1').update(file.toLowerCase()).digest('hex').slice(0, 10)
}

function saveDocs() {
  const list = [...docs.values()].map(d => ({ id: d.id, path: d.path }))
  try {
    fs.writeFileSync(DOCS_FILE, JSON.stringify(list.slice(-50)))
  } catch {}
}

function loadDocs() {
  try {
    for (const { path: file } of JSON.parse(fs.readFileSync(DOCS_FILE, 'utf8'))) {
      if (fs.existsSync(file) && kindOf(file)) addDoc(file, { save: false })
    }
  } catch {}
}

function addDoc(file, { save = true } = {}) {
  const id = docId(file)
  let doc = docs.get(id)
  if (!doc) {
    const stat = fs.statSync(file)
    doc = {
      id,
      path: file,
      name: path.basename(file),
      kind: kindOf(file),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      clients: new Set(),
      timer: null,
    }
    docs.set(id, doc)
    watchDoc(doc)
    if (save) saveDocs()
  }
  return doc
}

const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)

// fs.watchFile polls, which survives editors and LaTeX tools that replace the
// file instead of writing it in place (and Dropbox syncs).
function watchDoc(doc) {
  fs.watchFile(doc.path, { interval: 700 }, curr => {
    if (curr.mtimeMs === 0 || curr.size === 0) return // gone or being rewritten
    if (curr.mtimeMs === doc.mtimeMs && curr.size === doc.size) return
    clearTimeout(doc.timer)
    // wait for the writer to finish before telling anyone
    doc.timer = setTimeout(() => {
      let stat
      try {
        stat = fs.statSync(doc.path)
      } catch {
        return
      }
      if (stat.size === 0 || (stat.mtimeMs === doc.mtimeMs && stat.size === doc.size)) return
      doc.mtimeMs = stat.mtimeMs
      doc.size = stat.size
      const event = { type: 'changed', docId: doc.id, name: doc.name, path: doc.path, mtimeMs: stat.mtimeMs }
      for (const res of doc.clients) sse(res, 'changed', event)
      emit(event)
    }, 500)
  })
}

// --- http ------------------------------------------------------------------

let lastPing = Date.now()

function send(res, status, body, type = 'application/json') {
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' })
  res.end(text)
}

function serveFile(res, root, rel) {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel))
  if (!file.startsWith(path.resolve(root) + path.sep)) return send(res, 403, { error: 'forbidden' })
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' })
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': root === PDFJS ? 'max-age=86400' : 'no-store',
    })
    res.end(data)
  })
}

function readBody(req, limit = 60 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function safeName(text) {
  return text.replace(/\.[a-z0-9]+$/i, '').replace(/[^\w一-鿿-]+/g, '_').slice(0, 40) || 'clip'
}

async function handle(req, res, port) {
  const url = new URL(req.url, `http://127.0.0.1:${port}`)
  // DNS rebinding guard: only our own host names
  const host = (req.headers.host || '').toLowerCase()
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'bad host' })

  const authed = req.headers['x-token'] === TOKEN || url.searchParams.get('t') === TOKEN
  const p = url.pathname

  if (p.startsWith('/vendor/')) return serveFile(res, PDFJS, p.slice('/vendor/'.length))
  if (p.startsWith('/static/')) return serveFile(res, WEB, p.slice('/static/'.length))

  const view = p.match(/^\/view\/([0-9a-f]{10})$/)
  if (view) {
    const doc = docs.get(view[1])
    if (!doc) return send(res, 404, 'This file is no longer open. Run /lasso again.', 'text/plain; charset=utf-8')
    const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8')
    const config = JSON.stringify({ token: TOKEN, docId: doc.id, name: doc.name, kind: doc.kind, lang }).replace(
      /</g,
      '\\u003c',
    )
    return send(
      res,
      200,
      html.replace('__CONFIG__', config).replaceAll('__TITLE__', doc.name.replace(/[<&"]/g, '')),
      MIME['.html'],
    )
  }

  if (!p.startsWith('/api/')) return send(res, 404, { error: 'not found' })
  if (!authed) return send(res, 401, { error: 'token required' })

  if (p === '/api/ping') {
    lastPing = Date.now()
    return send(res, 200, { ok: true, docs: docs.size })
  }

  if (p === '/api/lang' && req.method === 'POST') {
    const next = JSON.parse((await readBody(req)) || '{}').lang === 'zh' ? 'zh' : 'en'
    if (next !== lang) {
      lang = next
      for (const page of pages) sse(page, 'lang', { lang })
    }
    try {
      fs.writeFileSync(LANG_FILE, JSON.stringify({ lang }))
    } catch {}
    return send(res, 200, { lang })
  }

  if (p === '/api/open' && req.method === 'POST') {
    const { path: raw, cwd, reveal } = JSON.parse((await readBody(req)) || '{}')
    // `@file.pdf` is how a prompt names a file
    const given = String(raw || '').trim().replace(/^@/, '').replace(/^"(.*)"$/, '$1')
    if (!given) return send(res, 400, { error: 'path required' })
    const file = path.resolve(cwd || process.cwd(), given.replace(/^~(?=$|[\\/])/, os.homedir()))
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: `no such file: ${file}` })
    if (!kindOf(file)) return send(res, 400, { error: `not a PDF or an image: ${file}` })
    const doc = addDoc(file)
    const opened = { id: doc.id, name: doc.name, kind: doc.kind, path: doc.path, url: `http://127.0.0.1:${port}/view/${doc.id}` }
    // from Explorer: the session shows it (its mod reads this line)
    if (reveal) emit({ type: 'open-request', ...opened })
    return send(res, 200, opened)
  }

  const docRoute = p.match(/^\/api\/doc\/([0-9a-f]{10})\/(file|events)$/)
  if (docRoute) {
    const doc = docs.get(docRoute[1])
    if (!doc) return send(res, 404, { error: 'unknown document' })
    if (docRoute[2] === 'file') {
      // one read: the reader gets a consistent snapshot even mid-rewrite
      return fs.readFile(doc.path, (err, data) => {
        if (err) return send(res, 409, { error: 'file is being rewritten, try again' })
        res.writeHead(200, {
          'Content-Type': MIME[path.extname(doc.path).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        })
        res.end(data)
      })
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
    sse(res, 'hello', { mtimeMs: doc.mtimeMs, lang })
    doc.clients.add(res)
    pages.add(res)
    const beat = setInterval(() => res.write(': beat\n\n'), 25000)
    req.on('close', () => {
      clearInterval(beat)
      doc.clients.delete(res)
      pages.delete(res)
      lastPageAt = Date.now()
    })
    return
  }

  if (p === '/api/clip' && req.method === 'POST') {
    const clip = JSON.parse(await readBody(req))
    const doc = docs.get(clip.docId)
    if (!doc) return send(res, 404, { error: 'unknown document' })
    const id = `${Date.now().toString(36)}${randomBytes(2).toString('hex')}`
    let image
    if (typeof clip.png === 'string' && clip.png.startsWith('data:image/png;base64,')) {
      image = path.join(CLIPS, `${safeName(doc.name)}-p${clip.page}-${id}.png`)
      fs.writeFileSync(image, Buffer.from(clip.png.slice('data:image/png;base64,'.length), 'base64'))
    }
    emit({
      type: 'clip',
      send: clip.send === true,
      clip: {
        id,
        name: doc.name,
        path: doc.path,
        page: Number(clip.page) || 1,
        kind: clip.kind === 'text' ? 'text' : 'region',
        text: String(clip.text || '').slice(0, 12000),
        ...(clip.note ? { note: String(clip.note).slice(0, 2000) } : {}),
        ...(image ? { image } : {}),
      },
    })
    return send(res, 200, { ok: true, id })
  }

  return send(res, 404, { error: 'not found' })
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const actual = server.address().port
      handle(req, res, actual).catch(err => send(res, 500, { error: String(err?.message || err) }))
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

async function main() {
  fs.mkdirSync(HOME, { recursive: true })
  ensureVendor()
  pruneClips()
  loadDocs()

  let server
  // a hot reload of the mod restarts us on the same port, so open readers
  // reconnect; the old process may take a moment to let go of it
  for (let attempt = 0; attempt < 10 && WANTED_PORT; attempt++) {
    try {
      server = await listen(WANTED_PORT)
      break
    } catch {
      await new Promise(r => setTimeout(r, 300))
    }
  }
  server ??= await listen(0)
  const port = server.address().port
  emit({ type: 'ready', port, token: TOKEN, home: HOME })
  // where Explorer's "Open with Lasso" finds the newest running server
  const record = { port, token: TOKEN, pid: process.pid, standalone: Boolean(args.standalone) }
  try {
    fs.writeFileSync(SERVER_FILE, JSON.stringify(record))
  } catch {}
  process.on('exit', () => {
    try {
      if (JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8')).pid === process.pid) fs.unlinkSync(SERVER_FILE)
    } catch {}
  })
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(signal, () => process.exit(0))

  // the mod pings while its session lives; a standalone server (opened from
  // Explorer with no session) lives while a reader page is open
  setInterval(() => {
    const isIdle = args.standalone
      ? pages.size === 0 && Date.now() - lastPageAt > IDLE_EXIT_MS
      : Date.now() - lastPing > IDLE_EXIT_MS
    if (isIdle) process.exit(0)
  }, 30000).unref()
}

main().catch(err => {
  emit({ type: 'error', message: String(err?.stack || err) })
  process.exit(1)
})
