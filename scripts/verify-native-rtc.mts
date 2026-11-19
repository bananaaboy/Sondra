/**
 * The native device's data channel against the web app's own transfer code, in the real Chromium:
 * a browser sends 20 MB to a native receiver, and a native sender sends 20 MB to a browser. The pieces
 * are the 64 KiB the web app sends — one byte more than the unpatched WebRTC library could read — and
 * the offer and answer travel as files where the apps use Drive.
 *
 *   npm run verify:native-rtc      (after `cargo build -p sondra-devices --example rtc_peer`)
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { build } from 'esbuild'
import { chromium } from 'playwright-core'

const exe = process.env.RTC_PEER ?? 'native/target/debug/examples/rtc_peer'
if (!existsSync(exe)) {
  console.error(`Kein ${exe}: erst „cargo build -p sondra-devices --example rtc_peer“ (in native/).`)
  process.exit(2)
}

const bundle = await build({ entryPoints: ['src/lib/deviceTransfer.ts'], bundle: true, format: 'iife', globalName: 'T', write: false, logLevel: 'warning' })
const code = bundle.outputFiles[0].text

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? process.env.E2E_CHROMIUM ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  // Electron and the apps do not hide local addresses behind mDNS either.
  args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--no-sandbox'],
})

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
let bad = 0
const check = (label: string, ok: boolean) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}`)
  if (!ok) bad += 1
}

function run(dir: string, mode: 'send' | 'receive') {
  const child = spawn(exe, [dir, mode], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (d) => (out += d))
  const exit = new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? -1)))
  return { out: () => out, exit, stop: () => child.kill() }
}

async function until(path: string) {
  for (let i = 0; i < 300; i++) {
    if (existsSync(path) && readFileSync(path, 'utf8').length > 0) return readFileSync(path, 'utf8')
    await wait(100)
  }
  throw new Error(`nothing came in ${path}`)
}

async function newPage() {
  const page = await browser.newPage()
  page.on('console', (m) => console.log(`[browser] ${m.text()}`))
  await page.addScriptTag({ content: code })
  await page.evaluate(() => {
    const w = window as unknown as Record<string, any>
    w.pattern = (at: number) => (at * 31 + Math.floor(at / 251)) % 253
    // The web app's `wireOf`, as it is in devices.ts.
    w.wireOf = (channel: RTCDataChannel, pc: RTCPeerConnection) => {
      channel.binaryType = 'arraybuffer'
      channel.bufferedAmountLowThreshold = 1024 * 1024
      const closers: (() => void)[] = []
      const closed = () => closers.splice(0).forEach((h) => h())
      channel.addEventListener('close', closed)
      pc.addEventListener('connectionstatechange', () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') closed()
      })
      return {
        send: (data: string | ArrayBuffer) => channel.send(data as string),
        get bufferedAmount() {
          return channel.bufferedAmount
        },
        drained: () => new Promise<void>((resolve) => channel.addEventListener('bufferedamountlow', () => resolve(), { once: true })),
        onMessage: (h: (d: string | ArrayBuffer) => void) => channel.addEventListener('message', (e) => h(e.data)),
        onClose: (h: () => void) => closers.push(h),
        close: () => {
          channel.close()
          pc.close()
        },
      }
    }
    w.gathered = (pc: RTCPeerConnection) =>
      new Promise<void>((resolve) => {
        if (pc.iceGatheringState === 'complete') return resolve()
        pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && resolve())
        setTimeout(resolve, 4000)
      })
  })
  return page
}

const SIZE = 20 * 1024 * 1024 + 321

// 1. The browser sends, the native device receives.
{
  const dir = mkdtempSync(join(tmpdir(), 'sondra-rtc-'))
  const rust = run(dir, 'receive')
  const offer = await newPage().then(async (page) => {
    const sdp = await page.evaluate(async () => {
      const w = window as any
      const pc = new RTCPeerConnection({ iceServers: [] })
      const channel = pc.createDataChannel('sondra', { ordered: true })
      await pc.setLocalDescription(await pc.createOffer())
      await w.gathered(pc)
      w.pc = pc
      w.channel = channel
      return pc.localDescription!.sdp
    })
    writeFileSync(join(dir, 'offer.sdp'), sdp)
    const answer = await until(join(dir, 'answer.sdp'))
    const result = await page.evaluate(
      async ({ answer, size }) => {
        const w = window as any
        await w.pc.setRemoteDescription({ type: 'answer', sdp: answer })
        await new Promise<void>((resolve, reject) => {
          if (w.channel.readyState === 'open') return resolve()
          w.channel.onopen = () => resolve()
          setTimeout(() => reject(new Error('the channel never opened')), 30000)
        })
        const file = {
          name: 'Muster.bin',
          size,
          mime: 'application/octet-stream',
          read: async (start: number, end: number) => {
            const bytes = new Uint8Array(end - start)
            for (let i = 0; i < bytes.length; i++) bytes[i] = w.pattern(start + i)
            return bytes.buffer
          },
        }
        const places = await w.T.sendOver(w.wireOf(w.channel, w.pc), [file])
        return places
      },
      { answer, size: SIZE },
    )
    await page.close()
    return result
  })
  const code = await Promise.race([rust.exit, wait(60_000).then(() => -9)])
  check('Browser → nativ: die Übertragung endet', Array.isArray(offer))
  check('Browser → nativ: das native Gerät hat alles, nichts falsch', code === 0 && rust.out().includes(`received ${SIZE} bytes, 0 wrong`))
  rust.stop()
}

// 2. The native device sends, the browser receives.
{
  const dir = mkdtempSync(join(tmpdir(), 'sondra-rtc-'))
  const rust = run(dir, 'send')
  const offer = await until(join(dir, 'offer.sdp'))
  const page = await newPage()
  const answer = await page.evaluate(async (offer) => {
    const w = window as any
    const pc = new RTCPeerConnection({ iceServers: [] })
    w.got = new Promise((resolve) => {
      pc.ondatachannel = ({ channel }) => resolve(channel)
    })
    await pc.setRemoteDescription({ type: 'offer', sdp: offer })
    await pc.setLocalDescription(await pc.createAnswer())
    await w.gathered(pc)
    w.pc = pc
    return pc.localDescription!.sdp
  }, offer)
  writeFileSync(join(dir, 'answer.sdp'), answer)
  const result = await page.evaluate(async () => {
    const w = window as any
    const channel: RTCDataChannel = await w.got
    if (channel.readyState !== 'open') await new Promise<void>((resolve) => (channel.onopen = () => resolve()))
    let at = 0
    let wrong = 0
    const sink = {
      write: async (chunk: Uint8Array) => {
        for (let i = 0; i < chunk.length; i++) if (chunk[i] !== w.pattern(at + i)) wrong++
        at += chunk.length
      },
      close: async () => 'Prüfung',
      abort: async () => undefined,
    }
    const places = await w.T.receiveOver(w.wireOf(channel, w.pc), async () => sink)
    return { at, wrong, places }
  })
  const code = await Promise.race([rust.exit, wait(60_000).then(() => -9)])
  check('nativ → Browser: der Browser hat alles, nichts falsch', result.at === SIZE && result.wrong === 0)
  check('nativ → Browser: das native Gerät erfährt, wo es liegt', code === 0 && rust.out().includes('Pruefung') === false && rust.out().includes('sent, the other side says'))
  rust.stop()
}

await browser.close()
if (bad > 0) {
  console.error(`${bad} Prüfung(en) fehlgeschlagen`)
  process.exit(1)
}
console.log('das native Gerät und der Browser übertragen in beide Richtungen')
