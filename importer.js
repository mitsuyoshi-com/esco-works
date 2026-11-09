// 旧エスコワークスの履歴を新方式へ取り込む（設計書 docs/03_ESCOWorks移行設計_20261109.md の契約どおり）。
//  ・元ファイルは消さない。送るのは読み取った内容のコピーだけ。
//  ・分割送信（1回 ~6MB。サーバー上限は8MB）。何度送っても同じ結果（冪等：legacyId が同じなら重複しない）。
//  ・サーバーの応答の件数と手元の件数を突き合わせ、さらに受領確認（GET）で全会話が届いたか確かめる。
//    一つでも合わなければ完了にしない（例外を投げる）。呼び出し側が次回起動時に再試行する。
//  ・読めなかったファイルは捨てず、バイト列を userData/legacy-unreadable/ に保管し、送信にも添える。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { readLegacy, toConversation, toProject, overallHash, countMessages, countNonError } = require('./legacy')

class ImportError extends Error {
  constructor(kind, message) { super(message); this.kind = kind } // auth | verify | network | server
}

const RECEIPT = 'legacy-import-receipt.json'
const MAX_UNREADABLE_B64 = 4 * 1024 * 1024
const bytesOf = (o) => Buffer.byteLength(JSON.stringify(o), 'utf8')
const OK_STATES = new Set(['created', 'skipped', 'updated'])

function atomicWrite(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file + '.tmp', text, 'utf8')
  fs.renameSync(file + '.tmp', file)
}

function readReceipt(userData) {
  try { return JSON.parse(fs.readFileSync(path.join(userData, RECEIPT), 'utf8')) } catch { return null }
}

// 読めなかったファイルのコピーを保管（同じ内容は上書きしない）
function keepUnreadable(userData, unreadable) {
  if (!unreadable.length) return
  const dir = path.join(userData, 'legacy-unreadable')
  fs.mkdirSync(dir, { recursive: true })
  for (const u of unreadable) {
    const f = path.join(dir, u.sha256.slice(0, 32) + '.bin')
    if (!fs.existsSync(f)) fs.writeFileSync(f, u.bytes)
  }
  const idx = unreadable.map((u) => ({ file: u.file, kind: u.kind, size: u.size, sha256: u.sha256 }))
  atomicWrite(path.join(dir, 'index.json'), JSON.stringify(idx, null, 2))
}

// 大きすぎる1会話は、発言を分けて送る（raw は最初の1通だけ・発言を除いた形）
function splitConversation(c, max) {
  const chunks = []
  let cur = [], size = 0
  const room = Math.max(1024, Math.floor(max / 2))
  for (const m of c.messages) {
    const s = bytesOf(m)
    if (cur.length && size + s > room) { chunks.push(cur); cur = []; size = 0 }
    cur.push(m); size += s
  }
  if (cur.length || !chunks.length) chunks.push(cur)
  const { messages: _omit, ...rawRest } = c.raw
  return chunks.map((messages, i) => ({
    ...c, messages,
    raw: i === 0 ? { ...rawRest, _messagesOmittedFromRaw: true, _messageCount: c.messages.length } : null,
    partial: { index: i, total: chunks.length }
  }))
}

function buildBatches(data, max) {
  const batches = []
  const fresh = () => ({ projects: [], conversations: [], unreadable: [], business: null, size: 200 })
  let cur = fresh()
  const nonEmpty = (b) => b.projects.length || b.conversations.length || b.unreadable.length || b.business
  const push = (field, item) => {
    const s = bytesOf(item) + 2
    if (s + cur.size > max && nonEmpty(cur)) { batches.push(cur); cur = fresh() }
    if (field === 'business') cur.business = item
    else cur[field].push(item)
    cur.size += s
  }
  if (data.business) push('business', { entries: data.business.entries, jobs: data.business.jobs })
  for (const p of data.projects) push('projects', toProject(p))
  for (const s of data.sessions) {
    const c = toConversation(s)
    if (bytesOf(c) + 200 > max) for (const part of splitConversation(c, max)) push('conversations', part)
    else push('conversations', c)
  }
  for (const u of data.unreadable) {
    push('unreadable', {
      file: u.file, kind: u.kind, size: u.size, sha256: u.sha256,
      base64: u.size <= MAX_UNREADABLE_B64 ? u.bytes.toString('base64') : null
    })
  }
  if (nonEmpty(cur) || !batches.length) batches.push(cur)
  return batches
}

