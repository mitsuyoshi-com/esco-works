const fs = require('fs')
const path = require('path')
const { createHash, randomUUID } = require('crypto')
const hash = value => createHash('sha256').update(value).digest('hex')
const clean = value => String(value || '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || '未設定'
const START = '<!-- ESCO-AUTO-START -->'
const END = '<!-- ESCO-AUTO-END -->'

class BusinessStore {
  constructor(dir, config, changed = () => {}) {
    this.dir = dir; this.config = config; this.changed = changed; this.syncing = false
    fs.mkdirSync(dir, { recursive: true })
    this.file = path.join(dir, 'state.json')
    if (fs.existsSync(this.file)) this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'))
    else this.state = { entries: [], jobs: {}, synced: {}, status: '未設定' }
  }
  save() {
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.state), 'utf8')
    fs.renameSync(this.file + '.tmp', this.file)
    this.changed(this.status())
  }
  status() { return { status: this.state.status, entries: this.state.entries.length, jobs: Object.keys(this.state.jobs).length, lastSync: this.state.lastSync || null } }
  capture(text, sessionId) {
    const c = this.config()
    if (!String(c.userName || '').trim()) throw new Error('設定でお名前を登録してください')
    this.state.entries.push({ id: randomUUID(), at: new Date().toISOString(), text, sessionId, name: c.userName, staffId: c.staffId })
    this.state.status = 'PCに保存済み・整理中'
    this.state.needsOrganize = true
    this.save()
    return this.state.entries.at(-1).id
  }
  instructions() {
    const jobs = Object.values(this.state.jobs).map(j => ({ id: j.id, title: j.title }))
    return `この会話はスタッフ本人の業務の聞き取りです。仕事内容、頻度、手順、入力資料、成果物、判断基準、困りごと、所要時間を整理してください。本人が説明した事実だけをfactsに入れ、不明な点はunknown、AIの提案はideasに分離。既存業務は同じidを使い、既存の事実を落とさず追加・明示訂正を反映。細かい確認で入力を妨げず、必要な質問は本文で短く聞いてください。ファイル操作はしません。保存はアプリが行います。各回答の末尾に必ず次の形式のJSONコードブロックを1つ出力してください。更新が不要ならjobsは空配列。\n\`\`\`json\n{"escoBusiness":1,"jobs":[{"id":"既存idか新規なら空文字","title":"業務名","facts":["事実"],"unknown":["未確認"],"ideas":["AI提案"]}]}\n\`\`\`\n既存業務一覧:${JSON.stringify(jobs)}\n直近の整理内容:${JSON.stringify(Object.values(this.state.jobs)).slice(-50000)}`
  }
  integrate(text, entryId) {
    const blocks = [...text.matchAll(/```json\s*([\s\S]*?)```/g)]
    let parsed
    for (const block of blocks) { try { const v = JSON.parse(block[1]); if (v.escoBusiness === 1) parsed = v } catch {} }
    if (!parsed || !Array.isArray(parsed.jobs)) {
      this.state.status = '入力は保存済み・AI整理を再試行してください'; this.save(); return false
    }
    for (const j of parsed.jobs.slice(0, 30)) {
      if (typeof j.title !== 'string' || !j.title.trim()) continue
      const title = j.title.trim().slice(0, 120)
      const id = this.state.jobs[j.id] ? j.id : hash(title).slice(0, 16)
      const array = x => Array.isArray(x) ? x.filter(v => typeof v === 'string').map(v => v.slice(0, 8000)).slice(0, 150) : []
      const old = this.state.jobs[id]
      this.state.jobs[id] = { id, title, facts: array(j.facts), unknown: array(j.unknown), ideas: array(j.ideas),
        updatedAt: new Date().toISOString(), sources: [...new Set([...(old?.sources || []), entryId])],
        filename: old?.filename || `${clean(title)}_${id}.md` }
    }
    this.state.needsOrganize = false
    this.state.status = '共有フォルダへ保存待ち'; this.save(); return true
  }
  sync() {
    if (this.syncPromise) { this.syncAgain = true; return this.syncPromise }
    this.syncPromise = (async () => {
      do { this.syncAgain = false; await this.syncOnce() } while (this.syncAgain)
      return this.status()
    })().finally(() => { this.syncPromise = null })
    return this.syncPromise
  }
  async syncOnce() {
    this.syncing = true
    const c = this.config()
    try {
      if (!c.businessFolder) { this.state.status = '共有先未設定・PCに保存済み'; return this.status() }
      if (!c.userName || !c.staffId) { this.state.status = 'スタッフ未設定'; return this.status() }
      await fs.promises.access(c.businessFolder)
      const staffRoot = path.join(c.businessFolder, 'スタッフ', clean(c.staffId))
      await fs.promises.mkdir(path.join(staffRoot, '業務'), { recursive: true })
      const notes = this.state.entries.map(e => `## ${e.at}\n\n${e.text}\n`).join('\n')
      const files = { '入力記録.md': `# ${c.userName}さんの入力記録\n\n${notes}`,
        '業務一覧.md': `# ${c.userName}さんの業務一覧\n\n${Object.values(this.state.jobs).map(j => `- [${j.title.replace(/[\[\]]/g, '')}](業務/${encodeURIComponent(j.filename)})`).join('\n')}\n` }
      for (const j of Object.values(this.state.jobs)) files['業務/' + j.filename] =
        `# ${j.title}\n\n担当: ${c.userName}\n更新: ${j.updatedAt}\n\n## 本人の説明に基づく業務内容\n${j.facts.map(v => '- ' + v).join('\n') || '- 未確認'}\n\n## 未確認事項\n${j.unknown.map(v => '- ' + v).join('\n') || '- なし'}\n\n## AIによる改善案（未承認）\n${j.ideas.map(v => '- ' + v).join('\n') || '- なし'}\n`
      for (const [relative, body] of Object.entries(files)) {
        const target = path.join(staffRoot, relative)
        let old = ''
        try { old = await fs.promises.readFile(target, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
        const block = `${START}\n${body}\n${END}`
        const a = old.indexOf(START), b = old.indexOf(END)
        const oldBlock = a >= 0 && b > a ? old.slice(a, b + END.length) : old
        const key = hash(target)
        if (old && oldBlock !== block && this.state.synced[key] !== hash(oldBlock)) {
          throw new Error(`${relative} が他のPCまたは手動で変更されています。共有先の内容を確認してください`)
        }
        const next = a >= 0 && b > a ? old.slice(0, a) + block + old.slice(b + END.length) : block + '\n\n<!-- 手動追記はこの下へ。自動更新でも保持されます。 -->\n'
        if (old !== next) {
          if (old) {
            const backup = path.join(staffRoot, '_更新履歴', relative.replace(/[\/\\]/g, '_'))
            await fs.promises.mkdir(backup, { recursive: true })
            await fs.promises.writeFile(path.join(backup, `${Date.now()}-${randomUUID().slice(0, 8)}.md`), old, 'utf8')
          }
          const tmp = target + '.' + randomUUID() + '.tmp'
          await fs.promises.writeFile(tmp, next, 'utf8')
          await fs.promises.rename(tmp, target)
        }
        this.state.synced[key] = hash(block)
        this.save()
      }
      this.state.status = this.state.needsOrganize ? '入力記録は共有済み・AIによる整理待ち' : '共有フォルダに保存済み（クラウド同期はDriveが実行）'
      this.state.lastSync = new Date().toISOString()
    } catch (e) { this.state.status = `PCに保存済み・共有待ち: ${e.message}` }
    finally { this.syncing = false; this.save() }
    return this.status()
  }
}
module.exports = { BusinessStore }
