// Desktop conversation history. Files stay in Electron userData, outside the app/update directory.
const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')

class SessionStore {
  constructor(dir) {
    this.dir = dir
    fs.mkdirSync(dir, { recursive: true })
  }
  file(id) {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('無効なセッションです')
    return path.join(this.dir, `${id}.json`)
  }
  create() {
    const now = new Date().toISOString()
    return { id: randomUUID(), title: '新しい会話', createdAt: now, updatedAt: now,
      mode: 'chat', workFolder: null, sessionId: null, sessionCwd: null, messages: [], projectId: null, archived: false, deleted: false, pinned: false }
  }
  save(session) {
    const file = this.file(session.id)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(session), { encoding: 'utf8', mode: 0o600 })
    fs.renameSync(tmp, file)
  }
  read(id) {
    const session = JSON.parse(fs.readFileSync(this.file(id), 'utf8'))
    if (session.id !== id || !Array.isArray(session.messages)) throw new Error('履歴を読み込めませんでした')
    return session
  }
  list() {
    const items = []
    for (const file of fs.readdirSync(this.dir)) {
      if (!file.endsWith('.json')) continue
      try {
        const s = this.read(file.slice(0, -5))
        items.push({ id: s.id, title: s.title, updatedAt: s.updatedAt, mode: s.mode, workFolder: s.workFolder,
          projectId: s.projectId || null, archived: !!s.archived, deleted: !!s.deleted, pinned: !!s.pinned, kind: s.kind || 'chat' })
      } catch { /* A damaged entry must not hide the remaining history. */ }
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
}

// One recorder per window. Capture in main so closing/reloading the renderer cannot erase a turn.
class SessionRecorder {
  constructor(store, notify, onError) {
    this.store = store
    this.notify = notify
    this.onError = onError
    this.session = store.create()
    this.timer = null
    this.ai = null
  }
  use(session) {
    this.flush(true)
    this.session = session
    this.ai = null
  }
  begin(text, mode, workFolder) {
    const s = this.session
    const previous = { ...s, messages: [...s.messages] }
    s.mode = mode
    s.workFolder = workFolder
    if (!s.messages.length && !s.customTitle) s.title = text.replace(/\s+/g, ' ').slice(0, 60)
    s.messages.push({ role: 'user', text, at: new Date().toISOString() })
    this.ai = null
    this.touch()
    try { this.flush(true) }
    catch (error) { this.session = previous; throw error }
  }
  touch() { this.session.updatedAt = new Date().toISOString() }
  event(ev, payload, runner) {
    const s = this.session
    if (!s.messages.length) return
    s.sessionId = runner.sessionId || null
    s.sessionCwd = runner.sessionCwd || null
    if (ev === 'agent:token') {
      if (!this.ai) {
        this.ai = { role: 'ai', text: '', at: new Date().toISOString() }
        s.messages.push(this.ai)
      }
      this.ai.text += payload.delta
    } else if (ev === 'agent:text') {
      this.ai = { role: 'ai', text: payload.text, at: new Date().toISOString() }
      s.messages.push(this.ai)
    } else if (ev === 'agent:tool') {
      this.ai = null
    } else if (ev === 'agent:error') {
      s.messages.push({ role: 'error', text: payload.message, at: new Date().toISOString() })
      this.ai = null
    }
    this.touch()
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 500)
  }
  finish(runner) {
    this.session.sessionId = runner.sessionId || null
    this.session.sessionCwd = runner.sessionCwd || null
    this.ai = null
    this.flush()
  }
  flush(throwOnError = false) {
    clearTimeout(this.timer)
    this.timer = null
    if (!this.session.messages.length) return
    try {
      this.store.save(this.session)
      this.notify()
    } catch (error) {
      this.onError(error)
      if (throwOnError) throw error
    }
  }
}

module.exports = { SessionStore, SessionRecorder }
