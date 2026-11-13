// クラウドのチャット画面に渡す、ごく小さな窓口（v0.5.0〜）。
// 渡すのは「エージェントを使える人か」の問い合わせと「エージェントの画面を開く」の合図だけ。
// キーやファイルの中身など、PC側の情報はここを通らない。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('escoShell', {
  agentStatus: () => ipcRenderer.invoke('shell:agent-status'),
  openAgent: () => ipcRenderer.send('shell:open-agent')
})
