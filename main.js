// ESCO Works（v0.4.0〜）Electron の殻。
// 画面そのものは、社内のAIチャット（クラウド）の Web 画面を表示するだけ。
// 殻がやること：ウィンドウ／自動更新／初回の自動ログイン／旧エスコワークスの履歴の取り込み。
// v0.5.0〜：指定された人だけ、PCのファイルを扱える「エージェント」の画面を別ウィンドウで開ける（agentMain.js）。
const { app, BrowserWindow, Menu, shell, dialog, session, safeStorage, ipcMain } = require('electron')
const path = require('path')
const fs = require('fs')
const { baseUrl, joinKey } = require('./config')
const { normName, extractNames } = require('./nameMatch')
const { autoLogin } = require('./login')
const { candidateDirs, readLegacy } = require('./legacy')
const { runImport, clearApiKeys, deviceIdFor, ImportError } = require('./importer')
const { setupAutoUpdate } = require('./updater')
const { setupAgent } = require('./agentMain')

const TEST = process.env.ESCO_TEST === '1'
if (TEST) {
  // テストは必ず専用の userData で動かす（本物の利用者データに触れない）
  if (!process.env.ESCO_TEST_USERDATA) { console.error('ESCO_TEST=1 には ESCO_TEST_USERDATA が必要です'); process.exit(2) }
  app.setPath('userData', process.env.ESCO_TEST_USERDATA)
}
// 配布前の検査：「ESCO Works.exe --agent-selftest」で、パッケージにした状態のままエージェントの頭脳（同梱の claude.exe）が
// 本当に動くかを確かめる。画面は出さない。キーは環境変数 ESCO_SELFTEST_KEY、結果は ESCO_SELFTEST_OUT のファイルに書く。
// 本物の利用者データには触れない（一時フォルダを使う）。サーバーにもつながない。
const SELFTEST = process.argv.includes('--agent-selftest')
if (SELFTEST) app.setPath('userData', fs.mkdtempSync(path.join(require('os').tmpdir(), 'esco-agent-selftest-')))
async function runAgentSelftest() {
  const outFile = process.env.ESCO_SELFTEST_OUT
  const res = { version: app.getVersion(), packaged: app.isPackaged, arch: process.arch, ok: false, text: '', tools: [], usage: null, error: null }
  const finish = (code) => { try { if (outFile) fs.writeFileSync(outFile, JSON.stringify(res, null, 2)) } catch { /* 書けなくても終了する */ } app.exit(code) }
  const timer = setTimeout(() => { res.error = '時間切れ（120秒）'; finish(1) }, 120000)
  try {
    if (!process.env.ESCO_SELFTEST_KEY) throw new Error('ESCO_SELFTEST_KEY がありません')
    const { AgentRunner } = require('./agent')
    const work = path.join(app.getPath('userData'), 'work')
    fs.mkdirSync(work, { recursive: true })
    const runner = new AgentRunner({
      getSettings: () => ({ apiKey: process.env.ESCO_SELFTEST_KEY, models: { chat: 'claude-sonnet-5-5', docs: 'claude-sonnet-5-5', files: 'claude-sonnet-5-5' }, enableBrowser: false }),
      emit: (ev, p) => {
        if (ev === 'agent:token') res.text += p.delta
        if (ev === 'agent:text') res.text += p.text
        if (ev === 'agent:tool') res.tools.push(p.tool)
        if (ev === 'agent:usage') res.usage = p
        if (ev === 'agent:error') res.error = p.message
        if (ev === 'agent:ask') runner.respondPermission(p.requestId, true, false)
      }
    })
    // ファイルを実際に1つ作らせる（＝PCのファイル操作まで通ること）
    await runner.startTurn({ text: 'この作業フォルダに selftest.txt というファイルを作り、中身を「エージェント動作OK」の1行にしてください。終わったら「完了」とだけ答えてください。', mode: 'files', workFolder: work, cwd: work, autoApprove: true, permMode: 'bypass' })
    let made = ''
    try { made = fs.readFileSync(path.join(work, 'selftest.txt'), 'utf8').trim() } catch { /* 作られていない */ }
    res.fileContent = made
    res.ok = !res.error && made.includes('エージェント動作OK') && !!res.usage && res.usage.costUsd > 0
    clearTimeout(timer); finish(res.ok ? 0 : 1)
  } catch (e) { res.error = String((e && e.message) || e); clearTimeout(timer); finish(1) }
}

