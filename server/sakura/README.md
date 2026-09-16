# スマホ・PC同期ワークスペース

## 配置
- `server/sakura/*.php` のアプリコード、config.php、SQLiteは公開ディレクトリの外へ配置する。
- 公開先には `public/api.php` と `renderer/workspace/*` だけを置く。
- PHP 8.3、PDO SQLite、curl、mbstring、HTTPSが必要。
- 既存サイトとPHPバージョンを共有しない場合は、専用ディレクトリのCGIハンドラーで分離する。
- `config.example.php` を非公開のconfig.phpへコピーし、APIキーを設定する。秘密情報をGitへ登録しない。

## アカウント・同期
- 初期管理者は、非公開DBに1回限りの招待（invites: SHA256(code), email, admin, expires）を作り、本人がWeb画面の `#invite=...` で登録する。
- 管理者が社員のメールを指定して招待リンクを発行できる。期限24時間、再使用不可。
- PCアプリの「スマホ・PC同期」から同じアカウントへログイン。スマホQRは2分・1回限り。
- 既存ローカル履歴は明示的に取り込む。同じIDの再取り込みでは重複・上書きしない。
- PC実行フォルダはPC側で選択する。スマホから任意のローカルパスは指定できない。
- PCの処理権限が期限切れになったタスクは自動再実行せず、中断と表示する。結果確認後に再依頼する。

## Google共有保存
- OAuth refresh token方式、または `server/google-drive/Code.gs` の専用Apps Scriptゲートウェイを利用できる。
- Apps ScriptのフォルダIDを管理者の非公開プロジェクト内で設定する。公開Gitには実フォルダIDを置かない。
- 管理者がGoogleの許可を確認してinitializeを実行し、所有者として実行するWebアプリにデプロイする。署名のないリクエストは保存しない。
- ESCO Works管理者画面の「共有フォルダの接続」でURLと接続キーを設定する。キーはサーバーの非公開領域に保持する。
- 入力原文を先に保存し、AIが整理した事実・不明点・改善案を別々にMD化する。
- 自動生成部分のみ更新。手動追記は保持し、自動生成部分の手動変更は競合として停止する。更新前の内容はDrive内に退避する。
- スマホを閉じた後の再試行にはcron.phpを利用。さくら共有サーバーの負荷制限に従う。

## 検証
- `node test/cloud-workspace.cjs`: HTTP API、アカウント分離、招待、再送、競合、承認、QR、完全削除。
- `node test/cloud-drive.cjs`: 署名、上書き、手動追記保持、競合、パストラバーサル。
- `node test/cloud-workspace.cjs --serve` の後、Electronで `test/cloud-ui.cjs`: PC・スマホ間の承認と履歴同期、スマホ幅のレイアウト。
- 既存テスト: sessions-test.cjs / workspace-test.cjs / workspace-ui.cjs。
- 実際のGoogle許可・MD保存・再起動後同期が完了するまで「完全に本番化済み」と扱わない。
