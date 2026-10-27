import { Captions, Download, Film, Flag, FolderOpen, Image as ImageIcon, Layers, Loader2, Mic, Music, Palette, Pause, Play, Plus, RefreshCw, Search, Shapes, Smile, Sparkles, Trash2, Type, Upload, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react'
import { CAPTION_PRESETS, EFFECTS, SHAPE_PRESETS, STICKERS, TRANSITIONS } from '../model/defaults'
import { clipEnd, isTextClip } from '../model/timeline'
import type { Asset, TextClip, TextStyle, TransitionName } from '../model/types'
import { FILTER_PRESETS } from '../engine/filters'
import type { FlagItem } from '../engine/flags'
import { fetchSoundFile, getFreesoundKey, licenseLabel, searchSounds, setFreesoundKey, type SoundResult } from '../engine/freesound'
import {
  deleteLibraryItem,
  dismissJob,
  emptyTrash,
  formatBytes,
  getLibraryStatus,
  getTrash,
  isJobActive,
  libraryAudioUrl,
  listJobs,
  listLibrary,
  revealLibraryFolder,
  startYouTubeJob,
  updateYtDlp,
  type LibraryItem,
  type LibraryJob,
  type LibraryStatus,
  type TrashInfo,
} from '../engine/library'
import { shapeSvgPath } from '../engine/shapes'
import type { WhisperModel } from '../engine/transcribe'
import {
  addAssetToTimeline,
  addEffect,
  addFilterLayer,
  addFlagSticker,
  addLibraryAudio,
  addShape,
  addSticker,
  addText,
  addTransition,
  applyCaptionPreset,
  applyFilter,
  autoCaptions,
  importCaptionsFile,
  importFiles,
  importLutFile,
  removeFromBin,
  seek,
  select,
  setLeftTab,
  startVoiceover,
  stopVoiceover,
  updateClipById,
} from '../state/actions'
import type { LeftTab } from '../state/store'
import { useEditor } from '../state/store'
import { Button, Empty, Row, Section, Segmented, Select, Toggle, cx, formatDuration, formatTimecode } from './controls'
import { DRAG_TYPES } from './Timeline'

const TABS: Array<{ id: LeftTab; label: string; icon: ReactNode }> = [
  { id: 'media', label: 'Media', icon: <Film size={16} /> },
  { id: 'audio', label: 'Audio', icon: <Music size={16} /> },
  { id: 'text', label: 'Text', icon: <Type size={16} /> },
  { id: 'stickers', label: 'Stickers', icon: <Smile size={16} /> },
  { id: 'effects', label: 'Effects', icon: <Sparkles size={16} /> },
  { id: 'transitions', label: 'Transitions', icon: <Layers size={16} /> },
  { id: 'filters', label: 'Filters', icon: <Palette size={16} /> },
  { id: 'captions', label: 'Captions', icon: <Captions size={16} /> },
]

export function LeftPanel() {
  const tab = useEditor((s) => s.leftTab)
  return (
    <div className="flex h-full min-h-0 flex-col bg-[#14171d]">
      <nav className="grid shrink-0 grid-cols-4 gap-0.5 border-b border-white/[0.06] p-1" aria-label="Asset panels">
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setLeftTab(t.id)}
            className={cx(
              'flex flex-col items-center gap-0.5 rounded-md px-1 py-1.5 text-[10px] font-medium transition-colors',
              tab === t.id ? 'bg-blue-500/15 text-blue-300' : 'text-zinc-400 hover:bg-white/5 hover:text-zinc-100',
            )}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </nav>
      <div className="ve-scroll min-h-0 flex-1 overflow-y-auto bg-[#1c2028]">
        {tab === 'media' && <MediaPanel />}
        {tab === 'audio' && <AudioPanel />}
        {tab === 'text' && <TextPanel />}
        {tab === 'stickers' && <StickersPanel />}
        {tab === 'effects' && <EffectsPanel />}
        {tab === 'transitions' && <TransitionsPanel />}
        {tab === 'filters' && <FiltersPanel />}
        {tab === 'captions' && <CaptionsPanel />}
      </div>
    </div>
  )
}

const pickFiles = (accept: string, multiple = true): Promise<File[]> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.multiple = multiple
    input.onchange = () => resolve(input.files ? [...input.files] : [])
    input.click()
  })

const setDrag = (e: DragEvent, type: string, value: string) => {
  e.dataTransfer.setData(type, value)
  e.dataTransfer.effectAllowed = 'copy'
}

// ── Media ───────────────────────────────────────────────────────────────────

function MediaPanel() {
  const assets = useEditor((s) => s.assets)
  const bin = useEditor((s) => s.project.bin)
  const [filter, setFilter] = useState<'all' | 'video' | 'image'>('all')
  const items = bin.map((id) => assets[id]).filter((a): a is Asset => !!a && (a.kind === 'video' || a.kind === 'image') && (filter === 'all' || a.kind === filter))

  return (
    <div className="p-3">
      <ImportZone accept="video/*,image/*,audio/*,.srt,.vtt,.ass,.ssa,.cube" label="Import media" hint="Video, photos, audio, captions (.srt/.vtt/.ass) or LUTs (.cube) — or paste from the clipboard" />
      <div className="mb-2 mt-3 flex items-center justify-between">
        <Segmented
          value={filter}
          size="xs"
          options={[
            { value: 'all', label: 'All' },
            { value: 'video', label: 'Videos' },
            { value: 'image', label: 'Photos' },
          ]}
          onChange={setFilter}
        />
        <span className="text-[10px] text-zinc-500">{items.length} items</span>
      </div>
      {items.length === 0 ? (
        <Empty>Imported videos and photos appear here. Drag them onto the timeline or click + to add at the playhead.</Empty>
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {items.map((a) => (
            <AssetCard key={a.id} asset={a} />
          ))}
        </div>
      )}
    </div>
  )
}

