/**
 * The Kalender's arithmetic, checked where it can go wrong: across the two
 * nights the clocks change (29 March and 25 October 2026 in Europe), with
 * weeks that start on Monday, repeats on dates rather than hours, and
 * reminders that fire once.
 *
 *   npm run verify:calendar
 *
 * Run in the time zone of those clocks — set before anything reads a date.
 */

process.env.TZ = 'Europe/Berlin'

const store = new Map<string, string>()
;(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => void store.set(key, value),
  removeItem: (key: string) => void store.delete(key),
}

import {
  addDays,
  dayHeading,
  dayLong,
  deleteEvent,
  dueReminders,
  itemsOn,
  normalizeEvent,
  occursOn,
  parseYmd,
  rememberReminders,
  saveEvent,
  startsAt,
  todayYmd,
  toldReminders,
  useCalendar,
  weekDates,
  weekdayOf,
  weekLabel,
  weekStart,
  type CalEvent,
} from '../src/lib/calendar'

let failures = 0
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) failures += 1
  console.log(`${ok ? 'ok  ' : 'FEHL'}  ${label}${ok ? '' : `  erwartet ${JSON.stringify(expected)}, war ${JSON.stringify(actual)}`}`)
}

/* -- Dates -------------------------------------------------------------------- */

check('Datum: gültig', parseYmd('2026-11-26'), { y: 2026, m: 11, d: 26 })
check('Datum: 30. Februar gibt es nicht', parseYmd('2026-02-30'), null)
check('Datum: 29. Februar nur im Schaltjahr', [parseYmd('2028-02-29') !== null, parseYmd('2027-02-29')], [true, null])
check('Datum: Unsinn', [parseYmd('26.11.2026'), parseYmd('2026-13-01'), parseYmd('')], [null, null, null])
check('Wochentag: der 26.11.2026 ist ein Donnerstag', [weekdayOf('2026-11-26'), dayLong('2026-11-26')], [3, 'Donnerstag, 26. November 2026'])
check('Woche beginnt am Montag', [weekStart('2026-11-26'), weekStart('2026-11-23'), weekStart('2026-11-29')], ['2026-11-23', '2026-11-23', '2026-11-23'])
check('sieben Tage, Mo bis So', weekDates('2026-11-23').map((d) => weekdayOf(d)), [0, 1, 2, 3, 4, 5, 6])
check('Beschriftung des Tages', dayHeading('2026-11-26'), 'Do 26')
check('Wochenbeschriftung im selben Monat', weekLabel('2026-11-23'), '23.–29. November 2026')
check('… über einen Monat', weekLabel('2026-11-30'), '30. Nov. – 6. Dez. 2026')
check('… über den Jahreswechsel', weekLabel('2026-12-28'), '28. Dez. 2026 – 3. Jan. 2027')

/* -- The nights the clocks change ---------------------------------------------- */

check('Zeitumstellung Frühjahr: der Tag danach ist der 30.', addDays('2026-03-29', 1), '2026-03-30')
check('Zeitumstellung Herbst: der Tag danach ist der 26.', addDays('2026-10-25', 1), '2026-10-26')
check('sieben Tage über die Frühjahrs-Umstellung bleiben derselbe Wochentag', [weekdayOf('2026-03-25'), weekdayOf(addDays('2026-03-25', 7)), addDays('2026-03-25', 7)], [2, 2, '2026-04-01'])
check('sieben Tage über die Herbst-Umstellung', [addDays('2026-10-21', 7), weekdayOf(addDays('2026-10-21', 7))], ['2026-10-28', 2])
check('die Woche der Umstellung hat sieben verschiedene Tage', new Set(weekDates('2026-03-23')).size, 7)
check('… auch im Herbst, mit dem 25. als Sonntag', [weekDates('2026-10-19')[6], weekdayOf('2026-10-25')], ['2026-10-25', 6])
check('addDays über Monats- und Jahresgrenze zurück', [addDays('2026-03-01', -1), addDays('2027-01-01', -1)], ['2026-02-28', '2026-12-31'])
check('die Uhrzeit bleibt die Uhrzeit: 18:00 am Tag der Herbst-Umstellung', [startsAt('2026-10-25', '18:00').getHours(), startsAt('2026-10-25', '18:00').getMinutes()], [18, 0])
const week1 = startsAt('2026-10-18', '18:00').getTime()
const week2 = startsAt('2026-10-25', '18:00').getTime()
const week3 = startsAt('2026-11-01', '18:00').getTime()
check('über die Herbst-Umstellung hat die Woche 169 Stunden, die nächste wieder 168', [(week2 - week1) / 3_600_000, (week3 - week2) / 3_600_000], [169, 168])
check('Frühjahr: 18:00 bleibt 18:00, die Woche hat 167 Stunden', [(startsAt('2026-03-29', '18:00').getTime() - startsAt('2026-03-22', '18:00').getTime()) / 3_600_000, startsAt('2026-03-29', '18:00').getHours()], [167, 18])
check('heute nach der Uhr der Wand', todayYmd(new Date(2026, 9, 25, 23, 30)), '2026-10-25')

