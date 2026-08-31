// 配布用ビルドの前に cloudflared.exe（スマホ連携のトンネル用）を vendor/ へ取得する。
// バージョンとSHA256を固定し、改ざん・差し替えを検知する。gitには入れない（.gitignore済）。
// 更新するときは VERSION と SHA256 を新しいリリースの値に差し替えること。
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const VERSION = '2026.8.2'
const SHA256 = 'c29eee2b121f5436a642eed69fd9767da7e7b8c510fa50aaa130337f931357b5'
const URL = `https://github.com/cloudflare/cloudflared/releases/download/${VERSION}/cloudflared-windows-amd64.exe`
const LICENSE_URL = `https://raw.githubusercontent.com/cloudflare/cloudflared/${VERSION}/LICENSE`

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, 'vendor', 'cloudflared')
const exe = path.join(dir, 'cloudflared.exe')
const license = path.join(dir, 'LICENSE')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

fs.mkdirSync(dir, { recursive: true })

if (fs.existsSync(exe) && sha256(exe) === SHA256) {
  console.log(`[fetch-cloudflared] ok (cached ${VERSION})`)
} else {
  console.log(`[fetch-cloudflared] downloading ${VERSION} ...`)
  const res = await fetch(URL, { redirect: 'follow' })
  if (!res.ok) {
    console.error(`[fetch-cloudflared] download failed: HTTP ${res.status}`)
    process.exit(1)
  }
  fs.writeFileSync(exe, Buffer.from(await res.arrayBuffer()))
  const got = sha256(exe)
  if (got !== SHA256) {
    fs.rmSync(exe)
    console.error(`[fetch-cloudflared] SHA256 mismatch!\n  expected: ${SHA256}\n  got:      ${got}`)
    process.exit(1)
  }
  console.log('[fetch-cloudflared] downloaded and verified')
}

if (!fs.existsSync(license)) {
  const res = await fetch(LICENSE_URL, { redirect: 'follow' })
  if (res.ok) fs.writeFileSync(license, Buffer.from(await res.arrayBuffer()))
}
console.log('[fetch-cloudflared] done')
