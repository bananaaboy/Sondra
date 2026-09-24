/**
 * Puts the tested installer on Vercel Blob, at an address that names the
 * version and answers without a redirect.
 *
 *   BLOB_READ_WRITE_TOKEN=… node desktop/upload-blob.mjs release/Sondra-Setup-1.0.0.exe 1.0.0
 *
 * Why not the GitHub release: the Microsoft Store takes an installer URL for
 * Win32 apps, and refuses one that redirects. Every GitHub release download
 * answers 302 to a signed object-storage address that expires after half an
 * hour, and nothing on GitHub's side turns that off. A public Blob URL is
 * served straight from Vercel's CDN.
 *
 * The address never changes once written — the Store expects the file behind
 * a submitted URL to stay what was certified — so an existing blob is an
 * error here, not something to overwrite. A new version gets a new path.
 *
 * Only the two newest versions stay: the new one, and the one before it,
 * which a submission may still be in certification with. Every setup is
 * 130 MB, and a free Blob store that fills up is suspended — with every
 * address in it, the Store's included.
 */

import fs from 'node:fs'
import path from 'node:path'

import { del, list, put } from '@vercel/blob'

const [file, version] = process.argv.slice(2)
const token = process.env.BLOB_READ_WRITE_TOKEN

if (!file || !version) {
  console.error('Aufruf: node desktop/upload-blob.mjs <setup.exe> <version>')
  process.exit(1)
}
if (!token) {
  console.error('BLOB_READ_WRITE_TOKEN fehlt.')
  process.exit(1)
}

const pathname = `sondra/${version}/${path.basename(file)}`
const size = fs.statSync(file).size
console.log(`Lade ${path.basename(file)} (${(size / 1e6).toFixed(1)} MB) nach ${pathname} …`)

const blob = await put(pathname, fs.createReadStream(file), {
  access: 'public',
  token,
  addRandomSuffix: false,
  allowOverwrite: false,
  contentType: 'application/vnd.microsoft.portable-executable',
  multipart: true,
})

// What the Store will check: a plain 200, no redirect, the whole file.
const answer = await fetch(blob.url, { method: 'HEAD', redirect: 'manual' })
const length = Number(answer.headers.get('content-length'))
if (answer.status !== 200 || length !== size) {
  console.error(`Prüfung fehlgeschlagen: ${answer.status}, ${length} statt ${size} Bytes.`)
  process.exit(1)
}

console.log(`Store-URL: ${blob.url}`)

// Older versions go; a failure here must not undo the upload above.
try {
  const newer = (a, b) => b.localeCompare(a, undefined, { numeric: true })
  const { blobs } = await list({ prefix: 'sondra/', token, limit: 1000 })
  const versions = [...new Set(blobs.map((entry) => entry.pathname.split('/')[1]).filter(Boolean))].sort(newer)
  const keep = new Set([version, ...versions.filter((v) => v !== version).slice(0, 1)])
  const old = blobs.filter((entry) => !keep.has(entry.pathname.split('/')[1]))
  if (old.length > 0) {
    await del(old.map((entry) => entry.url), { token })
    console.log(`Entfernt: ${old.map((entry) => entry.pathname).join(', ')}`)
  }
} catch (failure) {
  console.warn(`Ältere Fassungen nicht entfernt: ${failure?.message ?? failure}`)
}
if (process.env.GITHUB_STEP_SUMMARY) {
  fs.appendFileSync(
    process.env.GITHUB_STEP_SUMMARY,
    `### Paket-URL für den Microsoft Store\n\n\`${blob.url}\`\n\nOhne Umleitung geprüft: HTTP 200, ${size} Bytes.\n`,
  )
}
