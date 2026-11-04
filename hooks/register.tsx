import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { LassoClip, LassoLang, LassoServer } from '../types'

// Change the tag when a clip's fields change: it declines what an earlier
// version stored, which outlives a reload.
const clips = atom({ plugin: 'lasso', key: 'clips' } as const, [], { shape: 'clips-1' })
const server = atom({ plugin: 'lasso', key: 'server' } as const, null)
const promptLang = atom({ plugin: 'lasso', key: 'promptLang' } as const, null)

const OPEN_TOOL = 'mcp__lasso__open'
const PANE_TOOL = 'mcp__Claude_Browser__preview_start'
const PERSON = new Set<string>(['composer', 'sdk', 'bridge'])
const VIEWABLE =/\.(pdf|png|jpe?g|gif|webp|bmp|svg|avif)$/i

type Opened = { id: string; name: string; kind: 'pdf' | 'image'; path: string; url: string }

// --- language: Claude's `language` setting, else the language the person writes in

const STRINGS = {
  zh: {
    starting: 'Lasso 服务还在启动，稍等几秒再试。',
    cannotOpen: (why: string) => `打不开：${why}`,
    usage: '用法：/lasso <文件.pdf|图片> [页码]　·　/lasso clear 清空待发送摘录　·　/lasso shell 加入右键菜单',
    cleared: '已清空待发送的摘录。',
    shellLabel: '用 Lasso 打开',
    shellOn:
      '已在资源管理器中加入「用 Lasso 打开」（PDF 和图片）：右键文件 →「显示更多选项」→「用 Lasso 打开」。\n' +
      '想双击就打开：右键 →「打开方式」→「选择其他应用」→ Lasso → 勾选「始终」。/lasso unshell 可移除。',
    shellOff: '已从资源管理器移除「用 Lasso 打开」。',
    shellFailed: (why: string) => `设置右键菜单失败：${why}`,
    shellWindowsOnly: '右键菜单目前只支持 Windows。',
    openingPane: (name: string) => `正在内置浏览器面板中打开 ${name}…`,
    openedBrowser: (name: string, url: string) => `已在浏览器中打开 ${name}：${url}`,
    openManually: (name: string, url: string) => `请在浏览器中打开 ${name}：${url}`,
    hint: '圈选（L）或选中文字后点「添加到对话」，摘录会随你的下一条消息发送。',
    askPane: (url: string) => `在内置浏览器面板中打开 Lasso 阅读器：${url}`,
    region: '圈选',
    text: '文字',
    regionLong: '圈选区域',
    textLong: '选中文字',
    page: (n: number) => `第 ${n} 页`,
    added: (label: string) => `已添加到对话：${label}（随下一条消息发送）`,
    changed: (name: string) => `${name} 已在磁盘上被修改，可在阅读器中点「刷新」`,
    failed: 'Lasso 服务启动失败，详见调试日志',
    stopped: 'Lasso 服务已停止（需要 Node.js）',
    band: '摘录 · 随下一条消息发送:',
    clear: '清空',
    send: '发送',
    sent: (n: number) => `已把 ${n} 条摘录发送给 Claude`,
    lookAt: '请看这些摘录：',
    shot: '截图',
    note: '备注',
    body: '文本',
  },
  en: {
    starting: 'Lasso is still starting; try again in a few seconds.',
    cannotOpen: (why: string) => `Cannot open: ${why}`,
    usage: 'Usage: /lasso <file.pdf|image> [page]  ·  /lasso clear drops pending clips  ·  /lasso shell adds it to the right-click menu',
    cleared: 'Pending clips cleared.',
    shellLabel: 'Open with Lasso',
    shellOn:
      'Added "Open with Lasso" to Explorer for PDFs and images: right-click a file → Show more options → Open with Lasso.\n' +
      'To open on double-click: right-click → Open with → Choose another app → Lasso → Always. /lasso unshell removes it.',
    shellOff: 'Removed "Open with Lasso" from Explorer.',
    shellFailed: (why: string) => `Could not set up the right-click menu: ${why}`,
    shellWindowsOnly: 'The right-click menu is Windows-only for now.',
    openingPane: (name: string) => `Opening ${name} in the built-in browser pane…`,
    openedBrowser: (name: string, url: string) => `Opened ${name} in your browser: ${url}`,
    openManually: (name: string, url: string) => `Open ${name} in a browser: ${url}`,
    hint: 'Circle (L) or select text, then "Add to chat": clips go with your next message.',
    askPane: (url: string) => `Open the Lasso reader in the built-in browser pane: ${url}`,
    region: 'region',
    text: 'text',
    regionLong: 'circled region',
    textLong: 'selected text',
    page: (n: number) => `page ${n}`,
    added: (label: string) => `Added to chat: ${label} (sent with your next message)`,
    changed: (name: string) => `${name} changed on disk; press Refresh in the reader`,
    failed: 'The Lasso server failed to start; see the debug log',
    stopped: 'The Lasso server stopped (it needs Node.js)',
    band: 'Clips · sent with your next message:',
    clear: 'Clear',
    send: 'Send',
    sent: (n: number) => `Sent ${n} clip${n === 1 ? '' : 's'} to Claude`,
    lookAt: 'Please look at these clips:',
    shot: 'Screenshot',
    note: 'Note',
    body: 'Text',
  },
} as const

