// 全テストを順に実行（すべて自動・画面なし・本番には触れない）
const { spawnSync } = require('node:child_process')
const path = require('node:path')
let bad = 0
for (const f of ['name-test.cjs', 'import-test.cjs', 'shell-e2e.cjs']) {
  console.log('\n===== ' + f + ' =====')
  const r = spawnSync(process.execPath, [path.join(__dirname, f)], { stdio: 'inherit' })
  if (r.status !== 0) bad++
}
console.log(bad ? '\n失敗あり' : '\nすべて通過')
process.exit(bad ? 1 : 0)
