// 殻（Electron）の総合テスト。画面は出さず（hidden）、モックサーバーとテスト専用の一時 userData だけを使う。
// 本物の利用者データ・本番サーバー・GitHub・ブラウザには触れない。
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const electronPath = require('electron')
const { createMock } = require('./mock-server.cjs')
const { makeLegacy } = require('./fixtures.cjs')

const root = path.join(__dirname, '..')
const tmp = (l) => fs.mkdtempSync(path.join(os.tmpdir(), 'esco-e2e-' + l + '-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
async function t(name, fn) {
  try { await fn(); results.push(true); console.log('PASS ' + name) } catch (e) { results.push(false); console.log('FAIL ' + name + '\n   ' + (e && e.stack || e)) }
}

// 殻を1回起動して、レポートを返す
function runShell({ url, userData, legacyDirs = [], env = {}, timeoutMs = 25000, whileRunning }) {
  const report = path.join(userData, 'report.json')
  const e = {
    ...process.env, ELECTRON_RUN_AS_NODE: '', ESCO_TEST: '1', ESCO_TEST_USERDATA: userData, ESCO_TEST_HIDDEN: '1', ESCO_TEST_EXIT: '1',
    ESCO_TEST_FAST: '1', ESCO_TEST_REPORT: report, ESCO_TEST_TIMEOUT_MS: String(timeoutMs - 5000),
    ESCO_WORKS_URL: url, ESCO_LEGACY_DIRS: legacyDirs.join(path.delimiter), ESCO_JOIN_KEY: '', ...env
  }
  delete e.ELECTRON_RUN_AS_NODE
  return new Promise((resolve, reject) => {
    const p = spawn(electronPath, ['.', '--disable-gpu'], { cwd: root, env: e, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (out += d))
    const timer = setTimeout(() => { p.kill(); reject(new Error('殻が時間内に終了しませんでした\n' + out.slice(-1500))) }, timeoutMs)
    if (whileRunning) whileRunning()
    p.on('exit', (code) => {
      clearTimeout(timer)
      if (!fs.existsSync(report)) return reject(new Error('レポートがありません（終了コード ' + code + '）\n' + out.slice(-1500)))
      resolve({ ...JSON.parse(fs.readFileSync(report, 'utf8')), exitCode: code, log: out })
    })
  })
}
const apiKeyOf = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).apiKey

;(async () => {
  await t('自動ログイン→履歴取り込み→旧APIキー消去：名前が1人だけ一致。殻の画面を読み込み、Cookie を約1年で保存、外部遷移は止まり、タイトルは ESCO Works のまま', async () => {
    const mock = await createMock({ externalNav: true }); const legacy = tmp('legacy'), ud = tmp('ud')
    const exp = makeLegacy(legacy, { sessions: 5, messages: 4, withError: true, broken: true, business: true, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key } })
    assert.equal(r.login.result, 'logged_in')
    assert.ok(r.loaded.includes(mock.url + '/'), '画面を読み込めていません: ' + JSON.stringify(r.loaded))
    assert.equal(r.windowTitle, 'ESCO Works')
    const c = r.cookies.find((x) => x.name === 'aichat_session')
    assert.ok(c && c.httpOnly, 'Cookie がありません')
    const days = (c.expirationDate - Date.now() / 1000) / 86400
    assert.ok(days > 330 && days < 370, 'Cookie の期限が約1年ではありません: ' + days.toFixed(1) + ' 日')
    assert.ok(r.external.includes('http://external.invalid/nav'), '外部遷移が既定のブラウザ側へ回されていません')
    assert.ok(!r.loaded.some((u) => u.includes('external.invalid')), '外部ページが殻の中で開きました')
    assert.equal(r.import.status, 'done'); assert.equal(r.import.totals.conversations, exp.conversations); assert.equal(r.import.totals.messages, exp.messages)
    const got = mock.bucket(mock.state.members[0].id).conversations
    assert.equal(got.size, exp.conversations)
    assert.equal([...got.values()].reduce((n, x) => n + x.messages, 0), exp.messages)
    assert.equal(apiKeyOf(legacy), '', '旧APIキーが消えていません')
    assert.ok(fs.existsSync(path.join(ud, 'legacy-import-receipt.json')))
    assert.ok(fs.existsSync(path.join(legacy, 'sessions', exp.ids[0] + '.json')), '元ファイルが消えています')
    console.log('   取り込み: 会話', r.import.totals.conversations, '/ 発言', r.import.totals.messages, '/ Cookie期限', days.toFixed(0), '日 / 旧APIキー消去', r.import.clearedApiKeyFiles, '件')
    await mock.close()
  })

  await t('旧さくら登録名（account.bin・資格情報で暗号化）からの名前でも自動ログインできる', async () => {
    const mock = await createMock(); const legacy = tmp('legacy'), ud = tmp('ud')
    makeLegacy(legacy, { sessions: 1, userName: '' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_ACCOUNT_NAME: '山本　光強' } })
    assert.equal(r.login.result, 'logged_in')
    await mock.close()
  })

  await t('同姓同名（複数一致）は自動ログインせず、名前選択画面（/join#k=…）へ。取り込みは保留・APIキーは残る', async () => {
    const mock = await createMock(); const legacy = tmp('legacy'), ud = tmp('ud')
    makeLegacy(legacy, { sessions: 2, userName: '佐藤花子' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key }, timeoutMs: 15000 })
    assert.equal(r.login.result, 'need_picker'); assert.equal(r.login.reason, 'multiple')
    assert.ok(r.loaded.some((u) => u.startsWith(mock.url + '/join#k=')), '名前選択画面を開いていません: ' + JSON.stringify(r.loaded))
    assert.equal(mock.state.loginCalls, 0)
    assert.equal(apiKeyOf(legacy), 'sk-ant-TEST-FAKE-KEY'); assert.equal(r.importDone, false)
    await mock.close()
  })

  await t('使用中の名前は選べず、名前選択画面へ', async () => {
    const mock = await createMock(); const legacy = tmp('legacy'), ud = tmp('ud')
    mock.state.members[0].inUse = true
    makeLegacy(legacy, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key }, timeoutMs: 15000 })
    assert.equal(r.login.reason, 'in_use'); assert.ok(r.loaded.some((u) => u.startsWith(mock.url + '/join#k=')))
    await mock.close()
  })

  await t('鍵がないビルドでは自動ログインせず Web のログイン画面（トップ）を表示', async () => {
    const mock = await createMock(); const legacy = tmp('legacy'), ud = tmp('ud')
    makeLegacy(legacy, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], timeoutMs: 15000 })
    assert.equal(r.login.result, 'no_key'); assert.ok(r.loaded.includes(mock.url + '/')); assert.equal(mock.state.loginCalls, 0)
    await mock.close()
  })

  await t('同意がまだの間は取り込まず待ち、同意後に取り込み、完了後にだけ旧APIキーを消す', async () => {
    const mock = await createMock({ needsConsent: true }); const legacy = tmp('legacy'), ud = tmp('ud')
    const exp = makeLegacy(legacy, { sessions: 3, userName: '山本光強' })
    const flip = async () => { await sleep(4000); assert.equal(apiKeyOf(legacy), 'sk-ant-TEST-FAKE-KEY', '同意前にAPIキーが消えました'); assert.equal(mock.state.importCalls, 0, '同意前に送信しました'); mock.state.needsConsent = false }
    let flipped
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key }, whileRunning: () => { flipped = flip() } })
    await flipped
    assert.equal(r.import.status, 'done'); assert.equal(apiKeyOf(legacy), '')
    assert.equal(mock.bucket(mock.state.members[0].id).conversations.size, exp.conversations)
    await mock.close()
  })

  await t('取り込みが失敗しても完了にしない：失敗→自動で再試行→成功（成功までAPIキーは残る）', async () => {
    const mock = await createMock({ failFirst: 4 }); const legacy = tmp('legacy'), ud = tmp('ud')
    const exp = makeLegacy(legacy, { sessions: 3, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key } })
    const iFail = r.events.findIndex((x) => x.includes('[import] 失敗')), iDone = r.events.findIndex((x) => x.includes('[import] 完了'))
    assert.ok(iFail >= 0 && iDone > iFail, '失敗→完了の順になっていません')
    assert.equal(r.import.status, 'done'); assert.equal(apiKeyOf(legacy), '')
    assert.equal(mock.bucket(mock.state.members[0].id).conversations.size, exp.conversations)
    await mock.close()
  })

  await t('サーバーの応答が食い違い続けると完了にしない（APIキーは残り、受領書も作らない）', async () => {
    const mock = await createMock({ corrupt: 'received' }); const legacy = tmp('legacy'), ud = tmp('ud')
    makeLegacy(legacy, { sessions: 3, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key }, timeoutMs: 15000 })
    assert.equal(r.importDone, false); assert.equal(apiKeyOf(legacy), 'sk-ant-TEST-FAKE-KEY')
    assert.ok(!fs.existsSync(path.join(ud, 'legacy-import-receipt.json')))
    await mock.close()
  })

  await t('名前がログイン中の人と違うときは確認（「あとで」なら取り込まない・「移す」なら取り込む）', async () => {
    for (const [answer, expectDone] of [['no', false], ['yes', true]]) {
      const mock = await createMock(); const legacy = tmp('legacy'), ud = tmp('ud')
      makeLegacy(legacy, { sessions: 2, userName: '山本光強' })
      // Web の名前選択で佐藤さんとしてログイン済み、という状況（旧アプリの名前は山本さん）
      const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], timeoutMs: 15000,
        env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_PRELOGIN_USERID: mock.state.members[1].id, ESCO_TEST_CONFIRM: answer } })
      assert.equal(r.importDone, expectDone, answer)
      assert.equal(apiKeyOf(legacy), expectDone ? '' : 'sk-ant-TEST-FAKE-KEY')
      assert.equal(mock.bucket(mock.state.members[1].id).conversations.size, expectDone ? 2 : 0)
      await mock.close()
    }
  })

  await t('通信できないときは日本語の案内ページ（再試行ボタン）を表示し、落ちない', async () => {
    const legacy = tmp('legacy'), ud = tmp('ud')
    makeLegacy(legacy, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: 'http://127.0.0.1:9', userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: 'K'.repeat(32) }, timeoutMs: 12000 })
    assert.ok(r.loaded.some((u) => u.startsWith('file:') && u.endsWith('offline.html?u=' + encodeURIComponent('http://127.0.0.1:9/')) || u.includes('offline.html')), '案内ページを表示していません: ' + JSON.stringify(r.loaded))
    assert.equal(apiKeyOf(legacy), 'sk-ant-TEST-FAKE-KEY')
  })

  await t('ダウンロード（提案書PDF・画像）が殻で保存できる', async () => {
    const mock = await createMock({ autoDownload: true }); const legacy = tmp('legacy'), ud = tmp('ud'), dl = tmp('dl')
    makeLegacy(legacy, { sessions: 1, userName: '山本光強' })
    const r = await runShell({ url: mock.url, userData: ud, legacyDirs: [legacy], env: { ESCO_JOIN_KEY: mock.state.key, ESCO_TEST_DOWNLOAD_DIR: dl }, timeoutMs: 15000 })
    assert.ok(r.downloads.some((d) => d.name === 'proposal.pdf' && d.state === 'completed'), JSON.stringify(r.downloads))
    assert.ok(fs.readFileSync(path.join(dl, 'proposal.pdf'), 'utf8').startsWith('%PDF'))
    await mock.close()
  })

  const bad = results.filter((x) => !x).length
  console.log('\n殻の総合テスト: ' + (results.length - bad) + '/' + results.length + ' 通過')
  process.exit(bad ? 1 : 0)
})()
