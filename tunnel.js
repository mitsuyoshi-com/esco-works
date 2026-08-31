// Cloudflare Quick Tunnel の起動・URL取得・自動再起動（Electron依存は最小限）。
// 将来 named tunnel / Tailscale 等へ差し替えられるよう、このファイルに外部到達手段を隔離する。
const { spawn } = require('child_process')
const path = require('path')
const fs = require('fs')

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
const START_TIMEOUT_MS = 30000 // URL取得までの待ち時間上限
const MAX_BACKOFF_MS = 60000

// cloudflared.exe の実体パスを解決する。
// 配布ビルド: extraResources で resources/bin/ に同梱。開発時: vendor/cloudflared/。
function resolveCloudflared() {
  const candidates = []
  try {
    const { app } = require('electron')
    if (app && app.isPackaged) {
      candidates.push(path.join(process.resourcesPath, 'bin', 'cloudflared.exe'))
    }
  } catch {
    /* Electron外（テスト等）は無視 */
  }
  candidates.push(path.join(__dirname, 'vendor', 'cloudflared', 'cloudflared.exe'))
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return null
}

class Tunnel {
  /**
   * @param {object} deps
   * @param {(status: {state: string, url?: string, message?: string}) => void} deps.onStatus
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ onStatus, log }) {
    this.onStatus = onStatus
    this.log = log || (() => {})
    this.proc = null
    this.url = null
    this.stopping = false
    this.backoff = 2000
    this.retryTimer = null
  }

  /** トンネルを起動してURLを返す（失敗時はthrow） */
  start(localPort) {
    this.stopping = false
    this.localPort = localPort
    return this.spawnOnce()
  }

  spawnOnce() {
    const exe = resolveCloudflared()
    if (!exe) {
      const message = 'cloudflared.exe が見つかりません（再インストールで直る可能性があります）'
      this.onStatus({ state: 'error', message })
      return Promise.reject(new Error(message))
    }
    this.onStatus({ state: 'starting' })
    return new Promise((resolve, reject) => {
      let settled = false
      const proc = spawn(exe, ['tunnel', '--url', `http://127.0.0.1:${this.localPort}`, '--no-autoupdate'], {
        windowsHide: true
      })
      this.proc = proc
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          this.onStatus({ state: 'error', message: 'トンネルの起動がタイムアウトしました（ネットワークをご確認ください）' })
          try {
            proc.kill()
          } catch {
            /* ignore */
          }
          reject(new Error('tunnel start timeout'))
        }
      }, START_TIMEOUT_MS)

      // cloudflaredはURLをstderrに出す
      const onData = (buf) => {
        const s = buf.toString()
        const m = s.match(URL_RE)
        if (m && !settled) {
          settled = true
          clearTimeout(timer)
          this.url = m[0]
          this.backoff = 2000 // 成功したらバックオフをリセット
          this.log(`[tunnel] up: ${this.url}`)
          this.onStatus({ state: 'up', url: this.url })
          resolve(this.url)
        }
      }
      proc.stderr.on('data', onData)
      proc.stdout.on('data', onData)
      proc.on('error', (e) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.onStatus({ state: 'error', message: `トンネルを起動できません: ${e.message}` })
          reject(e)
        }
      })
      proc.on('exit', (code) => {
        this.proc = null
        this.url = null
        if (this.stopping) return
        this.log(`[tunnel] exited (code=${code})`)
        if (!settled) {
          settled = true
          clearTimeout(timer)
          this.onStatus({ state: 'error', message: 'トンネルが起動できませんでした' })
          reject(new Error(`tunnel exited: ${code}`))
          return
        }
        // 稼働中の異常終了 → 指数バックオフで自動再起動（URLは変わる）
        this.onStatus({ state: 'restarting' })
        this.retryTimer = setTimeout(() => {
          this.spawnOnce().catch(() => {})
          this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS)
        }, this.backoff)
      })
    })
  }

  stop() {
    this.stopping = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    if (this.proc) {
      try {
        this.proc.kill()
      } catch {
        /* ignore */
      }
      this.proc = null
    }
    this.url = null
    this.onStatus({ state: 'stopped' })
  }
}

module.exports = { Tunnel, resolveCloudflared }
