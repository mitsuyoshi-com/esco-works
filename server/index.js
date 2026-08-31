// esco-relay: ESCO Works スマホ連携の中継サーバー。
// スマホ側は ../remote.js のRemoteServer（プロトコル共通）、PC側は pclink.js のWS常駐接続、
// ルーティングは hybridRunner.js（PC接続中→中継 / 切断中→クラウド頭脳）。
//
// 必要な環境変数（/etc/esco-relay/env に置く。systemdのEnvironmentFileで読む）:
//   ESCO_ORG_KEY        組織キー（必須。openssl rand -hex 16 等で生成）
//   ANTHROPIC_API_KEY   クラウド頭脳用のAPIキー（必須。PC配布キーとは別発行を推奨）
//   ESCO_RELAY_URL      公開URL 例 https://relay.example.jp（必須。QRに使う）
//   ESCO_PORT           待受ポート（既定 8787。Caddyの裏の127.0.0.1バインド）
//   ESCO_DATA_DIR       データ保存先（既定 ./data）
//   ESCO_MODEL          クラウド頭脳のモデル（既定 claude-sonnet-5）
const path = require('path')
const fs = require('fs')
const { RemoteServer } = require('../remote.js')
const { Store } = require('./store.js')
const { PcLinkHub } = require('./pclink.js')
const { HybridRunner } = require('./hybridRunner.js')

const CLOUD_MAX_CONCURRENT = 3 // 1GB VPSでのOOM防止（SDKプロセスの並走上限）

/**
 * 中継サーバーを組み立てて起動する。テストからはoverridesでモックを注入できる。
 * @param {object} config { orgKey, apiKey, relayUrl, port, host, dataDir, model }
 * @param {object} [overrides] { createCloudRunner, log }
 */
