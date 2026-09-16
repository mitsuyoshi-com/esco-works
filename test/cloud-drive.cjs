const fs=require('fs'),vm=require('vm'),crypto=require('crypto'),assert=require('assert/strict');
let next=0;const props=new Map([['ESCO_KEY','test-key']]);
class File {constructor(name,text=''){this.name=name;this.text=text;this.id=String(++next);this.time=Date.now()}getId(){return this.id}getLastUpdated(){return new Date(this.time)}getBlob(){return {getDataAsString:()=>this.text}}setContent(s){this.text=s;this.time++;return this}}
class Folder {constructor(name){this.name=name;this.files=[];this.folders=[]}getName(){return this.name}getFilesByName(n){return iter(this.files.filter(x=>x.name===n))}getFoldersByName(n){return iter(this.folders.filter(x=>x.name===n))}createFolder(n){const x=new Folder(n);this.folders.push(x);return x}createFile(n,t){const x=new File(n,t);this.files.push(x);return x}}
const iter=a=>({hasNext:()=>a.length>0,next:()=>a.shift()});const root=new Folder('ESCO_業務共有');let locked=false;
const scope={console,Date,PropertiesService:{getScriptProperties:()=>({getProperty:k=>props.get(k),setProperty:(k,v)=>props.set(k,v)})},DriveApp:{getFolderById:id=>{assert.equal(id,'test-shared-folder');return root}},ScriptApp:{getService:()=>({getUrl:()=>''})},Utilities:{DigestAlgorithm:{SHA_256:1},Charset:{UTF_8:1},computeDigest:(_,t)=>[...crypto.createHash('sha256').update(t).digest()],computeHmacSha256Signature:(t,k)=>[...crypto.createHmac('sha256',k).update(t).digest()]},MimeType:{PLAIN_TEXT:'text/plain'},ContentService:{MimeType:{JSON:'json'},createTextOutput:t=>({setMimeType:()=>JSON.parse(t)})},LockService:{getScriptLock:()=>({tryLock:()=>locked=true,hasLock:()=>locked,releaseLock:()=>locked=false})}};
vm.createContext(scope);vm.runInContext(fs.readFileSync('server/google-drive/Code.gs','utf8').replace('REPLACE_WITH_SHARED_FOLDER_ID','test-shared-folder'),scope);
const call=(files,sig)=>{const payload=JSON.stringify({time:Date.now()/1000,staffId:'a'.repeat(32),files});return scope.doPost({postData:{contents:JSON.stringify({payload,signature:sig||crypto.createHmac('sha256','test-key').update(payload).digest('hex')})}})};
assert.equal(call({'入力記録.md':'内容'},'bad').ok,false);assert.equal(root.folders.length,0);
assert.equal(call({'入力記録.md':'内容','業務/月次.md':'月末作業'}).ok,true);
const staff=root.folders[0].folders[0],f=staff.files.find(f=>f.name==='入力記録.md');assert.ok(f.text.includes('内容'));
assert.equal(call({'入力記録.md':'内容'}).ok,true);assert.equal(staff.folders.some(f=>f.name==='_更新履歴'),false);
f.text+='\n手動の追記';assert.equal(call({'入力記録.md':'更新'}).ok,true);assert.ok(f.text.endsWith('手動の追記'));
f.text=f.text.replace('更新','手動変更');assert.equal(call({'入力記録.md':'次の更新'}).ok,false);assert.ok(f.text.includes('手動変更'));
assert.equal(call({'業務/../escape.md':'bad'}).ok,false);
console.log('PASS: signed Drive gateway, fixed root, unauthorized rejection, idempotent overwrite, manual notes preserved, conflict detection, traversal rejection');
