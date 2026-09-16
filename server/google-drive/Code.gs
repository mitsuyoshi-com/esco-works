// ESCO Works: only the designated shared folder is used. No sharing permissions are changed.
const ESCO_FOLDER = 'REPLACE_WITH_SHARED_FOLDER_ID';
function initialize() {
  const folder = DriveApp.getFolderById(ESCO_FOLDER);
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('ESCO_KEY');
  if (!key) { key = Utilities.getUuid() + Utilities.getUuid(); props.setProperty('ESCO_KEY', key); }
  console.log('共有先: ' + folder.getName());
  console.log('接続URL: ' + ScriptApp.getService().getUrl());
  console.log('接続キー: ' + key);
}
function hash(text) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,text,Utilities.Charset.UTF_8).map(v=>('0'+(v&255).toString(16)).slice(-2)).join(''); }
function child(parent,name,folder) {
  const list=folder?parent.getFoldersByName(name):parent.getFilesByName(name);
  if(list.hasNext()){const found=list.next();if(list.hasNext())throw Error('同名ファイルが複数あります: '+name);return found;}
  return folder?parent.createFolder(name):parent.createFile(name,'',MimeType.PLAIN_TEXT);
}
function doPost(e) {
  const output=o=>ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
  const lock=LockService.getScriptLock();
  try {
    const envelope=JSON.parse(e.postData.contents), key=PropertiesService.getScriptProperties().getProperty('ESCO_KEY');
    if(!key||typeof envelope.payload!=='string'||envelope.payload.length>2000000)throw Error('認証できません');
    const signature=Utilities.computeHmacSha256Signature(envelope.payload,key,Utilities.Charset.UTF_8).map(v=>('0'+(v&255).toString(16)).slice(-2)).join('');
    if(signature!==envelope.signature)throw Error('認証できません');
    const request=JSON.parse(envelope.payload);
    if(Math.abs(Date.now()/1000-request.time)>120||!/^[a-f0-9]{32}$/.test(request.staffId))throw Error('期限または担当者が不正です');
    if(!lock.tryLock(10000))throw Error('別の共有保存処理を実行中です');
    const root=DriveApp.getFolderById(ESCO_FOLDER), staff=child(child(root,'スタッフ',true),request.staffId,true), jobs=child(staff,'業務',true);
    const stateFile=child(staff,'_クラウド同期.json',false), state=JSON.parse(stateFile.getBlob().getDataAsString()||'{}');
    const entries=Object.entries(request.files||{});if(entries.length>100)throw Error('ファイル数が多すぎます');
    for(const [relative,body] of entries) {
      const isJob=relative.startsWith('業務/'), name=isJob?relative.slice(3):relative;
      if(typeof body!=='string'||body.length>1500000||(!isJob&&!['入力記録.md','業務一覧.md'].includes(name))||!name.endsWith('.md')||/[\/\\\x00-\x1f]/.test(name)||name.includes('..'))throw Error('保存名が不正です');
      const file=child(isJob?jobs:staff,name,false), modified=file.getLastUpdated().getTime(), old=file.getBlob().getDataAsString();
      const start='<!-- ESCO-AUTO-START -->',end='<!-- ESCO-AUTO-END -->', block=start+'\n'+body+'\n'+end;
      const a=old.indexOf(start),b=old.indexOf(end),has=a>=0&&b>a,oldBlock=has?old.slice(a,b+end.length):old;
      if(old&&oldBlock!==block&&state[file.getId()]!==hash(oldBlock))throw Error(name+'の自動生成部分が手動変更されています');
      if(oldBlock===block){state[file.getId()]=hash(block);continue;}
      if(old)child(staff,'_更新履歴',true).createFile(Date.now()+'_'+name,old,MimeType.PLAIN_TEXT);
      if(file.getLastUpdated().getTime()!==modified)throw Error(name+'が保存直前に更新されました');
      file.setContent(has?old.slice(0,a)+block+old.slice(b+end.length):block);
      state[file.getId()]=hash(block);stateFile.setContent(JSON.stringify(state));
    }
    stateFile.setContent(JSON.stringify(state));return output({ok:true});
  }catch(error){return output({ok:false,error:String(error.message||error)});}finally{if(lock.hasLock())lock.releaseLock();}
}
