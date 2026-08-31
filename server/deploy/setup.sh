#!/bin/bash
# esco-relay セットアップスクリプト（Ubuntu 22.04/24.04想定・冪等・rootで実行）
# 使い方: DOMAIN=relay.example.jp bash setup.sh
set -euo pipefail

DOMAIN="${DOMAIN:?DOMAIN=relay.example.jp のようにドメインを指定してください}"
REPO_URL="${REPO_URL:-https://github.com/mitsuyoshi-com/esco-works.git}"
APP_DIR=/opt/esco-relay
DATA_DIR=/var/lib/esco-relay
ENV_FILE=/etc/esco-relay/env

echo "== [1/7] Node.js 22 =="
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

echo "== [2/7] Caddy（自動TLS） =="
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

echo "== [3/7] swap 2GB（1GB RAM VPSでのSDK並走対策） =="
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== [4/7] サービスユーザーとコード配置 =="
id -u esco >/dev/null 2>&1 || useradd --system --home "$DATA_DIR" --shell /usr/sbin/nologin esco
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" pull --ff-only
else
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR" && npm ci --omit=dev
mkdir -p "$DATA_DIR" && chown -R esco:esco "$DATA_DIR" && chmod 700 "$DATA_DIR"

echo "== [5/7] 環境変数（初回のみ雛形生成） =="
mkdir -p "$(dirname "$ENV_FILE")"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
# esco-relay 環境変数（このファイルは600権限・リポジトリに入れない）
ESCO_ORG_KEY=$(openssl rand -hex 16)
ANTHROPIC_API_KEY=sk-ant-ここにサーバー専用キーを設定
ESCO_RELAY_URL=https://$DOMAIN
ESCO_PORT=8787
ESCO_DATA_DIR=$DATA_DIR
ESCO_MODEL=claude-sonnet-5
EOF
  chmod 600 "$ENV_FILE"
  echo "!! $ENV_FILE の ANTHROPIC_API_KEY を実キーに書き換えてください"
fi

echo "== [6/7] systemd =="
cp "$APP_DIR/server/deploy/esco-relay.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now esco-relay

echo "== [7/7] Caddy =="
cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    reverse_proxy 127.0.0.1:8787
}
EOF
systemctl reload caddy

echo "== 完了 =="
echo "1. $ENV_FILE の ANTHROPIC_API_KEY を設定 → systemctl restart esco-relay"
echo "2. 接続コード生成: cd $APP_DIR && node server/scripts/make-connect-code.mjs"
echo "3. 動作確認:       cd $APP_DIR && node server/scripts/selfcheck.mjs"
