/**
 * Discord's status from the app (desktop/discord.mjs), checked against a
 * stand-in for Discord's local pipe that answers the way Discord does: READY
 * to the handshake, a reply to every frame.
 *
 * The client used to send the status again on every reply, and every send
 * drew another reply: some 50 000 frames a second for as long as the switch
 * was on. Here each change is one frame.
 *
 *   npm run verify:discord
 */

import fs from 'node:fs'
import net from 'node:net'

const { discordRpc } = await import('../desktop/discord.mjs')

let failures = 0
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

const pipe = process.platform === 'win32' ? '\\\\?\\pipe\\discord-ipc-0' : '/tmp/discord-ipc-0'
if (process.platform !== 'win32') fs.rmSync(pipe, { force: true })

const received = []
let closed = false
const server = net.createServer((socket) => {
  socket.on('close', () => (closed = true))
  socket.on('data', (buffer) => {
    let at = 0
    while (at + 8 <= buffer.length) {
      const op = buffer.readInt32LE(at)
      const length = buffer.readInt32LE(at + 4)
      const body = JSON.parse(buffer.subarray(at + 8, at + 8 + length).toString())
      at += 8 + length
      received.push(op === 0 ? 'handshake' : `${body.cmd}:${body.args?.activity?.state ?? 'leer'}`)
      const reply = op === 0 ? { cmd: 'DISPATCH', evt: 'READY', data: {} } : { cmd: body.cmd, evt: null, nonce: body.nonce, data: {} }
      const payload = Buffer.from(JSON.stringify(reply))
      const head = Buffer.alloc(8)
      head.writeInt32LE(1, 0)
      head.writeInt32LE(payload.length, 4)
      socket.write(Buffer.concat([head, payload]))
    }
  })
})
await new Promise((resolve) => server.listen(pipe, resolve))
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

discordRpc.init(true)
discordRpc.setActivity({ details: 'Merkliste', state: 'Frieren' })
await wait(1000)
check('Verbinden: Handschlag, dann der Stand einmal', received, ['handshake', 'SET_ACTIVITY:Frieren'])

discordRpc.setActivity({ details: 'Merkliste', state: 'Dark' })
await wait(500)
check('Eine Änderung ist ein Rahmen', received.slice(2), ['SET_ACTIVITY:Dark'])

discordRpc.setEnabled(false)
const before = received.length
discordRpc.setActivity({ details: 'Merkliste', state: 'Nana' })
await wait(500)
// Discord takes the status down itself when the pipe closes.
check('Ausgeschaltet: Verbindung zu, nichts mehr gesendet', [closed, received.length - before], [true, 0])

server.close()
if (process.platform !== 'win32') fs.rmSync(pipe, { force: true })

if (failures > 0) {
  console.log(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nDiscord bekommt jeden Stand einmal und nichts, wenn es aus ist.')
process.exit(0)
