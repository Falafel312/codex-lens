const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('codexLens', {
  getState: () => ipcRenderer.invoke('state:get'),
  signIn: () => ipcRenderer.invoke('account:sign-in'),
  approveAccount: () => ipcRenderer.invoke('account:approve'),
  signOut: () => ipcRenderer.invoke('account:sign-out'),
  retryRelay: () => ipcRenderer.invoke('relay:retry'),
  onState: callback => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('state:changed', listener)
    return () => ipcRenderer.removeListener('state:changed', listener)
  },
})
