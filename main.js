// エスコAIアシスタント Electronメインプロセス
// ウィンドウごとに独立した会話・作業フォルダ・AgentRunnerを持つ（複数同時作業対応）
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { loadSettings, saveSettings, addUsage, monthUsage } = require('./settings')
const { AgentRunner } = require('./agent')
const { setupAutoUpdate } = require('./updater')

let settings = null
// webContents.id -> { win, runner, workFolder }
const windows = new Map()
let updater = null

// 全ウィンドウへイベントを送る
function emitAll(ev, payload) {
  for (const st of windows.values()) st.emit(ev, payload)
}

// 作業フォルダ未選択時にAIのcwdとして使うスクラッチ領域（ユーザーには見せない）
function scratchDir() {
  const p = path.join(app.getPath('userData'), 'scratch')
  fs.mkdirSync(p, { recursive: true })
  return p
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
    runner: new AgentRunner({ getSettings: () => settings, emit }),
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
      monthUsd: monthUsage()
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
  ipcMain.handle('usage:add', (_e, costUsd) => addUsage(costUsd))
  ipcMain.on('update:install', () => updater && updater.quitAndInstall())

  const win = createWindow()

  // 自動アップデート（配布ビルドのみ有効）
  updater = setupAutoUpdate(app, emitAll, (m) => console.log(m))

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
