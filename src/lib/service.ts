/**
 * Extraction service client — the one feature that leaves the machine.
 *
 * YouTube and comparable portals do not send `Access-Control-Allow-Origin`, so a
 * web page cannot read their media no matter how it asks. That is not a gap in
 * this app; it is the same-origin policy doing its job. The only way through is
 * a server that fetches on the visitor's behalf, and a server that fetches on
 * your behalf sees the address you asked for and the address you asked from.
 *
 * So this is opt-in, off by default, and the UI says plainly what it costs.
 *
 * The wire format is the one cobalt established and several implementations now
 * speak, which means the endpoint is the user's choice — a public instance they
 * trust, or one they run themselves. Nothing is hard-coded here, because
 * shipping a default would quietly send everyone's URLs to a machine neither
 * they nor this project controls.
 */

import { IN_DESKTOP_APP } from './desktop'

export type DownloadMode = 'auto' | 'audio' | 'mute'
export type VideoQuality = 'max' | '2160' | '1440' | '1080' | '720' | '480' | '360'
export type AudioFormat = 'best' | 'mp3' | 'opus' | 'wav'

export interface ServiceSettings {
  /** Base URL of the extraction service. Empty means the feature is unusable. */
  endpoint: string
  downloadMode: DownloadMode
  videoQuality: VideoQuality
  audioFormat: AudioFormat
}

export const DEFAULT_SERVICE: ServiceSettings = {
  endpoint: '',
  downloadMode: 'auto',
  videoQuality: '1080',
  audioFormat: 'best',
}

/** One media item the service offers. */
export interface ServiceItem {
  url: string
  filename: string
  kind: 'video' | 'audio' | 'photo' | 'gif'
}

/**
 * A job the service hands back for the client to finish.
 *
 * Newer cobalt versions answer `local-processing` for anything that needs
 * muxing — YouTube above 360p ships video and audio as separate streams. The
 * instance proxies the parts and expects the client to combine them. That suits
 * this app exactly: FFmpeg is already here, and doing the work locally means
 * the instance never handles the finished file.
 */
export interface LocalJob {
  type: 'merge' | 'mute' | 'audio' | 'gif' | 'remux'
  /** Parts to fetch, in order. For `merge` that is video then audio. */
  tunnels: string[]
  filename: string
  mimeType: string
  /** Target codec for `audio` jobs. */
  audioFormat?: string
  /** True when the audio stream can be copied rather than re-encoded. */
  audioCopy?: boolean
  /** Tunnels point at HLS playlists rather than plain files. */
  isHls: boolean
}

export type ServiceResult =
  | { kind: 'file'; item: ServiceItem }
  | { kind: 'picker'; items: ServiceItem[] }
  | { kind: 'local'; job: LocalJob }

/** What a reachable instance says about itself. */
export interface ServiceInfo {
  version: string
  services: string[]
  /** The instance is behind a bot check this app cannot solve. */
  needsTurnstile: boolean
}

export class ServiceError extends Error {
  readonly code: string | null

  constructor(message: string, code: string | null = null) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
  }
}

/**
 * Turns the service's error codes into something a person can act on.
 *
 * Every line here reports somebody else's answer. The service is the visitor's
 * own — a public instance they picked, or a bridge on their own machine — and
 * Sondra neither filters what is sent to it nor second-guesses what comes
 * back: `runService` forwards whatever stands in the field, and
 * `resolveViaProvider` takes the reply as given.
 *
 * That has to be audible in the wording, and it was not. „Diese Adresse kennt
 * der Dienst nicht" read as though this app had refused, which sent at least
 * one person looking for a restriction here to remove. There is none. The
 * sentence now names who said no.
 */
