// デプロイ後の疎通確認（VPS上で実行）。公開URL経由で /healthz とモバイルUI配信、
// クラウド頭脳の1ターン実行（実APIキー・数円のコスト）を確認する。
//   node server/scripts/selfcheck.mjs           … healthz+UI配信のみ（コスト0）
//   node server/scripts/selfcheck.mjs --full    … クラウド頭脳の実1ターンも確認
import fs from 'fs'
import { createRequire } from 'module'
const require = createRequire(import.meta.url)

let env = { ...process.env }
try {
  for (const line of fs.readFileSync('/etc/esco-relay/env', 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m && !env[m[1]]) env[m[1]] = m[2]
  }
} catch {
  /* envファイルなし */
}

const url = (env.ESCO_RELAY_URL || '').replace(/\/$/, '')
if (!url) {
  console.error('ESCO_RELAY_URL が見つかりません')
  process.exit(1)
}

let ok = true
const check = (name, cond) => {
  console.log(`  ${cond ? 'ok' : 'NG'}: ${name}`)
  if (!cond) ok = false
}

// 1. healthz
try {
  const r = await fetch(`${url}/healthz`)
  check('/healthz が200', r.status === 200)
} catch (e) {
  check(`/healthz 到達（${e.message}）`, false)
}
// 2. モバイルUI配信
try {
  const r = await fetch(url)
  const body = await r.text()
  check('モバイルUIが配信される', r.status === 200 && body.includes('ESCO Works'))
} catch (e) {
  check(`UI配信（${e.message}）`, false)
}
// 3. クラウド頭脳の実行（--fullのみ・実コスト発生）
if (process.argv.includes('--full')) {
  const { AgentRunner } = require('../../agent.js')
  let out = ''
  const runner = new AgentRunner({
    getSettings: () => ({ apiKey: env.ANTHROPIC_API_KEY, enableBrowser: false, models: { chat: env.ESCO_MODEL || 'claude-sonnet-5' } }),
    emit: (ev, p) => {
      if (ev === 'agent:token') out += p.delta
      if (ev === 'agent:error') console.log('  [error]', p.message)
    }
  })
  await runner.startTurn({
    text: '「サーバー動作OK」とだけ返してください。',
    mode: 'chat',
    workFolder: null,
    cwd: env.ESCO_DATA_DIR || '/tmp',
    autoApprove: false,
    permMode: 'readonly'
  })
  check(`クラウド頭脳が応答（${out.slice(0, 30)}）`, out.includes('OK'))
}

console.log(ok ? '[selfcheck] done' : '[selfcheck] FAILED')
process.exit(ok ? 0 : 1)
