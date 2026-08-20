// 自動アップデート（electron-updater + GitHub 非公開リリース）
// 光強代表が新バージョンをリリースするたび、全員のアプリが起動時に検知して自動更新する。
//
// 設定は build/update-config.json（配布ビルドに同梱）から読む:
//   { "owner": "<github-user>", "repo": "esco-works", "token": "<read-only PAT>" }
// 非公開リポジトリのため、リリース取得用の読み取り専用トークンが必要。

// 公開リポジトリのため、実行時トークンは不要。
const REPO = { owner: 'mitsuyoshi-com', repo: 'esco-works' }

// emit(ev, payload): 全ウィンドウへ通知するための関数を受け取る
function setupAutoUpdate(app, emitAll, log) {
  if (!app.isPackaged) {
    log && log('[updater] 開発モードのため自動更新は無効')
    return
  }
  let autoUpdater
  try {
    ;({ autoUpdater } = require('electron-updater'))
  } catch (e) {
    log && log('[updater] electron-updater 読み込み失敗: ' + (e && e.message))
    return
  }

  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.setFeedURL({
    provider: 'github',
    owner: REPO.owner,
    repo: REPO.repo
  })

  autoUpdater.on('checking-for-update', () => emitAll('update:status', { state: 'checking' }))
  autoUpdater.on('update-available', (info) =>
    emitAll('update:status', { state: 'available', version: info && info.version })
  )
  autoUpdater.on('update-not-available', () => emitAll('update:status', { state: 'none' }))
  autoUpdater.on('download-progress', (p) =>
    emitAll('update:status', { state: 'downloading', percent: Math.round(p.percent || 0) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    emitAll('update:status', { state: 'ready', version: info && info.version })
  )
  autoUpdater.on('error', (err) => {
    log && log('[updater] error: ' + (err && err.message))
    emitAll('update:status', { state: 'error', message: err && err.message })
  })

  // 起動直後 + 以後6時間ごとにチェック
  const check = () => autoUpdater.checkForUpdates().catch(() => {})
  setTimeout(check, 4000)
  setInterval(check, 6 * 60 * 60 * 1000)

  // renderer から「今すぐ再起動して更新」を受けたら適用
  return {
    quitAndInstall: () => {
      try {
        autoUpdater.quitAndInstall()
      } catch {
        /* ignore */
      }
    }
  }
}

module.exports = { setupAutoUpdate }
