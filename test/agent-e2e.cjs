// エージェント（指定された人だけ）の総合テスト。画面は出さず、モックサーバーと一時 userData だけを使う。
// Anthropic・本番サーバーには一切つながない（にせのエージェント test/fake-runner.cjs を使う）。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const electronPath = require('electron')
const { createMock } = require('./mock-server.cjs')
const { makeLegacy, snapshot } = require('./fixtures.cjs')

const root = path.join(__dirname, '..')
const tmp = (l) => fs.mkdtempSync(path.join(os.tmpdir(), 'esco-agent-' + l + '-'))
const results = []
async function t(name, fn) {
  try { await fn(); results.push(true); console.log('PASS ' + name) } catch (e) { results.push(false); console.log('FAIL ' + name + '\n   ' + (e && e.stack || e)) }
}
const KEY = 'sk-ant-api03-TESTONLY-' + 'a'.repeat(40)
const ME = '11111111-1111-4111-8111-111111111111'

function runShell({ url, userData, env = {}, timeoutMs = 30000 }) {
  const report = path.join(userData, 'report.json')
  const e = {
    ...process.env, ESCO_TEST: '1', ESCO_TEST_USERDATA: userData, ESCO_TEST_HIDDEN: '1', ESCO_TEST_EXIT: '1', ESCO_TEST_FAST: '1',
    ESCO_TEST_REPORT: report, ESCO_TEST_TIMEOUT_MS: String(timeoutMs - 5000), ESCO_WORKS_URL: url, ESCO_LEGACY_DIRS: '', ESCO_JOIN_KEY: '',
    ESCO_TEST_AGENT: '1', ESCO_TEST_RUNNER: path.join(__dirname, 'fake-runner.cjs'), ESCO_TEST_RUNNER_LOG: path.join(userData, 'runner.log'), ...env
  }
  delete e.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    // ESCO_E2E_EXE にパッケージ版の exe を渡すと、配布する形のままで同じテストをする（ビルド機での確認用）
    const packaged = process.env.ESCO_E2E_EXE
    const p = spawn(packaged || electronPath, packaged ? ['--disable-gpu'] : ['.', '--disable-gpu'], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => { p.kill(); reject(new Error('殻が時間内に終了しませんでした\n' + out.slice(-2000))) }, timeoutMs)
    p.on('exit', (code) => {
      clearTimeout(timer)
      if (!fs.existsSync(report)) return reject(new Error('レポートがありません（終了コード ' + code + '）\n' + out.slice(-2000)))
      resolve({ ...JSON.parse(fs.readFileSync(report, 'utf8')), exitCode: code, log: out })
    })
  })
}
const runnerLog = (ud) => { try { return fs.readFileSync(path.join(ud, 'runner.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) } catch { return [] } }
// userData の中のどこかにキーの文字列が書かれていないか（ログ・設定・キューを含めて全部）
function findKeyOnDisk(dir, key) {
  const hits = []
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) { if (!/^(Cache|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|Network|Session Storage|Local Storage|blob_storage|Shared Dictionary|WebStorage)$/i.test(e.name)) walk(p) }
      else if (e.name !== 'runner.log') { try { if (fs.readFileSync(p).includes(key)) hits.push(path.relative(dir, p)) } catch { /* 開けないファイルは対象外 */ } } // runner.log はテスト用のにせエージェントの記録
    }
  }
  walk(dir)
  return hits
}

;(async () => {
  await t('対象者：入口が出る→画面が開く→旧版の会話が見える→1回動かすと、その人のキーで動き、利用額が1件報告される。キーはPCに保存されない・画面にも出ない', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, apiKey: KEY } } }); const ud = tmp('ud')
    const exp = makeLegacy(ud, { sessions: 4, userName: '山本光強', business: true })
    const before = snapshot(path.join(ud, 'sessions'))
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key } })
    const a = r.agentScenario
    assert.ok(a && !a.error, 'シナリオが失敗: ' + JSON.stringify(a))
    assert.deepEqual(a.status, { enabled: true })
    assert.equal(a.opened, true); assert.equal(a.title, 'ESCO Works エージェント')
    assert.equal(a.init.hasApiKey, true); assert.equal(a.init.notice, ''); assert.equal(a.init.apiKeyShown, '', '画面にキーが渡っています')
    assert.equal(a.sessions, exp.conversations, '旧版の会話が一覧に出ていません: ' + a.sessions)
    assert.deepEqual(a.sends, ['ok'])
    assert.deepEqual(a.hiddenParts, { cost: '今月のエージェントの残り：58％', phone: true, key: true }, '残りの表示（金額なし・％だけ）・スマホ連携とキー欄の非表示が想定と違います')
    const log = runnerLog(ud)
    assert.equal(log.length, 1); assert.equal(log[0].apiKey, KEY, 'サーバーのキーで動いていません'); assert.equal(log[0].mode, 'docs')
    assert.equal(mock.state.agent.usage.length, 1)
    const u = mock.state.agent.usage[0]
    assert.equal(u.userId, ME); assert.equal(u.costUsd, 0.42); assert.equal(u.mode, 'docs'); assert.equal(u.model, 'claude-sonnet-5-5')
    assert.equal(u.inputTokens, 9000); assert.equal(u.outputTokens, 2000); assert.ok(/^[A-Za-z0-9_-]{8,80}$/.test(u.runId)); assert.ok(u.appVersion)
    assert.equal(a.queue, 0, '送り終えた報告が残っています')
    assert.deepEqual(findKeyOnDisk(ud, KEY), [], 'キーがPCのファイルに書かれています')
    assert.deepEqual(snapshot(path.join(ud, 'sessions')), before, '旧版の元ファイルが書き換わっています')
    const h = mock.state.agent.configHeaders
    assert.ok(h.length >= 2 && h.every((x) => x.shell === '1' && !x.origin && !x.referer && (!x.site || x.site === 'none')), '殻からの問い合わせの形が想定と違います: ' + JSON.stringify(h[0]))
    console.log('   一覧', a.sessions, '件 / 報告', JSON.stringify({ costUsd: u.costUsd, mode: u.mode, model: u.model }), '/ 問い合わせの sec-fetch-site:', h[0].site)
    await mock.close()
  })

  await t('対象者でない人：入口は出ず、開く合図を送っても画面は開かない。エージェント用のデータ置き場も作られない報告もない', async () => {
    const mock = await createMock(); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 2, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key }, timeoutMs: 25000 })
    const a = r.agentScenario
    assert.deepEqual(a.status, { enabled: false }); assert.equal(a.opened, false)
    assert.equal(mock.state.agent.usage.length, 0); assert.equal(runnerLog(ud).length, 0)
    assert.ok(!fs.existsSync(path.join(ud, 'agent', 'sessions')), '対象者でないのにデータ置き場ができています')
    await mock.close()
  })

  await t('今月の枠に達した人：画面は開くが動かせない（案内が出る）。エージェントは呼ばれず、報告もない', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, blocked: true, apiKey: KEY } } }); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key } })
    const a = r.agentScenario
    assert.deepEqual(a.status, { enabled: true }); assert.equal(a.opened, true)
    assert.equal(a.init.hasApiKey, false); assert.ok(a.init.notice.includes('ご利用枠に達しました'))
    assert.ok(a.sends[0].startsWith('error: ') && a.sends[0].includes('ご利用枠に達しました'), a.sends[0])
    assert.equal(a.warn.hidden, false); assert.ok(a.warn.text.includes('来月1日'))
    assert.equal(runnerLog(ud).length, 0); assert.equal(mock.state.agent.usage.length, 0)
    await mock.close()
  })

  await t('キーがまだ入っていない人：動かせない（準備中の案内）', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, apiKey: '' } } }); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key } })
    const a = r.agentScenario
    assert.ok(a.sends[0].includes('準備がまだ'), a.sends[0]); assert.equal(runnerLog(ud).length, 0)
    await mock.close()
  })

  await t('動かしている最中に枠を超えたら、その回の分は報告され、次の回からは止まる', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, apiKey: KEY } }, blockAfterUsage: true }); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_AGENT_SENDS: '2' } })
    const a = r.agentScenario
    assert.equal(a.sends[0], 'ok'); assert.ok(a.sends[1].includes('ご利用枠に達しました'), a.sends[1])
    assert.equal(mock.state.agent.usage.length, 1); assert.equal(runnerLog(ud).length, 1)
    assert.equal(a.warn.hidden, false)
    await mock.close()
  })

  await t('報告を送れなかったときは捨てずに残し、あとで送り直す（二重には数えない）', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, apiKey: KEY } }, usageFailFirst: 1 }); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_AGENT_REFLUSH: '1' } })
    const a = r.agentScenario
    assert.equal(a.sends[0], 'ok'); assert.equal(a.queue, 1, '送れなかった報告が残っていません'); assert.equal(a.queueAfter, 0)
    assert.equal(mock.state.agent.usage.length, 1)
    await mock.close()
  })

  await t('途中で止めた回（金額が届かない）も、トークン数を付けて「推定」として報告する', async () => {
    const mock = await createMock({ agentMembers: { [ME]: { enabled: true, apiKey: KEY } } }); const ud = tmp('ud')
    makeLegacy(ud, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_RUNNER_ABORT: '1' } })
    assert.equal(r.agentScenario.sends[0], 'ok')
    const u = mock.state.agent.usage[0]
    assert.ok(u && u.estimated === true && u.costUsd === 0 && u.inputTokens === 1200 && u.outputTokens === 300, JSON.stringify(u))
    await mock.close()
  })

  const bad = results.filter((x) => !x).length
  console.log('\nエージェントの総合テスト: ' + (results.length - bad) + '/' + results.length + ' 通過')
  process.exit(bad ? 1 : 0)
})()
