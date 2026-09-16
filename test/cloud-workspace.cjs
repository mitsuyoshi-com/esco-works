const fs=require('fs'),path=require('path'),os=require('os'),{spawn,spawnSync}=require('child_process'),assert=require('node:assert/strict'),{randomUUID}=require('crypto');
const root=path.resolve(__dirname,'..'),data=fs.mkdtempSync(path.join(os.tmpdir(),'esco-cloud-test-')),priv=path.join(data,'private'),web=path.join(data,'public');fs.mkdirSync(priv);fs.mkdirSync(web);
const php=process.env.ESCO_PHP||path.join(os.tmpdir(),'esco-php/php.exe');const opts=['-d','extension_dir='+path.join(path.dirname(php),'ext'),'-d','extension=pdo_sqlite','-d','extension=curl','-d','extension=mbstring','-d','extension=openssl'];
for(const f of ['app.php','worker.php','drive.php'])fs.copyFileSync(path.join(root,'server/sakura',f),path.join(priv,f));fs.copyFileSync(path.join(root,'server/sakura/public/api.php'),path.join(web,'api.php'));for(const f of fs.readdirSync(path.join(root,'renderer/workspace')))fs.copyFileSync(path.join(root,'renderer/workspace',f),path.join(web,f));
const port=18974,url='http://127.0.0.1:'+port;fs.writeFileSync(path.join(priv,'config.php'),`<?php return ['dataDir'=>__DIR__.'/data','origin'=>'${url}','cookiePath'=>'/','secure'=>false,'apiKey'=>'test'];`);
function run(code){const f=path.join(priv,'test-step.php');fs.writeFileSync(f,'<?php require __DIR__."/worker.php"; $w=new Workspace(require __DIR__."/config.php"); '+code);const r=spawnSync(php,[...opts,f],{encoding:'utf8',windowsHide:true});if(r.status!==0)throw Error(r.stderr||r.stdout);return r.stdout}
run(`$w->addUser('one@example.test','担当一','test-password-one');$w->addUser('two@example.test','担当二','test-password-two');`);
const server=spawn(php,[...opts,'-S','127.0.0.1:'+port,'-t',web],{env:{...process.env,ESCO_PRIVATE_DIR:priv},windowsHide:true,stdio:['ignore','ignore','pipe']});let errs='';server.stderr.on('data',b=>{errs+=b});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function api(action,body={},token='',expected=200,headers={}){const r=await fetch(url+'/api.php',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...headers},body:JSON.stringify({action,...body})});const text=await r.text();let j;try{j=JSON.parse(text)}catch{throw Error(text)}assert.equal(r.status,expected,action+': '+text);return j}
const op=()=>({opId:randomUUID()});
(async()=>{try{
 for(let i=0;i<40;i++){try{await fetch(url);break}catch{await delay(100)}}
 const a=await api('login',{email:'one@example.test',password:'test-password-one',desktop:true}),b=await api('login',{email:'two@example.test',password:'test-password-two',desktop:true});
 assert.equal((await api('bootstrap',{_accessToken:a.token})).user.id,a.user.id);
 await api('bootstrap',{},'',401);await api('bootstrap',{},a.token,403,{Origin:'https://evil.example'});
 await api('invite.issue',{...op(),email:'new@example.test'},b.token,403);
 await api('drive.configure',{url:'https://evil.example',key:'x'},b.token,403);
 run(`$w->tx(function(&$s){foreach($s['users'] as &$u)if($u['email']==='one@example.test')$u['admin']=true;});`);
 const invite=await api('invite.issue',{...op(),email:'new@example.test'},a.token);
 await api('invite.redeem',{code:invite.code,email:'other@example.test',name:'別人',password:'test-password-new'},'',400);
 const enrolled=await api('invite.redeem',{code:invite.code,email:'new@example.test',name:'新担当',password:'test-password-new',desktop:true});assert.equal(enrolled.user.admin,false);
 await api('invite.redeem',{code:invite.code,email:'new@example.test',name:'新担当',password:'test-password-new'},'',401);
 await api('drive.configure',{url:'http://127.0.0.1',key:'x'},a.token,400);
 const p=await api('project.save',{...op(),name:'請求',instructions:'円単位'},a.token);
 let s=await api('session.create',{...op(),projectId:p.id},a.token);await api('session.get',{id:s.id},b.token,404);await api('session.update',{...op(),id:s.id,revision:0,pinned:true},a.token,409);
 s=await api('session.update',{...op(),id:s.id,revision:s.revision,title:'請求書',pinned:true},a.token);
 const body={...op(),id:s.id,revision:s.revision,text:'請求業務を説明します',route:'cloud'};const sent=await api('chat.send',body,a.token);const replay=await api('chat.send',body,a.token);assert.equal(replay.taskId,sent.taskId);await api('chat.send',{...body,text:'違う操作'},a.token,409);
 run(`cloudRun($w,fn()=>['content'=>[['type'=>'text','text'=>'テスト回答']]]);`);s=await api('session.get',{id:s.id},a.token);assert.equal(s.messages.length,2);assert.equal(s.messages[1].text,'テスト回答');
 s=await api('session.update',{...op(),id:s.id,revision:s.revision,archived:true},a.token);s=await api('session.update',{...op(),id:s.id,revision:s.revision,archived:false,deleted:true},a.token);await api('session.purge',{...op(),id:s.id,revision:s.revision},a.token,400);s=await api('session.update',{...op(),id:s.id,revision:s.revision,deleted:false},a.token);
 const pcId=randomUUID();await api('pc.poll',{pcId,name:'テストPC',accept:true,projects:[p.id]},a.token);await api('pc.poll',{pcId,name:'なりすまし'},b.token,403);
 const queued=await api('chat.send',{...op(),id:s.id,revision:s.revision,text:'フォルダを確認',route:'pc',pcId},a.token);const claimed=(await api('pc.poll',{pcId,accept:true,projects:[p.id]},a.token)).task;assert.equal(claimed.id,queued.taskId);assert.equal((await api('pc.poll',{pcId,accept:true},a.token)).task,null);
 const event={pcId,taskId:claimed.id,lease:claimed.lease,seq:1,ev:'agent:ask',payload:{requestId:'req1',tool:'Write',input:{file:'example.txt'}}};await api('pc.event',event,b.token,404);await api('pc.event',event,a.token);await api('pc.event',event,a.token);await api('task.answer',{...op(),taskId:claimed.id,requestId:'req1',approved:true},a.token);const poll=await api('pc.poll',{pcId,active:claimed.id},a.token);assert.equal(poll.answers[0].approved,true);
 await api('pc.event',{...event,seq:2,ev:'agent:token',payload:{delta:'hello '}},a.token);await api('pc.event',{...event,seq:3,ev:'agent:token',payload:{delta:'world'}},a.token);await api('pc.event',{...event,seq:4,ev:'task:finished',payload:{}},a.token);s=await api('session.get',{id:s.id},a.token);assert.equal(s.messages.at(-1).text,'hello world');
 const qr=await api('pair.issue',{},a.token);const linked=await api('pair.redeem',{code:qr.code,desktop:true});assert.equal(linked.user.id,a.user.id);await api('pair.redeem',{code:qr.code,desktop:true},'',401);await api('logout',{},linked.token);await api('bootstrap',{},linked.token,401);
 let biz=await api('session.create',{...op(),kind:'business'},a.token);await api('chat.send',{...op(),id:biz.id,revision:biz.revision,text:'毎月請求書を作る'},a.token);
 run(`cloudRun($w,fn()=>['content'=>[['type'=>'text','text'=>"整理しました。\\n\u0060\u0060\u0060json\\n".json_encode(['escoBusiness'=>1,'jobs'=>[['id'=>'','title'=>'請求書','facts'=>['毎月作成'],'unknown'=>[],'ideas'=>[]]]],JSON_UNESCAPED_UNICODE)."\\n\u0060\u0060\u0060"]]]);`);
 const business=run(`$b=$w->tx(fn(&$s)=>$s['business']);echo json_encode(array_values($b)[0],JSON_UNESCAPED_UNICODE);`);assert.ok(JSON.parse(business).jobs);assert.equal(Object.values(JSON.parse(business).jobs)[0].title,'請求書');
 s=await api('session.update',{...op(),id:s.id,revision:s.revision,deleted:true},a.token);await api('session.purge',{...op(),id:s.id,revision:s.revision,confirmed:true},a.token);
 const purged=await api('session.get',{id:s.id},a.token);assert.equal(purged.messages.length,0);assert.equal((await api('bootstrap',{},a.token)).tasks.some(t=>t.sessionId===s.id),false);
 console.log('PASS: account isolation, CSRF origin rejection, revisions, idempotency, cloud response, history actions, PC claim isolation, approval, event replay, whitespace, one-time QR, logout, business structure');console.log('TEST_ROOT='+data);
 if(process.argv.includes('--serve')){console.log('Serving test workspace on '+url);return}server.kill();
 }catch(e){console.error(e.stack);console.error(errs.slice(-1200));server.kill();process.exitCode=1}})();
