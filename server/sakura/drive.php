<?php
require_once __DIR__.'/worker.php';
final class DrivePublisher {
 private $cfg,$token,$dir;
 function __construct($cfg){$this->cfg=$cfg['drive']??[];$this->dir=$cfg['dataDir'];if(is_file($this->dir.'/drive-gateway.json'))$this->cfg=array_merge($this->cfg,json_decode(file_get_contents($this->dir.'/drive-gateway.json'),true,512,JSON_THROW_ON_ERROR));}
 function token(){if($this->token)return $this->token;demand(!empty($this->cfg['refreshToken'])&&!empty($this->cfg['folderId']),'管理者によるGoogle Drive接続設定が必要です');$r=requestJson('https://oauth2.googleapis.com/token',http_build_query(['client_id'=>$this->cfg['clientId'],'client_secret'=>$this->cfg['clientSecret'],'refresh_token'=>$this->cfg['refreshToken'],'grant_type'=>'refresh_token']),['Content-Type: application/x-www-form-urlencoded']);return $this->token=$r['access_token'];}
 function req($url,$method='GET',$data=null,$extra=[]){$ch=curl_init($url);$headers=[];curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>20,CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_HTTPHEADER=>array_merge(['Authorization: Bearer '.$this->token()],$extra),CURLOPT_HEADERFUNCTION=>function($c,$h)use(&$headers){$a=explode(':',$h,2);if(count($a)===2)$headers[strtolower(trim($a[0]))]=trim($a[1]);return strlen($h);}]);if($data!==null)curl_setopt($ch,CURLOPT_POSTFIELDS,$data);$body=curl_exec($ch);$code=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);if($code<200||$code>=300)throw new RuntimeException($code===412?'共有先が他から更新されました。確認してください。':'Drive保存エラー ('.$code.')');return [$body,$headers];}
 function file($parent,$name,$folder=false){$quote=fn($v)=>str_replace(["\\","'"],["\\\\","\\'"],$v);$q="'".$quote($parent)."' in parents and name = '".$quote($name)."' and trashed = false";$r=$this->req('https://www.googleapis.com/drive/v3/files?'.http_build_query(['q'=>$q,'fields'=>'files(id,name,mimeType)','supportsAllDrives'=>'true','includeItemsFromAllDrives'=>'true']));$items=json_decode($r[0],true)['files']??[];demand(count($items)<=1,'共有先に同名ファイルが複数あります');if($items)return $items[0]['id'];$meta=['name'=>$name,'parents'=>[$parent],'mimeType'=>$folder?'application/vnd.google-apps.folder':'text/markdown'];$r=$this->req('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true','POST',json_encode($meta),['Content-Type: application/json']);return json_decode($r[0],true)['id'];}
 function publish($staffId,$files){
  $lock=fopen($this->dir.'/drive.lock','c');if(!flock($lock,LOCK_EX|LOCK_NB)){fclose($lock);throw new RuntimeException('共有保存中です。次の確認時に再試行します。');}
  try{
   if(!empty($this->cfg['gatewayUrl'])){
    $payload=json_encode(['time'=>time(),'staffId'=>$staffId,'files'=>$files],JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    $body=json_encode(['payload'=>$payload,'signature'=>hash_hmac('sha256',$payload,$this->cfg['gatewayKey'])]);
    $ch=curl_init($this->cfg['gatewayUrl']);curl_setopt_array($ch,[CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>$body,CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>60,CURLOPT_CONNECTTIMEOUT=>10,CURLOPT_FOLLOWLOCATION=>true,CURLOPT_MAXREDIRS=>3,CURLOPT_REDIR_PROTOCOLS=>CURLPROTO_HTTPS]);$raw=curl_exec($ch);$status=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);$r=json_decode($raw?:'',true);if($status!==200||!is_array($r))throw new RuntimeException('Google共有保存サービスへ接続できません');if(empty($r['ok']))throw new RuntimeException($r['error']??'共有保存に失敗しました');return;
   }
   $stateFile=$this->dir.'/drive-sync.json';$known=is_file($stateFile)?json_decode(file_get_contents($stateFile),true,512,JSON_THROW_ON_ERROR):[];
   $root=$this->file($this->cfg['folderId']??'','スタッフ',true);$staff=$this->file($root,$staffId,true);$jobs=$this->file($staff,'業務',true);
   foreach($files as $relative=>$body){$parent=strpos($relative,'業務/')===0?$jobs:$staff;$name=basename($relative);$file=$this->file($parent,$name);[$old,$headers]=$this->req('https://www.googleapis.com/drive/v3/files/'.rawurlencode($file).'?alt=media&supportsAllDrives=true');$start='<!-- ESCO-AUTO-START -->';$end='<!-- ESCO-AUTO-END -->';$block=$start."\n".$body."\n".$end;$a=strpos($old,$start);$b=strpos($old,$end);$oldBlock=$a!==false&&$b!==false&&$b>$a?substr($old,$a,$b+strlen($end)-$a):$old;
    if($old&&$oldBlock!==$block&&($known[$file]??'')!==hash('sha256',$oldBlock))throw new RuntimeException($name.'が手動または別の処理で変更されました');
    $next=$a!==false&&$b!==false&&$b>$a?substr($old,0,$a).$block.substr($old,$b+strlen($end)):$block."\n\n<!-- 手動追記はこの下へ -->\n";
    if($next!==$old){if($old){$backup=$this->file($staff,'_更新履歴',true);$copy=$this->file($backup,gmdate('Ymd_His').'_'.uid().'_'.$name);$this->req('https://www.googleapis.com/upload/drive/v3/files/'.$copy.'?uploadType=media&supportsAllDrives=true','PATCH',$old,['Content-Type: text/markdown; charset=utf-8']);}
     demand(!empty($headers['etag']),'共有先の更新確認情報が取得できません');$this->req('https://www.googleapis.com/upload/drive/v3/files/'.$file.'?uploadType=media&supportsAllDrives=true','PATCH',$next,['Content-Type: text/markdown; charset=utf-8','If-Match: '.$headers['etag']]);}
    $known[$file]=hash('sha256',$block);file_put_contents($stateFile.'.tmp',json_encode($known));rename($stateFile.'.tmp',$stateFile);
   }
  }finally{flock($lock,LOCK_UN);fclose($lock);}
 }
}
