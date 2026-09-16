// Local-only window and IPC boundary for the synchronized workspace.
const { BrowserWindow, ipcMain, dialog, app, safeStorage } = require('electron')
const path = require('path'), fs = require('fs')
const { WorkspaceClient } = require('./workspaceClient')
const { AgentRunner } = require('./agent')
function setupWorkspace({ getSettings, folderQueue, sessions, projects, recordUsage }) {
 const views = new Set(); const client = new WorkspaceClient({ dir: path.join(app.getPath('userData'), 'workspace'),
  encrypt: text => { if (!safeStorage.isEncryptionAvailable()) throw Error('Windowsの資格情報暗号化を利用できません'); return safeStorage.encryptString(text) },
  decrypt: bytes => safeStorage.decryptString(bytes),
  createRunner: emit => {
   const runner = new AgentRunner({ getSettings, emit: (ev,p) => { if(ev==='agent:done' && p.costUsd)recordUsage(p.costUsd); emit(ev,p) } })
   return { startTurn: async args => { const lock=folderQueue.request(args.workFolder); runner.cancelQueue=lock.cancel; const release=await lock.wait; runner.cancelQueue=null;try { await runner.startTurn(args) }finally{release()} }, interrupt:()=>{runner.cancelQueue?.();runner.interrupt()}, respondPermission:(...a)=>runner.respondPermission(...a),respondChoice:(...a)=>runner.respondChoice(...a) }
  }
 })
 const allowed = new Set(['drive.configure','invite.issue','bootstrap','session.get','session.create','session.update','session.purge','project.save','chat.send','task.answer','task.cancel','pair.issue','business.retry','work.run'])
 ipcMain.handle('workspace:request',async(e,action,body={})=>{
  if(!views.has(e.sender.id))throw Error('この画面では利用できません')
  if(action==='status')return client.status()
  if(action==='login')return client.login(body)
  if(action==='logout')return client.logout()
  if(action==='bind') { const r=await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender),{title:'このプロジェクトを実行するPCフォルダ',properties:['openDirectory']});if(!r.canceled)return client.bind(body.projectId,r.filePaths[0]);return client.status() }
  if(action==='qr'){const r=await client.api('pair.issue');const url=client.config.url+'/#pair='+r.code;return {url,image:await require('qrcode').toDataURL(url),expiresIn:r.expiresIn}}
  if(action==='import') {const result=[];for(const x of sessions.list()){const s=sessions.read(x.id);result.push(await client.api('session.import',{source:s.id,session:s,project:projects.list().find(p=>p.id===s.projectId)||null,opId:require('crypto').randomUUID()}));}return {count:result.length} }
  if(!allowed.has(action))throw Error('未対応の操作です')
  return client.api(action,body)
 })
 function open(){const w=new BrowserWindow({width:1280,height:850,minWidth:760,minHeight:550,webPreferences:{preload:path.join(__dirname,'cloudPreload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}});const id=w.webContents.id;views.add(id);w.on('closed',()=>views.delete(id));w.webContents.setWindowOpenHandler(()=>({action:'deny'}));w.webContents.on('will-navigate',e=>e.preventDefault());w.loadFile(path.join(__dirname,'renderer/workspace/index.html'));return w}
 app.on('before-quit',()=>client.stop());client.start();return {open,client}
}
module.exports={setupWorkspace}
