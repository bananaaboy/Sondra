// Runs every browser scenario against the built site (`npm run build` first):
// starts `dev-service` on a free port, then each scenario in its own process,
// so one crash is one failed scenario and not a dead run.
//
//   npm run build && npm run verify:e2e [name …]
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '../..')
const ALL = ['geraete', 'ordner', 'bewegung']
const wanted = process.argv.slice(2)
const names = wanted.length ? wanted : ALL

if (!fs.existsSync(path.join(root, 'dist/index.html'))) {
  console.error('Kein dist/ — erst `npm run build`.')
  process.exit(2)
}

const port = await new Promise((resolve) => {
  const probe = net.createServer().listen(0, '127.0.0.1', () => {
    const { port } = probe.address()
    probe.close(() => resolve(port))
  })
})

const server = spawn(process.execPath, [path.join(root, 'scripts/dev-service.mjs')], {
  cwd: root,
  env: { ...process.env, PORT: String(port) },
  stdio: 'ignore',
})
const stop = () => server.kill()
process.on('exit', stop)

// Up when the front page answers.
for (let tries = 0; ; tries += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/`)).ok) break
  } catch {
    /* not yet */
  }
  if (tries > 60) {
    console.error('Der Testserver startet nicht.')
    process.exit(2)
  }
  await new Promise((done) => setTimeout(done, 250))
}

let failed = 0
for (const name of names) {
  console.log(`\n── ${name} ──`)
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(here, `${name}.mjs`)], {
      cwd: root,
      env: { ...process.env, E2E_BASE: `http://127.0.0.1:${port}/` },
      stdio: 'inherit',
    })
    child.on('exit', (status) => resolve(status ?? 1))
  })
  if (code !== 0) failed += 1
}
stop()
console.log(failed ? `\n${failed} von ${names.length} Szenarien gescheitert.` : `\nAlle ${names.length} Szenarien grün.`)
process.exit(failed ? 1 : 0)
