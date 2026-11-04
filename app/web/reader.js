// Lasso reader: PDFs through pdf.js, images through a plain zoomable view;
// circled regions and selected text go to the Claude Code session.
const { token, docId, name, kind } = window.READER
let lang = window.READER.lang === 'zh' ? 'zh' : 'en'
const headers = { 'X-Token': token }
const $ = id => document.getElementById(id)
const container = $('viewerContainer')

// --- language: whatever the mod says Claude speaks -----------------------------

const I18N = {
  zh: {
    prev: '上一页 (←)', next: '下一页 (→)', page: '页码',
    zoomOut: '缩小 (Ctrl -)', zoomIn: '放大 (Ctrl +)', fit: '适应 (Ctrl 0)',
    toolText: '文字', toolTextTitle: '选择文字 (V)',
    toolPan: '移动', toolPanTitle: '拖动画面 (V)',
    toolLasso: '圈选', toolLassoTitle: '圈选区域 (L)，按住 Shift 拉矩形',
    find: '搜索 (Ctrl F)', findNone: '无结果', conn: '与 Claude 会话的连接',
    changed: at => `文件已在磁盘上被修改（${at}）`, refresh: '刷新 (R)', dismiss: '忽略',
    notePh: '想问什么？（Enter 发送，Ctrl+Enter 只添加，Shift+Enter 换行）', cancel: '取消',
    add: '添加', addTitle: '先放进对话，随下一条消息一起发送 (Ctrl+Enter)',
    send: '发送', sendTitle: '马上发给 Claude (Enter)', sent: '已发送给 Claude ✓',
    metaRegion: n => `第 ${n} 页 · 圈选区域`, metaText: n => `第 ${n} 页 · 选中文字`, metaImage: '图片 · 圈选区域',
    noText: '（此区域没有可提取的文字，将只发送截图）', imageOnly: '将发送这块区域的截图',
    added: '已添加到对话 ✓', refreshed: '已刷新',
    refreshFailed: m => `刷新失败：${m}`, captureFailed: m => `截取失败：${m}`,
    addFailed: m => `添加失败：${m}`, openFailed: m => `打开失败：${m}`,
  },
  en: {
    prev: 'Previous page (←)', next: 'Next page (→)', page: 'Page',
    zoomOut: 'Zoom out (Ctrl -)', zoomIn: 'Zoom in (Ctrl +)', fit: 'Fit (Ctrl 0)',
    toolText: 'Text', toolTextTitle: 'Select text (V)',
    toolPan: 'Pan', toolPanTitle: 'Drag to move around (V)',
    toolLasso: 'Circle', toolLassoTitle: 'Circle a region (L); hold Shift for a rectangle',
    find: 'Find (Ctrl F)', findNone: 'No matches', conn: 'Connection to the Claude session',
    changed: at => `The file changed on disk (${at})`, refresh: 'Refresh (R)', dismiss: 'Dismiss',
    notePh: 'Ask something (Enter sends, Ctrl+Enter only adds, Shift+Enter for a new line)', cancel: 'Cancel',
    add: 'Add', addTitle: 'Put it in the chat, sent with your next message (Ctrl+Enter)',
    send: 'Send', sendTitle: 'Send it to Claude now (Enter)', sent: 'Sent to Claude ✓',
    metaRegion: n => `Page ${n} · circled region`, metaText: n => `Page ${n} · selected text`, metaImage: 'Image · circled region',
    noText: '(no text to extract here; the screenshot alone is sent)', imageOnly: 'A screenshot of this region is sent',
    added: 'Added to chat ✓', refreshed: 'Refreshed',
    refreshFailed: m => `Refresh failed: ${m}`, captureFailed: m => `Capture failed: ${m}`,
    addFailed: m => `Add failed: ${m}`, openFailed: m => `Could not open: ${m}`,
  },
}
const t = (key, ...rest) => {
  const value = I18N[lang][key] ?? I18N.en[key]
  return typeof value === 'function' ? value(...rest) : value
}

let bannerMtime = null
function applyLang() {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
  for (const el of document.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n)
  for (const el of document.querySelectorAll('[data-i18n-title]')) el.title = t(el.dataset.i18nTitle)
  for (const el of document.querySelectorAll('[data-i18n-ph]')) el.placeholder = t(el.dataset.i18nPh)
  for (const el of document.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel))
  if (bannerMtime !== null) $('bannerText').textContent = t('changed', new Date(bannerMtime).toLocaleTimeString())
}

