import {
  ArrowLeftRight,
  ArrowLeftToLine,
  ArrowRightToLine,
  AudioLines,
  Bookmark,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Clapperboard,
  ClipboardPaste,
  Copy,
  CopyPlus,
  Diamond,
  Eye,
  EyeOff,
  FlipHorizontal2,
  Link2,
  Lock,
  LockOpen,
  Magnet,
  Music,
  Pencil,
  Plus,
  Redo2,
  Rewind,
  RotateCw,
  ScanLine,
  Scissors,
  Shapes,
  Snowflake,
  Sparkles,
  Trash2,
  Type,
  Undo2,
  Unlink,
  Video,
  Volume2,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react'
import { MARKER_COLORS } from '../model/defaults'
import { keyframeTimes } from '../model/keyframes'
import { sceneList } from '../model/scenes'
import { clipEnd, getTrack, isMediaClip, moveClip, moveClips, projectDuration, snapPoints, snapTime, trimClip } from '../model/timeline'
import type { Clip, KeyframeProp, Marker, MediaClip, Project, Track } from '../model/types'
import {
  addAssetToTimeline,
  addEffect,
  addFlagSticker,
  addMarker,
  addNewScene,
  addShape,
  addSticker,
  addText,
  addTransition,
  beginEdit,
  copyKeyframes,
  copySelection,
  clearKeyframes,
  deleteSceneById,
  deleteSelected,
  duplicateSceneById,
  duplicateSelected,
  endEdit,
  extractAudio,
  flipSelected,
  freezeFrame,
  hasCopiedKeyframes,
  importFiles,
  moveKeyframeTime,
  moveSceneBy,
  paste,
  pasteKeyframes,
  previewClipById,
  reattachAudio,
  removeMarker,
  renameSceneById,
  reverseSelected,
  rotateSelected,
  seek,
  select,
  setTrackFlag,
  splitAtPlayhead,
  splitByScene,
  startTextEdit,
  switchSceneTo,
  toggleExpandedKeyframes,
  toggleSelect,
  trimSelectedToPlayhead,
  updateMarker,
} from '../state/actions'
import { getEditorStore, useEditor } from '../state/store'
import { WAVEFORM_RATE } from '../engine/media'
import { ContextMenu, type MenuItem, type MenuState } from './ContextMenu'
import { cx, formatDuration, formatTimecode } from './controls'

const HEADER_W = 168
const RULER_H = 28
const SNAP_PX = 8
const LANE_H = 18

const baseTrackHeight = (t: Track) => (t.isMain ? 68 : t.kind === 'video' ? 56 : t.kind === 'audio' ? 50 : t.kind === 'text' ? 34 : 30)

const PROP_SHORT: Record<KeyframeProp, string> = { x: 'X', y: 'Y', scale: 'Scale', scaleX: 'W', scaleY: 'H', rotation: 'Rot', opacity: 'Opacity', volume: 'Vol' }

/** Animated properties shown as lanes for the expanded clips on a track. */
function lanesFor(track: Track, project: Project, expanded: string[]) {
  const out: Array<{ clip: Clip; prop: KeyframeProp }> = []
  for (const clip of project.clips) {
    if (clip.trackId !== track.id || !expanded.includes(clip.id)) continue
    for (const prop of Object.keys(clip.keyframes) as KeyframeProp[]) if (clip.keyframes[prop]?.length) out.push({ clip, prop })
  }
  return out
}

const store = () => getEditorStore()

/** Major tick spacing (s) so labels are at least ~90 px apart. */
function tickStep(zoom: number) {
  const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600]
  return steps.find((s) => s * zoom >= 90) ?? 600
}

function rulerLabel(t: number, step: number) {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  if (step < 1) return `${String(m).padStart(2, '0')}:${s.toFixed(step < 0.1 ? 2 : 1).padStart(step < 0.1 ? 5 : 4, '0')}`
  return `${String(m).padStart(2, '0')}:${String(Math.round(s)).padStart(2, '0')}`
}

// ── Drag payloads from the left panel ───────────────────────────────────────

export const DRAG_TYPES = {
  asset: 'application/x-ve-asset',
  text: 'application/x-ve-text',
  sticker: 'application/x-ve-sticker',
  shape: 'application/x-ve-shape',
  flag: 'application/x-ve-flag',
  effect: 'application/x-ve-effect',
  transition: 'application/x-ve-transition',
} as const