export function explain(code: string | null, detail?: string | null): string {
  if (!code) return 'Der Dienst hat die Anfrage abgelehnt.'
  if (code.includes('ytdlp.cookies')) {
    return (
      'Die Anmeldung aus dem gewählten Browser liess sich nicht lesen. Chrome und Edge sperren ' +
      'ihre Cookies, solange sie offen sind, und verschlüsseln sie so, dass andere Programme sie ' +
      'oft gar nicht lesen können. Beim nächsten Versuch wird wieder gefragt — Firefox klappt am ' +
      'zuverlässigsten.'
    )
  }
  if (code.includes('ytdlp.outdated')) {
    return (
      'yt-dlp kommt mit dieser Seite gerade nicht zurecht, auch nicht in der neuesten Fassung. ' +
      'Das passiert, wenn die Seite etwas umgestellt hat; meist gibt es nach wenigen Tagen eine ' +
      'neue Fassung von yt-dlp' + (IN_DESKTOP_APP ? ', die Sondra dann selbst holt.' : '.') +
      (detail ? ` yt-dlp meldet: „${detail}“` : '')
    )
  }
  if (code.includes('link.invalid') || code.includes('link.unsupported')) {
    return (
      'Der verbundene Dienst antwortet, dass er diese Seite nicht kennt — die Absage kommt von ' +
      'ihm, nicht von Sondra. Ein anderer Dienst oder eine neuere Fassung kann sie unter ' +
      'Umständen.'
    )
  }
  if (code.includes('content.video.unavailable') || code.includes('content.video.private')) {
    return 'Das Video ist nicht öffentlich abrufbar.'
  }
  if (code.includes('content.video.age')) return 'Das Video ist altersbeschränkt.'
  if (code.includes('content.video.region')) return 'Das Video ist in der Region des Dienstes gesperrt.'
  if (code.includes('content.too_long')) return 'Das Video überschreitet die Längenbegrenzung des Dienstes.'
  // Die beiden Codes der yt-dlp-Brücke. Beide haben eine konkrete Abhilfe, und
  // die gehört in die Meldung — sonst steht dort nur, dass es nicht ging.
  // In the app, the service is the app's own and asks its questions itself.
  if (IN_DESKTOP_APP && code.includes('ytdlp.signin')) {
    return (
      'YouTube verlangt für dieses Video eine Anmeldung. Beim nächsten Versuch fragt Sondra, aus ' +
      'welchem Browser sie kommen soll — dort müssen Sie bei YouTube angemeldet sein.'
    )
  }
  if (IN_DESKTOP_APP && code.includes('ytdlp.missing')) {
    return (
      'Ohne yt-dlp geht dieser Weg nicht. Beim nächsten Versuch fragt Sondra noch einmal, ob es ' +
      'geladen werden soll; es braucht dafür eine Internetverbindung zu github.com.'
    )
  }
  if (code.includes('ytdlp.signin')) {
    return (
      'YouTube verlangt für dieses Video eine Anmeldung („bestätigen, dass Sie kein Bot sind"). ' +
      'Starten Sie die Brücke mit dem Browser neu, in dem Sie bei YouTube angemeldet sind — ' +
      'also mit --cookies firefox am Ende des Befehls. Statt firefox geht auch chrome, edge, ' +
      'brave, opera oder safari.'
    )
  }
  if (code.includes('ytdlp.missing')) {
    return (
      'Die Brücke läuft, findet aber yt-dlp nicht. Die Programmdatei gehört in denselben Ordner ' +
      'wie sondra-ytdlp.mjs.'
    )
  }
  if (code.includes('auth')) return 'Der Dienst verlangt einen Zugangsschlüssel.'
  if (code.includes('rate_exceeded')) return 'Zu viele Anfragen an den Dienst. Später erneut versuchen.'
  if (code.includes('fetch') || code.includes('unreachable')) {
    // The service's own words, when it sent them: "could not reach" alone
    // left nobody able to tell a bot check from a dead link.
    return detail
      ? `Der Dienst kam an die Quelle nicht heran. yt-dlp meldet: „${detail}“`
      : 'Der Dienst konnte die Quelle selbst nicht erreichen.'
  }
  return `Der Dienst meldet: ${code}`
}

