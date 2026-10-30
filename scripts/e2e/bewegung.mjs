// Motion: the rule under the tabs glides, a tool arrives settled, menus and dialogs
// come in and go, with and without reduced motion, on a desktop and a phone.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
for (const [label, viewport, reduced] of [['desktop', { width: 1440, height: 900 }, false], ['handy', { width: 390, height: 844 }, false], ['ruhig', { width: 1440, height: 900 }, true]]) {
  const context = await browser.newContext({ viewport, reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => { if (!harmless(e)) errors.push(String(e)) })
  await page.goto(BASE)
  await page.waitForSelector('#start-werkzeuge')
  await page.waitForTimeout(800)
  // Tiles end fully visible
  const op = await page.$$eval('button[id^="v-"]', (els) => els.slice(0, 12).map((e) => getComputedStyle(e).opacity))
  check(`${label}: Kacheln sichtbar nach Ankunft`, op.every((o) => o === '1'), op.join(','))
  // Tab rule glides
  const tabs = page.locator('[role="tab"]')
  const n = await tabs.count()
  const rule = page.locator('[role="tablist"] > span[aria-hidden]')
  const before = await rule.evaluate((e) => getComputedStyle(e).transform)
  const target = tabs.nth(Math.min(3, n - 1))
  await target.click()
  await page.waitForTimeout(90)
  const mid = await rule.evaluate((e) => getComputedStyle(e).transform)
  await page.waitForTimeout(600)
  const after = await rule.evaluate((e) => getComputedStyle(e).transform)
  const tb = await target.boundingBox()
  const lb = await rule.boundingBox()
  check(`${label}: Strich unter dem gewählten Reiter`, Math.abs(lb.x - (tb.x + 12)) < 2 && Math.abs(lb.x + lb.width - (tb.x + tb.width - 12)) < 2, `${lb.x}/${lb.width} vs ${tb.x}/${tb.width}`)
  if (!reduced) check(`${label}: Strich gleitet`, mid !== before && mid !== after, `${before} → ${mid} → ${after}`)
  // Panel ends settled
  const pr = await page.locator('.panel-root').first().evaluate((e) => [getComputedStyle(e).opacity, getComputedStyle(e).transform])
  check(`${label}: Werkzeug steht ruhig`, pr[0] === '1' && pr[1] === 'none', pr.join(' '))
  await page.screenshot({ path: OUT + `${label}-reiter.png` })
  // Mehr menu (if any)
  const more = page.getByRole('button', { name: /^Mehr/ })
  if (await more.count()) {
    await more.click()
    await page.waitForTimeout(60)
    const m = await page.locator('[role="menu"]').evaluate((e) => getComputedStyle(e).opacity)
    await page.waitForTimeout(400)
    const m2 = await page.locator('[role="menu"]').evaluate((e) => getComputedStyle(e).opacity)
    check(`${label}: Menü fällt auf`, m2 === '1' && (reduced || Number(m) < 1), `${m} → ${m2}`)
    await page.screenshot({ path: OUT + `${label}-mehr.png` })
    await page.keyboard.press('Escape')
  }
  // Dialog: Was ist neu via footer
  await page.goto(BASE)
  await page.waitForTimeout(500)
  const whats = page.getByRole('button', { name: /Was ist neu/ }).last()
  await whats.scrollIntoViewIfNeeded()
  await whats.click()
  await page.waitForTimeout(50)
  const d1 = await page.locator('dialog[open]').evaluate((e) => getComputedStyle(e).opacity)
  await page.waitForTimeout(500)
  const d2 = await page.locator('dialog[open]').evaluate((e) => [getComputedStyle(e).opacity, getComputedStyle(e).transform].join(' '))
  check(`${label}: Dialog kommt herein`, d2 === '1 none' && (reduced || Number(d1) < 1), `${d1} → ${d2}`)
  await page.screenshot({ path: OUT + `${label}-dialog.png` })
  await page.keyboard.press('Escape')
  await page.waitForTimeout(300)
  check(`${label}: Dialog geschlossen`, (await page.locator('dialog[open]').count()) === 0)
  // Theme toggle
  const theme = page.getByRole('button', { name: /^Erscheinungsbild/ })
  await theme.click(); await page.waitForTimeout(400)
  await theme.click(); await page.waitForTimeout(400)
  const attr = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
  check(`${label}: Thema gewechselt`, attr === 'dark' || attr === 'light' || attr === null, String(attr))
  check(`${label}: keine Fehler`, errors.length === 0, errors.join(' | '))
  await context.close()
}
await browser.close()
finish()
