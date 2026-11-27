// The Kalender: a week of seven columns on a desk and a list of days on a phone; entries of the person's
// own with a date, a time, a repeat and a reminder; a series with its day of the week; a reminder that says
// so while Sondra is open — once.
import { BASE, OUT, check, finish, harmless, launch } from './lib.mjs'

const browser = await launch()
const errors = []

const open = async ({ viewport = { width: 1280, height: 900 }, events, list, touch = false } = {}) => {
  const context = await browser.newContext({ viewport, serviceWorkers: 'block', hasTouch: touch })
  await context.addInitScript(
    ({ events, list }) => {
      try {
        // Seeded once: a reload in the same tab must keep what the page itself stored since.
        if (!sessionStorage.getItem('seeded')) {
          if (events) localStorage.setItem('sondra:kalender', JSON.stringify(events))
          if (list) localStorage.setItem('sondra:saved_links', JSON.stringify(list))
          sessionStorage.setItem('seeded', '1')
        }
      } catch {
        /* private window */
      }
    },
    { events: events ?? null, list: list ?? null },
  )
  const page = await context.newPage()
  page.on('pageerror', (e) => {
    if (!harmless(e)) errors.push(String(e))
  })
  return { context, page }
}

const stored = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sondra:kalender') ?? '[]'))
const savedList = (page) => page.evaluate(() => JSON.parse(localStorage.getItem('sondra:saved_links') ?? '[]'))
const pad = (n) => String(n).padStart(2, '0')

/* -- an empty week leads, an entry is made ------------------------------------------------------------ */
{
  const { context, page } = await open()
  await page.goto(`${BASE}#kalender`)
  await page.getByRole('heading', { name: 'Kalender' }).waitFor({ timeout: 15_000 })
  check('Adresse #kalender öffnet den Kalender, der Reiter ist der gewählte', ((await page.locator('nav [aria-current="page"]').first().textContent()) ?? '').includes('Kalender') && (await page.getByText('Diese Woche ist leer.').count()) === 1)
  check('Sieben Tage, Montag bis Sonntag', (await page.locator('section[aria-label]').filter({ has: page.locator('h3') }).count()) === 7)
  check('Heute ist markiert, „Heute“ ist in dieser Woche aus', (await page.getByText('heute', { exact: true }).count()) === 1 && (await page.getByRole('button', { name: 'Heute', exact: true }).isDisabled()))

  await page.getByRole('button', { name: 'Termin eintragen' }).click()
  await page.getByLabel(/^Name/).fill('Zahnarzt')
  await page.getByLabel(/^Uhrzeit/).fill('09:30')
  await page.getByLabel(/^Ende/).fill('10:15')
  await page.getByLabel(/^Notiz/).fill('Karte mitnehmen')
  await page.getByLabel(/^Erinnerung/).selectOption('60')
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click()
  await page.waitForTimeout(300)
  const events = await stored(page)
  check('Der Eintrag liegt mit Zeit, Ende, Notiz und Erinnerung im Speicher', events.length === 1 && events[0].title === 'Zahnarzt' && events[0].time === '09:30' && events[0].endTime === '10:15' && events[0].remind === 60 && events[0].repeat === 'none', JSON.stringify(events))
  check('… und steht in der Woche, die leere Meldung ist weg', (await page.getByRole('button', { name: /09:30–10:15 Zahnarzt/ }).count()) === 1 && (await page.getByText('Diese Woche ist leer.').count()) === 0)

  await page.reload()
  await page.getByRole('heading', { name: 'Kalender' }).waitFor()
  check('Nach dem Neuladen ist er noch da', (await page.getByRole('button', { name: /Zahnarzt/ }).count()) === 1)

  // Edit, then delete with a second question.
  await page.getByRole('button', { name: /Zahnarzt/ }).click()
  await page.getByLabel(/^Name/).fill('Zahnarzt Dr. Weiss')
  await page.getByLabel(/^Wiederholen/).selectOption('weekly')
  await page.getByRole('button', { name: 'Speichern', exact: true }).click()
  await page.waitForTimeout(200)
  const edited = await stored(page)
  check('Ändern ersetzt den Eintrag, es bleibt einer', edited.length === 1 && edited[0].title === 'Zahnarzt Dr. Weiss' && edited[0].repeat === 'weekly')
  await page.getByRole('button', { name: /Zahnarzt Dr. Weiss/ }).click()
  await page.getByRole('button', { name: 'Löschen', exact: true }).click()
  check('Löschen fragt noch einmal', (await stored(page)).length === 1 && (await page.getByRole('button', { name: 'Wirklich löschen?' }).count()) === 1)
  await page.getByRole('button', { name: 'Wirklich löschen?' }).click()
  await page.waitForTimeout(200)
  check('… und löscht dann', (await stored(page)).length === 0)

  // Mistakes are said, not swallowed.
  await page.getByRole('button', { name: 'Eintrag', exact: true }).click()
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click()
  check('Ohne Namen: ein Satz, nichts gespeichert', (await page.getByRole('alert').filter({ hasText: 'Name' }).count()) === 1 && (await stored(page)).length === 0)
  await page.getByLabel(/^Name/).fill('Sport')
  check('Ohne Uhrzeit ist die Erinnerung aus, mit dem Grund daneben', (await page.getByLabel(/^Erinnerung/).isDisabled()) && (await page.getByText('Dafür braucht der Eintrag eine Uhrzeit.').count()) === 1)
  await page.getByLabel(/^Uhrzeit/).fill('18:00')
  await page.getByLabel(/^Ende/).fill('17:00')
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click()
  check('Ende vor Anfang: abgelehnt', (await page.getByRole('alert').filter({ hasText: 'Ende' }).count()) === 1)
  await page.keyboard.press('Escape')

  // Weeks.
  const label = await page.locator('p[aria-live="polite"]').first().textContent()
  await page.getByRole('button', { name: 'Eine Woche weiter' }).click()
  const next = await page.locator('p[aria-live="polite"]').first().textContent()
  check('Eine Woche weiter ändert die Beschriftung, „Heute“ geht an', next !== label && (await page.getByRole('button', { name: 'Heute', exact: true }).isEnabled()))
  await page.getByRole('button', { name: 'Heute', exact: true }).click()
  check('„Heute“ kommt zurück', (await page.locator('p[aria-live="polite"]').first().textContent()) === label)
  await context.close()
}