const APP_TITLE = 'ESCO Works'
const BASE = baseUrl()
const BASE_ORIGIN = new URL(BASE).origin
const KEY = joinKey()
const OFFLINE_PAGE = path.join(__dirname, 'shell', 'offline.html')
const FAST = TEST && process.env.ESCO_TEST_FAST === '1' // テスト時は待ち時間を縮める

if (!app.requestSingleInstanceLock()) { app.quit() } // 起動は1つだけ（2つ目は既存を前面に出して終了）

let win = null
let banner = null // { text, kind }
let offline = false
let importDone = false
let importRunning = false
let importFails = 0
let importTimer = null
let confirmedMismatch = false
let agent = null   // エージェント（指定された人だけ）。app の準備ができてから作る
let updater = null
const telemetry = { loaded: [], external: [], blocked: [], downloads: [], login: null, import: null, events: [], agent: null }

// ---- ログ（userData/shell.log。1MBを超えたら作り直す） ----
function log(msg) {
  const line = new Date().toISOString() + ' ' + msg
  try {
    const f = path.join(app.getPath('userData'), 'shell.log')
    try { if (fs.statSync(f).size > 1024 * 1024) fs.renameSync(f, f + '.old') } catch { /* なし */ }
    fs.appendFileSync(f, line + '\n')
  } catch { /* ログが書けなくても動く */ }
  if (TEST) { telemetry.events.push(line); console.log(line) }
}

const isInternal = (url) => { try { return new URL(url).origin === BASE_ORIGIN } catch { return false } }

function openExternal(url) {
  let u
  try { u = new URL(url) } catch { return }
  if (!['http:', 'https:', 'mailto:'].includes(u.protocol)) { telemetry.blocked.push(url); return }
  telemetry.external.push(url)
  if (TEST) return // テストでは実際には開かない
  shell.openExternal(url).catch(() => {})
}

// ---- Cookie の入れ物は Electron の標準セッション。fetch もこの Cookie を使う ----
const ses = () => session.defaultSession
function doFetch(p, init = {}) {
  return ses().fetch(BASE + p, { credentials: 'include', redirect: 'follow', signal: AbortSignal.timeout(120000), ...init })
}

// 自動ログインで受け取った Cookie が「ブラウザを閉じたら消える」形なら、約1年に延ばして保存する
async function persistSessionCookie() {
  const list = await ses().cookies.get({ url: BASE, name: 'aichat_session' })
  const c = list[0]
  if (!c) return false
  const year = Math.floor(Date.now() / 1000) + 365 * 24 * 3600
  if (!c.expirationDate || c.expirationDate < year - 30 * 24 * 3600) {
    await ses().cookies.set({
      url: BASE, name: 'aichat_session', value: c.value, path: '/', httpOnly: true,
      secure: BASE.startsWith('https:'), sameSite: 'lax', expirationDate: year
    })
  }
  await ses().cookies.flushStore()
  return true
}

async function whoami() {
  try {
    const r = await doFetch('/api/conversations')
    if (r.status === 401) return { loggedIn: false }
    if (!r.ok) return { loggedIn: false, status: r.status }
    const j = await r.json()
    return { loggedIn: true, name: j.user && j.user.name, needsConsent: !!j.needsConsent }
  } catch (e) {
    return { loggedIn: false, network: true, detail: String((e && e.message) || e) }
  }
}

