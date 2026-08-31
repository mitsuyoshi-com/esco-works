// エスコAIアシスタント Electronメインプロセス
// ウィンドウごとに独立した会話・作業フォルダ・AgentRunnerを持つ（複数同時作業対応）
const { app, BrowserWindow, ipcMain, dialog, shell, powerSaveBlocker } = require('electron')
const path = require('path')
const fs = require('fs')
const { loadSettings, saveSettings, addUsage, monthUsage } = require('./settings')
const { AgentRunner } = require('./agent')
const { setupAutoUpdate } = require('./updater')
const { RemoteServer } = require('./remote')
const { Tunnel } = require('./tunnel')
const { RelayClient } = require('./relayClient')
const { randomUUID } = require('crypto')

let settings = null
// webContents.id -> { win, runner, workFolder }
const windows = new Map()
let updater = null

// 全ウィンドウへイベントを送る
function emitAll(ev, payload) {
  for (const st of windows.values()) st.emit(ev, payload)
}

// 利用額の一元計上: AgentRunnerのemitをラップし、agent:doneのコストをmain側で積算する。
// PCウィンドウ・スマホどちらのターンもここを通るため、二重計上・未計上が起きない。
function wrapUsageAccounting(emit) {
  return (ev, payload) => {
    if (ev === 'agent:done' && payload && payload.costUsd > 0) {
      const monthUsd = addUsage(payload.costUsd)
      emitAll('usage:updated', { monthUsd })
    }
    emit(ev, payload)
  }
}

// 作業フォルダ未選択時にAIのcwdとして使うスクラッチ領域（ユーザーには見せない）
function scratchDir() {
  const p = path.join(app.getPath('userData'), 'scratch')
  fs.mkdirSync(p, { recursive: true })
  return p
}

/* --- スマホ連携（リモートチャット） ---
   mode='tunnel': RemoteServer(127.0.0.1) + Cloudflare Quick Tunnel（QRを毎回読む・サーバー不要）
   mode='relay' : 中継サーバー(server/)へ外向きWS常駐（QRは初回だけ・PC停止中もクラウドがチャット代打） */
const remote = {
  server: null, // tunnel用RemoteServer
  tunnel: null,
  relay: null, // relay用RelayClient
  relayDevices: [], // サーバー由来の端末一覧キャッシュ
  status: { state: 'stopped' }, // stopped | starting | up | restarting | error | connecting | connected | reconnecting
  blockerId: null
}

// スマホ用のcwd（PC用scratchと分離。デバイスごとに独立）
function remoteScratchDir(deviceId) {
  const p = path.join(app.getPath('userData'), 'remote-scratch', String(deviceId).slice(0, 16))
  fs.mkdirSync(p, { recursive: true })
  return p
}

function remoteMode() {
  return (settings.remote && settings.remote.mode) || 'off'
}

function remoteStatusPayload() {
  const mode = remoteMode()
  return {
    mode,
    enabled: mode !== 'off', // 旧UI互換
    hasConnectCode: !!(settings.relay && settings.relay.url && settings.relay.orgKey),
    ...remote.status,
    devices: mode === 'relay' ? remote.relayDevices : remote.server ? remote.server.listDevices() : []
  }
}

function setRemoteStatus(status) {
  remote.status = status
  emitAll('remote:changed', remoteStatusPayload())
}