async function createRelay(config, overrides = {}) {
  const log = overrides.log || ((m) => console.log(m))
  const dataDir = config.dataDir
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const store = new Store(dataDir)

  let cloudActive = 0
  const runners = new Map() // deviceId -> HybridRunner
  let hub = null // 後で生成。runnerには遅延参照のプロキシを渡す
  const hubProxy = {
    send: (pcId, msg) => (hub ? hub.send(pcId, msg) : false),
    isConnected: (pcId) => (hub ? hub.isConnected(pcId) : false)
  }

  // クラウド頭脳: 実AgentRunner（テストではモックに差し替え）
  const defaultCreateCloudRunner = (deviceId) => (emit) => {
    const { AgentRunner } = require('../agent.js')
    const scratch = path.join(dataDir, 'scratch', deviceId.slice(0, 16))
    fs.mkdirSync(scratch, { recursive: true })
    const runner = new AgentRunner({
      getSettings: () => ({
        apiKey: config.apiKey,
        userName: '',
        enableBrowser: false,
        models: { chat: config.model || 'claude-sonnet-5' }
      }),
      emit
    })
    // cwdを焼き込み、強制パラメータを再適用するラッパー
    return {
      startTurn: ({ text }) =>
        runner.startTurn({ text, mode: 'chat', workFolder: null, cwd: scratch, autoApprove: false, permMode: 'readonly' }),
      respondPermission: (...a) => runner.respondPermission(...a),
      respondChoice: (...a) => runner.respondChoice(...a),
      interrupt: () => runner.interrupt(),
      newConversation: () => runner.newConversation()
    }
  }
  const createCloudRunnerFor = overrides.createCloudRunner || defaultCreateCloudRunner

  const makeRunner = (emit, deviceId, meta) =>
    new HybridRunner({
      deviceId,
      pcId: (meta && meta.pcId) || '',
      hub: hubProxy,
      store,
      emit,
      createCloudRunner: createCloudRunnerFor(deviceId),
      acquireCloudSlot: () => {
        if (cloudActive >= CLOUD_MAX_CONCURRENT) return false
        cloudActive++
        return true
      },
      releaseCloudSlot: () => {
        cloudActive = Math.max(0, cloudActive - 1)
      },
      onCloudUsage: (usd) => store.addUsage(usd),
      log
    })

  const remote = new RemoteServer({
    // サーバーでは連携は常時有効。userNameはstateForでデバイス単位に上書き
    getSettings: () => ({ userName: '', remote: { enabled: true } }),
    createRunner: (emit, deviceId, meta) => {
      const r = makeRunner(emit, deviceId, meta)
      runners.set(deviceId, r)
      return r
    },
    scratchDirFor: (deviceId) => {
      const p = path.join(dataDir, 'scratch', String(deviceId).slice(0, 16))
      fs.mkdirSync(p, { recursive: true })
      return p
    },
    staticDir: path.join(__dirname, '..', 'renderer', 'mobile'),
    onSessionCreated: ({ deviceId, token, name, meta }) => {
      store.addDevice({
        deviceId,
        token,
        name,
        pcId: (meta && meta.pcId) || '',
        pairedAt: new Date().toISOString(),
        lastSeen: new Date().toISOString()
      })
      const pcId = (meta && meta.pcId) || ''
      if (pcId) sendDevicesChanged(pcId)
    },
    onDeviceSeen: (deviceId, lastSeen) => store.touchDevice(deviceId, lastSeen),
    stateFor: (deviceId) => {
      const d = store.getDevice(deviceId)
      const pc = d && d.pcId ? store.getPc(d.pcId) : null
      return { userName: (pc && pc.userName) || '', pcOnline: d ? hubProxy.isConnected(d.pcId) : false }
    },
    onRequest: (req, res) => {
      if (req.url === '/healthz') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('ok')
        return true
      }
      return false
    },
    log
  })

  const port = await remote.listen(config.port || 8787, config.host || '127.0.0.1')

  hub = new PcLinkHub({
    server: remote.server,
    orgKey: config.orgKey,
    store,
    log,
    onMessage: (pcId, msg) => handlePcMessage(pcId, msg),
    onConnected: (pcId) => {
      for (const r of runnersForPc(pcId)) r.notifyPcConnected()
      sendDevicesChanged(pcId)
      sendPendingHandoffs(pcId)
    },
    onDisconnected: (pcId) => {
      for (const r of runnersForPc(pcId)) r.notifyPcDisconnected()
    }
  })
  // 永続化済みペアリングを復元（サーバー再起動後もスマホのトークンが生きる）
  for (const d of store.listDevices()) {
    remote.adoptSession({
      deviceId: d.deviceId,
      token: d.token,
      name: d.name,
      meta: { pcId: d.pcId },
      lastSeen: d.lastSeen
    })
  }

  function runnersForPc(pcId) {
    return Array.from(runners.values()).filter((r) => r.pcId === pcId)
  }

  function sendDevicesChanged(pcId) {
    const devices = store.devicesForPc(pcId).map((d) => ({
      deviceId: d.deviceId,
      name: d.name,
      pairedAt: d.pairedAt,
      lastSeen: d.lastSeen,
      pendingHandoff: Math.max(0, (d.convSeq || 0) - (d.handoffAck || 0))
    }))
    hub.send(pcId, { t: 'devices:changed', devices })
  }

  function sendPendingHandoffs(pcId) {
    for (const d of store.devicesForPc(pcId)) {
      const entries = store.pendingHandoff(d.deviceId)
      if (entries.length) hub.send(pcId, { t: 'handoff', deviceId: d.deviceId, entries })
    }
  }

  function handlePcMessage(pcId, msg) {
    switch (msg.t) {
      case 'hello': {
        store.upsertPc({ pcId, userName: String(msg.userName || '').slice(0, 60) })
        sendDevicesChanged(pcId)
        sendPendingHandoffs(pcId)
        break
      }
      case 'pair:issue': {
        const code = remote.regeneratePairCode({ pcId })
        hub.send(pcId, {
          t: 'pair:code',
          code,
          url: `${config.relayUrl}/#p=${code}`,
          expiresAt: Date.now() + 10 * 60 * 1000
        })
        break
      }
      case 'event': {
        // PC側runnerのイベントをスマホへ。deviceIdがこのPCのものであることを必ず検証
        const d = store.getDevice(String(msg.deviceId || ''))
        if (!d || d.pcId !== pcId) return
        const r = runners.get(d.deviceId)
        if (r) r.handlePcEvent(String(msg.ev || ''), msg.payload || {})
        break
      }
      case 'revoke': {
        const d = store.getDevice(String(msg.deviceId || ''))
        if (!d || d.pcId !== pcId) return
        remote.revokeDevice(d.deviceId)
        runners.delete(d.deviceId)
        store.removeDevice(d.deviceId)
        sendDevicesChanged(pcId)
        break
      }
      case 'handoff:ack': {
        const d = store.getDevice(String(msg.deviceId || ''))
        if (!d || d.pcId !== pcId) return
        store.setHandoffAck(d.deviceId, Number(msg.upto) || 0)
        sendDevicesChanged(pcId)
        break
      }
      default:
        break
    }
  }

  log(`[relay] listening on ${config.host || '127.0.0.1'}:${port}`)
  return {
    port,
    remote,
    hub,
    store,
    close() {
      hub.close()
      remote.close()
      store.saveNow()
    }
  }
}

/* --- 直接起動（systemdから） --- */
if (require.main === module) {
  const cfg = {
    orgKey: process.env.ESCO_ORG_KEY,
    apiKey: process.env.ANTHROPIC_API_KEY,
    relayUrl: (process.env.ESCO_RELAY_URL || '').replace(/\/$/, ''),
    port: parseInt(process.env.ESCO_PORT || '8787', 10),
    dataDir: process.env.ESCO_DATA_DIR || path.join(__dirname, 'data'),
    model: process.env.ESCO_MODEL || 'claude-sonnet-5'
  }
  if (!cfg.orgKey || !cfg.apiKey || !cfg.relayUrl) {
    console.error('[relay] ESCO_ORG_KEY / ANTHROPIC_API_KEY / ESCO_RELAY_URL を環境変数で設定してください')
    process.exit(1)
  }
  createRelay(cfg).catch((e) => {
    console.error('[relay] start failed:', e && e.message)
    process.exit(1)
  })
  process.on('SIGTERM', () => process.exit(0))
}

module.exports = { createRelay, CLOUD_MAX_CONCURRENT }