interface ServiceResponse {
  status?: string
  url?: string
  filename?: string
  picker?: { type?: string; url?: string; thumb?: string }[]
  audio?: string | { format?: string; copy?: boolean }
  audioFilename?: string
  type?: string
  tunnel?: string[]
  isHLS?: boolean
  output?: { type?: string; filename?: string }
  error?: { code?: string; detail?: string }
}

/**
 * Hosts that are obviously media pages rather than an API.
 *
 * Pasting the video URL into the service field is the mistake everyone makes
 * first — the two fields sit near each other and both want a URL. Catching it
 * by name gives a useful answer instead of "youtube.com does not respond",
 * which is true but tells nobody anything.
 */
const MEDIA_HOSTS =
  /(?:^|\.)(?:youtube\.com|youtu\.be|soundcloud\.com|vimeo\.com|tiktok\.com|twitter\.com|x\.com|instagram\.com|reddit\.com|twitch\.tv|bilibili\.com|dailymotion\.com|facebook\.com|spotify\.com)$/i

/**
 * Hostnames that mean "this machine".
 *
 * `host.docker.internal` belongs here too: Docker Desktop routes it back to the
 * host, so a service reached through it is as local as one on 127.0.0.1. Left
 * out, it was refused for not being HTTPS — a true statement about a rule that
 * does not apply, which is the least useful kind of error message.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])
const LOCAL_HOSTS = new Set([...LOOPBACK_HOSTS, 'host.docker.internal'])

/**
 * Which address space a target actually sits in.
 *
 * There are three, and the distinction turned out to be the whole ballgame:
 * `loopback` is this very machine, `local` is the network it sits on (the
 * router, a printer, a NAS), `public` is everything else. A request may declare
 * where it is going — but the browser checks that declaration against where the
 * request really lands, and a wrong one is not ignored. It fails the check, and
 * the request dies without so much as a prompt.
 *
 * That is exactly what happened here: `local` was declared for an address on
 * `127.0.0.1`, and the symptom was maddening — permission available, permission
 * not denied, no question asked, request dead. Measured afterwards from a hosted
 * page against all four values, only `loopback` reaches `127.0.0.1`.
 */
function addressSpaceFor(target: string): 'loopback' | 'local' {
  try {
    return LOOPBACK_HOSTS.has(new URL(target).hostname) ? 'loopback' : 'local'
  } catch {
    return 'local'
  }
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim()
  if (!trimmed) throw new ServiceError('Es ist kein Dienst hinterlegt.')
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
  try {
    const url = new URL(withScheme)

    if (MEDIA_HOSTS.test(url.hostname)) {
      throw new ServiceError(
        `${url.hostname} ist die Adresse des Videos, nicht die des Dienstes. Oben gehört der Link ` +
          'zum Medium hin; hier die Adresse Ihres eigenen Dienstes.',
      )
    }

    const local = LOCAL_HOSTS.has(url.hostname)
    if (url.protocol !== 'https:' && !local) {
      // A page served over HTTPS cannot talk to an HTTP endpoint at all — the
      // browser blocks it as mixed content before the request is made. Saying
      // so here is more useful than letting fetch fail opaquely.
      throw new ServiceError(
        'Der Dienst muss über HTTPS erreichbar sein. Ein Browser blockiert HTTP-Anfragen von einer ' +
          'HTTPS-Seite (Ausnahme: localhost).',
      )
    }
    return url.href
  } catch (error) {
    if (error instanceof ServiceError) throw error
    throw new ServiceError('Die Adresse des Dienstes ist keine gültige URL.')
  }
}


/** True for addresses that live on the machine running the browser. */
export function isLoopback(endpoint: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(endpoint).hostname)
  } catch {
    return false
  }
}

/** True when this page itself is being served from that same machine. */
export function pageIsLocal(): boolean {
  return isLoopback(window.location.origin)
}

