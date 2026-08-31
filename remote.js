// スマホ連携用のリモートチャットサーバー（Electron非依存・Node標準httpのみ）。
// 127.0.0.1にのみバインドし、外部からはCloudflare Quick Tunnel経由でのみ到達する。
// 下り: SSE（EventSource。連番+バッファで再接続時にLast-Event-IDから再送）
// 上り: fetch POST。クライアントから信用するのはチャット本文と承認/選択肢の回答のみ。
const http = require('http')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')

const EVENT_BUFFER_MAX = 500 // デバイスごとに保持する再送用イベント数
const PAIR_CODE_TTL_MS = 10 * 60 * 1000 // ワンタイムコードの有効期限
const IDLE_INTERRUPT_MS = 10 * 60 * 1000 // SSE切断のままこの時間経過で実行中ターンを中断（承認待ちハング回避）
const BODY_LIMIT = 1024 * 1024 // POSTボディ上限 1MB
const PAIR_ATTEMPT_LIMIT = 10 // ペアリング試行回数/分（多層防御）

const STATIC_FILES = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/mobile.js': { file: 'mobile.js', type: 'text/javascript; charset=utf-8' },
  '/mobile.css': { file: 'mobile.css', type: 'text/css; charset=utf-8' },
  '/shared/md.js': { file: path.join('..', 'shared', 'md.js'), type: 'text/javascript; charset=utf-8' }
}

function token128() {
  return crypto.randomBytes(16).toString('hex')
}

// タイミング攻撃を避ける固定時間比較
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

// User-Agentから表示用の端末名を要約する
function deviceNameFromUA(ua) {
  ua = String(ua || '')
  if (/iPhone/i.test(ua)) return 'iPhone'
  if (/iPad/i.test(ua)) return 'iPad'
  if (/Android/i.test(ua)) return 'Androidスマホ'
  if (/Windows/i.test(ua)) return 'Windows PC'
  if (/Macintosh/i.test(ua)) return 'Mac'
  return 'スマホ'
}

class RemoteServer {
  /**
   * @param {object} deps
   * @param {() => object} deps.getSettings 現在の設定を返す
   * @param {(emit: Function, deviceId: string, meta?: object) => object} deps.createRunner デバイス専用AgentRunnerを生成
   * @param {(deviceId: string) => string} deps.scratchDirFor デバイス専用cwdを返す
   * @param {string} deps.staticDir renderer/mobile の絶対パス
   * @param {(entry: {deviceId,name,pairedAt,lastSeen,meta}) => void} [deps.onDevicePaired] 台帳保存フック（トークンは渡さない）
   * @param {(deviceId: string, lastSeen: string) => void} [deps.onDeviceSeen] 最終接続時刻の更新フック
   * @param {(entry: {deviceId,token,name,meta}) => void} [deps.onSessionCreated] トークン永続化フック（中継サーバー用）
   * @param {(deviceId: string) => object|undefined} [deps.stateFor] /api/state のデバイス単位上書き（中継サーバー用）
   * @param {(req, res) => boolean} [deps.onRequest] 追加ルート（trueを返したら処理済み。/healthz等）
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ getSettings, createRunner, scratchDirFor, staticDir, onDevicePaired, onDeviceSeen, onSessionCreated, stateFor, onRequest, log }) {
    this.getSettings = getSettings
    this.createRunner = createRunner
    this.scratchDirFor = scratchDirFor
    this.staticDir = staticDir
    this.onDevicePaired = onDevicePaired || (() => {})
    this.onDeviceSeen = onDeviceSeen || (() => {})
    this.onSessionCreated = onSessionCreated || (() => {})
    this.stateFor = stateFor || (() => undefined)
    this.onRequest = onRequest || (() => false)
    this.log = log || (() => {})
    this.server = null
    this.port = 0
    // deviceId -> { token, name, meta, runner, seq, buffer, sseRes, busy, lastSeen, idleTimer }
    this.sessions = new Map()
    this.pairCode = null // { code, expiresAt, meta }
    this.pairAttempts = [] // 直近のペアリング試行時刻（レート制限用）
    this.heartbeat = null
  }

  /** ワンタイムコードを再生成して返す（QR表示のたびに呼ぶ）。metaはペアリング先の紐付け情報（中継サーバーのpcId等） */
  regeneratePairCode(meta) {
    this.pairCode = { code: token128(), expiresAt: Date.now() + PAIR_CODE_TTL_MS, meta: meta || null }
    return this.pairCode.code
  }

  /** 永続化済みペアリングの復元（中継サーバーの再起動時用）。バッファは空から再開 */
  adoptSession({ deviceId, token, name, meta, lastSeen }) {
    const emit = (ev, payload) => this.pushEvent(deviceId, ev, payload)
    this.sessions.set(deviceId, {
      token,
      name: name || 'スマホ',
      meta: meta || null,
      runner: this.createRunner(emit, deviceId, meta || null),
      seq: 0,
      buffer: [],
      sseRes: null,
      busy: false,
      lastSeen: lastSeen || new Date().toISOString(),
      idleTimer: null
    })
  }