// ---- 旧データの場所 ----
function legacyDirs() {
  const ud = app.getPath('userData')
  if (TEST) {
    const extra = (process.env.ESCO_LEGACY_DIRS || '').split(path.delimiter).filter(Boolean)
    return candidateDirs(ud, null, extra)
  }
  return candidateDirs(ud, app.getPath('appData'))
}

function legacyNames(dirs) {
  const decrypt = (buf) => safeStorage.decryptString(buf)
  return extractNames(dirs, safeStorage.isEncryptionAvailable() ? decrypt : null)
}

// ---- 画面の下に出す小さな表示（取り込みの経過） ----
function setBanner(text, kind) {
  banner = text ? { text, kind } : null
  injectBanner()
}
function injectBanner() {
  if (!win || win.isDestroyed() || offline) return
  const b = banner
  const color = !b ? '' : b.kind === 'error' ? '#b3261e' : b.kind === 'ok' ? '#1b7f3b' : '#1f4fd8'
  const js = '(()=>{const id="esco-shell-banner";let e=document.getElementById(id);const t=' + JSON.stringify(b ? b.text : '') + ';' +
    'if(!t){if(e)e.remove();return}' +
    'if(!e){e=document.createElement("div");e.id=id;e.setAttribute("role","status");' +
    'e.style.cssText="position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:2147483647;padding:8px 16px;border-radius:999px;font:13px system-ui,sans-serif;color:#fff;box-shadow:0 2px 10px rgba(0,0,0,.25);pointer-events:none;max-width:90vw";' +
    'if(document.body)document.body.appendChild(e);else return}' +
    'e.textContent=t;e.style.background=' + JSON.stringify(color) + '})()'
  win.webContents.executeJavaScript(js).catch(() => {})
}

// ---- 取り込みの進め方 ----
function scheduleImport(ms) {
  clearTimeout(importTimer)
  if (importDone) return
  importTimer = setTimeout(importTick, FAST ? Math.min(ms, 400) : ms)
}

async function importTick() {
  if (importDone || importRunning) return
  importRunning = true
  try {
    const me = await whoami()
    if (!me.loggedIn || me.needsConsent) { scheduleImport(15000); return } // ログインと同意が済むまで待つ
    const dirs = legacyDirs()
    const names = legacyNames(dirs)
    const peekForConfirm = readLegacy(dirs)
    const hasConversations = peekForConfirm.sessions.length > 0

    // 旧アプリのお名前と今ログインしている名前が違うとき、または旧アプリにお名前の登録が無いのに会話があるときは、
    // 本人に確認してから移す（選び間違いで他人の履歴を渡さない）
    const nameMismatch = names.length && me.name && !names.some((n) => normName(n) === normName(me.name))
    const noNameButData = !names.length && hasConversations
    if ((nameMismatch || noNameButData) && !confirmedMismatch) {
      const auto = TEST ? process.env.ESCO_TEST_CONFIRM : null
      let yes
      if (auto) yes = auto === 'yes'
      else {
        const r = await dialog.showMessageBox(win || undefined, {
          type: 'question', buttons: ['移す', 'あとで'], defaultId: 1, cancelId: 1, title: APP_TITLE,
          message: 'このPCの過去の会話を「' + me.name + '」さんのものとして移します。よろしいですか？',
          detail: (names.length ? '旧アプリに登録されていたお名前：' + names.join('、') : '旧アプリにはお名前の登録がありませんでした。') +
            '\n違うお名前でログインしている場合は「あとで」を選び、ログインし直してください。'
        })
        yes = r.response === 0
      }
      if (!yes) { log('[import] 名前が一致しないため保留（本人が「あとで」を選択）'); telemetry.import = { status: 'held_mismatch' }; scheduleImport(10 * 60 * 1000); return }
      confirmedMismatch = true
    }

    const peek = readLegacy(dirs)
    const hasData = peek.sessions.length || peek.projects.length || peek.business || peek.unreadable.length
    if (hasData) setBanner('過去の会話を移しています…', 'info')
    const res = await runImport({ doFetch, userData: app.getPath('userData'), deviceId: deviceIdFor(app.getPath('userData')), dirs, log, ...(FAST ? { sleep: async () => {} } : {}) })
    // 受領確認まで完了した。ここで初めて旧APIキーを消す（取り込みが終わらない限り消さない）
    const cleared = clearApiKeys(dirs)
    importDone = true
    telemetry.import = { status: res.status, totals: res.receipt.totals, clearedApiKeyFiles: cleared.length }
    log('[import] 完了 ' + JSON.stringify(res.receipt.totals) + ' 旧APIキー消去 ' + cleared.length + ' 件')
    if (hasData && res.status === 'done') {
      setBanner('過去の会話の移行が完了しました（会話 ' + res.receipt.totals.conversations + ' 件）', 'ok')
      setTimeout(() => { if (win && !win.isDestroyed() && !offline) win.webContents.reload() }, FAST ? 300 : 2500)
      setTimeout(() => setBanner(null), FAST ? 1500 : 9000)
    } else setBanner(null)
    finishTest()
  } catch (e) {
    importFails++
    const kind = e instanceof ImportError ? e.kind : 'error'
    log('[import] 失敗(' + kind + '): ' + (e && e.message))
    telemetry.import = { status: 'failed', kind, message: String(e && e.message) }
    if (kind === 'auth') { setBanner(null); scheduleImport(15000) }
    else {
      setBanner('過去の会話の移行がまだ終わっていません。自動でやり直します。', 'error')
      scheduleImport(Math.min(30 * 60 * 1000, 60000 * 2 ** Math.min(importFails - 1, 5)))
    }
  } finally {
    importRunning = false
  }
}

