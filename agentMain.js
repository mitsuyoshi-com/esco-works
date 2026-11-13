// エージェント（PCのファイルを読み書きできる作業モード）。v0.3.4 までの ESCO Works の本体を、
// 指定された人だけが開ける別ウィンドウとして戻したもの（v0.5.0〜）。
//  ・使えるかどうか・その人専用のキーは、サーバー（/api/agent/config）が決める。キーは PC に保存しない（メモリだけ）。
//  ・1回動かすたびに利用額をサーバーへ報告する（/api/agent/usage）。送れなかった分はファイルに残して送り直す。
//  ・データの置き場は userData/agent/。初回だけ、旧版の会話・プロジェクト・業務メモ・設定を写す（元は消さない・書き換えない）。
//  ・スマホ連携（旧版）は戻していない。スマホはクラウド側のチャットを使う。
const { BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { randomUUID } = require('crypto')
const { AgentRunner } = require('./agent')
const { SessionStore, SessionRecorder } = require('./sessions')
const { ProjectStore } = require('./projects')
const { BusinessStore } = require('./business')
const { FolderQueue } = require('./folderQueue')

const DEFAULT_MODEL = 'claude-sonnet-5-5'
const DEFAULTS = {
  userName: '', staffId: '', businessFolder: '', enableBrowser: false, sendWithCtrlEnter: false,
  models: { chat: DEFAULT_MODEL, docs: DEFAULT_MODEL, files: DEFAULT_MODEL }
}
// Opus は費用が大きいため使わない（2026-10-18 光強代表の指示）。旧標準の Sonnet 5 も標準モデルへ寄せる
const normalizeModel = (id) => (!id || String(id).startsWith('claude-opus') || id === 'claude-sonnet-5' ? DEFAULT_MODEL : id)

const MSG = {
  off: 'エージェントは、いまご利用いただけません。',
  blocked: '今月のエージェントのご利用枠に達しました。来月1日からまた使えます。お急ぎのときは山本までご連絡ください。ふだんのチャットはこれまでどおり使えます。',
  notReady: 'エージェントの準備がまだ終わっていません。山本までご連絡ください。',
  offline: 'サーバーに接続できません。インターネットの接続を確認して、もう一度お試しください。'
}

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', text, 'utf8')
  fs.renameSync(file + '.tmp', file)
}
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

/**
 * 初回だけ、旧版（userData 直下）のデータを userData/agent/ に写す。元のファイルには触れない。
 * 途中で止まっても次回やり直せるよう、終わってから印（.seeded）を置く。
 */
function seedFromLegacy(userData, dataDir, log) {
  const mark = path.join(dataDir, '.seeded')
  if (fs.existsSync(mark)) return { seeded: false }
  const copied = { sessions: 0, projects: 0, business: 0 }
  for (const sub of ['sessions', 'projects']) {
    const from = path.join(userData, sub), to = path.join(dataDir, sub)
    fs.mkdirSync(to, { recursive: true })
    let names = []
    try { names = fs.readdirSync(from).filter((f) => /\.json$/i.test(f)) } catch { /* 旧版を使っていなかった */ }
    for (const f of names) {
      try {
        if (!fs.existsSync(path.join(to, f))) { fs.copyFileSync(path.join(from, f), path.join(to, f)); copied[sub]++ }
      } catch (e) { log('[agent] 旧データを写せませんでした ' + sub + '/' + f + ' ' + (e && e.message)) }
    }
  }
  try {
    const from = path.join(userData, 'business', 'state.json'), to = path.join(dataDir, 'business', 'state.json')
    if (fs.existsSync(from) && !fs.existsSync(to)) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); copied.business = 1 }
  } catch (e) { log('[agent] 業務メモを写せませんでした ' + (e && e.message)) }
  // 設定：お名前・共有フォルダ・モデルなど。APIキーは写さない（キーはサーバーが渡す）
  const old = readJson(path.join(userData, 'settings.json'), null)
  if (old && !fs.existsSync(path.join(dataDir, 'settings.json'))) {
    const s = { ...DEFAULTS, models: { ...DEFAULTS.models, ...(old.models || {}) } }
    for (const k of ['userName', 'staffId', 'businessFolder', 'enableBrowser', 'sendWithCtrlEnter']) if (old[k] !== undefined) s[k] = old[k]
    atomicWrite(path.join(dataDir, 'settings.json'), JSON.stringify(s, null, 2))
  }
  atomicWrite(mark, JSON.stringify({ at: new Date().toISOString(), copied }))
  log('[agent] 旧版のデータを写しました ' + JSON.stringify(copied))
  return { seeded: true, copied }
}

