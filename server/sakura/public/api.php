<?php
// All secrets and data must live outside the public web directory.
$private=getenv('ESCO_PRIVATE_DIR')?:dirname(__DIR__,2).'/esco-works-private';
header('Cache-Control: no-store');header('X-Content-Type-Options: nosniff');header('Content-Type: application/json; charset=utf-8');
try{
 if(!is_file($private.'/config.php'))throw new RuntimeException('設定が必要です');
 $cfg=require $private.'/config.php';require_once $private.'/worker.php';
 if($_SERVER['REQUEST_METHOD']!=='POST'){http_response_code(405);echo json_encode(['error'=>'POSTのみ利用できます']);exit;}
 $origin=$_SERVER['HTTP_ORIGIN']??'';if($origin&&$origin!==($cfg['origin']??'')){http_response_code(403);echo json_encode(['error'=>'許可されていない接続元です']);exit;}
 if((int)($_SERVER['CONTENT_LENGTH']??0)>2500000){http_response_code(413);exit;}
 $raw=file_get_contents('php://input',false,null,0,2500001);demand(strlen($raw)<=2500000,'入力が長すぎます',413);$b=json_decode($raw,true,512,JSON_THROW_ON_ERROR);demand(is_array($b),'リクエストが不正です');$action=$b['action']??'';
 $auth=$_SERVER['HTTP_AUTHORIZATION']??$_SERVER['REDIRECT_HTTP_AUTHORIZATION']??'';$token=preg_match('/^Bearer ([a-f0-9]{64})$/',$auth,$m)?$m[1]:($b['_accessToken']??$_COOKIE['esco_workspace']??'');unset($b['_accessToken']);demand(is_string($token),'ログインしてください',401);
 $w=new Workspace($cfg);
 if($action==='drive.configure'){
  $u=$w->tx(function(&$s)use($w,$token){return $w->auth($s,$token);});demand(!empty($u['admin']),'管理者のみ利用できます',403);
  $url=$b['url']??'';$key=$b['key']??'';demand(is_string($url)&&preg_match('~^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$~',$url)&&is_string($key)&&preg_match('/^[a-f0-9-]{72}$/',$key),'接続URLまたはキーの形式を確認してください');
  $f=$cfg['dataDir'].'/drive-gateway.json';file_put_contents($f.'.tmp',json_encode(['gatewayUrl'=>$url,'gatewayKey'=>$key]));chmod($f.'.tmp',0600);rename($f.'.tmp',$f);echo json_encode(['ok'=>true]);exit;
 }
 if($action==='work.run'){set_time_limit(120);ignore_user_abort(true);$u=$w->tx(function(&$s)use($w,$token){return $w->auth($s,$token);});cloudRun($w,null,$u['id']);require_once $private.'/drive.php';$drive=new DrivePublisher($cfg);sharedRun($w,[$drive,'publish'],$u['id'],1);$out=['ok'=>true];}else $out=$w->call($action,$b,$token,$_SERVER['REMOTE_ADDR']??'local');
 if(isset($out['token'])){setcookie('esco_workspace',$out['token'],['expires'=>time()+400*86400,'path'=>$cfg['cookiePath']??'/esco-works/','secure'=>($cfg['secure']??true),'httponly'=>true,'samesite'=>'Strict']);if(empty($b['desktop']))unset($out['token']);}
 if($action==='bootstrap'&&$token)setcookie('esco_workspace',$token,['expires'=>time()+400*86400,'path'=>$cfg['cookiePath']??'/esco-works/','secure'=>($cfg['secure']??true),'httponly'=>true,'samesite'=>'Strict']);
 if($action==='logout')setcookie('esco_workspace','',['expires'=>time()-3600,'path'=>$cfg['cookiePath']??'/esco-works/','secure'=>($cfg['secure']??true),'httponly'=>true,'samesite'=>'Strict']);
 // Authenticated polling is also a worker trigger; cron covers closed browsers.
 if($action==='work.run'){/* reserved */}
 echo json_encode($out,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
 if($action==='chat.send'&&($out['taskId']??null)){if(function_exists('fastcgi_finish_request'))fastcgi_finish_request();}
}catch(ApiError $e){http_response_code($e->status);echo json_encode(['error'=>$e->getMessage()],JSON_UNESCAPED_UNICODE);}
catch(Throwable $e){http_response_code(500);error_log('ESCO workspace: '.$e->getMessage());echo json_encode(['error'=>'サーバーで処理できませんでした。管理者に確認してください。'],JSON_UNESCAPED_UNICODE);}