// ---- ウィンドウ ----
function guard(wc) {
  wc.on('will-navigate', (e, url) => { if (!isInternal(url)) { e.preventDefault(); openExternal(url) } })
  wc.setWindowOpenHandler(({ url }) => {
    if (isInternal(url)) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1000, height: 800, title: APP_TITLE, autoHideMenuBar: true, show: !TEST || process.env.ESCO_TEST_HIDDEN !== '1' } }
    }
    openExternal(url)
    return { action: 'deny' }
  })
  wc.on('did-create-window', (child) => { child.setTitle(APP_TITLE); child.on('page-title-updated', (e) => e.preventDefault()); guard(child.webContents) })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 850, minWidth: 760, minHeight: 550, title: APP_TITLE, autoHideMenuBar: true,
    show: !(TEST && process.env.ESCO_TEST_HIDDEN === '1'),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, devTools: TEST,
      preload: path.join(__dirname, 'shell', 'cloudPreload.js') }
  })
  guard(win.webContents)
  win.on('page-title-updated', (e) => e.preventDefault()) // タイトルは常に「ESCO Works」
  win.on('closed', () => { win = null })
  win.webContents.on('did-finish-load', () => {
    const u = win && win.webContents.getURL()
    if (u) telemetry.loaded.push(u)
    if (u && isInternal(u)) offline = false
    injectBanner()
  })
  win.webContents.on('did-navigate-in-page', injectBanner)
  win.webContents.on('did-fail-load', (_e, code, desc, url, isMain) => {
    if (!isMain || code === -3) return // -3 は途中で別のページへ移っただけ
    if (url && url.startsWith('file:')) return
    log('[window] 読み込み失敗 ' + code + ' ' + desc)
    showOffline()
  })
}

let retryTimer = null
function showOffline() {
  if (!win || win.isDestroyed()) return
  offline = true
  win.loadFile(OFFLINE_PAGE, { query: { u: BASE + '/' } }).catch(() => {})
  clearTimeout(retryTimer)
  retryTimer = setTimeout(retryOnline, FAST ? 500 : 30000)
}
async function retryOnline() {
  if (!win || win.isDestroyed()) return
  const me = await whoami()
  if (me.network) { retryTimer = setTimeout(retryOnline, FAST ? 500 : 30000); return }
  offline = false
  win.loadURL(BASE + '/')
}

