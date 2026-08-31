# esco-relay — ESCO Works スマホ連携の中継サーバー

スマホ（固定URL・SSE）と各社員PCのESCO Works（外向きWS常駐）を仲介する。
PC起動中はPCへ中継（フル機能）、PC停止中はサーバー上のクラウド頭脳（readonly）がチャットのみ代打する。

## 構成

- `index.js` — 起動配線。`../remote.js`（スマホ側プロトコル・PCアプリと共用）+ `pclink.js`（PC側WS）+ `hybridRunner.js`（ルート判定）
- `store.js` — JSON永続化（ペアリング・トークン・クラウド会話・利用額）
- 頭脳は `../agent.js` の AgentRunner をそのままLinuxで実行（`permMode:'readonly'` 固定）

## デプロイ（Ubuntu VPS・rootで）

```bash
git clone https://github.com/mitsuyoshi-com/esco-works.git /opt/esco-relay
DOMAIN=relay.example.jp bash /opt/esco-relay/server/deploy/setup.sh
vi /etc/esco-relay/env   # ANTHROPIC_API_KEY をサーバー専用キーに
systemctl restart esco-relay
node /opt/esco-relay/server/scripts/selfcheck.mjs          # 疎通確認（--full で実1ターン）
node /opt/esco-relay/server/scripts/make-connect-code.mjs  # PCに配る接続コードを生成
```

DNS: ドメインのAレコードをVPSのIPに向けておく（Caddyが自動でTLS証明書を取る）。

## 運用

- 更新: `cd /opt/esco-relay && git pull && npm ci --omit=dev && systemctl restart esco-relay`
- ログ: `journalctl -u esco-relay -f`
- 死活監視: `https://<ドメイン>/healthz`（UptimeRobot等の無料監視を推奨）
- 秘密の場所: `/etc/esco-relay/env`（600）と `/var/lib/esco-relay/state.json`（600）。**リポジトリに入れない**
- 組織キーの回転: envの `ESCO_ORG_KEY` を変更 → restart → 接続コードを再生成して各PCに再配布

## ローカル開発

```bash
ESCO_ORG_KEY=$(openssl rand -hex 16) ANTHROPIC_API_KEY=sk-... \
ESCO_RELAY_URL=http://127.0.0.1:8787 ESCO_DATA_DIR=./server/data node server/index.js
```

プロトコル検証（APIコスト0）: `npm run relay-sim`