export function Timeline() {
  const project = useEditor((s) => s.project)
  const zoom = useEditor((s) => s.zoom)
  const magnet = useEditor((s) => s.magnet)
  const snapping = useEditor((s) => s.snapping)
  const ripple = useEditor((s) => s.ripple)
  const canUndo = useEditor((s) => s.canUndo)
  const canRedo = useEditor((s) => s.canRedo)
  const hasSelection = useEditor((s) => s.selection.length > 0)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [viewWidth, setViewWidth] = useState(800)

  const duration = projectDuration(project)
  const contentSeconds = Math.max(duration + 20, viewWidth / zoom)
  const contentWidth = contentSeconds * zoom

  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setViewWidth(el.clientWidth - HEADER_W))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Ctrl/⌘ + wheel zooms around the pointer, like CapCut.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const x = e.clientX - rect.left - HEADER_W + el.scrollLeft
      const t = x / store().getState().zoom
      const next = Math.min(600, Math.max(4, store().getState().zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      store().set({ zoom: next })
      requestAnimationFrame(() => {
        el.scrollLeft = t * next - (e.clientX - rect.left - HEADER_W)
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  // Keep the playhead in view while playing.
  useEffect(() => {
    return store().subscribe(() => {
      const { playing, playhead, zoom: z } = store().getState()
      const el = scrollRef.current
      if (!playing || !el) return
      const x = playhead * z
      const visible = el.clientWidth - HEADER_W
      if (x > el.scrollLeft + visible - 60 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 80)
    })
  }, [])

  const setZoom = (z: number) => store().set({ zoom: Math.min(600, Math.max(4, z)) })
  const fit = () => setZoom(Math.max(4, (viewWidth - 40) / Math.max(5, duration)))

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#111318]">
      <div className="flex shrink-0 items-center gap-0.5 border-b border-white/[0.06] px-2 py-1">
        <ScenesMenu project={project} />
        <Divider />
        <ToolButton title="Undo (Ctrl+Z)" onClick={() => store().undo()} disabled={!canUndo}>
          <Undo2 size={15} />
        </ToolButton>
        <ToolButton title="Redo (Ctrl+Shift+Z)" onClick={() => store().redo()} disabled={!canRedo}>
          <Redo2 size={15} />
        </ToolButton>
        <Divider />
        <ToolButton title="Split (Ctrl+B)" onClick={splitAtPlayhead}>
          <Scissors size={15} />
        </ToolButton>
        <ToolButton title="Delete left of playhead (Q)" onClick={() => trimSelectedToPlayhead('left')}>
          <ArrowLeftToLine size={15} />
        </ToolButton>
        <ToolButton title="Delete right of playhead (W)" onClick={() => trimSelectedToPlayhead('right')}>
          <ArrowRightToLine size={15} />
        </ToolButton>
        <ToolButton title="Delete (Del)" onClick={deleteSelected} disabled={!hasSelection}>
          <Trash2 size={15} />
        </ToolButton>
        <ToolButton title="Duplicate (Ctrl+D)" onClick={duplicateSelected} disabled={!hasSelection}>
          <CopyPlus size={15} />
        </ToolButton>
        <Divider />
        <ToolButton title="Freeze frame (Shift+F)" onClick={() => void freezeFrame()}>
          <Snowflake size={15} />
        </ToolButton>
        <ToolButton title="Reverse" onClick={() => void reverseSelected()}>
          <Rewind size={15} />
        </ToolButton>
        <ToolButton title="Mirror" onClick={() => flipSelected('h')} disabled={!hasSelection}>
          <FlipHorizontal2 size={15} />
        </ToolButton>
        <ToolButton title="Rotate 90°" onClick={() => rotateSelected(90)} disabled={!hasSelection}>
          <RotateCw size={15} />
        </ToolButton>
        <ToolButton title="Detach audio" onClick={extractAudio} disabled={!hasSelection}>
          <AudioLines size={15} />
        </ToolButton>
        <ToolButton title="Split by scene" onClick={() => void splitByScene()}>
          <ScanLine size={15} />
        </ToolButton>
        <ToolButton title="Add marker (M)" onClick={() => addMarker()}>
          <Bookmark size={15} />
        </ToolButton>
        <div className="flex-1" />
        <ToolButton title={`Ripple editing: ${ripple ? 'on' : 'off'} (R) — deletes and trims close the gap on every track`} active={ripple} onClick={() => store().set({ ripple: !ripple })}>
          <ArrowLeftRight size={15} />
        </ToolButton>
        <ToolButton title={`Main track magnet: ${magnet ? 'on' : 'off'}`} active={magnet} onClick={() => store().set({ magnet: !magnet })}>
          <Magnet size={15} />
        </ToolButton>
        <ToolButton title={`Auto snapping: ${snapping ? 'on' : 'off'} (N) — hold Shift while dragging to skip it`} active={snapping} onClick={() => store().set({ snapping: !snapping })}>
          <span className="text-[10px] font-bold">SNAP</span>
        </ToolButton>
        <Divider />
        <ToolButton title="Zoom out (Ctrl+-)" onClick={() => setZoom(zoom / 1.4)}>
          <ZoomOut size={15} />
        </ToolButton>
        <input
          aria-label="Timeline zoom"
          type="range"
          min={Math.log(4)}
          max={Math.log(600)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => setZoom(Math.exp(Number(e.target.value)))}
          className="ve-range w-28"
        />
        <ToolButton title="Zoom in (Ctrl+=)" onClick={() => setZoom(zoom * 1.4)}>
          <ZoomIn size={15} />
        </ToolButton>
        <button type="button" onClick={fit} className="rounded px-2 py-1 text-[11px] text-zinc-300 hover:bg-white/10" title="Fit timeline to window (Shift+Z)">
          Fit
        </button>
      </div>

      <div ref={scrollRef} className="ve-scroll relative min-h-0 flex-1 overflow-auto">
        <div className="relative" style={{ width: contentWidth + HEADER_W }}>
          <Ruler project={project} zoom={zoom} width={contentWidth} />
          <TrackList project={project} zoom={zoom} width={contentWidth} scrollRef={scrollRef} />
          <Playhead zoom={zoom} />
        </div>
      </div>
    </div>
  )
}

function ToolButton({ children, title, onClick, disabled, active }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; active?: boolean }) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'flex h-7 min-w-7 items-center justify-center rounded-md px-1.5 transition-colors disabled:opacity-30',
        active ? 'bg-blue-500/20 text-blue-300' : 'text-zinc-300 hover:bg-white/10 hover:text-white',
      )}
    >
      {children}
    </button>
  )
}

const Divider = () => <span className="mx-1 h-4 w-px bg-white/10" />

// ── Scenes ──────────────────────────────────────────────────────────────────

