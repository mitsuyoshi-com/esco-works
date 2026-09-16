<?php
// Device credentials are random, stored hashed, and individually revocable.
function deviceToken($w,&$s,$owner,$kind,$name,$fixed=null){
 $token=$fixed??bin2hex(random_bytes(32));$key=hash('sha256',$token);
 $s['tokens'][$key]=['id'=>uid(),'userId'=>$owner,'kind'=>$kind,'name'=>shortText($name,180),'createdAt'=>stamp(),'lastSeen'=>stamp(),'expires'=>time()+400*86400];return $token;
}
function deviceCall($w,&$s,$action,$b,$token){
 if($action==='device.enroll'){
  $secret=$b['secret']??'';demand(is_string($secret)&&preg_match('/^[a-f0-9]{64}$/',$secret),'端末キーが不正です');$key=hash('sha256',$secret);
  $e=$s['enrollments'][$key]??null;
  if(!$e){
   $name=shortText($b['name']??'',180);demand($name!=='','名前を入力してください');
   $e=['id'=>uid(),'name'=>$name,'pcName'=>shortText($b['pcName']??'PC',180),'status'=>'pending','createdAt'=>stamp(),'expires'=>time()+7*86400];
   $s['enrollments'][$key]=$e;
  }
  // Private, single-use bootstrap invitation is used only on the owner's PC.
  if(!empty($b['adminInvite'])&&$e['status']==='pending'){$ik=hash('sha256',$b['adminInvite']);$i=$s['invites'][$ik]??null;demand($i&&!empty($i['admin'])&&$i['expires']>time(),'管理用初期設定の期限が切れました',401);$e['status']='approved';$e['admin']=true;$s['enrollments'][$key]=$e;unset($s['invites'][$ik]);}
  demand($e['expires']>time(),'端末の利用開始申請が期限切れです',401);demand($e['status']!=='denied','この端末は許可されていません',403);
  if($e['status']!=='approved')return ['status'=>'pending','id'=>$e['id']];
  $access=hash_hmac('sha256','ESCO device enrollment',$secret);$tk=hash('sha256',$access);
  if(empty($e['userId'])){
   $u=['id'=>uid(),'email'=>'','password'=>'','name'=>$e['name'],'disabled'=>false,'admin'=>!empty($e['admin'])];$s['users'][$u['id']]=$u;
   deviceToken($w,$s,$u['id'],'pc',$e['pcName'],$access);$s['enrollments'][$key]['userId']=$u['id'];
  }else{$u=$s['users'][$e['userId']];demand(isset($s['tokens'][$tk])&&!$u['disabled'],'この端末の連携は解除されています',401);}
  return ['status'=>'approved','token'=>$access,'user'=>$w->user($u)];
 }
 if($action==='pair.request'){
  $key=hash('sha256',$b['code']??'');$p=$s['pairs'][$key]??null;demand($p&&$p['expires']>time()&&empty($p['claim']),'QRが期限切れか使用済みです',401);
  $claim=bin2hex(random_bytes(32));$s['pairs'][$key]['claim']=hash('sha256',$claim);$s['pairs'][$key]['check']=str_pad((string)random_int(0,999999),6,'0',STR_PAD_LEFT);$s['pairs'][$key]['name']=shortText($b['name']??'スマホ',180);
  return ['claim'=>$claim,'check'=>$s['pairs'][$key]['check'],'expiresIn'=>$p['expires']-time()];
 }
 if($action==='pair.complete'){
  $claim=hash('sha256',$b['claim']??'');foreach($s['pairs'] as $key=>$p)if(($p['claim']??'')===$claim){
   demand($p['expires']>time()&&isset($s['tokens'][$p['issuer']]),'連携が期限切れです',401);
   if(empty($p['approved']))return ['status'=>'pending'];$u=$s['users'][$p['userId']];demand(!$u['disabled'],'利用できません',401);
   unset($s['pairs'][$key]);return ['status'=>'approved','token'=>deviceToken($w,$s,$u['id'],'mobile',$p['name']),'user'=>$w->user($u)];
  }throw new ApiError('連携が期限切れか使用済みです。PCでQRを再表示してください',401);
 }
 if(!in_array($action,['device.requests','device.decide','devices.list','device.revoke','pair.issue','pair.pending','pair.approve']))return null;
 $u=$w->auth($s,$token);$owner=$u['id'];$tk=hash('sha256',$token);$credential=$s['tokens'][$tk];
 if($action==='device.requests'||$action==='device.decide'){
  demand(!empty($u['admin']),'管理者のみ利用できます',403);
  if($action==='device.requests')return ['requests'=>array_values(array_filter($s['enrollments']??[],fn($e)=>$e['status']==='pending'&&$e['expires']>time()))];
  foreach($s['enrollments']??[] as $k=>$e)if($e['id']===($b['id']??'')){demand($e['expires']>time()&&$e['status']==='pending','申請は処理済みか期限切れです',409);$s['enrollments'][$k]['status']=!empty($b['approved'])?'approved':'denied';return ['ok'=>true];}throw new ApiError('申請がありません',404);
 }
 if($action==='devices.list'){$rows=[];foreach($s['tokens'] as $k=>$t)if($t['userId']===$owner||!empty($u['admin']))$rows[]=['id'=>$t['id']??$k,'name'=>($s['users'][$t['userId']]['name']??'').' / '.($t['name']??'既存の接続'),'kind'=>$t['kind']??'legacy','current'=>$k===$tk,'lastSeen'=>$t['lastSeen']??''];return ['devices'=>$rows];}
 if($action==='device.revoke'){
  foreach($s['tokens'] as $k=>$t)if(($t['userId']===$owner||!empty($u['admin']))&&($t['id']??$k)===($b['id']??'')){unset($s['tokens'][$k]);foreach($s['pairs'] as $pk=>$p)if(($p['issuer']??'')===$k)unset($s['pairs'][$pk]);return ['ok'=>true];}throw new ApiError('端末がありません',404);
 }
 demand(($credential['kind']??'legacy')!=='mobile','PCから連携してください',403);
 if($action==='pair.issue'){
  foreach($s['pairs'] as $k=>$p)if(($p['issuer']??'')===$tk)unset($s['pairs'][$k]);
  $code=bin2hex(random_bytes(24));$s['pairs'][hash('sha256',$code)]=['userId'=>$owner,'issuer'=>$tk,'expires'=>time()+120];return ['code'=>$code,'expiresIn'=>120];
 }
 if($action==='pair.pending'){$rows=[];foreach($s['pairs'] as $k=>$p)if(($p['issuer']??'')===$tk&&!empty($p['claim']))$rows[]=['id'=>$k,'check'=>$p['check'],'name'=>$p['name'],'approved'=>!empty($p['approved'])];return ['requests'=>$rows];}
 $key=$b['id']??'';$p=$s['pairs'][$key]??null;demand($p&&$p['issuer']===$tk&&!empty($p['claim']),'連携要求がありません',404);
 if(empty($b['approved']))unset($s['pairs'][$key]);else $s['pairs'][$key]['approved']=true;return ['ok'=>true];
}
