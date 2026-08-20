// ビルド時、exeパッケージ後にrceditでアイコンを埋め込む。
// signAndEditExecutable:false（winCodeSign回避）でもアイコンを付けるための処置。
// rceditは自前のrcedit.exeを同梱しており、シンボリックリンク/管理者権限を必要としない。
const path = require('path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const mod = require('rcedit')
  const rcedit = mod.rcedit || mod.default || mod
  const exe = path.join(context.appOutDir, 'ESCO Works.exe')
  const ico = path.join(__dirname, 'build', 'icon.ico')
  try {
    await rcedit(exe, { icon: ico })
    console.log('[afterPack] アイコンを埋め込みました: ' + exe)
  } catch (e) {
    console.log('[afterPack] アイコン埋め込み失敗（続行）: ' + (e && e.message))
  }
}
