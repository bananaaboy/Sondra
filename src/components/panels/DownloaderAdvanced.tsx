/**
 * Media downloader — one panel, three paths.
 *
 * A direct link, an HLS playlist and a portal URL are the same task from the
 * user's side: paste an address, get the file. So they share one address field
 * and one button, and the path is picked from the address itself rather than
 * asked about up front. The chips underneath say which path was chosen and let
 * it be overridden.
 *
 * The third path is the one that costs something. A browser can only read a
 * remote file if that server allows it, and portals do not — so reaching them
 * means a server in the middle that sees the address and the IP. That option is
 * off by default, and switching it on unfolds its terms in place rather than
 * hiding them behind a link. *
 * ## Why this is now the second way in
 *
 * This panel is the complete one: it speaks to a cobalt instance or to the
 * yt-dlp bridge running on your own machine, it knows about cookies, quality
 * tiers, playlists and local post-processing, and it is the only route that
 * reaches YouTube at full resolution. It also asks you to install something
 * first, which for most visits is one hurdle too many.
 *
 * So the plain panel in front of it does the common case with nothing to set
 * up, and this one is a click away under "Mehr Wege" for when that is not
 * enough. Nothing here was removed; it simply stopped being the first thing
 * anyone sees.

 */

import { useEffect, useRef, useState } from 'react'

import { openGetAppDialog } from '../GetApp'

import {
  audioFor,
  fetchHlsSegments,
  fetchMedia,
  fetchPlaylist,
  saveBytes,
  streamToDisk,
  TransferError,
  isPortalUrl,
  type HlsPlaylist,
  type TransferProgress,
} from '../../lib/download'
import { detectCapabilities } from '../../lib/capabilities'
import {
  DEFAULT_SERVICE,
  findLocalInstance,
  isLoopback,
  probeService,
  localNetworkPermission,
  pageIsLocal,
  requestLocalAccess,
  LOCAL_SERVICE_DISCLAIMER,
  SERVICE_DISCLAIMER,
  watchForInstance,
  type AudioFormat,
  type DownloadMode,
  type ServiceInfo,
  type ServiceSettings,
  type VideoQuality,
} from '../../lib/service'
import { loadFfmpeg, runFfmpeg } from '../../lib/ffmpegClient'
import { formatBytes, sanitizeFilename } from '../../lib/format'
import { offerDownloadToDrive } from '../../lib/googleDrive'
import {
  DEFAULT_PORT,
  localSteps,
  localCandidates,
  manualPrerequisite,
  composeFile,
  nodeOnlyUnixScript,
  nodeOnlyWindowsScript,
  nodeUnixScript,
  nodeWindowsScript,
  unixScript,
  windowsScript,
  oneLiner,
  rememberedInstances,
  rememberInstance,
  ytdlpSteps,
  ytdlpUnixLauncher,
  ytdlpWindowsLauncher,
  launcherFilename,
} from '../../lib/selfhost'
import { detectPlatform } from '../../lib/platform'
import { serviceConnection, setServiceConnection } from '../../lib/serviceState'
import { kindFromMime, useSession } from '../../state/store'
import { ChoiceRow } from '../editor/EditorShell'
import {
  ArrowRight,
  Badge,
  Button,
  Card,
  Dialog,

  Field,
  Notice,
  Progress,
  Select,
  TextInput,
  Toggle,
} from '../ui/primitives'

type Mode = 'direct' | 'hls'

const SERVICE_STORAGE_KEY = 'sondra:service'

/** Only the endpoint and the quality choices persist — never the API key. */
function readServiceSettings(): ServiceSettings {
  try {
    const raw = readStored(SERVICE_STORAGE_KEY, 'lizge:service')
    if (raw) return { ...DEFAULT_SERVICE, ...(JSON.parse(raw) as Partial<ServiceSettings>) }
  } catch {
    /* blocked storage, or somebody hand-edited it */
  }
  return DEFAULT_SERVICE
}

