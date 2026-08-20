/* エスコAIアシスタント renderer */
const $ = (id) => document.getElementById(id)

const MODELS = [
  { id: 'claude-sonnet-5', label: 'Sonnet 5（標準・おすすめ）' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5（軽い・安い）' },
  { id: 'claude-opus-5', label: 'Opus 5（最高性能・高い）' }
]

const USD_JPY = 150 // 表示用の概算レート

let mode = 'chat'
let busy = false
let currentAiEl = null
let currentAiRaw = '' // ストリーミング中のAI応答の生テキスト（Markdown整形用）
let settingsCache = null
let monthUsd = 0

/* --- 軽量Markdown → HTML（外部ライブラリ不使用・安全にエスケープしてから整形） --- */
function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
}
function inlineMd(s) {
  // この時点でsはエスケープ済み。インライン記法だけHTML化する。
  s = s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
  s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>')
  return s
}
function md(text) {
  const lines = escapeHtml(text).split('\n')
  let html = ''
  let inCode = false
  let listType = null // 'ul' | 'ol'
  const closeList = () => {
    if (listType) {
      html += listType === 'ul' ? '</ul>' : '</ol>'
      listType = null
    }
  }
  let para = []
  const flushPara = () => {
    if (para.length) {
      html += `<p>${inlineMd(para.join('<br>'))}</p>`
      para = []
    }
  }
  for (const raw of lines) {
    const line = raw
    if (/^```/.test(line.trim())) {
      flushPara()
      closeList()
      if (!inCode) {
        html += '<pre><code>'
        inCode = true
      } else {
        html += '</code></pre>'
        inCode = false
      }
      continue
    }
    if (inCode) {
      html += line + '\n'
      continue
    }
    const h = line.match(/^(#{1,3})\s+(.*)$/)
    if (h) {
      flushPara()
      closeList()
      const lvl = h[1].length
      html += `<h${lvl}>${inlineMd(h[2])}</h${lvl}>`
      continue
    }
    const ul = line.match(/^\s*[-*・]\s+(.*)$/)
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (ul || ol) {
      flushPara()
      const want = ul ? 'ul' : 'ol'
      if (listType !== want) {
        closeList()
        html += want === 'ul' ? '<ul>' : '<ol>'
        listType = want
      }
      html += `<li>${inlineMd((ul || ol)[1])}</li>`
      continue
    }
    if (line.trim() === '') {
      flushPara()
      closeList()
      continue
    }
    para.push(line)
  }
  if (inCode) html += '</code></pre>'
  flushPara()
  closeList()
  return html
}

// ユーザーが最下部付近にいるか（自動スクロールしてよいか）を追記の前に判定する
function nearBottom() {
  const m = $('messages')
  return m.scrollHeight - m.scrollTop - m.clientHeight < 60
}
function scrollToBottom() {
  $('messages').scrollTop = $('messages').scrollHeight
}

function addMsg(cls, text) {
  const el = document.createElement('div')
  el.className = `msg ${cls}`
  el.textContent = text
  $('messages').appendChild(el)
  scrollToBottom()
  return el
}

/* --- 「考え中」インジケーター --- */
let pending = null // { el, label, t0, timer }
function showPending(label) {
  if (pending) {
    pending.label = label
    renderPending()
    return
  }
  const el = addMsg('ai pending', label)
  pending = { el, label, t0: Date.now(), timer: setInterval(renderPending, 500) }
  renderPending()
}
function renderPending() {
  if (!pending) return
  const atBottom = nearBottom()
  const s = Math.floor((Date.now() - pending.t0) / 1000)
  const dots = '.'.repeat((Math.floor(Date.now() / 500) % 3) + 1)
  pending.el.textContent = `${pending.label}${dots}${s >= 3 ? ` (${s}s)` : ''}`
  if (atBottom) scrollToBottom()
}
function clearPending() {
  if (!pending) return
  clearInterval(pending.timer)
  pending.el.remove()
  pending = null
}

function setBusy(b) {
  busy = b
  $('sendBtn').disabled = b
  $('stopBtn').hidden = !b
  if (!b) $('toolStatus').textContent = ''
}

function updateCost() {
  const yen = Math.round(monthUsd * USD_JPY)
  $('cost').textContent = `今月の利用額（概算）: $${monthUsd.toFixed(2)} ≒ ${yen.toLocaleString()}円`
}

function folderLabel(p) {
  if (!p) return '未選択'
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

let hasFolder = false

/* --- サイドバー（作業フォルダのファイルツリー） --- */
const expanded = new Set()

async function buildTree(container, dirPath, depth) {
  const res = await window.escoAI.listDir(dirPath)
  const items = (res && res.items) || []
  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'fitem'
    el.style.paddingLeft = `${6 + depth * 14}px`
    el.title = it.path
    el.draggable = true

    const caret = document.createElement('span')
    caret.className = 'caret'
    caret.textContent = it.isDir ? (expanded.has(it.path) ? '▾' : '▸') : ''
    const icon = document.createElement('span')
    icon.textContent = it.isDir ? '📁' : '📄'
    const name = document.createElement('span')
    name.className = 'fname'
    name.textContent = it.name
    el.append(caret, icon, name)

    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', it.path)
      e.dataTransfer.effectAllowed = 'copy'
    })
    el.addEventListener('click', () => {
      if (!it.isDir) return
      expanded.has(it.path) ? expanded.delete(it.path) : expanded.add(it.path)
      refreshTree()
    })
    el.addEventListener('dblclick', () => window.escoAI.openPath(it.path))

    container.appendChild(el)
    if (it.isDir && expanded.has(it.path)) {
      await buildTree(container, it.path, depth + 1)
    }
  }
  if (depth === 0 && res && res.truncated > 0) {
    const more = document.createElement('div')
    more.className = 'tree-empty'
    more.textContent = `ほか ${res.truncated} 件（多すぎるため非表示）`
    container.appendChild(more)
  }
}

let treeBusy = false
async function refreshTree() {
  if (treeBusy) return
  treeBusy = true
  try {
    const tree = $('tree')
    tree.innerHTML = ''
    if (!hasFolder) {
      const hint = document.createElement('div')
      hint.className = 'tree-empty'
      hint.textContent = 'フォルダ未選択でも会話できます。ファイル作業をするときは📁で選んでください。'
      tree.appendChild(hint)
      return
    }
    await buildTree(tree, null, 0) // null = 作業フォルダのルート
  } finally {
    treeBusy = false
  }
}
$('refreshBtn').addEventListener('click', refreshTree)
window.escoAI.on('fs:changed', refreshTree)

// AI応答内リンクのクリックで画面が遷移してしまうのを防ぐ（無害化）
$('messages').addEventListener('click', (e) => {
  const a = e.target.closest && e.target.closest('a')
  if (a) e.preventDefault()
})

async function boot() {
  const init = await window.escoAI.init()
  settingsCache = init.settings
  monthUsd = init.monthUsd || 0
  hasFolder = !!init.workFolder
  $('folderName').textContent = folderLabel(init.workFolder)
  $('folderBtn').title = init.workFolder || '作業フォルダを選択'
  $('sideTitle').textContent = hasFolder ? folderLabel(init.workFolder) : 'フォルダ未選択'
  $('keyWarn').hidden = init.hasApiKey
  updateCost()
  refreshTree()

  for (const sel of ['mChat', 'mDocs', 'mFiles']) {
    for (const m of MODELS) {
      const o = document.createElement('option')
      o.value = m.id
      o.textContent = m.label
      $(sel).appendChild(o)
    }
  }
  addMsg('ai', 'こんにちは。ESCO Worksです。\n上のタブで作業を選んでください。\n・チャット：相談や文章の下書き\n・資料作成：提案書や案内文をファイルに\n・フォルダ整理：📁で選んだフォルダの整理・リネーム\n\n資料（PDF等）はこの画面にドラッグ&ドロップで渡せます。\n🪟で別ウィンドウを開けば、別の作業を同時に進められます。')
}

/* --- モード切替 --- */
document.querySelectorAll('.mode').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode').forEach((b) => b.classList.remove('active'))
    btn.classList.add('active')
    mode = btn.dataset.mode
    $('autoApprove').checked = mode === 'files'
  })
})

/* --- 許可モード（Shift+Tabで循環） --- */
const PERM_MODES = [
  { id: 'normal', label: '● ノーマル', cls: 'mode-normal', hint: '毎回確認します（安全）' },
  { id: 'plan', label: '◐ Plan', cls: 'mode-plan', hint: 'まず計画だけ立てて実行しません' },
  { id: 'bypass', label: '⚡ バイパス', cls: 'mode-bypass', hint: '確認なしで全て実行（自己責任）' }
]
let permMode = 'normal'
function setPermMode(id) {
  permMode = id
  const m = PERM_MODES.find((x) => x.id === id) || PERM_MODES[0]
  const btn = $('modeBtn')
  btn.textContent = m.label
  btn.className = `modeBadge ${m.cls}`
  btn.title = `${m.hint}（Shift+Tabで切り替え）`
}
function cyclePermMode() {
  const i = PERM_MODES.findIndex((x) => x.id === permMode)
  setPermMode(PERM_MODES[(i + 1) % PERM_MODES.length].id)
}
$('modeBtn').addEventListener('click', cyclePermMode)
// テキスト欄以外にフォーカスがあってもShift+Tabで切り替えられるように
document.addEventListener('keydown', (e) => {
  if (e.key === 'Tab' && e.shiftKey && e.target !== $('input')) {
    e.preventDefault()
    cyclePermMode()
  }
})
setPermMode('normal')

/* --- 送信 --- */
async function send() {
  const text = $('input').value.trim()
  if (!text || busy) return
  $('input').value = ''
  addMsg('user', text)
  currentAiEl = null
  currentAiRaw = ''
  setBusy(true)
  showPending(permMode === 'plan' ? 'Planning' : 'Thinking')
  try {
    await window.escoAI.send({ text, mode, autoApprove: $('autoApprove').checked, permMode })
  } catch (e) {
    addMsg('error', String(e && e.message ? e.message : e))
  }
  clearPending()
  setBusy(false)
}
$('sendBtn').addEventListener('click', send)
$('input').addEventListener('keydown', (e) => {
  // Shift+Tab で許可モードを切り替え
  if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault()
    cyclePermMode()
    return
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault()
    send()
  }
})
$('stopBtn').addEventListener('click', () => window.escoAI.interrupt())

/* --- 新しいウィンドウ --- */
$('newWinBtn').addEventListener('click', () => window.escoAI.newWindow())

/* --- ファイルのドラッグ&ドロップ（パスを入力欄に差し込む） --- */
document.addEventListener('dragover', (e) => e.preventDefault())
document.addEventListener('drop', (e) => {
  e.preventDefault()
  // 外部（エクスプローラー等）からのファイル、またはサイドバーからのドラッグ
  const files = Array.from(e.dataTransfer?.files || [])
  let paths = files.map((f) => window.escoAI.pathForFile(f)).filter(Boolean)
  if (paths.length === 0) {
    const t = e.dataTransfer?.getData('text/plain')
    if (t) paths = [t]
  }
  if (paths.length === 0) return
  const tag = paths.map((p) => `（ファイル: ${p}）`).join('\n')
  $('input').value = $('input').value ? `${$('input').value}\n${tag}` : `${tag}\n`
  $('input').focus()
})

/* --- 会話リセット --- */
$('newChatBtn').addEventListener('click', () => {
  window.escoAI.newChat() // main側で実行中ターンをinterruptしてからリセット
  clearPending()
  clearAsks()
  currentAiEl = null
  setBusy(false)
  $('messages').innerHTML = ''
  addMsg('ai', '新しい会話を始めました。')
})

/* --- 作業フォルダの表示反映（選択時・フォルダ消失時で共通） --- */
function applyFolder(p) {
  hasFolder = !!p
  $('folderName').textContent = folderLabel(p)
  $('folderBtn').title = p || '作業フォルダを選択'
  $('sideTitle').textContent = hasFolder ? folderLabel(p) : 'フォルダ未選択'
  expanded.clear()
  refreshTree()
}
$('folderBtn').addEventListener('click', async () => {
  const p = await window.escoAI.pickFolder()
  applyFolder(p)
})
// main側でフォルダが変わった（削除で未選択化された等）ときの同期
window.escoAI.on('folder:changed', ({ workFolder }) => applyFolder(workFolder))

/* --- エージェントからのイベント --- */
window.escoAI.on('agent:token', ({ delta }) => {
  clearPending()
  const atBottom = nearBottom()
  if (!currentAiEl) {
    currentAiEl = addMsg('ai', '')
    currentAiRaw = ''
  }
  currentAiRaw += delta
  currentAiEl.innerHTML = md(currentAiRaw)
  if (atBottom) scrollToBottom()
})
window.escoAI.on('agent:text', ({ text }) => {
  clearPending()
  currentAiEl = addMsg('ai', '')
  currentAiRaw = text
  currentAiEl.innerHTML = md(text)
})
window.escoAI.on('agent:tool', ({ tool }) => {
  $('toolStatus').textContent = tool
  currentAiEl = null // ツール実行を挟んだら次のテキストは新しい吹き出しへ
  currentAiRaw = ''
  showPending(tool) // 実行中のアクションを吹き出しで見せる
})
window.escoAI.on('agent:done', async ({ costUsd }) => {
  clearPending()
  clearAsks() // ターン終了で残った承認バーを片付ける
  $('toolStatus').textContent = ''
  if (costUsd > 0) {
    monthUsd = await window.escoAI.addUsage(costUsd)
    updateCost()
  }
})
window.escoAI.on('agent:error', ({ message }) => {
  clearPending()
  clearAsks()
  addMsg('error', `エラー: ${message}`)
})

/* --- 実行許可（Claude Code風のインラインカード） --- */
const openCards = new Set() // 未回答の許可カード

function labelFor(req) {
  // Playwrightツールは読みやすい日本語に
  const t = req.tool || ''
  if (t.startsWith('mcp__playwright')) return 'ブラウザ操作'
  return req.label || t
}
function addPermCard(req) {
  const card = document.createElement('div')
  card.className = 'permcard'
  const head = document.createElement('div')
  head.className = 'pc-head'
  head.innerHTML = `<b>${escapeHtml(labelFor(req))}</b> を実行してよいですか？`
  card.appendChild(head)
  if (req.detail) {
    const pre = document.createElement('pre')
    pre.textContent = req.detail
    card.appendChild(pre)
  }
  const btns = document.createElement('div')
  btns.className = 'pc-btns'
  const allow = document.createElement('button')
  allow.className = 'pc-allow'
  allow.textContent = '許可'
  const always = document.createElement('button')
  always.textContent = '常に許可'
  const deny = document.createElement('button')
  deny.textContent = '拒否'
  btns.append(allow, always, deny)
  card.appendChild(btns)
  $('messages').appendChild(card)
  scrollToBottom()

  const finish = (approved, remember, resultText) => {
    if (!openCards.has(card)) return
    openCards.delete(card)
    window.escoAI.respondPermission(req.requestId, approved, remember)
    btns.remove()
    const r = document.createElement('div')
    r.className = 'pc-result'
    r.textContent = resultText
    card.appendChild(r)
    card.classList.add('answered')
  }
  allow.addEventListener('click', () => finish(true, false, '許可しました'))
  always.addEventListener('click', () => finish(true, true, '常に許可にしました'))
  deny.addEventListener('click', () => finish(false, false, '拒否しました'))
  card.__cancel = () => finish(false, false, 'キャンセルされました')
  openCards.add(card)
  currentAiEl = null // カードの後のテキストは新しい吹き出しへ
  currentAiRaw = ''
}
// ターン終了・中断時に未回答カードを片付ける
function clearAsks() {
  for (const card of Array.from(openCards)) {
    if (card.__cancel) card.__cancel()
  }
}
window.escoAI.on('agent:ask', (req) => addPermCard(req))

/* --- 選択肢つきの質問カード --- */
function addChoiceCard(req) {
  const card = document.createElement('div')
  card.className = 'permcard choicecard'
  const head = document.createElement('div')
  head.className = 'pc-head'
  head.innerHTML = `<b>${escapeHtml(req.question || '選んでください')}</b>`
  card.appendChild(head)
  const btns = document.createElement('div')
  btns.className = 'pc-btns'
  const finish = (answer) => {
    if (!openCards.has(card)) return
    openCards.delete(card)
    window.escoAI.respondChoice(req.requestId, answer)
    btns.remove()
    const r = document.createElement('div')
    r.className = 'pc-result'
    r.textContent = `→ ${answer}`
    card.appendChild(r)
    card.classList.add('answered')
  }
  for (const opt of req.options || []) {
    const b = document.createElement('button')
    b.textContent = opt
    b.addEventListener('click', () => finish(opt))
    btns.appendChild(b)
  }
  card.appendChild(btns)
  $('messages').appendChild(card)
  scrollToBottom()
  card.__cancel = () => finish('（キャンセルされました）')
  openCards.add(card)
  currentAiEl = null
  currentAiRaw = ''
}
window.escoAI.on('agent:choice', (req) => addChoiceCard(req))

/* --- 設定 --- */
// 他ウィンドウでの保存を反映（開いていない間の変更も取りこぼさない）
window.escoAI.on('settings:changed', (s) => {
  settingsCache = s
})
$('settingsBtn').addEventListener('click', async () => {
  // 開く直前に最新設定を取り直し、複数ウィンドウでの巻き戻りを防ぐ
  try {
    const init = await window.escoAI.init()
    settingsCache = init.settings
  } catch {
    /* キャッシュのまま続行 */
  }
  $('setKey').value = settingsCache.apiKey || ''
  $('setName').value = settingsCache.userName || ''
  $('mChat').value = settingsCache.models.chat
  $('mDocs').value = settingsCache.models.docs
  $('mFiles').value = settingsCache.models.files
  $('setBrowser').checked = !!settingsCache.enableBrowser
  $('settingsDlg').showModal()
})
$('setCancel').addEventListener('click', () => $('settingsDlg').close())
$('setSave').addEventListener('click', async () => {
  const next = {
    apiKey: $('setKey').value.trim(),
    userName: $('setName').value.trim(),
    enableBrowser: $('setBrowser').checked,
    models: {
      chat: $('mChat').value,
      docs: $('mDocs').value,
      files: $('mFiles').value
    }
  }
  await window.escoAI.saveSettings(next)
  settingsCache = { ...settingsCache, ...next }
  if (next.apiKey) $('keyWarn').hidden = true
  $('settingsDlg').close()
})

/* --- 自動アップデートの通知 --- */
window.escoAI.on('update:status', (s) => {
  const bar = $('updateBar')
  const msg = $('updateMsg')
  const btn = $('updateBtn')
  if (s.state === 'downloading') {
    bar.hidden = false
    btn.hidden = true
    msg.textContent = `新しいバージョンをダウンロード中… ${s.percent || 0}%`
  } else if (s.state === 'ready') {
    bar.hidden = false
    btn.hidden = false
    msg.textContent = `新しいバージョン ${s.version || ''} の準備ができました。`
  } else {
    bar.hidden = true // checking / none / error は黙って隠す
  }
})
$('updateBtn').addEventListener('click', () => window.escoAI.installUpdate())

boot()
