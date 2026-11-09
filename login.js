// 初回の自動ログイン（社内公開リンクの名前一覧と照合）。
// doFetch(path, init) は Cookie を保持する fetch（アプリでは Electron の session.fetch）。
const { matchMember } = require('./nameMatch')

async function jsonOf(res) { try { return await res.json() } catch { return {} } }

// 戻り値 result:
//   logged_in   自動ログインできた（Cookie は doFetch の Cookie 入れに保存されている）
//   need_picker Web の名前選択画面へ（使用中・複数一致・不一致・名前なし）
//   bad_key     鍵が無効（Web のログイン画面へ）
//   no_key      鍵なし
//   error       通信エラー
async function autoLogin({ doFetch, key, names, log = () => {} }) {
  if (!key) return { result: 'no_key' }
  let res
  try {
    res = await doFetch('/api/auth/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: key }) })
  } catch (e) { return { result: 'error', detail: String(e && e.message || e) } }
  if (res.status === 404 || res.status === 400) return { result: 'bad_key' }
  if (!res.ok) return { result: 'error', detail: 'HTTP ' + res.status }
  const j = await jsonOf(res)
  const m = matchMember(names, j.members || [])
  log('[login] 照合: ' + m.kind + (m.candidates.length ? ' 候補' + m.candidates.length : ''))
  if (m.kind !== 'unique') return { result: 'need_picker', reason: m.kind }
  let r2
  try {
    r2 = await doFetch('/api/auth/join/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: key, userId: m.member.id }) })
  } catch (e) { return { result: 'error', detail: String(e && e.message || e) } }
  if (r2.status === 409) return { result: 'need_picker', reason: 'in_use' } // 照合のあとに使用中になった
  if (!r2.ok) return { result: 'need_picker', reason: 'login_' + r2.status }
  const j2 = await jsonOf(r2)
  return { result: 'logged_in', name: j2.name || m.member.name }
}

module.exports = { autoLogin }