document.body.classList.add(`kind-${kind}`)
if (kind === 'image') {
  $('toolText').dataset.i18n = 'toolPan'
  $('toolText').dataset.i18nTitle = 'toolPanTitle'
}
$('docName').textContent = name
$('docName').title = name
applyLang()

// --- small helpers -------------------------------------------------------------

const store = {
  get(key) {
    try { return JSON.parse(localStorage.getItem(key)) } catch { return null }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)) } catch {}
  },
}

let toastTimer
function toast(text, ms = 2200) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => (el.hidden = true), ms)
}

const isTyping = e => /^(INPUT|TEXTAREA)$/.test(e.target.tagName)

async function fetchFile() {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`/api/doc/${docId}/file`, { headers })
    if (res.ok) return res
    if (res.status !== 409 || attempt > 5) throw new Error(`${res.status} ${await res.text()}`)
    await new Promise(r => setTimeout(r, 400)) // mid-rewrite: try again
  }
}

function bounds(points) {
  const xs = points.map(p => p[0])
  const ys = points.map(p => p[1])
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) }
}

function inside([x, y], poly) {
  let hit = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]
    const [xj, yj] = poly[j]
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function strokeOutline(ctx, pts, width) {
  ctx.strokeStyle = 'rgba(217, 119, 87, 0.95)'
  ctx.lineWidth = width
  ctx.lineJoin = ctx.lineCap = 'round'
  ctx.beginPath()
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)))
  ctx.closePath()
  ctx.stroke()
}

// --- the PDF engine: pdf.js's own viewer -----------------------------------------

