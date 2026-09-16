// Account workspace client. Only the main process holds the login token.
const fs = require('fs'), path = require('path'), { randomUUID } = require('crypto')
class WorkspaceClient {
  constructor({ dir, encrypt, decrypt, createRunner, changed = () => {} }) {
    this.dir = dir; this.encrypt = encrypt; this.decrypt = decrypt; this.createRunner = createRunner; this.changed = changed
    fs.mkdirSync(dir, { recursive: true }); this.config = {}; this.active = null; this.pending = []; this.folders = {}; this.stopped = false
    try { this.config = JSON.parse(decrypt(fs.readFileSync(path.join(dir, 'account.bin')))) } catch {}
    try { this.folders = JSON.parse(fs.readFileSync(path.join(dir, 'folders.json'), 'utf8')) } catch {}
  }
  save() { const f = path.join(this.dir, 'account.bin'); fs.writeFileSync(f + '.tmp', this.encrypt(JSON.stringify(this.config))); fs.renameSync(f + '.tmp', f) }
  async api(action, body = {}) {
    if (!this.config.url) throw Error('同期サーバーのURLを設定してください')
    const r = await fetch(this.config.url + '/api.php', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(action === 'work.run' ? 125000 : 25000), headers: { 'Content-Type': 'application/json', ...(this.config.token ? { Authorization: 'Bearer ' + this.config.token } : {}) }, body: JSON.stringify({ action, ...body, ...(this.config.token ? { _accessToken: this.config.token } : {}) }) })
    let j; try { j = await r.json() } catch { throw Error('同期サーバーの応答を確認できませんでした') }
    if (!r.ok) { const e = Error(j.error || '同期に失敗しました'); e.status = r.status; throw e } return j
  }
  async login({ url, email, password }) {
    const u = new URL(url); if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname))) throw Error('HTTPSのURLを指定してください')
    if (u.username || u.password || u.search || u.hash) throw Error('サーバーURLが不正です')
    if (this.active) throw Error('実行中の作業を停止してから切り替えてください')
    const old = this.config; this.config = { url: u.href.replace(/\/$/, '') }
    try { const r = await this.api('login', { email, password, desktop: true }); this.config = { ...this.config, token: r.token, user: r.user, pcId: old.url === this.config.url && old.user?.id === r.user.id ? old.pcId : randomUUID() }; if (old.user?.id !== r.user.id || old.url !== this.config.url) { this.folders = {}; this.pending = []; fs.writeFileSync(path.join(this.dir, 'folders.json'), '{}') } this.save(); this.start(); return { user: r.user } }
    catch (e) { this.config = old; throw e }
  }
  async logout() {
    if (this.active) throw Error('実行中の作業を停止してからログアウトしてください')
    try { await this.api('logout') } catch(e) { if(e.status!==401)throw e } this.stop(); this.config = {}; this.save(); this.changed()
  }
  async enroll({ url = 'https://esco-corp.sakura.ne.jp/esco-works', name, adminInvite } = {}) {
    if (this.config.token) return { status: 'approved', user: this.config.user }
    const u = new URL(url)
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && ['127.0.0.1','localhost'].includes(u.hostname))) throw Error('HTTPSのURLを指定してください')
    if (u.username || u.password || u.search || u.hash) throw Error('サーバーURLが不正です')
    url = u.href.replace(/\/$/, '')
    if (this.config.enrollment && this.config.url !== url) throw Error('申請済みの接続先を使用してください')
    this.config = { ...this.config, url, pcId: this.config.pcId || randomUUID(), enrollment: this.config.enrollment || { secret: require('crypto').randomBytes(32).toString('hex'), name } }
    this.save() // Persist the key before submitting; retries/restarts use the same identity.
    const r = await this.api('device.enroll', { ...this.config.enrollment, pcName: require('os').hostname(), desktop: true, ...(adminInvite ? { adminInvite } : {}) })
    if (r.token) { this.config.token = r.token; this.config.user = r.user; delete this.config.enrollment; this.save(); this.start() }
    return { status: r.status, user: r.user }
  }
  status() { return { url: this.config.url || '', user: this.config.user || null, connected: !!this.config.token, error: this.error || '', folders: this.folders } }
  bind(projectId, folder) { this.folders[projectId || '_default'] = folder; fs.writeFileSync(path.join(this.dir, 'folders.json'), JSON.stringify(this.folders)); return this.status() }
  start() { this.stopped = false; clearTimeout(this.timer); if (this.config.token) this.tick() }
  stop() { this.stopped = true; clearTimeout(this.timer); this.active?.runner.interrupt() }
  async tick() {
    if (this.polling || this.stopped) return; this.polling = true
    try {
      while (this.pending.length) {
        const event = this.pending[0]
        try { await this.api('pc.event', event); this.pending.shift() }
        catch (e) {
          if (![403,404,409].includes(e.status)) throw e
          const lost = this.pending.filter(p => p.taskId === event.taskId)
          fs.appendFileSync(path.join(this.dir, 'interrupted-events.jsonl'), JSON.stringify({at:new Date().toISOString(),events:lost}) + '\n')
          this.pending = this.pending.filter(p => p.taskId !== event.taskId)
          if (this.active?.id === event.taskId) { this.active.lost = true; this.active.runner.interrupt() }
        }
      }
      const data = await this.api('pc.poll', { pcId: this.config.pcId, name: require('os').hostname(), active: this.active?.id || null, accept: !this.active, projects: Object.keys(this.folders) })
      if (data.cancel && this.active) this.active.runner.interrupt()
      for (const a of data.answers || []) { if (this.active && a.taskId === this.active.id) { if (a.kind === 'permission') this.active.runner.respondPermission(a.requestId, a.approved, false); else this.active.runner.respondChoice(a.requestId, a.answer) } }
      if (data.task && !this.active) this.execute(data.task)
      const snapshot = await this.api('bootstrap'); const file = path.join(this.dir, 'cache.json'); fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot)); fs.renameSync(file + '.tmp', file)
      this.error = ''; this.changed()
    } catch (e) { this.error = e.message; if (e.status === 401) { this.active?.runner.interrupt(); this.stopped = true } }
    finally { this.polling = false; if (!this.stopped) this.timer = setTimeout(() => this.tick(), 2500) }
  }
  async execute(task) {
    const folder = this.folders[task.projectId || '_default']; let failed = false, seq = 0
    const push = (ev, payload) => { if (this.active?.lost) return; this.pending.push({ pcId: this.config.pcId, taskId: task.id, lease: task.lease, seq: ++seq, ev, payload }) }
    const runner = this.createRunner((ev, payload) => { if (ev === 'agent:done') return; if (ev === 'agent:error') failed = true; push(ev, payload) })
    this.active = { id: task.id, runner }
    try {
      if (!folder || !fs.existsSync(folder)) throw Error('このPCでプロジェクトの作業フォルダを指定してください')
      // Folder is selected on this PC, never accepted from the mobile request.
      await runner.startTurn({ text: task.text, history: task.history || [], systemInstructions: task.instructions || '', mode: 'chat', workFolder: folder, cwd: folder, autoApprove: false, permMode: 'normal' })
      push('task:finished', { failed })
    } catch (e) { push('agent:error', { message: e.message }); push('task:finished', { failed: true }) }
    finally { this.active = null }
  }
}
module.exports = { WorkspaceClient }