const fromSetting = (value: unknown): LassoLang | null => {
  if (typeof value !== 'string' || !value.trim() || value === 'auto') return null
  return /zh|chinese|中文|汉|漢|mandarin|cantonese/i.test(value) ? 'zh' : 'en'
}

const fromText = (text: string): LassoLang | null => {
  const letters = text.replace(/\s|[\p{P}\p{S}\d]/gu, '')
  if (letters.length < 2) return null
  const han = (letters.match(/\p{Script=Han}/gu) ?? []).length
  return han / letters.length > 0.2 ? 'zh' : 'en'
}

async function langOf($: EngineInterface): Promise<LassoLang> {
  const setting = await $.settings.read({ key: 'language' }).catch(() => undefined)
  return fromSetting(setting) ?? (await read($, promptLang)) ?? 'en'
}

const isImage = (clip: LassoClip) => !/\.pdf$/i.test(clip.name)

const label = (clip: LassoClip, lang: LassoLang) =>
  `${clip.name.replace(/\.[a-z0-9]+$/i, '')}${isImage(clip) ? '' : ` p.${clip.page}`} ` +
  (clip.kind === 'region' ? STRINGS[lang].region : STRINGS[lang].text)

// What the model reads, appended under the person's own prompt.
function formatClips(list: LassoClip[], lang: LassoLang) {
  const s = STRINGS[lang]
  const blocks = list.map((clip, i) => {
    const where = isImage(clip) ? '' : ` · ${s.page(clip.page)}`
    const lines = [
      `[${i + 1}] ${clip.name}${where} · ${clip.kind === 'region' ? s.regionLong : s.textLong}`,
      `File: ${clip.path}`,
    ]
    if (clip.image) lines.push(`${s.shot}: @${clip.image}`)
    if (clip.note) lines.push(`${s.note}: ${clip.note}`)
    if (clip.text) lines.push(`${s.body}:`, ...clip.text.split('\n').map(line => `> ${line}`))
    return lines.join('\n')
  })

  return `<lasso-clips>\n${blocks.join('\n\n')}\n</lasso-clips>`
}

// --- the server ----------------------------------------------------------------