function ImportZone({ accept, label, hint }: { accept: string; label: string; hint: string }) {
  const [over, setOver] = useState(false)
  return (
    <button
      type="button"
      onClick={async () => {
        const files = await pickFiles(accept)
        if (files.length) void importFiles(files)
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          setOver(true)
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        e.stopPropagation()
        setOver(false)
        if (e.dataTransfer.files.length) void importFiles([...e.dataTransfer.files])
      }}
      className={cx(
        'flex w-full flex-col items-center gap-1 rounded-lg border border-dashed px-3 py-4 text-center transition-colors',
        over ? 'border-blue-400 bg-blue-500/10' : 'border-white/15 hover:border-white/30 hover:bg-white/[0.03]',
      )}
    >
      <Upload size={18} className="text-blue-300" />
      <span className="text-xs font-semibold text-zinc-100">{label}</span>
      <span className="text-[10px] text-zinc-500">{hint}</span>
    </button>
  )
}

function AssetCard({ asset }: { asset: Asset }) {
  const thumbs = useEditor((s) => s.thumbnails[asset.id])
  const thumb = thumbs?.urls[Math.min(thumbs.urls.length - 1, Math.floor(thumbs.urls.length / 3))]
  return (
    <div
      draggable
      onDragStart={(e) => setDrag(e, DRAG_TYPES.asset, asset.id)}
      className="group relative overflow-hidden rounded-lg border border-white/10 bg-black/40"
      title={`${asset.name}${asset.width ? ` · ${asset.width}×${asset.height}` : ''}`}
    >
      <div className="relative aspect-video bg-black">
        {thumb ? <img src={thumb} alt="" draggable={false} className="h-full w-full object-cover" /> : <div className="flex h-full items-center justify-center text-zinc-600">{asset.kind === 'image' ? <ImageIcon size={18} /> : <Film size={18} />}</div>}
        {asset.kind === 'video' && <span className="absolute bottom-1 right-1 rounded bg-black/70 px-1 text-[9px] text-white">{formatDuration(asset.duration)}</span>}
        <button
          type="button"
          title="Add to timeline at playhead"
          aria-label="Add to timeline"
          onClick={() => addAssetToTimeline(asset.id)}
          className="absolute right-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-blue-500 text-white opacity-0 shadow transition-opacity group-hover:opacity-100"
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          title="Remove from media"
          aria-label="Remove from media"
          onClick={() => removeFromBin(asset.id)}
          className="absolute left-1 top-1 flex h-6 w-6 items-center justify-center rounded-full bg-black/70 text-zinc-300 opacity-0 transition-opacity hover:text-red-300 group-hover:opacity-100"
        >
          <X size={12} />
        </button>
      </div>
      <p className="truncate px-1.5 py-1 text-[10px] text-zinc-300">{asset.name}</p>
    </div>
  )
}

// ── Audio ───────────────────────────────────────────────────────────────────