/* -- Repeats --------------------------------------------------------------------- */

const weekly = { date: '2026-03-25', repeat: 'weekly' as const }
check('wöchentlich: der erste Tag, die Woche danach über die Umstellung', [occursOn(weekly, '2026-03-25'), occursOn(weekly, '2026-04-01'), occursOn(weekly, '2026-03-29')], [true, true, false])
check('wöchentlich: nie vor dem Anfang', occursOn(weekly, '2026-03-18'), false)
check('täglich', [occursOn({ date: '2026-10-24', repeat: 'daily' }, '2026-10-25'), occursOn({ date: '2026-10-24', repeat: 'daily' }, '2026-10-23')], [true, false])
check('einmalig: nur der Tag', [occursOn({ date: '2026-10-24', repeat: 'none' }, '2026-10-24'), occursOn({ date: '2026-10-24', repeat: 'none' }, '2026-10-25')], [true, false])

/* -- Entries ---------------------------------------------------------------------- */

check('Eintrag ohne Namen gilt nicht', normalizeEvent({ title: '  ', date: '2026-11-26' }), null)
check('Eintrag mit falschem Datum gilt nicht', normalizeEvent({ title: 'x', date: '2026-02-31' }), null)
const kept = normalizeEvent({ id: 'a', title: ' Zahnarzt ', date: '2026-11-26', time: '09:30', endTime: '08:00', remind: 30, repeat: 'sonstwas', note: ' Karte mitnehmen ', updatedAt: 1 })!
check('Eintrag: Ende vor dem Anfang fällt weg, unbekannte Wiederholung ist einmalig', [kept.title, kept.endTime, kept.repeat, kept.note, kept.remind], ['Zahnarzt', undefined, 'none', 'Karte mitnehmen', 30])
check('Erinnerung ohne Uhrzeit fällt weg', normalizeEvent({ title: 'x', date: '2026-11-26', remind: 10 })!.remind, undefined)
check('Uhrzeit: 24:00 und 9:5 gelten nicht', [normalizeEvent({ title: 'x', date: '2026-11-26', time: '24:00' })!.time, normalizeEvent({ title: 'x', date: '2026-11-26', time: '9:5' })!.time], [undefined, undefined])
check('Steuerzeichen im Namen werden Leerzeichen', normalizeEvent({ title: 'a\u0000b\nc', date: '2026-11-26' })!.title, 'a b c')

/* -- A day ------------------------------------------------------------------------ */

const events: CalEvent[] = [
  { id: 'e1', title: 'Zahnarzt', date: '2026-11-26', time: '09:30', repeat: 'none', updatedAt: 1 },
  { id: 'e2', title: 'Geburtstag Mia', date: '2026-11-26', repeat: 'none', updatedAt: 1 },
  { id: 'e3', title: 'Sport', date: '2026-11-05', time: '18:00', repeat: 'weekly', remind: 60, updatedAt: 1 },
]
const series = [
  { id: 's1', title: 'Frieren', airing: { weekday: 3, time: '18:00' }, status: 'watching' },
  { id: 's2', title: 'Pausiert', airing: { weekday: 3, time: '20:00' }, status: 'paused' },
  { id: 's3', title: 'Ohne Tag', status: 'watching' },
]
check('Tag: ohne Zeit zuerst, dann nach der Uhr, Pausiertes fehlt', itemsOn('2026-11-26', events, series).map((i) => `${i.time ?? '–'} ${i.title}`), ['– Geburtstag Mia', '09:30 Zahnarzt', '18:00 Frieren', '18:00 Sport'])
check('Tag: eine Serie nur an ihrem Wochentag', itemsOn('2026-11-27', events, series).map((i) => i.title), [])