async function api($: EngineInterface, path: string, body?: unknown) {
  const srv = await read($, server)
  if (!srv) return undefined
  return $.http
    .fetch(`http://127.0.0.1:${srv.port}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'X-Token': srv.token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    .catch((err: unknown) => ({ ok: false, status: 0, text: String(err) }))
}

async function pushLang($: EngineInterface) {
  await api($, '/api/lang', { lang: await langOf($) })
}

async function openDoc($: EngineInterface, given: string, page?: number): Promise<Opened | string> {
  const s = STRINGS[await langOf($)]
  const res = await api($, '/api/open', { path: given, cwd: await $.session.cwd() })
  if (!res) return s.starting
  if (!res.ok) {
    let reason = res.text
    try {
      reason = JSON.parse(res.text).error ?? reason
    } catch {}
    return s.cannotOpen(reason)
  }
  const opened = JSON.parse(res.text) as Opened
  await $.store.set('lastPath', opened.path)

  return { ...opened, url: page && opened.kind === 'pdf' ? `${opened.url}#page=${page}` : opened.url }
}

const hasPane = async ($: EngineInterface) =>
  (await $.tool.list().catch(() => [])).some(tool => tool.name === PANE_TOOL)

// Where the desktop app's browser pane is missing (a terminal), the system browser.
async function openInSystemBrowser($: EngineInterface, url: string) {
  const isWindows = /^[A-Za-z]:[\\/]/.test($.plugin.root)
  const tries = isWindows ? [['rundll32', 'url.dll,FileProtocolHandler', url]] : [['open', url], ['xdg-open', url]]
  for (const argv of tries) {
    const ran = await $.process.run(argv).catch(() => undefined)
    if (ran?.exitCode === 0) return true
  }
  return false
}

// Every waiting clip, sent to Claude now as a prompt of its own (it runs once
// the session is idle); each clip's note is its question.
async function sendClips($: EngineInterface) {
  const list = await read($, clips)
  if (list.length === 0) return
  await update($, clips, () => [])
  const lang = await langOf($)
  const asked = list.map(clip => clip.note).filter(Boolean).join('\n')
  void $.prompt.submit({ text: `${asked || STRINGS[lang].lookAt}\n\n${formatClips(list, lang)}` })
  $.ui.toast(STRINGS[lang].sent(list.length))
}

async function onServerLine($: EngineInterface, line: string) {
  let msg: { type?: string; [k: string]: unknown }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const lang = await langOf($)
  const s = STRINGS[lang]
  if (msg.type === 'ready') {
    await update($, server, () => ({ port: msg.port, token: msg.token }) as LassoServer)
    await pushLang($)
  } else if (msg.type === 'clip') {
    const clip = msg.clip as LassoClip
    await update($, clips, list => [...list, clip].slice(-20))
    if (msg.send === true) await sendClips($)
    else $.ui.toast(s.added(label(clip, lang)))
  } else if (msg.type === 'open-request') {
    // a file opened from Explorer's "Open with Lasso": Claude brings it into the pane
    $.ui.toast(s.openingPane(String(msg.name)))
    if (await hasPane($)) void $.prompt.submit({ text: s.askPane(String(msg.url)) })
    else await openInSystemBrowser($, String(msg.url))
  } else if (msg.type === 'changed') {
    $.ui.toast(s.changed(String(msg.name)), { timeoutMs: 6000 })
  } else if (msg.type === 'error') {
    $.ui.log(`lasso server: ${msg.message}`, { to: 'debug' })
    $.ui.toast(s.failed)
  }
}

// One server per session, restarted on a crash; a reload of the mod kills it
// with the module and starts it again on the same port and token.
async function runServer($: EngineInterface) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const prev = await read($, server)
    const token = prev?.token ?? randomToken()
    const argv = [
      'node',
      `${$.plugin.root}/app/server.mjs`,
      '--token',
      token,
      '--port',
      String(prev?.port ?? 0),
      '--lang',
      await langOf($),
    ]
    let buffer = ''
    try {
      for await (const { stream, text } of $.process.spawn({ argv })) {
        if (stream !== 'stdout') {
          $.ui.log(`lasso server: ${text}`, { to: 'debug' })
          continue
        }
        buffer += text
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) if (line.trim()) await onServerLine($, line)
      }
    } catch (err) {
      $.ui.log(`lasso server: ${String(err)}`, { to: 'debug' })
    }
    await $.clock.sleep(1500)
  }
  await update($, server, () => null)
  $.ui.toast(STRINGS[await langOf($)].stopped)
}

function randomToken() {
  let out = ''
  for (let i = 0; i < 32; i++) out += Math.floor(Math.random() * 16).toString(16)
  return out
}

// --- Explorer: "Open with Lasso" on PDFs and images (Windows, this user only) --------

