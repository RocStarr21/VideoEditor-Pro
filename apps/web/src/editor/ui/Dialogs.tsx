import { Clapperboard, Copy, Download, Film, FolderOpen, Keyboard, LoaderCircle, Plus, Redo2, RotateCcw, Trash2, Undo2, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { CANVAS_RATIOS } from '../model/defaults'
import { clipEnd, projectDuration } from '../model/timeline'
import type { ExportFormat, ExportQuality, ExportResult, ExportSettings } from '../engine/export'
import type { ProjectSummary } from '../engine/persistence'
import { deleteProjectById, duplicateProject, loadBlob, loadLut, newProject, openProject, renameProject, selectedClips } from '../state/actions'
import { ACTIONS, comboFromEvent, isModifierOnly, loadBindings, prettyCombo, rebind, resetBindings, type Bindings } from '../state/keybindings'
import { getEditorStore, useEditor } from '../state/store'
import { Button, Row, Segmented, Select, Toggle, cx, formatDuration } from './controls'

const store = () => getEditorStore()

// ── Top bar ─────────────────────────────────────────────────────────────────

export function TopBar({ onShowShortcuts }: { onShowShortcuts: () => void }) {
  const name = useEditor((s) => s.project.name)
  const projectId = useEditor((s) => s.project.id)
  const canUndo = useEditor((s) => s.canUndo)
  const canRedo = useEditor((s) => s.canRedo)
  const updatedAt = useEditor((s) => s.project.updatedAt)

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-white/[0.06] bg-[#041E42] px-3 text-white">
      <div className="flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#003594]">
          <Clapperboard size={16} />
        </div>
        <div className="leading-tight">
          <p className="text-[9px] font-semibold uppercase tracking-[0.22em] text-[#9fb0c8]">RocStarr Media</p>
          <p className="text-sm font-black">VideoEditor Pro</p>
        </div>
      </div>
      <a href="https://portal.rocstarrmedia.com/dashboard" className="hidden rounded-md border border-white/15 px-2 py-1 text-[11px] font-semibold text-white/80 hover:bg-white/10 md:block">
        ← Central Dashboard
      </a>
      <div className="mx-auto flex min-w-0 items-center gap-2">
        <input
          key={projectId}
          defaultValue={name}
          onBlur={(e) => renameProject(e.target.value)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          }}
          aria-label="Project name"
          className="w-56 min-w-0 truncate rounded-md bg-transparent px-2 py-1 text-center text-sm font-semibold outline-none hover:bg-white/5 focus:bg-white/10"
        />
        <SavedBadge updatedAt={updatedAt} />
      </div>
      <div className="flex items-center gap-1">
        <button type="button" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!canUndo} onClick={() => store().undo()} className="rounded-md p-1.5 hover:bg-white/10 disabled:opacity-30">
          <Undo2 size={16} />
        </button>
        <button type="button" title="Redo (Ctrl+Shift+Z)" aria-label="Redo" disabled={!canRedo} onClick={() => store().redo()} className="rounded-md p-1.5 hover:bg-white/10 disabled:opacity-30">
          <Redo2 size={16} />
        </button>
        <button type="button" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={onShowShortcuts} className="rounded-md p-1.5 hover:bg-white/10">
          <Keyboard size={16} />
        </button>
        <Button variant="outline" className="border-white/20 text-white" onClick={() => store().set({ projectsOpen: true })}>
          <FolderOpen size={14} /> Projects
        </Button>
        <Button variant="primary" className="bg-blue-500 px-4" onClick={() => store().set({ exportOpen: true })}>
          <Download size={14} /> Export
        </Button>
      </div>
    </header>
  )
}

function SavedBadge({ updatedAt }: { updatedAt: number }) {
  const [, tick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => tick((n) => n + 1), 15000)
    return () => window.clearInterval(id)
  }, [])
  const ago = Math.max(0, Math.round((Date.now() - updatedAt) / 1000))
  return <span className="hidden text-[10px] text-white/50 sm:inline">Saved on this device · {ago < 5 ? 'just now' : ago < 60 ? `${ago}s ago` : `${Math.round(ago / 60)}m ago`}</span>
}