async function pdfEngine() {
  const pdfjsLib = await import('/vendor/build/pdf.mjs')
  globalThis.pdfjsLib = pdfjsLib
  pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs'
  const { PDFViewer, EventBus, PDFLinkService, PDFFindController } = await import('/vendor/web/pdf_viewer.mjs')

  const eventBus = new EventBus()
  const linkService = new PDFLinkService({ eventBus })
  const findController = new PDFFindController({ eventBus, linkService })
  const viewer = new PDFViewer({ container, viewer: $('viewer'), eventBus, linkService, findController, enableHWA: true })
  linkService.setViewer(viewer)

  let pdfDoc = null
  let restore = null
  let deferredInit = null
  const textCache = new Map()

  async function load(keepView) {
    restore = keepView && pdfDoc
      ? { scale: viewer.currentScaleValue, top: container.scrollTop, left: container.scrollLeft }
      : null
    const data = new Uint8Array(await (await fetchFile()).arrayBuffer())
    // pdf.js 5.4 keeps one page map for every document: resetting the viewer
    // after the new document has loaded zeroes the new one's page count, so
    // let go of the old document first (the bytes are already here, so this
    // blanks the view only for the parse)
    if (pdfDoc) {
      const old = pdfDoc
      pdfDoc = null
      viewer.setDocument(null)
      linkService.setDocument(null)
      await old.destroy()
    }
    pdfDoc = await pdfjsLib.getDocument({
      data,
      cMapUrl: '/vendor/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/vendor/standard_fonts/',
      wasmUrl: '/vendor/wasm/',
      iccUrl: '/vendor/iccs/',
    }).promise
    textCache.clear()
    deferredInit = null
    viewer.setDocument(pdfDoc)
    linkService.setDocument(pdfDoc, null)
    $('pageCount').textContent = `/ ${pdfDoc.numPages}`
  }

  // A pane opened in the background lays out at zero width: fit once it has
  // room, and refit a fitted scale whenever the pane is resized.
  new ResizeObserver(() => {
    if (!pdfDoc || container.clientWidth < 50) return
    if (deferredInit) {
      const run = deferredInit
      deferredInit = null
      run()
      return
    }
    const preset = viewer.currentScaleValue
    if (preset === 'page-width' || preset === 'page-fit' || preset === 'auto') viewer.currentScaleValue = preset
  }).observe(container)

  eventBus.on('pagesinit', () => {
    if (container.clientWidth < 50) deferredInit = initView
    else initView()
  })

  function initView() {
    if (restore) {
      viewer.currentScaleValue = restore.scale
      const { top, left } = restore
      const apply = () => {
        container.scrollTop = top
        container.scrollLeft = left
      }
      // pdf.js scrolls to the first page as it lays the new document out;
      // put the reader back where they were once that has happened
      requestAnimationFrame(apply)
      const once = () => {
        eventBus.off('pagerendered', once)
        apply()
      }
      eventBus.on('pagerendered', once)
      restore = null
      return
    }
    viewer.currentScaleValue = store.get(`scale:${docId}`) || 'page-width'
    const page = Number(new URLSearchParams(location.hash.slice(1)).get('page'))
    if (page) viewer.currentPageNumber = page
    else if (store.get(`page:${docId}`)) viewer.currentPageNumber = store.get(`page:${docId}`)
    $('pageInput').value = viewer.currentPageNumber
  }

  eventBus.on('pagechanging', ({ pageNumber }) => {
    $('pageInput').value = pageNumber
    store.set(`page:${docId}`, pageNumber)
  })
  eventBus.on('scalechanging', ({ scale, presetValue }) => {
    $('zoomLabel').textContent = `${Math.round(scale * 100)}%`
    if (scale > 0) store.set(`scale:${docId}`, presetValue || scale)
    closePopover() // its outline no longer matches the page
  })

  $('prevPage').onclick = () => viewer.previousPage()
  $('nextPage').onclick = () => viewer.nextPage()
  $('pageInput').onchange = e => {
    const n = Number(e.target.value)
    if (pdfDoc && n >= 1 && n <= pdfDoc.numPages) viewer.currentPageNumber = n
    else e.target.value = viewer.currentPageNumber
  }

  function find(type, findPrevious = false) {
    eventBus.dispatch('find', {
      source: null,
      type,
      query: $('findInput').value,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious,
      matchDiacritics: false,
    })
  }
  $('findInput').addEventListener('input', () => find(''))
  $('findInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') find('again', e.shiftKey)
    if (e.key === 'Escape') {
      e.target.value = ''
      find('')
      container.focus()
    }
  })
  eventBus.on('updatefindmatchescount', ({ matchesCount }) => {
    $('findStatus').textContent = matchesCount.total ? `${matchesCount.current}/${matchesCount.total}` : ''
  })
  eventBus.on('updatefindcontrolstate', ({ state, matchesCount }) => {
    if (state === 1) $('findStatus').textContent = $('findInput').value ? t('findNone') : ''
    else if (matchesCount?.total) $('findStatus').textContent = `${matchesCount.current}/${matchesCount.total}`
  })

  async function textContent(page) {
    if (!textCache.has(page.pageNumber)) textCache.set(page.pageNumber, page.getTextContent())
    return textCache.get(page.pageNumber)
  }

  return {
    load,
    canSelectText: true,
    zoomIn: () => viewer.increaseScale({ drawingDelay: 300 }),
    zoomOut: () => viewer.decreaseScale({ drawingDelay: 300 }),
    zoomBy: (scaleFactor, origin) => viewer.updateScale({ scaleFactor, origin, drawingDelay: 250 }),
    fit: () => (viewer.currentScaleValue = 'page-width'),
    nextPage: () => viewer.nextPage(),
    previousPage: () => viewer.previousPage(),

    pageAt(el) {
      const div = el?.closest?.('.page')
      if (!div) return null
      const number = Number(div.dataset.pageNumber)
      const view = viewer.getPageView(number - 1)
      return view?.pdfPage ? { div, number, view, width: view.viewport.width, height: view.viewport.height } : null
    },

    // Text whose glyph boxes have their center inside the outline, in reading order.
    async textIn({ view }, poly) {
      const { items } = await textContent(view.pdfPage)
      const vp = view.viewport
      let out = ''
      let lastY = null
      for (const item of items) {
        if (!item.str) {
          if (item.hasEOL && out && !out.endsWith('\n')) out += '\n'
          continue
        }
        const tx = pdfjsLib.Util.transform(vp.transform, item.transform)
        const height = Math.hypot(tx[2], tx[3])
        const angle = Math.atan2(tx[1], tx[0])
        const width = item.width * vp.scale
        const cx = tx[4] + (Math.cos(angle) * width) / 2 + Math.sin(angle) * (height / 2)
        const cy = tx[5] + (Math.sin(angle) * width) / 2 - Math.cos(angle) * (height / 2)
        if (!inside([cx, cy], poly)) continue
        if (lastY !== null && Math.abs(cy - lastY) > height * 0.8 && !out.endsWith('\n')) out += '\n'
        out += item.str
        if (item.hasEOL) out += '\n'
        lastY = cy
      }
      return out.replace(/[ \t]+\n/g, '\n').trim()
    },

    // Renders the outlined region afresh at print resolution, outline on top.
    async capture({ view }, poly, drawOutline) {
      const page = view.pdfPage
      const pdfPoly = poly.map(([x, y]) => view.viewport.convertToPdfPoint(x, y))
      let scale = 3
      let vp, box
      for (;;) {
        vp = page.getViewport({ scale, rotation: view.viewport.rotation })
        const pts = pdfPoly.map(([x, y]) => vp.convertToViewportPoint(x, y))
        const b = bounds(pts)
        const pad = 6 * scale
        box = {
          pts,
          x: Math.max(0, Math.floor(b.x0 - pad)),
          y: Math.max(0, Math.floor(b.y0 - pad)),
          x1: Math.min(vp.width, Math.ceil(b.x1 + pad)),
          y1: Math.min(vp.height, Math.ceil(b.y1 + pad)),
        }
        if ((box.x1 - box.x) * (box.y1 - box.y) <= 12e6 || scale <= 1) break
        scale /= 1.5
      }
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, box.x1 - box.x)
      canvas.height = Math.max(1, box.y1 - box.y)
      const ctx = canvas.getContext('2d')
      ctx.fillStyle = '#fff'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvasContext: ctx, viewport: vp, transform: [1, 0, 0, 1, -box.x, -box.y] }).promise
      if (drawOutline) strokeOutline(ctx, box.pts.map(([x, y]) => [x - box.x, y - box.y]), 1.2 * scale)
      return canvas.toDataURL('image/png')
    },
  }
}

