// テスト用のモックサーバー：設計書「取り込みAPI」の契約どおりに応答する（本物のサーバーには一切つながない）
const http = require('node:http')
const crypto = require('node:crypto')

function createMock(options = {}) {
  const st = {
    key: options.key || 'K'.repeat(32),
    members: options.members || [
      { id: '11111111-1111-4111-8111-111111111111', name: '山本 光強', department: null, inUse: false },
      { id: '22222222-2222-4222-8222-222222222222', name: '佐藤 花子', department: null, inUse: false },
      { id: '33333333-3333-4333-8333-333333333333', name: '佐藤 花子', department: null, inUse: false } // 同姓同名（複数一致の確認用）
    ],
    needsConsent: options.needsConsent === true,
    failFirst: options.failFirst || 0,        // 取り込みの最初のN回を 500 にする
    corrupt: options.corrupt || null,          // 'received' | 'perConversation' | 'receipt' | 'messages'
    limit: options.limit || 8 * 1024 * 1024,  // これより大きい本文は 413
    externalNav: options.externalNav === true,
    autoDownload: options.autoDownload === true,
    sessions: new Map(),                       // cookie -> memberId
    store: new Map(),                          // memberId -> { conversations: Map(legacyId -> {messages, raw?}), projects: Map, business, unreadable: [] }
    calls: [], importCalls: 0, maxBody: 0, loginCalls: 0,
    // エージェント：memberId -> { enabled, blocked, apiKey }。usage は受け取った報告
    agent: { members: options.agentMembers || {}, usage: [], configHeaders: [], usageFailFirst: options.usageFailFirst || 0, usageCalls: 0, blockAfterUsage: options.blockAfterUsage === true }
  }
  const userOf = (req) => {
    const m = /(?:^|;\s*)aichat_session=([^;]+)/.exec(req.headers.cookie || '')
    return m && st.sessions.has(m[1]) ? st.members.find((x) => x.id === st.sessions.get(m[1])) : null
  }
  const bucket = (id) => { if (!st.store.has(id)) st.store.set(id, { conversations: new Map(), projects: new Map(), business: null, unreadable: [] }); return st.store.get(id) }
  const send = (res, code, obj, headers = {}) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(obj)) }
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0
    req.on('data', (c) => { n += c.length; chunks.push(c) })
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes: n }))
    req.on('error', reject)
  })

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x')
    st.calls.push(req.method + ' ' + url.pathname)
    try {
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<!doctype html><html><head><meta charset="utf-8"><title>モックのタイトル</title></head><body><h1>ESCO Works mock</h1>' +
          (st.externalNav ? '<script>setTimeout(()=>{window.open("http://external.invalid/popup")},300);setTimeout(()=>{location.href="http://external.invalid/nav"},800);</script>' : '') +
          '<a id="dl" href="/api/documents/x">dl</a>' +
          (st.autoDownload ? '<script>setTimeout(()=>document.getElementById("dl").click(),400)</script>' : '') + '</body></html>')
      }
      if (req.method === 'GET' && (url.pathname === '/join')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>join</title><body>join page</body>') }
      if (req.method === 'GET' && url.pathname === '/api/documents/x') {
        res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': 'attachment; filename="proposal.pdf"' })
        return res.end(Buffer.from('%PDF-1.4 mock'))
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/join') {
        const b = JSON.parse((await readBody(req)).text || '{}')
        if (b.token !== st.key) return send(res, 404, { error: 'このリンクは使えません' })
        return send(res, 200, { tenant: { name: 'エスココーポレーション', appName: 'ESCO Works' }, members: st.members, current: null })
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/join/login') {
        st.loginCalls++
        const b = JSON.parse((await readBody(req)).text || '{}')
        if (b.token !== st.key) return send(res, 404, { error: 'bad key' })
        const m = st.members.find((x) => x.id === b.userId)
        if (!m) return send(res, 400, { error: '名前を選んでください' })
        if (m.inUse) return send(res, 409, { inUse: true, error: '使用中' })
        m.inUse = true
        const tok = crypto.randomBytes(24).toString('base64url')
        st.sessions.set(tok, m.id)
        // 本物は Max-Age 付き。ここでは「Cookie の期限を殻が延ばす」確認のため、あえて期限なし（セッションCookie）で返す
        return send(res, 200, { ok: true, name: m.name }, { 'set-cookie': 'aichat_session=' + tok + '; Path=/; HttpOnly; SameSite=Lax' + (options.cookieMaxAge ? '; Max-Age=' + options.cookieMaxAge : '') })
      }
      if (req.method === 'GET' && url.pathname === '/api/conversations') {
        const u = userOf(req)
        if (!u) return send(res, 401, { error: 'ログインしてください' })
        return send(res, 200, { user: { id: u.id, name: u.name, isAdmin: false, appName: 'ESCO Works' }, needsConsent: st.needsConsent, conversations: [], archived: [] })
      }
      if (req.method === 'POST' && url.pathname === '/api/import/legacy') {
        const { text, bytes } = await readBody(req)
        st.importCalls++
        st.maxBody = Math.max(st.maxBody, bytes)
        const u = userOf(req)
        if (!u) return send(res, 401, { error: 'ログインしてください' })
        if (st.needsConsent) return send(res, 403, { error: '同意が必要です', needsConsent: true })
        if (bytes > st.limit) return send(res, 413, { error: 'too large' })
        if (st.importCalls <= st.failFirst) return send(res, 500, { error: 'boom' })
        const b = JSON.parse(text)
        const bk = bucket(u.id)
        const out = { ok: true, received: { projects: 0, conversations: 0, messages: 0 }, created: { projects: 0, conversations: 0, messages: 0 }, skipped: { conversations: 0 }, perConversation: [] }
        for (const p of b.projects || []) { out.received.projects++; if (!bk.projects.has(p.legacyId)) { bk.projects.set(p.legacyId, p); out.created.projects++ } }
        for (const c of b.conversations || []) {
          out.received.conversations++
          out.received.messages += c.messages.length
          const kept = c.messages.filter((m) => m.role === 'user' || m.role === 'ai').length // 本物は user/assistant だけ画面用に保存（error は raw にのみ）
          const old = bk.conversations.get(c.legacyId)
          let state
          if (!old) { bk.conversations.set(c.legacyId, { messages: c.messages.length, shown: kept, raw: c.raw, title: c.title, deleted: c.deleted, archived: c.archived }); state = 'created'; out.created.conversations++; out.created.messages += c.messages.length }
          else if (c.partial) { old.messages += c.messages.length; old.shown += kept; state = 'updated' }
          else if (c.messages.length > old.messages) { old.messages = c.messages.length; old.shown = kept; state = 'updated' }
          else { state = 'skipped'; out.skipped.conversations++ }
          const total = bk.conversations.get(c.legacyId).messages
          out.perConversation.push({ legacyId: c.legacyId, messages: st.corrupt === 'messages' ? total + 1 : total, state, ...(c.partial ? { partial: c.partial } : {}) })
        }
        if (b.business) { bk.business = b.business; out.received.businessEntries = b.business.entries.length; out.received.businessJobs = Object.keys(b.business.jobs).length }
        for (const x of b.unreadable || []) bk.unreadable.push({ sha256: x.sha256, size: x.size, hasBytes: !!x.base64 })
        if (st.corrupt === 'received') out.received.conversations = Math.max(0, out.received.conversations - 1)
        if (st.corrupt === 'perConversation' && out.perConversation.length) out.perConversation.pop()
        return send(res, 200, out)
      }
      if (req.method === 'GET' && url.pathname === '/api/import/legacy/receipt') {
        const u = userOf(req)
        if (!u) return send(res, 401, { error: 'ログインしてください' })
        const bk = bucket(u.id)
        let convs = [...bk.conversations.entries()].map(([legacyId, v]) => ({ legacyId, messages: v.messages }))
        if (st.corrupt === 'receipt') convs = convs.slice(1)
        return send(res, 200, { ok: true, counts: { conversations: convs.length, projects: bk.projects.size }, conversations: convs, projects: [...bk.projects.keys()].map((legacyId) => ({ legacyId })) })
      }
      if (req.method === 'GET' && url.pathname === '/api/agent/config') {
        const u = userOf(req)
        if (!u) return send(res, 401, { error: 'ログインしてください' })
        st.agent.configHeaders.push({ shell: req.headers['x-esco-shell'] || null, origin: req.headers.origin || null, referer: req.headers.referer || null, site: req.headers['sec-fetch-site'] || null })
        // 本物と同じ：殻からの問い合わせ（x-esco-shell あり・ページ発でない）にだけ答える
        const site = req.headers['sec-fetch-site']
        if (req.headers['x-esco-shell'] !== '1' || req.headers.origin || req.headers.referer || (site && site !== 'none')) return send(res, 200, { enabled: false })
        const m = st.agent.members[u.id]
        if (!m || !m.enabled) return send(res, 200, { enabled: false })
        const key = !m.blocked && m.apiKey ? m.apiKey : null
        return send(res, 200, { enabled: true, blocked: !!m.blocked, ready: !!key, apiKey: key, userName: u.name, remainPct: m.blocked ? 0 : (m.remainPct ?? 100) })
      }
      if (req.method === 'POST' && url.pathname === '/api/agent/usage') {
        const u = userOf(req)
        if (!u) return send(res, 401, { error: 'ログインしてください' })
        st.agent.usageCalls++
        if (st.agent.usageCalls <= st.agent.usageFailFirst) return send(res, 500, { error: 'boom' })
        const m = st.agent.members[u.id]
        if (!m || !m.enabled) return send(res, 404, { error: '見つかりません' })
        const b = JSON.parse((await readBody(req)).text || '{}')
        const dup = st.agent.usage.some((x) => x.userId === u.id && x.runId === b.runId)
        if (!dup) st.agent.usage.push({ userId: u.id, ...b })
        if (st.agent.blockAfterUsage) m.blocked = true
        if (!dup) m.remainPct = Math.max(0, (m.remainPct ?? 100) - 42)
        return send(res, 200, { ok: true, added: !dup, blocked: !!m.blocked, remainPct: m.blocked ? 0 : m.remainPct })
      }
      send(res, 404, { error: 'not found' })
    } catch (e) {
      send(res, 500, { error: String(e && e.message) })
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const url = 'http://127.0.0.1:' + server.address().port
      resolve({ server, url, state: st, bucket, close: () => new Promise((r) => server.close(r)) })
    })
  })
}

// ログイン済みの人として使うための Cookie 付き fetch（Node 単体テスト用）
async function loginAs(mock, memberIndex = 0) {
  const m = mock.state.members[memberIndex]
  const res = await fetch(mock.url + '/api/auth/join/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: mock.state.key, userId: m.id }) })
  const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
  return (p, init = {}) => fetch(mock.url + p, { ...init, headers: { ...(init.headers || {}), cookie } })
}

module.exports = { createMock, loginAs }