/**
 * Fetches, and if the browser refuses, asks once more the way it wants to be
 * asked.
 *
 * A page served from the internet reaching for `localhost` is the shape of a
 * cross-site attack on someone's router, so browsers gate it: since Chrome 141
 * such a request needs the visitor's permission, and an HTTPS page asking for
 * `http://` would be refused as mixed content besides. `targetAddressSpace:
 * 'local'` is how a request declares where it is going, which is what lets the
 * browser put the question to the visitor rather than dropping the request in
 * silence — and a granted permission lifts the mixed-content refusal too.
 *
 * It is the second attempt, not the first, and that ordering was earned: the
 * declaration is checked against where the request actually lands, so asserting
 * "local" for an address that turns out to be loopback fails a request that
 * would otherwise have gone through. Measured, not assumed — a page on a
 * hostname of its own that resolves to 127.0.0.1 broke exactly that way. So the
 * plain attempt goes first and the declaration is kept for the case it is for.
 */
/**
 * What the browser has decided about reaching this machine.
 *
 * Chrome exposes the local network permission like any other, which turns the
 * whole question from guesswork into a fact: `granted` and a failure means the
 * service really is not there, `denied` means the visitor said no once and the
 * browser will not ask again, `prompt` means it has yet to be asked. Browsers
 * without the permission answer `unsupported`, which is its own useful answer —
 * those need the older arrangement where the service itself vouches for the
 * request.
 */
export async function localNetworkPermission(): Promise<'granted' | 'denied' | 'prompt' | 'unsupported'> {
  try {
    const status = await navigator.permissions.query({
      name: 'local-network-access' as PermissionName,
    })
    return status.state
  } catch {
    return 'unsupported'
  }
}

/**
 * Asks for the local network in the one way that can produce a prompt.
 *
 * A permission prompt needs a real click behind it, and it needs the request to
 * declare where it is going. This does both and nothing else, so it can be
 * wired straight to a button rather than buried under a retry the browser may
 * no longer consider user-initiated.
 */
export async function requestLocalAccess(target: string): Promise<Response> {
  const init = {
    credentials: 'omit' as const,
    headers: { Accept: 'application/json' },
    // No short deadline here. This request is what makes the browser put the
    // permission question on screen, and the clock would otherwise be running
    // while somebody reads it — eight seconds is a plausible time to think, and
    // aborting then would cancel the very request the answer was meant for.
    signal: AbortSignal.timeout(120_000),
  }
  const first = addressSpaceFor(target)
  try {
    return await fetch(target, { ...init, targetAddressSpace: first } as RequestInit)
  } catch {
    // A hostname can resolve into either space, so the other one gets a turn.
    const second = first === 'loopback' ? 'local' : 'loopback'
    return await fetch(target, { ...init, targetAddressSpace: second } as RequestInit)
  }
}

export async function fetchLocalAware(target: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(target, init)
  } catch (error) {
    if (!isLoopback(target) || pageIsLocal()) throw error
    const first = addressSpaceFor(target)
    const second = first === 'loopback' ? 'local' : 'loopback'
    try {
      // Not in the DOM typings yet; a browser that does not know the member
      // ignores it, and the retry then fails the same way the first did.
      return await fetch(target, { ...init, targetAddressSpace: first } as RequestInit)
    } catch {
      return await fetch(target, { ...init, targetAddressSpace: second } as RequestInit)
    }
  }
}

/**
 * Turns a fetch rejection into something the user can act on.
 *
 * The awkward case is a hosted page reaching for a service on the visitor's own
 * machine. Browsers treat that as a public site poking at a private network and
 * block it, preflight and all — the service answering perfectly makes no
 * difference, and from inside the page the failure looks exactly like "nothing
 * is running there". Since that is the one case where the obvious diagnosis is
 * the wrong one, it gets named rather than guessed at.
 */
