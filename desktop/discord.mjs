/**
 * Lightweight Discord Rich Presence (RPC) client for Sondra Desktop.
 *
 * Connects directly to Discord's local IPC named pipe (Windows: \\.\pipe\discord-ipc-0)
 * using Node's standard `net` module. Zero external npm packages required.
 *
 * Opt-in/opt-out is strictly respected: when disabled by the user, the connection
 * is closed immediately and no packets are sent.
 */

import net from 'node:net'

const DEFAULT_CLIENT_ID = '1342898716254507008' // Sondra registered App ID

class DiscordRpcClient {
  constructor() {
    this.socket = null
    this.connected = false
    /** Discord answered the handshake (READY); activities go out only after it. */
    this.ready = false
    /** A search through the pipes is under way; a second one would race it. */
    this.connecting = false
    this.clientId = DEFAULT_CLIENT_ID
    this.currentActivity = null
    this.reconnectTimer = null
    this.enabled = false
  }

  init(enabled = false, clientId = DEFAULT_CLIENT_ID) {
    this.enabled = Boolean(enabled)
    this.clientId = clientId || DEFAULT_CLIENT_ID
    if (this.enabled) {
      this.connect()
    }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled)
    if (this.enabled) {
      if (!this.connected) this.connect()
      else if (this.currentActivity) this.setActivity(this.currentActivity)
    } else {
      this.clearActivity()
      this.disconnect()
    }
  }

  connect() {
    if (this.socket || this.connecting || !this.enabled) return
    this.connecting = true

    // Search for Discord pipe on Windows (discord-ipc-0 to discord-ipc-9)
    const pipePrefix = process.platform === 'win32' ? '\\\\?\\pipe\\discord-ipc-' : '/tmp/discord-ipc-'
    
    const tryPipe = (index) => {
      if (index > 9 || !this.enabled) {
        // Retry in 30 seconds if Discord wasn't running
        this.connecting = false
        this.scheduleReconnect()
        return
      }

      const path = `${pipePrefix}${index}`
      const sock = net.createConnection(path)

      let opened = false
      sock.on('connect', () => {
        opened = true
        this.connecting = false
        this.socket = sock
        this.connected = true
        this.sendHandshake()
      })

      sock.on('data', (data) => {
        // Discord answers every frame. Only READY, its answer to the
        // handshake, is the cue to send what is waiting; sending again on
        // every answer made a loop of some 50 000 frames a second.
        if (this.ready || !isReady(data)) return
        this.ready = true
        if (this.currentActivity && this.enabled) this.sendActivity(this.currentActivity)
      })

      sock.on('error', () => {
        sock.destroy()
        // A pipe that never opened: try the next one. One that was open and
        // failed is handled by 'close'.
        if (!opened) tryPipe(index + 1)
      })

      sock.on('close', () => {
        if (!opened) return
        this.socket = null
        this.connected = false
        this.ready = false
        if (this.enabled) {
          this.scheduleReconnect()
        }
      })
    }

    tryPipe(0)
  }

  scheduleReconnect() {
    if (this.reconnectTimer || !this.enabled) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.enabled && !this.connected) {
        this.connect()
      }
    }, 30_000)
  }

  sendHandshake() {
    if (!this.socket || !this.connected) return
    const payload = JSON.stringify({ v: 1, client_id: this.clientId })
    this.writeFrame(0, payload) // Opcode 0 = HANDSHAKE
  }

  writeFrame(opcode, jsonString) {
    if (!this.socket || !this.connected) return
    try {
      const payloadBuf = Buffer.from(jsonString, 'utf8')
      const headerBuf = Buffer.alloc(8)
      headerBuf.writeInt32LE(opcode, 0)
      headerBuf.writeInt32LE(payloadBuf.length, 4)
      this.socket.write(Buffer.concat([headerBuf, payloadBuf]))
    } catch {
      // Ignore pipe write errors
    }
  }

  setActivity(activity) {
    this.currentActivity = activity
    if (!this.enabled) return
    if (!this.connected) {
      this.connect()
      return
    }
    this.sendActivity(activity)
  }

  sendActivity(activity) {
    if (!this.socket || !this.connected || !this.ready || !this.enabled) return
    const nonce = Math.random().toString(36).slice(2)
    const payload = JSON.stringify({
      cmd: 'SET_ACTIVITY',
      args: {
        pid: process.pid,
        activity: activity || null,
      },
      nonce,
    })
    this.writeFrame(1, payload) // Opcode 1 = FRAME
  }

  clearActivity() {
    this.currentActivity = null
    if (this.socket && this.connected) {
      this.sendActivity(null)
    }
  }

  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {}
      this.socket = null
    }
    this.connected = false
    this.ready = false
  }
}

/** True when the frames in `data` include Discord's READY event. */
function isReady(data) {
  let at = 0
  while (at + 8 <= data.length) {
    const length = data.readInt32LE(at + 4)
    try {
      if (JSON.parse(data.subarray(at + 8, at + 8 + length).toString('utf8'))?.evt === 'READY') return true
    } catch {
      return false
    }
    at += 8 + length
  }
  return false
}

export const discordRpc = new DiscordRpcClient()