async function start() {
  createWindow()
  const dirs = legacyDirs()
  log('[start] v' + app.getVersion() + ' ' + BASE + ' 旧データの場所 ' + dirs.length + ' か所 鍵' + (KEY ? 'あり' : 'なし'))
  const me = await whoami()
  let target = BASE + '/'
  if (me.network) {
    showOffline()
  } else {
    if (!me.loggedIn) {
      const r = await autoLogin({ doFetch, key: KEY, names: legacyNames(dirs), log })
      telemetry.login = r
      log('[login] ' + r.result + (r.reason ? ' (' + r.reason + ')' : ''))
      if (r.result === 'logged_in') await persistSessionCookie()
      else if (r.result === 'need_picker') target = BASE + '/join#k=' + KEY
      else if (r.result === 'error') { showOffline(); scheduleImport(5000); return }
    }
    win.loadURL(target).catch(() => {})
  }
  if (TEST && process.env.ESCO_TEST_AGENT === '1') agentScenario = runAgentScenario()
  scheduleImport(3000)
}

// ---- テスト専用：エージェントの一連の流れ（入口の表示判定→画面を開く→1回動かす→利用額の報告）を自動でたどる ----
let agentScenario = null
async function runAgentScenario() {
  const out = { steps: [] }
  telemetry.agentScenario = out
  const wait = async (fn, ms = 8000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await new Promise((r) => setTimeout(r, 150)) } }
  try {
    const okPage = await wait(() => win && !win.isDestroyed() && isInternal(win.webContents.getURL()) && !win.webContents.isLoading())
    if (!okPage) { out.error = 'チャット画面を読み込めませんでした'; return }
    out.status = await win.webContents.executeJavaScript('window.escoShell.agentStatus()')
    // 画面の見え方の確認用（ESCO_TEST_SHOTS にフォルダを渡すと PNG を保存する。ウィンドウは表示したまま撮る）
    const shots = process.env.ESCO_TEST_SHOTS
    const shoot = async (w, name) => {
      if (!shots) return
      w.show(); w.focus(); w.moveTop()
      await new Promise((r) => setTimeout(r, 1500))
      await w.webContents.capturePage()
      await new Promise((r) => setTimeout(r, 400))
      fs.writeFileSync(path.join(shots, name), (await w.webContents.capturePage()).toPNG())
    }
    await shoot(win, '1_chat.png')
    await win.webContents.executeJavaScript('window.escoShell.openAgent()')
    const aw = await wait(() => BrowserWindow.getAllWindows().find((w) => w !== win && w.webContents.getURL().includes('renderer/index.html') && !w.webContents.isLoading()), 5000)
    out.opened = !!aw
    if (!aw) return
    out.title = aw.getTitle()
    out.init = await aw.webContents.executeJavaScript('window.escoAI.init().then((i) => ({ hasApiKey: i.hasApiKey, notice: i.notice, apiKeyShown: i.settings.apiKey, userName: i.settings.userName }))')
    out.sessions = await aw.webContents.executeJavaScript('window.escoAI.listSessions().then((l) => l.items.length)')
    const n = Number(process.env.ESCO_TEST_AGENT_SENDS || 1)
    out.sends = []
    if (shots) {
      // 見え方の確認用：人が操作するのと同じに、タブを選び、入力欄に書いて「送信」を押す
      await aw.webContents.executeJavaScript(`(() => { document.querySelector('.mode[data-mode="docs"]').click(); const t = document.getElementById('input'); t.value = ${JSON.stringify(process.env.ESCO_TEST_AGENT_TEXT || 'テストの依頼')}; t.dispatchEvent(new Event('input')); document.getElementById('sendBtn').click() })()`)
      await new Promise((r) => setTimeout(r, 3000))
      await agent.flushUsage()
      await agent.refreshAccess()
    }
    for (let i = 0; i < (shots ? 0 : n); i++) {
      out.sends.push(await aw.webContents.executeJavaScript(`window.escoAI.send({ text: ${JSON.stringify(process.env.ESCO_TEST_AGENT_TEXT || 'テストの依頼 ' + (i + 1))}, mode: 'docs', autoApprove: false }).then(() => 'ok').catch((e) => 'error: ' + e.message)`))
      await agent.flushUsage()
    }
    await new Promise((r) => setTimeout(r, 300))
    await shoot(aw, '2_agent.png')
    out.warn = await aw.webContents.executeJavaScript("({ hidden: document.getElementById('keyWarn').hidden, text: document.getElementById('keyWarnText').textContent })")
    out.hiddenParts = await aw.webContents.executeJavaScript("({ cost: document.getElementById('cost').textContent, phone: document.getElementById('cloudWorkspaceBtn').hidden, key: document.getElementById('setKey').closest('label').hidden })")
    try { out.queue = JSON.parse(fs.readFileSync(path.join(agent.dataDir, 'usage-queue.json'), 'utf8')).length } catch { out.queue = 0 }
    if (process.env.ESCO_TEST_AGENT_REFLUSH === '1') { await agent.flushUsage(); try { out.queueAfter = JSON.parse(fs.readFileSync(path.join(agent.dataDir, 'usage-queue.json'), 'utf8')).length } catch { out.queueAfter = 0 } }
    aw.destroy()
  } catch (e) { out.error = String((e && e.stack) || e) }
}