function describeUnreachable(endpoint: string): ServiceError {
  let host = endpoint
  try {
    host = new URL(endpoint).host
  } catch {
    /* keep the raw string */
  }

  if (isLoopback(endpoint) && !pageIsLocal()) {
    return new ServiceError(
      `${host} war nicht erreichbar. Läuft der Dienst dort, liegt es nicht an ihm: Diese Seite kommt ` +
        'aus dem Netz und greift auf Ihren eigenen Rechner zu, und dafür verlangt der Browser seit ' +
        'Kurzem Ihre ausdrückliche Erlaubnis. Er sollte danach fragen — sagen Sie ja. Haben Sie ' +
        'vorher einmal abgelehnt, fragt er nicht wieder: dann im Schloss-Symbol links in der ' +
        'Adresszeile unter den Berechtigungen den Zugriff aufs lokale Netzwerk erlauben und neu ' +
        'laden. Zuverlässig ohne all das geht es, wenn Sondra selbst lokal läuft.',
      'local-network-blocked',
    )
  }

  return new ServiceError(
    `${host} antwortet nicht, oder die Instanz erlaubt keine Anfragen von dieser Seite. ` +
      'Prüfen Sie die Adresse und stellen Sie sicher, dass die Instanz CORS für diesen Ursprung ' +
      'freigibt (bei cobalt ist das die Voreinstellung).',
  )
}

/**
 * Asks a reachable instance what it is and what it can do.
 *
 * Worth its own round trip: it separates "wrong address" from "instance is fine
 * but does not offer YouTube", which is the difference between a typo and a
 * configuration problem, and the user cannot tell those apart from a failed
 * download alone.
 */
export async function probeService(
  endpoint: string,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<ServiceInfo> {
  const normalized = normalizeEndpoint(endpoint)

  let response: Response
  try {
    response = await fetchLocalAware(normalized, {
      signal,
      credentials: 'omit',
      headers: { Accept: 'application/json', ...(apiKey ? { Authorization: `Api-Key ${apiKey}` } : {}) },
    })
  } catch {
    throw describeUnreachable(normalized)
  }

  let body: { cobalt?: { version?: string; services?: string[]; turnstileSitekey?: string } }
  try {
    body = await response.json()
  } catch {
    throw new ServiceError(
      `Unter dieser Adresse antwortet etwas (${response.status}), aber kein Dienst, den Sondra ` +
        'ansprechen kann. Zeigt die Adresse vielleicht auf eine Weboberfläche statt auf die API?',
    )
  }

  if (!body.cobalt) {
    throw new ServiceError(
      'Die Antwort passt nicht zu der Schnittstelle, die Sondra spricht. Erwartet wird die ' +
        'yt-dlp-Brücke oder eine cobalt-Instanz.',
    )
  }

  return {
    version: body.cobalt.version ?? 'unbekannt',
    services: body.cobalt.services ?? [],
    needsTurnstile: Boolean(body.cobalt.turnstileSitekey),
  }
}

/**
 * Looks for an instance running on this machine.
 *
 * Each candidate gets a short timeout, because a closed port on localhost fails
 * instantly but a firewalled one can hang until the default timeout — and
 * waiting thirty seconds to be told "nothing here" is worse than useless.
 */
export async function findLocalInstance(
  candidates: string[],
  signal?: AbortSignal,
): Promise<{ endpoint: string; info: ServiceInfo } | null> {
  for (const candidate of candidates) {
    if (signal?.aborted) return null
    try {
      const timeout = AbortSignal.timeout(2500)
      const combined = signal ? AbortSignal.any([signal, timeout]) : timeout
      const info = await probeService(candidate, null, combined)
      return { endpoint: candidate, info }
    } catch {
      // Nothing there, or not a cobalt API. Try the next one.
    }
  }
  return null
}

/**
 * Keeps looking until an instance appears on this machine.
 *
 * Setting one up means leaving the page, running a command, and coming back —
 * and the coming back is where people give up, because nothing tells them it
 * worked. So rather than asking for another button press afterwards, this waits
 * and notices by itself. A sweep is cheap: a closed port on localhost refuses
 * the connection immediately, so most attempts cost nothing at all.
 *
 * Bounded, because a promise that never settles is a leak with better manners.
 */
export async function watchForInstance(
  candidates: string[],
  options: { signal?: AbortSignal; intervalMs?: number; timeoutMs?: number } = {},
): Promise<{ endpoint: string; info: ServiceInfo } | null> {
  const { signal, intervalMs = 2000, timeoutMs = 300_000 } = options
  const deadline = Date.now() + timeoutMs

  while (!signal?.aborted && Date.now() < deadline) {
    const found = await findLocalInstance(candidates, signal)
    if (found) return found
    await pause(intervalMs, signal)
  }
  return null
}

/** Resolves after `ms`, or as soon as the caller gives up — never rejects. */
function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })
}

