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
  'update:status',
  'usage:updated',
  'remote:changed',
  'sessions:changed',
  'history:error',
  'chat:idle', 'session:selected', 'business:status'
]

contextBridge.exposeInMainWorld('escoAI', {
  openWorkspace: () => ipcRenderer.send('workspace:open'),
  init: () => ipcRenderer.invoke('app:init'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  pickFolder: () => ipcRenderer.invoke('folder:pick'),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  interrupt: () => ipcRenderer.send('chat:interrupt'),
  remoteSetMode: (mode) => ipcRenderer.invoke('remote:setMode', mode),
  remoteSetConnectCode: (code) => ipcRenderer.invoke('remote:setConnectCode', code),
  remoteStatus: () => ipcRenderer.invoke('remote:status'),
  remoteQr: () => ipcRenderer.invoke('remote:qr'),
  remoteRevoke: (deviceId) => ipcRenderer.invoke('remote:revoke', deviceId),
  newChat: (input) => ipcRenderer.invoke('chat:new', input),
  updateSession: (input) => ipcRenderer.invoke('sessions:update', input),
  purgeSession: (id) => ipcRenderer.invoke('sessions:purge', id),
  saveProject: (input) => ipcRenderer.invoke('projects:save', input),
  projectFolder: () => ipcRenderer.invoke('projects:folder'),
  businessStatus: () => ipcRenderer.invoke('business:status'),
  businessSync: () => ipcRenderer.invoke('business:sync'),
  businessFolder: () => ipcRenderer.invoke('business:folder'),
  preview: (file) => ipcRenderer.invoke('fs:preview', file),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  openSession: (id) => ipcRenderer.invoke('sessions:open', id),
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
