/**
 * The one door from Sondra's page into the app around it: the version, the
 * updater, files Windows opened with Sondra, the screens and windows there
 * are to record, the Merkliste's link to Anytype (one action at a time,
 * never the key) and the sign-in to Google Drive (an access token when asked,
 * never the refresh token). Nothing else of Electron or Node reaches the page.
 */

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('sondraApp', {
  updateState: () => ipcRenderer.invoke('sondra:update-state'),
  checkForUpdates: () => ipcRenderer.invoke('sondra:update-check'),
  installUpdate: () => ipcRenderer.invoke('sondra:update-install'),
  takeOpenedFiles: () => ipcRenderer.invoke('sondra:take-files'),
  captureSources: () => ipcRenderer.invoke('sondra:capture-sources'),
  pickCaptureSource: (id, audio) => ipcRenderer.invoke('sondra:capture-pick', id, audio),
  anytype: (action, ...args) => ipcRenderer.invoke('sondra:anytype', action, ...args),
  drive: (action, ...args) => ipcRenderer.invoke('sondra:drive', action, ...args),
  setDiscordPresence: (activity) => ipcRenderer.invoke('sondra:discord-presence', activity),
  setDiscordEnabled: (enabled) => ipcRenderer.invoke('sondra:discord-enabled', enabled),
  setAlwaysOnTop: (flag) => ipcRenderer.invoke('sondra:always-on-top', flag),
  isAlwaysOnTop: () => ipcRenderer.invoke('sondra:is-always-on-top'),
  focusWindow: () => ipcRenderer.invoke('sondra:focus'),
  notify: (title, body) => ipcRenderer.invoke('sondra:notify', title, body),
  getDownloadDir: () => ipcRenderer.invoke('sondra:get-download-dir'),
  pickDownloadDir: () => ipcRenderer.invoke('sondra:pick-download-dir'),
  setProgressBar: (progress) => ipcRenderer.invoke('sondra:set-progress-bar', progress),
  setPowerSaveBlocker: (active) => ipcRenderer.invoke('sondra:power-save-blocker', active),
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
  onMediaAction: (callback) => {
    const listener = (_event, action) => callback(action)
    ipcRenderer.on('sondra:media-action', listener)
    return () => ipcRenderer.removeListener('sondra:media-action', listener)
  },
})