async function startRemote() {
  if (remote.server) return
  const server = new RemoteServer({
    getSettings: () => settings,
    createRunner: (emit) => new AgentRunner({ getSettings: () => settings, emit: wrapUsageAccounting(emit) }),
    scratchDirFor: remoteScratchDir,
    staticDir: path.join(__dirname, 'renderer', 'mobile'),
    onDevicePaired: (entry) => {
      // ペアリング履歴（表示・監査用）。トークンは保存しない
      settings.remoteDevices = [...(settings.remoteDevices || []), entry].slice(-20)
      saveSettings(settings)
      emitAll('remote:changed', remoteStatusPayload())
    },
    onDeviceSeen: () => {},
    log: (m) => console.log(m)
  })
  server.version = app.getVersion()
  remote.server = server
  remote.tunnel = new Tunnel({
    onStatus: (status) => setRemoteStatus(status),
    log: (m) => console.log(m)
  })
  try {
    const port = await server.listen()
    console.log(`[remote] listening on 127.0.0.1:${port}`)
    await remote.tunnel.start(port)
    // スマホ連携ON中はPCのスリープで切れないようにする
    if (remote.blockerId === null) remote.blockerId = powerSaveBlocker.start('prevent-app-suspension')
  } catch (e) {
    console.log('[remote] start failed:', e && e.message)
    stopRemote(false)
    setRemoteStatus({ state: 'error', message: (e && e.message) || 'スマホ連携を開始できませんでした' })
  }
}

/* --- サーバー経由（relay）モード --- */

// このPCの識別子を初回に生成して保存する（pcSecretはサーバーがTOFUで発行）
function ensureRelayIdentity() {
  if (!settings.relay.pcId) {
    settings.relay = { ...settings.relay, pcId: randomUUID().replace(/-/g, '') }
    saveSettings(settings)
  }
}

function startRelay() {
  if (remote.relay) return
  if (!settings.relay.url || !settings.relay.orgKey) {
    setRemoteStatus({ state: 'error', message: '接続コードを設定してください' })
    return
  }
  ensureRelayIdentity()
  const relay = new RelayClient({
    getConfig: () => ({
      url: settings.relay.url,
      orgKey: settings.relay.orgKey,
      pcId: settings.relay.pcId,
      pcSecret: settings.relay.pcSecret,
      userName: settings.userName,
      version: app.getVersion()
    }),
    savePcSecret: (pcSecret) => {
      settings.relay = { ...settings.relay, pcSecret }
      saveSettings(settings)
    },
    createRunner: (emit) => new AgentRunner({ getSettings: () => settings, emit: wrapUsageAccounting(emit) }),
    scratchDirFor: remoteScratchDir,
    handoffDir: path.join(app.getPath('userData'), 'cloud-handoff'),
    onStatus: (status) => setRemoteStatus(status),
    onDevices: (devices) => {
      remote.relayDevices = devices
      emitAll('remote:changed', remoteStatusPayload())
    },
    log: (m) => console.log(m)
  })
  remote.relay = relay
  relay.start()
  if (remote.blockerId === null) remote.blockerId = powerSaveBlocker.start('prevent-app-suspension')
}

function stopRemote(notify = true) {
  if (remote.tunnel) {
    remote.tunnel.onStatus = () => {} // stop()内のstatus通知は自前でまとめて出す
    remote.tunnel.stop()
    remote.tunnel = null
  }
  if (remote.server) {
    remote.server.close()
    remote.server = null
  }
  if (remote.relay) {
    remote.relay.onStatus = () => {}
    remote.relay.stop()
    remote.relay = null
    remote.relayDevices = []
  }
  if (remote.blockerId !== null) {
    try {
      powerSaveBlocker.stop(remote.blockerId)
    } catch {
      /* ignore */
    }
    remote.blockerId = null
  }
  if (notify) setRemoteStatus({ state: 'stopped' })
  else remote.status = { state: 'stopped' }
}

// 方式の切り替え（設定UIから）。enabledはトンネル用RemoteServerが参照する導出値
async function setRemoteMode(mode) {
  stopRemote(false)
  settings.remote = { ...settings.remote, mode, enabled: mode === 'tunnel' }
  saveSettings(settings)
  if (mode === 'tunnel') await startRemote()
  else if (mode === 'relay') startRelay()
  else setRemoteStatus({ state: 'stopped' })
  return remoteStatusPayload()
}

