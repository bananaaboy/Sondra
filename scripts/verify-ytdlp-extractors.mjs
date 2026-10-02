#!/usr/bin/env node
/**
 * Exercises the local service's full AniWorld → redirect → VOE path without
 * contacting a portal. The fixture also uses the less rigid JSON-script shape
 * accepted by VOE clones.
 */

import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const root = path.resolve(import.meta.dirname, '..')
const fixtureDir = await mkdtemp(path.join(os.tmpdir(), 'sondra-ytdlp-'))
const port = 19_000 + (process.pid % 1_000)

function rot13(value) {
  return value.replace(/[a-zA-Z]/g, (character) => {
    const code = character.charCodeAt(0)
    const base = code <= 90 ? 65 : 97
    return String.fromCharCode(((code - base + 13) % 26) + base)
  })
}

function voePayload(source, title) {
  const json = JSON.stringify({ source, title })
  const reversed = Buffer.from(json).toString('base64').split('').reverse().join('')
  const shifted = Array.from(reversed, (character) => String.fromCharCode(character.charCodeAt(0) + 3)).join('')
  return rot13(Buffer.from(shifted).toString('base64'))
}

const streamUrl = 'https://media.fixture.test/video.mp4'
const payload = voePayload(streamUrl, 'AniWorld fixture')
const preload = `
const episode = 'https://aniworld.to/anime/stream/fixture/staffel-1/episode-1'
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target === episode) return { ok: true, text: async () => '<section>VOE <a href="/redirect/4241628">start</a></section><a href="/redirect/other">other</a>' }
  if (target === 'https://aniworld.to/redirect/4241628') return { ok: true, url: 'https://voe.sx/e/fixture' }
  if (target === 'https://voe.sx/e/fixture') return { ok: true, text: async () => \`<script data-page="fixture" type='application/json'>["${payload}"]</script>\` }
  throw new Error('Unexpected request: ' + target)
}
`

const ytdlp = `#!/bin/sh
printf '%s\\n' '{"title":"probe","formats":[{"format_id":"fixture","vcodec":"avc1.4d401f","acodec":"mp4a.40.2","height":720,"protocol":"https","ext":"mp4"}]}'
`

let service
try {
  await writeFile(path.join(fixtureDir, 'preload.mjs'), preload)
  await writeFile(path.join(fixtureDir, 'yt-dlp'), ytdlp)
  await chmod(path.join(fixtureDir, 'yt-dlp'), 0o755)

  service = spawn(process.execPath, ['--import', path.join(fixtureDir, 'preload.mjs'), path.join(root, 'public/sondra-ytdlp.mjs')], {
    cwd: fixtureDir,
    env: { ...process.env, SONDRA_SERVICE_PORT: String(port) },
    stdio: 'ignore',
  })

  let response
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      response = await new Promise((resolve, reject) => {
        const request = http.request(
          { hostname: '127.0.0.1', port, path: '/', method: 'POST', headers: { 'content-type': 'application/json' } },
          async (result) => {
            let body = ''
            for await (const chunk of result) body += chunk
            resolve({ status: result.statusCode, body })
          },
        )
        request.on('error', reject)
        request.end(JSON.stringify({ url: 'https://aniworld.to/anime/stream/fixture/staffel-1/episode-1' }))
      })
      break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }

  assert.ok(response, 'Der lokale Dienst ist nicht gestartet.')
  assert.equal(response.status, 200)
  const body = JSON.parse(response.body)
  assert.equal(body.status, 'tunnel')
  assert.equal(body.filename, 'AniWorld fixture (720p).mp4')
  console.log('ok    AniWorld → Redirect → VOE → MP4-Auftrag')
} finally {
  if (service && !service.killed) {
    service.kill()
    await once(service, 'exit')
  }
  await rm(fixtureDir, { recursive: true, force: true })
}
