<?php
require_once __DIR__.'/app.php';
function requestJson($url,$body,$headers=[],$method='POST',$timeout=50){
 if(!array_filter($headers,fn($h)=>stripos($h,'Content-Type:')===0))$headers[]='Content-Type: application/json';
 $ch=curl_init($url);curl_setopt_array($ch,[CURLOPT_CUSTOMREQUEST=>$method,CURLOPT_RETURNTRANSFER=>true,CURLOPT_TIMEOUT=>$timeout,CURLOPT_CONNECTTIMEOUT=>10,CURLOPT_HTTPHEADER=>$headers]);if($body!==null)curl_setopt($ch,CURLOPT_POSTFIELDS,is_string($body)?$body:json_encode($body));$raw=curl_exec($ch);$status=curl_getinfo($ch,CURLINFO_HTTP_CODE);$err=curl_error($ch);curl_close($ch);if($raw===false)throw new RuntimeException('外部サービスとの通信に失敗しました');$j=json_decode($raw,true);if($status<200||$status>=300)throw new RuntimeException('外部サービスの応答エラー ('.$status.')');return $j??$raw;
}
function businessPrompt($business){return '社員本人の業務を整理してください。本人が述べた事実はfacts、不明点はunknown、AI提案はideas。既存業務は同じidで既存の事実を保持し、本人の明示訂正を反映してください。確認は少数にし、回答末尾に必ず ```json コードブロックで {"escoBusiness":1,"jobs":[{"id":"既存idか新規は空文字","title":"業務名","facts":["事実"],"unknown":[],"ideas":[]}]} を返してください。保存処理はシステムが行います。既存業務:'.json_encode($business['jobs']??[],JSON_UNESCAPED_UNICODE);}
function cloudRun($w,$invoke=null,$owner=null){
 $task=$w->tx(function(&$s)use($owner){$running=0;foreach($s['tasks'] as $t)if($t['route']==='cloud'&&$t['status']==='running'&&$t['deadline']>time())$running++;if($running>=3)return null;foreach($s['tasks'] as &$t){if($t['route']==='cloud'&&$t['status']==='queued'&&(!$owner||$t['userId']===$owner)){$t['status']='running';$t['deadline']=time()+100;return $t+['business'=>$s['business'][$t['userId']]??[]];}}return null;});if(!$task)return false;
 try{
  $messages=[];foreach($task['history'] as $m)if(in_array($m['role'],['user','ai']))$messages[]=['role'=>$m['role']==='ai'?'assistant':'user','content'=>$m['text']];$messages[]=['role'=>'user','content'=>$task['text']];
  $system='あなたはESCO Worksの社内アシスタントです。日本語で簡潔に答えてください。現在はクラウド相談モードです。PCファイルの操作はできません。必要なら「PCで実行」に切り替えて依頼するよう案内してください。';
  $system.=$task['kind']==='business'?businessPrompt($task['business']):$task['instructions'];
  $result=$invoke?$invoke($messages,$system):requestJson('https://api.anthropic.com/v1/messages',['model'=>$w->cfg['model']??'claude-sonnet-5','max_tokens'=>7000,'system'=>$system,'messages'=>$messages],['x-api-key: '.$w->cfg['apiKey'],'anthropic-version: 2023-06-01']);
  $text='';foreach($result['content']??[] as $block)if(($block['type']??'')==='text')$text.=$block['text'];if(!$text)throw new RuntimeException('AIから本文が返りませんでした');
  $w->tx(function(&$s)use($task,$text){$t=&$s['tasks'][$task['id']];if($t['status']!=='running')return;if(!empty($t['cancel'])){$t['status']='cancelled';return;}$x=&$s['sessions'][$task['sessionId']];$x['messages'][]=['role'=>'ai','text'=>$text,'at'=>stamp(),'taskId'=>$task['id']];$x['revision']++;$x['updatedAt']=stamp();$t['status']='done';
   if($task['kind']==='business'){$b=&$s['business'][$task['userId']];$parsed=null;preg_match_all('/```json\s*([\s\S]*?)```/',$text,$matches);foreach($matches[1] as $m){$j=json_decode($m,true);if(($j['escoBusiness']??0)===1&&is_array($j['jobs']??null))$parsed=$j;}if(!$parsed){$b['status']='入力は保存済み・AI整理を再試行してください';return;}foreach(array_slice($parsed['jobs'],0,30) as $job){if(!is_string($job['title']??null)||!trim($job['title']))continue;$id=isset($b['jobs'][$job['id']??''])?$job['id']:substr(hash('sha256',$job['title']),0,16);$j=['id'=>$id,'title'=>mb_substr($job['title'],0,120),'updatedAt'=>stamp()];foreach(['facts','unknown','ideas'] as $key)$j[$key]=array_slice(array_values(array_filter($job[$key]??[],'is_string')),0,150);$b['jobs'][$id]=$j;}$b['revision']++;$b['status']='共有先へ保存待ち';}
  });
 }catch(Throwable $e){$w->tx(function(&$s)use($task,$e){$t=&$s['tasks'][$task['id']];$t['status']='failed';$t['error']=$e->getMessage();});}
 return true;
}
function markdownFiles($name,$business){
 $files=['入力記録.md'=>'# '.$name."さんの入力記録\n\n",'業務一覧.md'=>'# '.$name."さんの業務一覧\n\n"];
 foreach($business['entries'] as $e)$files['入力記録.md'].='## '.$e['at']."\n\n".$e['text']."\n\n";
 foreach($business['jobs'] as $j){$filename=preg_replace('/[<>:"\/\\\\|?*\x00-\x1f]/u','_',mb_substr($j['title'],0,60)).'_'.$j['id'].'.md';$files['業務一覧.md'].='- ['.str_replace(['[',']'],'',$j['title']).'](業務/'.rawurlencode($filename).")\n";$body='# '.$j['title']."\n\n担当: ".$name."\n更新: ".$j['updatedAt']."\n\n";foreach(['facts'=>'本人の説明に基づく業務内容','unknown'=>'未確認事項','ideas'=>'AIによる改善案（未承認）'] as $key=>$label)$body.='## '.$label."\n- ".implode("\n- ",$j[$key]?:['なし'])."\n\n";$files['業務/'.$filename]=$body;}
 return $files;
}
function sharedRun($w,$publisher,$owner=null,$limit=3){
 $batch=$w->tx(function(&$s)use($owner,$limit){$out=[];foreach($s['business'] as $id=>$b)if((!$owner||$owner===$id)&&($b['sharedRevision']??0)<$b['revision'])$out[]=['id'=>$id,'name'=>$s['users'][$id]['name'],'business'=>$b];usort($out,fn($a,$b)=>($a['business']['lastAttempt']??0)<=>($b['business']['lastAttempt']??0));$out=array_slice($out,0,$limit);foreach($out as $b)$s['business'][$b['id']]['lastAttempt']=time();return $out;});
 foreach($batch as $b){try{$publisher($b['id'],markdownFiles($b['name'],$b['business']));$w->tx(function(&$s)use($b){$v=&$s['business'][$b['id']];$v['sharedRevision']=$b['business']['revision'];$v['status']=$v['revision']===$v['sharedRevision']?'共有フォルダに保存済み':'新しい入力の保存待ち';});}catch(Throwable $e){$w->tx(function(&$s)use($b,$e){$s['business'][$b['id']]['status']='サーバーに保存済み・共有待ち: '.$e->getMessage();});}}
}
