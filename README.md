# エスコAIアシスタント (esco-ai)

エスココーポレーション社員向けの社内AIデスクトップアプリ。
Claude Agent SDK × Electron。CLIを知らない社員でもチャット画面だけで
「相談・文章作成」「提案資料の作成」「フォルダ整理・リネーム」ができる。

## 起動（開発）

```
cd C:\Users\k-ima\Desktop\esco-ai
npm start
```

スモークテスト（GUIなしでSDK疎通確認）: `npm run smoke`

## 配布用ビルド（ポータブルexe）

```
npm run dist
```

→ `dist/` に単一exeができる。社員のPCにはこれを配るだけ（インストール不要）。

## 仕組み

- `main.js` — Electronメイン。ウィンドウ・IPC・設定・作業フォルダ管理
- `agent.js` — Claude Agent SDKの実行（AI-Buddyの実証済みパターンを簡略化して流用）
- `settings.js` — 設定(userData/settings.json)と月間利用額(usage.json)の保存
- `renderer/` — チャットUI（バニラJS、ビルド不要）

## モードとモデル

| モード | 内容 | 既定モデル |
|---|---|---|
| チャット | 相談・文章下書き | claude-sonnet-5 |
| 資料作成 | 提案書等を作業フォルダにファイル保存 | claude-sonnet-5 |
| フォルダ整理 | 📁で選んだフォルダ内の分類・リネーム（削除はせず`_不要`へ移動） | claude-sonnet-5 |

モデルはモードごとに⚙設定で変更可（Haiku 4.5 / Sonnet 5 / Opus 5）。

## 並行作業と資料の渡し方

- **🪟 新しいウィンドウ** — ウィンドウごとに独立した会話・作業フォルダ・AI実行。
  複数案件を同時に進められる（Claude Codeの複数ターミナルと同じ感覚）
- **ドラッグ&ドロップ** — PDF等を画面に落とすと「（ファイル: パス）」が入力欄に入る。
  「この資料を要約して提案書にして」のような依頼ができる（作業フォルダ外のファイルも読み取りは可）

## 安全設計

- 読み取り系ツールのみ自動許可。書き込みは作業フォルダ内のみ自動許可
- Bashは危険パターン（shutdown/format/全消し等）を拒否。
  「ファイル操作を自動許可」チェック（フォルダ整理モードで既定ON）がOFFなら都度確認バー表示
- WebSearch/WebFetchは無効化（社内利用の想定外動作を防ぐ）
- `settingSources: []` でこのPCのCLAUDE.md等は読み込まない

## APIキー

- ⚙設定から入力 → userDataのsettings.jsonに保存（PCごと）
- 未設定の場合、このPCではClaude Codeのログイン認証にフォールバックする
  （＝開発中は光強代表の課金。**北山社長のConsoleでキーを発行したら必ず設定すること**）
- 費用表示は `result.total_cost_usd` の積算（概算・レート150円/$固定表示）

## 未実装・次のステップ

- [ ] 北山社長のAnthropic Consoleアカウント作成 → APIキー差し替え（電話待ち）
- [ ] 社員ごとのキー/ワークスペース分け（Consoleで人別に発行して個別集計）
- [ ] `npm run dist` でexe化して配布テスト
- [ ] 実利用フィードバックでプロンプト調整