function ScenesMenu({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<string | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const scenes = sceneList(project)
  const current = project.scene

  useEffect(() => {
    if (!open) return
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', down, true)
    return () => window.removeEventListener('pointerdown', down, true)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs text-zinc-200 hover:bg-white/10"
        title="Scenes: separate timelines inside this project"
      >
        <Clapperboard size={14} className="text-blue-300" />
        <span className="max-w-32 truncate font-medium">{current?.name ?? 'Scene 1'}</span>
        {scenes.length > 1 && <span className="text-[10px] text-zinc-500">{scenes.findIndex((s) => s.id === current?.id) + 1}/{scenes.length}</span>}
        <ChevronDown size={12} className="text-zinc-400" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 w-72 rounded-lg border border-white/10 bg-[#1b1f27] p-1 shadow-2xl" onKeyDown={(e) => e.stopPropagation()}>
          {scenes.map((s, i) => (
            <div key={s.id} className={cx('group flex items-center gap-1 rounded-md px-1.5 py-1', s.id === current?.id ? 'bg-blue-500/15' : 'hover:bg-white/5')}>
              {renaming === s.id ? (
                <input
                  autoFocus
                  defaultValue={s.name}
                  onBlur={(e) => {
                    renameSceneById(s.id, e.target.value)
                    setRenaming(null)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                    if (e.key === 'Escape') setRenaming(null)
                  }}
                  className="min-w-0 flex-1 rounded border border-white/10 bg-black/30 px-1 text-xs text-white outline-none"
                />
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    switchSceneTo(s.id)
                    setOpen(false)
                  }}
                  onDoubleClick={() => setRenaming(s.id)}
                  className="flex min-w-0 flex-1 items-center gap-1.5 text-left text-xs text-zinc-100"
                  title="Open scene · double-click to rename"
                >
                  {s.id === current?.id ? <Check size={12} className="shrink-0 text-blue-300" /> : <span className="w-3 shrink-0 text-center text-[10px] text-zinc-500">{i + 1}</span>}
                  <span className="truncate">{s.name}</span>
                </button>
              )}
              <span className="flex shrink-0 items-center opacity-0 group-hover:opacity-100">
                <MiniBtn title="Rename" onClick={() => setRenaming(s.id)}>
                  <Pencil size={11} />
                </MiniBtn>
                <MiniBtn title="Duplicate scene" onClick={() => duplicateSceneById(s.id)}>
                  <Copy size={11} />
                </MiniBtn>
                <MiniBtn title="Move left" onClick={() => moveSceneBy(s.id, -1)} disabled={i === 0}>
                  <ChevronLeft size={11} />
                </MiniBtn>
                <MiniBtn title="Move right" onClick={() => moveSceneBy(s.id, 1)} disabled={i === scenes.length - 1}>
                  <ChevronRight size={11} />
                </MiniBtn>
                <MiniBtn
                  title="Delete scene"
                  danger
                  disabled={scenes.length <= 1}
                  onClick={() => {
                    if (confirm(`Delete scene “${s.name}” and everything on its timeline?`)) deleteSceneById(s.id)
                  }}
                >
                  <Trash2 size={11} />
                </MiniBtn>
              </span>
            </div>
          ))}
          <button type="button" onClick={addNewScene} className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-xs text-zinc-200 hover:bg-white/10">
            <Plus size={12} /> New scene
          </button>
          <p className="px-1.5 pb-1 pt-0.5 text-[10px] leading-4 text-zinc-500">Each scene is its own timeline; export renders the open scene.</p>
        </div>
      )}
    </div>
  )
}

function MiniBtn({ children, title, onClick, disabled, danger }: { children: React.ReactNode; title: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" title={title} aria-label={title} disabled={disabled} onClick={onClick} className={cx('rounded p-1 disabled:opacity-30', danger ? 'text-red-300 hover:bg-red-500/15' : 'text-zinc-400 hover:bg-white/10 hover:text-white')}>
      {children}
    </button>
  )
}

// ── Ruler ───────────────────────────────────────────────────────────────────

function Ruler({ project, zoom, width }: { project: Project; zoom: number; width: number }) {
  const step = tickStep(zoom)
  const [editing, setEditing] = useState<{ marker: Marker; x: number; y: number } | null>(null)
  const ticks = useMemo(() => {
    const out: number[] = []
    for (let t = 0; t * zoom <= width; t += step) out.push(t)
    return out
  }, [step, zoom, width])

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = e.currentTarget
    const rect = el.getBoundingClientRect()
    const at = (clientX: number) => seek((clientX - rect.left) / zoom)
    at(e.clientX)
    el.setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent) => at(ev.clientX)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  /** Dragging a marker moves it; a plain click jumps to it. */
  const dragMarker = (e: ReactPointerEvent, m: Marker) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const startX = e.clientX
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      updateMarker(m.id, { t: Math.max(0, m.t + dx / zoom) })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (!moved) seek(m.t)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const live = editing ? project.markers.find((m) => m.id === editing.marker.id) : undefined

  return (
    <div className="sticky top-0 z-20 flex" style={{ height: RULER_H }}>
      <div className="sticky left-0 z-30 shrink-0 border-b border-r border-white/[0.06] bg-[#111318]" style={{ width: HEADER_W }} />
      <div className="relative cursor-text border-b border-white/[0.06] bg-[#14171d]" style={{ width }} onPointerDown={scrub}>
        {ticks.map((t) => (
          <div key={t} className="absolute top-0 h-full" style={{ left: t * zoom }}>
            <div className="h-2.5 w-px bg-zinc-500" />
            <span className="absolute left-1 top-2 select-none whitespace-nowrap font-mono text-[10px] text-zinc-500">{rulerLabel(t, step)}</span>
            {[0.25, 0.5, 0.75].map((f) => (
              <div key={f} className="absolute top-0 h-1.5 w-px bg-zinc-700" style={{ left: step * zoom * f }} />
            ))}
          </div>
        ))}
        {project.markers.map((m) => (
          <div key={m.id}>
            {(m.duration ?? 0) > 0 && <div className="pointer-events-none absolute bottom-0 h-1.5 rounded-sm opacity-70" style={{ left: m.t * zoom, width: (m.duration ?? 0) * zoom, background: m.color }} />}
            <button
              type="button"
              title={`${m.label || 'Marker'}${m.note ? ` — ${m.note}` : ''} · drag to move, double-click to edit`}
              onPointerDown={(e) => dragMarker(e, m)}
              onDoubleClick={(e) => setEditing({ marker: m, x: e.clientX, y: e.clientY })}
              onContextMenu={(e) => {
                e.preventDefault()
                setEditing({ marker: m, x: e.clientX, y: e.clientY })
              }}
              className="absolute bottom-0 z-10 flex -translate-x-1/2 flex-col items-center"
              style={{ left: m.t * zoom }}
            >
              {m.label && <span className="mb-px max-w-24 truncate rounded px-1 text-[9px] text-white" style={{ background: m.color }}>{m.label}</span>}
              <span className="block h-3 w-2.5" style={{ background: m.color, clipPath: 'polygon(0 0,100% 0,100% 70%,50% 100%,0 70%)' }} />
            </button>
          </div>
        ))}
      </div>
      {editing && live && <MarkerPopover marker={live} x={editing.x} y={editing.y} fps={project.fps} onClose={() => setEditing(null)} />}
    </div>
  )
}