// --- the image engine: one picture, zoomed around the pointer --------------------

function imageEngine() {
  const viewerEl = $('viewer')
  viewerEl.className = ''
  const page = document.createElement('div')
  page.className = 'imagePage page'
  page.dataset.pageNumber = '1'
  const img = document.createElement('img')
  img.alt = name
  img.draggable = false
  page.append(img)
  viewerEl.append(page)

  let natural = { w: 1, h: 1 }
  let scale = 1
  let preset = store.get(`scale:${docId}`) ?? 'fit'
  let objectUrl = null

  const fitScale = () =>
    Math.min(2, (container.clientWidth - 40) / natural.w, (container.clientHeight - 40) / natural.h)

  function setScale(next, origin) {
    next = Math.min(16, Math.max(0.05, next))
    // an outline drawn at the old zoom no longer matches; a refit to the same zoom keeps it
    if (Math.abs(next - scale) > 1e-4) closePopover()
    const [ox, oy] = origin ?? [container.clientWidth / 2, container.clientHeight / 2]
    const rect = container.getBoundingClientRect()
    const px = (container.scrollLeft + (ox - rect.left) - page.offsetLeft) / scale
    const py = (container.scrollTop + (oy - rect.top) - page.offsetTop) / scale
    scale = next
    page.style.width = `${natural.w * scale}px`
    page.style.height = `${natural.h * scale}px`
    if (origin) {
      container.scrollLeft = px * scale + page.offsetLeft - (ox - rect.left)
      container.scrollTop = py * scale + page.offsetTop - (oy - rect.top)
    }
    $('zoomLabel').textContent = `${Math.round(scale * 100)}%`
  }

  function applyPreset() {
    // a hidden pane has no size yet; the resize observer fits once it has one
    if (preset === 'fit' && container.clientWidth < 50) return
    if (preset === 'fit') setScale(fitScale())
    else setScale(Number(preset) || 1)
  }

  new ResizeObserver(() => {
    if (container.clientWidth >= 50 && preset === 'fit') applyPreset()
  }).observe(container)

  async function load(keepView) {
    const keep = keepView ? { top: container.scrollTop, left: container.scrollLeft } : null
    const blob = await (await fetchFile()).blob()
    const url = URL.createObjectURL(blob)
    // onload, not decode(): decode() waits while the pane is hidden
    const probe = new Image()
    await new Promise((resolve, reject) => {
      probe.onload = resolve
      probe.onerror = () => reject(new Error('cannot decode the image'))
      probe.src = url
    })
    natural = { w: probe.naturalWidth || 1024, h: probe.naturalHeight || 768 }
    img.src = url
    if (objectUrl) URL.revokeObjectURL(objectUrl)
    objectUrl = url
    applyPreset()
    if (keep) {
      container.scrollTop = keep.top
      container.scrollLeft = keep.left
    }
  }

  const zoom = (factor, origin) => {
    preset = String(scale * factor)
    setScale(scale * factor, origin)
    store.set(`scale:${docId}`, preset)
  }

  // drag to pan while the pan tool is on
  let pan = null
  container.addEventListener('pointerdown', e => {
    if (mode !== 'text' || e.button !== 0) return
    pan = { x: e.clientX, y: e.clientY, left: container.scrollLeft, top: container.scrollTop }
    container.setPointerCapture(e.pointerId)
    document.body.classList.add('panning')
  })
  container.addEventListener('pointermove', e => {
    if (!pan) return
    container.scrollLeft = pan.left - (e.clientX - pan.x)
    container.scrollTop = pan.top - (e.clientY - pan.y)
  })
  const endPan = () => {
    pan = null
    document.body.classList.remove('panning')
  }
  container.addEventListener('pointerup', endPan)
  container.addEventListener('pointercancel', endPan)

  return {
    load,
    canSelectText: false,
    zoomIn: () => zoom(1.25),
    zoomOut: () => zoom(1 / 1.25),
    zoomBy: (factor, origin) => zoom(factor, origin),
    fit: () => {
      preset = 'fit'
      store.set(`scale:${docId}`, preset)
      applyPreset()
    },
    nextPage() {},
    previousPage() {},
    pageAt: el => (el?.closest?.('.imagePage') ? { div: page, number: 1, width: page.clientWidth, height: page.clientHeight } : null),
    textIn: async () => '',

    // Cropped from the file's own pixels, not the screen's.
    async capture(region, poly, drawOutline) {
      const toNatural = natural.w / region.width
      const pad = 6 * toNatural
      const b = bounds(poly.map(([x, y]) => [x * toNatural, y * toNatural]))
      const sx = Math.max(0, Math.floor(b.x0 - pad))
      const sy = Math.max(0, Math.floor(b.y0 - pad))
      const sw = Math.max(1, Math.min(natural.w, Math.ceil(b.x1 + pad)) - sx)
      const sh = Math.max(1, Math.min(natural.h, Math.ceil(b.y1 + pad)) - sy)
      const k = Math.min(1, Math.sqrt(12e6 / (sw * sh)))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sw * k))
      canvas.height = Math.max(1, Math.round(sh * k))
      const ctx = canvas.getContext('2d')
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
      if (drawOutline) {
        const pts = poly.map(([x, y]) => [(x * toNatural - sx) * k, (y * toNatural - sy) * k])
        strokeOutline(ctx, pts, Math.max(2, 3 * toNatural * k))
      }
      return canvas.toDataURL('image/png')
    },
  }
}