// ── Modal shell ─────────────────────────────────────────────────────────────

function Modal({ title, onClose, children, width = 'max-w-lg' }: { title: string; onClose: () => void; children: ReactNode; width?: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div role="dialog" aria-modal="true" aria-label={title} className={cx('w-full overflow-hidden rounded-xl border border-white/10 bg-[#171a21] text-zinc-100 shadow-2xl', width)} onKeyDown={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-zinc-400 hover:bg-white/10 hover:text-white">
            <X size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

// ── Export ──────────────────────────────────────────────────────────────────

const FORMATS: Array<{ value: ExportFormat; label: string; hint: string }> = [
  { value: 'mp4', label: 'Video (MP4)', hint: 'Plays everywhere — social, web, phones' },
  { value: 'webm', label: 'Video (WebM)', hint: 'Open format, good for the web' },
  { value: 'gif', label: 'GIF', hint: 'Animated, silent, small loops' },
  { value: 'wav', label: 'Audio only (WAV)', hint: 'The full mix as an audio file' },
  { value: 'png', label: 'Still frame (PNG)', hint: 'The frame at the playhead' },
  { value: 'srt', label: 'Captions (SRT)', hint: 'For YouTube, LinkedIn, players' },
  { value: 'vtt', label: 'Captions (VTT)', hint: 'For web video players' },
  { value: 'ass', label: 'Captions (ASS)', hint: 'Styled subtitles for VLC, mpv, Aegisub' },
]

const RESOLUTIONS = [
  { value: 480, label: '480p' },
  { value: 720, label: '720p' },
  { value: 1080, label: '1080p' },
  { value: 1440, label: '2K' },
  { value: 2160, label: '4K' },
]

const GIF_SIZES = [
  { value: 320, label: '320p' },
  { value: 480, label: '480p' },
  { value: 640, label: '640p' },
]

export function ExportDialog() {
  const open = useEditor((s) => s.exportOpen)
  if (!open) return null
  return <ExportDialogBody />
}

function ExportDialogBody() {
  const project = useEditor((s) => s.project)
  const assets = useEditor((s) => s.assets)
  const playhead = useEditor((s) => s.playhead)
  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [resolution, setResolution] = useState(1080)
  const [fps, setFps] = useState(project.fps)
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [codec, setCodec] = useState<ExportSettings['codec']>('auto')
  const [includeAudio, setIncludeAudio] = useState(true)
  const [range, setRange] = useState<'all' | 'selection'>('all')
  const [encoders, setEncoders] = useState<Record<string, boolean> | null>(null)
  const [progress, setProgress] = useState<{ p: number; message: string } | null>(null)
  const [result, setResult] = useState<(ExportResult & { url: string; seconds: number }) | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const duration = projectDuration(project)

  const sel = selectedClips()
  const selRange = sel.length ? { start: Math.min(...sel.map((c) => c.start)), end: Math.max(...sel.map(clipEnd)) } : null

  useEffect(() => {
    let alive = true
    void import('../engine/export').then(async (m) => {
      const size = m.exportSize(project, resolution)
      const r = await m.probeEncoders(size.width, size.height)
      if (alive) setEncoders(r)
    })
    return () => {
      alive = false
    }
  }, [project, resolution])

  useEffect(() => () => {
    if (result) URL.revokeObjectURL(result.url)
  }, [result])

  const close = () => {
    controller.current?.abort()
    store().set({ exportOpen: false })
  }

  const run = async () => {
    setError(null)
    setResult(null)
    const ctrl = new AbortController()
    controller.current = ctrl
    const started = performance.now()
    setProgress({ p: 0, message: 'Starting…' })
    try {
      const { runExport } = await import('../engine/export')
      const settings: ExportSettings = {
        format,
        resolution: format === 'gif' ? Math.min(resolution, 640) : resolution,
        fps,
        quality,
        codec,
        includeAudio,
        range: range === 'selection' && selRange ? selRange : null,
        frameTime: playhead,
      }
      const out = await runExport(
        { project, assets, loadBlob, loadLut, signal: ctrl.signal, onProgress: (p, message) => setProgress({ p, message }) },
        settings,
      )
      setResult({ ...out, url: URL.createObjectURL(out.blob), seconds: (performance.now() - started) / 1000 })
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message || 'Export failed')
    } finally {
      setProgress(null)
      controller.current = null
    }
  }

  const isVideo = format === 'mp4' || format === 'webm'
  const isCaptions = format === 'srt' || format === 'vtt' || format === 'ass'
  const busy = !!progress
  const size = (() => {
    const short = Math.min(project.canvas.width, project.canvas.height)
    const s = (format === 'gif' ? Math.min(resolution, 640) : resolution) / short
    return `${Math.round((project.canvas.width * s) / 2) * 2}×${Math.round((project.canvas.height * s) / 2) * 2}`
  })()

  return (
    <Modal title="Export" onClose={close}>
      <div className="space-y-4 p-4">
        <div className="grid grid-cols-2 gap-1.5">
          {FORMATS.map((f) => (
            <button
              key={f.value}
              type="button"
              disabled={busy}
              onClick={() => {
                setFormat(f.value)
                if (f.value === 'gif') setResolution(480)
                else if (resolution < 480) setResolution(1080)
              }}
              className={cx('rounded-lg border px-3 py-2 text-left', format === f.value ? 'border-blue-400 bg-blue-500/10' : 'border-white/10 hover:bg-white/5')}
            >
              <p className="text-xs font-semibold text-white">{f.label}</p>
              <p className="text-[10px] text-zinc-500">{f.hint}</p>
            </button>
          ))}
        </div>

        {(isVideo || format === 'gif' || format === 'png') && (
          <Row label="Resolution">
            <Segmented value={resolution} options={format === 'gif' ? GIF_SIZES : RESOLUTIONS} onChange={setResolution} size="xs" />
            <span className="text-[10px] text-zinc-500">{size}</span>
          </Row>
        )}
        {(isVideo || format === 'gif') && (
          <Row label="Frame rate">
            <Segmented value={fps} options={(format === 'gif' ? [10, 12, 15] : [24, 25, 30, 50, 60]).map((v) => ({ value: v, label: `${v}` }))} onChange={setFps} size="xs" />
          </Row>
        )}
        {isVideo && (
          <>
            <Row label="Quality">
              <Segmented
                value={quality}
                size="xs"
                options={[
                  { value: 'low', label: 'Lower' },
                  { value: 'medium', label: 'Good' },
                  { value: 'high', label: 'Recommended' },
                  { value: 'very_high', label: 'Higher' },
                ]}
                onChange={setQuality}
              />
            </Row>
            <Row label="Codec">
              <Select
                value={codec}
                options={[
                  { value: 'auto', label: 'Automatic (best compatible)' },
                  { value: 'avc', label: `H.264${encoders && !encoders.avc ? ' — not available' : ''}` },
                  { value: 'hevc', label: `HEVC / H.265${encoders && !encoders.hevc ? ' — not available' : ''}` },
                  { value: 'vp9', label: `VP9${encoders && !encoders.vp9 ? ' — not available' : ''}` },
                  { value: 'av1', label: `AV1${encoders && !encoders.av1 ? ' — not available' : ''}` },
                ]}
                onChange={setCodec}
              />
            </Row>
            <Row label="Audio">
              <Toggle checked={includeAudio} onChange={setIncludeAudio} />
            </Row>
          </>
        )}
        {format !== 'png' && !isCaptions && (
          <Row label="Range">
            <Segmented
              value={range}
              size="xs"
              options={[
                { value: 'all', label: `Whole timeline (${formatDuration(duration)})` },
                { value: 'selection', label: selRange ? `Selected clips (${formatDuration(selRange.end - selRange.start)})` : 'Selected clips' },
              ]}
              onChange={(v) => (v === 'selection' && !selRange ? undefined : setRange(v))}
            />
          </Row>
        )}

        {progress && (
          <div>
            <div className="mb-1 flex justify-between text-[11px] text-zinc-400">
              <span>{progress.message}</span>
              <span>{Math.round(progress.p * 100)}%</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-white/10">
              <div className="h-full rounded-full bg-blue-500 transition-[width]" style={{ width: `${Math.round(progress.p * 100)}%` }} />
            </div>
          </div>
        )}
        {error && <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{error}</p>}
        {result && (
          <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2">
            <p className="text-xs font-semibold text-emerald-200">Export complete</p>
            <p className="text-[11px] text-zinc-300">
              {result.filename} · {(result.blob.size / 1024 / 1024).toFixed(1)} MB · {result.description} · {result.seconds.toFixed(1)}s
            </p>
            <a href={result.url} download={result.filename} className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-400">
              <Download size={13} /> Save file
            </a>
          </div>
        )}
      </div>
      <div className="flex justify-end gap-2 border-t border-white/[0.06] px-4 py-3">
        {busy ? (
          <Button variant="outline" onClick={() => controller.current?.abort()}>
            Cancel export
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Close
            </Button>
            <Button variant="primary" onClick={() => void run()} disabled={format !== 'png' && !isCaptions && duration <= 0}>
              {busy ? <LoaderCircle size={13} className="animate-spin" /> : <Download size={13} />} Export
            </Button>
          </>
        )}
      </div>
    </Modal>
  )
}

// ── Projects ────────────────────────────────────────────────────────────────

export function ProjectsDialog() {
  const open = useEditor((s) => s.projectsOpen)
  if (!open) return null
  return <ProjectsDialogBody />
}

function ProjectsDialogBody() {
  const currentId = useEditor((s) => s.project.id)
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [ratio, setRatio] = useState('16:9')

  const refresh = async () => {
    const db = await import('../engine/persistence')
    await db.saveProject(store().getState().project)
    setProjects(await db.listProjects())
    setUsage(await db.storageEstimate())
  }
  useEffect(() => {
    void refresh()
  }, [])

  return (
    <Modal title="Projects" onClose={() => store().set({ projectsOpen: false })} width="max-w-2xl">
      <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-3">
        <Select value={ratio} options={CANVAS_RATIOS.map((r) => ({ value: r.id, label: `${r.label} · ${r.hint}` }))} onChange={setRatio} />
        <Button variant="primary" onClick={() => void newProject(ratio)}>
          <Plus size={13} /> New project
        </Button>
        {usage && (
          <span className="ml-auto text-[10px] text-zinc-500">
            Stored on this device: {(usage.usage / 1024 / 1024).toFixed(0)} MB of {(usage.quota / 1024 / 1024 / 1024).toFixed(1)} GB
          </span>
        )}
      </div>
      <div className="ve-scroll max-h-[60vh] overflow-y-auto p-2">
        {!projects ? (
          <p className="p-6 text-center text-xs text-zinc-500">Loading…</p>
        ) : (
          projects.map((p) => (
            <div key={p.id} className={cx('flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-white/5', p.id === currentId && 'bg-blue-500/10')}>
              <button type="button" className="flex min-w-0 flex-1 items-center gap-3 text-left" onClick={() => void openProject(p.id)}>
                <span className="flex h-14 w-24 shrink-0 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black">
                  {p.thumbnail ? <img src={p.thumbnail} alt="" className="h-full w-full object-cover" /> : <Film size={16} className="text-zinc-600" />}
                </span>
                <span className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">
                    {p.name} {p.id === currentId && <span className="text-[10px] text-blue-300">· open</span>}
                  </p>
                  <p className="text-[11px] text-zinc-500">
                    {p.width}×{p.height} · {p.fps} fps · {p.clipCount} clips{p.sceneCount > 1 ? ` · ${p.sceneCount} scenes` : ''} · {formatDuration(p.duration)}
                  </p>
                  <p className="text-[10px] text-zinc-600">
                    Created {new Date(p.createdAt).toLocaleDateString()} · edited {new Date(p.updatedAt).toLocaleString()}
                  </p>
                </span>
              </button>
              <Button title="Duplicate" onClick={() => void duplicateProject(p.id).then(refresh)}>
                <Copy size={13} />
              </Button>
              <Button
                variant="danger"
                title="Delete project"
                onClick={() => {
                  if (confirm(`Delete “${p.name}” and its media from this device? This cannot be undone.`)) void deleteProjectById(p.id).then(refresh)
                }}
              >
                <Trash2 size={13} />
              </Button>
            </div>
          ))
        )}
      </div>
    </Modal>
  )
}

// ── Shortcuts ───────────────────────────────────────────────────────────────

/** Shortcuts list with click-to-rebind (OpenCut customizable keybindings); saved on this device. */
export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  const [bindings, setBindings] = useState<Bindings>(() => loadBindings())
  const [capturing, setCapturing] = useState<string | null>(null)

  useEffect(() => {
    if (!capturing) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      e.stopPropagation()
      if (isModifierOnly(e)) return
      if (e.key === 'Escape') {
        setCapturing(null)
        return
      }
      setBindings({ ...rebind(capturing, comboFromEvent(e)) })
      setCapturing(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [capturing])

  const groups = [...new Set(ACTIONS.map((a) => a.group))]
  return (
    <Modal title="Keyboard shortcuts" onClose={capturing ? () => setCapturing(null) : onClose} width="max-w-2xl">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-2 text-[11px] text-zinc-400">
        <span>{capturing ? 'Press the new key combination… (Esc cancels)' : 'Click a key to change it. A combination used elsewhere moves to the new action.'}</span>
        <Button
          variant="outline"
          onClick={() => {
            setBindings({ ...resetBindings() })
            setCapturing(null)
          }}
        >
          <RotateCcw size={12} /> Reset all
        </Button>
      </div>
      <div className="ve-scroll max-h-[65vh] overflow-y-auto p-4">
        <div className="grid grid-cols-1 gap-x-8 gap-y-4 sm:grid-cols-2">
          {groups.map((g) => (
            <div key={g}>
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-zinc-500">{g}</p>
              <div className="space-y-1">
                {ACTIONS.filter((a) => a.group === g).map((a) => (
                  <div key={a.id} className="flex items-center justify-between gap-3 text-xs">
                    <span className="text-zinc-300">{a.label}</span>
                    <button
                      type="button"
                      onClick={() => setCapturing(a.id)}
                      className={cx('flex flex-wrap justify-end gap-1 rounded px-1 py-0.5 hover:bg-white/10', capturing === a.id && 'ring-1 ring-blue-400')}
                      title="Click to change"
                    >
                      {capturing === a.id ? (
                        <kbd className="rounded border border-blue-400 bg-blue-500/20 px-1.5 py-0.5 font-mono text-[10px] text-white">press keys…</kbd>
                      ) : (bindings[a.id] ?? []).length ? (
                        (bindings[a.id] ?? []).map((k) => (
                          <kbd key={k} className="rounded border border-white/15 bg-black/40 px-1.5 py-0.5 font-mono text-[10px] text-zinc-200">
                            {prettyCombo(k)}
                          </kbd>
                        ))
                      ) : (
                        <kbd className="rounded border border-dashed border-white/15 px-1.5 py-0.5 font-mono text-[10px] text-zinc-500">none</kbd>
                      )}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  )
}

export function BusyOverlay() {
  const busy = useEditor((s) => s.busy)
  if (!busy) return null
  return (
    <div className="fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
      <div className="flex w-full max-w-md items-center gap-3 rounded-xl border border-white/10 bg-[#171a21] px-4 py-3 shadow-2xl">
        <LoaderCircle size={16} className="shrink-0 animate-spin text-blue-400" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs text-zinc-100">{busy.label}</p>
          {busy.progress !== null && (
            <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-white/10">
              <div className="h-full bg-blue-500 transition-[width]" style={{ width: `${Math.round(busy.progress * 100)}%` }} />
            </div>
          )}
        </div>
        {busy.cancel && (
          <Button variant="outline" onClick={busy.cancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  )
}