// ---- テスト用の後始末 ----
let finishing = false
async function finishTest() {
  if (!TEST || finishing || process.env.ESCO_TEST_EXIT !== '1') return
  finishing = true
  if (agentScenario) await agentScenario
  await new Promise((r) => setTimeout(r, FAST ? 1200 : 3000))
  await writeReport()
  app.quit()
}
async function writeReport() {
  if (!process.env.ESCO_TEST_REPORT) return
  const cookies = await ses().cookies.get({ url: BASE }).catch(() => [])
  let docTitle = null, windowTitle = null
  try { if (win && !win.isDestroyed()) { windowTitle = win.getTitle(); docTitle = await win.webContents.executeJavaScript('document.title') } } catch { /* なし */ }
  const out = { ...telemetry, windowTitle, docTitle, importDone, cookies: cookies.map((c) => ({ name: c.name, httpOnly: c.httpOnly, session: !!c.session, expirationDate: c.expirationDate || null })) }
  fs.writeFileSync(process.env.ESCO_TEST_REPORT, JSON.stringify(out, null, 2))
}

// ---- 起動 ----
app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
app.on('window-all-closed', () => app.quit())

app.whenReady().then(async () => {
  if (!app.hasSingleInstanceLock()) return
  if (SELFTEST) return runAgentSelftest()
  // 権限：画面からの許可要求は基本すべて拒否。コピー・貼り付けと全画面だけ、自社の画面に限って許可
  const allowed = new Set(['clipboard-sanitized-write', 'clipboard-read', 'fullscreen'])
  ses().setPermissionRequestHandler((wc, perm, cb) => cb(allowed.has(perm) && isInternal(wc.getURL())))
  ses().setPermissionCheckHandler((wc, perm, origin) => allowed.has(perm) && isInternal(origin || (wc && wc.getURL()) || ''))
  // ダウンロード（提案書PDF・画像）：保存先の既定は「ダウンロード」フォルダ
  ses().on('will-download', (_e, item) => {
    const name = item.getFilename()
    if (TEST && process.env.ESCO_TEST_DOWNLOAD_DIR) item.setSavePath(path.join(process.env.ESCO_TEST_DOWNLOAD_DIR, name))
    else item.setSaveDialogOptions({ defaultPath: path.join(app.getPath('downloads'), name) })
    item.once('done', (_ev, state) => telemetry.downloads.push({ name, state }))
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '編集', submenu: [{ role: 'undo', label: '元に戻す' }, { role: 'redo', label: 'やり直す' }, { type: 'separator' },
      { role: 'cut', label: '切り取り' }, { role: 'copy', label: 'コピー' }, { role: 'paste', label: '貼り付け' }, { role: 'selectAll', label: 'すべて選択' }] },
    { label: '表示', submenu: [{ role: 'reload', label: '再読み込み' }, { type: 'separator' },
      { role: 'resetZoom', label: '拡大率をもとに戻す' }, { role: 'zoomIn', label: '拡大' }, { role: 'zoomOut', label: '縮小' }, { role: 'togglefullscreen', label: '全画面' }] }
  ]))
  // テスト専用：手元のサーバーに、決まった利用者としてログイン済みの状態で始める（画面の見え方の確認用）
  if (TEST && process.env.ESCO_TEST_COOKIE) {
    const i = process.env.ESCO_TEST_COOKIE.indexOf('=')
    await ses().cookies.set({ url: BASE, name: process.env.ESCO_TEST_COOKIE.slice(0, i), value: process.env.ESCO_TEST_COOKIE.slice(i + 1), path: '/' })
  }
  // テスト専用：旧アプリのさくら登録名（account.bin）を、この環境の資格情報暗号化で作る
  if (TEST && process.env.ESCO_TEST_ACCOUNT_NAME && safeStorage.isEncryptionAvailable()) {
    const d = path.join(app.getPath('userData'), 'workspace')
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'account.bin'), safeStorage.encryptString(JSON.stringify({ url: 'https://example.invalid', user: { id: 'x', name: process.env.ESCO_TEST_ACCOUNT_NAME } })))
  }
  // テスト専用：Web の名前選択で別の人としてログイン済み、という状況を作る
  if (TEST && process.env.ESCO_TEST_PRELOGIN_USERID) {
    await doFetch('/api/auth/join/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: KEY, userId: process.env.ESCO_TEST_PRELOGIN_USERID }) }).catch(() => {})
  }
  // エージェント（指定された人だけ）。使えるかどうかはサーバーが決める
  agent = setupAgent({
    app, doFetch, log,
    onUpdate: { install: () => updater && updater.quitAndInstall(), check: () => (updater ? updater.checkNow() : Promise.resolve({ state: 'dev' })) },
    // テストのときだけ、にせのエージェント（Anthropic につながない）に差し替えられる
    test: TEST ? { hidden: process.env.ESCO_TEST_HIDDEN === '1', runnerFactory: process.env.ESCO_TEST_RUNNER ? require(process.env.ESCO_TEST_RUNNER).factory : undefined } : {}
  })
  // チャット画面（自社のページ）からの合図だけ受ける。ほかのページ・別ウィンドウからは受けない
  const fromChat = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents && isInternal(e.sender.getURL())
  ipcMain.handle('shell:agent-status', async (e) => {
    if (!fromChat(e)) return { enabled: false }
    const a = await agent.refreshAccess()
    telemetry.agent = { enabled: !!a.enabled, blocked: !!a.blocked, ready: !!a.ready }
    return { enabled: !!a.enabled }
  })
  ipcMain.on('shell:open-agent', async (e) => {
    if (!fromChat(e)) return
    const r = await agent.open()
    log('[agent] 開く ' + (r.opened ? 'OK' : '不可 ' + r.reason))
    if (!r.opened && !TEST) dialog.showMessageBox(win, { type: 'info', title: APP_TITLE, message: r.reason })
  })
  // 自動更新（GitHub Releases・1時間ごとの確認・夜間の自動適用）。エージェントが作業中の夜は見送る
  updater = setupAutoUpdate(app, (ev, p) => { log('[update] ' + ev + ' ' + JSON.stringify(p)); agent.emitAll(ev, p) }, log, () => agent.isBusy())
  await start()
  if (TEST && process.env.ESCO_TEST_EXIT === '1') {
    setTimeout(async () => { if (!finishing) { finishing = true; await writeReport(); app.quit() } }, Number(process.env.ESCO_TEST_TIMEOUT_MS || 25000))
  }
})