/* -- a series with its day --------------------------------------------------------------------------- */
{
  const series = (id, title, extra = {}) => ({ id, url: `https://aniworld.to/anime/stream/${id}`, title, language: 'auto', season: 1, episode: 5, mode: 'video', audioFormat: 'mp3', videoPref: 'untouched', audioPref: 'high', autoTranscribe: false, updatedAt: Date.now(), status: 'watching', ...extra })
  const { context, page } = await open({ list: [series('frieren', 'Frieren'), series('fertig', 'Fertig', { status: 'done' })] })
  await page.goto(`${BASE}#kalender`)
  await page.getByRole('heading', { name: 'Kalender' }).waitFor({ timeout: 15_000 })
  await page.getByRole('button', { name: 'Eintrag', exact: true }).click()
  await page.getByRole('button', { name: 'Serie, die jede Woche läuft' }).click()
  check('Nur gesehene Serien stehen zur Wahl, nicht abgeschlossene', (await page.getByLabel(/^Serie/).locator('option').allTextContents()).join() === 'Frieren')
  await page.getByLabel(/^Wochentag/).selectOption('3')
  await page.getByLabel(/^Sendezeit/).fill('18:00')
  await page.getByLabel(/^Erinnerung/).selectOption('0')
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click()
  await page.waitForTimeout(300)
  const list = await savedList(page)
  check('Der Sendetag liegt an der Serie der Merkliste', JSON.stringify(list.find((s) => s.id === 'frieren')?.airing) === JSON.stringify({ weekday: 3, time: '18:00', remind: 0 }), JSON.stringify(list.find((s) => s.id === 'frieren')?.airing))
  const column = page.locator('section[aria-label^="Donnerstag"]')
  check('Donnerstag zeigt sie mit der Folge, bei der Sie stehen', (await column.getByText('Frieren').count()) === 1 && (await column.getByText('Nächste: Staffel 1, Folge 5').count()) === 1)
  check('Kein anderer Tag zeigt sie', (await page.getByText('Frieren').count()) === 1)
  await page.screenshot({ path: `${OUT}kalender-serie.png` })

  await page.getByRole('button', { name: /Frieren/ }).click()
  await page.getByLabel(/^Wochentag/).selectOption('4')
  await page.getByRole('button', { name: 'Speichern', exact: true }).click()
  await page.waitForTimeout(200)
  check('Den Tag ändern verschiebt sie', (await savedList(page)).find((s) => s.id === 'frieren').airing.weekday === 4 && (await page.locator('section[aria-label^="Freitag"]').getByText('Frieren').count()) === 1)

  await page.getByRole('button', { name: /Frieren/ }).click()
  await page.getByRole('button', { name: 'Zur Serie' }).click()
  await page.waitForTimeout(600)
  check('„Zur Serie“ geht in die Merkliste', page.url().includes('#merkliste'))
  await page.goto(`${BASE}#kalender`)
  await page.getByRole('heading', { name: 'Kalender' }).waitFor()
  await page.getByRole('button', { name: /Frieren/ }).click()
  await page.getByRole('button', { name: 'Aus dem Kalender nehmen' }).click()
  await page.getByRole('button', { name: 'Wirklich aus dem Kalender nehmen?' }).click()
  await page.waitForTimeout(200)
  check('Aus dem Kalender nehmen löscht nur den Sendetag, die Serie bleibt', (await savedList(page)).find((s) => s.id === 'frieren')?.airing === undefined && (await savedList(page)).length === 2)
  await context.close()
}

