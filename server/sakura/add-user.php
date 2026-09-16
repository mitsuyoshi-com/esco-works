<?php
if(PHP_SAPI!=='cli'){http_response_code(404);exit;}
require_once __DIR__.'/app.php';$cfg=require __DIR__.'/config.php';$w=new Workspace($cfg);
$email=$argv[1]??'';$name=$argv[2]??'';$password=getenv('ESCO_NEW_USER_PASSWORD')?:'';
echo $w->addUser($email,$name,$password).PHP_EOL;
