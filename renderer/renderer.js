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

/* Markdown整形（escapeHtml / inlineMd / md）は shared/md.js で読み込み済み */

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
  $('newChatBtn').disabled = sessionSwitchBusy
  $('folderBtn').disabled = b
  document.querySelectorAll('.mode').forEach(btn => { btn.disabled = b })
  renderSessions()
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
let editState = null
let previewRequest = 0

async function previewFile(file, name) {
  const request = ++previewRequest
  $('previewName').textContent = name
  $('filePreview').textContent = '読み込み中…'
  try { const result = await window.escoAI.preview(file); if (request === previewRequest) $('filePreview').textContent = result.text }
  catch (e) { if (request === previewRequest) $('filePreview').textContent = e.message }
}
function editProject(project = null) {
  editState = { type: 'project', project, folder: project?.folder || null }
  $('editHeading').textContent = project ? 'プロジェクト設定' : '新しいプロジェクト'
  $('editName').value = project?.name || ''
  $('editName').parentElement.hidden = false
  $('projectFields').hidden = false; $('moveField').hidden = true
  $('projectFolderLabel').textContent = editState.folder || 'フォルダ未選択'
  $('projectInstructions').value = project?.instructions || ''
  $('editError').textContent = ''; $('editDlg').showModal()
}
function openSessionMenu(session) {
  $('menuTitle').textContent = session.title
  const box = $('sessionMenuActions'); box.replaceChildren()
  const action = (label, fn) => { const btn = document.createElement('button'); btn.textContent = label; btn.addEventListener('click', async () => {
    $('sessionMenuDlg').close()
    try { await fn() } catch(e) { historyNotice(e.message) }
  }); box.appendChild(btn) }
  action('名前を変更', () => {
    editState = {type:'rename',session}; $('editHeading').textContent = '名前を変更'; $('editName').value = session.title
    $('editName').parentElement.hidden = false; $('projectFields').hidden = true; $('moveField').hidden = true; $('editError').textContent = ''; $('editDlg').showModal()
  })
  action('プロジェクトへ移動', () => {
    editState = {type:'move',session}; $('editHeading').textContent = 'プロジェクトへ移動'
    $('editName').parentElement.hidden = true; $('projectFields').hidden = true; $('moveField').hidden = false; $('moveProject').replaceChildren()
    for (const p of [{id:'',name:'プロジェクト未所属'}, ...projects]) { const o = document.createElement('option'); o.value = p.id; o.textContent = p.name; $('moveProject').appendChild(o) }
    $('moveProject').value = session.projectId || ''; $('editError').textContent = ''; $('editDlg').showModal()
  })
  const update = async (type) => {
    const value = await window.escoAI.updateSession({ id: session.id, action: type })
    if (session.id === activeSessionId) applySession(value)
    await refreshSessions()
  }
  action(session.pinned ? 'ピン留めを解除' : 'ピン留め', () => update('pin'))
  if (session.archived || session.deleted) action('通常一覧へ復元', () => update('restore'))
  else action('アーカイブ', () => update('archive'))
  if (!session.deleted) action('ゴミ箱へ移動', () => update('trash'))
  else action('完全に削除…', () => window.escoAI.purgeSession(session.id))
  $('sessionMenuDlg').showModal()
}
async function businessRefresh() {
  try { const state = await window.escoAI.businessStatus(); $('businessState').textContent = state.status }
  catch(e) { $('businessState').textContent = e.message }
}
$('newProjectBtn').addEventListener('click', () => editProject())
$('pickProjectFolder').addEventListener('click', async () => { const folder = await window.escoAI.projectFolder(); if (folder) { editState.folder = folder; $('projectFolderLabel').textContent = folder } })
$('editCancel').addEventListener('click', () => $('editDlg').close())
$('menuClose').addEventListener('click', () => $('sessionMenuDlg').close())
$('editSave').addEventListener('click', async () => {
  try {
    if (editState.type === 'project') {
      const p = await window.escoAI.saveProject({ id: editState.project?.id, name: $('editName').value, folder: editState.folder, instructions: $('projectInstructions').value }); selectedProject = p.id
    } else {
      const value = await window.escoAI.updateSession({ id: editState.session.id, action: editState.type, value: editState.type === 'move' ? $('moveProject').value : $('editName').value })
      if (value.id === activeSessionId) { currentSession.title = value.title; $('sessionName').textContent = value.title }
    }
    $('editDlg').close(); await refreshSessions()
  } catch(e) { $('editError').textContent = e.message }
})
$('businessBtn').addEventListener('click', async () => {
  const existing = sessionItems.find(s => s.kind === 'business' && !s.deleted && !s.archived)
  await switchSession(existing?.id || null, 'business')
})
$('businessFolderBtn').addEventListener('click', async () => { try { $('businessFolderPath').textContent = await window.escoAI.businessFolder() || '未設定'; businessRefresh() } catch(e) { historyNotice(e.message) } })
$('businessRetry').addEventListener('click', async () => { await window.escoAI.businessSync(); businessRefresh() })
window.escoAI.on('business:status', state => { $('businessState').textContent = state.status })
$('shareWorkBtn').addEventListener('click', async () => {
  if (busy) { historyNotice('作業完了後に共有してください'); return }
  const text = [...$('messages').querySelectorAll('.msg.user')].map(el => el.textContent).join('\n\n')
  if (!text) return
  const existing = sessionItems.find(s => s.kind === 'business' && !s.deleted && !s.archived)
  await switchSession(existing?.id || null, 'business')
  if (currentSession?.kind !== 'business' || busy) return
  $('input').value = '以下は私の作業に関する入力です。依頼や希望と、実際の業務について述べた事実を区別し、業務共有に整理してください。\n\n' + text
  await send()
})
let sessionItems = []
let projects = []
let selectedProject = null
let currentSession = null
function messageMd(text) { return md(currentSession?.kind === 'business' ? text.replace(/```json[\s\S]*?(?:```|$)/g, '').trim() : text) }
const drafts = new Map()
const collapsedProjects = new Set(JSON.parse(localStorage.getItem('collapsedProjects') || '[]'))
let activeSessionId = null
let sessionSwitchBusy = false
let sessionListRequest = 0