// --- start the engine ------------------------------------------------------------

let mode = 'text'
let pending = null // the clip the popover offers
const engine = kind === 'image' ? imageEngine() : await pdfEngine()

async function refresh() {
  $('banner').hidden = true
  bannerMtime = null
  closePopover()
  try {
    await engine.load(true)
    toast(t('refreshed'))
  } catch (err) {
    toast(t('refreshFailed', err.message), 4000)
  }
}

// --- file change banner, language changes ----------------------------------------

function connect() {
  const source = new EventSource(`/api/doc/${docId}/events?t=${token}`)
  let seen = null
  source.addEventListener('hello', e => {
    $('conn').className = 'conn ok'
    const data = JSON.parse(e.data)
    // a change made while we were disconnected (or while the server restarted)
    if (seen !== null && data.mtimeMs !== seen) showBanner(data.mtimeMs)
    seen = data.mtimeMs
    if (data.lang && data.lang !== lang) {
      lang = data.lang
      applyLang()
    }
  })
  source.addEventListener('changed', e => {
    const { mtimeMs } = JSON.parse(e.data)
    seen = mtimeMs
    showBanner(mtimeMs)
  })
  source.addEventListener('lang', e => {
    lang = JSON.parse(e.data).lang === 'zh' ? 'zh' : 'en'
    applyLang()
  })
  source.onerror = () => ($('conn').className = 'conn bad')
}