/**
 * @param app         Electron の app
 * @param doFetch     (path, init) => Response  ログイン中の Cookie で自社サーバーを呼ぶ
 * @param log         記録
 * @param onUpdate    { install(), check() }  更新（設定画面の「今すぐ更新を確認」用）
 * @param test        テスト時の差し替え { runnerFactory }
 */
function setupAgent({ app, doFetch, log = () => {}, onUpdate = {}, test = {} }) {
  const userData = app.getPath('userData')
  const dataDir = path.join(userData, 'agent')
  fs.mkdirSync(dataDir, { recursive: true })
  const settingsFile = path.join(dataDir, 'settings.json')
  const queueFile = path.join(dataDir, 'usage-queue.json')
  const folderQueue = new FolderQueue()
  const windows = new Map()   // webContents.id -> { win, active, emit }
  const contexts = new Map()  // 会話ID -> 実行の状態
  let sessionStore = null, projectStore = null, businessStore = null, businessTimer = null
  let settings = null
  let ready = false
  // サーバーが決める利用可否。apiKey はここ（メモリ）にだけ持つ
  let access = { enabled: false, blocked: false, ready: false, apiKey: '', userName: '', remainPct: null, checkedAt: 0, offline: false }

  function loadSettings() {
    const raw = readJson(settingsFile, {})
    const s = { ...DEFAULTS, ...raw, models: { ...DEFAULTS.models, ...(raw.models || {}) } }
    delete s.apiKey; delete s.remote; delete s.relay; delete s.remoteDevices
    for (const k of Object.keys(s.models)) s.models[k] = normalizeModel(s.models[k])
    return s
  }
  const saveSettings = () => atomicWrite(settingsFile, JSON.stringify(settings, null, 2))
  // AgentRunner に渡す設定：キーはこのときだけ足す
  const runnerSettings = () => ({ ...settings, apiKey: access.apiKey || '' })
  // 画面に渡す設定：キーは渡さない
  const viewSettings = () => ({ ...settings, apiKey: '' })

  function emitAll(ev, payload) { for (const st of windows.values()) st.emit(ev, payload) }

  // ---- 利用可否の確認 ----
  async function refreshAccess() {
    try {
      const r = await doFetch('/api/agent/config', { headers: { 'x-esco-shell': '1' } })
      if (r.status === 401) { access = { ...access, enabled: false, ready: false, apiKey: '', offline: false, checkedAt: Date.now() }; return access }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      const j = await r.json()
      access = {
        enabled: !!j.enabled, blocked: !!j.blocked, ready: !!j.ready && typeof j.apiKey === 'string' && !!j.apiKey,
        apiKey: typeof j.apiKey === 'string' ? j.apiKey : '', userName: typeof j.userName === 'string' ? j.userName : '',
        remainPct: typeof j.remainPct === 'number' ? j.remainPct : null,   // 今月の枠の残り（％）。金額は受け取らない
        checkedAt: Date.now(), offline: false
      }
      emitAll('usage:updated', { remainPct: access.remainPct })
    } catch (e) {
      // つながらないときは、直前の判定は残したままキーだけ使わせない（確認できないまま動かさない）
      access = { ...access, offline: true, checkedAt: Date.now() }
      log('[agent] 利用可否を確認できませんでした ' + (e && e.message))
    }
    return access
  }
  const notice = () => (access.offline ? MSG.offline : !access.enabled ? MSG.off : access.blocked ? MSG.blocked : !access.ready ? MSG.notReady : '')

  // ---- 利用額の報告（送れるまで残す） ----
  let flushing = false
  function queueUsage(u) {
    const q = readJson(queueFile, [])
    q.push({ runId: randomUUID(), at: new Date().toISOString(), appVersion: app.getVersion(), ...u })
    atomicWrite(queueFile, JSON.stringify(q.slice(-2000)))
    flushUsage()
  }
  async function flushUsage() {
    if (flushing) return
    flushing = true
    try {
      for (;;) {
        const q = readJson(queueFile, [])
        if (!q.length) break
        const { at, ...body } = q[0]
        void at
        let drop = false
        try {
          const r = await doFetch('/api/agent/usage', { method: 'POST', headers: { 'content-type': 'application/json', 'x-esco-shell': '1' }, body: JSON.stringify(body) })
          if (r.ok) {
            drop = true
            const j = await r.json().catch(() => ({}))
            if (typeof j.remainPct === 'number') { access = { ...access, remainPct: j.remainPct }; emitAll('usage:updated', { remainPct: j.remainPct }) }
            if (j.blocked && !access.blocked) { access = { ...access, blocked: true, ready: false, apiKey: '' }; emitAll('agent:notice', { message: MSG.blocked }) }
          } else if (r.status === 400 || r.status === 404) {
            drop = true // 形が違う・対象者でなくなった報告は、何度送っても通らないので捨てる（記録は残す）
            log('[agent] 利用額の報告が受け付けられませんでした ' + r.status + ' ' + JSON.stringify({ ...body, costUsd: body.costUsd }))
          } else break // 401・サーバーの不調：あとで送り直す
        } catch { break }
        if (drop) {
          const now = readJson(queueFile, [])
          atomicWrite(queueFile, JSON.stringify(now.filter((x) => x.runId !== body.runId)))
        }
      }
    } finally { flushing = false }
  }
  // AgentRunner の通知を受ける口：利用額の通知（agent:usage）はここで受けて報告し、画面には流さない
  function wrapUsage(emit) {
    return (ev, payload) => {
      if (ev === 'agent:usage') {
        if (payload && (payload.costUsd > 0 || payload.estimated)) queueUsage(payload)
        return
      }
      emit(ev, payload)
    }
  }
  const newRunner = (emit) => (test.runnerFactory ? test.runnerFactory({ getSettings: runnerSettings, emit: wrapUsage(emit) })
    : new AgentRunner({ getSettings: runnerSettings, emit: wrapUsage(emit) }))

  // 作業フォルダ未選択のときに AI が動く場所（利用者には見せない）
  function scratchDir() {
    const p = path.join(dataDir, 'scratch')
    fs.mkdirSync(p, { recursive: true })
    return p
  }

  function createContext(session = sessionStore.create()) {
    const ctx = { win: null, workFolder: session.workFolder, busy: false, watcher: null, watchTimer: null,
      asks: new Map(), choices: new Map(), unread: false, status: '待機中' }
    ctx.emit = (ev, payload) => { for (const view of windows.values()) if (view.active === ctx) view.emit(ev, payload) }
    ctx.history = new SessionRecorder(sessionStore, () => emitAll('sessions:changed', {}),
      () => ctx.emit('history:error', { message: '履歴を保存できませんでした。空き容量・アクセス権を確認してください。' }))
    ctx.history.session = session
    ctx.runner = newRunner((ev, payload) => {
      ctx.history.event(ev, payload, ctx.runner)
      if (ev === 'agent:ask') { ctx.asks.set(payload.requestId, payload); ctx.status = '確認待ち' }
      if (ev === 'agent:choice') { ctx.choices.set(payload.requestId, payload); ctx.status = '確認待ち' }
      if (ev === 'agent:error') ctx.status = 'エラー'
      if (ev === 'agent:token' || ev === 'agent:tool') ctx.status = '作業中'
      ctx.emit(ev, payload)
      if (ev === 'agent:ask' || ev === 'agent:choice') emitAll('sessions:changed', {})
    })
    ctx.runner.sessionId = session.sessionId || undefined
    ctx.runner.sessionCwd = session.sessionCwd || undefined
    contexts.set(session.id, ctx)
    return ctx
  }
  function snapshot(ctx) {
    return { ...ctx.history.session, workFolder: ctx.workFolder, busy: ctx.busy, status: ctx.status,
      asks: [...ctx.asks.values()], choices: [...ctx.choices.values()] }
  }
  function selectContext(view, ctx) {
    view.active = ctx; ctx.win = view.win; ctx.unread = false
    watchFolder(ctx)
    emitAll('sessions:changed', {})
    return snapshot(ctx)
  }
  const stateOf = (event) => windows.get(event.sender.id)?.active

  function setWorkFolder(state, folder) {
    state.workFolder = folder
    state.history.session.workFolder = folder
    state.history.flush()
    watchFolder(state)
    state.emit('folder:changed', { workFolder: folder })
  }
  function watchFolder(state) {
    try { state.watcher?.close() } catch { /* ignore */ }
    state.watcher = null
    if (!state.workFolder) return
    try {
      const w = fs.watch(state.workFolder, { recursive: true }, (_ev, filename) => {
        const name = String(filename || '')
        if (name.includes('node_modules') || /(^|[\\/])\./.test(name)) return
        clearTimeout(state.watchTimer)
        state.watchTimer = setTimeout(() => state.emit('fs:changed', {}), 500)
      })
      // 監視中にフォルダが消える・切れると 'error' が飛ぶ。受けないとアプリごと落ちる
      w.on('error', () => {
        try { w.close() } catch { /* ignore */ }
        state.watcher = null
        if (state.workFolder && !fs.existsSync(state.workFolder)) setWorkFolder(state, null)
      })
      state.watcher = w
    } catch { state.watcher = null }
  }
  function isInsideFolder(child, parent) {
    const rel = path.relative(path.resolve(parent), path.resolve(child))
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
  }

  function createWindow() {
    const win = new BrowserWindow({ width: 1280, height: 800, minWidth: 900, minHeight: 550, show: !test.hidden,
      title: 'ESCO Works エージェント', icon: path.join(__dirname, 'build', 'icon.png'), autoHideMenuBar: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
    const view = { win, active: createContext(), emit: (ev, payload) => { if (!win.isDestroyed()) win.webContents.send(ev, payload) } }
    view.active.win = win
    const windowId = win.webContents.id
    windows.set(windowId, view)
    win.on('closed', () => { windows.delete(windowId); emitAll('sessions:changed', {}) })
    // エージェントの画面は同梱のファイルだけを表示する。外のページへは移らせない
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
    return win
  }

  // ---- 初回の準備（データ置き場・画面からの呼び出し口） ----
  function init() {
    if (ready) return
    ready = true
    try { seedFromLegacy(userData, dataDir, log) } catch (e) { log('[agent] 旧データの写しに失敗（続行） ' + (e && e.message)) }
    settings = loadSettings()
    if (!settings.staffId) { settings.staffId = randomUUID(); saveSettings() }
    sessionStore = new SessionStore(path.join(dataDir, 'sessions'))
    projectStore = new ProjectStore(path.join(dataDir, 'projects'))
    businessStore = new BusinessStore(path.join(dataDir, 'business'), () => settings, (payload) => emitAll('business:status', payload))
    businessTimer = setInterval(() => businessStore.state.entries.length && businessStore.sync(), 60000)
    setInterval(flushUsage, 5 * 60 * 1000)
    flushUsage()

    ipcMain.handle('app:init', (e) => {
      const s = stateOf(e)
      return {
        settings: viewSettings(), hasApiKey: !notice(), notice: notice(), workFolder: s.workFolder,
        monthUsd: 0, remainPct: access.remainPct, version: app.getVersion(), session: snapshot(s), busy: s.busy
      }
    })
    ipcMain.handle('settings:save', (_e, next) => {
      const { apiKey, remote, relay, remoteDevices, ...rest } = next || {}
      void apiKey; void remote; void relay; void remoteDevices
      settings = { ...settings, ...rest, models: { ...settings.models, ...(rest.models || {}) } }
      for (const k of Object.keys(settings.models)) settings.models[k] = normalizeModel(settings.models[k])
      saveSettings()
      emitAll('settings:changed', viewSettings())
      return true
    })
    ipcMain.handle('folder:pick', async (e) => {
      const s = stateOf(e)
      if (s.busy) throw new Error('作業が終わってからフォルダを変更してください')
      const r = await dialog.showOpenDialog(s.win, { title: '作業フォルダを選択', defaultPath: s.workFolder || app.getPath('documents'), properties: ['openDirectory', 'createDirectory'] })
      if (!r.canceled && r.filePaths[0]) {
        if (s.busy) throw new Error('作業が終わってからフォルダを変更してください')
        setWorkFolder(s, r.filePaths[0])
      }
      return s.workFolder
    })
    const LIST_CAP = 500
    ipcMain.handle('fs:list', async (e, dirPath) => {
      const s = stateOf(e)
      if (!s.workFolder) return { items: [], truncated: 0 }
      const dir = dirPath || s.workFolder
      if (!isInsideFolder(dir, s.workFolder)) return { items: [], truncated: 0 }
      try {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true })
        const sorted = entries.filter((d) => d.name !== 'node_modules' && !d.name.startsWith('.'))
          .map((d) => ({ name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory() }))
          .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'ja')))
        return { items: sorted.slice(0, LIST_CAP), truncated: Math.max(0, sorted.length - LIST_CAP) }
      } catch { return { items: [], truncated: 0 } }
    })
    ipcMain.handle('fs:open', (e, p) => {
      const s = stateOf(e)
      if (!s.workFolder || !isInsideFolder(p, s.workFolder)) return false
      shell.openPath(p)
      return true
    })

    ipcMain.handle('chat:send', async (e, { text, mode, autoApprove, permMode, sessionId }) => {
      const s = stateOf(e)
      if (sessionId && sessionId !== s.history.session.id) throw new Error('セッションが切り替わりました。もう一度送信してください')
      if (s.busy) throw new Error('このセッションは実行中です')
      if (s.history.session.deleted || s.history.session.archived) throw new Error('復元してから送信してください')
      if (s.history.session.kind === 'business' && [...contexts.values()].some((c) => c.busy && c.history.session.kind === 'business')) throw new Error('業務整理が完了するまでお待ちください')
      if (typeof text !== 'string' || !text.trim()) throw new Error('メッセージを入力してください')
      mode = ['chat', 'docs', 'files'].includes(mode) ? mode : 'chat'
      // 動かす前に毎回、使えるか（対象者か・今月の枠が残っているか）をサーバーに確かめる
      s.busy = true
      try {
        await refreshAccess()
        const why = notice()
        if (why) { emitAll('agent:notice', { message: why }); throw new Error(why) }
      } catch (err) { s.busy = false; throw err }
      emitAll('agent:notice', { message: '' })
      s.status = '作業中'
      let entryId
      let releaseFolder = () => {}
      const messageStart = s.history.session.messages.length
      const history = s.history.session.messages.filter((m) => m.role === 'user' || m.role === 'ai').map((m) => ({ role: m.role, text: m.text }))
      try {
        if (s.history.session.kind === 'business') {
          entryId = businessStore.capture(text, s.history.session.id)
          businessStore.sync()
        }
        s.history.begin(text, mode, s.workFolder)
        const lock = folderQueue.request(s.workFolder)
        s.cancelQueue = lock.cancel
        s.status = '順番待ち'
        emitAll('sessions:changed', {})
        releaseFolder = await lock.wait
        s.cancelQueue = null
        s.status = '作業中'
        if (s.workFolder && !fs.existsSync(s.workFolder)) setWorkFolder(s, null)
        log(`[agent][chat:send] mode=${mode} perm=${permMode} len=${text.length}`)
        const project = projectStore.list().find((p) => p.id === s.history.session.projectId)
        emitAll('sessions:changed', {})
        await s.runner.startTurn({
          text, history,
          systemInstructions: entryId ? businessStore.instructions() : project?.instructions || '',
          interview: !!entryId, mode, workFolder: s.workFolder, cwd: scratchDir(), autoApprove, permMode
        })
        if (entryId) {
          const output = s.history.session.messages.slice(messageStart).filter((m) => m.role === 'ai').map((m) => m.text).join('\n')
          businessStore.integrate(output, entryId)
          await businessStore.sync()
        }
        return true
      } catch (error) {
        s.status = 'エラー'
        s.history.event('agent:error', { message: error.message }, s.runner)
        throw error
      } finally {
        releaseFolder()
        s.cancelQueue = null
        s.history.finish(s.runner)
        s.busy = false
        s.asks.clear(); s.choices.clear()
        if (s.status !== 'エラー') s.status = '完了'
        s.unread = ![...windows.values()].some((v) => v.active === s)
        s.emit('chat:idle', {})
        emitAll('sessions:changed', {})
      }
    })
    ipcMain.on('chat:interrupt', (e) => { const s = stateOf(e); if (s?.cancelQueue) s.cancelQueue(); else s?.runner.interrupt() })
    ipcMain.handle('chat:new', (e, input = {}) => {
      const view = windows.get(e.sender.id)
      const session = sessionStore.create()
      if (input.projectId) {
        let project = null
        try { project = projectStore.get(input.projectId) } catch { project = null }
        if (project) { session.projectId = project.id; session.workFolder = project.folder }
      }
      if (input.kind === 'business') { session.kind = 'business'; session.title = '私の業務を教える'; session.customTitle = true; session.pinned = true }
      sessionStore.save(session)
      return selectContext(view, createContext(session))
    })
    ipcMain.handle('sessions:list', (e) => ({ currentId: stateOf(e)?.history.session.id || null, projects: projectStore.list(),
      items: sessionStore.list().map((item) => ({ ...item,
        busy: !!contexts.get(item.id)?.busy, status: contexts.get(item.id)?.status || '待機中', unread: !!contexts.get(item.id)?.unread,
        openElsewhere: [...windows.values()].some((v) => v.win.webContents.id !== e.sender.id && v.active.history.session.id === item.id)
      })) }))
    ipcMain.handle('sessions:open', (e, id) => {
      const view = windows.get(e.sender.id)
      const owner = [...windows.values()].find((v) => v !== view && v.active.history.session.id === id)
      if (owner) { owner.win.show(); owner.win.focus(); throw new Error('別ウィンドウで開いています。そのウィンドウを表示しました。') }
      const ctx = contexts.get(id) || createContext(sessionStore.read(id))
      return selectContext(view, ctx)
    })
    ipcMain.handle('sessions:update', (_e, { id, action, value }) => {
      const ctx = contexts.get(id)
      if (ctx?.busy && !['rename', 'pin'].includes(action)) throw new Error('実行中の作業を停止してから操作してください')
      const session = ctx?.history.session || sessionStore.read(id)
      if (action === 'rename') { if (!String(value || '').trim()) throw new Error('名前を入力してください'); session.title = String(value).trim().slice(0, 120); session.customTitle = true }
      else if (action === 'pin') session.pinned = !session.pinned
      else if (action === 'archive') session.archived = true
      else if (action === 'trash') session.deleted = true
      else if (action === 'restore') { session.archived = false; session.deleted = false }
      else if (action === 'move') { if (value) projectStore.get(value); session.projectId = value || null }
      else throw new Error('操作が不正です')
      sessionStore.save(session); emitAll('sessions:changed', {}); return ctx ? snapshot(ctx) : session
    })
    ipcMain.handle('sessions:purge', async (e, id) => {
      const session = sessionStore.read(id)
      if (!session.deleted || contexts.get(id)?.busy) throw new Error('ゴミ箱内の停止したセッションだけ削除できます')
      const { response } = await dialog.showMessageBox(windows.get(e.sender.id).win, { type: 'warning', buttons: ['キャンセル', '完全に削除'], defaultId: 0, cancelId: 0,
        message: '「' + session.title + '」の会話履歴を完全に削除しますか？', detail: '元に戻せません。作成した業務ファイル・共有MDは削除しません。' })
      if (response !== 1) return false
      const ctx = contexts.get(id); if (ctx) { clearTimeout(ctx.history.timer); ctx.watcher?.close() }
      contexts.delete(id); fs.unlinkSync(sessionStore.file(id))
      for (const view of windows.values()) if (view.active.history.session.id === id) { selectContext(view, createContext()); view.emit('session:selected', snapshot(view.active)) }
      emitAll('sessions:changed', {}); return true
    })
    ipcMain.handle('projects:save', (_e, input) => { const p = projectStore.save(input); emitAll('sessions:changed', {}); return p })
    ipcMain.handle('projects:delete', (_e, id) => {
      const project = projectStore.get(id)
      const members = sessionStore.list().filter((s) => s.projectId === project.id)
      if (members.some((s) => contexts.get(s.id)?.busy)) throw new Error('このプロジェクト内で実行中の作業を停止してから削除してください')
      for (const item of members) {
        const session = contexts.get(item.id)?.history.session || sessionStore.read(item.id)
        session.projectId = null
        sessionStore.save(session)
      }
      projectStore.remove(project.id)
      emitAll('sessions:changed', {})
      return { id: project.id, moved: members.length }
    })
    ipcMain.handle('projects:folder', async (e) => { const r = await dialog.showOpenDialog(windows.get(e.sender.id).win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0] })
    ipcMain.handle('business:status', () => businessStore.status())
    ipcMain.handle('business:sync', () => businessStore.sync())
    ipcMain.handle('business:folder', async (e) => {
      const r = await dialog.showOpenDialog(windows.get(e.sender.id).win, { title: 'Google Drive内のESCO_業務共有を選択', properties: ['openDirectory'] })
      if (!r.canceled) { settings.businessFolder = r.filePaths[0]; saveSettings(); emitAll('settings:changed', viewSettings()); await businessStore.sync() }
      return settings.businessFolder || ''
    })
    ipcMain.handle('fs:preview', async (e, file) => {
      const ctx = stateOf(e)
      if (!ctx.workFolder || !isInsideFolder(file, ctx.workFolder)) throw new Error('作業フォルダ内のファイルを選択してください')
      const real = await fs.promises.realpath(file)
      if (!isInsideFolder(real, await fs.promises.realpath(ctx.workFolder))) throw new Error('フォルダ外のリンクは表示できません')
      const stat = await fs.promises.stat(real)
      if (stat.size > 512000 || !/\.(md|txt|csv|json|js|css|html|log|ya?ml)$/i.test(real)) return { text: 'プレビュー対象外です。ダブルクリックすると既定のアプリで開きます。' }
      return { text: await fs.promises.readFile(real, 'utf8') }
    })
    ipcMain.on('perm:respond', (e, { requestId, approved, remember }) => {
      const s = stateOf(e); if (!s?.asks.has(requestId)) return
      s.asks.delete(requestId); s.runner.respondPermission(requestId, approved, remember); s.status = '作業中'; emitAll('sessions:changed', {})
    })
    ipcMain.on('choice:respond', (e, { requestId, answer }) => {
      const s = stateOf(e); if (!s?.choices.has(requestId)) return
      s.choices.delete(requestId); s.runner.respondChoice(requestId, answer); s.status = '作業中'; emitAll('sessions:changed', {})
    })
    ipcMain.on('window:new', (e) => { if (windows.has(e.sender.id)) createWindow() })
    ipcMain.on('update:install', () => onUpdate.install && onUpdate.install())
    ipcMain.handle('update:check', () => (onUpdate.check ? onUpdate.check() : Promise.resolve({ state: 'dev' })))
    // スマホ連携（旧版）は戻していない。画面の古い呼び出しには「使わない」と答える
    const remoteOff = () => ({ mode: 'off', enabled: false, hasConnectCode: false, state: 'stopped', devices: [] })
    ipcMain.handle('remote:setMode', remoteOff)
    ipcMain.handle('remote:setConnectCode', () => ({ error: 'この版ではスマホ連携は使えません。スマホではチャットをご利用ください。' }))
    ipcMain.handle('remote:status', remoteOff)
    ipcMain.handle('remote:qr', () => ({ error: 'この版ではスマホ連携は使えません。' }))
    ipcMain.handle('remote:revoke', remoteOff)
    ipcMain.on('workspace:open', () => {})

    app.on('will-quit', () => {
      clearInterval(businessTimer)
      for (const ctx of contexts.values()) { try { ctx.runner.interrupt() } catch { /* ignore */ } ctx.history.finish(ctx.runner); ctx.watcher?.close(); clearTimeout(ctx.watchTimer) }
    })
  }

  /** エージェントの画面を開く（開いていれば前に出す）。使えない人には理由を返すだけで開かない */
  async function open() {
    await refreshAccess()
    if (!access.enabled) return { opened: false, reason: access.offline ? MSG.offline : MSG.off }
    init()
    if (access.userName && !settings.userName) { settings.userName = access.userName; saveSettings() }
    const first = [...windows.values()][0]
    if (first) { if (first.win.isMinimized()) first.win.restore(); first.win.show(); first.win.focus(); return { opened: true, win: first.win } }
    return { opened: true, win: createWindow() }
  }

  return {
    open,
    refreshAccess,
    access: () => ({ enabled: access.enabled, blocked: access.blocked, ready: access.ready, offline: access.offline }),
    isBusy: () => AgentRunner.activeTurns > 0 || [...contexts.values()].some((c) => c.busy),
    emitAll,
    flushUsage,
    dataDir
  }
}

module.exports = { setupAgent, seedFromLegacy, MSG }
