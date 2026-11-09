// テスト用の旧形式データ（旧 sessions.js / projects.js / business.js が書いていた形そのまま・架空の内容）
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const uuid = () => crypto.randomUUID()

function makeSession(i, { messages = 4, mode = 'chat', projectId = null, archived = false, deleted = false, pinned = false, long = 0 } = {}) {
  const id = uuid()
  const at = new Date(Date.UTC(2026, 9, 1 + (i % 28), 1, 2, 3)).toISOString()
  const msgs = []
  for (let k = 0; k < messages; k++) {
    const body = long ? 'あ'.repeat(long) : '架空の発言 ' + i + '-' + k
    msgs.push(k % 2 === 0 ? { role: 'user', text: body, at } : { role: 'ai', text: '架空の回答 ' + i + '-' + k, at })
  }
  return { id, title: '架空の会話 ' + i, createdAt: at, updatedAt: at, mode, workFolder: mode === 'chat' ? null : 'C:/work', sessionId: 'sdk-' + i, sessionCwd: null, messages: msgs, projectId, archived, deleted, pinned }
}

// dir 配下に sessions/ projects/ business/ settings.json を作る。戻り値：期待値
function makeLegacy(dir, opts = {}) {
  const n = opts.sessions ?? 5
  const exp = { conversations: 0, messages: 0, projects: 0, businessEntries: 0, businessJobs: 0, unreadable: 0, ids: [] }
  fs.mkdirSync(path.join(dir, 'sessions'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'projects'), { recursive: true })
  const proj = { id: uuid(), name: '架空の案件', folder: 'C:/work/案件', instructions: '丁寧な言葉で答えてください' }
  if (opts.projects !== 0) { fs.writeFileSync(path.join(dir, 'projects', proj.id + '.json'), JSON.stringify(proj)); exp.projects = 1 }
  for (let i = 0; i < n; i++) {
    const s = makeSession(i, {
      messages: opts.messages ?? (i % 3) + 2, mode: ['chat', 'docs', 'files'][i % 3],
      projectId: i === 1 && exp.projects ? proj.id : null, archived: i === 2, deleted: i === 3, pinned: i === 0, long: opts.long
    })
    if (opts.withError && i === 0) s.messages.push({ role: 'error', text: 'エラーの表示', at: s.updatedAt })
    fs.writeFileSync(path.join(dir, 'sessions', s.id + '.json'), JSON.stringify(s))
    exp.conversations++; exp.messages += s.messages.length; exp.ids.push(s.id)
  }
  if (opts.broken) {
    fs.writeFileSync(path.join(dir, 'sessions', uuid() + '.json'), '{ これは壊れたファイル')
    fs.writeFileSync(path.join(dir, 'sessions', uuid() + '.json.tmp'), JSON.stringify({ id: 'x', messages: [] }))
    exp.unreadable += 2
  }
  if (opts.business) {
    fs.mkdirSync(path.join(dir, 'business'), { recursive: true })
    const entries = [{ id: uuid(), at: '2026-10-01T00:00:00Z', text: '請求書を毎月作ります', sessionId: null, name: opts.business === true ? '山本 光強' : opts.business, staffId: 's1' }]
    const jobs = { j1: { id: 'j1', title: '請求書作成', facts: ['毎月'], unknown: [], ideas: [], updatedAt: '2026-10-02T00:00:00Z', sources: [entries[0].id] } }
    fs.writeFileSync(path.join(dir, 'business', 'state.json'), JSON.stringify({ entries, jobs, synced: {}, status: 'x' }))
    exp.businessEntries = 1; exp.businessJobs = 1
  }
  const settings = { apiKey: opts.apiKey === undefined ? 'sk-ant-TEST-FAKE-KEY' : opts.apiKey, userName: opts.userName ?? '', staffId: 'staff-1', businessFolder: '', enableBrowser: false, models: { chat: 'claude-sonnet-5-5' }, remote: { mode: 'off', enabled: false } }
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings, null, 2))
  return exp
}

// ディレクトリ内の全ファイルの {相対パス: sha256}
function snapshot(dir) {
  const out = {}
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else out[path.relative(dir, p)] = crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')
    }
  }
  walk(dir)
  return out
}

module.exports = { makeLegacy, makeSession, snapshot, uuid }