/* -- Reminders ---------------------------------------------------------------------- */

const told: Record<string, number> = {}
// Thursday 26 Nov 2026, 17:30: Sport (18:00, one hour before) is due from 17:00.
const at1730 = new Date(2026, 10, 26, 17, 30)
const due = dueReminders(at1730, events, series, told)
check('Erinnerung: eine Stunde vorher ist fällig', due.map((d) => [d.key, d.title, d.body]), [['event:e3@2026-11-26', 'Sport', 'Um 18:00 Uhr']])
check('Erinnerung: zu früh noch nicht', dueReminders(new Date(2026, 10, 26, 16, 59), events, series, told), [])
check('Erinnerung: eine Serie ohne Erinnerung meldet sich nicht', dueReminders(new Date(2026, 10, 26, 18, 0), events, series, {}).some((d) => d.title.includes('Frieren')), false)
check('Erinnerung: nach der Karenz nicht mehr (31 Minuten nach 18:00)', dueReminders(new Date(2026, 10, 26, 18, 31), events, series, told), [])
check('Erinnerung: kurz nach der Zeit „Jetzt“', dueReminders(new Date(2026, 10, 26, 18, 10), events, series, told)[0]?.body, 'Jetzt, 18:00 Uhr')
rememberReminders(due.map((d) => d.key), at1730.getTime())
check('Erinnerung: einmal gesagt, nie wieder', dueReminders(new Date(2026, 10, 26, 17, 45), events, series, toldReminders(at1730.getTime())), [])
check('Erinnerung: die nächste Woche ist ein neues Mal', dueReminders(new Date(2026, 11, 3, 17, 30), events, series, toldReminders(new Date(2026, 11, 3).getTime())).map((d) => d.key), ['event:e3@2026-12-03'])
const withSeries = [{ id: 's1', title: 'Frieren', airing: { weekday: 3, time: '18:00', remind: 0 }, status: 'watching' }]
check('Erinnerung zur Sendezeit einer Serie', dueReminders(new Date(2026, 10, 26, 18, 0), [], withSeries, {}).map((d) => [d.title, d.body]), [['Heute: Frieren', 'Jetzt, 18:00 Uhr']])
check('Erinnerung: ein Tag vorher, über Mitternacht', dueReminders(new Date(2026, 10, 25, 9, 31), [{ id: 'z', title: 'Zahnarzt', date: '2026-11-26', time: '09:30', repeat: 'none', remind: 1440, updatedAt: 1 }], [], {}).map((d) => d.key), ['event:z@2026-11-26'])
check('Erinnerung am Tag der Herbst-Umstellung zur richtigen Wanduhr', dueReminders(new Date(2026, 9, 25, 17, 0), [{ id: 'w', title: 'Wand', date: '2026-10-25', time: '18:00', repeat: 'none', remind: 60, updatedAt: 1 }], [], {}).length, 1)
check('Gesagtes wird nach einer Woche vergessen', Object.keys(toldReminders(at1730.getTime() + 8 * 86_400_000)), [])

/* -- The store ---------------------------------------------------------------------- */

const saved = saveEvent({ title: 'Test', date: '2026-12-01', time: '12:00', repeat: 'weekly', remind: 10 })!
check('Speichern: im Speicher und auf der Platte', [useCalendar.getState().events.length, JSON.parse(store.get('sondra:kalender')!).length], [1, 1])
saveEvent({ ...saved, title: 'Test 2' })
check('Speichern mit derselben Kennung ersetzt', [useCalendar.getState().events.length, useCalendar.getState().events[0].title], [1, 'Test 2'])
check('Speichern ohne Namen: abgelehnt, nichts geändert', [saveEvent({ title: '', date: '2026-12-01' }), useCalendar.getState().events.length], [null, 1])
deleteEvent(saved.id)
check('Löschen', useCalendar.getState().events.length, 0)

if (failures > 0) {
  console.error(`\n${failures} Prüfung(en) fehlgeschlagen.`)
  process.exit(1)
}
console.log('\nAlles in Ordnung.')
