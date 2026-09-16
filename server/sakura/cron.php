<?php
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once __DIR__.'/worker.php';require_once __DIR__.'/drive.php';$cfg=require __DIR__.'/config.php';$w=new Workspace($cfg);$lock=fopen($cfg['dataDir'].'/worker.lock','c');if(!flock($lock,LOCK_EX|LOCK_NB))exit;for($i=0;$i<3;$i++)if(!cloudRun($w))break;$drive=new DrivePublisher($cfg);sharedRun($w,[$drive,'publish']);