function createWindow() {
  const win = new BrowserWindow({
    width: 920,
    height: 700,
    minWidth: 640,
    minHeight: 480,
    title: 'ESCO Works',
    icon: path.join(__dirname, 'build', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  const id = win.webContents.id
  const emit = (ev, payload) => {
    if (ev.startsWith('agent:')) console.log(`[win${id}][${ev}]`, JSON.stringify(payload).slice(0, 200))
    if (!win.isDestroyed()) win.webContents.send(ev, payload)
  }
  const state = {
    win,
    emit,
    workFolder: null, // 未選択で開始。選択しなくても会話は動く
    runner: new AgentRunner({ getSettings: () => settings, emit: wrapUsageAccounting(emit) }),
    watcher: null,
    watchTimer: null
  }
  windows.set(id, state)
  // 画面側のconsoleエラーをメイン側ログへ透過（診断用）
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) console.log(`[win${id}][renderer] ${message}`)
  })
  win.on('closed', () => {
    state.runner.interrupt()
    state.watcher?.close()
    windows.delete(id)
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  return win
}

function stateOf(event) {
  return windows.get(event.sender.id)
}

// 作業フォルダの設定変更を1か所に集約し、監視の張り直しとUI通知を行う
function setWorkFolder(state, folder) {
  state.workFolder = folder
  watchFolder(state)
  state.emit('folder:changed', { workFolder: folder })
}

// 作業フォルダを監視し、変化があればサイドバー更新イベントを送る（500msデバウンス）
function watchFolder(state) {
  try {
    state.watcher?.close()
  } catch {
    /* ignore */
  }
  state.watcher = null
  if (!state.workFolder) return
  try {
    const w = fs.watch(state.workFolder, { recursive: true }, (_ev, filename) => {
      // node_modules や隠しフォルダ配下の大量変更はツリー再構築のトリガーにしない
      const name = String(filename || '')
      if (name.includes('node_modules') || /(^|[\\/])\./.test(name)) return
      clearTimeout(state.watchTimer)
      state.watchTimer = setTimeout(() => state.emit('fs:changed', {}), 500)
    })
    // 監視中にフォルダが削除・切断されるとFSWatcherが'error'を投げる。
    // 未処理だとメインプロセスごとクラッシュするため必ず捕捉する。
    w.on('error', () => {
      try {
        w.close()
      } catch {
        /* ignore */
      }
      state.watcher = null
      if (state.workFolder && !fs.existsSync(state.workFolder)) {
        setWorkFolder(state, null)
      }
    })
    state.watcher = w
  } catch {
    // 監視に失敗しても手動更新で使えるので無視
    state.watcher = null
  }
}

function isInsideFolder(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

app.whenReady().then(async () => {
  settings = loadSettings()

  // 起動診断モード: electron . --selftest でGUIなしにSDK呼び出しを検証
  if (process.argv.includes('--selftest')) {
    console.log('[selftest] start')
    const runner = new AgentRunner({
      getSettings: () => settings,
      emit: (ev, payload) => console.log(`[selftest][${ev}]`, JSON.stringify(payload).slice(0, 300))
    })
    try {
      await runner.startTurn({
        text: '「Electron内動作OK」とだけ返してください。',
        mode: 'chat',
        workFolder: null,
        cwd: scratchDir(),
        autoApprove: false
      })
      console.log('[selftest] done')
    } catch (e) {
      console.log('[selftest] threw:', e && e.message)
    }
    app.quit()
    return
  }

  ipcMain.handle('app:init', (e) => {
    const s = stateOf(e)
    return {
      settings: { ...settings, apiKey: settings.apiKey ? '****' + settings.apiKey.slice(-4) : '' },
      hasApiKey: !!settings.apiKey,
      workFolder: s.workFolder,
      monthUsd: monthUsage(),
      version: app.getVersion()
    }
  })

  ipcMain.handle('settings:save', (_e, next) => {
    // マスク表示のままのAPIキーは変更なしとして扱う
    if (next.apiKey && next.apiKey.startsWith('****')) next.apiKey = settings.apiKey
    settings = { ...settings, ...next, models: { ...settings.models, ...(next.models || {}) } }
    saveSettings(settings)
    // 全ウィンドウのキャッシュを最新化（複数ウィンドウでの上書き巻き戻りを防ぐ）
    const masked = { ...settings, apiKey: settings.apiKey ? '****' + settings.apiKey.slice(-4) : '' }
    for (const st of windows.values()) st.emit('settings:changed', masked)
    return true
  })

  ipcMain.handle('folder:pick', async (e) => {
    const s = stateOf(e)
    const r = await dialog.showOpenDialog(s.win, {
      title: '作業フォルダを選択',
      defaultPath: s.workFolder || app.getPath('documents'),
      properties: ['openDirectory', 'createDirectory']
    })
    if (!r.canceled && r.filePaths[0]) {
      setWorkFolder(s, r.filePaths[0])
    }
    return s.workFolder
  })

  // サイドバー用: 作業フォルダ内のディレクトリ一覧（非同期・件数上限つき）
  const LIST_CAP = 500
  ipcMain.handle('fs:list', async (e, dirPath) => {
    const s = stateOf(e)
    if (!s.workFolder) return { items: [], truncated: 0 }
    const dir = dirPath || s.workFolder
    if (!isInsideFolder(dir, s.workFolder)) return { items: [], truncated: 0 }
    try {
      const entries = await fs.promises.readdir(dir, { withFileTypes: true })
      const visible = entries.filter((d) => d.name !== 'node_modules' && !d.name.startsWith('.'))
      const sorted = visible
        .map((d) => ({ name: d.name, path: path.join(dir, d.name), isDir: d.isDirectory() }))
        .sort((a, b) => (a.isDir !== b.isDir ? (a.isDir ? -1 : 1) : a.name.localeCompare(b.name, 'ja')))
      return { items: sorted.slice(0, LIST_CAP), truncated: Math.max(0, sorted.length - LIST_CAP) }
    } catch {
      return { items: [], truncated: 0 }
    }
  })

  // サイドバーからのダブルクリックで既定アプリで開く（ユーザー起点の操作のみ）
  ipcMain.handle('fs:open', (e, p) => {
    const s = stateOf(e)
    if (!s.workFolder || !isInsideFolder(p, s.workFolder)) return false
    shell.openPath(p)
    return true
  })

  ipcMain.handle('chat:send', async (e, { text, mode, autoApprove, permMode }) => {
    const s = stateOf(e)
    // 選択済みフォルダが消えていたら「未選択」に戻す（未選択でも会話は動く）
    if (s.workFolder && !fs.existsSync(s.workFolder)) {
      setWorkFolder(s, null)
    }
    console.log(`[win${e.sender.id}][chat:send] mode=${mode} perm=${permMode} len=${text.length}`)
    await s.runner.startTurn({
      text,
      mode,
      workFolder: s.workFolder,
      cwd: scratchDir(),
      autoApprove,
      permMode
    })
    return true
  })

  ipcMain.on('chat:interrupt', (e) => stateOf(e)?.runner.interrupt())
  ipcMain.on('chat:new', (e) => {
    const s = stateOf(e)
    if (!s) return
    // 実行中ターンを止めてから会話をリセット（旧ターンの流入・旧セッション復活を防ぐ）
    s.runner.interrupt()
    s.runner.newConversation()
  })
  ipcMain.on('perm:respond', (e, { requestId, approved, remember }) =>
    stateOf(e)?.runner.respondPermission(requestId, approved, remember)
  )
  ipcMain.on('choice:respond', (e, { requestId, answer }) =>
    stateOf(e)?.runner.respondChoice(requestId, answer)
  )

  ipcMain.on('window:new', () => createWindow())
  ipcMain.on('update:install', () => updater && updater.quitAndInstall())

  /* --- スマホ連携のIPC --- */
  ipcMain.handle('remote:setMode', (_e, mode) => {
    if (!['off', 'tunnel', 'relay'].includes(mode)) mode = 'off'
    return setRemoteMode(mode)
  })
  // 接続コード（ESCO1.base64url({u:サーバーURL, k:組織キー})）の登録
  ipcMain.handle('remote:setConnectCode', (_e, code) => {
    try {
      const m = String(code || '').trim().match(/^ESCO1\.([A-Za-z0-9_-]+)$/)
      if (!m) throw new Error('bad format')
      const obj = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'))
      const url = String(obj.u || '').replace(/\/$/, '')
      const key = String(obj.k || '')
      // 誤入力対策: httpsのみ許可（開発用にlocalhost/127.0.0.1のhttpだけ例外）
      if (!/^https:\/\//i.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(url)) throw new Error('bad url')
      if (!/^[0-9a-f]{16,64}$/i.test(key)) throw new Error('bad key')
      settings.relay = { ...settings.relay, url, orgKey: key }
      saveSettings(settings)
      // relayモード稼働中なら新しい接続先で張り直す
      if (remoteMode() === 'relay') {
        stopRemote(false)
        startRelay()
      }
      return { ok: true, url }
    } catch {
      return { error: '接続コードが正しくありません。管理者から届いたコードをそのまま貼り付けてください。' }
    }
  })
  ipcMain.handle('remote:status', () => remoteStatusPayload())
  // QRコード生成: 表示のたびにワンタイムコードを再発行する（有効10分・1回限り）
  ipcMain.handle('remote:qr', async () => {
    const QRCode = require('qrcode')
    if (remoteMode() === 'relay') {
      if (!remote.relay) return { error: 'サーバー経由の連携が起動していません' }
      try {
        const { url } = await remote.relay.requestPairCode()
        const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
        return { dataUrl, url: settings.relay.url, once: true }
      } catch (e) {
        return { error: (e && e.message) || 'QRコードを発行できませんでした' }
      }
    }
    if (!remote.server || !remote.tunnel || !remote.tunnel.url) {
      return { error: remote.status.message || 'スマホ連携が起動していません' }
    }
    const code = remote.server.regeneratePairCode()
    const url = `${remote.tunnel.url}/#p=${code}`
    const dataUrl = await QRCode.toDataURL(url, { width: 320, margin: 2 })
    return { dataUrl, url: remote.tunnel.url }
  })
  ipcMain.handle('remote:revoke', (_e, deviceId) => {
    if (remoteMode() === 'relay' && remote.relay) remote.relay.revoke(deviceId)
    else if (remote.server) remote.server.revokeDevice(deviceId)
    return remoteStatusPayload()
  })

  // 配布版検証モード: GUIなしでRemoteServer+トンネル起動→自URLへ疎通確認→終了
  if (process.argv.includes('--remotetest')) {
    console.log('[remotetest] start')
    const prevEnabled = settings.remote && settings.remote.enabled
    settings.remote = { ...(settings.remote || {}), enabled: true }
    try {
      await startRemote()
      if (!remote.tunnel || !remote.tunnel.url) throw new Error('tunnel url not obtained')
      console.log('[remotetest] tunnel url =', remote.tunnel.url)
      const host = new URL(remote.tunnel.url).hostname
      const checkBody = (status, body) => status === 200 && body.includes('ESCO Works')
      // 1) 通常のfetch（DNS払い出し直後は引けないことがあるため数回リトライ）
      let ok = false
      let directDnsFailed = false
      for (let i = 1; i <= 3 && !ok; i++) {
        try {
          const res = await fetch(remote.tunnel.url, { redirect: 'follow' })
          ok = checkBody(res.status, await res.text())
          console.log(`[remotetest] GET / try${i} -> ${res.status} mobileUI=${ok ? 'OK' : 'NG'}`)
        } catch (e) {
          directDnsFailed = true
          console.log(`[remotetest] GET / try${i} -> ${e && e.message}`)
          await new Promise((r) => setTimeout(r, 4000))
        }
      }
      // 2) 失敗時: ルーター/ISPのDNSがtrycloudflareをブロックしている環境向けに、
      //    1.1.1.1のDoHで解決してIP直結（SNIはホスト名のまま）で再確認する
      if (!ok) {
        try {
          const doh = await fetch(`https://1.1.1.1/dns-query?name=${host}&type=A`, {
            headers: { accept: 'application/dns-json' }
          })
          const ans = (await doh.json()).Answer || []
          const ip = (ans.find((a) => a.type === 1) || {}).data
          if (!ip) throw new Error('DoH: no A record')
          console.log(`[remotetest] DoH resolved ${host} -> ${ip}`)
          const https = require('https')
          const body = await new Promise((resolve, reject) => {
            const req = https.request(
              { host: ip, servername: host, headers: { Host: host }, path: '/', timeout: 15000 },
              (res) => {
                let buf = ''
                res.on('data', (c) => (buf += c))
                res.on('end', () => resolve({ status: res.statusCode, text: buf }))
              }
            )
            req.on('error', reject)
            req.on('timeout', () => req.destroy(new Error('timeout')))
            req.end()
          })
          ok = checkBody(body.status, body.text)
          console.log(`[remotetest] GET / (via DoH) -> ${body.status} mobileUI=${ok ? 'OK' : 'NG'}`)
          if (ok && directDnsFailed) {
            console.log('[remotetest] 注意: このPCのDNSはtrycloudflareを解決できません（トンネル自体は正常）。同じWi-Fiのスマホも失敗する可能性がありますが、4G/5G回線からは使えます。')
          }
        } catch (e) {
          console.log(`[remotetest] DoH fallback -> ${e && e.message}`)
        }
      }
      console.log(ok ? '[remotetest] done' : '[remotetest] FAILED')
    } catch (e) {
      console.log('[remotetest] threw:', e && e.message)
    }
    stopRemote(false)
    settings.remote = { ...(settings.remote || {}), enabled: !!prevEnabled }
    app.quit()
    return
  }

  // 配布版検証モード: 中継サーバーへの接続と資格情報の流れを検証（環境変数で接続先を指定）
  //   ESCO_TEST_RELAY_URL / ESCO_TEST_ORG_KEY を設定して `ESCO Works.exe --relaytest`
  if (process.argv.includes('--relaytest')) {
    console.log('[relaytest] start')
    const url = process.env.ESCO_TEST_RELAY_URL
    const orgKey = process.env.ESCO_TEST_ORG_KEY
    if (!url || !orgKey) {
      console.log('[relaytest] ESCO_TEST_RELAY_URL / ESCO_TEST_ORG_KEY を設定してください')
      app.quit()
      return
    }
    settings.relay = { ...settings.relay, url: url.replace(/\/$/, ''), orgKey, pcId: '', pcSecret: '' }
    settings.remote = { ...settings.remote, mode: 'relay', enabled: false }
    ensureRelayIdentity()
    let done = false
    const finish = (ok, note) => {
      if (done) return
      done = true
      console.log(`[relaytest] ${note}`)
      console.log(ok ? '[relaytest] done' : '[relaytest] FAILED')
      stopRemote(false)
      app.quit()
    }
    remote.relay = new RelayClient({
      getConfig: () => ({ ...settings.relay, userName: 'relaytest', version: app.getVersion() }),
      savePcSecret: () => {},
      createRunner: () => ({ startTurn: async () => {}, interrupt() {}, newConversation() {}, respondPermission() {}, respondChoice() {} }),
      scratchDirFor: remoteScratchDir,
      handoffDir: path.join(app.getPath('userData'), 'cloud-handoff-test'),
      onStatus: async (st) => {
        console.log('[relaytest] status =', JSON.stringify(st))
        if (st.state === 'connected') {
          try {
            const { url: pairUrl } = await remote.relay.requestPairCode()
            finish(true, `pair url = ${pairUrl}`)
          } catch (e) {
            finish(false, `pair:issue failed: ${e && e.message}`)
          }
        }
        if (st.state === 'error') finish(false, st.message || 'error')
      },
      onDevices: () => {},
      log: (m) => console.log(m)
    })
    remote.relay.start()
    setTimeout(() => finish(false, 'timeout'), 30000)
    return
  }

  const win = createWindow()

  // 自動アップデート（配布ビルドのみ有効）
  updater = setupAutoUpdate(app, emitAll, (m) => console.log(m))

  // 前回スマホ連携ONのまま終了していたら自動再開
  // （tunnel: URLが変わるのでQR再読取が必要 / relay: 固定URLなのでそのまま復帰）
  if (remoteMode() === 'tunnel') startRemote()
  else if (remoteMode() === 'relay') startRelay()

  // UIテストモード: 画面のIPCブリッジ経由で自動送信し、配線を検証
  if (process.argv.includes('--uitest')) {
    win.webContents.once('did-finish-load', async () => {
      try {
        const t = await win.webContents.executeJavaScript('typeof window.escoAI')
        console.log('[uitest] window.escoAI =', t)
        const r = await win.webContents.executeJavaScript(
          `window.escoAI.send({ text: '「UIテストOK」とだけ返してください。', mode: 'chat', autoApprove: false }).then(() => 'sent-ok').catch((e) => 'send-error: ' + e.message)`
        )
        console.log('[uitest] send result =', r)
      } catch (e) {
        console.log('[uitest] threw:', e && e.message)
      }
      setTimeout(() => app.quit(), 1500)
    })
  }

  // スクショ生成モード: マニュアル用に実UIをPNG保存する
  if (process.argv.includes('--screenshot')) {
    const shotsDir = path.join(__dirname, 'build', 'shots')
    fs.mkdirSync(shotsDir, { recursive: true })
    const save = async (name) => {
      const img = await win.webContents.capturePage()
      fs.writeFileSync(path.join(shotsDir, name), img.toPNG())
      console.log('[shot]', name)
    }
    win.webContents.once('did-finish-load', async () => {
      await new Promise((r) => setTimeout(r, 800))
      // デモ会話を注入
      await win.webContents.executeJavaScript(`(function(){
        const M=document.getElementById('messages');
        const add=(cls,html)=>{const d=document.createElement('div');d.className='msg '+cls;d.innerHTML=html;M.appendChild(d);return d};
        M.innerHTML='';
        add('user','木更津店の在庫車の提案書を作って。派手めがいい。');
        add('ai','<p>承知しました。まず方向性を確認させてください。</p>');
        const c=document.createElement('div');c.className='permcard choicecard';
        c.innerHTML='<div class="pc-head"><b>提案書のトーンはどれにしますか？</b></div><div class="pc-btns"><button>高級感</button><button>ポップで派手</button><button>シンプル</button></div>';
        M.appendChild(c);
        add('ai','<h3>提案書の構成案</h3><p><strong>ポップで派手</strong>のトーンで作成します。</p><ul><li>表紙：車両写真＋大きなキャッチ</li><li>スペックと価格</li><li>ローン月々シミュレーション</li></ul><p>作成を開始します。</p>');
        window.scrollTo(0,document.body.scrollHeight);
      })()`)
      await new Promise((r) => setTimeout(r, 500))
      await save('main.png')
      await win.webContents.executeJavaScript(`document.getElementById('settingsDlg').showModal()`)
      await new Promise((r) => setTimeout(r, 400))
      await save('settings.png')
      await win.webContents.executeJavaScript(`document.getElementById('settingsDlg').close()`)
      setTimeout(() => app.quit(), 300)
    })
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// 終了時にcloudflaredの子プロセスを確実に殺す
app.on('will-quit', () => {
  stopRemote(false)
})