function historyNotice(message = '') {
  $('historyNotice').textContent = message
  $('historyNotice').hidden = !message
}
function renderSessions() {
  const query = $('sessionSearch').value.trim().toLocaleLowerCase()
  const filter = $('historyFilter').value
  const list = $('sessionList'); list.replaceChildren()
  const items = sessionItems.filter(s => (filter === 'trash' ? s.deleted : filter === 'archive' ? s.archived && !s.deleted : !s.archived && !s.deleted) && s.title.toLocaleLowerCase().includes(query))
  function row(s, parent) {
    const wrap = document.createElement('div'); wrap.className = 'session-row'
    const btn = document.createElement('button'); btn.className = 'session-item' + (s.id === activeSessionId ? ' active' : '')
    btn.disabled = sessionSwitchBusy; btn.setAttribute('aria-current', s.id === activeSessionId ? 'true' : 'false')
    btn.title = s.title + (s.workFolder ? '\n' + s.workFolder : '')
    const title = document.createElement('span'); title.className = 'session-title'
    title.textContent = (s.pinned ? '📌 ' : '') + s.title
    const meta = document.createElement('span'); meta.className = 'session-meta'
    meta.textContent = (s.unread ? '● 未読 · ' : '') + (s.status || '待機中') + (s.openElsewhere ? ' · 別ウィンドウ' : '')
    btn.append(title, meta); btn.addEventListener('click', () => switchSession(s.id))
    const menu = document.createElement('button'); menu.className = 'session-more'; menu.textContent = '…'; menu.title = s.title + ' の操作'
    menu.addEventListener('click', () => openSessionMenu(s)); wrap.append(btn,menu); parent.appendChild(wrap)
  }
  if (filter === 'active') {
    items.filter(s => s.pinned).forEach(s => row(s,list))
    for (const p of [...projects, {id: null,name:'プロジェクト未所属'}]) {
      const children = items.filter(s => !s.pinned && s.projectId === p.id)
      if (query && !children.length) continue
      const head = document.createElement('div'); head.className = 'project-head'
      const toggle = document.createElement('button'); const folded = !query && collapsedProjects.has(p.id)
      const activeCount = sessionItems.filter(s => s.projectId === p.id && s.busy).length
      toggle.textContent = (folded ? '▶ ' : '▼ ') + p.name + (activeCount ? ' · ' + activeCount + '件実行中' : '')
      toggle.title = p.folder || p.name
      toggle.addEventListener('click', () => { selectedProject = p.id; collapsedProjects.has(p.id) ? collapsedProjects.delete(p.id) : collapsedProjects.add(p.id); localStorage.setItem('collapsedProjects',JSON.stringify([...collapsedProjects])); renderSessions() })
      const add = document.createElement('button'); add.textContent = '+'; add.title = p.name + ' に会話を追加'; add.addEventListener('click', () => { selectedProject = p.id; switchSession() })
      head.append(toggle,add)
      if (p.id) { const edit = document.createElement('button'); edit.textContent = '…'; edit.title = 'プロジェクト設定'; edit.addEventListener('click', () => editProject(p)); head.appendChild(edit) }
      list.appendChild(head)
      if (!folded) { const group = document.createElement('div'); group.className = 'session-group'; children.forEach(s => row(s,group)); list.appendChild(group) }
    }
  } else items.forEach(s => row(s,list))
  if (!items.length && (query || filter !== 'active')) { const hint = document.createElement('p'); hint.className = 'tree-empty'; hint.textContent = '該当する会話はありません。'; list.appendChild(hint) }
}
async function refreshSessions() {
  const request = ++sessionListRequest
  try {
    const result = await window.escoAI.listSessions()
    if (request !== sessionListRequest) return
    sessionItems = result.items
    projects = result.projects || []
    activeSessionId = result.currentId
    renderSessions()
  } catch (e) { historyNotice(`履歴を取得できませんでした: ${e.message}`) }
}
function applySession(session) {
  clearPending()
  openCards.clear() // 切替では保留中の質問に回答しない
  currentAiEl = null
  currentAiRaw = ''
  activeSessionId = session.id
  currentSession = session
  selectedProject = session.projectId || null
  $('sessionName').textContent = session.title
  $('businessBar').hidden = session.kind !== 'business'
  $('shareWorkBtn').hidden = session.kind === 'business'
  mode = session.mode || 'chat'
  document.querySelectorAll('.mode').forEach(btn => btn.classList.toggle('active', btn.dataset.mode === mode))
  // Past permission grants are never silently re-enabled by opening history.
  setPermMode('normal')
  $('autoApprove').checked = false
  $('input').value = drafts.get(session.id) || ''
  $('messages').replaceChildren()
  for (const m of session.messages) {
    const el = addMsg(m.role === 'user' ? 'user' : m.role === 'error' ? 'error' : 'ai', m.text)
    if (m.role === 'ai') el.innerHTML = messageMd(m.text)
  }
  if (!session.messages.length) addMsg('ai', '新しい会話を始めました。会話は自動で履歴に保存されます。')
  applyFolder(session.workFolder)
  if (session.busy && session.messages.at(-1)?.role === 'ai') { currentAiEl = $('messages').lastElementChild; currentAiRaw = session.messages.at(-1).text }
  for (const req of session.asks || []) addPermCard(req)
  for (const req of session.choices || []) addChoiceCard(req)
  setBusy(!!session.busy)
  if (session.deleted || session.archived) { $('sendBtn').disabled = true; $('input').disabled = true } else $('input').disabled = false
  businessRefresh()
  historyNotice()
  scrollToBottom()
}
async function switchSession(id = null, kind = null) {
  if (sessionSwitchBusy || (id && id === activeSessionId)) return
  drafts.set(activeSessionId, $('input').value)
  sessionSwitchBusy = true
  renderSessions()
  try {
    const session = id ? await window.escoAI.openSession(id) : await window.escoAI.newChat({ projectId: kind ? null : selectedProject, kind })
    applySession(session)
    await refreshSessions()
  } catch (e) { historyNotice(e.message) }
  finally { sessionSwitchBusy = false; $('newChatBtn').disabled = false; renderSessions() }
}
$('sessionSearch').addEventListener('input', renderSessions)
$('historyFilter').addEventListener('change', renderSessions)
window.escoAI.on('session:selected', applySession)
window.escoAI.on('sessions:changed', refreshSessions)
window.escoAI.on('history:error', ({ message }) => historyNotice(message))
window.escoAI.on('chat:idle', () => { clearPending(); setBusy(false) })

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
      if (!it.isDir) { previewFile(it.path, it.name); return }
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
let treeAgain = false
async function refreshTree() {
  if (treeBusy) { treeAgain = true; return }
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
    if (treeAgain) { treeAgain = false; refreshTree() }
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
  if (init.version) $('verLabel').textContent = 'v' + init.version
  updateCost()
  refreshTree()
  await refreshSessions()
  // 更新直後も、業務共有の初期設定を案内する。
  if (!init.hasApiKey || !settingsCache.userName?.trim() || !settingsCache.businessFolder) {
    setTimeout(() => { if (!$('settingsDlg').open) $('settingsBtn').click() }, 700)
  }

  for (const sel of ['mChat', 'mDocs', 'mFiles']) {
    for (const m of MODELS) {
      const o = document.createElement('option')
      o.value = m.id
      o.textContent = m.label
      $(sel).appendChild(o)
    }
  }
  if (init.session?.messages.length) applySession(init.session)
  else addMsg('ai', 'こんにちは。ESCO Worksです。\n上のタブで作業を選んでください。会話はこのPCに自動保存されます。\n左のセッション履歴から過去の会話を開いて続けられます。\n\n資料（PDF等）はこの画面にドラッグ&ドロップで渡せます。\n🪟で別ウィンドウを開けば、別の作業を同時に進められます。')
  setBusy(!!init.busy)
  if (init.busy) showPending('作業中')
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
  const sentSession = activeSessionId
  const text = $('input').value.trim()
  if (!text || busy) return
  if (currentSession?.kind === 'business' && !settingsCache.userName?.trim()) { $('settingsBtn').click(); return }
  $('input').value = ''
  addMsg('user', text)
  currentAiEl = null
  currentAiRaw = ''
  setBusy(true)
  showPending(permMode === 'plan' ? 'Planning' : 'Thinking')
  try {
    await window.escoAI.send({ text, mode, autoApprove: $('autoApprove').checked, permMode, sessionId: sentSession })
  } catch (e) {
    if (activeSessionId === sentSession) {
      addMsg('error', String(e && e.message ? e.message : e))
      if (!$('input').value) $('input').value = text
    }
  }
  if (activeSessionId === sentSession) { clearPending(); setBusy(false) }
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
$('cloudWorkspaceBtn').addEventListener('click', () => window.escoAI.openWorkspace())
$('cloudSetupBtn').addEventListener('click', () => { $('settingsDlg').close(); window.escoAI.openWorkspace() })

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
$('newChatBtn').addEventListener('click', () => switchSession())

/* --- 作業フォルダの表示反映（選択時・フォルダ消失時で共通） --- */
function applyFolder(p) {
  previewRequest++
  $('previewName').textContent = 'ファイルプレビュー'
  $('filePreview').textContent = 'ファイルをクリックすると内容を表示します。'
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
  currentAiEl.innerHTML = messageMd(currentAiRaw)
  if (atBottom) scrollToBottom()
})
window.escoAI.on('agent:text', ({ text }) => {
  clearPending()
  currentAiEl = addMsg('ai', '')
  currentAiRaw = text
  currentAiEl.innerHTML = messageMd(text)
})
window.escoAI.on('agent:tool', ({ tool }) => {
  $('toolStatus').textContent = tool
  currentAiEl = null // ツール実行を挟んだら次のテキストは新しい吹き出しへ
  currentAiRaw = ''
  showPending(tool) // 実行中のアクションを吹き出しで見せる
})
window.escoAI.on('agent:done', () => {
  clearPending()
  clearAsks() // ターン終了で残った承認バーを片付ける
  $('toolStatus').textContent = ''
})
// 利用額はmain側で一元計上され、更新がここに届く（スマホからの利用分も含む）
window.escoAI.on('usage:updated', ({ monthUsd: usd }) => {
  monthUsd = usd
  updateCost()
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
  $('businessFolderPath').textContent = settingsCache.businessFolder || '未設定'
  $('mChat').value = settingsCache.models.chat
  $('mDocs').value = settingsCache.models.docs
  $('mFiles').value = settingsCache.models.files
  $('setBrowser').checked = !!settingsCache.enableBrowser
  try {
    renderRemoteStatus(await window.escoAI.remoteStatus())
  } catch {
    /* 表示のみの失敗は無視 */
  }
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

/* --- スマホ連携（設定ダイアログ内） --- */
const REMOTE_STATE_LABELS = {
  stopped: '停止中',
  starting: '起動中…（10秒ほどかかります）',
  up: '接続受付中',
  restarting: '再接続中…',
  connecting: 'サーバーへ接続中…',
  connected: 'サーバー接続中',
  reconnecting: 'サーバーへ再接続中…',
  error: 'エラー'
}
const REMOTE_HINTS = {
  off: '',
  tunnel: '外出先から使うには、このパソコンを起動したままにしてください。アプリを起動し直したときは、QRコードをもう一度読み取る必要があります。',
  relay:
    'QRコードの読み取りは初回の1回だけです。パソコン起動中はファイル作業もスマホから頼めます。パソコンが起きていない間は、サーバーがチャットだけ代わりに応答します。'
}
function renderRemoteStatus(st) {
  const mode = st.mode || 'off'
  for (const r of document.querySelectorAll('input[name="remoteMode"]')) r.checked = r.value === mode
  $('connectCodeRow').hidden = mode !== 'relay'
  if (st.hasConnectCode && !$('setConnectCode').value) $('setConnectCode').value = '設定済み'
  $('remoteHint').textContent = REMOTE_HINTS[mode] || ''
  const label = REMOTE_STATE_LABELS[st.state] || st.state
  $('remoteStatus').textContent = mode === 'off' ? '' : `状態: ${label}${st.message ? `（${st.message}）` : ''}`
  const ready = (mode === 'tunnel' && st.state === 'up') || (mode === 'relay' && st.state === 'connected')
  $('remoteQrBtn').hidden = !ready
  const box = $('remoteDevices')
  box.innerHTML = ''
  if (mode !== 'off' && st.devices && st.devices.length) {
    for (const d of st.devices) {
      const row = document.createElement('div')
      row.className = 'remote-device'
      const name = document.createElement('span')
      const extra = d.connected ? '（接続中）' : d.pendingHandoff > 0 ? `（外出中の会話 ${d.pendingHandoff}件）` : ''
      name.textContent = `${d.name}${extra}`
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.textContent = '解除'
      btn.addEventListener('click', async () => {
        renderRemoteStatus(await window.escoAI.remoteRevoke(d.deviceId))
      })
      row.append(name, btn)
      box.appendChild(row)
    }
  }
}
// 方式の切り替えは保存ボタンを待たずに即反映（起動に時間がかかるため状態を見せる）
for (const r of document.querySelectorAll('input[name="remoteMode"]')) {
  r.addEventListener('change', async () => {
    if (!r.checked) return
    if (r.value === 'relay') {
      // 未保存の接続コードが入力欄にあれば先に登録する
      const code = $('setConnectCode').value.trim()
      if (code && code !== '設定済み') {
        const res = await window.escoAI.remoteSetConnectCode(code)
        if (res.error) {
          $('remoteStatus').textContent = `状態: エラー（${res.error}）`
          return
        }
        $('setConnectCode').value = '設定済み'
      }
    }
    renderRemoteStatus(await window.escoAI.remoteSetMode(r.value))
  })
}
// 接続コードの貼り付け → フォーカスが外れたタイミングで保存
$('setConnectCode').addEventListener('change', async () => {
  const code = $('setConnectCode').value.trim()
  if (!code || code === '設定済み') return
  const res = await window.escoAI.remoteSetConnectCode(code)
  if (res.error) {
    $('remoteStatus').textContent = `状態: エラー（${res.error}）`
  } else {
    $('setConnectCode').value = '設定済み'
    renderRemoteStatus(await window.escoAI.remoteStatus())
  }
})
window.escoAI.on('remote:changed', (st) => {
  if ($('settingsDlg').open) renderRemoteStatus(st)
})
$('remoteQrBtn').addEventListener('click', async () => {
  const r = await window.escoAI.remoteQr()
  if (r.error) {
    $('remoteStatus').textContent = `状態: エラー（${r.error}）`
    return
  }
  $('qrImg').src = r.dataUrl
  $('qrDlg').showModal()
})
$('qrClose').addEventListener('click', () => $('qrDlg').close())

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
$('keyOpenBtn').addEventListener('click', () => $('settingsBtn').click())

boot()