async function postBatch({ doFetch, deviceId, batch, index, total, retries, sleep, log }) {
  const body = {
    source: 'pc', deviceId, batch: { index, total },
    projects: batch.projects, conversations: batch.conversations, unreadable: batch.unreadable,
    ...(batch.business ? { business: batch.business } : {})
  }
  const text = JSON.stringify(body)
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) await sleep(Math.min(30000, 1500 * 2 ** (attempt - 1)))
    let res
    try {
      res = await doFetch('/api/import/legacy', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text })
    } catch (e) { lastErr = new ImportError('network', '通信できませんでした: ' + (e && e.message || e)); continue }
    if (res.status === 401 || res.status === 403) throw new ImportError('auth', 'ログインまたは同意が済んでいません（HTTP ' + res.status + '）')
    if (res.status === 413) { const e = new ImportError('server', '1回の送信が大きすぎます'); e.tooLarge = true; throw e }
    if (res.status >= 500 || res.status === 429) { lastErr = new ImportError('server', 'サーバーが一時的に応答できません（HTTP ' + res.status + '）'); continue }
    let j
    try { j = await res.json() } catch { throw new ImportError('verify', '取り込みの応答を読めませんでした（HTTP ' + res.status + '）') }
    if (!res.ok || !j || j.ok !== true) throw new ImportError('verify', '取り込みが受け付けられませんでした（HTTP ' + res.status + '）: ' + String((j && j.error) || '').slice(0, 200))
    log('[import] バッチ ' + (index + 1) + '/' + total + ' 受領')
    return j
  }
  throw lastErr || new ImportError('network', '送信に失敗しました')
}

// 1バッチの応答を手元の件数と突き合わせる
function verifyBatch(batch, j) {
  const r = j.received || {}
  const sentMsgs = batch.conversations.reduce((n, c) => n + countMessages(c), 0)
  const expect = { projects: batch.projects.length, conversations: batch.conversations.length, messages: sentMsgs }
  for (const k of Object.keys(expect)) {
    if (r[k] !== expect[k]) throw new ImportError('verify', '件数が合いません（' + k + ': 送信 ' + expect[k] + ' / 受領 ' + r[k] + '）')
  }
  if (batch.business) {
    const ne = batch.business.entries.length, nj = Object.keys(batch.business.jobs).length
    if (r.businessEntries !== ne) throw new ImportError('verify', '業務メモの件数が合いません（送信 ' + ne + ' / 受領 ' + r.businessEntries + '）')
    if (r.businessJobs !== nj) throw new ImportError('verify', '業務の整理結果の件数が合いません（送信 ' + nj + ' / 受領 ' + r.businessJobs + '）')
  }
  const per = j.perConversation || []
  for (const c of batch.conversations) {
    const e = per.find((x) => x.legacyId === c.legacyId && (!c.partial || !x.partial || x.partial.index === c.partial.index)) || per.find((x) => x.legacyId === c.legacyId)
    if (!e || !OK_STATES.has(e.state)) throw new ImportError('verify', '会話が受領されていません: ' + c.legacyId)
    if (!c.partial && e.messages !== countMessages(c) && e.messages !== countNonError(c)) {
      throw new ImportError('verify', '発言数が合いません（会話 ' + c.legacyId + ': 送信 ' + countMessages(c) + ' / 受領 ' + e.messages + '）')
    }
  }
}

// 受領確認：本人の取り込み済み legacyId 一覧に、送った会話・プロジェクトが全部あるか
async function crossCheck({ doFetch, deviceId, sent }) {
  let res
  try { res = await doFetch('/api/import/legacy/receipt?deviceId=' + encodeURIComponent(deviceId), { method: 'GET' }) }
  catch (e) { throw new ImportError('network', '受領確認に通信できませんでした: ' + (e && e.message || e)) }
  if (res.status === 401 || res.status === 403) throw new ImportError('auth', '受領確認でログインを確認できませんでした')
  if (!res.ok) throw new ImportError('verify', '受領確認を取得できませんでした（HTTP ' + res.status + '）')
  let j
  try { j = await res.json() } catch { throw new ImportError('verify', '受領確認の応答を読めませんでした') }
  const idsOf = (v) => (Array.isArray(v) ? v : [])
    .map((x) => (typeof x === 'string' ? { id: x } : { id: x && (x.legacyId || x.legacy_id || x.id), messages: x && x.messages }))
    .filter((x) => typeof x.id === 'string')
  const convs = new Map(idsOf(j.conversations || j.legacyIds || j.ids).map((x) => [x.id, x]))
  const projs = new Set(idsOf(j.projects).map((x) => x.id))
  // 送ったものが1件でもあるなら、ID単位の一覧が必ず要る（件数だけでは「完了」にしない）
  if (sent.conversations.size && !convs.size) throw new ImportError('verify', '受領確認に会話の一覧がありません')
  if (sent.projects.size && !projs.size) throw new ImportError('verify', '受領確認にプロジェクトの一覧がありません')
  for (const c of sent.conversations.values()) {
    const got = convs.get(c.legacyId)
    if (!got) throw new ImportError('verify', '受領確認に会話がありません: ' + c.legacyId)
    if (typeof got.messages !== 'number') throw new ImportError('verify', '受領確認に発言数がありません: ' + c.legacyId)
    if (got.messages !== c.total && got.messages !== c.nonError) {
      throw new ImportError('verify', '受領確認の発言数が合いません（会話 ' + c.legacyId + ': 送信 ' + c.total + ' / 受領 ' + got.messages + '）')
    }
  }
  for (const p of sent.projects) if (!projs.has(p)) throw new ImportError('verify', 'プロジェクトが受領確認にありません: ' + p)
  return j
}

