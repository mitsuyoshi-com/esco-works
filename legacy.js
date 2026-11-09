// 旧エスコワークス（v0.3.x まで）のデータを読む。**読み取り専用**。元ファイルは書き換えない・消さない。
//   sessions/*.json   会話（アーカイブ済み・ゴミ箱も含む）。形式は旧 sessions.js の SessionStore
//   projects/*.json   プロジェクト（name・folder・instructions）
//   business/state.json  「私の業務を教える」（entries・jobs）
// 読めないファイル（壊れたJSON・形式違い・書きかけの .tmp）は捨てずに unreadable に集め、バイト列ごと保管する。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

function candidateDirs(userData, appData, extra = []) {
  const list = [userData, ...extra]
  if (appData) for (const n of ['esco-ai', 'ESCO Works', 'esco-works']) list.push(path.join(appData, n))
  const seen = new Set(), out = []
  for (const d of list) {
    if (!d) continue
    let key
    try { key = fs.realpathSync.native(d).toLowerCase() } catch { continue } // 無いフォルダは対象外
    if (seen.has(key)) continue
    seen.add(key); out.push(d)
  }
  return out
}

function listFiles(dir, re) {
  try { return fs.readdirSync(dir).filter((f) => re.test(f)).sort().map((f) => path.join(dir, f)) } catch { return [] }
}

const isoOr = (v, fallback) => (typeof v === 'string' && v ? v : fallback)

function readLegacy(dirs) {
  const out = { dirs, sessions: [], projects: [], business: null, unreadable: [], duplicates: [] }
  const byId = new Map()
  const projectById = new Map()
  const business = { entries: [], jobs: {}, files: [] }
  const seenEntry = new Set()

  for (const dir of dirs) {
    for (const file of listFiles(path.join(dir, 'sessions'), /\.json(\.tmp)?$/i)) {
      const bytes = fs.readFileSync(file)
      let obj = null
      if (!/\.tmp$/i.test(file)) { try { obj = JSON.parse(bytes.toString('utf8')) } catch { obj = null } }
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.messages)) {
        out.unreadable.push({ file, kind: 'session', size: bytes.length, sha256: sha(bytes), bytes })
        continue
      }
      const legacyId = (typeof obj.id === 'string' && obj.id) || path.basename(file).replace(/\.json$/i, '')
      const item = { legacyId, file, sha256: sha(bytes), obj }
      const old = byId.get(legacyId)
      if (old) {
        // 同じ会話が複数の場所にある：発言が多い方（同数なら更新が新しい方）を採用し、もう片方は記録に残す
        const better = obj.messages.length > old.obj.messages.length ||
          (obj.messages.length === old.obj.messages.length && isoOr(obj.updatedAt, '') > isoOr(old.obj.updatedAt, ''))
        out.duplicates.push({ legacyId, kept: better ? file : old.file, other: better ? old.file : file })
        if (better) byId.set(legacyId, item)
      } else byId.set(legacyId, item)
    }
    for (const file of listFiles(path.join(dir, 'projects'), /\.json(\.tmp)?$/i)) {
      const bytes = fs.readFileSync(file)
      let obj = null
      if (!/\.tmp$/i.test(file)) { try { obj = JSON.parse(bytes.toString('utf8')) } catch { obj = null } }
      if (!obj || typeof obj !== 'object' || typeof obj.name !== 'string') {
        out.unreadable.push({ file, kind: 'project', size: bytes.length, sha256: sha(bytes), bytes })
        continue
      }
      const legacyId = (typeof obj.id === 'string' && obj.id) || path.basename(file).replace(/\.json$/i, '')
      if (!projectById.has(legacyId)) projectById.set(legacyId, { legacyId, file, sha256: sha(bytes), obj })
      else out.duplicates.push({ legacyId, kept: projectById.get(legacyId).file, other: file })
    }
    const bf = path.join(dir, 'business', 'state.json')
    if (fs.existsSync(bf)) {
      const bytes = fs.readFileSync(bf)
      let st = null
      try { st = JSON.parse(bytes.toString('utf8')) } catch { st = null }
      if (!st || typeof st !== 'object') {
        out.unreadable.push({ file: bf, kind: 'business', size: bytes.length, sha256: sha(bytes), bytes })
      } else {
        business.files.push({ file: bf, sha256: sha(bytes) })
        for (const e of Array.isArray(st.entries) ? st.entries : []) {
          const k = e && e.id ? String(e.id) : JSON.stringify(e)
          if (!seenEntry.has(k)) { seenEntry.add(k); business.entries.push(e) }
        }
        for (const [id, j] of Object.entries(st.jobs && typeof st.jobs === 'object' ? st.jobs : {})) {
          const cur = business.jobs[id]
          if (!cur || isoOr(j && j.updatedAt, '') > isoOr(cur && cur.updatedAt, '')) business.jobs[id] = j
        }
      }
    }
  }
  out.sessions = [...byId.values()].sort((a, b) => a.legacyId.localeCompare(b.legacyId))
  out.projects = [...projectById.values()].sort((a, b) => a.legacyId.localeCompare(b.legacyId))
  if (business.files.length) out.business = business
  return out
}

// 設計書のAPI形式へ
function toConversation(s) {
  const o = s.obj
  const now = new Date(0).toISOString()
  return {
    legacyId: s.legacyId,
    title: typeof o.title === 'string' ? o.title : '',
    createdAt: isoOr(o.createdAt, isoOr(o.updatedAt, now)),
    updatedAt: isoOr(o.updatedAt, isoOr(o.createdAt, now)),
    archived: !!o.archived,
    deleted: !!o.deleted,
    pinned: !!o.pinned,
    projectLegacyId: typeof o.projectId === 'string' && o.projectId ? o.projectId : null,
    mode: typeof o.mode === 'string' ? o.mode : 'chat',
    messages: o.messages.map((m) => ({
      role: m && typeof m.role === 'string' ? m.role : 'error',
      text: m && typeof m.text === 'string' ? m.text : (m && m.text != null ? String(m.text) : ''),
      at: m && typeof m.at === 'string' ? m.at : isoOr(o.updatedAt, now)
    })),
    raw: o
  }
}

function toProject(p) {
  const o = p.obj
  return {
    legacyId: p.legacyId,
    name: o.name,
    instructions: typeof o.instructions === 'string' ? o.instructions : '',
    folder: typeof o.folder === 'string' ? o.folder : null,
    raw: o
  }
}

// 全体の指紋：取り込み対象（読めたもの・読めなかったもの）の内容が変わったか調べるため
function overallHash(data) {
  const parts = [
    ...data.sessions.map((s) => 's:' + s.legacyId + ':' + s.sha256),
    ...data.projects.map((p) => 'p:' + p.legacyId + ':' + p.sha256),
    ...(data.business ? data.business.files.map((f) => 'b:' + f.sha256).sort() : []),
    ...data.unreadable.map((u) => 'u:' + u.sha256).sort()
  ].sort()
  return sha(Buffer.from(parts.join('\n'), 'utf8'))
}

const countMessages = (c) => c.messages.length
const countNonError = (c) => c.messages.filter((m) => m.role === 'user' || m.role === 'ai' || m.role === 'assistant').length

module.exports = { candidateDirs, readLegacy, toConversation, toProject, overallHash, countMessages, countNonError, sha }
