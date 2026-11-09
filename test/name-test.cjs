// 名前の照合テスト（Node 単体）
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { matchMember, normName, extractNames } = require('../nameMatch.js')
const { autoLogin } = require('../login.js')
const { createMock } = require('./mock-server.cjs')

let pass = 0, fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('PASS ' + name) } catch (e) { fail++; console.log('FAIL ' + name + '\n   ' + (e && e.stack || e)) }
}
const M = (name, inUse = false, id = name) => ({ id, name, inUse, department: null })

;(async () => {
  await t('正規化：全角半角・空白（半角/全角）・大文字小文字の違いを吸収する', () => {
    assert.equal(normName('山本　光強'), normName('山本 光強'))
    assert.equal(normName('ＹＡＭＡＤＡ Taro'), normName('yamada  taro'))
    assert.equal(normName('ﾔﾏﾓﾄ ﾐﾂﾕｷ'), normName('ヤマモト ミツユキ'))
    assert.equal(normName(null), '')
  })
  await t('一致：1人だけ一致 → unique（空白違い・全角半角違いでも）', () => {
    const r = matchMember(['山本光強'], [M('山本 光強'), M('佐藤 花子')])
    assert.equal(r.kind, 'unique'); assert.equal(r.member.id, '山本 光強')
    assert.equal(matchMember(['ＹＡＭＡ　Ｔａｒｏ'], [M('yama taro'), M('佐藤')]).kind, 'unique')
  })
  await t('複数一致（同姓同名）→ multiple（自動ログインしない）', () => {
    assert.equal(matchMember(['佐藤花子'], [M('佐藤 花子', false, 'a'), M('佐藤 花子', false, 'b')]).kind, 'multiple')
  })
  await t('旧名前が2つあり別々の人に一致 → multiple', () => {
    assert.equal(matchMember(['山本光強', '佐藤花子'], [M('山本 光強'), M('佐藤 花子')]).kind, 'multiple')
  })
  await t('不一致 → none／名前なし → no_names', () => {
    assert.equal(matchMember(['鈴木一郎'], [M('山本 光強')]).kind, 'none')
    assert.equal(matchMember([], [M('山本 光強')]).kind, 'no_names')
    assert.equal(matchMember(['  ', ''], [M('山本 光強')]).kind, 'no_names')
  })
  await t('使用中（すでにほかの端末でログイン中）→ in_use（自動ログインしない）', () => {
    assert.equal(matchMember(['山本光強'], [M('山本 光強', true)]).kind, 'in_use')
  })
  await t('部分一致では自動ログインしない（山本 と 山本光強）', () => {
    assert.equal(matchMember(['山本'], [M('山本 光強')]).kind, 'none')
  })
  await t('旧データから名前を集める：settings.json／business の entries（account.bin は復号関数を渡したとき）', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'esco-name-'))
    fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ userName: '山本 光強' }))
    fs.mkdirSync(path.join(d, 'business')); fs.writeFileSync(path.join(d, 'business', 'state.json'), JSON.stringify({ entries: [{ name: '山本 光強' }, { name: '佐藤 花子' }] }))
    fs.mkdirSync(path.join(d, 'workspace')); fs.writeFileSync(path.join(d, 'workspace', 'account.bin'), 'ENC')
    const names = extractNames([d], (buf) => { assert.equal(buf.toString(), 'ENC'); return JSON.stringify({ user: { name: '宮崎 太郎' } }) })
    assert.deepEqual(names.sort(), ['佐藤 花子', '宮崎 太郎', '山本 光強'].sort())
    assert.deepEqual(extractNames([d], null).sort(), ['佐藤 花子', '山本 光強'].sort()) // 復号できない環境でも壊れない
    assert.deepEqual(extractNames([path.join(d, '無い')], null), [])
  })

  // 自動ログイン（モックの名前一覧と照合し、必要なら Cookie 付きでログイン）
  const jar = () => { let cookie = ''; return async (p, i = {}) => { const r = await fetch(mock.url + p, { ...i, headers: { ...(i.headers || {}), cookie } }); const c = r.headers.get('set-cookie'); if (c) cookie = c.split(';')[0]; return r } }
  let mock
  await t('自動ログイン：一致1人 → logged_in（その名前でログインしたことをサーバーが認識）', async () => {
    mock = await createMock(); const f = jar()
    const r = await autoLogin({ doFetch: f, key: mock.state.key, names: ['山本光強'] })
    assert.equal(r.result, 'logged_in'); assert.equal(mock.state.loginCalls, 1)
    assert.equal((await (await f('/api/conversations')).json()).user.name, '山本 光強')
    await mock.close()
  })
  await t('自動ログイン：同姓同名・不一致・使用中は need_picker（ログインを試さない）', async () => {
    for (const [names, setup, reason] of [[['佐藤花子'], null, 'multiple'], [['鈴木一郎'], null, 'none'], [['山本光強'], (m) => { m.state.members[0].inUse = true }, 'in_use'], [[], null, 'no_names']]) {
      mock = await createMock(); if (setup) setup(mock)
      const r = await autoLogin({ doFetch: jar(), key: mock.state.key, names })
      assert.equal(r.result, 'need_picker'); assert.equal(r.reason, reason); assert.equal(mock.state.loginCalls, 0)
      await mock.close()
    }
  })
  await t('自動ログイン：鍵なし → no_key／鍵が無効 → bad_key', async () => {
    mock = await createMock()
    assert.equal((await autoLogin({ doFetch: jar(), key: '', names: ['山本光強'] })).result, 'no_key')
    assert.equal((await autoLogin({ doFetch: jar(), key: 'x'.repeat(40), names: ['山本光強'] })).result, 'bad_key')
    await mock.close()
  })
  await t('自動ログイン：照合のあと別の端末に先に使われた（409）→ need_picker', async () => {
    mock = await createMock()
    const f = jar()
    // 一覧を取ったあと、ログインの前に、別の端末が同じ名前を使い始めた状況
    const wrapped = async (p, i) => { const r = await f(p, i); if (p === '/api/auth/join') mock.state.members[0].inUse = true; return r }
    const r = await autoLogin({ doFetch: wrapped, key: mock.state.key, names: ['山本光強'] })
    assert.equal(r.result, 'need_picker'); assert.equal(r.reason, 'in_use')
    await mock.close()
  })
  await t('自動ログイン：通信エラー → error', async () => {
    const r = await autoLogin({ doFetch: async () => { throw new Error('ECONNREFUSED') }, key: 'k'.repeat(30), names: ['a'] })
    assert.equal(r.result, 'error')
  })

  console.log('\n名前照合テスト: ' + pass + '/' + (pass + fail) + ' 通過')
  process.exit(fail ? 1 : 0)
})()
