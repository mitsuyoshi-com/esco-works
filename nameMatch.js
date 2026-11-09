// 旧設定から取り出した名前と、名簿（社内公開リンクの名前一覧）を照合する。
// 「正規化したうえで完全一致が1人だけ」のときだけ自動ログインする。
const fs = require('fs')
const path = require('path')

function normName(s) {
  return String(s == null ? '' : s).normalize('NFKC').replace(/[\s\u3000]+/g, '').toLowerCase()
}

// 名前一覧 members: [{id, name, inUse}]、旧名前 names: string[]
// 戻り値 kind: unique（自動ログイン可）／in_use（本人らしいが使用中）／multiple／none／no_names
function matchMember(names, members) {
  const set = new Set((names || []).map(normName).filter(Boolean))
  if (!set.size) return { kind: 'no_names', candidates: [] }
  const hit = (members || []).filter((m) => set.has(normName(m && m.name)))
  if (hit.length === 0) return { kind: 'none', candidates: [] }
  if (hit.length > 1) return { kind: 'multiple', candidates: hit }
  return { kind: hit[0].inUse ? 'in_use' : 'unique', member: hit[0], candidates: hit }
}

// 旧データのあるフォルダ群から、名前の候補を集める（読み取りのみ）。
//  ① settings.json の userName
//  ② workspace/account.bin（Windowsの資格情報で暗号化。旧アプリのさくら登録名）
//  ③ business/state.json の entries[].name
// decrypt(buffer) -> string は呼び出し側が渡す（Electron の safeStorage.decryptString）。
function extractNames(dirs, decrypt) {
  const names = []
  const add = (v) => { if (typeof v === 'string' && v.trim()) names.push(v.trim()) }
  for (const dir of dirs) {
    try { add(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).userName) } catch { /* なし */ }
    if (decrypt) {
      try {
        const cfg = JSON.parse(decrypt(fs.readFileSync(path.join(dir, 'workspace', 'account.bin'))))
        add(cfg && cfg.user && cfg.user.name)
        add(cfg && cfg.enrollment && cfg.enrollment.name)
      } catch { /* なし・復号できない */ }
    }
    try {
      const st = JSON.parse(fs.readFileSync(path.join(dir, 'business', 'state.json'), 'utf8'))
      for (const e of st.entries || []) add(e && e.name)
    } catch { /* なし */ }
  }
  return [...new Set(names)]
}

module.exports = { normName, matchMember, extractNames }
