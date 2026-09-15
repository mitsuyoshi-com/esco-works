const path = require('path')
const inside = (a,b) => { const r = path.relative(a,b); return !r || (!r.startsWith('..') && !path.isAbsolute(r)) }
class FolderQueue {
  constructor() { this.jobs = [] }
  request(folder) {
    if (!folder) return { wait: Promise.resolve(() => {}), cancel() {} }
    const job = { folder: path.resolve(folder), running: false }
    const wait = new Promise((resolve,reject) => { job.resolve = resolve; job.reject = reject })
    this.jobs.push(job)
    this.pump()
    return { wait, cancel: () => { if (job.running) return; this.jobs = this.jobs.filter(j => j !== job); job.reject(new Error('順番待ちを停止しました')); this.pump() } }
  }
  pump() {
    for (let i=0; i<this.jobs.length; i++) {
      const job = this.jobs[i]
      if (job.running || this.jobs.slice(0,i).some(j => inside(j.folder,job.folder) || inside(job.folder,j.folder))) continue
      job.running = true
      job.resolve(() => { this.jobs = this.jobs.filter(j => j !== job); this.pump() })
    }
  }
}
module.exports = { FolderQueue }
