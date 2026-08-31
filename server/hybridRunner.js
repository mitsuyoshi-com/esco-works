// スマホ1台ぶんの実行ルーター。remote.jsのrunnerインターフェース
// （startTurn/respondPermission/respondChoice/interrupt/newConversation）を実装し、
//  - ペアリング先PCがWS接続中 → PCへ中継（PC上のAgentRunnerがフル機能で応答）
//  - PC切断中               → サーバー上のクラウドAgentRunner（readonly固定）が代打
// ルートはターン開始時に決定し、ターン途中では切り替えない。
const PC_DISCONNECT_GRACE_MS = parseInt(process.env.ESCO_PC_GRACE_MS || '20000', 10) // ターン実行中のWS瞬断をどこまで待つか（テストでは短縮可）
// クラウドターンの上限時間。APIキー不備等でSDKが無応答のままハングすると
// busyと実行枠を永久に占有するため、強制的に中断する（正常応答は通常1分未満）
const CLOUD_TURN_TIMEOUT_MS = parseInt(process.env.ESCO_CLOUD_TURN_TIMEOUT_MS || '180000', 10)

class HybridRunner {
  /**
   * @param {object} deps
   * @param {string} deps.deviceId
   * @param {string} deps.pcId ペアリング先PC
   * @param {object} deps.hub PcLinkHub
   * @param {object} deps.store Store
   * @param {(ev: string, payload: object) => void} deps.emit スマホのSSEへ
   * @param {(emit: Function) => object} deps.createCloudRunner クラウドAgentRunnerの生成（テストではモック注入）
   * @param {() => boolean} deps.acquireCloudSlot クラウド同時実行枠の取得（falseなら満杯）
   * @param {() => void} deps.releaseCloudSlot
   * @param {(costUsd: number) => void} [deps.onCloudUsage]
   * @param {(msg: string) => void} [deps.log]
   */
  constructor({ deviceId, pcId, hub, store, emit, createCloudRunner, acquireCloudSlot, releaseCloudSlot, onCloudUsage, log }) {
    this.deviceId = deviceId
    this.pcId = pcId
    this.hub = hub
    this.store = store
    this.emit = emit
    this.createCloudRunner = createCloudRunner
    this.acquireCloudSlot = acquireCloudSlot || (() => true)
    this.releaseCloudSlot = releaseCloudSlot || (() => {})
    this.onCloudUsage = onCloudUsage || (() => {})
    this.log = log || (() => {})
    this.active = null // null | 'pc' | 'cloud'
    this.cloudRunner = null
    this._turnResolve = null // PCルートのターン完了resolve
    this._graceTimer = null
    this._cloudText = '' // クラウド応答の本文（会話ログ用）
  }

  /* --- remote.js runnerインターフェース --- */

  async startTurn({ text }) {
    const viaPc = this.hub.isConnected(this.pcId)
    this.emit('relay:route', { via: viaPc ? 'pc' : 'cloud' })
    if (viaPc) return this.startPcTurn(text)
    return this.startCloudTurn(text)
  }

  respondPermission(requestId, approved, remember) {
    if (this.active === 'pc') {
      this.hub.send(this.pcId, { t: 'perm', deviceId: this.deviceId, requestId, approved: !!approved, remember: !!remember })
    } else if (this.cloudRunner) {
      this.cloudRunner.respondPermission(requestId, approved, remember)
    }
  }

  respondChoice(requestId, answer) {
    if (this.active === 'pc') {
      this.hub.send(this.pcId, { t: 'choice', deviceId: this.deviceId, requestId, answer })
    } else if (this.cloudRunner) {
      this.cloudRunner.respondChoice(requestId, answer)
    }
  }

  interrupt() {
    if (this.active === 'pc') {
      this.hub.send(this.pcId, { t: 'interrupt', deviceId: this.deviceId })
    }
    if (this.cloudRunner) this.cloudRunner.interrupt()
  }

  newConversation() {
    this.hub.send(this.pcId, { t: 'new', deviceId: this.deviceId }) // 切断中はfalseで無害
    if (this.cloudRunner) this.cloudRunner.newConversation()
  }

  /* --- PCルート --- */

