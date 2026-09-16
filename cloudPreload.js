const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('escoWorkspace', { request: (action,body) => ipcRenderer.invoke('workspace:request',action,body) })
