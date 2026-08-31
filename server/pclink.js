// PC(ESCO Works)⇔中継サーバーの常駐WebSocketハブ。
// 認証: Authorization: Bearer <組織キー> + X-PC-Id + X-PC-Secret（TOFUピン留め）
//  - 未知のpcIdの初回接続時にpcSecretを発行して永続化。以後は必須。
//    → 組織キーが漏れても、既存PCになりすましてそのPC宛のスマホ発話を横取りできない。
const crypto = require('crypto')
const { WebSocketServer } = require('ws')

const PING_INTERVAL_MS = 30000

function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return crypto.timingSafeEqual(ba, bb)
}

class PcLinkHub {
  /**
   * @param {object} deps
   * @param {import('http').Server} deps.server RemoteServerが張ったhttpサーバー（upgradeを共用）
   * @param {string} deps.orgKey 組織キー
   * @param {object} deps.store Store
   * @param {(pcId: string, msg: object) => void} deps.onMessage PCからのメッセージ
   * @param {(pcId: string) => void} [deps.onConnected]
   * @param {(pcId: string) => void} [deps.onDisconnected]
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ server, orgKey, store, onMessage, onConnected, onDisconnected, log }) {
    this.orgKey = orgKey
    this.store = store
    this.onMessage = onMessage
    this.onConnected = onConnected || (() => {})
    this.onDisconnected = onDisconnected || (() => {})
    this.log = log || (() => {})
    this.socks = new Map() // pcId -> ws
    this.wss = new WebSocketServer({ noServer: true })

    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url, 'http://x')
      if (url.pathname !== '/pc/link') {
        socket.destroy()
        return
      }
      const auth = this.authenticate(req)
      if (!auth.ok) {
        // 情報を漏らさず接続を切る
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
        socket.destroy()
        return
      }
      this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, auth))
    })

    this.pinger = setInterval(() => {
      for (const [pcId, ws] of this.socks) {
        if (ws.isAlive === false) {
          this.log(`[pclink] ping timeout: ${pcId.slice(0, 8)}`)
          ws.terminate()
          continue
        }
        ws.isAlive = false
        try {
          ws.ping()
        } catch {
          /* closeイベント側で処理 */
        }
      }
    }, PING_INTERVAL_MS)
  }

  authenticate(req) {
    const m = String(req.headers['authorization'] || '').match(/^Bearer\s+(\S+)$/i)
    if (!m || !safeEqual(m[1], this.orgKey)) return { ok: false }
    const pcId = String(req.headers['x-pc-id'] || '')
    if (!/^[0-9a-f-]{16,64}$/.test(pcId)) return { ok: false }
    const known = this.store.getPc(pcId)
    if (known && known.pcSecret) {
      // 既知PC: ピン留めされたsecretの照合必須
      const secret = String(req.headers['x-pc-secret'] || '')
      if (!safeEqual(secret, known.pcSecret)) return { ok: false }
      return { ok: true, pcId, isNew: false, pcSecret: known.pcSecret }
    }
    // 未知PC: TOFUでsecret発行
    const pcSecret = crypto.randomBytes(16).toString('hex')
    this.store.upsertPc({ pcId, pcSecret, userName: '', lastSeen: new Date().toISOString() })
    return { ok: true, pcId, isNew: true, pcSecret }
  }

  accept(ws, auth) {
    const { pcId } = auth
    // 同一pcIdの二重接続は旧を閉じる（アプリ再起動直後の残留ソケット対策）
    const old = this.socks.get(pcId)
    if (old) {
      try {
        old.terminate()
      } catch {
        /* ignore */
      }
    }
    this.socks.set(pcId, ws)
    ws.isAlive = true
    ws.on('pong', () => (ws.isAlive = true))
    ws.on('message', (buf) => {
      let msg
      try {
        msg = JSON.parse(buf.toString('utf8'))
      } catch {
        return
      }
      if (!msg || typeof msg.t !== 'string') return
      this.store.upsertPc({ pcId, lastSeen: new Date().toISOString() })
      this.onMessage(pcId, msg)
    })
    ws.on('close', () => {
      if (this.socks.get(pcId) === ws) {
        this.socks.delete(pcId)
        this.onDisconnected(pcId)
      }
    })
    ws.on('error', () => {
      /* closeで処理 */
    })
    this.log(`[pclink] connected: ${pcId.slice(0, 8)}${auth.isNew ? ' (new)' : ''}`)
    // helloより先にhello:okを送る（初回はpcSecretを含む＝PC側が保存する）
    this.send(pcId, { t: 'hello:ok', ...(auth.isNew ? { pcSecret: auth.pcSecret } : {}) })
    this.onConnected(pcId)
  }

  send(pcId, msg) {
    const ws = this.socks.get(pcId)
    if (!ws || ws.readyState !== ws.OPEN) return false
    try {
      ws.send(JSON.stringify(msg))
      return true
    } catch {
      return false
    }
  }

  isConnected(pcId) {
    const ws = this.socks.get(pcId)
    return !!ws && ws.readyState === ws.OPEN
  }

  close() {
    clearInterval(this.pinger)
    for (const ws of this.socks.values()) {
      try {
        ws.terminate()
      } catch {
        /* ignore */
      }
    }
    this.socks.clear()
    this.wss.close()
  }
}

module.exports = { PcLinkHub }
