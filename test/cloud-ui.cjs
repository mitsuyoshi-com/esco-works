const {app,BrowserWindow}=require('electron'),fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict');
const data=fs.mkdtempSync(path.join(os.tmpdir(),'esco-cloud-ui-'));app.setPath('userData',data);
class Runner {constructor({emit}){this.emit=emit}async startTurn(p){assert.equal(p.autoApprove,false);assert.equal(p.workFolder,data);this.emit('agent:ask',{requestId:'approve1',tool:'Write',detail:'テストフォルダへ結果を書き込み'});await new Promise(r=>this.resume=r);if(this.approved){fs.writeFileSync(path.join(data,'pc-result.txt'),'approved once');this.emit('agent:token',{delta:'承認して実行しました'});}this.emit('agent:done',{costUsd:0})}respondPermission(id,approved){this.approved=approved;this.resume()}interrupt(){this.resume?.()}respondChoice(){}}
const agent=require.resolve('../agent');require.cache[agent]={id:agent,filename:agent,loaded:true,exports:{AgentRunner:Runner}};
const delay=ms=>new Promise(r=>setTimeout(r,ms));async function until(fn){for(let i=0;i<140;i++){if(await fn())return;await delay(250)}throw Error('timeout')}
let desktop,mobile,setup,restarted;const timer=setTimeout(()=>{console.error('UI timeout');app.exit(1)},90000);
app.on('browser-window-created',(_e,w)=>{w.hide();w.webContents.setBackgroundThrottling(false)});
app.whenReady().then(async()=>{try{
 setup=require('../workspaceDesktop').setupWorkspace({getSettings:()=>({}),folderQueue:{request:()=>({wait:Promise.resolve(()=>{}),cancel:()=>{}})},sessions:{list:()=>[]},projects:{list:()=>[]},recordUsage:()=>{}});desktop=setup.open();await until(()=>!desktop.webContents.isLoading());const js=c=>desktop.webContents.executeJavaScript(c).catch(e=>{throw Error(c+': '+e.message)});
 await js("$('url').value='http://127.0.0.1:18974';$('email').value='one@example.test';$('password').value='test-password-one';$('loginForm').requestSubmit()");await until(()=>js('!!user'));
 const project=await js("mutate('project.save',{name:'UI同期テスト',instructions:''})");setup.client.bind(project.id,data);
 await until(async()=>{const s=await setup.client.api('bootstrap');return s.pcs.some(p=>p.id===setup.client.config.pcId)});
 await js(`selectedProject=${JSON.stringify(project.id)};$('newSession').click()`);await until(()=>js('!!current'));const sid=await js('current.id');
 await js(`(async()=>{await refresh();$('route').value='pc';$('pc').value=${JSON.stringify(setup.client.config.pcId)};$('input').value='承認して動作確認';$('sendForm').requestSubmit()})()`);
 await until(()=>js("!!document.querySelector('#asks button')"));
 mobile=new BrowserWindow({width:390,height:844,show:false,webPreferences:{offscreen:true,contextIsolation:true,nodeIntegration:false,sandbox:true}});await mobile.loadURL('http://127.0.0.1:18974');mobile.webContents.enableDeviceEmulation({screenPosition:'mobile',screenSize:{width:390,height:844},viewPosition:{x:0,y:0},deviceScaleFactor:1,viewSize:{width:390,height:844},scale:1});const mj=c=>mobile.webContents.executeJavaScript(c).catch(e=>{throw Error(c+': '+e.message)});
 await mj("$('email').value='one@example.test';$('password').value='test-password-one';$('loginForm').requestSubmit()");await until(()=>mj('!!user'));await mj(`select(${JSON.stringify(sid)})`);await until(()=>mj("!!document.querySelector('#asks button')"));await mj("document.querySelector('#asks button').click()");
 await until(()=>fs.existsSync(path.join(data,'pc-result.txt')));await until(()=>mj("$('messages').textContent.includes('承認して実行しました')"));
 assert.ok(await mj('document.documentElement.scrollWidth<=innerWidth'));
 await delay(200);const shot=await mobile.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true});if(!shot.isEmpty())fs.writeFileSync(path.join(data,'mobile.png'),shot.toPNG());
 assert.ok(await mj('innerWidth<=390'));assert.equal(await mj("getComputedStyle($('sidebar')).position"),'fixed');
 await mj("$('manage').click()");await mj("document.querySelector('#editBody input').value='スマホで名前変更';[...document.querySelectorAll('#editBody button')].find(b=>b.textContent==='名前を保存').click()");await until(()=>js("state.sessions.some(s=>s.title==='スマホで名前変更')"));
 setup.client.stop();
 await mj(`(async()=>{await refresh();$('route').value='pc';$('pc').value=${JSON.stringify(setup.client.config.pcId)};$('input').value='再起動後に実行';$('sendForm').requestSubmit()})()`);
 await until(()=>mj("$('taskState').textContent==='実行待ち'"));
 const {WorkspaceClient}=require('../workspaceClient');restarted=new WorkspaceClient({dir:setup.client.dir,encrypt:setup.client.encrypt,decrypt:setup.client.decrypt,createRunner:setup.client.createRunner});assert.equal(restarted.config.pcId,setup.client.config.pcId);assert.equal(restarted.folders[project.id],data);restarted.start();
 await until(()=>mj("!!document.querySelector('#asks button')"));await mj("document.querySelector('#asks button').click()");await until(()=>mj("$('taskState').textContent==='完了'"));restarted.stop();
 console.log('PASS: desktop encrypted login, native IPC, PC queue, mobile approval, result sync, mobile rename reflected on PC, 390px no overflow, offline queue and encrypted client restart');console.log('ARTIFACT='+data);clearTimeout(timer);setup.client.stop();app.exit(0);
}catch(e){console.error(e.stack);clearTimeout(timer);setup?.client.stop();restarted?.stop();app.exit(1)}});