function MarkerPopover({ marker: m, x, y, fps, onClose }: { marker: Marker; x: number; y: number; fps: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
    }
  }, [onClose])
  return (
    <div
      ref={ref}
      className="fixed z-[70] w-64 rounded-lg border border-white/10 bg-[#1b1f27] p-3 text-xs shadow-2xl"
      style={{ left: Math.min(x, window.innerWidth - 272), top: Math.min(y + 8, window.innerHeight - 240) }}
      onKeyDown={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <div className="mb-2 flex items-center gap-1.5">
        {MARKER_COLORS.map((c) => (
          <button key={c} type="button" onClick={() => updateMarker(m.id, { color: c })} className={cx('h-4 w-4 rounded-full border-2', m.color === c ? 'border-white' : 'border-transparent')} style={{ background: c }} title="Colour" />
        ))}
        <span className="ml-auto font-mono text-[10px] text-zinc-400">{formatTimecode(m.t, fps)}</span>
      </div>
      <input
        autoFocus
        value={m.label}
        placeholder="Label"
        onChange={(e) => updateMarker(m.id, { label: e.target.value })}
        className="mb-2 w-full rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
      />
      <textarea
        value={m.note ?? ''}
        placeholder="Note…"
        rows={2}
        onChange={(e) => updateMarker(m.id, { note: e.target.value })}
        className="mb-2 w-full resize-none rounded-md border border-white/10 bg-black/30 px-2 py-1 text-xs text-white outline-none focus:border-blue-500"
      />
      <label className="mb-2 flex items-center gap-2 text-zinc-300">
        Duration
        <input
          type="number"
          min={0}
          step={0.1}
          value={m.duration ?? 0}
          onChange={(e) => updateMarker(m.id, { duration: Math.max(0, Number(e.target.value) || 0) })}
          className="w-20 rounded-md border border-white/10 bg-black/30 px-2 py-1 text-right text-xs text-white outline-none focus:border-blue-500"
        />
        s
      </label>
      <div className="flex justify-between">
        <button
          type="button"
          onClick={() => {
            removeMarker(m.id)
            onClose()
          }}
          className="rounded px-2 py-1 text-red-300 hover:bg-red-500/15"
        >
          Delete
        </button>
        <button type="button" onClick={onClose} className="rounded bg-blue-500 px-2 py-1 text-white hover:bg-blue-400">
          Done
        </button>
      </div>
    </div>
  )
}

function Playhead({ zoom }: { zoom: number }) {
  const playhead = useEditor((s) => s.playhead)
  return (
    <div className="pointer-events-none absolute bottom-0 top-0 z-30" style={{ left: HEADER_W + playhead * zoom }}>
      <div className="absolute -left-[5px] top-0 h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent border-t-white" />
      <div className="absolute left-0 top-0 h-full w-px bg-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)]" />
    </div>
  )
}

// ── Tracks ──────────────────────────────────────────────────────────────────

interface Marquee {
  x0: number
  y0: number
  x1: number
  y1: number
}

function TrackList({ project, zoom, width, scrollRef }: { project: Project; zoom: number; width: number; scrollRef: React.RefObject<HTMLDivElement | null> }) {
  const rowsRef = useRef<HTMLDivElement>(null)
  const expanded = useEditor((s) => s.expandedKeyframes)
  const [dropHint, setDropHint] = useState<{ trackId: string | null; t: number } | null>(null)
  const [marquee, setMarquee] = useState<Marquee | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)

  const tracksByY = () => {
    const rows = rowsRef.current?.querySelectorAll<HTMLElement>('[data-track-id]') ?? []
    return [...rows].map((r) => ({ id: r.dataset.trackId!, rect: r.getBoundingClientRect() }))
  }

  const timeAt = (clientX: number) => {
    const el = scrollRef.current
    if (!el) return 0
    const rect = el.getBoundingClientRect()
    return Math.max(0, (clientX - rect.left - HEADER_W + el.scrollLeft) / zoom)
  }

  const trackAt = (clientY: number) => tracksByY().find((r) => clientY >= r.rect.top && clientY < r.rect.bottom)?.id ?? null

  const onDragOver = (e: DragEvent) => {
    const types = e.dataTransfer.types
    if (!types.includes('Files') && !Object.values(DRAG_TYPES).some((t) => types.includes(t))) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDropHint({ trackId: trackAt(e.clientY), t: timeAt(e.clientX) })
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDropHint(null)
    const t = timeAt(e.clientX)
    const trackId = trackAt(e.clientY) ?? undefined
    const dt = e.dataTransfer
    store().set({ playhead: t })
    if (dt.files.length) {
      void importFiles([...dt.files], { at: t, trackId })
      return
    }
    const asset = dt.getData(DRAG_TYPES.asset)
    if (asset) return void addAssetToTimeline(asset, t, trackId)
    const sticker = dt.getData(DRAG_TYPES.sticker)
    if (sticker) return addSticker(sticker)
    const shape = dt.getData(DRAG_TYPES.shape)
    if (shape) return addShape(shape)
    const flag = dt.getData(DRAG_TYPES.flag)
    if (flag) {
      const [code, ...name] = flag.split('|')
      return void addFlagSticker(code, name.join('|'))
    }
    const text = dt.getData(DRAG_TYPES.text)
    if (text) return addText(JSON.parse(text))
    const effect = dt.getData(DRAG_TYPES.effect)
    if (effect) return addEffect(effect as never)
    const transition = dt.getData(DRAG_TYPES.transition)
    if (transition) return addTransition(transition as never)
  }

  /**
   * Empty-lane press: a click deselects and moves the playhead; a drag draws a
   * box that selects every clip it touches (Shift/Ctrl adds to the selection).
   */
  const startMarquee = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const container = rowsRef.current
    if (!container) return
    const origin = container.getBoundingClientRect()
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    const baseSelection = additive ? store().getState().selection : []
    const start = { x: e.clientX - origin.left, y: e.clientY - origin.top }
    let moved = false
    const move = (ev: PointerEvent) => {
      const cur = { x: ev.clientX - origin.left, y: ev.clientY - origin.top }
      if (!moved && Math.hypot(cur.x - start.x, cur.y - start.y) < 4) return
      moved = true
      setMarquee({ x0: start.x, y0: start.y, x1: cur.x, y1: cur.y })
      const left = Math.min(start.x, cur.x)
      const right = Math.max(start.x, cur.x)
      const top = Math.min(start.y, cur.y) + origin.top
      const bottom = Math.max(start.y, cur.y) + origin.top
      const t0 = (left - HEADER_W) / zoom
      const t1 = (right - HEADER_W) / zoom
      const rows = tracksByY().filter((r) => r.rect.bottom > top && r.rect.top < bottom).map((r) => r.id)
      const hits = store()
        .getState()
        .project.clips.filter((c) => rows.includes(c.trackId) && clipEnd(c) > t0 && c.start < t1)
        .map((c) => c.id)
      store().set({ selection: [...new Set([...baseSelection, ...hits])] })
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setMarquee(null)
      if (!moved) {
        if (!additive) store().set({ selection: [] })
        seek(timeAt(e.clientX))
      }
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const openMenu = (e: React.MouseEvent, clip: Clip) => {
    e.preventDefault()
    e.stopPropagation()
    const s = store().getState()
    if (!s.selection.includes(clip.id)) select([clip.id])
    setMenu({ x: e.clientX, y: e.clientY, items: clipMenuItems(clip, s.expandedKeyframes.includes(clip.id)) })
  }

  return (
    <div
      ref={rowsRef}
      className="relative pb-24"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setDropHint(null)
      }}
      onDrop={onDrop}
    >
      {project.tracks.map((track) => (
        <TrackRow
          key={track.id}
          track={track}
          project={project}
          zoom={zoom}
          width={width}
          highlighted={dropHint?.trackId === track.id}
          lanes={lanesFor(track, project, expanded)}
          tracksByY={tracksByY}
          onLanePointerDown={startMarquee}
          onClipMenu={openMenu}
        />
      ))}
      {project.clips.length === 0 && (
        <div className="pointer-events-none absolute left-0 right-0 top-2 flex justify-center" style={{ paddingLeft: HEADER_W }}>
          <div className="rounded-lg border border-dashed border-white/15 px-6 py-5 text-center text-xs text-zinc-500">
            Drag media here, or click <span className="text-zinc-300">+</span> on any item in the Media panel
          </div>
        </div>
      )}
      {dropHint && <div className="pointer-events-none absolute bottom-0 top-0 z-20 w-0.5 bg-blue-400" style={{ left: HEADER_W + dropHint.t * zoom }} />}
      {marquee && (
        <div
          className="pointer-events-none absolute z-20 border border-blue-400 bg-blue-500/15"
          style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
        />
      )}
      {menu && <ContextMenu menu={menu} onClose={() => setMenu(null)} />}
    </div>
  )
}

