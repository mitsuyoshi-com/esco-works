// テスト用のにせエージェント：Anthropic には一切つながず、決まった応答と利用額の通知だけを出す。
// 受け取ったキーを記録して、殻がサーバーからのキーを渡しているかを確かめられるようにする。
const fs = require('node:fs')

function factory({ getSettings, emit }) {
  return {
    sessionId: undefined, sessionCwd: undefined,
    async startTurn({ text, mode }) {
      const s = getSettings()
      if (process.env.ESCO_TEST_RUNNER_LOG) fs.appendFileSync(process.env.ESCO_TEST_RUNNER_LOG, JSON.stringify({ text, mode, apiKey: s.apiKey, model: s.models && s.models[mode] }) + '\n')
      if (process.env.ESCO_TEST_RUNNER_TEXT) { emit('agent:tool', { tool: 'Reading files' }); emit('agent:tool', { tool: 'Writing files' }) }
      emit('agent:token', { delta: process.env.ESCO_TEST_RUNNER_TEXT || 'にせの応答です。' })
      if (process.env.ESCO_TEST_RUNNER_ABORT === '1') {
        // 途中で止めた回：金額は届かず、トークン数だけが分かる
        emit('agent:usage', { costUsd: 0, estimated: true, model: 'claude-sonnet-5-5', mode, turns: 1, durationMs: 500, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 0 })
      } else {
        emit('agent:usage', { costUsd: 0.42, estimated: false, model: 'claude-sonnet-5-5', mode, turns: 3, durationMs: 1500, inputTokens: 9000, outputTokens: 2000, cacheReadTokens: 100, cacheWriteTokens: 50 })
      }
      emit('agent:done', { costUsd: 0.42, durationMs: 1500 })
    },
    interrupt() {}, newConversation() {}, respondPermission() {}, respondChoice() {}
  }
}

module.exports = { factory }
