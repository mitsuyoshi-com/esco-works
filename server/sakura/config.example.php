<?php
// Copy privately to config.php. Do not place credentials inside www or git.
return [
 'dataDir'=>__DIR__.'/data',
 'origin'=>'https://YOUR-HOST',
 'cookiePath'=>'/esco-works/',
 'secure'=>true,
 'apiKey'=>getenv('ANTHROPIC_API_KEY')?:'',
 'model'=>'claude-sonnet-5',
 'drive'=>['folderId'=>'','clientId'=>'','clientSecret'=>'','refreshToken'=>'']
];
