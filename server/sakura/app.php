<?php
require_once __DIR__.'/devices.php';
// Private application code. Install OUTSIDE www; only public/api.php is web-accessible.
final class ApiError extends RuntimeException { public $status; function __construct($message,$status=400){parent::__construct($message);$this->status=$status;} }
function uid(){return bin2hex(random_bytes(16));}
function stamp(){return gmdate('c');}
function demand($condition,$message,$status=400){if(!$condition)throw new ApiError($message,$status);}
function shortText($v,$max=20000){demand(is_string($v)&&strlen($v)<=$max,'入力が長すぎるか形式が不正です');return trim($v);}
final class Workspace {
 public $cfg,$db;
 function __construct($cfg){
  $this->cfg=$cfg; $dir=$cfg['dataDir'];if(!is_dir($dir))mkdir($dir,0700,true);
  $this->db=new PDO('sqlite:'.$dir.'/workspace.sqlite');$this->db->setAttribute(PDO::ATTR_ERRMODE,PDO::ERRMODE_EXCEPTION);$this->db->exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY, body TEXT NOT NULL)');
  $this->db->exec("INSERT OR IGNORE INTO state VALUES (1,'{\"users\":{},\"tokens\":{},\"pairs\":{},\"pcs\":{},\"sessions\":{},\"projects\":{},\"tasks\":{},\"business\":{},\"ops\":{},\"limits\":{}}')");
 }
 function tx($fn){$this->db->exec('BEGIN IMMEDIATE');try{$s=json_decode($this->db->query('SELECT body FROM state WHERE id=1')->fetchColumn(),true,512,JSON_THROW_ON_ERROR);$r=$fn($s);$q=$this->db->prepare('UPDATE state SET body=? WHERE id=1');$q->execute([json_encode($s,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR)]);$this->db->exec('COMMIT');return $r;}catch(Throwable $e){$this->db->exec('ROLLBACK');throw $e;}}
 function addUser($email,$name,$password){demand(filter_var($email,FILTER_VALIDATE_EMAIL)&&strlen($password)>=12,'メールと12文字以上のパスワードが必要です');return $this->tx(function(&$s)use($email,$name,$password){foreach($s['users'] as $u)demand($u['email']!==strtolower($email),'登録済みです');$u=['id'=>uid(),'email'=>strtolower($email),'name'=>shortText($name,180),'password'=>password_hash($password,PASSWORD_DEFAULT),'disabled'=>false];$s['users'][$u['id']]=$u;return $u['id'];});}
 function user($u){return array_intersect_key($u,array_flip(['id','name','email','admin']));}
 function token(&$s,$userId){$token=bin2hex(random_bytes(32));$s['tokens'][hash('sha256',$token)]=['userId'=>$userId,'expires'=>time()+30*86400];return $token;}
 function auth(&$s,$token){$t=$s['tokens'][hash('sha256',$token)]??null;$u=$s['users'][$t['userId']??'']??null;demand($t&&$t['expires']>time()&&$u&&!$u['disabled'],'ログインしてください',401);if(isset($t['kind'])){$s['tokens'][hash('sha256',$token)]['expires']=time()+400*86400;$s['tokens'][hash('sha256',$token)]['lastSeen']=stamp();}return $u;}
 function own($s,$table,$id,$userId){$o=$s[$table][$id]??null;demand($o&&$o['userId']===$userId,'対象が見つかりません',404);return $o;}
 function idle($s,$sessionId){foreach($s['tasks'] as $t)if($t['sessionId']===$sessionId&&in_array($t['status'],['queued','running','approval']))throw new ApiError('この会話は処理中です',409);}
 function revision($object,$b){demand(isset($b['revision'])&&$object['revision']===$b['revision'],'他の端末で変更されました。再読み込みしてやり直してください',409);}
 function call($action,$b,$token='',$ip='local'){
  // Login throttling must commit even on bad credentials.
  $newDevice=$action==='device.enroll'&&$this->tx(function(&$s)use($b){return !isset($s['enrollments'][hash('sha256',is_string($b['secret']??null)?$b['secret']:'')]);});
  if($newDevice||in_array($action,['login','pair.request','invite.redeem'])){
   $allowed=$this->tx(function(&$s)use($ip,$newDevice){$key=hash('sha256',($newDevice?'enrollment:':'login:').$ip);$v=$s['limits'][$key]??['at'=>time(),'count'=>0];if(time()-$v['at']>600)$v=['at'=>time(),'count'=>0];$v['count']++;$s['limits'][$key]=$v;foreach($s['limits'] as $k=>$l)if(time()-$l['at']>600)unset($s['limits'][$k]);return $v['count']<=($newDevice?100:15);});demand($allowed,'時間をおいて再試行してください',429);
  }
  return $this->tx(function(&$s)use($action,$b,$token){
   foreach($s['tokens'] as $k=>$t)if($t['expires']<=time())unset($s['tokens'][$k]);
   foreach($s['pairs'] as $k=>$t)if($t['expires']<=time())unset($s['pairs'][$k]);
   if($action==='login'){$match=null;foreach($s['users'] as $u)if($u['email']===strtolower(trim($b['email']??'')))$match=$u;$valid=password_verify($b['password']??'',$match['password']??'$2y$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2uheWG/igi.');demand($match&&$valid&&!$match['disabled'],'メールまたはパスワードが違います',401);return ['token'=>$this->token($s,$match['id']),'user'=>$this->user($match)];}
   if($action==='pair.redeem')throw new ApiError('新版のQRで連携してください',410);
   $deviceResult=deviceCall($this,$s,$action,$b,$token);if($deviceResult!==null)return $deviceResult;
   if($action==='invite.redeem'){
    $key=hash('sha256',$b['code']??'');$i=$s['invites'][$key]??null;demand($i&&$i['expires']>time(),'招待リンクが無効か期限切れです',401);
    $email=strtolower(shortText($b['email']??'',254));$name=shortText($b['name']??'',180);$password=$b['password']??'';
    demand(filter_var($email,FILTER_VALIDATE_EMAIL)&&$name!==''&&is_string($password)&&strlen($password)>=12&&strlen($password)<=200,'名前・メール・12文字以上のパスワードを入力してください');
    demand(empty($i['email'])||$i['email']===$email,'招待されたメールアドレスを入力してください');foreach($s['users'] as $existing)demand($existing['email']!==$email,'登録済みです');
    $u=['id'=>uid(),'email'=>$email,'name'=>$name,'password'=>password_hash($password,PASSWORD_DEFAULT),'disabled'=>false,'admin'=>!empty($i['admin'])];$s['users'][$u['id']]=$u;unset($s['invites'][$key]);return ['token'=>$this->token($s,$u['id']),'user'=>$this->user($u)];
   }
   $u=$this->auth($s,$token);$owner=$u['id'];
   if($action==='logout'){unset($s['tokens'][hash('sha256',$token)]);return ['ok'=>true];}
   // Expired PC leases are uncertain, never auto-run a potentially completed file operation twice.
   foreach($s['tasks'] as &$task)if(in_array($task['status'],['running','approval'])&&$task['deadline']<time()){$task['status']='interrupted';$task['error']='接続または処理が中断しました。実行結果を確認してから再依頼してください。';}unset($task);
   if($action==='bootstrap'){
    $sessions=[];foreach($s['sessions'] as $x)if($x['userId']===$owner&&!isset($x['purged'])){$v=$x;unset($v['messages']);$sessions[]=$v;}
    $tasks=[];foreach($s['tasks'] as $t)if($t['userId']===$owner){unset($t['lease'],$t['history'],$t['text']);$tasks[]=$t;}
    $pcs=[];foreach($s['pcs'] as $p)if($p['userId']===$owner)$pcs[]=$p+['online'=>time()-$p['lastSeen']<20];
    return ['user'=>$this->user($u),'sessions'=>$sessions,'projects'=>array_values(array_filter($s['projects'],fn($p)=>$p['userId']===$owner)),'tasks'=>$tasks,'pcs'=>$pcs,'business'=>$s['business'][$owner]['status']??'まだ入力がありません'];
   }
   if($action==='session.get')return $this->own($s,'sessions',$b['id']??'',$owner);
   if($action==='pc.poll'){
    demand(($s['tokens'][hash('sha256',$token)]['kind']??'legacy')!=='mobile','PCの認証が必要です',403);
    $pcId=$b['pcId']??'';demand((bool)preg_match('/^[a-f0-9-]{32,36}$/',$pcId),'PC情報が不正です');$old=$s['pcs'][$pcId]??null;demand(!$old||$old['userId']===$owner,'接続できません',403);
    $s['pcs'][$pcId]=['id'=>$pcId,'userId'=>$owner,'name'=>shortText($b['name']??'PC',180),'lastSeen'=>time(),'projects'=>array_slice($b['projects']??[],0,200)];$answers=[];$cancel=false;
    foreach($s['tasks'] as &$t){if($t['userId']!==$owner||($t['pcId']??'')!==$pcId)continue;if(($b['active']??'')===$t['id']&&in_array($t['status'],['running','approval'])){$t['deadline']=time()+90;$cancel=!empty($t['cancel']);foreach($t['asks'] as $a)if(isset($a['answer']))$answers[]=$a['answer']+['taskId'=>$t['id']];}}unset($t);
    if(!empty($b['accept']))foreach($s['tasks'] as &$t){if($t['userId']===$owner&&$t['route']==='pc'&&$t['status']==='queued'&&$t['pcId']===$pcId){$t['status']='running';$t['lease']=uid();$t['deadline']=time()+90;return ['task'=>$t,'answers'=>$answers,'cancel'=>$cancel];}}unset($t);return ['task'=>null,'answers'=>$answers,'cancel'=>$cancel];
   }
   if($action==='pc.event'){
    $id=$b['taskId']??'';$t=$this->own($s,'tasks',$id,$owner);demand($t['route']==='pc'&&$t['pcId']===($b['pcId']??'')&&hash_equals($t['lease']??'',$b['lease']??''),'処理の所有権が違います',403);
    $seq=(int)($b['seq']??0);if($seq<=$t['seq'])return ['ok'=>true];demand($seq===$t['seq']+1,'イベントを順番に再送してください',409);demand(in_array($t['status'],['running','approval']),'この処理は終了済みです',409);
    $p=$b['payload']??[];$ev=$b['ev']??'';$session=&$s['sessions'][$t['sessionId']];
    if($ev==='agent:token'||$ev==='agent:text'){$text=$ev==='agent:token'?($p['delta']??''):($p['text']??'');demand(is_string($text)&&strlen($text)<=100000,'イベントが長すぎます');$last=count($session['messages'])-1;if($ev==='agent:token'&&$last>=0&&($session['messages'][$last]['taskId']??'')===$id&&$session['messages'][$last]['role']==='ai')$session['messages'][$last]['text'].=$text;else $session['messages'][]=['role'=>'ai','text'=>$text,'at'=>stamp(),'taskId'=>$id];$session['revision']++;}
    elseif($ev==='agent:ask'||$ev==='agent:choice'){$requestId=shortText($p['requestId']??'',100);$t['asks'][$requestId]=['requestId'=>$requestId,'kind'=>$ev==='agent:ask'?'permission':'choice','tool'=>shortText($p['tool']??'',150),'description'=>shortText($p['description']??$p['question']??'',6000),'input'=>$p['input']??null,'detail'=>$p['detail']??null,'options'=>$p['options']??[]];$t['status']='approval';}
    elseif($ev==='agent:error')$t['error']=shortText($p['message']??'処理に失敗しました',4000);
    elseif($ev==='task:finished'){$t['status']=!empty($t['cancel'])?'cancelled':(!empty($p['failed'])?'failed':'done');$t['asks']=[];}
    $t['seq']=$seq;$t['deadline']=time()+90;$s['tasks'][$id]=$t;return ['ok'=>true];
   }
   $op=$b['opId']??'';demand((bool)preg_match('/^[a-zA-Z0-9-]{16,80}$/',$op),'操作IDが不正です');$opKey=$owner.':'.$op;
   $fingerprint=hash('sha256',json_encode([$action,$b]));if(isset($s['ops'][$opKey])){demand($s['ops'][$opKey]['fingerprint']===$fingerprint,'操作IDが重複しています',409);return $s['ops'][$opKey]['result'];}
   $result=[];
   switch($action){
    case 'invite.issue':
     demand(!empty($u['admin']),'管理者のみ利用できます',403);$email=strtolower(shortText($b['email']??'',254));demand(filter_var($email,FILTER_VALIDATE_EMAIL),'社員のメールアドレスを入力してください');$code=bin2hex(random_bytes(24));$s['invites'][hash('sha256',$code)]=['email'=>$email,'expires'=>time()+86400,'admin'=>false];$result=['code'=>$code,'expiresIn'=>86400];break;

    case 'session.import':
     $src=shortText($b['source']??'',80);demand((bool)preg_match('/^[a-f0-9-]{36}$/',$src),'履歴IDが不正です');$id=substr(hash('sha256',$owner.':'.$src),0,32);
     if(isset($s['sessions'][$id])){$result=['id'=>$id];break;}$old=$b['session']??[];$project=$b['project']??null;$projectId=null;
     if($project){$projectId=substr(hash('sha256',$owner.':project:'.($project['id']??'')),0,32);if(!isset($s['projects'][$projectId]))$s['projects'][$projectId]=['id'=>$projectId,'userId'=>$owner,'revision'=>1,'name'=>shortText($project['name']??'取込プロジェクト',240),'instructions'=>shortText($project['instructions']??'',20000)];}
     $messages=[];foreach($old['messages']??[] as $m)if(in_array($m['role']??'',['user','ai','error']))$messages[]=['role'=>$m['role'],'text'=>shortText($m['text']??'',200000),'at'=>$m['at']??stamp()];demand(strlen(json_encode($messages))<2000000,'履歴が長すぎます');
     $s['sessions'][$id]=['id'=>$id,'userId'=>$owner,'projectId'=>$projectId,'kind'=>($old['kind']??'')==='business'?'business':'chat','title'=>shortText($old['title']??'取り込んだ会話',240),'archived'=>!empty($old['archived']),'deleted'=>!empty($old['deleted']),'pinned'=>!empty($old['pinned']),'revision'=>1,'updatedAt'=>$old['updatedAt']??stamp(),'messages'=>$messages];$result=['id'=>$id];break;
    case 'project.save':
     $id=$b['id']??uid();$p=isset($b['id'])?$this->own($s,'projects',$id,$owner):['id'=>$id,'userId'=>$owner,'revision'=>0];if(isset($b['id']))$this->revision($p,$b);$p['name']=shortText($b['name']??'',240);demand($p['name']!=='','プロジェクト名を入力してください');$p['instructions']=shortText($b['instructions']??'',20000);$p['revision']++;$s['projects'][$id]=$p;$result=$p;break;
    case 'session.create':
     $projectId=$b['projectId']??null;if($projectId)$this->own($s,'projects',$projectId,$owner);$id=uid();$kind=($b['kind']??'')==='business'?'business':'chat';$x=['id'=>$id,'userId'=>$owner,'projectId'=>$projectId,'kind'=>$kind,'title'=>$kind==='business'?'私の業務を教える':'新しい会話','archived'=>false,'deleted'=>false,'pinned'=>$kind==='business','revision'=>1,'updatedAt'=>stamp(),'messages'=>[]];$s['sessions'][$id]=$x;$result=$x;break;
    case 'session.update':
    case 'session.purge':
     $id=$b['id']??'';$x=$this->own($s,'sessions',$id,$owner);$this->revision($x,$b);$this->idle($s,$id);
     if($action==='session.purge'){demand($x['deleted']&&!empty($b['confirmed']),'ゴミ箱から確認して削除してください');$x['messages']=[];$x['purged']=true;$x['title']='削除済み';
      foreach($s['tasks'] as $k=>$t)if($t['sessionId']===$id)unset($s['tasks'][$k]);
      foreach($s['ops'] as &$o)if(($o['result']['id']??'')===$id)$o['result']=['id'=>$id,'purged'=>true];unset($o);}
     else {if(isset($b['title'])){$x['title']=shortText($b['title'],240);demand($x['title']!=='','名前を入力してください');}foreach(['pinned','archived','deleted'] as $key)if(isset($b[$key]))$x[$key]=(bool)$b[$key];if(array_key_exists('projectId',$b)){if($b['projectId'])$this->own($s,'projects',$b['projectId'],$owner);$x['projectId']=$b['projectId'];}}
     $x['revision']++;$x['updatedAt']=stamp();$s['sessions'][$id]=$x;$result=$x;break;
    case 'chat.send':
     $id=$b['id']??'';$x=$this->own($s,'sessions',$id,$owner);demand(!$x['deleted']&&!$x['archived']&&!isset($x['purged']),'会話を復元してください');$this->revision($x,$b);$this->idle($s,$id);$text=shortText($b['text']??'',20000);demand($text!=='','メッセージを入力してください');demand(strlen(json_encode($x))<2000000,'この会話は長くなりました。新しい会話を作成してください');
     $route=($b['route']??'')==='pc'?'pc':'cloud';if($x['kind']==='business'){$route='cloud';foreach($s['tasks'] as $task)if($task['userId']===$owner&&$task['kind']==='business'&&in_array($task['status'],['queued','running']))throw new ApiError('業務の整理が終わるまでお待ちください',409);}
     $pcId=$route==='pc'?($b['pcId']??''):null;if($route==='pc')$this->own($s,'pcs',$pcId,$owner);
     $tid=uid();$task=['id'=>$tid,'userId'=>$owner,'sessionId'=>$id,'projectId'=>$x['projectId'],'kind'=>$x['kind'],'route'=>$route,'pcId'=>$pcId,'text'=>$text,'history'=>array_slice($x['messages'],-40),'instructions'=>$s['projects'][$x['projectId']]['instructions']??'','status'=>'queued','createdAt'=>stamp(),'deadline'=>time()+180,'asks'=>[],'seq'=>0];
     $x['messages'][]=['role'=>'user','text'=>$text,'at'=>stamp(),'taskId'=>$tid];if(count($x['messages'])===1&&$x['title']==='新しい会話')$x['title']=mb_substr($text,0,40);$x['revision']++;$x['updatedAt']=stamp();$s['sessions'][$id]=$x;$s['tasks'][$tid]=$task;
     if($x['kind']==='business'){$biz=$s['business'][$owner]??['entries'=>[],'jobs'=>[],'revision'=>0];$biz['entries'][]=['id'=>$tid,'text'=>$text,'at'=>stamp()];$biz['revision']++;$biz['status']='サーバーに保存済み・AI整理待ち';$s['business'][$owner]=$biz;}
     $result=['taskId'=>$tid,'session'=>$x];break;
    case 'task.answer':
    case 'task.cancel':
     $id=$b['taskId']??'';$t=$this->own($s,'tasks',$id,$owner);demand(in_array($t['status'],['queued','running','approval']),'処理は終了しています',409);
     if($action==='task.cancel'){$t['cancel']=true;if($t['status']==='queued')$t['status']='cancelled';}
     else{$rid=$b['requestId']??'';$a=$t['asks'][$rid]??null;demand($a&&!isset($a['answer']),'確認は回答済みか期限切れです',409);$a['answer']=['requestId'=>$rid,'kind'=>$a['kind'],'approved'=>!empty($b['approved']),'answer'=>shortText($b['answer']??'',6000)];$t['asks'][$rid]=$a;$t['status']='running';}$s['tasks'][$id]=$t;$result=['ok'=>true];break;
    case 'business.retry':
     demand(isset($s['business'][$owner]),'入力がありません');$s['business'][$owner]['sharedRevision']=0;$s['business'][$owner]['status']='共有先へ保存待ち';$result=['ok'=>true];break;
    default:throw new ApiError('未対応の操作です',404);
   }
   $s['ops'][$opKey]=['fingerprint'=>$fingerprint,'result'=>$result,'at'=>time()];foreach($s['ops'] as $k=>$o)if($o['at']<time()-7*86400)unset($s['ops'][$k]);return $result;
  });
 }
}
