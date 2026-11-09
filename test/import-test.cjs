// 履歴の取り込みテスト（Node 単体。モックサーバー相手・本物の利用者データには触れない）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMock, loginAs } = require('./mock-server.cjs')
const { makeLegacy, snapshot } = require('./fixtures.cjs')
const { runImport, clearApiKeys, ImportError, readReceipt } = require('../importer.js')
const { readLegacy } = require('../legacy.js')

const results = []
async function t(name, fn) {
  try { await fn(); results.push([true, name]); console.log('PASS ' + name) }
  catch (e) { results.push([false, name]); console.log('FAIL ' + name + '\n   ' + (e && e.stack || e)) }
}
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), 'esco-import-' + label + '-'))
const noSleep = async () => {}
const mockConv = (mock, who = 0) => mock.bucket(mock.state.members[who].id).conversations

// 元ファイルが1バイトも変わっていないこと（追加されるファイルは別）
function assertUntouched(dir, before) {
  const after = snapshot(dir)
  for (const [k, v] of Object.entries(before)) assert.equal(after[k], v, '元ファイルが変わりました: ' + k)
}

;(async () => {
  await t('取り込み：会話・発言・プロジェクト・業務メモ・読めないファイルが全部届き、件数が一致する（元ファイル不変・APIキーはこの時点では残る）', async () => {
    const mock = await createMock(); const legacy = tmp('a-legacy'), ud = tmp('a-ud')
    const exp = makeLegacy(legacy, { sessions: 6, messages: 5, withError: true, broken: true, business: true })
    const before = snapshot(legacy)
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'dev-1', dirs: [legacy], sleep: noSleep })
    assert.equal(r.status, 'done')
    assert.deepEqual({ ...r.receipt.totals, batches: 0 }, { projects: 1, conversations: 6, messages: exp.messages, businessEntries: 1, businessJobs: 1, unreadable: 2, batches: 0 })
    const got = mockConv(mock)
    assert.equal(got.size, 6)
    for (const id of exp.ids) assert.ok(got.has(id), '会話が届いていません ' + id)
    assert.equal([...got.values()].reduce((n, c) => n + c.messages, 0), exp.messages)
    const bk = mock.bucket(mock.state.members[0].id)
    assert.equal(bk.projects.size, 1); assert.equal(bk.unreadable.length, 2); assert.ok(bk.business)
    // アーカイブ済み・ゴミ箱の会話も届いている
    assert.ok([...got.values()].some((c) => c.archived)); assert.ok([...got.values()].some((c) => c.deleted))
    assertUntouched(legacy, before)
    assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8')).apiKey, 'sk-ant-TEST-FAKE-KEY')
    const rc = readReceipt(ud)
    assert.equal(rc.complete, true); assert.equal(rc.conversations.length, 6)
    assert.ok(fs.readdirSync(path.join(ud, 'legacy-unreadable')).length >= 3) // 読めない2本の複製＋索引
    console.log('   届いた件数: 会話', got.size, '/ 発言', exp.messages, '/ バッチ', r.receipt.totals.batches)
    await mock.close()
  })

  await t('冪等：もう一度送っても重複しない（受領済みは already、受領書を消して再送しても skipped）', async () => {
    const mock = await createMock(); const legacy = tmp('b-legacy'), ud = tmp('b-ud')
    const exp = makeLegacy(legacy, { sessions: 4 })
    const doFetch = await loginAs(mock)
    await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    const again = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(again.status, 'already')
    fs.unlinkSync(path.join(ud, 'legacy-import-receipt.json'))
    const r3 = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r3.status, 'done')
    assert.equal(mockConv(mock).size, exp.conversations)
    assert.ok(r3.receipt.server.skipped.every((s) => s.conversations === exp.conversations)) // 全部 skipped
    await mock.close()
  })

  await t('追加：後から発言が増えた会話は、足りない分が更新される（updated）', async () => {
    const mock = await createMock(); const legacy = tmp('c-legacy'), ud = tmp('c-ud')
    const exp = makeLegacy(legacy, { sessions: 2, messages: 2 })
    const doFetch = await loginAs(mock)
    await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    const f = path.join(legacy, 'sessions', exp.ids[0] + '.json')
    const s = JSON.parse(fs.readFileSync(f, 'utf8')); s.messages.push({ role: 'user', text: '追記', at: s.updatedAt }); fs.writeFileSync(f, JSON.stringify(s))
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r.status, 'done'); assert.equal(mockConv(mock).get(exp.ids[0]).messages, 3)
    await mock.close()
  })

  await t('分割送信：小さいバッチ上限で複数回に分けて送り、全件一致', async () => {
    const mock = await createMock(); const legacy = tmp('d-legacy'), ud = tmp('d-ud')
    const exp = makeLegacy(legacy, { sessions: 12, messages: 4, business: true })
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep, maxBatchBytes: 3500 })
    assert.ok(r.receipt.totals.batches > 3, 'バッチ数 ' + r.receipt.totals.batches)
    assert.equal(mockConv(mock).size, exp.conversations)
    assert.equal([...mockConv(mock).values()].reduce((n, c) => n + c.messages, 0), exp.messages)
    console.log('   バッチ数', r.receipt.totals.batches, '最大本文', mock.state.maxBody, 'バイト')
    await mock.close()
  })

  await t('巨大な1会話は発言を分けて送る（raw は発言を除いた形）が、発言は全部届く', async () => {
    const mock = await createMock(); const legacy = tmp('e-legacy'), ud = tmp('e-ud')
    const exp = makeLegacy(legacy, { sessions: 1, messages: 8, long: 3000, projects: 0 })
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep, maxBatchBytes: 20000 })
    assert.equal(r.status, 'done'); assert.equal([...mockConv(mock).values()][0].messages, exp.messages)
    assert.ok(mock.state.importCalls > 1)
    await mock.close()
  })

  await t('413（大きすぎる）のときは分割を細かくして再送し、成功する', async () => {
    const mock = await createMock({ limit: 30000 }); const legacy = tmp('f-legacy'), ud = tmp('f-ud')
    const exp = makeLegacy(legacy, { sessions: 10, messages: 6, long: 400 })
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep, maxBatchBytes: 1024 * 1024 })
    assert.equal(r.status, 'done'); assert.equal(mockConv(mock).size, exp.conversations)
    await mock.close()
  })

  await t('一時的な失敗（500）は自動でやり直して成功する', async () => {
    const mock = await createMock({ failFirst: 2 }); const legacy = tmp('g-legacy'), ud = tmp('g-ud')
    const exp = makeLegacy(legacy, { sessions: 3 })
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep, retries: 3 })
    assert.equal(r.status, 'done'); assert.equal(mock.state.importCalls, 3); assert.equal(mockConv(mock).size, exp.conversations)
    await mock.close()
  })

  await t('失敗が続くと完了にしない：受領書なし・APIキー残る → 次回再試行で完了して初めてAPIキーを消せる', async () => {
    const mock = await createMock({ failFirst: 100 }); const legacy = tmp('h-legacy'), ud = tmp('h-ud')
    makeLegacy(legacy, { sessions: 3 })
    const doFetch = await loginAs(mock)
    await assert.rejects(() => runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep, retries: 1 }), (e) => e instanceof ImportError)
    assert.equal(readReceipt(ud), null)
    assert.equal(JSON.parse(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8')).apiKey, 'sk-ant-TEST-FAKE-KEY')
    mock.state.failFirst = 0
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r.status, 'done')
    const cleared = clearApiKeys([legacy])
    assert.equal(cleared.length, 1)
    const s = JSON.parse(fs.readFileSync(path.join(legacy, 'settings.json'), 'utf8'))
    assert.equal(s.apiKey, ''); assert.equal(s.staffId, 'staff-1'); assert.equal(s.models.chat, 'claude-sonnet-5-5') // 他の設定は残る
    assert.equal(clearApiKeys([legacy]).length, 0) // 2回目は何もしない
    await mock.close()
  })

  await t('未同意（403）・未ログイン（401）は auth として待つ。同意後に成功する', async () => {
    const mock = await createMock({ needsConsent: true }); const legacy = tmp('i-legacy'), ud = tmp('i-ud')
    makeLegacy(legacy, { sessions: 2 })
    const doFetch = await loginAs(mock)
    await assert.rejects(() => runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep }), (e) => e.kind === 'auth')
    await assert.rejects(() => runImport({ doFetch: (p, i) => fetch(mock.url + p, i), userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep }), (e) => e.kind === 'auth')
    mock.state.needsConsent = false
    assert.equal((await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })).status, 'done')
    await mock.close()
  })

  for (const mode of ['received', 'perConversation', 'receipt', 'messages']) {
    await t('突き合わせ：サーバーの応答が食い違う（' + mode + '）ときは完了にしない', async () => {
      const mock = await createMock({ corrupt: mode }); const legacy = tmp('j-legacy'), ud = tmp('j-ud')
      makeLegacy(legacy, { sessions: 3 })
      const doFetch = await loginAs(mock)
      await assert.rejects(() => runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep }), (e) => e.kind === 'verify')
      assert.equal(readReceipt(ud), null)
      await mock.close()
    })
  }

  await t('壊れたファイル・書きかけ(.tmp)は捨てず、バイト列ごと保管し、送信にも添える', async () => {
    const mock = await createMock(); const legacy = tmp('k-legacy'), ud = tmp('k-ud')
    makeLegacy(legacy, { sessions: 1, broken: true })
    const data = readLegacy([legacy])
    assert.equal(data.unreadable.length, 2); assert.equal(data.sessions.length, 1)
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r.receipt.unreadable.length, 2)
    for (const u of data.unreadable) assert.deepEqual(fs.readFileSync(path.join(ud, 'legacy-unreadable', u.sha256.slice(0, 32) + '.bin')), u.bytes)
    assert.equal(mock.bucket(mock.state.members[0].id).unreadable.filter((x) => x.hasBytes).length, 2)
    await mock.close()
  })

  await t('旧データが何もなくても、空の取り込みを送って受領される（空の受領書・APIキーは消せる）', async () => {
    const mock = await createMock(); const legacy = tmp('l-legacy'), ud = tmp('l-ud')
    fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ apiKey: 'sk-x', userName: '' }))
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r.status, 'done'); assert.equal(r.receipt.empty, true); assert.equal(mock.state.importCalls, 1)
    assert.equal(clearApiKeys([legacy]).length, 1)
    await mock.close()
  })

  await t('複数の場所に同じ会話があっても1本にまとめる（発言が多い方を採用）', async () => {
    const mock = await createMock(); const a = tmp('m-a'), b = tmp('m-b'), ud = tmp('m-ud')
    const exp = makeLegacy(a, { sessions: 2, messages: 2 })
    fs.mkdirSync(path.join(b, 'sessions'), { recursive: true })
    const id = exp.ids[0]
    const s = JSON.parse(fs.readFileSync(path.join(a, 'sessions', id + '.json'), 'utf8')); s.messages.push({ role: 'user', text: 'もう1通', at: s.updatedAt })
    fs.writeFileSync(path.join(b, 'sessions', id + '.json'), JSON.stringify(s))
    const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [a, b], sleep: noSleep })
    assert.equal(r.receipt.totals.conversations, 2); assert.equal(r.receipt.duplicates.length, 1)
    assert.equal(mockConv(mock).get(id).messages, 3)
    await mock.close()
  })

  // 旧アプリ本物の書き込みコード（アーカイブの sessions.js）で作った履歴を取り込む＝実データ形式の確認
  const archive = 'C:\\Users\\yamam\\Desktop\\_旧PCデスクトップ\\99_アーカイブ\\エスコワークス_旧版v0.3.4_Claude直結_2026-11-09'
  await t('実データ形式：旧アプリ本物の SessionStore/Recorder が書いた会話を取り込み、件数・発言数が完全一致', async () => {
    if (!fs.existsSync(path.join(archive, 'sessions.js'))) throw new Error('アーカイブの sessions.js が見つかりません')
    const { SessionStore, SessionRecorder } = require(path.join(archive, 'sessions.js'))
    const legacy = tmp('n-legacy'), ud = tmp('n-ud')
    const store = new SessionStore(path.join(legacy, 'sessions'))
    const rec = new SessionRecorder(store, () => {}, (e) => { throw e })
    const runner = { sessionId: 'sdk-1', sessionCwd: 'C:/work' }
    let expMsgs = 0, expConvs = 0
    for (let c = 0; c < 4; c++) {
      rec.use(store.create())
      rec.begin('質問 ' + c, ['chat', 'docs', 'files', 'chat'][c], c ? 'C:/work' : null)
      rec.event('agent:token', { delta: '回答' }, runner); rec.event('agent:token', { delta: 'です ' + c }, runner)
      rec.event('agent:tool', { tool: 'Read' }, runner)
      rec.event('agent:text', { text: '完成 ' + c }, runner)
      if (c === 3) rec.event('agent:error', { message: '一時的なエラー' }, runner)
      rec.finish(runner)
      expMsgs += rec.session.messages.length; expConvs++
    }
    // ゴミ箱・アーカイブ・ピン留めも旧アプリと同じ形で
    const list = store.list()
    const s0 = store.read(list[0].id); s0.deleted = true; store.save(s0)
    const s1 = store.read(list[1].id); s1.archived = true; s1.pinned = true; store.save(s1)
    fs.writeFileSync(path.join(legacy, 'settings.json'), JSON.stringify({ apiKey: 'sk-fake', userName: '山本光強' }))
    const mock = await createMock(); const doFetch = await loginAs(mock)
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [legacy], sleep: noSleep })
    assert.equal(r.receipt.totals.conversations, expConvs); assert.equal(r.receipt.totals.messages, expMsgs)
    assert.equal(mockConv(mock).size, expConvs)
    assert.equal([...mockConv(mock).values()].reduce((n, c) => n + c.messages, 0), expMsgs)
    console.log('   実形式: 会話', expConvs, '/ 発言', expMsgs, '（ゴミ箱・アーカイブ含む）')
    await mock.close()
  })

  await t('本物の userData（読み取りのみ・複製して使用）：件数を数え、取り込みが完全一致する', async () => {
    const real = path.join(process.env.APPDATA || '', 'esco-ai')
    const copy = tmp('real-copy')
    if (fs.existsSync(real)) for (const d of ['sessions', 'projects', 'business']) if (fs.existsSync(path.join(real, d))) fs.cpSync(path.join(real, d), path.join(copy, d), { recursive: true })
    const data = readLegacy([copy])
    const expConvs = data.sessions.length, expMsgs = data.sessions.reduce((n, s) => n + s.obj.messages.length, 0)
    const mock = await createMock(); const doFetch = await loginAs(mock); const ud = tmp('real-ud')
    const r = await runImport({ doFetch, userData: ud, deviceId: 'd', dirs: [copy], sleep: noSleep })
    assert.equal(r.receipt.totals.conversations, expConvs); assert.equal(r.receipt.totals.messages, expMsgs)
    assert.equal(mockConv(mock).size, expConvs)
    console.log('   このPCの本物の履歴: 会話', expConvs, '/ 発言', expMsgs, '/ プロジェクト', data.projects.length, '/ 読めないファイル', data.unreadable.length)
    await mock.close()
  })

  const failed = results.filter(([ok]) => !ok)
  console.log('\n取り込みテスト: ' + (results.length - failed.length) + '/' + results.length + ' 通過')
  process.exit(failed.length ? 1 : 0)
})()
