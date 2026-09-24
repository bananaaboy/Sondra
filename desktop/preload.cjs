/**
 * The one door from Sondra's page into the app around it: the version, and
 * the updater. Nothing else of Electron or Node reaches the page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sondraApp', {
  updateState: () => ipcRenderer.invoke('sondra:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('sondra:update-check'),
  installUpdate: () => ipcRenderer.invoke('sondra:update-install'),
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('sondra:update', listener)
    return () => ipcRenderer.removeListener('sondra:update', listener)
  },
})
