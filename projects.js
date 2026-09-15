const fs = require('fs')
const path = require('path')
const { randomUUID } = require('crypto')
class ProjectStore {
  constructor(dir) { this.dir = dir; fs.mkdirSync(dir, { recursive: true }) }
  file(id) {
    if (!/^[a-f0-9-]{36}$/.test(id || '')) throw new Error('プロジェクトが不正です')
    return path.join(this.dir, id + '.json')
  }
  list() {
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json')).flatMap(f => {
      try { return [JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'))] } catch { return [] }
    })
  }
  get(id) { return JSON.parse(fs.readFileSync(this.file(id), 'utf8')) }
  save(input) {
    const old = input.id ? this.get(input.id) : { id: randomUUID() }
    const name = String(input.name || '').trim().slice(0, 100)
    if (!name) throw new Error('プロジェクト名を入力してください')
    const project = { ...old, name, folder: input.folder || null, instructions: String(input.instructions || '').slice(0, 20000) }
    const file = this.file(project.id)
    fs.writeFileSync(file + '.tmp', JSON.stringify(project), 'utf8')
    fs.renameSync(file + '.tmp', file)
    return project
  }
}
module.exports = { ProjectStore }