async function shellMenu($: EngineInterface, isOn: boolean) {
  const s = STRINGS[await langOf($)]
  if (!/^[A-Za-z]:[\\/]/.test($.plugin.root)) return s.shellWindowsOnly
  const where = await $.process.run(['where', 'node']).catch(() => undefined)
  const node = where?.stdout.split(/\r?\n/).find(line => line.trim().toLowerCase().endsWith('node.exe'))?.trim()
  if (isOn && !node) return s.shellFailed('node.exe not found on PATH')
  const root = $.plugin.root.replace(/\//g, '\\')
  const ran = await $.process
    .run([
      'powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', `${root}\\app\\shell.ps1`,
      '-Action', isOn ? 'install' : 'uninstall',
      '-Root', root,
      '-Node', node ?? '',
      '-Label', s.shellLabel,
    ])
    .catch((err: unknown) => ({ exitCode: 1, stdout: '', stderr: String(err) }))
  if (ran.exitCode !== 0) return s.shellFailed((ran.stderr || ran.stdout).trim().slice(0, 400))

  return isOn ? s.shellOn : s.shellOff
}

// --- the default viewer for PDFs and images ----------------------------------------

// Other ways Claude might show a file to the person; a local PDF or image goes
// to Lasso instead. A remote URL is left alone: Lasso opens local files.
const OTHER_VIEWERS = /__(display_pdf|preview_start|navigate|show_pane|open_in_editor)$/

function localFileIn(input: Record<string, unknown>): string | undefined {
  for (const value of Object.values(input)) {
    if (typeof value !== 'string') continue
    const text = value.trim().replace(/#.*$/, '')
    if (!VIEWABLE.test(text) || /^https?:/i.test(text)) continue
    return decodeURIComponent(text.replace(/^file:\/\/\/?/i, ''))
  }
  return undefined
}

// A PDF or image the person names in a prompt (an @mention, or a full path)
// opens in Lasso as they send it; Claude is asked to bring it into the pane.
const MENTIONED = /@"([^"]+)"|@(\S+)|([A-Za-z]:[\\/][^\s"'<>|*?]+|~[\\/][^\s"'<>|*?]+)/g

async function openMentioned($: EngineInterface, text: string): Promise<string[]> {
  const paths = [...text.matchAll(MENTIONED)]
    .map(m => (m[1] ?? m[2] ?? m[3] ?? '').replace(/[),.;:!?，。；：！？）]+$/u, ''))
    .filter(path => VIEWABLE.test(path))
  const notes: string[] = []
  const pane = paths.length > 0 && (await hasPane($))
  for (const path of [...new Set(paths)].slice(0, 3)) {
    const opened = await openDoc($, path)
    if (typeof opened === 'string') continue
    notes.push(
      pane
        ? `Lasso, the user's default viewer, opened ${opened.name} at ${opened.url}. Show it beside the chat ` +
            `first: ${PANE_TOOL} with url "${opened.url}" (or mcp__Claude_Browser__navigate a tab already on Lasso).`
        : `Lasso, the user's default viewer, opened ${opened.name} at ${opened.url}.`,
    )
  }
  return notes
}

