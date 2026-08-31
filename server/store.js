// 中継サーバーの永続化（JSONファイル・10名規模なのでDBは使わない）。
// dataDir/state.json      … PC・スマホの台帳（トークン含む。600権限のディレクトリに置く）
// dataDir/conversations/  … クラウド頭脳の会話ログ（デバイス単位のjsonl。引き継ぎ用）
// dataDir/usage.json      … クラウド頭脳のAPI利用額（YYYY-MM積算）
const fs = require('fs')
const path = require('path')

const SAVE_DEBOUNCE_MS = 500
const HANDOFF_MAX_ENTRIES = 20 // 引き継ぎで渡す最大件数

class Store {
  constructor(dataDir) {
    this.dataDir = dataDir
    this.stateFile = path.join(dataDir, 'state.json')
    this.usageFile = path.join(dataDir, 'usage.json')
    this.convDir = path.join(dataDir, 'conversations')
    fs.mkdirSync(this.convDir, { recursive: true })
    this.saveTimer = null
    this.state = this.loadState()
  }

  loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'))
      return { pcs: raw.pcs || [], devices: raw.devices || [] }
    } catch {
      return { pcs: [], devices: [] }
    }
  }

  // tmp書き→renameのアトミック保存（デバウンス付き）
  save() {
    clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.saveNow(), SAVE_DEBOUNCE_MS)
  }

  saveNow() {
    clearTimeout(this.saveTimer)
    this.saveTimer = null
    const tmp = this.stateFile + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, this.stateFile)
  }

  /* --- PC台帳: { pcId, pcSecret, userName, lastSeen } --- */

  getPc(pcId) {
    return this.state.pcs.find((p) => p.pcId === pcId)
  }

  upsertPc(entry) {
    const cur = this.getPc(entry.pcId)
    if (cur) Object.assign(cur, entry)
    else this.state.pcs.push(entry)
    this.save()
    return this.getPc(entry.pcId)
  }

  /* --- スマホ台帳: { deviceId, token, name, pcId, pairedAt, lastSeen, convSeq, handoffAck } --- */

  listDevices() {
    return this.state.devices
  }

  devicesForPc(pcId) {
    return this.state.devices.filter((d) => d.pcId === pcId)
  }

  getDevice(deviceId) {
    return this.state.devices.find((d) => d.deviceId === deviceId)
  }

  addDevice(entry) {
    this.state.devices.push({ convSeq: 0, handoffAck: 0, ...entry })
    this.save()
  }

  removeDevice(deviceId) {
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== deviceId)
    try {
      fs.rmSync(this.convFile(deviceId), { force: true })
    } catch {
      /* ignore */
    }
    this.save()
  }

  touchDevice(deviceId, lastSeen) {
    const d = this.getDevice(deviceId)
    if (d) {
      d.lastSeen = lastSeen
      this.save()
    }
  }

  setHandoffAck(deviceId, upto) {
    const d = this.getDevice(deviceId)
    if (d && upto > (d.handoffAck || 0)) {
      d.handoffAck = upto
      this.save()
    }
  }

  /* --- クラウド会話ログ（引き継ぎ用） --- */

  convFile(deviceId) {
    // deviceIdは自前発行の32hexのみだが、パス組み立て前に念のため検証する
    if (!/^[0-9a-f]{32}$/.test(deviceId)) throw new Error('bad deviceId')
    return path.join(this.convDir, `${deviceId}.jsonl`)
  }

  appendConversation(deviceId, role, text) {
    const d = this.getDevice(deviceId)
    if (!d) return
    d.convSeq = (d.convSeq || 0) + 1
    const entry = { seq: d.convSeq, role, text, ts: new Date().toISOString() }
    fs.appendFileSync(this.convFile(deviceId), JSON.stringify(entry) + '\n', 'utf8')
    this.save()
  }

  /** handoffAckより後の未引き継ぎ分（直近HANDOFF_MAX_ENTRIES件） */
  pendingHandoff(deviceId) {
    const d = this.getDevice(deviceId)
    if (!d || (d.convSeq || 0) <= (d.handoffAck || 0)) return []
    let lines
    try {
      lines = fs.readFileSync(this.convFile(deviceId), 'utf8').split('\n').filter(Boolean)
    } catch {
      return []
    }
    const entries = []
    for (const line of lines) {
      try {
        const e = JSON.parse(line)
        if (e.seq > (d.handoffAck || 0)) entries.push(e)
      } catch {
        /* 壊れた行はスキップ */
      }
    }
    return entries.slice(-HANDOFF_MAX_ENTRIES)
  }

  /* --- クラウド頭脳の利用額（settings.jsと同形式のYYYY-MM積算） --- */

  addUsage(costUsd) {
    let u = {}
    try {
      u = JSON.parse(fs.readFileSync(this.usageFile, 'utf8'))
    } catch {
      /* 初回 */
    }
    const d = new Date()
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
    u[key] = (u[key] || 0) + costUsd
    fs.writeFileSync(this.usageFile, JSON.stringify(u, null, 2), { encoding: 'utf8', mode: 0o600 })
    return u[key]
  }
}

module.exports = { Store, HANDOFF_MAX_ENTRIES }
