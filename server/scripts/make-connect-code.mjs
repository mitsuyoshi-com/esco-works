// PCアプリの設定に貼る「接続コード」を生成する（VPS上で実行）。
//   node server/scripts/make-connect-code.mjs
// /etc/esco-relay/env（なければ環境変数）から ESCO_ORG_KEY / ESCO_RELAY_URL を読む。
import fs from 'fs'

let env = { ...process.env }
try {
  for (const line of fs.readFileSync('/etc/esco-relay/env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !env[m[1]]) env[m[1]] = m[2]
  }
} catch {
  /* envファイルなし（環境変数で渡す） */
}

const url = (env.ESCO_RELAY_URL || '').replace(/\/$/, '')
const key = env.ESCO_ORG_KEY || ''
if (!url || !key) {
  console.error('ESCO_RELAY_URL / ESCO_ORG_KEY が見つかりません')
  process.exit(1)
}
const code = 'ESCO1.' + Buffer.from(JSON.stringify({ u: url, k: key })).toString('base64url')
console.log('接続コード（各PCの ⚙設定 → スマホ連携 → 接続コード に貼り付け）:')
console.log(code)
