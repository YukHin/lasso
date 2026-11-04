// Explorer's "Open with Lasso": node open.mjs <file>
// Hands the file to the running Lasso server, whose Claude session shows it in
// the built-in browser pane; with no session running, starts a standalone
// server and opens the reader in the system browser.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOME = process.env.LASSO_HOME || path.join(os.homedir(), '.claude', 'lasso')
const SERVER_FILE = path.join(HOME, 'server.json')
const file = path.resolve(process.argv[2] || '')

async function handOver() {
  const record = JSON.parse(fs.readFileSync(SERVER_FILE, 'utf8'))
  const res = await fetch(`http://127.0.0.1:${record.port}/api/open`, {
    method: 'POST',
    headers: { 'X-Token': record.token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: file, reveal: !record.standalone }),
    signal: AbortSignal.timeout(2500),
  })
  if (!res.ok) throw new Error(await res.text())
  return { record, opened: await res.json() }
}

function openInBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]]
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function main() {
  let handed = await handOver().catch(() => null)
  if (!handed) {
    // no server answers (no session, or a stale record): start one of our own
    spawn(process.execPath, [path.join(HERE, 'server.mjs'), '--standalone', '1'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref()
    for (let i = 0; i < 40 && !handed; i++) {
      await new Promise(r => setTimeout(r, 250))
      handed = await handOver().catch(() => null)
    }
  }
  if (!handed) throw new Error('the Lasso server did not start')
  // a session's mod brings it into the pane; standalone, the system browser shows it
  if (handed.record.standalone) openInBrowser(handed.opened.url)
}

main().catch(err => {
  fs.mkdirSync(HOME, { recursive: true })
  fs.appendFileSync(path.join(HOME, 'open-errors.log'), `${new Date().toISOString()} ${file}: ${err?.stack || err}\n`)
  process.exit(1)
})