function showBanner(mtimeMs) {
  bannerMtime = mtimeMs
  $('bannerText').textContent = t('changed', new Date(mtimeMs).toLocaleTimeString())
  $('banner').hidden = false
}
$('bannerRefresh').onclick = refresh
$('bannerDismiss').onclick = () => {
  $('banner').hidden = true
  bannerMtime = null
}

// --- toolbar and keys ------------------------------------------------------------

$('zoomIn').onclick = () => engine.zoomIn()
$('zoomOut').onclick = () => engine.zoomOut()
$('zoomLabel').onclick = () => engine.fit()

function setMode(next) {
  mode = next
  document.body.classList.toggle('mode-lasso', mode === 'lasso')
  document.body.classList.toggle('mode-text', mode === 'text')
  for (const btn of document.querySelectorAll('.tool')) btn.classList.toggle('active', btn.dataset.tool === mode)
  if (mode === 'lasso') window.getSelection()?.removeAllRanges()
}
for (const btn of document.querySelectorAll('.tool')) btn.onclick = () => setMode(btn.dataset.tool)
setMode(kind === 'image' ? 'lasso' : 'text')

// ctrl/cmd + wheel and trackpad pinch: zoom around the pointer, re-render once settled
let wheelFactor = 1
let wheelOrigin = null
let wheelFrame = 0
container.addEventListener('wheel', e => {
  if (!e.ctrlKey && !e.metaKey) return
  e.preventDefault()
  wheelFactor *= Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0018))
  wheelOrigin = [e.clientX, e.clientY]
  if (wheelFrame) return
  wheelFrame = requestAnimationFrame(() => {
    wheelFrame = 0
    if (Math.abs(wheelFactor - 1) > 0.01) engine.zoomBy(wheelFactor, wheelOrigin)
    wheelFactor = 1
  })
}, { passive: false })

window.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey
  if (mod && (e.key === 'f' || e.key === 'F') && kind === 'pdf') {
    e.preventDefault()
    $('findInput').focus()
    $('findInput').select()
    return
  }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); engine.zoomIn(); return }
  if (mod && e.key === '-') { e.preventDefault(); engine.zoomOut(); return }
  if (mod && e.key === '0') { e.preventDefault(); engine.fit(); return }
  if (isTyping(e) || mod || e.altKey) return
  if (e.key === 'Escape') closePopover()
  else if (e.key === 'l' || e.key === 'L') setMode(mode === 'lasso' ? 'text' : 'lasso')
  else if (e.key === 'v' || e.key === 'V' || e.key === 't' || e.key === 'T') setMode('text')
  else if ((e.key === 'r' || e.key === 'R') && !$('banner').hidden) refresh()
  else if (e.key === 'ArrowRight' && container.scrollWidth <= container.clientWidth) engine.nextPage()
  else if (e.key === 'ArrowLeft' && container.scrollWidth <= container.clientWidth) engine.previousPage()
})

// --- lasso -----------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg'
let drawing = null

function localPoint(div, e) {
  const r = div.getBoundingClientRect()
  return [e.clientX - r.left - div.clientLeft, e.clientY - r.top - div.clientTop]
}

container.addEventListener('pointerdown', e => {
  if (mode !== 'lasso' || e.button !== 0) return
  const page = engine.pageAt(e.target)
  if (!page) return
  e.preventDefault()
  closePopover()
  container.setPointerCapture(e.pointerId)
  const svg = document.createElementNS(SVG, 'svg')
  svg.classList.add('lasso-svg')
  svg.style.left = '0px'
  svg.style.top = '0px'
  svg.setAttribute('width', page.width)
  svg.setAttribute('height', page.height)
  const path = document.createElementNS(SVG, 'path')
  svg.append(path)
  page.div.append(svg)
  drawing = { page, svg, path, points: [localPoint(page.div, e)], rect: e.shiftKey, frame: 0 }
})

container.addEventListener('pointermove', e => {
  if (!drawing) return
  const p = localPoint(drawing.page.div, e)
  const last = drawing.points.at(-1)
  drawing.rect = drawing.rect || e.shiftKey
  if (drawing.rect) drawing.points = [drawing.points[0], p]
  else if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 2) drawing.points.push(p)
  if (!drawing.frame) {
    drawing.frame = requestAnimationFrame(() => {
      if (!drawing) return
      drawing.frame = 0
      drawing.path.setAttribute('d', pathData(outline(drawing), false))
    })
  }
})