function clipMenuItems(clip: Clip, lanesShown: boolean): MenuItem[] {
  const media = isMediaClip(clip) ? clip : null
  const hasKeys = clip.type !== 'effect' && Object.values(clip.keyframes).some((l) => l?.length)
  const items: MenuItem[] = [
    { label: 'Split at playhead', shortcut: 'Ctrl+B', icon: <Scissors size={13} />, onSelect: splitAtPlayhead },
    { label: 'Duplicate', shortcut: 'Ctrl+D', icon: <CopyPlus size={13} />, onSelect: duplicateSelected },
    { label: 'Copy', shortcut: 'Ctrl+C', icon: <Copy size={13} />, onSelect: copySelection },
    { label: 'Paste at playhead', shortcut: 'Ctrl+V', icon: <ClipboardPaste size={13} />, onSelect: paste },
  ]
  if (clip.type === 'text') items.push({ label: 'Edit text on canvas', shortcut: 'Enter', icon: <Pencil size={13} />, onSelect: () => startTextEdit(clip.id), separator: true })
  if (media?.type === 'video') {
    items.push({ label: 'Detach audio', icon: <Unlink size={13} />, onSelect: extractAudio, separator: true })
    items.push({ label: 'Freeze frame', shortcut: 'Shift+F', icon: <Snowflake size={13} />, onSelect: () => void freezeFrame() })
    items.push({ label: 'Reverse', icon: <Rewind size={13} />, onSelect: () => void reverseSelected() })
  }
  if (media?.type === 'audio' && media.detachedFrom) items.push({ label: 'Reattach to video', icon: <Link2 size={13} />, onSelect: () => reattachAudio(clip.id), separator: true })
  if (clip.type !== 'effect') {
    items.push({ label: lanesShown ? 'Hide keyframe lanes' : 'Show keyframe lanes', icon: <Diamond size={13} />, onSelect: () => toggleExpandedKeyframes(clip.id), separator: true, disabled: !hasKeys && !lanesShown })
    items.push({ label: 'Copy keyframes', icon: <Copy size={13} />, onSelect: () => copyKeyframes(clip.id), disabled: !hasKeys })
    items.push({ label: 'Paste keyframes', icon: <ClipboardPaste size={13} />, onSelect: () => pasteKeyframes(), disabled: !hasCopiedKeyframes() })
    items.push({ label: 'Clear keyframes', icon: <Diamond size={13} />, onSelect: () => clearKeyframes(clip.id), disabled: !hasKeys })
  }
  items.push({ label: 'Delete', shortcut: 'Del', icon: <Trash2 size={13} />, onSelect: deleteSelected, danger: true, separator: true })
  return items
}

