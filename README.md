# ESCO Works（v0.4.0〜）

エスココーポレーション社員向けの社内AIアシスタント。v0.4.0 から、画面と頭脳は社内のクラウド版に移りました。
このアプリ（Windows インストール型）は、クラウド版の画面を表示する「殻」です。ウィンドウ・アイコン・自動更新・初回のログインと過去の会話の引き継ぎだけを担当します。

> 旧版（v0.3.4 まで・Claude 直結・PCのファイル操作あり）は使用停止中です。Git タグ `legacy-esco-works-v0.3.4-claude-direct` から復元できます。

## 構成
| ファイル | 役割 |
|---|---|
| `main.js` | ウィンドウ・権限・ダウンロード・自動ログインと取り込みの進行 |
| `config.js` | 接続先（環境変数 `ESCO_WORKS_URL` で上書き可）・初回ログイン用の鍵の読み込み |
| `nameMatch.js` / `login.js` | 旧設定の名前と名簿の照合・自動ログイン |
| `legacy.js` / `importer.js` | 旧データ（sessions・projects・business）の読み取り・分割送信・受領確認・受領書 |
| `updater.js` | GitHub Releases からの自動更新（1時間ごと・夜間3〜5時に適用） |
| `shell/offline.html` | 通信できないときの案内ページ |

## 開発・確認
```
npm install
npm test          # 名前照合・取り込み・殻の総合テスト（すべて自動・画面なし・モックサーバーのみ）
npm start         # 実際に起動（本番の接続先へつながる。普段は使わない）
```

## 配布ビルド（必ず x64）
```
npm run dist      # = electron-builder --win --x64（--publish never を付けて手元で確認してから公開する）
```
- 初回ログイン用の鍵は、ビルド前に `build/join-key.txt` に置く（Git には入れない・`.gitignore` 済み）。無い場合は自動ログインせず、Web のログイン画面を表示する。
- 公開は GitHub Releases（`latest.yml` を含める）。社員のPCは夜間に自動更新される。
