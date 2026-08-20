# 管理者権限でインストーラーをビルドしGitHubリリースへ公開する。
# winCodeSign内のmac用シンボリックリンク展開に管理者権限が必要なため。
$ErrorActionPreference = 'Continue'
$log = 'C:\Users\k-ima\Desktop\esco-ai\build-elevated.log'
"START $(Get-Date -Format o)" | Out-File $log -Encoding utf8

Set-Location 'C:\Users\k-ima\Desktop\esco-ai'
$gh = "C:\Program Files\GitHub CLI\gh.exe"
$env:GH_TOKEN = (& $gh auth token)
$env:CSC_IDENTITY_AUTO_DISCOVERY = 'false'

"GH_TOKEN set: $([bool]$env:GH_TOKEN)" | Out-File $log -Append -Encoding utf8

# npxはcmd経由で確実に解決させる
& cmd /c "npx electron-builder --win --publish always" *>> $log

"EXITCODE=$LASTEXITCODE" | Out-File $log -Append -Encoding utf8
"DONE $(Get-Date -Format o)" | Out-File $log -Append -Encoding utf8