const TrackRow = memo(function TrackRow({
  track,
  project,
  zoom,
  width,
  highlighted,
  lanes,
  tracksByY,
  onLanePointerDown,
  onClipMenu,
}: {
  track: Track
  project: Project
  zoom: number
  width: number
  highlighted: boolean
  lanes: Array<{ clip: Clip; prop: KeyframeProp }>
  tracksByY: () => Array<{ id: string; rect: DOMRect }>
  onLanePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void
  onClipMenu: (e: React.MouseEvent, clip: Clip) => void
}) {
  const clips = project.clips.filter((c) => c.trackId === track.id)
  const clipIds = clips.map((c) => c.id)
  const hasSelected = useEditor((s) => s.selection.some((id) => clipIds.includes(id)))
  const baseH = baseTrackHeight(track)
  const h = baseH + lanes.length * LANE_H
  const Icon = track.kind === 'audio' ? Music : track.kind === 'text' ? Type : track.kind === 'effect' ? Sparkles : clips.some((c) => c.type === 'shape') && clips.every((c) => c.type === 'shape') ? Shapes : Video

  return (
    <div className="flex" data-track-id={track.id} style={{ height: h }}>
      <div className={cx('sticky left-0 z-10 flex shrink-0 flex-col border-b border-r border-white/[0.06] px-2', hasSelected ? 'bg-[#1b2130]' : 'bg-[#15181e]')} style={{ width: HEADER_W }}>
        <div className="flex items-center gap-1" style={{ height: baseH }}>
          <Icon size={13} className={cx('shrink-0', track.isMain ? 'text-blue-400' : hasSelected ? 'text-blue-300' : 'text-zinc-500')} />
          <span className="min-w-0 flex-1 truncate text-[11px] text-zinc-300" title={track.name}>
            {track.name}
          </span>
          {track.kind !== 'audio' && (
            <IconToggle title={track.hidden ? 'Show track' : 'Hide track'} on={track.hidden} onClick={() => setTrackFlag(track.id, 'hidden')}>
              {track.hidden ? <EyeOff size={12} /> : <Eye size={12} />}
            </IconToggle>
          )}
          {(track.kind === 'audio' || track.kind === 'video') && (
            <IconToggle title={track.muted ? 'Unmute track' : 'Mute track'} on={track.muted} onClick={() => setTrackFlag(track.id, 'muted')}>
              {track.muted ? <VolumeX size={12} /> : <Volume2 size={12} />}
            </IconToggle>
          )}
          <IconToggle title={track.locked ? 'Unlock track' : 'Lock track'} on={track.locked} onClick={() => setTrackFlag(track.id, 'locked')}>
            {track.locked ? <Lock size={12} /> : <LockOpen size={12} />}
          </IconToggle>
        </div>
        {lanes.map((l) => (
          <div key={`${l.clip.id}-${l.prop}`} className="flex items-center gap-1 truncate pl-4 text-[10px] text-zinc-400" style={{ height: LANE_H }} title={`${l.clip.name} · ${PROP_SHORT[l.prop]}`}>
            <Diamond size={9} className="shrink-0 text-blue-400" />
            <span className="truncate">{PROP_SHORT[l.prop]}</span>
          </div>
        ))}
      </div>
      <div
        className={cx(
          'relative border-b border-white/[0.04]',
          track.isMain ? 'bg-[#1a1d24]' : 'bg-[#15181e]',
          hasSelected && 'bg-white/[0.02]',
          highlighted && 'bg-blue-500/10',
          track.locked && 'opacity-60',
        )}
        style={{ width }}
        onPointerDown={(e) => {
          if (e.target !== e.currentTarget) return
          onLanePointerDown(e)
        }}
      >
        {clips.map((clip) => (
          <ClipView key={clip.id} clip={clip} track={track} zoom={zoom} height={baseH} tracksByY={tracksByY} onMenu={onClipMenu} />
        ))}
        {lanes.map((l, i) => (
          <KeyframeLane key={`${l.clip.id}-${l.prop}`} clip={l.clip} prop={l.prop} zoom={zoom} top={baseH + i * LANE_H} />
        ))}
      </div>
    </div>
  )
})

/** One row of draggable diamonds for a single animated property (OpenCut expanded keyframes). */
function KeyframeLane({ clip, prop, zoom, top }: { clip: Clip; prop: KeyframeProp; zoom: number; top: number }) {
  if (clip.type === 'effect') return null
  const list = clip.keyframes[prop] ?? []
  const drag = (e: ReactPointerEvent, t: number) => {
    e.stopPropagation()
    if (e.button !== 0) return
    const startX = e.clientX
    let moved = false
    let current = t
    beginEdit()
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 3) return
      moved = true
      const next = Math.min(clip.duration, Math.max(0, Math.round((t + dx / zoom) * 1000) / 1000))
      if (next !== current) {
        moveKeyframeTime(clip.id, prop, current, next, true)
        current = next
      }
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endEdit()
      if (!moved) seek(clip.start + t)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div className="absolute left-0 right-0 border-t border-white/[0.04]" style={{ top, height: LANE_H }}>
      <div className="absolute top-1/2 h-px bg-blue-400/40" style={{ left: clip.start * zoom, width: clip.duration * zoom }} />
      {list.map((k) => (
        <button
          key={k.t}
          type="button"
          title={`${PROP_SHORT[prop]} keyframe at ${k.t.toFixed(2)}s — drag to retime, click to jump`}
          onPointerDown={(e) => drag(e, k.t)}
          className="absolute top-1/2 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-white bg-blue-400 hover:bg-white"
          style={{ left: (clip.start + k.t) * zoom }}
        />
      ))}
    </div>
  )
}

function IconToggle({ children, title, on, onClick }: { children: React.ReactNode; title: string; on: boolean; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className={cx('rounded p-1 hover:bg-white/10', on ? 'text-amber-300' : 'text-zinc-500')}>
      {children}
    </button>
  )
}

// ── Clips ───────────────────────────────────────────────────────────────────

type DragMode = 'move' | 'trim-start' | 'trim-end'