function writeServiceSettings(settings: ServiceSettings): void {
  try {
    localStorage.setItem(SERVICE_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* the setting simply will not survive a reload */
  }
}


/**
 * Reads a stored value, falling back to the key this app used under its old
 * name. Renaming the product should not quietly throw away what someone saved.
 */
function readStored(key: string, previous: string): string | null {
  try {
    const current = localStorage.getItem(key)
    if (current !== null) return current
    const legacy = localStorage.getItem(previous)
    if (legacy !== null) localStorage.setItem(key, legacy)
    return legacy
  } catch {
    return null
  }
}

/**
 * The options behind the one address field, not a second downloader.
 *
 * This used to carry an address field of its own, which meant the panel asked
 * the same question twice: paste up there, or paste down here, and nothing on
 * screen said which one was meant. The address now lives once, at the top, and
 * is handed down — everything here acts on it.
 */
export function AdvancedDownloader({ url }: { url: string }) {
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const caps = detectCapabilities()

  // Null means "whatever the address implies"; a value is a deliberate override.
  const [modeOverride, setModeOverride] = useState<Mode | null>(null)
  // Off by default: a download that lands in the session can be fed straight
  // into the converter or the sampler, whereas one streamed to disk cannot.
  const [streamToDiskEnabled, setStreamToDiskEnabled] = useState(false)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<TransferProgress | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [playlist, setPlaylist] = useState<HlsPlaylist | null>(null)
  const [variantUrl, setVariantUrl] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Off on every load of a page from the internet: opting into sending an
  // address to a third party is a decision worth making deliberately. On when
  // the page is served from this machine — see `serviceState`.
  //
  // Switching tabs is not a new load, though. This panel unmounts when another
  // one is shown, and starting from scratch on the way back threw away a live
  // connection while the status strip went on reporting it — the two disagreed,
  // and the panel was the one that was wrong. Both now read the same state.
  const [showPaths, setShowPaths] = useState(false)
  const [serviceEnabled, setServiceEnabled] = useState(() => serviceConnection().enabled)
  const [service, setService] = useState<ServiceSettings>(() => {
    const stored = readServiceSettings()
    // A live connection's address wins over the remembered one.
    const live = serviceConnection().endpoint
    return live ? { ...stored, endpoint: live } : stored
  })
  const [apiKey, setApiKey] = useState(() => serviceConnection().apiKey ?? '')
  // The address field loads through the service too, so it needs the key —
  // in memory only, like here.
  useEffect(() => setServiceConnection({ apiKey: apiKey || null }), [apiKey])
  const [serviceInfo, setServiceInfo] = useState<ServiceInfo | null>(() => serviceConnection().info)
  const [checking, setChecking] = useState(false)
  const [searching, setSearching] = useState(false)
  const [copied, setCopied] = useState(false)
  const [known, setKnown] = useState<string[]>(() => rememberedInstances())
  const [localWay, setLocalWay] = useState<'ytdlp' | 'node' | 'docker'>('ytdlp')
  // What is already on this machine. Both start off, because assuming a
  // stranger has a developer's toolchain is how instructions end up skipping
  // the step they most needed to include.
  const [hasNode, setHasNode] = useState(false)
  const [hasGit, setHasGit] = useState(false)
  /** Setup lives in a dialog, so the page itself stays short. */
  const [setupDialog, setSetupDialog] = useState(false)

  /** Listen for external requests to open setup dialog */
  useEffect(() => {
    const handler = () => {
      setServiceEnabled(true)
      setSetupDialog(true)
    }
    window.addEventListener('sondra:open-setup-dialog', handler)
    return () => window.removeEventListener('sondra:open-setup-dialog', handler)
  }, [])

  /** The last hand-run check, kept verbatim so it can be read or pasted. */
  const [probe, setProbe] = useState<string | null>(null)
  /** The guided setup is watching for an instance to come up. */
  const [waiting, setWaiting] = useState(false)
  const waitRef = useRef<AbortController | null>(null)
  /** The last file this panel fetched, so saving it is one click away. */
  const [fetched, setFetched] = useState<{ name: string; bytes: Uint8Array; mime: string } | null>(null)

  // A five-minute poll must not outlive the panel that started it.
  useEffect(() => () => waitRef.current?.abort(), [])


  const updateService = (patch: Partial<ServiceSettings>) => {
    setService((current) => {
      const next = { ...current, ...patch }
      writeServiceSettings(next)
      return next
    })
  }

  const platform = detectPlatform()
  // Empty on a page that is already local: the scripts then start the service
  // alone, without also serving a copy of this page.
  const hostedOrigin = pageIsLocal() ? '' : window.location.origin
  const localCommand =
    localWay === 'docker'
      ? oneLiner()
      : localWay === 'ytdlp'
        ? ytdlpSteps({ hasNode, platform, origin: window.location.origin }).join('\n')
        : localSteps({ hasNode, hasGit, platform, origin: window.location.origin }).join('\n')
  /** Node is missing and this system has no install command worth printing. */
  const needsNodeByHand = localWay !== 'docker' && manualPrerequisite({ hasNode, platform })
  const connected = serviceInfo !== null
  const endpointLabel = service.endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '')

  const detectedHls = /\.m3u8(\?|$)/i.test(url.trim())
  const detectedPortal = isPortalUrl(url)
  const autoMode: Mode = detectedHls ? 'hls' : 'direct'
  const effectiveMode: Mode = modeOverride ?? autoMode

  const reset = () => {
    setError(null)
    setPlaylist(null)
    setVariantUrl('')
    setFetched(null)
  }

  const handleFailure = (failure: unknown, scope: string) => {
    if (failure instanceof DOMException && failure.name === 'AbortError') return
    if (failure instanceof TransferError && failure.kind === 'aborted') return
    const message = failure instanceof Error ? failure.message : String(failure)
    setError(message)
    log(scope, message, 'error')
  }

  const downloadDirect = async () => {
    const target = url.trim()
    if (!target) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    reset()

    try {
      const name = sanitizeFilename(new URL(target).pathname.split('/').pop() || 'download')

      if (streamToDiskEnabled && caps.fileSystemAccess) {
        // Straight to disk: a large file never has to fit in this tab's heap.
        await streamToDisk(target, name, setProgress, controller.signal)
        log('download', `${name} direkt auf die Festplatte geschrieben`)
        return
      }

      const media = await fetchMedia(target, setProgress, controller.signal)
      const mime = media.contentType ?? 'application/octet-stream'
      addAsset({
        name: media.filename,
        bytes: media.bytes,
        mime,
        sizeBytes: media.bytes.byteLength,
        kind: kindFromMime(mime, media.filename),
        audio: null,
        durationSeconds: null,
        origin: 'download',
      })
      setFetched({ name: media.filename, bytes: media.bytes, mime })
      offerDownloadToDrive({ name: media.filename, bytes: media.bytes, mime })
      log('download', `${media.filename} geladen (${formatBytes(media.bytes.byteLength)})`)
    } catch (failure) {
      handleFailure(failure, 'download')
    } finally {
      setBusy(false)
      setProgress(null)
      abortRef.current = null
    }
  }

  const inspectPlaylist = async () => {
    const target = url.trim()
    if (!target) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    reset()

    try {
      const parsed = await fetchPlaylist(target, controller.signal)
      setPlaylist(parsed)
      if (parsed.kind === 'master' && parsed.variants.length) {
        setVariantUrl(parsed.variants[0].url)
        log('hls', `${parsed.variants.length} Qualitätsstufen gefunden`)
      } else {
        log('hls', `${parsed.segments.length} Segmente gefunden`)
      }
    } catch (failure) {
      handleFailure(failure, 'hls')
    } finally {
      setBusy(false)
      abortRef.current = null
    }
  }

  const downloadHls = async () => {
    if (!playlist) return
    const controller = new AbortController()
    abortRef.current = controller
    setBusy(true)
    setError(null)

    try {
      let media = playlist
      // A master may keep the sound in a rendition of its own; without it the
      // MP4 came out silent.
      let soundPlaylist: HlsPlaylist | null = null
      if (media.kind === 'master') {
        setNote('Qualitätsstufe wird geladen')
        const variant = media.variants.find((entry) => entry.url === variantUrl) ?? media.variants[0]
        const rendition = audioFor(media, variant)
        media = await fetchPlaylist(variant.url, controller.signal)
        if (rendition) soundPlaylist = await fetchPlaylist(rendition.url, controller.signal)
      }

      setNote('Segmente werden geladen')
      const segments = await fetchHlsSegments(
        media,
        (done, total, bytes) => {
          setProgress({
            receivedBytes: bytes,
            totalBytes: null,
            fraction: done / total,
            bytesPerSecond: 0,
          })
          setNote(`Segment ${done} von ${total}`)
        },
        controller.signal,
      )

      const sound = soundPlaylist
        ? await fetchHlsSegments(
            soundPlaylist,
            (done, total) => setNote(`Ton: Segment ${done} von ${total}`),
            controller.signal,
          )
        : null

      // Concatenated transport-stream segments are playable but seek badly;
      // remuxing to MP4 costs one stream copy and no re-encode.
      setNote('Wird zu MP4 zusammengefasst')
      setProgress(null)
      await loadFfmpeg()
      const { files } = await runFfmpeg({
        input: sound ? { 'stream.ts': segments, 'sound.ts': sound } : { 'stream.ts': segments },
        output: ['stream.mp4'],
        args: sound
          ? ['-i', 'stream.ts', '-i', 'sound.ts', '-map', '0:v:0?', '-map', '1:a:0', '-c', 'copy', '-dn', '-sn', '-movflags', '+faststart', 'stream.mp4']
          : ['-i', 'stream.ts', '-c', 'copy', '-movflags', '+faststart', 'stream.mp4'],
        signal: controller.signal,
      })

      const bytes = files['stream.mp4']
      const name = sanitizeFilename(`${new URL(url).hostname}-stream.mp4`)
      addAsset({
        name,
        bytes,
        mime: 'video/mp4',
        sizeBytes: bytes.byteLength,
        kind: 'video',
        audio: null,
        durationSeconds: null,
        origin: 'download',
      })
      setFetched({ name, bytes, mime: 'video/mp4' })
      offerDownloadToDrive({ name, bytes, mime: 'video/mp4' })
      log('hls', `${name} erzeugt (${formatBytes(bytes.byteLength)})`)
    } catch (failure) {
      handleFailure(failure, 'hls')
    } finally {
      setBusy(false)
      setProgress(null)
      setNote(null)
      abortRef.current = null
    }
  }

  /** Takes an instance into use and remembers where it was. */
  const adopt = (endpoint: string, info: ServiceInfo) => {
    updateService({ endpoint })
    setServiceInfo(info)
    setKnown(rememberInstance(endpoint))
    setSetupDialog(false)
    setError(null)
    setServiceConnection({ endpoint, info, searching: false })
  }

  /**
   * Looks on this machine the moment the switch goes on.
   *
   * Only this machine. A remembered remote address is filled in but not probed:
   * contacting a third party is the very thing this switch is a decision about,
   * so it waits for a deliberate click. Talking to localhost sends nothing
   * anywhere and costs nothing when the port is closed, so there is no reason
   * to make anyone ask for it.
   */
  const autoConnect = async () => {
    const controller = new AbortController()
    setSearching(true)
    try {
      const found = await findLocalInstance(localCandidates(), controller.signal)
      if (found) {
        adopt(found.endpoint, found.info)
        log('dienst', `Instanz auf diesem Rechner gefunden: ${found.endpoint}`)
        return
      }
      const remembered = rememberedInstances()[0]
      if (remembered && !service.endpoint.trim()) updateService({ endpoint: remembered })
    } finally {
      setSearching(false)
    }
  }

  const searchLocal = async () => {
    const controller = new AbortController()
    abortRef.current = controller
    setSearching(true)
    setError(null)
    setServiceInfo(null)
    try {
      const found = await findLocalInstance(localCandidates(), controller.signal)
      if (found) {
        adopt(found.endpoint, found.info)
        log('dienst', `Lokale Instanz gefunden: ${found.endpoint} — ${found.info.version}`)
      } else {
        setError(
          `Auf diesem Rechner läuft nichts auf Port ${DEFAULT_PORT}. Mit „Befehl kopieren“ ` +
            'starten Sie einen Dienst; Sondra verbindet sich dann von selbst.',
        )
      }
    } finally {
      setSearching(false)
      abortRef.current = null
    }
  }

  const stopWaiting = () => {
    waitRef.current?.abort()
    waitRef.current = null
    setWaiting(false)
  }

  /**
   * Copies the command, then waits for the result of running it.
   *
   * The step people fall at is not the command — it is coming back to the page
   * afterwards and not knowing what to press. So nothing has to be pressed: the
   * page keeps looking until the instance answers and then connects itself.
   */
  const startAndWait = async () => {
    try {
      await navigator.clipboard.writeText(localCommand)
      setCopied(true)
      setTimeout(() => setCopied(false), 5000)
    } catch {
      // Clipboard access can be refused; the command is on screen either way.
    }

    stopWaiting()
    const controller = new AbortController()
    waitRef.current = controller
    setWaiting(true)
    setError(null)
    try {
      const found = await watchForInstance(localCandidates(), { signal: controller.signal })
      if (found) {
        adopt(found.endpoint, found.info)
        log('dienst', `Instanz gefunden: ${found.endpoint} — ${found.info.version}`)
      } else if (!controller.signal.aborted) {
        setError(
          `Fünf Minuten lang kam auf Port ${DEFAULT_PORT} keine Antwort. ` +
            'Prüfen Sie, ob der Befehl im Terminal ausgeführt wurde.',
        )
      }
    } finally {
      if (waitRef.current === controller) waitRef.current = null
      setWaiting(false)
    }
  }

  /**
   * Keeps looking for as long as the feature is on and nothing has answered.
   *
   * The old behaviour checked once when the switch went on and then stopped,
   * which is exactly backwards: the common case is switching it on, going away
   * to start the service, and coming back to a page that has long since given
   * up. Now the page is the one that waits. A refused connection on localhost
   * costs nothing, so doing it every few seconds is cheaper than making someone
   * wonder whether it worked.
   */
  useEffect(() => {
    if (!serviceEnabled || connected || waiting) return
    setServiceConnection({ searching: true })
    const controller = new AbortController()
    let stopped = false

    const sweep = async () => {
      while (!stopped && !controller.signal.aborted) {
        const found = await findLocalInstance(localCandidates(), controller.signal)
        if (found) {
          if (!stopped) {
            adopt(found.endpoint, found.info)
            log('dienst', `Instanz gefunden: ${found.endpoint} — ${found.info.version}`)
          }
          return
        }
        await new Promise((resolve) => setTimeout(resolve, 4000))
      }
    }
    void sweep()

    return () => {
      stopped = true
      controller.abort()
      setServiceConnection({ searching: false })
    }
    // `adopt` and `log` are stable for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceEnabled, connected, waiting])

  /**
   * One button: ask for what is needed, try every address, report what happened.
   *
   * This used to be two. The check ran quietly and then told you to press a
   * second button for the permission — which is a instruction, not a solution,
   * and it also meant the permission request no longer had the click behind it
   * that a prompt needs. A browser will only put that question on screen in
   * response to a real interaction, so the request that triggers it has to be
   * the first thing this does, not the second thing after a failure.
   */
  const runProbe = async () => {
    setProbe('Wird geprüft…')
    const hosted = !pageIsLocal()
    const before = await localNetworkPermission()

    // On a hosted page the annotated request comes first, while the click is
    // still fresh. That is the one that can raise the prompt.
    if (hosted && before !== 'denied') {
      setProbe(
        'Der Browser sollte jetzt fragen, ob diese Seite auf Ihren Rechner zugreifen darf. ' +
          'Erlauben Sie es — die Prüfung läuft danach weiter.',
      )
      for (const candidate of localCandidates()) {
        try {
          await requestLocalAccess(candidate)
          const info = await probeService(candidate, null, AbortSignal.timeout(8000))
          adopt(candidate, info)
          setProbe(`Verbunden mit ${candidate} — ${info.version}, ${info.services.length} Dienste.`)
          return
        } catch {
          // Next address. The report below says what the browser decided.
        }
      }
    }

    const permission = await localNetworkPermission()
    const browser = navigator.userAgent.match(/(Chrome|Firefox|Version)\/[\d.]+/)?.[0] ?? 'unbekannt'
    const lines: string[] = [
      `Diese Seite: ${window.location.origin}`,
      `Sicherer Kontext: ${window.isSecureContext ? 'ja' : 'nein'}`,
      `Erlaubnis für lokales Netzwerk: ${
        {
          granted: 'erteilt',
          denied: 'verweigert — der Browser fragt nicht mehr von selbst',
          prompt: 'noch nicht erteilt',
          unsupported: 'kennt dieser Browser nicht',
        }[permission]
      }`,
      `Browser: ${browser}`,
      '',
    ]

    for (const candidate of localCandidates()) {
      try {
        const info = await probeService(candidate, null, AbortSignal.timeout(5000))
        lines.push(`${candidate} → ${info.version}, ${info.services.length} Dienste`)
        adopt(candidate, info)
        setProbe(lines.join('\n'))
        return
      } catch (failure) {
        // Only the first sentence of each message: four paragraphs of identical
        // advice is a wall, and the summary underneath says it once. Split on a
        // period followed by a space — the naive split cut "127.0.0.1" down to
        // "127." and reported a truncated address as the thing that failed.
        const text = failure instanceof Error ? failure.message : String(failure)
        const first = text.split(/\.\s/)[0]
        lines.push(`${candidate} → ${first}${first.endsWith('.') ? '' : '.'}`)
      }
    }

    if (hosted) {
      lines.push('')
      // Leading with the permission was right until it kept not working.
      // Chrome reports it as available and never asks — measured on the real
      // site, not guessed — so pointing at it a fourth time would be advice
      // this app has no evidence for. The mirror depends on no browser
      // feature at all, so it goes first and the permission is the footnote.
      lines.push(
        permission === 'granted'
          ? 'Der Zugriff ist erlaubt, aber unter keiner Adresse antwortet ein Dienst. Läuft er, ' +
            'und steht in seinem Fenster port: 9000?'
          : 'Läuft der Dienst, dann hält ihn der Browser zurück, nicht Ihr Rechner. Der Spiegel ' +
            'unten löst das ohne Erlaubnis und ohne Nachfrage: er liefert Sondra von Ihrem ' +
            'Rechner aus, und zwischen zwei Dingen auf derselben Maschine gibt es keine Grenze, ' +
            'die jemand erlauben müsste.' +
            (permission === 'denied'
              ? ' Die Erlaubnis ist hier zusätzlich verweigert — im Schloss links in der ' +
                'Adresszeile wieder zu erlauben.'
              : ''),
      )
    } else {
      lines.push('')
      lines.push('Läuft der Dienst, und steht in seinem Fenster port: 9000?')
    }
    setProbe(lines.join('\n'))
  }

  /**
   * Stops using the service entirely.
   *
   * It has to switch the feature off too, not just drop the connection: the
   * watcher would otherwise find the very same instance again four seconds
   * later, which is not what anyone means by "disconnect".
   */
  const disconnect = () => {
    stopWaiting()
    setServiceEnabled(false)
    setServiceInfo(null)
    setError(null)
    setModeOverride(null)
    setServiceConnection({ endpoint: null, info: null, searching: false, enabled: false })
    log('dienst', 'Verbindung zum Dienst getrennt')
  }

  /** Checks the endpoint and says precisely what is wrong with it. */
  const checkService = async () => {
    if (!service.endpoint.trim()) return
    const controller = new AbortController()
    abortRef.current = controller
    setChecking(true)
    setServiceInfo(null)
    setError(null)
    try {
      const info = await probeService(service.endpoint, apiKey || null, controller.signal)
      adopt(service.endpoint.trim(), info)
      log('dienst', `Instanz erreichbar: ${info.version}, ${info.services.length} Dienste`)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      setError(message)
      log('dienst', message, 'error')
    } finally {
      setChecking(false)
      abortRef.current = null
    }
  }

  // Named after what the address is, not after the protocol behind it. The
  // right one is picked automatically from the link; this row exists to show
  // what was picked and to override it.
  const PATHS: { id: Mode; label: string; hint: string; disabled: boolean }[] = [
    {
      id: 'direct',
      label: 'Direkte Datei',
      hint: 'Die Adresse zeigt auf die Datei selbst. Der Browser holt sie.',
      disabled: false,
    },
    {
      id: 'hls',
      label: 'Stream',
      hint: 'Ein Stream in vielen kleinen Teilen. Wird hier zu einer MP4 zusammengesetzt.',
      disabled: false,
    },
  ]

  // A portal address has one way in, and it is the field at the top: it asks
  // the connected service first and finishes whatever that service hands back.
  // The button that used to sit here did the same with fewer fallbacks.
  const portalOnly = detectedPortal && effectiveMode === 'direct'
  const canStart = Boolean(url.trim()) && !portalOnly

  const pathNote = portalOnly
    ? connected
      ? 'YouTube und ähnliche Seiten lädt das Feld oben — „Nachsehen“ fragt den verbundenen Dienst.'
      : serviceEnabled
        ? 'YouTube und ähnliche Seiten lädt das Feld oben. Mit einem verbundenen Dienst in voller Auflösung.'
        : 'YouTube und ähnliche Seiten lädt das Feld oben. Für volle Auflösung unten einschalten.'
    : PATHS.find((path) => path.id === effectiveMode)?.hint

  return (
    <div className="grid grid-cols-[minmax(0,1fr)] gap-[16px]">
      <Card tone="keylime" size="compact">
        <div className="flex flex-wrap items-baseline justify-between gap-x-[16px] gap-y-[4px]">
          <span className="text-small text-muted">
            Gilt für die Adresse im Feld oben.
          </span>
        </div>

        <div className="mt-[16px] flex flex-col gap-[16px]">
          {/* ---- the chosen path and the action share one row --------------- */}
          <div className="flex flex-wrap items-center gap-[8px]">
            {/* The line above this card says the path is chosen automatically,
                and then three buttons stood here inviting a choice — the panel
                contradicted itself, and the first thing anyone did was wonder
                which one they were supposed to press. So the choice is stated,
                not asked: the picked path is named, and the override is one
                click away for the case the guess is wrong. Nothing is gone. */}
            {showPaths ? (
              <div role="radiogroup" aria-label="Weg" className="flex gap-[4px] rounded-nav bg-panel-soft p-[4px]">
                {PATHS.map((path) => {
                  const active = path.id === effectiveMode
                  return (
                    <button
                      key={path.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      disabled={path.disabled}
                      title={path.hint}
                      onClick={() => {
                        setModeOverride(path.id)
                        reset()
                      }}
                      className={`px-[16px] py-[8px] text-small transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        active ? 'bg-ink text-on-ink' : 'text-ink hover:bg-panel-mid'
                      }`}
                    >
                      {path.label}
                    </button>
                  )
                })}
              </div>
            ) : (
              <p className="text-small text-muted">
                Weg:{' '}
                <span className="text-ink">
                  {PATHS.find((path) => path.id === effectiveMode)?.label ?? '—'}
                </span>{' '}
                <button
                  type="button"
                  onClick={() => setShowPaths(true)}
                  className="press text-ink underline underline-offset-[3px] hover:no-underline"
                >
                  ändern
                </button>
              </p>
            )}

            <div className="flex flex-wrap items-center gap-[8px] sm:ml-auto">
              {portalOnly ? null : effectiveMode === 'hls' ? (
                <Button size="sm" onClick={playlist ? downloadHls : inspectPlaylist} disabled={busy || !canStart}>
                  {busy ? 'Lädt…' : playlist ? 'Stream laden' : 'Playlist lesen'}
                  {!busy ? <ArrowRight /> : null}
                </Button>
              ) : (
                <Button size="sm" onClick={downloadDirect} disabled={busy || !canStart}>
                  {busy ? 'Lädt…' : 'Laden'}
                  {!busy ? <ArrowRight /> : null}
                </Button>
              )}

              {busy ? (
                <Button size="sm" variant="ghost" onClick={() => abortRef.current?.abort()}>
                  Abbrechen
                </Button>
              ) : null}
            </div>
          </div>

          <p className="-mt-[8px] text-small leading-[1.45] text-muted">
            {pathNote}
          </p>

          {/* ---- path-specific extras, only when they apply ----------------- */}
          {effectiveMode === 'direct' && caps.fileSystemAccess ? (
            <Toggle
              label="Direkt auf die Festplatte schreiben"
              hint="Für sehr große Dateien. Landet dann nicht in der Sitzung."
              checked={streamToDiskEnabled}
              onChange={setStreamToDiskEnabled}
            />
          ) : null}

          {playlist && playlist.kind === 'master' ? (
            <Field label="Qualitätsstufe">
              <Select value={variantUrl} onChange={(event) => setVariantUrl(event.target.value)}>
                {playlist.variants.map((variant) => (
                  <option key={variant.url} value={variant.url}>
                    {variant.resolution ?? 'unbekannt'} · {Math.round(variant.bandwidth / 1000)} kbit/s
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}

          {playlist && playlist.kind === 'media' ? (
            <div className="flex flex-wrap gap-[8px]">
              <Badge tone="forest">{playlist.segments.length} Segmente</Badge>
              {playlist.encrypted ? <Badge>verschlüsselt</Badge> : null}
            </div>
          ) : null}

          {busy || progress ? (
            <Progress
              value={progress?.fraction ?? null}
              label={
                note ??
                (progress
                  ? `${formatBytes(progress.receivedBytes)}${
                      progress.totalBytes ? ` von ${formatBytes(progress.totalBytes)}` : ''
                    }${progress.bytesPerSecond ? ` · ${formatBytes(progress.bytesPerSecond)}/s` : ''}`
                  : 'Verbindung wird aufgebaut')
              }
            />
          ) : null}

          {fetched ? (
            <div className="flex flex-wrap items-center gap-[12px] rounded-card bg-panel-soft px-[16px] py-[16px]">
              <div className="min-w-0 flex-1">
                <p className="truncate text-body text-ink">{fetched.name}</p>
                <p className="value text-small text-muted">{formatBytes(fetched.bytes.byteLength)} · in der Sitzung</p>
              </div>
              <Button size="sm" onClick={() => saveBytes(fetched.bytes, fetched.name, fetched.mime)}>
                Speichern
                <ArrowRight />
              </Button>
            </div>
          ) : null}

          {error ? (
            <Notice tone="error" title="Nicht abrufbar">
              {error}
            </Notice>
          ) : null}
        </div>

        {/* ---- external downloaders: switch, options, then the terms ------- */}
        <div className="mt-[16px] border-t border-line pt-[16px]">
          <Toggle
            label="YouTube und externe Downloader"
            hint={
              serviceEnabled
                ? 'Aktiviert. Verbindet sich mit der Desktop-App oder der lokalen Brücke.'
                : 'Aus. Direkte Mediendateien funktionieren ohne Dienst. YouTube erfordert die Desktop-App oder eine lokale Brücke.'
            }
            
            checked={serviceEnabled}
            onChange={(value) => {
              setServiceEnabled(value)
              setModeOverride(null)
              reset()
              log(
                'dienst',
                value
                  ? 'Externe Downloader eingeschaltet — Adressen verlassen ab jetzt den Rechner'
                  : 'Externe Downloader ausgeschaltet',
                value ? 'warn' : 'info',
              )
              setServiceConnection({ enabled: value })
              if (value) {
                void autoConnect()
              } else {
                stopWaiting()
                setServiceInfo(null)
                setServiceConnection({ endpoint: null, info: null, searching: false })
              }
            }}
          />

          {serviceEnabled ? (
            /* Two things stay on the page: what is true right now, and a
               way in. The rest is read once and then never again, so it
               lives behind a door instead of pushing the address field —
               the part used every single time — below the fold. */
            <div className="mt-[16px] flex flex-col gap-[12px]">
              {/* What is true right now, stated before anything else. Someone
                  who just switched this on wants one answer — does YouTube work
                  yet — and that is a sentence, not a form. */}
              <div className="flex flex-wrap items-center gap-[8px] rounded-card bg-panel-soft px-[16px] py-[12px]">
                <span
                  aria-hidden
                  className={`size-[9px] shrink-0 rounded-full ${connected ? 'bg-ink' : 'bg-ink/25'}`}
                />
                <p className="min-w-0 flex-1 text-small text-ink">
                  {connected ? (
                    <>
                      Verbunden mit <span className="font-mono text-small">{endpointLabel}</span>
                    </>
                  ) : waiting ? (
                    'Wartet auf den Dienst — läuft er, verbindet sich Sondra automatisch.'
                  ) : (
                    <>
                      Kein lokaler Dienst aktiv. Starten Sie die Sondra Desktop-App oder die lokale Brücke.
                    </>
                  )}
                </p>
                {connected ? (
                  <Button size="sm" variant="quiet" onClick={disconnect}>
                    Trennen
                  </Button>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center gap-[8px]">
                <Button size="sm" onClick={() => setSetupDialog(true)}>
                  {connected ? 'Einstellungen' : 'Dienst einrichten (Anleitung)'}
                </Button>
                {!connected ? (
                  <Button size="sm" variant="quiet" onClick={runProbe}>
                    {pageIsLocal() ? 'Verbindung prüfen' : 'Verbinden und Zugriff erlauben'}
                  </Button>
                ) : null}
                {connected ? (
                  <span className="text-small text-muted">
                    Portal-Links im Feld oben gehen jetzt.
                  </span>
                ) : null}
              </div>

              {probe ? (
                <div className="rounded-card bg-panel-soft p-[20px]">
                  <div className="flex items-baseline justify-between gap-[12px]">
                    <p className="text-small font-semibold text-ink">Ergebnis der Prüfung</p>
                    <button
                      type="button"
                      onClick={() => setProbe(null)}
                      className="rounded-nav text-small text-muted hover:text-ink"
                    >
                      Ausblenden
                    </button>
                  </div>
                  <pre className="mt-[8px] whitespace-pre-wrap break-all font-mono text-micro leading-[1.6] text-prose">
                    {probe}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}

          <Dialog open={setupDialog} onClose={() => setSetupDialog(false)} title="Dienst einrichten" size="lg">
            <div className="flex flex-col gap-[20px]">
                {connected ? (
                  <>
                    <div className="flex flex-wrap items-center gap-[8px]">
                      <Badge tone="forest">{serviceInfo.version}</Badge>
                      {/* Whether the instance actually offers YouTube is the thing
                          people get wrong, so it is stated rather than implied. */}
                      <Badge>
                        {serviceInfo.services.includes('youtube')
                          ? 'YouTube unterstützt'
                          : 'YouTube nicht aktiviert'}
                      </Badge>
                      <Badge>
                        {serviceInfo.services.length} {serviceInfo.services.length === 1 ? 'Dienst' : 'Dienste'}
                      </Badge>
                      {serviceInfo.needsTurnstile ? <Badge>verlangt Bot-Prüfung</Badge> : null}
                    </div>

                    <div className="grid gap-[16px] sm:grid-cols-2">
                      <Field label="Was holen">
                        <Select
                          value={service.downloadMode}
                          onChange={(event) => updateService({ downloadMode: event.target.value as DownloadMode })}
                        >
                          <option value="auto">Video mit Ton</option>
                          <option value="audio">Nur Ton</option>
                          <option value="mute">Video ohne Ton</option>
                        </Select>
                      </Field>

                      {service.downloadMode === 'audio' ? (
                        <Field label="Tonformat">
                          <Select
                            value={service.audioFormat}
                            onChange={(event) => updateService({ audioFormat: event.target.value as AudioFormat })}
                          >
                            <option value="best">Bestes verfügbares</option>
                            <option value="opus">Opus</option>
                            <option value="mp3">MP3</option>
                            <option value="wav">WAV</option>
                          </Select>
                        </Field>
                      ) : (
                        <Field label="Auflösung">
                          <Select
                            value={service.videoQuality}
                            onChange={(event) => updateService({ videoQuality: event.target.value as VideoQuality })}
                          >
                            <option value="max">Höchste</option>
                            <option value="2160">2160p</option>
                            <option value="1440">1440p</option>
                            <option value="1080">1080p</option>
                            <option value="720">720p</option>
                            <option value="480">480p</option>
                            <option value="360">360p</option>
                          </Select>
                        </Field>
                      )}

                      {/* Only asked for once something is connected, because an
                          empty key field on a screen with no service is just
                          another thing to worry about. */}
                      <Field label="Zugangsschlüssel" className="sm:col-span-2">
                        <TextInput
                          type="password"
                          autoComplete="off"
                          placeholder="optional, wird nicht gespeichert"
                          value={apiKey}
                          onChange={(event) => setApiKey(event.target.value)}
                        />
                      </Field>
                    </div>
                  </>
                ) : (
                  <div className="flex flex-col gap-[16px]">
                    <div className="rounded-card bg-panel-soft p-[14px]">
                      <p className="text-small font-semibold text-ink">
                        YouTube im Browser freischalten
                      </p>
                      <p className="mt-[4px] text-small leading-[1.5] text-muted">
                        YouTube blockiert direkte Downloads über Webseiten. Einer dieser drei Wege führt hin:
                      </p>
                    </div>

                    {/* Weg 1: Desktop App */}
                    <div className="rounded-card bg-raised p-[16px] ring-1 ring-inset ring-rule">
                      <p className="text-small font-semibold text-ink">Weg 1: Sondra Windows-App (Empfohlen)</p>
                      <p className="mt-[4px] text-small leading-[1.5] text-muted">
                        Beste und einfachste Lösung: Die Desktop-App bringt yt-dlp bereits mit, benötigt kein Terminal
                        und lädt Videos sofort in voller Auflösung herunter.
                      </p>
                      <div className="mt-[12px]">
                        <button
                          type="button"
                          onClick={() => {
                            setSetupDialog(false)
                            openGetAppDialog()
                          }}
                          className="press inline-flex items-center gap-[6px] rounded-nav bg-ink px-[14px] py-[8px] text-small font-medium text-on-ink hover:opacity-90"
                        >
                          Sondra für Windows herunterladen
                          <ArrowRight />
                        </button>
                      </div>
                    </div>

                    {/* Weg 2: a bridge on this machine. What it runs and what
                        is already installed are asked, not assumed, so the
                        commands below are the ones for this machine and can be
                        pasted start to finish. */}
                    <div className="rounded-card bg-panel-soft p-[16px]">
                      <p className="text-small font-semibold text-ink">Weg 2: Lokale Brücke im Terminal</p>
                      <p className="mt-[4px] max-w-[34em] text-small leading-[1.5] text-prose">
                        Ein kleiner Dienst auf diesem Rechner holt die Videos, diese Seite setzt sie zusammen.
                      </p>

                      <div className="mt-[14px] grid gap-[12px] sm:grid-cols-[9em_minmax(0,1fr)] sm:items-center">
                        <span className="text-small text-prose">Womit</span>
                        <ChoiceRow
                          value={localWay}
                          onChange={setLocalWay}
                          options={[
                            { value: 'ytdlp', label: 'yt-dlp — empfohlen', title: 'Eine Programmdatei, kein Quelltext' },
                            { value: 'node', label: 'cobalt mit Node.js', title: 'Quelltext von cobalt, mit Node.js gestartet' },
                            { value: 'docker', label: 'cobalt mit Docker', title: 'Ein Befehl, braucht Docker' },
                          ]}
                        />
                        {localWay !== 'docker' ? (
                          <>
                            <span className="text-small text-prose">Node.js</span>
                            <ChoiceRow
                              value={hasNode ? 'ja' : 'nein'}
                              onChange={(value) => setHasNode(value === 'ja')}
                              options={[
                                { value: 'nein', label: 'Noch nicht installiert' },
                                { value: 'ja', label: 'Schon installiert' },
                              ]}
                            />
                          </>
                        ) : null}
                        {localWay === 'node' ? (
                          <>
                            <span className="text-small text-prose">Git</span>
                            <ChoiceRow
                              value={hasGit ? 'ja' : 'nein'}
                              onChange={(value) => setHasGit(value === 'ja')}
                              options={[
                                { value: 'nein', label: 'Nicht installiert' },
                                { value: 'ja', label: 'Schon installiert' },
                              ]}
                            />
                          </>
                        ) : null}
                      </div>
                      <p className="mt-[8px] max-w-[34em] text-small leading-[1.5] text-prose">
                        {localWay === 'docker'
                          ? 'Braucht Docker — unter Windows also auch WSL2. Läuft danach dauerhaft mit.'
                          : hasNode
                            ? 'Die Anleitung lässt das Installieren von Node.js weg.'
                            : needsNodeByHand
                              ? 'Node.js kommt auf diesem System von Hand: einmal von nodejs.org installieren, dann die Zeilen unten.'
                              : 'Die erste Zeile installiert Node.js. Nicht sicher? So lassen — ein erledigter Schritt schadet nicht.'}
                      </p>

                      <div className="mt-[12px] rounded-nav bg-raised p-[12px] ring-1 ring-inset ring-line">
                        <span className="mb-[6px] block text-micro text-muted">
                          {platform === 'windows' ? 'PowerShell' : 'Terminal'}
                        </span>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-all font-mono text-small leading-[1.6] text-ink select-all">
                          {localCommand}
                        </pre>
                      </div>

                      <div className="mt-[12px] flex flex-wrap items-center gap-[10px]">
                        <Button size="sm" onClick={startAndWait}>
                          {copied ? 'Kopiert — Sondra wartet auf den Dienst' : localWay === 'docker' ? 'Befehl kopieren' : 'Befehle kopieren'}
                          {!copied ? <ArrowRight /> : null}
                        </Button>

                        {localWay === 'ytdlp' ? (
                          <button
                            type="button"
                            onClick={() =>
                              saveBytes(
                                new TextEncoder().encode(
                                  platform === 'windows'
                                    ? ytdlpWindowsLauncher(window.location.origin)
                                    : ytdlpUnixLauncher(window.location.origin, platform),
                                ),
                                launcherFilename(platform),
                                'text/plain',
                              )
                            }
                            className="press cursor-pointer rounded-nav text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                          >
                            Oder als Starterdatei ({launcherFilename(platform)}) — Doppelklick genügt
                          </button>
                        ) : (
                          /* cobalt's lines are shell lines; PowerShell runs
                             them badly. A finished script is the honest way
                             on Windows, and a choice everywhere else. */
                          <span className="flex flex-wrap items-center gap-x-[12px] gap-y-[4px] text-small text-prose">
                            Als fertige Datei:
                            {(localWay === 'node'
                              ? [
                                  {
                                    name: hasGit ? 'cobalt-ohne-docker.ps1' : 'cobalt-nur-node.ps1',
                                    text: () =>
                                      hasGit ? nodeWindowsScript(DEFAULT_PORT, hostedOrigin) : nodeOnlyWindowsScript(DEFAULT_PORT, hostedOrigin),
                                  },
                                  {
                                    name: hasGit ? 'cobalt-ohne-docker.sh' : 'cobalt-nur-node.sh',
                                    text: () =>
                                      hasGit ? nodeUnixScript(DEFAULT_PORT, hostedOrigin) : nodeOnlyUnixScript(DEFAULT_PORT, hostedOrigin),
                                  },
                                ]
                              : [
                                  { name: 'docker-compose.yml', text: () => composeFile() },
                                  { name: 'cobalt-starten.ps1', text: () => windowsScript() },
                                  { name: 'cobalt-starten.sh', text: () => unixScript() },
                                ]
                            ).map((file) => (
                              <button
                                key={file.name}
                                type="button"
                                onClick={() => saveBytes(new TextEncoder().encode(file.text()), file.name, 'text/plain')}
                                className="press cursor-pointer rounded-nav font-mono text-small text-ink underline decoration-rule underline-offset-[3px] hover:decoration-ink"
                              >
                                {file.name}
                              </button>
                            ))}
                          </span>
                        )}
                      </div>

                      {waiting ? (
                        <div className="mt-[10px] flex items-center gap-[8px] rounded-nav bg-panel-mid px-[12px] py-[8px] text-small text-ink">
                          <span className="pulse-dot inline-block size-[8px] shrink-0 rounded-pill bg-ink" />
                          <span className="flex-1">
                            Im Terminal ausführen. Sondra verbindet sich von selbst, sobald der Dienst antwortet.
                          </span>
                          <Button size="sm" variant="quiet" onClick={stopWaiting}>
                            Abbrechen
                          </Button>
                        </div>
                      ) : (
                        <p className="mt-[8px] text-small text-prose">
                          Kopieren, in {platform === 'windows' ? 'PowerShell' : 'ein Terminal'} einfügen, Enter. Sondra verbindet sich von selbst.
                        </p>
                      )}
                    </div>

                    {/* Weg 3: somebody already runs one — a server, a Docker
                        container, a friend's instance. Visible, not folded:
                        the people who have one are the people looking for it. */}
                    <div className="rounded-card bg-panel-soft p-[16px]">
                      <p className="text-small font-semibold text-ink">Weg 3: Vorhandenen Dienst verbinden</p>
                      <p className="mt-[4px] max-w-[34em] text-small leading-[1.5] text-prose">
                        Ein eigener Server, ein Docker-Container oder eine Instanz, deren Adresse Sie bekommen haben.
                      </p>
                      <div className="mt-[12px] flex flex-wrap items-center gap-[8px]">
                        <TextInput
                          type="url"
                          inputMode="url"
                          className="min-w-[200px] flex-1"
                          placeholder={`http://localhost:${DEFAULT_PORT} oder https://instanz.example/`}
                          value={service.endpoint}
                          onChange={(event) => {
                            updateService({ endpoint: event.target.value })
                            setServiceInfo(null)
                          }}
                          onKeyDown={(event) => {
                            if (event.key === 'Enter') void checkService()
                          }}
                        />
                        <Button size="sm" onClick={checkService} disabled={checking || waiting || !service.endpoint.trim()}>
                          {checking ? 'Prüft…' : 'Verbinden'}
                        </Button>
                        <Button size="sm" variant="quiet" onClick={searchLocal} disabled={searching}>
                          {searching ? 'Sucht…' : 'Auf diesem Rechner suchen'}
                        </Button>
                      </div>

                      {known.length > 0 ? (
                        <div className="mt-[10px] flex flex-wrap items-center gap-[8px]">
                          <span className="text-small text-prose">Zuletzt</span>
                          {known.map((entry) => (
                            <button
                              key={entry}
                              type="button"
                              onClick={() => {
                                updateService({ endpoint: entry })
                                setServiceInfo(null)
                              }}
                              title={entry}
                              className="press max-w-[220px] truncate rounded-nav bg-panel-mid px-[10px] py-[4px] font-mono text-small text-ink hover:bg-panel-strong"
                            >
                              {entry.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  </div>
                )}

                {/* Terms last, under the controls they apply to — and the
                    right ones: a service on this machine has no operator to
                    warn about, and saying otherwise would train people to
                    ignore the notice that does matter. */}
                {(() => {
                  const terms =
                    service.endpoint && isLoopback(service.endpoint)
                      ? LOCAL_SERVICE_DISCLAIMER
                      : SERVICE_DISCLAIMER
                  return (
                    <div className="rounded-card bg-raised p-[20px] text-small leading-[1.5] ring-1 ring-inset ring-rule">
                      <p className="mb-[8px] font-semibold text-ink">{terms.title}</p>
                      {terms.paragraphs.map((paragraph) => (
                        <p key={paragraph.slice(0, 24)} className="mb-[8px] text-prose/85">
                          {paragraph}
                        </p>
                      ))}
                      <p className="mt-[8px] border-t border-line pt-[8px] text-muted">
                        {terms.liability}
                      </p>
                    </div>
                  )
                })()}
            </div>
          </Dialog>
        </div>
      </Card>

    </div>
  )
}
