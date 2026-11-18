// Drives the browser side of the WebRTC probe: the real Chromium, running the
// same calls the web app's device code makes. Run: node run.mjs
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const require = createRequire(import.meta.url)
// The repository's own Playwright; the plain one where only that is installed.
let playwright
try {
  playwright = require('playwright-core')
} catch {
  playwright = require('playwright')
}
const { chromium } = playwright

const dir = mkdtempSync(join(tmpdir(), 'sondra-webrtc-'))
const exe = process.env.PROBE_EXE ?? new URL('./target/debug/probe-webrtc-interop', import.meta.url).pathname
const rust = spawn(exe, [dir], { stdio: ['ignore', 'pipe', 'inherit'] })
let rustOut = ''
rust.stdout.on('data', (d) => {
  rustOut += d
  process.stdout.write(`[rust]    ${d}`)
})
const rustExit = new Promise((resolve) => rust.on('exit', resolve))
const stopRust = () => { try { rust.kill() } catch {} }
process.on('exit', stopRust)
setTimeout(() => { console.log('[result] stalled: giving up after 50 s'); stopRust(); process.exit(2) }, 50_000).unref()

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
for (let i = 0; i < 300 && !existsSync(join(dir, 'offer.json')); i++) await wait(100)
const offer = JSON.parse(readFileSync(join(dir, 'offer.json'), 'utf8'))

// Electron turns the hiding of local addresses behind mDNS off; do the same.
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] })
const page = await browser.newPage()
page.on('console', (m) => console.log(`[browser] ${m.text()}`))

const answer = await page.evaluate(async (offer) => {
  const state = (window.__probe = { bytes: 0, wrong: 0, header: null, open: false })
  const pc = new RTCPeerConnection({ iceServers: [] })
  pc.ondatachannel = ({ channel }) => {
    channel.binaryType = 'arraybuffer'
    state.label = channel.label
    state.ordered = channel.ordered
    state.channel = channel
    channel.onopen = () => (state.open = true)
    channel.onmessage = ({ data }) => {
      if (typeof data === 'string') {
        state.header = JSON.parse(data)
        return
      }
      const view = new Uint8Array(data)
      for (let i = 0; i < view.length; i += 997) if (view[i] !== (state.bytes + i) % 251) state.wrong++
      state.bytes += view.length
      if (state.header && state.bytes >= state.header.size) {
        channel.send(`got ${state.bytes} bytes, ${state.wrong} wrong`)
        channel.send('x'.repeat(60 * 1024)) // under the 64 KiB the peer announces
      }
    }
  }
  console.log('offer has', (offer.sdp.match(/a=candidate/g) || []).length, 'candidates, rtcp-mux:', /a=rtcp-mux/.test(offer.sdp))
  await pc.setRemoteDescription(offer)
  console.log('remote set')
  await pc.setLocalDescription(await pc.createAnswer())
  console.log('local set')
  // Like the app (`gathered` in devices.ts): until done, or for a few seconds.
  if (pc.iceGatheringState !== 'complete') {
    await new Promise((resolve) => {
      pc.onicegatheringstatechange = () => pc.iceGatheringState === 'complete' && resolve()
      setTimeout(resolve, 3000)
    })
  }
  return JSON.parse(JSON.stringify(pc.localDescription))
}, offer).catch((e) => { console.log('evaluate failed:', String(e).split('\n')[0]); throw e })
writeFileSync(join(dir, 'answer.json'), JSON.stringify(answer))

const code = await Promise.race([rustExit, wait(60_000).then(() => 'timeout')])
const seen = await page.evaluate(() => ({ label: __probe.label, ordered: __probe.ordered, bytes: __probe.bytes, wrong: __probe.wrong, header: __probe.header }))
await browser.close()
console.log('[result] rust exit:', code, ' browser saw:', JSON.stringify(seen))
const ok = code === 0 && seen.label === 'sondra' && seen.ordered === true && seen.bytes === seen.header?.size && seen.wrong === 0 && /browser said: got \d+ bytes, 0 wrong/.test(rustOut)
console.log(ok ? 'INTEROP OK' : 'INTEROP FAILED')
process.exit(ok ? 0 : 1)