const ClipView = memo(function ClipView({
  clip,
  track,
  zoom,
  height,
  tracksByY,
  onMenu,
}: {
  clip: Clip
  track: Track
  zoom: number
  height: number
  tracksByY: () => Array<{ id: string; rect: DOMRect }>
  onMenu: (e: React.MouseEvent, clip: Clip) => void
}) {
  const selected = useEditor((s) => s.selection.includes(clip.id))
  const left = clip.start * zoom
  const w = Math.max(2, clip.duration * zoom)

  const startDrag = (e: ReactPointerEvent<HTMLDivElement>, mode: DragMode) => {
    if (e.button !== 0) return
    e.stopPropagation()
    if (track.locked) return
    const additive = e.shiftKey || e.ctrlKey || e.metaKey
    if (!selected || additive) toggleSelect(clip.id, additive)
    if (additive) return

    const s = store()
    const base = s.getState().project
    const assets = s.getState().assets
    const group = mode === 'move' && selected && s.getState().selection.length > 1 ? s.getState().selection : [clip.id]
    const startX = e.clientX
    const startY = e.clientY
    let moved = false
    const points = snapPoints(base, group, [s.getState().playhead])
    s.beginGesture()

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && mode === 'move' && Math.abs(dx) < 3 && Math.abs(ev.clientY - startY) < 3) return
      moved = true
      const { snapping, magnet, ripple } = s.getState()
      // Shift while dragging skips snapping (OpenCut); the toolbar toggle is the default.
      const threshold = snapping && !ev.shiftKey ? SNAP_PX / zoom : 0
      if (mode === 'move') {
        let start = Math.max(0, clip.start + dx / zoom)
        if (threshold) {
          const a = snapTime(start, points, threshold)
          const b = snapTime(start + clip.duration, points, threshold)
          if (a.snappedTo !== null && (b.snappedTo === null || Math.abs(a.t - start) <= Math.abs(b.t - (start + clip.duration)))) start = a.t
          else if (b.snappedTo !== null) start = b.t - clip.duration
        }
        if (group.length > 1) {
          // Group move keeps every clip on its own track; the earliest clip stops at 0.
          const earliest = Math.min(...base.clips.filter((c) => group.includes(c.id)).map((c) => c.start))
          const delta = Math.max(-earliest, start - clip.start)
          s.preview(() => moveClips(base, group, delta, { magnet }))
          return
        }
        const hovered = tracksByY().find((r) => ev.clientY >= r.rect.top && ev.clientY < r.rect.bottom)
        const hoveredTrack = hovered ? getTrack(base, hovered.id) : undefined
        const trackId = hoveredTrack && hoveredTrack.kind === track.kind ? hoveredTrack.id : clip.trackId
        s.preview(() => moveClip(base, clip.id, start, trackId, { magnet }))
      } else {
        const edgeT = mode === 'trim-start' ? clip.start + dx / zoom : clipEnd(clip) + dx / zoom
        const snapped = threshold ? snapTime(edgeT, points, threshold).t : edgeT
        s.preview(() => trimClip(base, clip.id, mode === 'trim-start' ? 'start' : 'end', snapped, assets, { magnet, ripple }))
      }
    }
    // Listen on window: dragging to another track re-renders the clip under a
    // different row, which unmounts the element the drag started on.
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      s.endGesture()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  const media = isMediaClip(clip) ? clip : null
  const tone =
    clip.type === 'audio'
      ? 'bg-emerald-900/70 border-emerald-500/40'
      : clip.type === 'text'
        ? clip.isCaption
          ? 'bg-amber-900/70 border-amber-500/40'
          : 'bg-fuchsia-900/60 border-fuchsia-500/40'
        : clip.type === 'effect'
          ? 'bg-violet-900/70 border-violet-500/40'
          : clip.type === 'shape'
            ? 'bg-teal-900/70 border-teal-500/40'
            : 'bg-sky-950 border-sky-500/30'

  const badges: string[] = []
  if (media) {
    if (media.speed !== 1) badges.push(`${Number(media.speed.toFixed(2))}x`)
    if (media.filter) badges.push('FX')
    if (media.mask.shape !== 'none') badges.push('Mask')
    if (media.chroma.enabled) badges.push('Key')
    if (media.removeBackground) badges.push('Cutout')
    if (media.muted && media.type !== 'image') badges.push('Muted')
    if (media.voiceEffect !== 'none') badges.push('Voice')
    if (media.detachedFrom) badges.push('Detached')
  }
  if (clip.type === 'shape' && clip.mask.shape !== 'none') badges.push('Mask')

  return (
    <div
      className={cx('group absolute top-[3px] overflow-hidden rounded-md border text-white', tone, selected ? 'z-10 ring-2 ring-white' : 'hover:brightness-110')}
      style={{ left, width: w, height: height - 6 }}
      onPointerDown={(e) => startDrag(e, 'move')}
      onContextMenu={(e) => onMenu(e, clip)}
      onDoubleClick={(e) => {
        e.stopPropagation()
        if (clip.type === 'text') {
          seek(Math.max(clip.start, Math.min(clipEnd(clip) - 0.01, store().getState().playhead)))
          startTextEdit(clip.id)
        } else seek(clip.start)
      }}
      title={`${clip.name} · ${formatDuration(clip.duration)}`}
    >
      {media && media.type !== 'audio' && <Filmstrip clip={media} zoom={zoom} height={height - 6} />}
      {clip.type === 'shape' && <div className="pointer-events-none absolute inset-y-0 left-0 w-full opacity-30" style={{ background: clip.fill }} />}
      {media && (media.type === 'audio' || (media.type === 'video' && !media.muted)) && (
        <Waveform clip={media} zoom={zoom} width={w} height={media.type === 'audio' ? height - 20 : 16} overlay={media.type === 'video'} />
      )}
      {media && <FadeOverlay clip={media} zoom={zoom} />}
      {media?.type === 'audio' && !track.locked && <VolumeLine clip={media} height={height - 6} />}
      {media?.beats.map((b, i) => (
        <span key={i} className="pointer-events-none absolute bottom-0.5 h-1.5 w-1.5 -translate-x-1/2 rounded-full bg-yellow-300" style={{ left: b * zoom }} />
      ))}

      <div className="pointer-events-none relative flex items-center gap-1 px-1.5 pt-0.5">
        <span className="truncate text-[10px] font-medium drop-shadow">
          {clip.type === 'text' ? clip.text.replace(/\n/g, ' ') : clip.name}
        </span>
        {badges.map((b) => (
          <span key={b} className="shrink-0 rounded bg-black/50 px-1 text-[9px] font-semibold text-zinc-200">
            {b}
          </span>
        ))}
      </div>

      {keyframeTimes(clip.keyframes).map((t) => (
        <span key={t} className="pointer-events-none absolute bottom-1 h-2 w-2 -translate-x-1/2 rotate-45 border border-white bg-blue-400" style={{ left: t * zoom }} />
      ))}

      {media?.transitionOut && (
        <span
          className="absolute right-0 top-1/2 z-10 flex h-5 w-5 -translate-y-1/2 translate-x-1/2 items-center justify-center rounded-sm border border-white/60 bg-blue-500 text-[9px] font-bold"
          title={`Transition: ${media.transitionOut.name} (${media.transitionOut.duration.toFixed(1)}s)`}
        >
          ⇄
        </span>
      )}

      {!track.locked && (
        <>
          <div className="absolute inset-y-0 left-0 z-20 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40 group-hover:bg-white/20" onPointerDown={(e) => startDrag(e, 'trim-start')} />
          <div className="absolute inset-y-0 right-0 z-20 w-2 cursor-ew-resize bg-white/0 hover:bg-white/40 group-hover:bg-white/20" onPointerDown={(e) => startDrag(e, 'trim-end')} />
        </>
      )}
    </div>
  )
})

