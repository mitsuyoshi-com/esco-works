// ESCO Works 殻の設定（接続先・初回ログイン用の鍵）
const fs = require('fs')
const path = require('path')

const DEFAULT_URL = 'https://dno-chat-712377223777.asia-northeast1.run.app'
const KEY_RE = /^[A-Za-z0-9_-]{20,200}$/

// 接続先。環境変数 ESCO_WORKS_URL で上書きできるのはテスト（ESCO_TEST=1）のときだけ。
// 配布版は固定（環境変数を仕込まれて偽のサーバーへ鍵や自動ログインを送らされないように）。
function baseUrl() {
  const override = process.env.ESCO_TEST === '1' ? process.env.ESCO_WORKS_URL : ''
  const u = new URL(override || DEFAULT_URL)
  return u.origin
}

// 社内公開リンクの鍵（初回ログイン用）。ビルド時に build/join-key.txt を同梱する。
// ファイルが無い（または形式が違う）ビルドでは空 = 自動ログインせず Web のログイン画面を出す。
function joinKey() {
  const fromEnv = (process.env.ESCO_JOIN_KEY || '').trim()
  if (KEY_RE.test(fromEnv)) return fromEnv
  try {
    const v = fs.readFileSync(path.join(__dirname, 'build', 'join-key.txt'), 'utf8').trim()
    if (KEY_RE.test(v)) return v
    // 「https://…/join#k=<鍵>」のようにリンクごと貼られていても受け付ける
    const m = /[#?&]k=([A-Za-z0-9_-]{20,200})/.exec(v)
    if (m) return m[1]
  } catch { /* 無ければ空 */ }
  return ''
}

module.exports = { baseUrl, joinKey, DEFAULT_URL, KEY_RE }