const DEFAULT_VIEWER_NOTE =
  `The user's default viewer for local PDFs and images (png, jpg, gif, webp, bmp, svg) is the Lasso mod. ` +
  `To open or show one to the user, call ${OPEN_TOOL} (it returns the reader's URL), then open that URL with ` +
  `${PANE_TOOL} so it sits beside the chat (or mcp__Claude_Browser__navigate a tab already on the reader). ` +
  `Do not use display_pdf, file:// URLs or other viewers for them. Reading a file for yourself is still the Read tool.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // start the server first: a refused registration must not leave the
    // reader without one
    void runServer($)
    await $.command
      .register({
        name: 'lasso',
        description: 'Open a PDF or image in Lasso: circle or select, add to chat',
        argumentHint: '<file.pdf|image> [page] | clear | shell',
      })
      .catch((err: unknown) => $.ui.log(`lasso: /lasso not registered: ${String(err)}`, { to: 'debug' }))
    await $.tool.register({
      name: 'open',
      description:
        "Open a local PDF or image in the user's default viewer, Lasso (a reader beside the chat where they " +
        'circle regions or select text and add them to the chat), optionally at a PDF page. Returns its URL: ' +
        `then open it with ${PANE_TOOL} so it shows beside the chat. Use whenever the user asks to open, show, ` +
        'view or read a PDF or an image.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path, or relative to the working directory' },
          page: { type: 'number', description: 'PDF page to show, from 1' },
        },
        required: ['path'],
      },
      isDeferred: false,
    })
    // keep the server alive while the session lives
    $.clock.every(60_000, () => void api($, '/api/ping'))

    return started
  })

  on('prompt.compose', async ($, e, next) => {
    const { sections } = await next(e)
    return { sections: [...sections, { id: 'lasso:default-viewer', text: DEFAULT_VIEWER_NOTE, scope: 'session' }] }
  })

  on('command.run', { command: 'lasso' }, async ($, e) => {
    const s = STRINGS[await langOf($)]
    // `@file.pdf` is how a file is named in a prompt; take it the same way here
    const args = e.args.trim().replace(/^@/, '')
    if (args === 'clear') {
      await update($, clips, () => [])
      return { text: s.cleared }
    }
    if (args === 'shell' || args === 'unshell') return { text: await shellMenu($, args === 'shell') }
    const match = args.match(/^(?:"([^"]+)"|'([^']+)'|(.+?))(?:\s+(\d+))?$/)
    const given = match ? (match[1] ?? match[2] ?? match[3]) : ''
    const page = match?.[4] ? Number(match[4]) : undefined
    const target = given || ((await $.store.get('lastPath')) as string | undefined)
    if (!target) return { text: s.usage }

    const opened = await openDoc($, target, page)
    if (typeof opened === 'string') return { text: opened }
    if (await hasPane($)) {
      // A plugin's own call to the pane is refused under auto mode (no request
      // asked for it), so Claude opens it, asked in a turn of its own.
      void $.prompt.submit({ text: s.askPane(opened.url) })
      return { text: `${s.openingPane(opened.name)}\n${s.hint}` }
    }
    const shown = await openInSystemBrowser($, opened.url)
    return { text: `${shown ? s.openedBrowser(opened.name, opened.url) : s.openManually(opened.name, opened.url)}\n${s.hint}` }
  })

  // The MCP tool table connected here (hundreds of tools) is too deep for tsc
  // to narrow a matcher over, and this tool is in it only once it registered.
  // @ts-ignore TS2589
  on('tool.call', { tool: OPEN_TOOL }, async ($: EngineInterface, e: unknown) => {
    const input = e as { path: string; page?: number }
    const opened = await openDoc($, input.path, input.page)
    if (typeof opened === 'string') return { result: opened }
    if (!(await hasPane($))) {
      const shown = await openInSystemBrowser($, opened.url)
      return { result: `${shown ? 'Opened' : 'Could not open'} ${opened.name} in the system browser: ${opened.url}` }
    }

    return {
      result:
        `Lasso has ${opened.name} ready at ${opened.url}. Now show it beside the chat: call ${PANE_TOOL} ` +
        `with url "${opened.url}" (or mcp__Claude_Browser__navigate a tab already on the reader). ` +
        `Don't read the file unless the user asks.`,
    }
  })

  // @ts-ignore TS2589 (as above)
  on('tool.call', { tool: OTHER_VIEWERS }, async ($: EngineInterface, e: { tool: string }, next: (e: unknown) => unknown) => {
    const file = localFileIn(e as unknown as Record<string, unknown>)
    if (!file) return next(e)

    return { deny: `The user's default viewer for PDFs and images is Lasso: call ${OPEN_TOOL} with path "${file}" instead.` }
    // @ts-ignore TS2589 (as above)
  }).catch(($: EngineInterface, e: unknown, next: (e: unknown) => unknown) => next(e))

  // Clips ride along with the person's next prompt, as context chips;
  // the prompt's language is also what the reader speaks while no setting says.
  on('prompt.submit', async ($, e, next) => {
    // what the person typed: the terminal's composer, the desktop app (sdk), a remote bridge
    if (e.command || e.isMeta || !PERSON.has(e.origin.kind)) return next(e)
    const spoken = fromText(e.text)
    if (spoken && spoken !== (await read($, promptLang))) {
      await update($, promptLang, () => spoken)
      void pushLang($)
    }
    const context = [...(e.context ?? []), ...(await openMentioned($, e.text))]
    const list = await read($, clips)
    if (list.length === 0) return next(context.length ? { ...e, context } : e)
    await update($, clips, () => [])
    const lang = await langOf($)
    const text = e.text.trim()
      ? `${e.text}\n\n${formatClips(list, lang)}`
      : `${STRINGS[lang].lookAt}\n\n${formatClips(list, lang)}`

    return next({ ...e, text, ...(context.length ? { context } : {}) })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, clips)
    if (list.length === 0 || e.props.hasSurvey) return next(e)
    const lang = await langOf($)
    const { Box, Button, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="row" flexWrap="wrap" gap={1}>
        <Text dimColor>{STRINGS[lang].band}</Text>
        {list.map(clip => (
          <Button
            key={`clip-${clip.id}`}
            label={`${label(clip, lang)} ×`}
            onPress={() => update($, clips, all => all.filter(one => one.id !== clip.id))}
          />
        ))}
        <Button key="send" variant="primary" label={STRINGS[lang].send} onPress={() => sendClips($)} />
        <Button key="clear" label={STRINGS[lang].clear} onPress={() => update($, clips, () => [])} />
      </Box>
    )
  })
}