/** Thumbnails tiled across the clip, each showing the source frame at that point. */
function Filmstrip({ clip, zoom, height }: { clip: MediaClip; zoom: number; height: number }) {
  const thumbs = useEditor((s) => s.thumbnails[clip.assetId])
  const asset = useEditor((s) => s.assets[clip.assetId])
  if (!thumbs?.urls.length || !asset) return null
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const tileW = Math.max(24, height * aspect)
  const width = clip.duration * zoom
  const count = Math.min(240, Math.ceil(width / tileW))
  const tiles = []
  for (let i = 0; i < count; i++) {
    const x = i * tileW
    const src = clip.type === 'image' ? 0 : clip.sourceIn + (x / zoom) * clip.speed
    const idx = thumbs.interval > 0 ? Math.min(thumbs.urls.length - 1, Math.floor(src / thumbs.interval)) : 0
    tiles.push(<img key={i} src={thumbs.urls[idx]} alt="" draggable={false} className="absolute top-0 h-full object-cover opacity-80" style={{ left: x, width: tileW }} />)
  }
  return <div className="pointer-events-none absolute inset-0">{tiles}</div>
}

/** Peaks drawn as bars; stretches past full scale turn red (OpenCut clipping tips). */
function Waveform({ clip, zoom, width, height, overlay }: { clip: MediaClip; zoom: number; width: number; height: number; overlay: boolean }) {
  const peaks = useEditor((s) => s.waveforms[clip.assetId])
  const ref = useRef<HTMLCanvasElement>(null)
  const [clipping, setClipping] = useState(false)
  const pxWidth = Math.min(Math.ceil(width), 8192)

  useEffect(() => {
    const c = ref.current
    if (!c || !peaks) return
    c.width = pxWidth
    c.height = Math.max(4, height)
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, c.width, c.height)
    const normal = overlay ? 'rgba(110,231,183,0.75)' : 'rgba(110,231,183,0.9)'
    const scale = width / pxWidth
    const mid = c.height / 2
    let clipped = 0
    const g = clip.muted ? 0 : clip.volume
    for (let x = 0; x < pxWidth; x++) {
      const tl = (x * scale) / zoom
      const src = clip.sourceIn + tl * clip.speed
      const i = Math.floor(src * WAVEFORM_RATE)
      const v = (peaks[i] ?? 0) * g
      if (v > 1) clipped++
      ctx.fillStyle = v > 1 ? 'rgba(248,113,113,0.95)' : normal
      const hh = Math.max(0.5, Math.min(1, v) * mid)
      ctx.fillRect(x, mid - hh, 1, hh * 2)
    }
    setClipping(clipped > 0)
  }, [peaks, pxWidth, height, zoom, width, clip.sourceIn, clip.speed, clip.volume, clip.muted, overlay])

  if (!peaks) return null
  return (
    <>
      <canvas ref={ref} className={cx('pointer-events-none absolute left-0', overlay ? 'bottom-0' : 'bottom-1')} style={{ width, height }} />
      {clipping && (
        <span className="pointer-events-auto absolute right-1 top-0.5 z-10 rounded bg-red-500/80 px-1 text-[9px] font-semibold text-white" title="Audio louder than full scale will distort — lower the volume or normalize loudness">
          CLIP
        </span>
      )}
    </>
  )
}

/** Horizontal gain line on audio clips; drag it up or down to change the clip volume (OpenCut volume line). */
function VolumeLine({ clip, height }: { clip: MediaClip; height: number }) {
  // 0..2 (−∞..+6 dB) maps bottom..top.
  const yFor = (v: number) => height - 6 - Math.min(1, Math.max(0, v / 2)) * (height - 12)
  const drag = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.stopPropagation()
    e.preventDefault()
    if (e.button !== 0) return
    const startY = e.clientY
    const base = clip.volume
    beginEdit()
    const move = (ev: PointerEvent) => {
      const v = Math.min(2, Math.max(0, base - ((ev.clientY - startY) / (height - 12)) * 2))
      previewClipById<MediaClip>(clip.id, (c) => ({ ...c, volume: Math.round(v * 100) / 100 }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endEdit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  const db = clip.volume <= 0 ? '-∞' : `${(20 * Math.log10(clip.volume)).toFixed(1)}`
  return (
    <div
      className="absolute left-0 right-0 z-20 h-2 -translate-y-1/2 cursor-ns-resize"
      style={{ top: yFor(clip.volume) }}
      onPointerDown={drag}
      title={`Volume ${db} dB — drag up or down`}
    >
      <div className="absolute inset-x-0 top-1/2 h-px bg-yellow-300/80" />
    </div>
  )
}

/** Shades fade-in / fade-out regions so audio fades are visible on the clip. */
function FadeOverlay({ clip, zoom }: { clip: MediaClip; zoom: number }) {
  if (!clip.fadeIn && !clip.fadeOut) return null
  return (
    <>
      {clip.fadeIn > 0 && <div className="pointer-events-none absolute inset-y-0 left-0 bg-gradient-to-r from-black/60 to-transparent" style={{ width: clip.fadeIn * zoom }} />}
      {clip.fadeOut > 0 && <div className="pointer-events-none absolute inset-y-0 right-0 bg-gradient-to-l from-black/60 to-transparent" style={{ width: clip.fadeOut * zoom }} />}
    </>
  )
}
