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
  }
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
    return { ...DEFAULTS, ...raw, models: { ...DEFAULTS.models, ...(raw.models || {}) } }
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