function outline({ points, rect }) {
  if (!rect) return points
  const [[x0, y0], [x1, y1]] = [points[0], points.at(-1)]
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

const pathData = (pts, closed) =>
  pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ') + (closed ? ' Z' : '')

async function finishLasso() {
  const d = drawing
  drawing = null
  const poly = outline(d)
  const b = bounds(poly)
  if (b.x1 - b.x0 < 8 || b.y1 - b.y0 < 8) {
    d.svg.remove()
    return
  }
  d.path.setAttribute('d', pathData(poly, true))
  d.svg.classList.add('done')
  const [png, text] = await Promise.all([engine.capture(d.page, poly, !d.rect), engine.textIn(d.page, poly)])
  const r = d.page.div.getBoundingClientRect()
  openPopover(
    { kind: 'region', page: d.page.number, text, png, svg: d.svg },
    { left: r.left + b.x0, top: r.top + b.y0, right: r.left + b.x1, bottom: r.top + b.y1 },
  )
}

container.addEventListener('pointerup', () => {
  if (drawing) {
    finishLasso().catch(err => toast(t('captureFailed', err.message), 4000))
    return
  }
  if (mode === 'text' && engine.canSelectText) setTimeout(offerSelection, 0)
})
container.addEventListener('pointercancel', () => {
  drawing?.svg.remove()
  drawing = null
})

function offerSelection() {
  const sel = window.getSelection()
  const text = sel?.toString().trim()
  if (!text || !sel.rangeCount || !container.contains(sel.anchorNode)) return
  const page = engine.pageAt(sel.anchorNode?.parentElement)
  if (!page) return
  openPopover({ kind: 'text', page: page.number, text }, sel.getRangeAt(0).getBoundingClientRect())
}

// --- popover ---------------------------------------------------------------------

function openPopover(clip, anchor) {
  closePopover()
  pending = clip
  const pop = $('popover')
  $('popImage').src = clip.png || ''
  $('popText').textContent =
    clip.text || (clip.kind === 'region' ? (kind === 'image' ? t('imageOnly') : t('noText')) : '')
  $('popMeta').textContent =
    kind === 'image' ? t('metaImage') : clip.kind === 'region' ? t('metaRegion', clip.page) : t('metaText', clip.page)
  $('popNote').value = ''
  pop.hidden = false
  const w = pop.offsetWidth
  const h = pop.offsetHeight
  const left = Math.max(12, Math.min(anchor.right - w, innerWidth - w - 12))
  let top = anchor.bottom + 8
  if (top + h > innerHeight - 8) top = Math.max(52, anchor.top - h - 8)
  pop.style.left = `${left}px`
  pop.style.top = `${top}px`
  $('popNote').focus({ preventScroll: true })
}

function closePopover({ keepSvg = false } = {}) {
  $('popover').hidden = true
  if (pending?.svg && !keepSvg) pending.svg.remove()
  pending = null
}

// send: Claude gets it now, as a turn of its own; otherwise it waits in the
// chat for the person's next message
async function addPending({ send = false } = {}) {
  const clip = pending
  if (!clip) return
  const note = $('popNote').value.trim()
  $('popAdd').disabled = $('popSend').disabled = true
  try {
    const res = await fetch('/api/clip', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ docId, page: clip.page, kind: clip.kind, text: clip.text, note, png: clip.png, send }),
    })
    if (!res.ok) throw new Error(await res.text())
    closePopover({ keepSvg: true })
    if (clip.svg) {
      clip.svg.classList.remove('done')
      clip.svg.classList.add('fade')
      setTimeout(() => clip.svg.remove(), 600)
    }
    window.getSelection()?.removeAllRanges()
    toast(t(send ? 'sent' : 'added'))
  } catch (err) {
    toast(t('addFailed', err.message), 4000)
  } finally {
    $('popAdd').disabled = $('popSend').disabled = false
  }
}

$('popAdd').onclick = () => addPending()
$('popSend').onclick = () => addPending({ send: true })
$('popCancel').onclick = () => closePopover()
$('popNote').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    addPending({ send: !(e.ctrlKey || e.metaKey) })
  } else if (e.key === 'Escape') closePopover()
})
document.addEventListener('pointerdown', e => {
  if (pending && !$('popover').contains(e.target) && !drawing && mode === 'text') closePopover()
})

connect()
engine.load(false).catch(err => toast(t('openFailed', err.message), 8000))
