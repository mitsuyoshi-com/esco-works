// 中継サーバー(server/)へのPC側常駐接続。
// 外向きWebSocketなのでNAT裏・ポート開放不要。サーバーから来る turn を
// デバイス単位のAgentRunnerで実行し、イベントを送り返す（＝スマホのSSEへ届く）。
// セキュリティ: サーバーが何を送ってきても、実行パラメータはここで強制する（多層防御）。
const path = require('path')
const fs = require('fs')
const WebSocket = require('ws')

const RECONNECT_MIN_MS = 2000
const RECONNECT_MAX_MS = 60000
const PAIR_TIMEOUT_MS = 10000
const OUTBOX_CAP = 500 // WS瞬断中のイベント保持数（復帰時に送る＝サーバーの切断猶予と対）
const HANDOFF_PREFIX_LIMIT = 4000 // 引き継ぎ前置テキストの上限文字数

class RelayClient {
  /**
   * @param {object} deps
   * @param {() => {url,orgKey,pcId,pcSecret,userName,version}} deps.getConfig 接続設定
   * @param {(pcSecret: string) => void} deps.savePcSecret 初回発行されたpcSecretの保存
   * @param {(emit: Function, deviceId: string) => object} deps.createRunner デバイス専用AgentRunner生成
   * @param {(deviceId: string) => string} deps.scratchDirFor
   * @param {string} deps.handoffDir クラウド会話の引き継ぎ保存先
   * @param {(status: {state, message?}) => void} deps.onStatus connecting|connected|reconnecting|error|stopped
   * @param {(devices: Array) => void} deps.onDevices サーバー由来の端末一覧
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ getConfig, savePcSecret, createRunner, scratchDirFor, handoffDir, onStatus, onDevices, log }) {
    this.getConfig = getConfig
    this.savePcSecret = savePcSecret
    this.createRunner = createRunner
    this.scratchDirFor = scratchDirFor
    this.handoffDir = handoffDir
    this.onStatus = onStatus
    this.onDevices = onDevices || (() => {})
    this.log = log || (() => {})
    this.ws = null
    this.stopping = false
    this.backoff = RECONNECT_MIN_MS
    this.retryTimer = null
    this.runners = new Map() // deviceId -> runner
    this.outbox = [] // WS切断中のイベント退避
    this.pendingPair = null // { resolve, reject, timer }
    fs.mkdirSync(handoffDir, { recursive: true })
  }

  start() {
    this.stopping = false
    this.connect(true)
  }

  stop() {
    this.stopping = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const r of this.runners.values()) r.interrupt()
    this.runners.clear()
    if (this.ws) {
      try {
        this.ws.terminate()
      } catch {
        /* ignore */
      }
      this.ws = null
    }
    this.onStatus({ state: 'stopped' })
  }

  connect(first) {
    const cfg = this.getConfig()
    if (!cfg.url || !cfg.orgKey) {
      this.onStatus({ state: 'error', message: '接続コードが設定されていません' })
      return
    }
    this.onStatus({ state: first ? 'connecting' : 'reconnecting' })
    const wsUrl = cfg.url.replace(/^http/i, 'ws').replace(/\/$/, '') + '/pc/link'
    let ws
    try {
      ws = new WebSocket(wsUrl, {
        headers: {
          Authorization: `Bearer ${cfg.orgKey}`,
          'X-PC-Id': cfg.pcId,
          'X-PC-Secret': cfg.pcSecret || ''
        }
      })
    } catch (e) {
      this.scheduleRetry(`接続できません: ${e.message}`)
      return
    }
    this.ws = ws
    ws.on('open', () => {
      this.backoff = RECONNECT_MIN_MS
      this.onStatus({ state: 'connected' })
      this.send({ t: 'hello', userName: cfg.userName || '', version: cfg.version || '' })
      // 瞬断中に溜まったイベントを流す（実行中ターンの続きがスマホに届く）
      const box = this.outbox
      this.outbox = []
      for (const m of box) this.send(m)
    })
    ws.on('message', (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      this.handleMessage(msg)
    })
    ws.on('close', (code) => {
      if (this.ws === ws) this.ws = null
      if (this.stopping) return
      // 401（認証拒否）はリトライしても無駄
      if (code === 4401) {
        this.onStatus({ state: 'error', message: '認証に失敗しました。接続コードを確認してください' })
        return
      }
      this.scheduleRetry()
    })
    ws.on('error', () => {
      /* closeで処理 */
    })
    ws.on('unexpected-response', (_req, res) => {
      if (this.ws === ws) this.ws = null
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
      if (this.stopping) return
      if (res.statusCode === 401) {
        this.onStatus({ state: 'error', message: '認証に失敗しました。接続コードを確認してください' })
        return
      }
      this.scheduleRetry(`サーバー応答: ${res.statusCode}`)
    })
  }

  scheduleRetry(message) {
    if (this.stopping || this.retryTimer) return
    this.onStatus({ state: 'reconnecting', ...(message ? { message } : {}) })
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect(false)
      this.backoff = Math.min(this.backoff * 2, RECONNECT_MAX_MS)
    }, this.backoff)
  }

  send(msg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify(msg))
        return true
      } catch {
        /* fallthrough */
      }
    }
    // イベントだけは瞬断復帰時に届けたいので退避（他の種別は捨てて良い）
    if (msg.t === 'event') {
      this.outbox.push(msg)
      if (this.outbox.length > OUTBOX_CAP) this.outbox.shift()
    }
    return false
  }

  handleMessage(msg) {
    switch (msg.t) {
      case 'hello:ok':
        if (msg.pcSecret) this.savePcSecret(msg.pcSecret)
        break
      case 'turn':
        this.runTurn(String(msg.deviceId || ''), String(msg.text || ''))
        break
      case 'perm': {
        const r = this.runners.get(msg.deviceId)
        if (r) r.respondPermission(String(msg.requestId || ''), !!msg.approved, !!msg.remember)
        break
      }
      case 'choice': {
        const r = this.runners.get(msg.deviceId)
        if (r) r.respondChoice(String(msg.requestId || ''), String(msg.answer || ''))
        break
      }
      case 'interrupt': {
        const r = this.runners.get(msg.deviceId)
        if (r) r.interrupt()
        break
      }
      case 'new': {
        const r = this.runners.get(msg.deviceId)
        if (r) {
          r.interrupt()
          r.newConversation()
        }
        break
      }
      case 'devices:changed':
        this.onDevices(msg.devices || [])
        break
      case 'pair:code':
        if (this.pendingPair) {
          clearTimeout(this.pendingPair.timer)
          this.pendingPair.resolve({ code: msg.code, url: msg.url })
          this.pendingPair = null
        }
        break
      case 'handoff':
        this.saveHandoff(String(msg.deviceId || ''), msg.entries || [])
        break
      default:
        break
    }
  }

  /** ペアリングコードの発行をサーバーに依頼（QR表示用） */
  requestPairCode() {
    return new Promise((resolve, reject) => {
      if (this.pendingPair) {
        clearTimeout(this.pendingPair.timer)
        this.pendingPair.reject(new Error('superseded'))
      }
      const timer = setTimeout(() => {
        this.pendingPair = null
        reject(new Error('サーバーからの応答がありません'))
      }, PAIR_TIMEOUT_MS)
      this.pendingPair = { resolve, reject, timer }
      if (!this.send({ t: 'pair:issue' })) {
        clearTimeout(timer)
        this.pendingPair = null
        reject(new Error('サーバーに接続していません'))
      }
    })
  }

  revoke(deviceId) {
    this.send({ t: 'revoke', deviceId })
  }

  /* --- ターン実行（サーバーからの中継。パラメータはここで強制） --- */

  runTurn(deviceId, text) {
    if (!/^[0-9a-f]{32}$/.test(deviceId) || !text) return
    let runner = this.runners.get(deviceId)
    if (!runner) {
      const emit = (ev, payload) => this.send({ t: 'event', deviceId, ev, payload })
      runner = this.createRunner(emit, deviceId)
      this.runners.set(deviceId, runner)
    }
    // 未注入の引き継ぎ（PC停止中のクラウド会話）があれば1回だけ文脈として前置する
    const prefix = this.takeHandoffPrefix(deviceId)
    runner
      .startTurn({
        text: prefix ? `${prefix}\n\n${text}` : text,
        mode: 'chat', // 強制: サーバー側と二重の防御
        workFolder: null, // 強制: 書き込みの自動許可ゼロ（承認カードはスマホに出る）
        cwd: this.scratchDirFor(deviceId),
        autoApprove: false,
        permMode: 'normal'
      })
      .catch((e) => {
        this.send({ t: 'event', deviceId, ev: 'agent:error', payload: { message: (e && e.message) || String(e) } })
      })
  }

  /* --- クラウド会話の引き継ぎ --- */

  handoffFile(deviceId) {
    if (!/^[0-9a-f]{32}$/.test(deviceId)) throw new Error('bad deviceId')
    return path.join(this.handoffDir, `${deviceId}.json`)
  }

  saveHandoff(deviceId, entries) {
    if (!/^[0-9a-f]{32}$/.test(deviceId) || !entries.length) return
    try {
      // 既存の未注入分に追記する
      let cur = []
      try {
        cur = JSON.parse(fs.readFileSync(this.handoffFile(deviceId), 'utf8')).entries || []
      } catch {
        /* 新規 */
      }
      const known = new Set(cur.map((e) => e.seq))
      const merged = [...cur, ...entries.filter((e) => !known.has(e.seq))]
      fs.writeFileSync(this.handoffFile(deviceId), JSON.stringify({ entries: merged }), 'utf8')
      const upto = Math.max(...entries.map((e) => Number(e.seq) || 0))
      this.send({ t: 'handoff:ack', deviceId, upto })
      this.log(`[relay] handoff saved: ${deviceId.slice(0, 8)} (+${entries.length})`)
    } catch (e) {
      this.log(`[relay] handoff save failed: ${e && e.message}`)
    }
  }

  takeHandoffPrefix(deviceId) {
    let entries
    try {
      entries = JSON.parse(fs.readFileSync(this.handoffFile(deviceId), 'utf8')).entries || []
    } catch {
      return ''
    }
    if (!entries.length) return ''
    try {
      fs.rmSync(this.handoffFile(deviceId), { force: true }) // 注入は1回だけ
    } catch {
      /* ignore */
    }
    let body = entries
      .map((e) => `${e.role === 'user' ? 'ユーザー' : 'AI'}: ${e.text}`)
      .join('\n')
    if (body.length > HANDOFF_PREFIX_LIMIT) body = body.slice(-HANDOFF_PREFIX_LIMIT)
    return `（参考: あなた（PC）が起動していない間に、サーバー上のAIとユーザーが交わした会話です。文脈として引き継いでください。\n${body}\n以上が引き継ぎです。以下がユーザーの新しいメッセージ:）`
  }
}

module.exports = { RelayClient }
