/**
 * Voice and music in one file, with the music stepping back while someone
 * speaks.
 *
 * Every slider is heard: the mix is recomputed a moment after a change and
 * the player has it, with the same mix without ducking beside it to switch
 * to. The picture shows why — the voice as bars, the music's level as a line
 * over it — and the report says in numbers what was done. A video as the
 * voice gets the mix laid back under its picture.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { saveBytes } from '../../lib/download'
import { DEFAULT_DUCK, mixWithDucking, type DuckResult, type DuckSettings } from '../../lib/duck'
import { loadFfmpeg, runFfmpeg } from '../../lib/ffmpegClient'
import { formatBytes, formatTimecode } from '../../lib/format'
import { encodeWav, type AudioData } from '../../lib/wav'
import { createZip } from '../../lib/zip'
import { decodeAssetAudio } from '../../hooks/useDecodedAudio'
import { useFilePicker } from '../../hooks/useIngest'
import { UndoRedoBar, useUndoHistory } from '../../hooks/useUndoHistory'
import { useSession, type Asset } from '../../state/store'
import { AudioPreview } from '../AudioPreview'
import { ArrowRight, Button, Card, Field, Notice, Progress, Select, Slider, Toggle } from '../ui/primitives'
import { ZipSave } from '../ZipSave'
import { DriveSaveButton } from '../GoogleDrive'

const SETTINGS_KEY = 'sondra:mischen'

function rememberedSettings(): DuckSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? 'null')
    if (saved && typeof saved === 'object') return { ...DEFAULT_DUCK, ...saved }
  } catch {
    /* only a preference */
  }
  return DEFAULT_DUCK
}

