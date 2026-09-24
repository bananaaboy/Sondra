/**
 * The one door from Sondra's page into the app around it: the version, the
 * updater, and files Windows opened with Sondra. Nothing else of Electron or
 * Node reaches the page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sondraApp', {
  updateState: () => ipcRenderer.invoke('sondra:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('sondra:update-check'),
  installUpdate: () => ipcRenderer.invoke('sondra:update-install'),
  takeOpenedFiles: () => ipcRenderer.invoke('sondra:take-files'),
  onOpenedFiles: (callback) => {
    const listener = (_event, files) => callback(files)
    ipcRenderer.on('sondra:files', listener)
    return () => ipcRenderer.removeListener('sondra:files', listener)
  },
  onUpdate: (callback) => {
    const listener = (_event, state) => callback(state)
    ipcRenderer.on('sondra:update', listener)
    return () => ipcRenderer.removeListener('sondra:update', listener)
  },
})
