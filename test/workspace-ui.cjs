const {app,BrowserWindow,dialog} = require('electron')
const fs=require('fs'), os=require('os'), path=require('path'), assert=require('node:assert/strict')
const restoreIndex=process.argv.indexOf('--restore')
const data=restoreIndex>=0?process.argv[restoreIndex+1]:fs.mkdtempSync(path.join(os.tmpdir(),'esco-workspace-ui-'))
app.setPath('userData',data); app.getVersion=()=>require('../package.json').version
const share=path.join(data,'share'); fs.mkdirSync(share,{recursive:true})
if(restoreIndex<0) fs.writeFileSync(path.join(data,'settings.json'),JSON.stringify({apiKey:'test-only',userName:'テスト担当',staffId:'test-staff',businessFolder:share,remote:{mode:'off'}}))
process.on('uncaughtException',e=>{fs.writeFileSync(path.join(data,'uncaught.txt'),e.stack);app.exit(1)})
dialog.showMessageBox=async()=>({response:0})
let n=0; const calls=[], held=new Map()
class Runner {
  constructor({emit}){this.emit=emit;this.remembered=new Set()}
  newConversation(){this.sessionId=undefined;this.sessionCwd=undefined}
  interrupt(){this.release?.()}
  respondPermission(id,approved){calls.push({approved});this.release?.()}
  respondChoice(){this.release?.()}
  async startTurn(p){
    calls.push({...p,resume:this.sessionId});this.sessionId||='sdk-'+(++n);this.sessionCwd=p.workFolder||p.cwd
    if(p.text==='確認を待つ'){ this.emit('agent:ask',{requestId:'ask-'+n,tool:'Write',input:{},description:'確認テスト'});await new Promise(r=>{this.release=r;held.set(p.text,this)}) }
    else if(p.text.startsWith('長い作業')){this.emit('agent:token',{delta:p.text+'開始'});await new Promise(r=>{this.release=r;held.set(p.text,this)})}
    if(p.interview)this.emit('agent:text',{text:'整理しました。\n```json\n'+JSON.stringify({escoBusiness:1,jobs:[{title:'月次請求',facts:['毎月請求書を作成'],unknown:['所要時間'],ideas:['転記の自動化']}]})+'\n```'})
    else this.emit('agent:token',{delta:'回答完了'})
    this.emit('agent:done',{costUsd:0})
  }
}
function mock(file,exports){const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports}}
mock('../agent',{AgentRunner:Runner});mock('../updater',{setupAutoUpdate:()=>null})
let win;app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false);win||=w})
require('../main')
const delay=ms=>new Promise(r=>setTimeout(r,ms))
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await delay(30)}throw new Error('wait timeout')}
const timer=setTimeout(()=>{console.error('FAIL timeout');app.exit(1)},30000)
app.whenReady().then(async()=>{
 try{
  await until(()=>win&&!win.webContents.isLoading());const js=c=>win.webContents.executeJavaScript(c)
  await until(()=>js('!!settingsCache'))
  if(restoreIndex>=0){
   const list=await js('window.escoAI.listSessions()');assert.ok(list.projects.some(p=>p.name==='請求業務'))
   const first=list.items.find(s=>s.title==='名前変更済み');assert.ok(first)
   await js('switchSession('+JSON.stringify(first.id)+')');await js("$('input').value='再起動後の続き';send()")
   assert.ok(calls[0].resume);assert.ok(calls[0].history.length>0)
   assert.ok((await js('window.escoAI.businessStatus()')).jobs>0)
   console.log('PASS: full restart restores projects, history, SDK resume and business state');clearTimeout(timer);app.exit(0);return
  }
  const project=await js('window.escoAI.saveProject('+JSON.stringify({name:'請求業務',folder:data,instructions:'千円単位'})+')')
  await js('selectedProject='+JSON.stringify(project.id)+';switchSession()')
  const first=(await js('window.escoAI.listSessions()')).currentId
  await js("$('input').value='長い作業A';window.pendingA=send();true")
  await until(()=>held.has('長い作業A'))
  await js('selectedProject=null;switchSession()')
  const second=(await js('window.escoAI.listSessions()')).currentId
  await js("$('input').value='長い作業B';window.pendingB=send();true")
  await until(()=>held.has('長い作業B'))
  assert.equal((await js('window.escoAI.listSessions()')).items.filter(s=>s.busy).length,2)
  held.get('長い作業A').release();await js('window.pendingA')
  assert.equal(await js('busy'),true)
  assert.equal(await js("$('messages').textContent.includes('長い作業A')"),false)
  held.get('長い作業B').release();await js('window.pendingB')
  await js('switchSession('+JSON.stringify(first)+')')
  assert.ok(await js("$('messages').textContent.includes('長い作業A開始回答完了')"))
  assert.equal(calls[0].systemInstructions,'千円単位')
  await js('window.escoAI.updateSession('+JSON.stringify({id:first,action:'rename',value:'名前変更済み'})+')')
  await js('window.escoAI.updateSession('+JSON.stringify({id:second,action:'archive'})+')')
  await js("$('historyFilter').value='archive';refreshSessions()")
  assert.equal(await js("document.querySelectorAll('.session-item').length"),1)
  await js('window.escoAI.updateSession('+JSON.stringify({id:second,action:'trash'})+')')
  assert.equal(await js('window.escoAI.purgeSession('+JSON.stringify(second)+')'),false)
  await js('window.escoAI.updateSession('+JSON.stringify({id:second,action:'restore'})+')')
  await js("$('historyFilter').value='active';selectedProject=null;switchSession()")
  await js("$('input').value='確認を待つ';window.pendingAsk=send();true")
  await until(()=>held.has('確認を待つ'))
  const askSession=(await js('window.escoAI.listSessions()')).currentId
  await js('switchSession('+JSON.stringify(first)+')')
  assert.equal(calls.some(c=>Object.hasOwn(c,'approved')),false)
  await js('switchSession('+JSON.stringify(askSession)+')')
  assert.equal(await js("document.querySelectorAll('.permcard').length"),1)
  await js("document.querySelector('.permcard button').click()")
  await js('window.pendingAsk');assert.equal(calls.find(c=>Object.hasOwn(c,'approved')).approved,true)
  await js("switchSession(null,'business')")
  await js("$('input').value='毎月請求書を作成しています';send()")
  assert.ok((await js('window.escoAI.businessStatus()')).jobs>0)
  assert.ok(fs.existsSync(path.join(share,'スタッフ','test-staff','業務一覧.md')))
  fs.writeFileSync(path.join(data,'sample.md'),'プレビュー内容')
  await js('switchSession('+JSON.stringify(first)+')')
  assert.equal((await js('window.escoAI.preview('+JSON.stringify(path.join(data,'sample.md'))+')')).text,'プレビュー内容')
  await js('previewFile('+JSON.stringify(path.join(data,'sample.md'))+',"sample.md")')
  await js('refreshSessions()');await delay(200)
  await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});await delay(200)
  fs.mkdirSync(path.join(__dirname,'../build/shots'),{recursive:true})
  fs.writeFileSync(path.join(__dirname,'../build/shots/workspace.png'),(await win.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true})).toPNG())
  console.log('PASS: real UI/IPC, project folders/instructions, parallel sessions, event isolation, rename/archive/trash/restore, cancel deletion, pending approval restore, business MD, file preview')
  console.log('TEST_DATA='+data);clearTimeout(timer);app.exit(0)
 }catch(e){console.error('FAIL',e);clearTimeout(timer);app.exit(1)}
})