  /** 指定デバイスのペアリングを解除（トークン即時無効化） */
  revokeDevice(deviceId) {
    const s = this.sessions.get(deviceId)
    if (s) {
      try {
        s.runner.interrupt()
      } catch {
        /* ignore */
      }
      this.closeSse(s)
      clearTimeout(s.idleTimer)
      this.sessions.delete(deviceId)
    }
  }

  /** 接続中デバイスの一覧（設定UI表示用） */
  listDevices() {
    return Array.from(this.sessions.entries()).map(([deviceId, s]) => ({
      deviceId,
      name: s.name,
      connected: !!s.sseRes,
      lastSeen: s.lastSeen
    }))
  }

  listen(port = 0, host = '127.0.0.1') {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handle(req, res).catch((e) => {
          this.log(`[remote] handler error: ${e && e.message}`)
          if (!res.headersSent) this.json(res, 500, { error: 'internal' })
        })
      })
      this.server.on('error', reject)
      // 既定は127.0.0.1限定バインド。LANからの直アクセスは不可（到達経路はトンネル/リバースプロキシのみ）
      this.server.listen(port, host, () => {
        this.port = this.server.address().port
        // SSE死活維持: 15秒毎のコメント行（トンネルのアイドル切断も防ぐ）
        this.heartbeat = setInterval(() => {
          for (const s of this.sessions.values()) {
            if (s.sseRes) {
              try {
                s.sseRes.write(': ping\n\n')
              } catch {
                this.closeSse(s)
              }
            }
          }
        }, 15000)
        resolve(this.port)
      })
    })
  }

  close() {
    clearInterval(this.heartbeat)
    this.heartbeat = null
    for (const [deviceId] of this.sessions) this.revokeDevice(deviceId)
    this.pairCode = null
    if (this.server) {
      this.server.close()
      this.server = null
    }
  }

  /* --- HTTP配線 --- */

  json(res, status, obj) {
    const body = JSON.stringify(obj)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(body)
  }

  readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (c) => {
        size += c.length
        if (size > BODY_LIMIT) {
          reject(new Error('body too large'))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => {
        try {
          resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
        } catch {
          reject(new Error('bad json'))
        }
      })
      req.on('error', reject)
    })
  }

  // Bearerトークン → セッション。無効ならnull
  authedSession(req) {
    const h = String(req.headers['authorization'] || '')
    const m = h.match(/^Bearer\s+([0-9a-f]{32})$/i)
    // EventSourceはヘッダを付けられないため、SSEだけクエリでも受ける
    const url = new URL(req.url, 'http://x')
    const qtok = url.searchParams.get('token')
    const tok = (m && m[1]) || qtok
    if (!tok) return null
    for (const [deviceId, s] of this.sessions) {
      if (safeEqual(s.token, tok)) return { deviceId, s }
    }
    return null
  }

  async handle(req, res) {
    // 追加ルート（/healthz等）は認証・有効判定の前に処理する
    if (this.onRequest(req, res)) return
    const settings = this.getSettings()
    // 連携OFF中は存在自体を隠す
    if (!settings.remote || !settings.remote.enabled) {
      res.writeHead(404)
      res.end()
      return
    }
    const url = new URL(req.url, 'http://x')
    const p = url.pathname

    // 静的配信（モバイルUI）
    if (req.method === 'GET' && STATIC_FILES[p]) {
      const def = STATIC_FILES[p]
      const file = path.join(this.staticDir, def.file)
      try {
        const body = fs.readFileSync(file)
        res.writeHead(200, { 'Content-Type': def.type, 'Cache-Control': 'no-store' })
        res.end(body)
      } catch {
        res.writeHead(404)
        res.end()
      }
      return
    }

    if (p === '/api/pair' && req.method === 'POST') return this.handlePair(req, res)

    // 以降は認証必須
    const auth = this.authedSession(req)
    if (!auth) {
      this.json(res, 401, { error: 'unauthorized' })
      return
    }
    const { deviceId, s } = auth
    s.lastSeen = new Date().toISOString()
    this.onDeviceSeen(deviceId, s.lastSeen)

    if (p === '/api/events' && req.method === 'GET') return this.handleSse(req, res, s)
    if (p === '/api/state' && req.method === 'GET') {
      const override = this.stateFor(deviceId) || {}
      this.json(res, 200, {
        busy: s.busy,
        seq: s.seq,
        version: this.version || '',
        userName: settings.userName || '',
        ...override
      })
      return
    }
    if (req.method !== 'POST') {
      this.json(res, 405, { error: 'method' })
      return
    }
    const body = await this.readBody(req)
    switch (p) {
      case '/api/chat': {
        const text = String(body.text || '').trim()
        if (!text) return this.json(res, 400, { error: 'empty' })
        if (s.busy) return this.json(res, 409, { error: 'busy' })
        this.startTurn(deviceId, s, text)
        return this.json(res, 202, { ok: true })
      }
      case '/api/interrupt':
        s.runner.interrupt()
        return this.json(res, 200, { ok: true })
      case '/api/new':
        s.runner.interrupt()
        s.runner.newConversation()
        return this.json(res, 200, { ok: true })
      case '/api/perm':
        s.runner.respondPermission(String(body.requestId || ''), !!body.approved, !!body.remember)
        return this.json(res, 200, { ok: true })
      case '/api/choice':
        s.runner.respondChoice(String(body.requestId || ''), String(body.answer || ''))
        return this.json(res, 200, { ok: true })
      default:
        return this.json(res, 404, { error: 'notfound' })
    }
  }

  handlePair(req, res) {
    // レート制限（1分あたりPAIR_ATTEMPT_LIMIT回）
    const now = Date.now()
    this.pairAttempts = this.pairAttempts.filter((t) => now - t < 60000)
    if (this.pairAttempts.length >= PAIR_ATTEMPT_LIMIT) {
      this.json(res, 429, { error: 'too many attempts' })
      return
    }
    this.pairAttempts.push(now)
    return this.readBody(req).then((body) => {
      const code = String(body.code || '')
      const pc = this.pairCode
      if (!pc || now > pc.expiresAt || !safeEqual(pc.code, code)) {
        this.json(res, 403, { error: 'invalid code' })
        return
      }
      const meta = pc.meta || null
      this.pairCode = null // 1回限り
      const deviceId = token128()
      const token = token128()
      const name = deviceNameFromUA(req.headers['user-agent'])
      const emit = (ev, payload) => this.pushEvent(deviceId, ev, payload)
      const session = {
        token,
        name,
        meta,
        runner: this.createRunner(emit, deviceId, meta),
        seq: 0,
        buffer: [],
        sseRes: null,
        busy: false,
        lastSeen: new Date().toISOString(),
        idleTimer: null
      }
      this.sessions.set(deviceId, session)
      this.onSessionCreated({ deviceId, token, name, meta })
      this.onDevicePaired({ deviceId, name, pairedAt: session.lastSeen, lastSeen: session.lastSeen, meta })
      this.log(`[remote] paired: ${name} (${deviceId.slice(0, 8)})`)
      this.json(res, 200, { deviceToken: token, deviceId, name })
    })
  }

  handleSse(req, res, s) {
    // 1デバイス1接続。新規接続が来たら旧接続を閉じる
    this.closeSse(s)
    clearTimeout(s.idleTimer)
    s.idleTimer = null
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    })
    res.write(': connected\n\n')
    s.sseRes = res
    // Last-Event-ID（ヘッダ or クエリ）以降を再送（電波断中のトークン・承認カードを取りこぼさない）
    const url = new URL(req.url, 'http://x')
    const lastId = parseInt(req.headers['last-event-id'] || url.searchParams.get('last') || '0', 10) || 0
    for (const e of s.buffer) {
      if (e.seq > lastId) this.writeSse(res, e)
    }
    req.on('close', () => {
      if (s.sseRes === res) {
        s.sseRes = null
        // 切断のまま放置されたら実行中ターンを中断（承認待ちPromiseのハング回避）
        s.idleTimer = setTimeout(() => {
          if (!s.sseRes) {
            this.log('[remote] idle interrupt')
            s.runner.interrupt()
          }
        }, IDLE_INTERRUPT_MS)
      }
    })
  }

  writeSse(res, e) {
    try {
      res.write(`id: ${e.seq}\ndata: ${JSON.stringify({ ev: e.ev, payload: e.payload })}\n\n`)
    } catch {
      /* 切断は req close で処理 */
    }
  }

  closeSse(s) {
    if (s.sseRes) {
      try {
        s.sseRes.end()
      } catch {
        /* ignore */
      }
      s.sseRes = null
    }
  }

  pushEvent(deviceId, ev, payload) {
    const s = this.sessions.get(deviceId)
    if (!s) return
    const e = { seq: ++s.seq, ev, payload }
    s.buffer.push(e)
    if (s.buffer.length > EVENT_BUFFER_MAX) s.buffer.shift()
    if (s.sseRes) this.writeSse(s.sseRes, e)
  }

  startTurn(deviceId, s, text) {
    s.busy = true
    // セキュリティ強制: クライアントから信用するのはtextのみ。
    // mode=chat固定 / workFolder=null固定（書き込み自動許可ゼロ）/ permMode=normal固定
    s.runner
      .startTurn({
        text,
        mode: 'chat',
        workFolder: null,
        cwd: this.scratchDirFor(deviceId),
        autoApprove: false,
        permMode: 'normal'
      })
      .catch((e) => {
        this.pushEvent(deviceId, 'agent:error', { message: (e && e.message) || String(e) })
      })
      .finally(() => {
        s.busy = false
      })
  }
}

module.exports = { RemoteServer }