async function runImport({ doFetch, userData, deviceId, dirs, log = () => {}, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), maxBatchBytes = 6 * 1024 * 1024, retries = 3, now = () => new Date() }) {
  const data = readLegacy(dirs)
  const hash = overallHash(data)
  keepUnreadable(userData, data.unreadable)

  const prev = readReceipt(userData)
  const empty = !data.sessions.length && !data.projects.length && !data.business && !data.unreadable.length
  if (prev && prev.complete && prev.overallSha256 === hash) return { status: 'already', receipt: prev }

  // 取り込み対象が1つもなくても、空の取り込みを送って「この端末は確認済み」と記録してもらう
  let max = maxBatchBytes, batches, responses
  for (let shrink = 0; ; shrink++) {
    batches = buildBatches(data, max)
    responses = []
    try {
      for (let i = 0; i < batches.length; i++) {
        const j = await postBatch({ doFetch, deviceId, batch: batches[i], index: i, total: batches.length, retries, sleep, log })
        verifyBatch(batches[i], j)
        responses.push(j)
      }
      break
    } catch (e) {
      if (e.tooLarge && shrink < 6) { max = Math.floor(max / 2); log('[import] 分割を細かくして再送します'); continue }
      throw e
    }
  }

  const sent = { conversations: new Map(), projects: [] }
  for (const b of batches) {
    for (const p of b.projects) sent.projects.push(p.legacyId)
    for (const c of b.conversations) {
      const s = sent.conversations.get(c.legacyId) || { legacyId: c.legacyId, total: 0, nonError: 0 }
      s.total += countMessages(c); s.nonError += countNonError(c)
      sent.conversations.set(c.legacyId, s)
    }
  }
  const server = await crossCheck({ doFetch, deviceId, sent })

  const totals = {
    projects: data.projects.length, conversations: data.sessions.length,
    messages: data.sessions.reduce((n, s) => n + s.obj.messages.length, 0),
    businessEntries: data.business ? data.business.entries.length : 0,
    businessJobs: data.business ? Object.keys(data.business.jobs).length : 0,
    unreadable: data.unreadable.length, batches: batches.length
  }
  const receipt = {
    version: 1, complete: true, completedAt: now().toISOString(), deviceId, source: 'pc',
    overallSha256: hash, empty, totals,
    conversations: data.sessions.map((s) => ({ legacyId: s.legacyId, messages: s.obj.messages.length, sha256: s.sha256, file: s.file })),
    projects: data.projects.map((p) => ({ legacyId: p.legacyId, sha256: p.sha256, file: p.file })),
    unreadable: data.unreadable.map((u) => ({ file: u.file, kind: u.kind, size: u.size, sha256: u.sha256 })),
    duplicates: data.duplicates, dirs,
    server: { created: responses.map((r) => r.created || null), skipped: responses.map((r) => r.skipped || null), receiptCounts: server.counts || null }
  }
  atomicWrite(path.join(userData, RECEIPT), JSON.stringify(receipt, null, 2))
  return { status: 'done', receipt }
}

// 旧APIキーを消す。受領確認まで完了したあとにだけ呼ぶ。他の設定は残す。戻り値＝消したファイル
function clearApiKeys(dirs) {
  const cleared = []
  for (const dir of dirs) {
    const f = path.join(dir, 'settings.json')
    let s
    try { s = JSON.parse(fs.readFileSync(f, 'utf8')) } catch { continue }
    if (s && typeof s.apiKey === 'string' && s.apiKey) {
      s.apiKey = ''
      atomicWrite(f, JSON.stringify(s, null, 2))
      cleared.push(f)
    }
  }
  return cleared
}

function deviceIdFor(userData) {
  const f = path.join(userData, 'device-id.txt')
  try { const v = fs.readFileSync(f, 'utf8').trim(); if (/^[a-f0-9-]{36}$/.test(v)) return v } catch { /* 新規 */ }
  const id = crypto.randomUUID()
  fs.mkdirSync(userData, { recursive: true })
  fs.writeFileSync(f, id, 'utf8')
  return id
}

module.exports = { runImport, clearApiKeys, deviceIdFor, readReceipt, ImportError, RECEIPT, buildBatches }
