const { contextBridge, ipcRenderer, webUtils } = require('electron')

const EVENTS = [
  'agent:token',
  'agent:text',
  'agent:tool',
  'agent:done',
  'agent:error',
  'agent:ask',
  'fs:changed',
  'folder:changed',
  'settings:changed',
  'agent:choice',
  'update:status'
]

contextBridge.exposeInMainWorld('escoAI', {
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  addUsage: (usd) => ipcRenderer.invoke('usage:add', usd),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  newChat: () => ipcRenderer.send('chat:new'),
  newWindow: () => ipcRenderer.send('window:new'),
  installUpdate: () => ipcRenderer.send('update:install'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  listDir: (dirPath) => ipcRenderer.invoke('fs:list', dirPath),
  openPath: (p) => ipcRenderer.invoke('fs:open', p),
  respondPermission: (requestId, approved, remember) =>
    ipcRenderer.send('perm:respond', { requestId, approved, remember }),
  respondChoice: (requestId, answer) => ipcRenderer.send('choice:respond', { requestId, answer }),
  on: (event, cb) => {
    if (!EVENTS.includes(event)) return
    ipcRenderer.on(event, (_e, payload) => cb(payload))
  }
})