const withSound = (asset: Asset) => asset.kind === 'audio' || asset.kind === 'video'
const decibels = (value: number) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${Math.abs(value).toFixed(1).replace('.', ',')} dB`
const seconds = (value: number) => `${value.toFixed(1).replace('.', ',')} s`

/** Voice level as bars, the music's gain as a line: where it ducks and how far. */
function DuckGraph({ result }: { result: DuckResult }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    const scale = window.devicePixelRatio || 1
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    const context = canvas.getContext('2d')
    if (!context) return
    context.scale(scale, scale)
    const css = getComputedStyle(canvas)
    const ink = css.getPropertyValue('--color-ink').trim() || '#0f3e1c'
    const rule = css.getPropertyValue('--color-rule').trim() || '#bcc4b6'
    context.clearRect(0, 0, width, height)

    const { voiceDb, musicGainDb } = result
    const columns = Math.max(1, Math.floor(width / 3))
    const per = voiceDb.length / columns
    context.fillStyle = rule
    for (let x = 0; x < columns; x += 1) {
      let level = -100
      for (let i = Math.floor(x * per); i < Math.floor((x + 1) * per); i += 1) level = Math.max(level, voiceDb[i])
      const h = Math.max(0, ((level + 60) / 60) * height * 0.9)
      if (h > 0) context.fillRect(x * 3, (height - h) / 2, 2, h)
    }

    // Music: 0 dB at the top, -40 dB at the bottom.
    context.strokeStyle = ink
    context.lineWidth = 2
    context.beginPath()
    for (let x = 0; x <= width; x += 1) {
      const db = musicGainDb[Math.min(musicGainDb.length - 1, Math.floor((x / width) * musicGainDb.length))]
      const y = Math.min(height - 1, Math.max(1, (-db / 40) * height))
      if (x === 0) context.moveTo(x, y)
      else context.lineTo(x, y)
    }
    context.stroke()
  }, [result])
  return <canvas ref={ref} className="h-[120px] w-full bg-panel-soft" aria-label="Pegel der Stimme und der Musik über die Zeit" />
}

export function MixPanel() {
  const assets = useSession((state) => state.assets)
  const activeAssetId = useSession((state) => state.activeAssetId)
  const addAsset = useSession((state) => state.addAsset)
  const log = useSession((state) => state.log)
  const picker = useFilePicker('zum Mischen geöffnet')

  const candidates = useMemo(() => assets.filter(withSound), [assets])
  const [voiceId, setVoiceId] = useState<string | null>(null)
  const [musicId, setMusicId] = useState<string | null>(null)
  const [settings, setSettings] = useState<DuckSettings>(rememberedSettings)
  const history = useUndoHistory(settings, setSettings, { enabled: candidates.length >= 2 })
  const [decoded, setDecoded] = useState<{ voice: AudioData; music: AudioData; key: string } | null>(null)
  const [decoding, setDecoding] = useState(false)
  const [result, setResult] = useState<{ mix: DuckResult; flat: AudioData } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [writing, setWriting] = useState<string | null>(null)

  // Sensible first picks: the active file as the voice, another as the music.
  useEffect(() => {
    const ids = candidates.map((asset) => asset.id)
    setVoiceId((current) => (current && ids.includes(current) ? current : ids.includes(activeAssetId ?? '') ? activeAssetId : (ids[0] ?? null)))
  }, [candidates, activeAssetId])
  useEffect(() => {
    const ids = candidates.map((asset) => asset.id)
    setMusicId((current) => (current && ids.includes(current) && current !== voiceId ? current : (ids.find((id) => id !== voiceId) ?? null)))
  }, [candidates, voiceId])

  const voice = candidates.find((asset) => asset.id === voiceId) ?? null
  const music = candidates.find((asset) => asset.id === musicId) ?? null
  const key = voice && music ? `${voice.id}|${music.id}` : ''

  useEffect(() => {
    // With one file the first picks are briefly the same file twice, and the
    // read that starts then is cancelled a render later. A cancelled read
    // must take its „Ton wird gelesen" with it, or the bar stays for good.
    if (!voice || !music || voice.id === music.id) {
      setDecoding(false)
      return
    }
    if (decoded?.key === key) return
    let cancelled = false
    setDecoding(true)
    setError(null)
    setResult(null)
    Promise.all([decodeAssetAudio(voice), decodeAssetAudio(music)])
      .then(([v, m]) => !cancelled && setDecoded({ voice: v, music: m, key }))
      .catch((failure) => !cancelled && setError(`Lesen nicht möglich: ${failure instanceof Error ? failure.message : String(failure)}`))
      .finally(() => !cancelled && setDecoding(false))
    return () => {
      cancelled = true
      setDecoding(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  // Mixed again a moment after the last change, so dragging stays smooth.
  useEffect(() => {
    if (!decoded || decoded.key !== key) return
    const timer = window.setTimeout(() => {
      try {
        const mix = mixWithDucking(decoded.voice, decoded.music, settings)
        const flat = mixWithDucking(decoded.voice, decoded.music, { ...settings, duckDb: 0 }).audio
        setResult({ mix, flat })
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure))
      }
    }, 250)
    return () => window.clearTimeout(timer)
  }, [decoded, key, settings])

  const update = (patch: Partial<DuckSettings>) =>
    setSettings((current) => {
      history.record(current)
      const next = { ...current, ...patch }
      try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(next))
      } catch {
        /* only a preference */
      }
      return next
    })

  const stem = voice ? voice.name.replace(/\.[^.]+$/, '') : 'mischung'
  const previewSources = useMemo(
    () => (result ? [{ id: 'mix', label: 'Gemischt', audio: result.mix.audio }, { id: 'flat', label: 'Ohne Absenken', audio: result.flat }] : []),
    [result],
  )

  const intoSession = () => {
    if (!result) return
    const bytes = encodeWav(result.mix.audio, 24)
    const name = `${stem} (gemischt).wav`
    addAsset({ name, bytes, mime: 'audio/wav', sizeBytes: bytes.byteLength, kind: 'audio', audio: result.mix.audio, durationSeconds: result.mix.report.totalSeconds, origin: 'derived' })
    log('mischen', `${name} in der Sitzung (${formatBytes(bytes.byteLength)})`)
  }

  /** The mix under the voice's own picture: no lead-in or tail, so they stay together. */
  const intoVideo = async () => {
    if (!voice || voice.kind !== 'video' || !decoded) return
    setError(null)
    setWriting('Ton wird unter das Bild gelegt')
    try {
      const fitted = mixWithDucking(decoded.voice, decoded.music, { ...settings, leadIn: 0, tail: 0 })
      await loadFfmpeg()
      const extension = (voice.name.split('.').pop() ?? 'mp4').toLowerCase()
      const input = `in.${extension}`
      const { files } = await runFfmpeg({
        input: { [input]: voice.bytes, 'mix.wav': encodeWav(fitted.audio, 16) },
        output: ['out.mp4'],
        args: ['-i', input, '-i', 'mix.wav', '-map', '0:v:0', '-map', '1:a:0', '-c:v', ...(['mp4', 'm4v', 'mov'].includes(extension) ? ['copy'] : ['libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p']), '-c:a', 'aac', '-b:a', '192k', '-shortest', 'out.mp4'],
      })
      const bytes = files['out.mp4']
      if (!bytes || bytes.byteLength < 1024) throw new Error('FFmpeg hat kein Video geschrieben.')
      const name = `${stem} (gemischt).mp4`
      addAsset({ name, bytes, mime: 'video/mp4', sizeBytes: bytes.byteLength, kind: 'video', audio: null, durationSeconds: voice.durationSeconds, origin: 'derived' })
      log('mischen', `${name} in der Sitzung (${formatBytes(bytes.byteLength)})`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message.split('\n')[0] : String(failure))
    } finally {
      setWriting(null)
    }
  }

  const report = result?.mix.report

  return (
    <div className="flex flex-col gap-[16px]">
      {picker.input}
      <Card tone="cream">
        <div className="flex flex-col gap-[20px]">
          <div className="flex flex-wrap items-center justify-between gap-[12px] border-b border-line/50 pb-[14px]">
            <div>
              <h2 className="display-md">Stimme und Musik mischen</h2>
              <p className="mt-[2px] text-small text-muted">
                Die Musik läuft unter der Stimme und duckt sich automatisch, sobald gesprochen wird — wie im Rundfunk.
              </p>
            </div>
          </div>

          {candidates.length < 2 ? (
            <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-[20px] items-start">
              <div className="flex flex-col gap-[14px] rounded-card bg-panel-soft/60 p-[24px] ring-1 ring-line/60">
                <div className="grid size-[44px] place-items-center rounded-pill bg-raised ring-1 ring-line text-ink">
                  <svg viewBox="0 0 20 20" className="size-[20px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M4 3h12v14H4zM2 8h16M2 12h16" />
                  </svg>
                </div>
                <div>
                  <h4 className="text-body font-semibold text-ink">
                    {candidates.length === 0
                      ? 'Zwei Tonspuren benötigt'
                      : `Noch eine Musikspur hinzufügen (Stimme: ${candidates[0].name})`}
                  </h4>
                  <p className="mt-[4px] text-small text-muted leading-relaxed">
                    Wählen Sie eine Aufnahme mit Stimme (Podcast, Kommentar) und eine zweite mit Musik oder Atmosphäre.
                  </p>
                </div>
                <div>
                  <Button onClick={picker.open} disabled={picker.busy}>
                    {picker.busy ? 'Wird gelesen …' : 'Dateien öffnen'}
                    {!picker.busy ? <ArrowRight /> : null}
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 gap-[10px]">
                <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                  <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                    <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M4 14l4-8 4 8 4-4" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-small font-semibold text-ink">Automatisches Ducking</h4>
                    <p className="text-micro text-muted leading-relaxed">Musikpegel sinkt sanft um z.B. 12 dB ab, sobald Pegel auf der Stimmspur anliegt.</p>
                  </div>
                </div>

                <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                  <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                    <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 10h14M3 6h10M3 14h6" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-small font-semibold text-ink">Weiche Blenden</h4>
                    <p className="text-micro text-muted leading-relaxed">Regulierbare Einschwing- und Rückkehrzeiten verhindern abruptes Pumpen.</p>
                  </div>
                </div>

                <div className="flex items-start gap-[12px] rounded-card bg-panel-soft/60 p-[12px] ring-1 ring-inset ring-line/50">
                  <div className="grid size-[32px] shrink-0 place-items-center rounded-nav bg-raised ring-1 ring-line/70 text-ink">
                    <svg viewBox="0 0 20 20" className="size-[16px]" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M12 4v10a3 3 0 11-3-3h3V4zM12 7l5-2v8" />
                    </svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <h4 className="text-small font-semibold text-ink">Export als Sendemischung</h4>
                    <p className="text-micro text-muted leading-relaxed">Verlustfreie WAV- oder MP3-Ausgabe direkt bereit zur Veröffentlichung.</p>
                  </div>
                </div>
              </div>
            </div>
          ) : (
          <>
            <div className="mt-[16px] grid max-w-[720px] gap-[16px] sm:grid-cols-2">
              <Field label="Stimme">
                <Select value={voiceId ?? ''} onChange={(event) => setVoiceId(event.target.value)}>
                  {candidates.map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Musik">
                <Select value={musicId ?? ''} onChange={(event) => setMusicId(event.target.value)}>
                  {candidates.filter((asset) => asset.id !== voiceId).map((asset) => (
                    <option key={asset.id} value={asset.id}>
                      {asset.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div className="mt-[8px]">
              <Button variant="ghost" size="sm" onClick={picker.open} disabled={picker.busy}>
                {picker.busy ? 'Wird gelesen …' : 'Weitere Datei öffnen'}
              </Button>
            </div>

            {/* Schnell-Presets */}
            <div className="mt-[20px] flex flex-wrap items-center justify-between gap-[8px]">
              <div className="flex flex-wrap items-center gap-[6px]">
                <span className="text-small font-medium text-muted">Vorgaben:</span>
                {[
                  { label: 'Podcast / Talk', settings: { musicDb: -14, duckDb: 16, sensitivity: 0.5, attackMs: 120, releaseMs: 600 } },
                  { label: 'Radio / Moderation', settings: { musicDb: -10, duckDb: 14, sensitivity: 0.6, attackMs: 80, releaseMs: 400 } },
                  { label: 'Hintergrund / Dezent', settings: { musicDb: -18, duckDb: 8, sensitivity: 0.4, attackMs: 200, releaseMs: 800 } },
                  { label: 'Voiceover / Stark', settings: { musicDb: -8, duckDb: 22, sensitivity: 0.7, attackMs: 60, releaseMs: 350 } },
                ].map((preset) => (
                  <button
                    key={preset.label}
                    type="button"
                    onClick={() => update(preset.settings)}
                    className="rounded-nav bg-panel-soft px-[10px] py-[4px] text-small font-medium text-ink hover:bg-panel-mid transition-colors ring-1 ring-line"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <UndoRedoBar canUndo={history.canUndo} canRedo={history.canRedo} onUndo={history.undo} onRedo={history.redo} />
            </div>

            {/* 3 Thematische Karten */}
            <div className="mt-[16px] grid gap-[16px] md:grid-cols-3">
              {/* Karte 1: Lautstaerke & Ducking */}
              <div className="flex flex-col gap-[14px] rounded-card bg-panel-soft p-[16px] ring-1 ring-line">
                <span className="text-small font-semibold text-ink">Lautstärke & Absenkung</span>
                <Slider
                  label="Musikpegel"
                  display={decibels(settings.musicDb)}
                  min={-30}
                  max={0}
                  step={0.5}
                  value={settings.musicDb}
                  onChange={(event) => update({ musicDb: Number(event.target.value) })}
                />
                <Slider
                  label="Beim Sprechen leiser um"
                  display={decibels(-settings.duckDb).replace('−', '')}
                  min={0}
                  max={30}
                  step={0.5}
                  value={settings.duckDb}
                  onChange={(event) => update({ duckDb: Number(event.target.value) })}
                />
                <Slider
                  label="Sprach-Empfindlichkeit"
                  display={`${Math.round(settings.sensitivity * 100)} %`}
                  min={0}
                  max={1}
                  step={0.05}
                  value={settings.sensitivity}
                  onChange={(event) => update({ sensitivity: Number(event.target.value) })}
                />
              </div>

              {/* Karte 2: Dynamik & Uebergaenge */}
              <div className="flex flex-col gap-[14px] rounded-card bg-panel-soft p-[16px] ring-1 ring-line">
                <span className="text-small font-semibold text-ink">Dynamik & Übergänge</span>
                <Slider
                  label="Wird leiser in (Attack)"
                  display={`${settings.attackMs} ms`}
                  min={20}
                  max={600}
                  step={10}
                  value={settings.attackMs}
                  onChange={(event) => update({ attackMs: Number(event.target.value) })}
                />
                <Slider
                  label="Kommt zurück in (Release)"
                  display={`${settings.releaseMs} ms`}
                  min={100}
                  max={3000}
                  step={50}
                  value={settings.releaseMs}
                  onChange={(event) => update({ releaseMs: Number(event.target.value) })}
                />
                <p className="mt-auto text-micro text-muted">
                  Kurze Zeiten reagieren direkt auf jedes Wort; längere Zeiten gleiten sanft.
                </p>
              </div>

              {/* Karte 3: Arrangement & Vor-/Nachlauf */}
              <div className="flex flex-col gap-[14px] rounded-card bg-panel-soft p-[16px] ring-1 ring-line">
                <span className="text-small font-semibold text-ink">Vor- & Nachlauf</span>
                <Slider
                  label="Musik vor Sprachbeginn"
                  display={seconds(settings.leadIn)}
                  min={0}
                  max={10}
                  step={0.5}
                  value={settings.leadIn}
                  onChange={(event) => update({ leadIn: Number(event.target.value) })}
                />
                <Slider
                  label="Ausklang nach Sprache"
                  display={seconds(settings.tail)}
                  min={0}
                  max={15}
                  step={0.5}
                  value={settings.tail}
                  onChange={(event) => update({ tail: Number(event.target.value) })}
                />
                <div className="mt-auto pt-[4px]">
                  <Toggle
                    label="Musik wiederholen (Loop)"
                    hint="Wiederholt die Musik, falls sie kürzer als die Stimme ist."
                    checked={settings.loopMusic}
                    onChange={(value) => update({ loopMusic: value })}
                  />
                </div>
              </div>
            </div>
          </>
        )}

        {decoding ? <div className="mt-[16px]"><Progress value={null} label="Ton wird gelesen" /></div> : null}
        </div>
      </Card>

      {error ? (
        <Notice tone="error" title="Hat nicht geklappt">
          {error}
        </Notice>
      ) : null}

      {result && report ? (
        <Card tone="mint">
          <div className="flex flex-wrap items-baseline justify-between gap-[12px]">
            <p className="text-small font-semibold text-ink">Mischung</p>
            <span className="value text-small text-prose">{formatTimecode(report.totalSeconds)}</span>
          </div>
          <div className="mt-[12px]">
            <DuckGraph result={result.mix} />
          </div>
          <ol className="mt-[12px] flex flex-col text-small text-prose">
            <li className="flex justify-between gap-[12px] border-t border-line py-[6px]">
              <span>Stimme erkannt</span>
              <span className="value text-ink">
                {formatTimecode(report.speechSeconds)} von {formatTimecode(report.voiceSeconds)} · ab {decibels(report.thresholdDb)}FS
              </span>
            </li>
            <li className="flex justify-between gap-[12px] border-t border-line py-[6px]">
              <span>Musik</span>
              <span className="value text-ink">
                {decibels(settings.musicDb)}, beim Sprechen {decibels(settings.musicDb - settings.duckDb)}
              </span>
            </li>
            <li className="flex justify-between gap-[12px] border-t border-line py-[6px]">
              <span>Übergänge</span>
              <span className="value text-ink">leiser in {settings.attackMs} ms, zurück in {settings.releaseMs} ms</span>
            </li>
            <li className="flex justify-between gap-[12px] border-t border-line py-[6px]">
              <span>Spitze</span>
              <span className="value text-ink">
                {report.trimDb > 0 ? `−1,0 dBFS · um ${decibels(report.trimDb).replace('+', '')} zurückgenommen` : `${decibels(report.peakDb)}FS`}
              </span>
            </li>
          </ol>
          <div className="mt-[12px]">
            <AudioPreview sources={previewSources} />
          </div>
          <div className="mt-[16px] flex flex-wrap gap-[8px]">
            <Button onClick={intoSession} disabled={Boolean(writing)}>
              In die Sitzung übernehmen
              <ArrowRight />
            </Button>
            <Button variant="quiet" disabled={Boolean(writing)} onClick={() => saveBytes(encodeWav(result.mix.audio, 24), `${stem} (gemischt).wav`, 'audio/wav')}>
              Als WAV speichern
            </Button>
            <DriveSaveButton
              size="md"
              disabled={Boolean(writing)}
              name={`${stem} (gemischt).wav`}
              bytes={() => encodeWav(result.mix.audio, 24)}
              source={result.mix.audio}
              mime="audio/wav"
              folder="audio"
            />
            {voice?.kind === 'video' ? (
              <Button variant="quiet" disabled={Boolean(writing)} onClick={() => void intoVideo()}>
                Unter das Video legen
              </Button>
            ) : null}
          </div>
          <div className="mt-[16px] border-t border-line pt-[12px]">
            <ZipSave
              suggestion={`${stem}-spuren`}
              label="Einzelspuren als ZIP"
              variant="quiet"
              disabled={Boolean(writing) || !decoded}
              onSave={({ file, stem: folder }) => {
                if (!decoded) return
                const zipData = createZip([
                  { name: `${folder}/01_Stimme_Roh.wav`, data: encodeWav(decoded.voice, 24) },
                  { name: `${folder}/02_Musik_Bearbeitet.wav`, data: encodeWav(decoded.music, 24) },
                  { name: `${folder}/03_Master_Geduckt.wav`, data: encodeWav(result.mix.audio, 24) },
                ])
                saveBytes(zipData, file, 'application/zip')
                log('mischen', 'Einzelspuren als ZIP exportiert')
              }}
            />
          </div>
          {voice?.kind === 'video' ? (
            <p className="mt-[8px] max-w-[64ch] text-small leading-[1.55] text-prose">
              Unter dem Video ohne „Musik vorher“ und „Ausklang“, damit Bild und Stimme zusammenbleiben.
            </p>
          ) : null}
          {writing ? <div className="mt-[12px]"><Progress value={null} label={writing} /></div> : null}
        </Card>
      ) : null}
    </div>
  )
}