/**
 * Asks the service what it can offer for `mediaUrl`.
 *
 * `apiKey` is passed through but never stored — a credential in localStorage
 * outlives the session and the intent behind it.
 */
export async function resolveMedia(
  mediaUrl: string,
  settings: ServiceSettings,
  apiKey: string | null,
  signal?: AbortSignal,
): Promise<ServiceResult> {
  const endpoint = normalizeEndpoint(settings.endpoint)

  let response: Response
  try {
    response = await fetchLocalAware(endpoint, {
      method: 'POST',
      signal,
      credentials: 'omit',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Api-Key ${apiKey}` } : {}),
      },
      body: JSON.stringify({
        url: mediaUrl,
        downloadMode: settings.downloadMode,
        videoQuality: settings.videoQuality,
        audioFormat: settings.audioFormat,
        filenameStyle: 'basic',
      }),
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    throw describeUnreachable(endpoint)
  }

  let body: ServiceResponse
  try {
    body = (await response.json()) as ServiceResponse
  } catch {
    throw new ServiceError(`Der Dienst antwortete mit ${response.status} und keinem gültigen JSON.`)
  }

  if (body.status === 'error' || !response.ok) {
    const code = body.error?.code ?? null
    throw new ServiceError(explain(code, body.error?.detail), code)
  }

  // "tunnel" streams through the service, "redirect" hands back the origin URL.
  if ((body.status === 'tunnel' || body.status === 'redirect') && body.url) {
    return {
      kind: 'file',
      item: {
        url: body.url,
        filename: body.filename ?? 'download',
        kind: settings.downloadMode === 'audio' ? 'audio' : 'video',
      },
    }
  }

  // The instance proxied the parts and left the muxing to us.
  if (body.status === 'local-processing' && Array.isArray(body.tunnel) && body.tunnel.length > 0) {
    const audio = typeof body.audio === 'object' && body.audio !== null ? body.audio : undefined
    return {
      kind: 'local',
      job: {
        type: (body.type as LocalJob['type']) ?? 'remux',
        tunnels: body.tunnel.filter((url): url is string => typeof url === 'string'),
        filename: body.output?.filename ?? body.filename ?? 'download',
        mimeType: body.output?.type ?? 'application/octet-stream',
        audioFormat: audio?.format,
        audioCopy: audio?.copy ?? true,
        isHls: Boolean(body.isHLS),
      },
    }
  }

  if (body.status === 'picker' && Array.isArray(body.picker)) {
    const items: ServiceItem[] = body.picker
      .filter((entry): entry is { type?: string; url: string } => typeof entry.url === 'string')
      .map((entry, index) => ({
        url: entry.url,
        filename: `${index + 1}-${body.filename ?? 'download'}`,
        kind: entry.type === 'photo' ? 'photo' : entry.type === 'gif' ? 'gif' : 'video',
      }))
    if (typeof body.audio === 'string') {
      items.push({ url: body.audio, filename: body.audioFilename ?? 'audio', kind: 'audio' })
    }
    if (items.length === 0) throw new ServiceError('Der Dienst lieferte eine leere Auswahl.')
    return { kind: 'picker', items }
  }

  throw new ServiceError(`Unerwartete Antwort des Dienstes (status: ${body.status ?? 'unbekannt'}).`)
}

/** FFmpeg arguments that finish a local-processing job. */
export function localJobArgs(job: LocalJob, inputs: string[], output: string): string[] {
  const args = inputs.flatMap((name) => ['-i', name])

  switch (job.type) {
    // No `+faststart` on the copies: it moves the index to the front for
    // streaming from a web server, by writing the whole file a second time —
    // for a file that ends up in the session or on disk, that second pass was
    // most of the wait at the end of a download.
    case 'merge':
      // Separate video and audio streams, already in the right codecs.
      return [...args, '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', output]
    case 'mute':
      return [...args, '-an', '-c:v', 'copy', output]
    case 'audio':
      return [
        ...args,
        '-vn',
        ...(job.audioCopy ? ['-c:a', 'copy'] : ['-c:a', audioEncoder(job.audioFormat)]),
        output,
      ]
    case 'gif':
      return [
        ...args,
        '-filter_complex',
        'fps=15,scale=-1:480:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse',
        '-loop',
        '0',
        output,
      ]
    case 'remux':
    default:
      return [...args, '-c', 'copy', output]
  }
}

function audioEncoder(format: string | undefined): string {
  switch (format) {
    case 'mp3':
      return 'libmp3lame'
    case 'opus':
      return 'libopus'
    case 'wav':
      return 'pcm_s16le'
    default:
      return 'aac'
  }
}

/** Container extension for a finished local job. */
export function localJobExtension(job: LocalJob): string {
  if (job.type === 'gif') return 'gif'
  if (job.type === 'audio') return job.audioFormat && job.audioFormat !== 'best' ? job.audioFormat : 'm4a'
  const fromName = job.filename.match(/\.([a-z0-9]{2,5})$/i)?.[1]
  return fromName ?? 'mp4'
}

/**
 * The notice shown whenever the feature is switched on.
 *
 * Two versions, because the truth differs. Against somebody else's instance
 * the address really does leave the machine and a stranger could log it.
 * Against the bridge on this computer there is no stranger — but YouTube still
 * sees the request, and saying "completely local" would be a lie of omission.
 *
 * The liability sentence is the same in both and is not conditional.
 */
export const SERVICE_DISCLAIMER = {
  title: 'Diese Funktion verlässt das lokale Prinzip',
  paragraphs: [
    'Die eingegebene Adresse geht samt Ihrer IP an den hinterlegten Dienst; er holt die Datei und ' +
      'reicht sie durch. Was sein Betreiber protokolliert, entzieht sich Sondra vollständig — wählen ' +
      'Sie einen Dienst, dem Sie vertrauen, oder betreiben Sie eine eigene Instanz.',
    'Alle übrigen Werkzeuge bleiben lokal: Konvertierung, Spurentrennung, Lautheit und Sampler ' +
      'rechnen weiterhin ausschließlich auf Ihrem Gerät.',
  ],
  liability:
    'Haftungsausschluss: Die Nutzung erfolgt auf eigene Verantwortung und eigenes Risiko. Für die ' +
    'Rechtmäßigkeit der abgerufenen Inhalte, für Verstöße gegen Nutzungsbedingungen oder ' +
    'Urheberrechte Dritter und für Schäden jeder Art wird keinerlei Haftung übernommen.',
} as const

/** The same notice when the service is the bridge on this very machine. */
export const LOCAL_SERVICE_DISCLAIMER = {
  title: 'Was dabei Ihr Gerät verlässt',
  paragraphs: [
    'Der Dienst läuft auf diesem Rechner, kein fremder Server ist dazwischen — niemand außer Ihnen ' +
      'sieht also, welche Adressen Sie abrufen.',
    'Die Anfrage selbst geht trotzdem hinaus: YouTube sieht sie und damit Ihre IP-Adresse, so wie ' +
      'beim normalen Ansehen auch. Alle übrigen Werkzeuge rechnen weiterhin ausschließlich hier.',
  ],
  liability:
    'Haftungsausschluss: Die Nutzung erfolgt auf eigene Verantwortung und eigenes Risiko. Für die ' +
    'Rechtmäßigkeit der abgerufenen Inhalte, für Verstöße gegen Nutzungsbedingungen oder ' +
    'Urheberrechte Dritter und für Schäden jeder Art wird keinerlei Haftung übernommen.',
} as const