  startPcTurn(text) {
    this.active = 'pc'
    return new Promise((resolve) => {
      this._turnResolve = resolve
      const sent = this.hub.send(this.pcId, { t: 'turn', deviceId: this.deviceId, text })
      if (!sent) {
        // isConnected直後に切れた稀なケース
        this.finishPcTurn('agent:error', { message: 'パソコンとの接続が切れました。もう一度送ってください。' })
      }
    })
  }

  /** PCから返ってきたイベント（index.jsのWSディスパッチから呼ばれる） */
  handlePcEvent(ev, payload) {
    if (this.active !== 'pc') return
    this.emit(ev, payload)
    if (ev === 'agent:done' || ev === 'agent:error') this.finishPcTurn(null)
  }

  finishPcTurn(finalEv, finalPayload) {
    if (finalEv) this.emit(finalEv, finalPayload)
    clearTimeout(this._graceTimer)
    this._graceTimer = null
    this.active = null
    const resolve = this._turnResolve
    this._turnResolve = null
    if (resolve) resolve()
  }

  /** PCのWSが切れた（瞬断は猶予・復帰しなければターンをエラー終了してハングを防ぐ） */
  notifyPcDisconnected() {
    if (this.active !== 'pc' || this._graceTimer) return
    this._graceTimer = setTimeout(() => {
      this._graceTimer = null
      if (this.active === 'pc') {
        this.log(`[hybrid] pc lost mid-turn: ${this.deviceId.slice(0, 8)}`)
        this.finishPcTurn('agent:error', {
          message: 'パソコンとの接続が切れました。もう一度送ると、サーバーが代わりに応答します。'
        })
      }
    }, PC_DISCONNECT_GRACE_MS)
  }

  notifyPcConnected() {
    // 猶予中の復帰: PC側のAgentRunnerは生きているのでイベントは再び流れてくる
    clearTimeout(this._graceTimer)
    this._graceTimer = null
  }

  /* --- クラウドルート --- */

  async startCloudTurn(text) {
    if (!this.acquireCloudSlot()) {
      this.emit('agent:error', { message: 'サーバーが混み合っています。少し待ってからもう一度お試しください。' })
      return
    }
    this.active = 'cloud'
    this._cloudText = ''
    if (!this.cloudRunner) {
      this.cloudRunner = this.createCloudRunner((ev, payload) => this.handleCloudEvent(ev, payload))
    }
    this.store.appendConversation(this.deviceId, 'user', text)
    // ハング対策: 上限時間で強制中断。abortすら効かない場合もraceで抜けて枠とbusyを必ず返す
    let timer = null
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => resolve('timeout'), CLOUD_TURN_TIMEOUT_MS)
    })
    try {
      // 安全弁: readonly固定（承認カード自体が出ない）・workFolderなし
      const turn = this.cloudRunner.startTurn({
        text,
        mode: 'chat',
        workFolder: null,
        cwd: undefined, // createCloudRunner側でcwdを焼き込む（index.js参照）
        autoApprove: false,
        permMode: 'readonly'
      })
      const result = await Promise.race([turn, timeout])
      if (result === 'timeout') {
        this.log(`[hybrid] cloud turn timeout: ${this.deviceId.slice(0, 8)}`)
        this.cloudRunner.interrupt() // 効けばゾンビターンはagent:done(cost0)で静かに閉じる
        this.emit('agent:error', { message: 'サーバーの応答がタイムアウトしました。しばらくしてからもう一度お試しください。' })
      }
    } finally {
      clearTimeout(timer)
      this.releaseCloudSlot()
      if (this._cloudText) this.store.appendConversation(this.deviceId, 'assistant', this._cloudText)
      this._cloudText = ''
      this.active = null
    }
  }

  handleCloudEvent(ev, payload) {
    if (ev === 'agent:token') this._cloudText += payload.delta || ''
    if (ev === 'agent:text') this._cloudText = payload.text || ''
    if (ev === 'agent:done' && payload && payload.costUsd > 0) this.onCloudUsage(payload.costUsd)
    this.emit(ev, payload)
  }
}

module.exports = { HybridRunner, PC_DISCONNECT_GRACE_MS }