function AudioPanel() {
  const assets = useEditor((s) => s.assets)
  const bin = useEditor((s) => s.project.bin)
  const recording = useEditor((s) => s.recording)
  const items = bin.map((id) => assets[id]).filter((a): a is Asset => !!a && a.kind === 'audio')
  return (
    <div className="p-3">
      <ImportZone accept="audio/*,video/*" label="Import music or sound" hint="MP3, WAV, M4A, AAC, OGG, FLAC" />
      <YouTubeSection />
      <Section title="Voiceover">
        <p className="text-[11px] leading-5 text-zinc-400">Records your microphone from the playhead while the timeline plays muted, then places the take on an audio track.</p>
        {recording ? (
          <Button variant="danger" onClick={() => void stopVoiceover()} className="w-full border border-red-500/40">
            <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" /> Stop recording
          </Button>
        ) : (
          <Button variant="primary" onClick={() => void startVoiceover()} className="w-full">
            <Mic size={13} /> Record voiceover
          </Button>
        )}
      </Section>
      <SoundsSection />
      <p className="mb-2 mt-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400">Your audio</p>
      {items.length === 0 ? (
        <Empty>Imported music, sound effects and voiceovers appear here.</Empty>
      ) : (
        <div className="space-y-1.5">
          {items.map((a) => (
            <div
              key={a.id}
              draggable
              onDragStart={(e) => setDrag(e, DRAG_TYPES.asset, a.id)}
              className="group flex items-center gap-2 rounded-lg border border-white/10 bg-black/30 px-2 py-2"
            >
              <Music size={14} className="shrink-0 text-emerald-300" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs text-zinc-100">{a.name}</p>
                <p className="text-[10px] text-zinc-500">{formatDuration(a.duration)}</p>
              </div>
              <button type="button" title="Add at playhead" aria-label="Add at playhead" onClick={() => addAssetToTimeline(a.id)} className="rounded p-1 text-zinc-300 hover:bg-white/10">
                <Plus size={14} />
              </button>
              <button type="button" title="Remove from media" aria-label="Remove from media" onClick={() => removeFromBin(a.id)} className="rounded p-1 text-zinc-500 opacity-0 hover:text-red-300 group-hover:opacity-100">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <p className="mt-4 text-[10px] leading-4 text-zinc-500">Tip: select a music clip and use Audio → Auto beat to snap cuts to the rhythm.</p>
    </div>
  )
}

/** Freesound search (OpenCut "Sounds"): the user's own API key, calls go straight from the browser. */
function SoundsSection() {
  const [key, setKey] = useState(getFreesoundKey())
  const [editingKey, setEditingKey] = useState(!getFreesoundKey())
  const [query, setQuery] = useState('')
  const [commercial, setCommercial] = useState(true)
  const [results, setResults] = useState<SoundResult[] | null>(null)
  const [count, setCount] = useState(0)
  const [next, setNext] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [playing, setPlaying] = useState<number | null>(null)
  const ctrl = useRef<AbortController | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  useEffect(() => () => audio.current?.pause(), [])

  const run = async (page = 1) => {
    if (!key.trim()) {
      setError('Add your Freesound API key first.')
      setEditingKey(true)
      return
    }
    ctrl.current?.abort()
    const c = new AbortController()
    ctrl.current = c
    setLoading(true)
    setError(null)
    try {
      const r = await searchSounds(query, { key: key.trim(), page, commercialOnly: commercial, signal: c.signal })
      setResults(page === 1 ? r.results : [...(results ?? []), ...r.results])
      setCount(r.count)
      setNext(r.nextPage)
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message)
    } finally {
      setLoading(false)
    }
  }

  const preview = (s: SoundResult) => {
    if (playing === s.id) {
      audio.current?.pause()
      setPlaying(null)
      return
    }
    audio.current?.pause()
    const a = new Audio(s.previewUrl)
    a.onended = () => setPlaying(null)
    audio.current = a
    void a.play()
    setPlaying(s.id)
  }

  const add = async (s: SoundResult) => {
    try {
      const file = await fetchSoundFile(s)
      const [asset] = await importFiles([file])
      if (asset) addAssetToTimeline(asset.id)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <Section title="Sound library" defaultOpen={false}>
      <p className="text-[11px] leading-5 text-zinc-400">Search 600,000+ Creative Commons sounds on Freesound. You need a free API key from freesound.org (Account → API keys).</p>
      {editingKey ? (
        <div className="flex gap-1">
          <input
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            onKeyDown={(e) => e.stopPropagation()}
            placeholder="Freesound API key"
            className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
          />
          <Button
            variant="primary"
            onClick={() => {
              setFreesoundKey(key)
              setEditingKey(false)
            }}
          >
            Save
          </Button>
        </div>
      ) : (
        <p className="text-[10px] text-zinc-500">
          API key saved on this device.{' '}
          <button type="button" className="text-blue-300 hover:underline" onClick={() => setEditingKey(true)}>
            Change
          </button>
        </p>
      )}
      <div className="flex items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2">
        <Search size={12} className="text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') void run(1)
          }}
          placeholder="whoosh, click, applause…"
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-zinc-600"
        />
        <Button variant="ghost" onClick={() => void run(1)} disabled={loading}>
          Search
        </Button>
      </div>
      <Row label="Commercial use" hint="Only CC0 and CC BY sounds, safe for client work">
        <Toggle checked={commercial} onChange={setCommercial} />
      </Row>
      {error && <p className="text-[11px] text-red-300">{error}</p>}
      {results && (
        <>
          <p className="text-[10px] text-zinc-500">{count.toLocaleString()} results</p>
          <div className="space-y-1">
            {results.map((s) => (
              <div key={s.id} className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-2 py-1.5">
                <button type="button" onClick={() => preview(s)} title="Preview" aria-label="Preview" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-100 hover:bg-white/20">
                  {playing === s.id ? <Pause size={11} /> : <Play size={11} />}
                </button>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs text-zinc-100" title={s.name}>
                    {s.name}
                  </p>
                  <p className="truncate text-[10px] text-zinc-500">
                    {formatDuration(s.duration)} · {s.username} · {licenseLabel(s.license)}
                  </p>
                </div>
                <button type="button" title="Add to timeline" aria-label="Add to timeline" onClick={() => void add(s)} className="rounded p-1 text-zinc-300 hover:bg-white/10">
                  <Plus size={14} />
                </button>
              </div>
            ))}
          </div>
          {next && (
            <Button variant="outline" className="w-full" onClick={() => void run(next)} disabled={loading}>
              {loading ? 'Loading…' : 'Load more'}
            </Button>
          )}
        </>
      )}
    </Section>
  )
}

/**
 * YouTube → audio. The Vite process does the work (server/library): the audio
 * lands on disk and is listed here in every project; the video it came from
 * waits in "To Be Deleted" until the user clears it.
 */
function YouTubeSection() {
  const [status, setStatus] = useState<LibraryStatus | null | undefined>(undefined)
  const [url, setUrl] = useState('')
  const [items, setItems] = useState<LibraryItem[]>([])
  const [jobs, setJobs] = useState<LibraryJob[]>([])
  const [trash, setTrash] = useState<TrashInfo | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [updating, setUpdating] = useState(false)
  const [playing, setPlaying] = useState<string | null>(null)
  const audio = useRef<HTMLAudioElement | null>(null)

  const refresh = async () => {
    try {
      const [i, j, t] = await Promise.all([listLibrary(), listJobs(), getTrash()])
      setItems(i)
      setJobs(j)
      setTrash(t)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  useEffect(() => {
    let alive = true
    getLibraryStatus()
      .then((s) => {
        if (!alive) return
        setStatus(s)
        void refresh()
      })
      .catch(() => alive && setStatus(null))
    return () => {
      alive = false
      audio.current?.pause()
    }
  }, [])

  const active = jobs.some(isJobActive)
  useEffect(() => {
    if (!active) return
    const id = window.setInterval(() => void refresh(), 1000)
    return () => window.clearInterval(id)
  }, [active])

  const submit = async () => {
    const text = url.trim()
    if (!text) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await startYouTubeJob(text)
      setUrl('')
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const preview = (item: LibraryItem) => {
    if (playing === item.id) {
      audio.current?.pause()
      setPlaying(null)
      return
    }
    audio.current?.pause()
    const a = new Audio(libraryAudioUrl(item.id))
    a.onended = () => setPlaying(null)
    audio.current = a
    void a.play()
    setPlaying(item.id)
  }

  const remove = async (item: LibraryItem) => {
    if (!window.confirm(`Delete "${item.title}" from the audio library?\nProjects that already use it keep their own copy.`)) return
    if (playing === item.id) preview(item)
    try {
      await deleteLibraryItem(item.id)
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const clearTrash = async () => {
    if (!trash?.files.length) return
    const n = trash.files.length
    if (!window.confirm(`Permanently delete ${n} video file${n > 1 ? 's' : ''} (${formatBytes(trash.total)}) from "To Be Deleted"?`)) return
    try {
      await emptyTrash()
      await refresh()
    } catch (err) {
      setError((err as Error).message)
    }
  }

  const update = async () => {
    setUpdating(true)
    setError(null)
    setNotice(null)
    try {
      const r = await updateYtDlp()
      setStatus(await getLibraryStatus())
      setNotice(r.version ? `yt-dlp is now ${r.version}.` : r.output || 'Update finished.')
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setUpdating(false)
    }
  }

  const shown = jobs.filter((j) => j.status !== 'done' && j.status !== 'cancelled')
  const ready = !!status?.ytdlp && !!status?.ffmpeg

  return (
    <Section title="YouTube audio">
      {status === undefined ? (
        <p className="text-[11px] text-zinc-500">Checking the library server…</p>
      ) : status === null ? (
        <p className="text-[11px] leading-5 text-zinc-400">YouTube import runs on the computer that hosts the editor, and that server is not reachable from here.</p>
      ) : (
        <>
          <p className="text-[11px] leading-5 text-zinc-400">Paste a YouTube link. The audio is saved to the library below for every project; the video it came from goes to the “To Be Deleted” folder. Only use audio you have the rights to.</p>
          {!status.ytdlp && (
            <p className="text-[11px] leading-5 text-amber-300">
              yt-dlp is not installed. In PowerShell: <code className="rounded bg-black/40 px-1">python -m pip install -U yt-dlp</code>, then reload.
            </p>
          )}
          {!status.ffmpeg && (
            <p className="text-[11px] leading-5 text-amber-300">
              ffmpeg is not installed. In PowerShell: <code className="rounded bg-black/40 px-1">winget install Gyan.FFmpeg</code>, then reload.
            </p>
          )}
          <div className="flex gap-1">
            <input
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') void submit()
              }}
              placeholder="https://www.youtube.com/watch?v=…"
              aria-label="YouTube link"
              className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none placeholder:text-zinc-600 focus:border-blue-500"
            />
            <Button variant="primary" onClick={() => void submit()} disabled={busy || !url.trim() || !ready}>
              <Download size={13} /> Get audio
            </Button>
          </div>
          {error && <p className="text-[11px] text-red-300">{error}</p>}
          {notice && <p className="text-[11px] text-emerald-300">{notice}</p>}
          {shown.length > 0 && (
            <div className="space-y-1">
              {shown.map((j) => (
                <div key={j.id} className="rounded-md border border-white/10 bg-black/30 px-2 py-1.5">
                  <div className="flex items-center gap-2">
                    {isJobActive(j) ? <Loader2 size={12} className="shrink-0 animate-spin text-blue-300" /> : <X size={12} className="shrink-0 text-red-300" />}
                    <p className="min-w-0 flex-1 truncate text-xs text-zinc-100" title={j.title ?? j.url}>
                      {j.title ?? j.url}
                    </p>
                    <button
                      type="button"
                      title={isJobActive(j) ? 'Cancel' : 'Dismiss'}
                      aria-label={isJobActive(j) ? 'Cancel' : 'Dismiss'}
                      onClick={() => void dismissJob(j.id).then(refresh)}
                      className="rounded p-1 text-zinc-500 hover:text-red-300"
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {isJobActive(j) ? (
                    <>
                      <div className="mt-1 h-1 overflow-hidden rounded bg-white/10">
                        <div className="h-full bg-blue-400 transition-[width]" style={{ width: `${Math.round(j.progress * 100)}%` }} />
                      </div>
                      <p className="mt-0.5 text-[10px] text-zinc-500">{j.status === 'downloading' ? `${j.message ?? 'Downloading…'} ${Math.round(j.progress * 100)}%` : (j.message ?? j.status)}</p>
                    </>
                  ) : (
                    <p className="mt-0.5 text-[10px] text-red-300">{j.message ?? 'Failed'}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {items.length === 0 ? (
            shown.length === 0 && <Empty>Audio you pull from YouTube appears here, in every project.</Empty>
          ) : (
            <div className="space-y-1">
              {items.map((item) => (
                <div
                  key={item.id}
                  draggable
                  onDragStart={(e) => setDrag(e, DRAG_TYPES.library, item.id)}
                  className="group flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-2 py-1.5"
                  title={`${item.title}\nDrag onto the timeline, or press + to add at the playhead`}
                >
                  <button type="button" onClick={() => preview(item)} title="Preview" aria-label="Preview" className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-white/10 text-zinc-100 hover:bg-white/20">
                    {playing === item.id ? <Pause size={11} /> : <Play size={11} />}
                  </button>
                  {item.thumbnail ? <img src={item.thumbnail} alt="" draggable={false} className="h-7 w-12 shrink-0 rounded object-cover" /> : <Music size={14} className="shrink-0 text-red-300" />}
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-zinc-100">{item.title}</p>
                    <p className="truncate text-[10px] text-zinc-500">
                      {formatDuration(item.duration)}
                      {item.uploader ? ` · ${item.uploader}` : ''} · {formatBytes(item.size)}
                    </p>
                  </div>
                  <button type="button" title="Add at playhead" aria-label="Add at playhead" onClick={() => void addLibraryAudio(item.id)} className="rounded p-1 text-zinc-300 hover:bg-white/10">
                    <Plus size={14} />
                  </button>
                  <button type="button" title="Delete from library" aria-label="Delete from library" onClick={() => void remove(item)} className="rounded p-1 text-zinc-500 opacity-0 hover:text-red-300 group-hover:opacity-100">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-zinc-500">
            <button type="button" className="inline-flex items-center gap-1 hover:text-zinc-300" onClick={() => void revealLibraryFolder('audio')}>
              <FolderOpen size={11} /> Audio folder
            </button>
            <button type="button" className="inline-flex items-center gap-1 hover:text-zinc-300" onClick={() => void revealLibraryFolder('trash')}>
              <FolderOpen size={11} /> To Be Deleted{trash?.files.length ? ` (${trash.files.length} · ${formatBytes(trash.total)})` : ' (empty)'}
            </button>
            {trash?.files.length ? (
              <button type="button" className="text-red-300 hover:underline" onClick={() => void clearTrash()}>
                Empty it
              </button>
            ) : null}
            {status.ytdlp && (
              <button type="button" className="inline-flex items-center gap-1 hover:text-zinc-300 disabled:opacity-50" onClick={() => void update()} disabled={updating} title="Update yt-dlp — do this when YouTube downloads start failing">
                <RefreshCw size={11} className={updating ? 'animate-spin' : ''} /> yt-dlp {status.ytdlp.version}
              </button>
            )}
          </div>
        </>
      )}
    </Section>
  )
}

// ── Text ────────────────────────────────────────────────────────────────────

const TEXT_PRESETS: Array<{ id: string; label: string; text: string; style: Partial<TextStyle>; y?: number; x?: number; preview: React.CSSProperties }> = [
  { id: 'default', label: 'Default', text: 'Add text', style: {}, preview: { fontWeight: 700 } },
  { id: 'title', label: 'Title', text: 'Your Title', style: { fontFamily: 'Montserrat', fontSize: 120, bold: true, letterSpacing: 2 }, preview: { fontFamily: 'Montserrat', fontWeight: 800, fontSize: 18 } },
  { id: 'subtitle', label: 'Subtitle', text: 'A short subtitle', style: { fontFamily: 'Inter', fontSize: 54, bold: false }, y: 120, preview: { fontSize: 12 } },
  { id: 'lower', label: 'Lower third', text: 'Name Surname\nTitle, Company', style: { fontSize: 44, align: 'left', bgColor: '#003594', bgOpacity: 0.92, bgPadding: 22, bgRadius: 6, shadowBlur: 0 }, x: -560, y: 330, preview: { background: '#003594', padding: '2px 6px', textAlign: 'left', fontSize: 10 } },
  { id: 'outline', label: 'Outline', text: 'OUTLINE', style: { fontFamily: 'Anton', fontSize: 130, strokeWidth: 10, strokeColor: '#000000', color: '#ffffff' }, preview: { fontFamily: 'Anton', WebkitTextStroke: '1px black', fontSize: 18 } },
  { id: 'neon', label: 'Neon', text: 'NEON', style: { fontFamily: 'Righteous', fontSize: 120, color: '#E0FFFF', shadowColor: '#22D3EE', shadowBlur: 30, shadowY: 0 }, preview: { fontFamily: 'Righteous', color: '#E0FFFF', textShadow: '0 0 8px #22D3EE', fontSize: 18 } },
  { id: 'hand', label: 'Handwritten', text: 'Handwritten', style: { fontFamily: 'Permanent Marker', fontSize: 100, bold: false }, preview: { fontFamily: 'Permanent Marker', fontSize: 16 } },
  { id: 'quote', label: 'Quote box', text: '“A great quote goes here.”', style: { fontFamily: 'Playfair Display', fontSize: 64, italic: true, bold: false, bgColor: '#000000', bgOpacity: 0.6, bgPadding: 30, bgRadius: 18 }, preview: { fontFamily: 'Playfair Display', fontStyle: 'italic', background: 'rgba(0,0,0,.6)', padding: '2px 6px', fontSize: 11 } },
  { id: 'pop', label: 'Pop', text: 'WOW!', style: { fontFamily: 'Bangers', fontSize: 150, color: '#FFE600', strokeWidth: 10, strokeColor: '#000000', bold: false }, preview: { fontFamily: 'Bangers', color: '#FFE600', WebkitTextStroke: '1px black', fontSize: 20 } },
  { id: 'brand', label: 'RocStarr', text: 'Systems > Campaigns', style: { fontFamily: 'Montserrat', fontSize: 70, bgColor: '#003594', bgOpacity: 0.95, bgPadding: 26, bgRadius: 10, highlightColor: '#FFD100' }, preview: { fontFamily: 'Montserrat', background: '#003594', padding: '2px 6px', fontWeight: 700, fontSize: 11 } },
]

function TextPanel() {
  const canvasH = useEditor((s) => s.project.canvas.height)
  const canvasW = useEditor((s) => s.project.canvas.width)
  const k = Math.min(canvasW, canvasH) / 1080
  return (
    <div className="p-3">
      <p className="mb-2 text-[11px] text-zinc-400">Click to add at the playhead, or drag onto the timeline. Double-click text on the preview to edit it in place.</p>
      <div className="grid grid-cols-2 gap-2">
        {TEXT_PRESETS.map((p) => {
          const style = { ...p.style, fontSize: Math.round((p.style.fontSize ?? 80) * k) }
          return (
            <button
              key={p.id}
              type="button"
              draggable
              onDragStart={(e) => setDrag(e, DRAG_TYPES.text, JSON.stringify(style))}
              onClick={() => addText(style, p.text, { x: Math.round((p.x ?? 0) * k), y: Math.round((p.y ?? 0) * k) })}
              className="flex h-20 flex-col items-center justify-center gap-1 rounded-lg border border-white/10 bg-black/40 px-2 text-white hover:border-blue-400/60"
            >
              <span className="max-w-full truncate" style={p.preview}>
                {p.text.split('\n')[0]}
              </span>
              <span className="text-[10px] text-zinc-500">{p.label}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Stickers: emoji, shapes, flags ──────────────────────────────────────────

type StickerTab = 'emoji' | 'shapes' | 'flags'

function StickersPanel() {
  const [tab, setTab] = useState<StickerTab>('emoji')
  return (
    <div className="p-3">
      <Segmented
        value={tab}
        size="xs"
        options={[
          { value: 'emoji', label: <span className="inline-flex items-center gap-1"><Smile size={12} /> Emoji</span> },
          { value: 'shapes', label: <span className="inline-flex items-center gap-1"><Shapes size={12} /> Shapes</span> },
          { value: 'flags', label: <span className="inline-flex items-center gap-1"><Flag size={12} /> Flags</span> },
        ]}
        onChange={setTab}
      />
      <div className="mt-3">
        {tab === 'emoji' && (
          <div className="grid grid-cols-6 gap-1">
            {STICKERS.map((s) => (
              <button
                key={s}
                type="button"
                draggable
                onDragStart={(e) => setDrag(e, DRAG_TYPES.sticker, s)}
                onClick={() => addSticker(s)}
                className="flex aspect-square items-center justify-center rounded-lg text-2xl hover:bg-white/10"
                title="Add sticker"
              >
                {s}
              </button>
            ))}
          </div>
        )}
        {tab === 'shapes' && <ShapesGrid />}
        {tab === 'flags' && <FlagsGrid />}
      </div>
      <Section title="Your own sticker">
        <p className="text-[11px] text-zinc-400">Import a PNG with transparency (logo, badge) — it is added as an overlay you can move, scale and animate.</p>
        <Button
          variant="outline"
          onClick={async () => {
            const files = await pickFiles('image/png,image/webp,image/svg+xml,image/gif', false)
            if (!files.length) return
            const [asset] = await importFiles(files)
            if (asset) addAssetToTimeline(asset.id, undefined, undefined, true)
          }}
        >
          <Upload size={13} /> Import image sticker
        </Button>
      </Section>
    </div>
  )
}

function ShapesGrid() {
  return (
    <>
      <p className="mb-2 text-[11px] text-zinc-400">Vector shapes with editable fill, stroke and corners. Click to add at the playhead.</p>
      <div className="grid grid-cols-4 gap-1.5">
        {SHAPE_PRESETS.map((p) => {
          const params = { shape: p.shape, cornerRadius: p.params?.cornerRadius ?? 0, sides: p.params?.sides ?? 6, points: p.params?.points ?? 5, innerRadius: p.params?.innerRadius ?? 0.45 }
          const fill = p.params?.fill ?? '#FFD100'
          const strokeW = p.params?.strokeWidth ?? 0
          return (
            <button
              key={p.id}
              type="button"
              draggable
              onDragStart={(e) => setDrag(e, DRAG_TYPES.shape, p.id)}
              onClick={() => addShape(p.id)}
              className="flex flex-col items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-2 hover:border-blue-400/60"
              title={`Add ${p.label.toLowerCase()}`}
            >
              <svg viewBox="0 0 40 40" className="h-9 w-9" aria-hidden>
                <path d={shapeSvgPath(p.shape, params, strokeW ? 32 : 36)} transform={strokeW ? 'translate(4 4)' : 'translate(2 2)'} fill={fill === 'transparent' ? 'none' : fill} stroke={strokeW ? (p.params?.strokeColor ?? '#fff') : 'none'} strokeWidth={strokeW ? 3 : 0} />
              </svg>
              <span className="text-[10px] text-zinc-400">{p.label}</span>
            </button>
          )
        })}
      </div>
    </>
  )
}

function FlagsGrid() {
  const [items, setItems] = useState<FlagItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [flagUrl, setFlagUrl] = useState<((code: string) => string) | null>(null)
  useEffect(() => {
    void import('../engine/flags').then((m) => {
      setItems(m.flagItems())
      setFlagUrl(() => m.flagUrl)
    })
  }, [])
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (items ?? []).filter((f) => !q || f.name.toLowerCase().includes(q) || f.code.includes(q))
  }, [items, query])
  return (
    <>
      <div className="mb-2 flex items-center gap-1.5 rounded-md border border-white/10 bg-black/30 px-2">
        <Search size={12} className="text-zinc-500" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder={items ? `Search ${items.length} flags` : 'Loading flags…'}
          className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-white outline-none placeholder:text-zinc-600"
        />
      </div>
      {!items || !flagUrl ? (
        <Empty>Loading…</Empty>
      ) : (
        <div className="grid grid-cols-4 gap-1.5">
          {shown.slice(0, 160).map((f) => (
            <button
              key={f.code}
              type="button"
              draggable
              onDragStart={(e) => setDrag(e, DRAG_TYPES.flag, `${f.code}|${f.name}`)}
              onClick={() => void addFlagSticker(f.code, f.name)}
              className="flex flex-col items-center gap-1 rounded-lg border border-white/10 bg-black/40 p-1.5 hover:border-blue-400/60"
              title={f.name}
            >
              <img src={flagUrl(f.code)} alt="" loading="lazy" draggable={false} className="h-7 w-10 rounded-sm object-cover" />
              <span className="w-full truncate text-center text-[9px] text-zinc-400">{f.name}</span>
            </button>
          ))}
          {shown.length > 160 && <p className="col-span-4 text-center text-[10px] text-zinc-500">Type to narrow down — {shown.length - 160} more</p>}
          {!shown.length && <p className="col-span-4 text-center text-[11px] text-zinc-500">No flag matches.</p>}
        </div>
      )}
      <p className="mt-2 text-[10px] text-zinc-500">Flag artwork: flag-icons (MIT).</p>
    </>
  )
}

// ── Effects & transitions ───────────────────────────────────────────────────

const EFFECT_SWATCH: Record<string, string> = {
  Basic: 'from-sky-600 to-indigo-700',
  Retro: 'from-amber-600 to-rose-700',
  Motion: 'from-emerald-600 to-teal-700',
  Distort: 'from-fuchsia-600 to-violet-800',
}

function EffectsPanel() {
  const groups = ['Basic', 'Retro', 'Motion', 'Distort'] as const
  return (
    <div className="p-3">
      <p className="mb-2 text-[11px] text-zinc-400">Effects apply to the whole frame on their own track. Click to add at the playhead.</p>
      {groups.map((g) => (
        <div key={g} className="mb-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{g}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {EFFECTS.filter((e) => e.group === g).map((e) => (
              <button
                key={e.id}
                type="button"
                draggable
                onDragStart={(ev) => setDrag(ev, DRAG_TYPES.effect, e.id)}
                onClick={() => addEffect(e.id)}
                className="overflow-hidden rounded-lg border border-white/10 text-left hover:border-blue-400/60"
              >
                <div className={cx('flex aspect-[4/3] items-center justify-center bg-gradient-to-br', EFFECT_SWATCH[g])}>
                  <Sparkles size={16} className="text-white/80" />
                </div>
                <p className="truncate px-1.5 py-1 text-[10px] text-zinc-200">{e.label}</p>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

function TransitionsPanel() {
  return (
    <div className="p-3">
      <p className="mb-2 text-[11px] text-zinc-400">Click to add between two touching clips at the cut nearest the playhead, or drag onto the timeline.</p>
      <div className="grid grid-cols-3 gap-1.5">
        {TRANSITIONS.map((t) => (
          <button
            key={t.id}
            type="button"
            draggable
            onDragStart={(e) => setDrag(e, DRAG_TYPES.transition, t.id)}
            onClick={() => addTransition(t.id as TransitionName)}
            className="overflow-hidden rounded-lg border border-white/10 hover:border-blue-400/60"
          >
            <div className="flex aspect-[4/3] items-center justify-center bg-gradient-to-r from-zinc-700 via-zinc-500 to-blue-600 text-lg text-white">⇄</div>
            <p className="truncate px-1.5 py-1 text-[10px] text-zinc-200">{t.label}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

// ── Filters ─────────────────────────────────────────────────────────────────

function FiltersPanel() {
  const assets = useEditor((s) => s.assets)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const luts = Object.values(assets).filter((a) => a.kind === 'lut')
  const groups = useMemo(() => [...new Set(FILTER_PRESETS.map((p) => p.group))], [])
  return (
    <div className="p-3">
      <p className="mb-2 text-[11px] text-zinc-400">
        {hasSelection ? 'Click a look to apply it to the selected clips.' : 'Nothing selected: clicking a look adds it as a filter layer over the timeline.'}
      </p>
      <div className="mb-3 flex gap-1">
        <Button variant="outline" onClick={() => applyFilter(null, 'None')} disabled={!hasSelection}>
          Remove filter
        </Button>
        <Button variant="outline" onClick={() => addFilterLayer(null, 'Adjustment')}>
          + Adjustment layer
        </Button>
      </div>
      {groups.map((g) => (
        <div key={g} className="mb-3">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-500">{g}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {FILTER_PRESETS.filter((p) => p.group === g).map((p) => (
              <button key={p.id} type="button" onClick={() => applyFilter(p.id, p.name)} className="overflow-hidden rounded-lg border border-white/10 text-left hover:border-blue-400/60">
                <div className="aspect-[4/3]" style={{ background: p.swatch }} />
                <p className="truncate px-1.5 py-1 text-[10px] text-zinc-200">{p.name}</p>
              </button>
            ))}
          </div>
        </div>
      ))}
      <Section title="LUTs">
        <p className="text-[11px] text-zinc-400">Import a 3D LUT (.cube) from your camera or colorist.</p>
        <Button
          variant="outline"
          onClick={async () => {
            const files = await pickFiles('.cube', true)
            for (const f of files) await importLutFile(f).catch((e: Error) => alert(`${f.name}: ${e.message}`))
          }}
        >
          <Upload size={13} /> Import .cube LUT
        </Button>
        {luts.map((l) => (
          <button key={l.id} type="button" onClick={() => applyFilter(`lut:${l.id}`, l.name)} className="flex w-full items-center gap-2 rounded-md border border-white/10 px-2 py-1.5 text-left text-xs text-zinc-200 hover:border-blue-400/60">
            <Palette size={13} className="text-amber-300" /> {l.name}
          </button>
        ))}
      </Section>
    </div>
  )
}

// ── Captions ────────────────────────────────────────────────────────────────

const MODELS: Array<{ value: WhisperModel; label: string }> = [
  { value: 'tiny', label: 'Fastest (tiny, ~40 MB)' },
  { value: 'base', label: 'Balanced (base, ~80 MB)' },
  { value: 'small', label: 'Accurate (small, ~250 MB)' },
  { value: 'medium', label: 'More accurate (medium, ~1.5 GB)' },
  { value: 'large', label: 'Best (large-v3-turbo, ~2.5 GB, needs a strong GPU)' },
]

function CaptionsPanel() {
  const project = useEditor((s) => s.project)
  const playhead = useEditor((s) => s.playhead)
  const selection = useEditor((s) => s.selection)
  const [language, setLanguage] = useState('auto')
  const [model, setModel] = useState<WhisperModel>('base')
  const [source, setSource] = useState<'main' | 'all'>('main')
  const [preset, setPreset] = useState('classic')
  const [languages, setLanguages] = useState<Array<{ code: string; label: string }>>([{ code: 'auto', label: 'Auto detect' }])
  const loaded = useRef(false)
  if (!loaded.current) {
    loaded.current = true
    void import('../engine/transcribe').then((m) => setLanguages(m.TRANSCRIBE_LANGUAGES))
  }
  const captions = project.clips.filter((c): c is TextClip => isTextClip(c) && c.isCaption).sort((a, b) => a.start - b.start)

  const exportFile = async (format: 'srt' | 'vtt' | 'ass') => {
    const { captionCues } = await import('../engine/export')
    const { serializeSrt, serializeVtt, serializeAss } = await import('../engine/captions')
    const cues = captionCues(project)
    if (!cues.length) return
    const first = captions[0]
    const body =
      format === 'srt'
        ? serializeSrt(cues)
        : format === 'vtt'
          ? serializeVtt(cues)
          : serializeAss(cues, { width: project.canvas.width, height: project.canvas.height, fontFamily: first?.style.fontFamily, fontSize: first?.style.fontSize })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain' }))
    a.download = `${project.name}.${format}`
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 2000)
  }

  return (
    <div>
      <Section title="Auto captions">
        <p className="text-[11px] leading-5 text-zinc-400">Speech-to-text runs entirely in your browser — no upload. The model downloads once and is cached.</p>
        <Row label="Language">
          <Select value={language} options={languages.map((l) => ({ value: l.code, label: l.label }))} onChange={setLanguage} />
        </Row>
        <Row label="Quality">
          <Select value={model} options={MODELS.map((m) => ({ value: m.value, label: m.label }))} onChange={setModel} />
        </Row>
        <Row label="Listen to">
          <Segmented
            value={source}
            size="xs"
            options={[
              { value: 'main', label: 'Main track' },
              { value: 'all', label: 'All audio' },
            ]}
            onChange={setSource}
          />
        </Row>
        <Row label="Style">
          <Select value={preset} options={CAPTION_PRESETS.map((p) => ({ value: p.id, label: p.label }))} onChange={setPreset} />
        </Row>
        <Button variant="primary" className="w-full" onClick={() => void autoCaptions({ language, model, source, preset })}>
          <Captions size={13} /> {captions.length ? 'Regenerate captions' : 'Generate captions'}
        </Button>
      </Section>
      <Section title="Files">
        <div className="flex flex-wrap gap-1">
          <Button
            variant="outline"
            onClick={async () => {
              const files = await pickFiles('.srt,.vtt,.ass,.ssa', false)
              if (files[0]) void importCaptionsFile(files[0])
            }}
          >
            <Upload size={13} /> Import SRT / VTT / ASS
          </Button>
          <Button variant="outline" disabled={!captions.length} onClick={() => void exportFile('srt')}>
            Export SRT
          </Button>
          <Button variant="outline" disabled={!captions.length} onClick={() => void exportFile('vtt')}>
            Export VTT
          </Button>
          <Button variant="outline" disabled={!captions.length} onClick={() => void exportFile('ass')} title="Styled subtitles for VLC, mpv, Aegisub">
            Export ASS
          </Button>
        </div>
      </Section>
      {captions.length > 0 && (
        <>
          <Section title="Style all captions">
            <div className="grid grid-cols-2 gap-1">
              {CAPTION_PRESETS.map((p) => (
                <Button key={p.id} variant="outline" onClick={() => applyCaptionPreset(p.id)}>
                  {p.label}
                </Button>
              ))}
            </div>
          </Section>
          <Section title={`Captions (${captions.length})`}>
            <div className="space-y-1">
              {captions.map((c) => {
                const active = playhead >= c.start && playhead < clipEnd(c)
                return (
                  <div key={c.id} className={cx('rounded-md border px-2 py-1.5', selection.includes(c.id) ? 'border-blue-400' : active ? 'border-white/25' : 'border-white/[0.06]')}>
                    <button
                      type="button"
                      className="mb-1 font-mono text-[10px] text-blue-300 hover:underline"
                      onClick={() => {
                        seek(c.start)
                        select([c.id])
                      }}
                    >
                      {formatTimecode(c.start, project.fps)} → {formatTimecode(clipEnd(c), project.fps)}
                    </button>
                    <textarea
                      value={c.text}
                      rows={Math.min(3, Math.ceil(c.text.length / 34) || 1)}
                      onChange={(e) => updateClipById<TextClip>(c.id, (x) => ({ ...x, text: e.target.value, name: e.target.value.slice(0, 40), words: null }))}
                      onKeyDown={(e) => e.stopPropagation()}
                      className="w-full resize-none bg-transparent text-xs text-zinc-100 outline-none"
                    />
                  </div>
                )
              })}
            </div>
          </Section>
        </>
      )}
    </div>
  )
}
