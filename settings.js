// 設定と月間利用額の保存（userData配下のJSON）
const { app } = require('electron')
const fs = require('fs')
const path = require('path')

const DEFAULTS = {
  apiKey: '',
  userName: '',
  enableBrowser: false,
  models: {
    chat: 'claude-sonnet-5',
    docs: 'claude-sonnet-5',
    files: 'claude-sonnet-5'
  },
  // スマホ連携。mode: off | tunnel（かんたん接続=Quick Tunnel）| relay（サーバー経由=ハイブリッド）
  // enabled は remote.js（トンネル時のRemoteServer）が参照する導出値（mode==='tunnel'）
  remote: { mode: 'off', enabled: false },
  // サーバー経由(relay)の接続情報。orgKey/pcSecretは各PCローカルのみ（リポジトリに入れない）
  relay: { url: '', orgKey: '', pcId: '', pcSecret: '' },
  // ペアリング済み端末の台帳（トンネル方式の表示・監査用のみ）: { deviceId, name, pairedAt, lastSeen }
  remoteDevices: []
}

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json')
}
function usageFile() {
  return path.join(app.getPath('userData'), 'usage.json')
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))
    const s = {
      ...DEFAULTS,
      ...raw,
      models: { ...DEFAULTS.models, ...(raw.models || {}) },
      remote: { ...DEFAULTS.remote, ...(raw.remote || {}) },
      relay: { ...DEFAULTS.relay, ...(raw.relay || {}) }
    }
    // 旧形式 {enabled:true}（mode未導入時代のトンネルON）→ mode:'tunnel' へ移行
    if (raw.remote && raw.remote.enabled && !raw.remote.mode) s.remote.mode = 'tunnel'
    s.remote.enabled = s.remote.mode === 'tunnel'
    return s
  } catch {
    return JSON.parse(JSON.stringify(DEFAULTS))
  }
}

function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true })
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2), 'utf8')
}

// 月間利用額（概算USD）を月キーで積算する
function monthKey() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}

function loadUsage() {
  try {
    return JSON.parse(fs.readFileSync(usageFile(), 'utf8'))
  } catch {
    return {}
  }
}

function addUsage(costUsd) {
  const u = loadUsage()
  const key = monthKey()
  u[key] = (u[key] || 0) + costUsd
  fs.mkdirSync(path.dirname(usageFile()), { recursive: true })
  fs.writeFileSync(usageFile(), JSON.stringify(u, null, 2), 'utf8')
  return u[key]
}

function monthUsage() {
  return loadUsage()[monthKey()] || 0
}

module.exports = { loadSettings, saveSettings, addUsage, monthUsage, DEFAULTS }