/* -- a reminder, once ---------------------------------------------------------------------------------- */
{
  const stamp = new Date(Date.now() - 60_000)
  const time = `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`
  const date = `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`
  const { context, page } = await open({ events: [{ id: 'due', title: 'Tabletten nehmen', date, time, repeat: 'none', remind: 0, updatedAt: 1 }] })
  await page.goto(`${BASE}#kalender`)
  await page.getByText('Tabletten nehmen', { exact: true }).first().waitFor({ timeout: 15_000 })
  const line = page.getByRole('status').filter({ hasText: 'Tabletten nehmen' })
  await line.waitFor({ timeout: 15_000 }).catch(() => undefined)
  check('Die Erinnerung steht als Zeile in der Seite', (await line.count()) === 1 && (await line.textContent())?.includes(`Jetzt, ${time} Uhr`), await line.textContent().catch(() => ''))
  await page.screenshot({ path: `${OUT}kalender-erinnerung.png` })
  await line.getByRole('button', { name: 'OK' }).click()
  check('OK nimmt sie weg', (await page.getByRole('status').filter({ hasText: 'Tabletten nehmen' }).count()) === 0)
  await page.reload()
  await page.getByRole('heading', { name: 'Kalender' }).waitFor()
  await page.waitForTimeout(4500)
  check('Nach einem Neustart sagt sie es nicht noch einmal', (await page.getByRole('status').filter({ hasText: 'Tabletten nehmen' }).count()) === 0)
  await context.close()
}

/* -- an entry long past is not told ---------------------------------------------------------------------- */
{
  const stamp = new Date(Date.now() - 3 * 3_600_000)
  const { context, page } = await open({
    events: [{ id: 'old', title: 'Längst vorbei', date: `${stamp.getFullYear()}-${pad(stamp.getMonth() + 1)}-${pad(stamp.getDate())}`, time: `${pad(stamp.getHours())}:${pad(stamp.getMinutes())}`, repeat: 'none', remind: 0, updatedAt: 1 }],
  })
  await page.goto(`${BASE}#kalender`)
  await page.getByRole('heading', { name: 'Kalender' }).waitFor({ timeout: 15_000 })
  await page.waitForTimeout(4500)
  check('Was vor drei Stunden war, wird beim Start nicht nachgeholt', (await page.getByRole('status').filter({ hasText: 'Längst vorbei' }).count()) === 0)
  await context.close()
}

/* -- the phone, and the start page ------------------------------------------------------------------------ */
{
  const { context, page } = await open({ viewport: { width: 390, height: 844 }, touch: true })
  await page.goto(`${BASE}#kalender`)
  await page.getByRole('heading', { name: 'Kalender' }).waitFor({ timeout: 15_000 })
  const days = page.locator('section[aria-label]').filter({ has: page.locator('h3') })
  const boxes = await Promise.all([0, 1, 2].map((i) => days.nth(i).boundingBox()))
  check('Am Handy stehen die Tage untereinander', boxes[0] && boxes[1] && boxes[1].y > boxes[0].y + 20 && Math.abs(boxes[0].x - boxes[1].x) < 2)
  check('Nichts läuft über den Rand', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1))
  await page.getByRole('button', { name: /^Eintrag am/ }).nth(2).click()
  await page.getByLabel(/^Name/).fill('Handy-Termin')
  await page.getByRole('button', { name: 'Eintragen', exact: true }).click()
  await page.waitForTimeout(200)
  const made = await stored(page)
  check('Ein Tipp aufs Plus legt am gewählten Tag an', made.length === 1 && made[0].title === 'Handy-Termin')
  await page.screenshot({ path: `${OUT}kalender-handy.png`, fullPage: true })
  await page.goto(BASE)
  await page.waitForTimeout(800)
  check('Die Startseite hat die Kachel „Kalender“', (await page.getByRole('button', { name: /^Kalender/ }).count()) >= 1)
  await context.close()
}

check('Keine Fehler auf der Seite', errors.length === 0, errors.join('; '))
await browser.close()
finish()
