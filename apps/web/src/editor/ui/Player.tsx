import { Maximize, Pause, Play, StepBack, StepForward } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { CANVAS_RATIOS, GUIDES } from '../model/defaults'
import { propValue } from '../model/keyframes'
import { clipEnd, getTrack, projectDuration } from '../model/timeline'
import type { Clip, KeyframeProp, Mask, MaskPathPoint, TextClip, VisualClip } from '../model/types'
import {
  PREVIEW_ZOOMS,
  addMaskPoint,
  beginEdit,
  endEdit,
  getEngine,
  previewClipById,
  select,
  setCanvasRatio,
  setGuide,
  setKeyframeable,
  setPreviewPan,
  setPreviewZoom,
  startTextEdit,
  stepFrame,
  stopTextEdit,
  togglePlay,
  updateClipById,
  updateMaskPoint,
} from '../state/actions'
import { useEditor } from '../state/store'
import { cx, formatTimecode } from './controls'

/** Pixels within which a dragged clip snaps to the canvas centre lines. */
const CENTER_SNAP = 8

export function Player() {
  const project = useEditor((s) => s.project)
  const playing = useEditor((s) => s.playing)
  const previewZoom = useEditor((s) => s.previewZoom)
  const pan = useEditor((s) => s.previewPan)
  const guide = useEditor((s) => s.guide)
  const gpu = useEditor((s) => s.gpu)
  const wrapRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [fit, setFit] = useState(0)
  const { width: cw, height: ch } = project.canvas

  // Fit-to-panel scale; the user's zoom overrides it when set.
  useLayoutEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const measure = () => {
      const pad = 16
      const W = Math.max(50, el.clientWidth - pad * 2)
      const H = Math.max(50, el.clientHeight - pad * 2)
      setFit(Math.min(W / cw, H / ch))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [cw, ch])

  const scale = previewZoom || fit
  const size = { w: Math.floor(cw * scale), h: Math.floor(ch * scale) }

  // Backing store at device resolution, never above project resolution.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !size.w) return
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    const k = Math.min(1, (size.w * dpr) / cw)
    canvas.width = Math.max(2, Math.round(cw * k))
    canvas.height = Math.max(2, Math.round(ch * k))
    const engine = getEngine()
    engine.attach(canvas)
    engine.requestRender()
  }, [size.w, size.h, cw, ch])

  useEffect(() => () => getEngine().detach(), [])

  // Ctrl+wheel zooms around the pointer; a plain wheel pans when zoomed in.
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      const state = { zoom: previewZoom || fit, pan }
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const next = Math.min(8, Math.max(0.1, state.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)))
        setPreviewZoom(Math.round(next * 1000) / 1000)
        return
      }
      if (!previewZoom) return
      e.preventDefault()
      setPreviewPan({ x: state.pan.x - e.deltaX, y: state.pan.y - e.deltaY })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [previewZoom, fit, pan])

  // Middle button or Alt+drag pans the zoomed preview.
  const startPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!(e.button === 1 || (e.button === 0 && e.altKey))) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const base = pan
    const move = (ev: PointerEvent) => setPreviewPan({ x: base.x + (ev.clientX - start.x), y: base.y + (ev.clientY - start.y) })
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const fullscreen = () => {
    const el = stageRef.current
    if (!el) return
    if (document.fullscreenElement) void document.exitFullscreen()
    else void el.requestFullscreen()
  }

  const zoomValue = previewZoom ? String(previewZoom) : 'fit'

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0b0d11]">
      {!gpu && (
        <div className="shrink-0 border-b border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-100">
          No WebGL2 in this browser: filters, LUTs, chroma key and effects are skipped in the preview and export. Use Chrome or Edge with hardware acceleration on.
        </div>
      )}
      <div ref={wrapRef} className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden" onPointerDown={startPan}>
        <div
          ref={stageRef}
          className="relative bg-black shadow-2xl ring-1 ring-white/10"
          style={{ width: size.w, height: size.h, transform: previewZoom ? `translate(${pan.x}px, ${pan.y}px)` : undefined }}
        >
          <canvas ref={canvasRef} className="block h-full w-full" />
          <GuideOverlay guide={guide} width={size.w} height={size.h} />
          <TransformOverlay width={size.w} height={size.h} />
        </div>
        {previewZoom > 0 && (
          <span className="pointer-events-none absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-zinc-300">{Math.round(previewZoom * 100)}% · Alt+drag or wheel to pan</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-white/[0.06] px-3 py-1.5">
        <TimeReadout fps={project.fps} duration={projectDuration(project)} />
        <div className="flex flex-1 items-center justify-center gap-1">
          <IconBtn title="Previous frame (←)" onClick={() => stepFrame(-1)}>
            <StepBack size={16} />
          </IconBtn>
          <button
            type="button"
            onClick={togglePlay}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
            aria-label={playing ? 'Pause' : 'Play'}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-black hover:bg-zinc-200"
          >
            {playing ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" className="translate-x-px" />}
          </button>
          <IconBtn title="Next frame (→)" onClick={() => stepFrame(1)}>
            <StepForward size={16} />
          </IconBtn>
        </div>
        <select
          aria-label="Preview zoom"
          value={zoomValue}
          onChange={(e) => setPreviewZoom(e.target.value === 'fit' ? 0 : Number(e.target.value))}
          className="rounded-md border border-white/10 bg-[#1b1f27] px-2 py-1 text-xs text-zinc-100"
          title="Preview zoom (Ctrl+wheel)"
        >
          <option value="fit">Fit{fit ? ` · ${Math.round(fit * 100)}%` : ''}</option>
          {PREVIEW_ZOOMS.map((z) => (
            <option key={z} value={z}>
              {Math.round(z * 100)}%
            </option>
          ))}
          {previewZoom > 0 && !PREVIEW_ZOOMS.includes(previewZoom) && <option value={previewZoom}>{Math.round(previewZoom * 100)}%</option>}
        </select>
        <select aria-label="Layout guide" value={guide} onChange={(e) => setGuide(e.target.value as typeof guide)} className="rounded-md border border-white/10 bg-[#1b1f27] px-2 py-1 text-xs text-zinc-100" title="Safe-zone guides (preview only)">
          {GUIDES.map((g) => (
            <option key={g.id} value={g.id}>
              {g.label}
            </option>
          ))}
        </select>
        <select
          aria-label="Aspect ratio"
          value={project.canvas.ratio}
          onChange={(e) => setCanvasRatio(e.target.value)}
          className="rounded-md border border-white/10 bg-[#1b1f27] px-2 py-1 text-xs text-zinc-100"
        >
          {project.canvas.ratio === 'original' && <option value="original">Original</option>}
          {project.canvas.ratio === 'custom' && <option value="custom">Custom {cw}×{ch}</option>}
          <option value="original" disabled={project.canvas.ratio === 'original'}>
            Original (match first clip)
          </option>
          {CANVAS_RATIOS.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label} · {r.hint}
            </option>
          ))}
        </select>
        <IconBtn title="Full screen" onClick={fullscreen}>
          <Maximize size={15} />
        </IconBtn>
      </div>
    </div>
  )
}

function TimeReadout({ fps, duration }: { fps: number; duration: number }) {
  const playhead = useEditor((s) => s.playhead)
  return (
    <div className="w-44 font-mono text-[11px] tabular-nums">
      <span className="text-blue-300">{formatTimecode(playhead, fps)}</span>
      <span className="text-zinc-500"> / {formatTimecode(duration, fps)}</span>
    </div>
  )
}

function IconBtn({ children, title, onClick }: { children: React.ReactNode; title: string; onClick: () => void }) {
  return (
    <button type="button" title={title} aria-label={title} onClick={onClick} className="flex h-7 w-7 items-center justify-center rounded-md text-zinc-300 hover:bg-white/10 hover:text-white">
      {children}
    </button>
  )
}

// ── Layout guides ───────────────────────────────────────────────────────────

/** Approximate areas each platform's own UI covers, as fractions of the frame. */
const SAFE_ZONES: Record<string, { top: number; bottom: number; right: number; left: number }> = {
  tiktok: { top: 0.12, bottom: 0.26, right: 0.16, left: 0 },
  reels: { top: 0.1, bottom: 0.24, right: 0.14, left: 0 },
  shorts: { top: 0.1, bottom: 0.2, right: 0.13, left: 0 },
  spotlight: { top: 0.12, bottom: 0.22, right: 0.15, left: 0 },
}

function GuideOverlay({ guide, width, height }: { guide: string; width: number; height: number }) {
  if (guide === 'none' || !width) return null
  const stroke = 'rgba(255,255,255,0.35)'
  if (guide === 'grid' || guide === 'thirds') {
    const n = guide === 'grid' ? 6 : 3
    const lines = []
    for (let i = 1; i < n; i++) {
      lines.push(<line key={`v${i}`} x1={(width * i) / n} y1={0} x2={(width * i) / n} y2={height} stroke={stroke} strokeDasharray={guide === 'grid' ? '2 4' : undefined} />)
      lines.push(<line key={`h${i}`} x1={0} y1={(height * i) / n} x2={width} y2={(height * i) / n} stroke={stroke} strokeDasharray={guide === 'grid' ? '2 4' : undefined} />)
    }
    return (
      <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
        {lines}
      </svg>
    )
  }
  const z = SAFE_ZONES[guide]
  if (!z) return null
  const shade = 'rgba(239,68,68,0.22)'
  return (
    <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden>
      <rect x={0} y={0} width={width} height={height * z.top} fill={shade} />
      <rect x={0} y={height * (1 - z.bottom)} width={width} height={height * z.bottom} fill={shade} />
      <rect x={width * (1 - z.right)} y={height * z.top} width={width * z.right} height={height * (1 - z.top - z.bottom)} fill={shade} />
      <rect x={width * z.left} y={height * z.top} width={width * (1 - z.left - z.right)} height={height * (1 - z.top - z.bottom)} fill="none" stroke="rgba(255,255,255,0.6)" strokeDasharray="6 4" />
      <text x={width * 0.03} y={height * z.top + 14} fill="rgba(255,255,255,0.7)" fontSize={11}>
        Safe area · {GUIDES.find((g) => g.id === guide)?.label} UI shaded
      </text>
    </svg>
  )
}

// ── Direct manipulation ─────────────────────────────────────────────────────

interface Box {
  x: number
  y: number
  width: number
  height: number
  rotation: number
}

const visualClip = (c: Clip | undefined): c is VisualClip => !!c && c.type !== 'effect' && c.type !== 'audio'

/** Point-in-rotated-rectangle test, in project pixels relative to the canvas centre. */
function hit(box: Box, px: number, py: number) {
  const l = toLocal(box, px, py)
  return Math.abs(l.x) <= Math.abs(box.width) / 2 && Math.abs(l.y) <= Math.abs(box.height) / 2
}

/** Project-space point → box-local coordinates (un-rotated, origin at the box centre). */
function toLocal(box: Box, px: number, py: number) {
  const a = (-box.rotation * Math.PI) / 180
  const dx = px - box.x
  const dy = py - box.y
  return { x: dx * Math.cos(a) - dy * Math.sin(a), y: dx * Math.sin(a) + dy * Math.cos(a) }
}

type HandleMode = 'move' | 'scale' | 'rotate' | 'stretch-x' | 'stretch-y'

function TransformOverlay({ width, height }: { width: number; height: number }) {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const playhead = useEditor((s) => s.playhead)
  const playing = useEditor((s) => s.playing)
  const maskDrawing = useEditor((s) => s.maskDrawing)
  const editingTextId = useEditor((s) => s.editingTextId)
  const [guides, setGuides] = useState<{ v: boolean; h: boolean }>({ v: false, h: false })
  const f = width / project.canvas.width

  const selected = project.clips.find((c) => c.id === selection[0])
  const active = visualClip(selected) && playhead >= selected.start && playhead < clipEnd(selected) && !getTrack(project, selected.trackId)?.hidden
  const box = active && selected ? (getEngine().bounds(selected.id, playhead) as Box | null) : null
  const drawing = maskDrawing && !!box && selected?.type !== 'text'

  const toProject = (e: { clientX: number; clientY: number }, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return { x: (e.clientX - r.left - r.width / 2) / f, y: (e.clientY - r.top - r.height / 2) / f }
  }

  /** Pen tool: adds a vertex, or selects the topmost visual clip under the pointer. */
  const pick = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.target !== e.currentTarget || e.button !== 0 || e.altKey) return
    const p = toProject(e, e.currentTarget)
    if (drawing && box && selected && (selected.type === 'video' || selected.type === 'image' || selected.type === 'shape')) {
      const l = toLocal(box, p.x, p.y)
      addMaskPoint(selected.id, { x: Math.round((l.x / Math.abs(box.width)) * 1000) / 1000, y: Math.round((l.y / Math.abs(box.height)) * 1000) / 1000 })
      return
    }
    if (editingTextId) stopTextEdit()
    const order = project.tracks.filter((t) => (t.kind === 'video' || t.kind === 'text') && !t.hidden)
    for (const track of order) {
      const clip = project.clips.find((c) => c.trackId === track.id && playhead >= c.start && playhead < clipEnd(c))
      if (!visualClip(clip)) continue
      const b = getEngine().bounds(clip.id, playhead)
      if (b && hit(b, p.x, p.y)) {
        select([clip.id])
        return
      }
    }
    select([])
  }

  const drag = (e: ReactPointerEvent, mode: HandleMode) => {
    if (!selected || !box || !visualClip(selected) || drawing) return
    e.stopPropagation()
    e.preventDefault()
    const stage = (e.currentTarget as HTMLElement).closest('[data-stage]') as HTMLElement
    const start = toProject(e, stage)
    const base = {
      x: box.x,
      y: box.y,
      scale: currentValue(selected, 'scale', playhead),
      scaleX: currentValue(selected, 'scaleX', playhead),
      scaleY: currentValue(selected, 'scaleY', playhead),
      rotation: box.rotation,
    }
    const baseDist = Math.hypot(start.x - box.x, start.y - box.y) || 1
    const baseAngle = Math.atan2(start.y - box.y, start.x - box.x)
    const startLocal = toLocal(box, start.x, start.y)
    beginEdit()

    const onMove = (ev: PointerEvent) => {
      const p = toProject(ev, stage)
      if (mode === 'move') {
        let x = base.x + (p.x - start.x)
        let y = base.y + (p.y - start.y)
        const snapV = Math.abs(x) < CENTER_SNAP / f
        const snapH = Math.abs(y) < CENTER_SNAP / f
        if (snapV) x = 0
        if (snapH) y = 0
        setGuides({ v: snapV, h: snapH })
        setKeyframeable(selected.id, 'x', Math.round(x), true)
        setKeyframeable(selected.id, 'y', Math.round(y), true)
      } else if (mode === 'scale') {
        const d = Math.hypot(p.x - box.x, p.y - box.y)
        setKeyframeable(selected.id, 'scale', Math.max(0.05, Math.round(base.scale * (d / baseDist) * 1000) / 1000), true)
      } else if (mode === 'stretch-x' || mode === 'stretch-y') {
        // Side handles stretch one axis: the ratio of the pointer's local offset to where it started.
        const l = toLocal(box, p.x, p.y)
        const ratio = mode === 'stretch-x' ? Math.abs(l.x) / (Math.abs(startLocal.x) || 1) : Math.abs(l.y) / (Math.abs(startLocal.y) || 1)
        const prop: KeyframeProp = mode === 'stretch-x' ? 'scaleX' : 'scaleY'
        const b = mode === 'stretch-x' ? base.scaleX : base.scaleY
        setKeyframeable(selected.id, prop, Math.max(0.05, Math.round(b * ratio * 1000) / 1000), true)
      } else {
        const angle = Math.atan2(p.y - box.y, p.x - box.x)
        let deg = base.rotation + ((angle - baseAngle) * 180) / Math.PI
        // Snap to 15° steps with Shift.
        if (ev.shiftKey) deg = Math.round(deg / 15) * 15
        setKeyframeable(selected.id, 'rotation', Math.round(deg * 10) / 10, true)
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      setGuides({ v: false, h: false })
      endEdit()
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const bw = box ? Math.abs(box.width) * f : 0
  const bh = box ? Math.abs(box.height) * f : 0
  const editing = !!box && selected?.type === 'text' && editingTextId === selected.id

  return (
    <div data-stage className={cx('absolute inset-0 overflow-hidden', drawing && 'cursor-crosshair')} onPointerDown={pick}>
      {guides.v && <div className="pointer-events-none absolute bottom-0 top-0 w-px bg-pink-400" style={{ left: width / 2 }} />}
      {guides.h && <div className="pointer-events-none absolute left-0 right-0 h-px bg-pink-400" style={{ top: height / 2 }} />}
      {drawing && <p className="pointer-events-none absolute left-2 top-2 rounded bg-black/70 px-2 py-1 text-[11px] text-white">Pen: click to add mask points · Esc to finish</p>}
      {box && selected && !playing && (
        <div
          className={cx('absolute border border-white shadow-[0_0_0_1px_rgba(0,0,0,0.4)]', drawing ? 'pointer-events-none' : 'cursor-move')}
          style={{
            left: width / 2 + box.x * f - bw / 2,
            top: height / 2 + box.y * f - bh / 2,
            width: bw,
            height: bh,
            transform: `rotate(${box.rotation}deg)`,
          }}
          onPointerDown={(e) => !editing && drag(e, 'move')}
          onDoubleClick={(e) => {
            if (selected.type === 'text') {
              e.stopPropagation()
              startTextEdit(selected.id)
            }
          }}
        >
          {(selected.type === 'video' || selected.type === 'image' || selected.type === 'shape') && selected.mask.shape !== 'none' && (
            <MaskHandles clipId={selected.id} mask={selected.mask} bw={bw} bh={bh} drawing={drawing} />
          )}
          {editing && <InlineTextEditor clip={selected as TextClip} f={f} bw={bw} bh={bh} />}
          {!editing && !drawing && (
            <>
              {(['nw', 'ne', 'sw', 'se'] as const).map((corner) => (
                <span
                  key={corner}
                  onPointerDown={(e) => drag(e, 'scale')}
                  className={cx(
                    'absolute h-3 w-3 cursor-nwse-resize rounded-full border border-blue-500 bg-white',
                    corner.includes('n') ? '-top-1.5' : '-bottom-1.5',
                    corner.includes('w') ? '-left-1.5' : '-right-1.5',
                    (corner === 'ne' || corner === 'sw') && 'cursor-nesw-resize',
                  )}
                />
              ))}
              <span onPointerDown={(e) => drag(e, 'stretch-x')} title="Stretch width" className="absolute -right-1 top-1/2 h-4 w-2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-blue-500 bg-white" />
              <span onPointerDown={(e) => drag(e, 'stretch-x')} title="Stretch width" className="absolute -left-1 top-1/2 h-4 w-2 -translate-y-1/2 cursor-ew-resize rounded-sm border border-blue-500 bg-white" />
              <span onPointerDown={(e) => drag(e, 'stretch-y')} title="Stretch height" className="absolute -bottom-1 left-1/2 h-2 w-4 -translate-x-1/2 cursor-ns-resize rounded-sm border border-blue-500 bg-white" />
              <span onPointerDown={(e) => drag(e, 'rotate')} title="Rotate (Shift snaps to 15°)" className="absolute -top-7 left-1/2 h-4 w-4 -translate-x-1/2 cursor-grab rounded-full border border-blue-500 bg-white" />
              <span className="pointer-events-none absolute -top-3 left-1/2 h-3 w-px -translate-x-1/2 bg-white" />
            </>
          )}
        </div>
      )}
    </div>
  )
}

/** Dashed outline of the mask with a centre handle (position) and a corner handle (size); pen points are draggable. */
function MaskHandles({ clipId, mask, bw, bh, drawing }: { clipId: string; mask: Mask; bw: number; bh: number; drawing: boolean }) {
  const cxp = bw / 2 + mask.x * bw
  const cyp = bh / 2 + mask.y * bh
  const mw = Math.max(4, mask.width * bw)
  const mh = Math.max(4, (mask.shape === 'linear' ? 0 : mask.height) * bh)

  const dragMask = (e: ReactPointerEvent, mode: 'pos' | 'size') => {
    e.stopPropagation()
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    const base = { x: mask.x, y: mask.y, w: mask.width, h: mask.height }
    beginEdit()
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / bw
      const dy = (ev.clientY - start.y) / bh
      const patch = mode === 'pos' ? { x: Math.round((base.x + dx) * 1000) / 1000, y: Math.round((base.y + dy) * 1000) / 1000 } : { width: Math.max(0.02, Math.round((base.w + dx * 2) * 1000) / 1000), height: Math.max(0.02, Math.round((base.h + dy * 2) * 1000) / 1000) }
      previewClipById<Exclude<Clip, { type: 'text' } | { type: 'effect' }>>(clipId, (c) => ({ ...c, mask: { ...c.mask, ...patch } }))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endEdit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const dragPoint = (e: ReactPointerEvent, index: number, point: MaskPathPoint) => {
    e.stopPropagation()
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY }
    beginEdit()
    const move = (ev: PointerEvent) => {
      const next = { ...point, x: Math.round((point.x + (ev.clientX - start.x) / bw) * 1000) / 1000, y: Math.round((point.y + (ev.clientY - start.y) / bh) * 1000) / 1000 }
      updateMaskPoint(clipId, index, next, true)
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      endEdit()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (mask.shape === 'freeform') {
    const pts = mask.path ?? []
    return (
      <>
        <svg className="pointer-events-none absolute inset-0 overflow-visible" width={bw} height={bh} aria-hidden>
          {pts.length > 1 && <polygon points={pts.map((p) => `${bw / 2 + p.x * bw},${bh / 2 + p.y * bh}`).join(' ')} fill="rgba(59,130,246,0.12)" stroke="#60a5fa" strokeDasharray="4 3" />}
        </svg>
        {pts.map((p, i) => (
          <span
            key={i}
            onPointerDown={(e) => dragPoint(e, i, p)}
            className={cx('absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-white bg-blue-500', drawing && 'pointer-events-auto')}
            style={{ left: bw / 2 + p.x * bw, top: bh / 2 + p.y * bh, cursor: 'grab' }}
            title={`Point ${i + 1}`}
          />
        ))}
      </>
    )
  }

  const outlineClass = mask.shape === 'circle' ? 'rounded-full' : mask.shape === 'rectangle' ? 'rounded-sm' : mask.shape === 'diamond' ? 'rotate-45' : ''
  return (
    <>
      <div
        className={cx('pointer-events-none absolute border border-dashed border-blue-300/90', outlineClass)}
        style={{
          left: cxp - mw / 2,
          top: mask.shape === 'linear' ? cyp : cyp - mh / 2,
          width: mw,
          height: mask.shape === 'linear' ? 0 : mh,
          transform: `rotate(${mask.rotation}deg)`,
        }}
      />
      <span onPointerDown={(e) => dragMask(e, 'pos')} title="Move mask" className="absolute h-3.5 w-3.5 -translate-x-1/2 -translate-y-1/2 cursor-move rounded-full border-2 border-white bg-blue-500" style={{ left: cxp, top: cyp }} />
      {mask.shape !== 'linear' && (
        <span onPointerDown={(e) => dragMask(e, 'size')} title="Resize mask" className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 cursor-nwse-resize rounded-sm border border-white bg-blue-400" style={{ left: cxp + mw / 2, top: cyp + mh / 2 }} />
      )}
    </>
  )
}

/** Textarea laid over the text clip's box so typing edits the clip in place (OpenCut inline text editing). */
function InlineTextEditor({ clip, f, bw, bh }: { clip: TextClip; f: number; bw: number; bh: number }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.focus()
    el.select()
  }, [])
  const s = clip.style
  const scale = currentValue(clip, 'scale', 0)
  return (
    <textarea
      ref={ref}
      value={clip.text}
      onChange={(e) => updateClipById<TextClip>(clip.id, (c) => ({ ...c, text: e.target.value, name: e.target.value.slice(0, 40) || c.name, words: null }))}
      onBlur={stopTextEdit}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) stopTextEdit()
      }}
      onPointerDown={(e) => e.stopPropagation()}
      spellCheck={false}
      className="absolute inset-0 resize-none overflow-hidden bg-blue-500/10 p-0 text-white outline-none ring-2 ring-blue-400"
      style={{
        width: bw,
        height: bh,
        fontFamily: `'${s.fontFamily}', sans-serif`,
        fontSize: Math.max(8, s.fontSize * f * scale),
        fontWeight: s.bold ? 700 : 400,
        fontStyle: s.italic ? 'italic' : 'normal',
        textAlign: s.align,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing * f * scale,
        color: s.color,
      }}
    />
  )
}

function currentValue(clip: VisualClip, prop: KeyframeProp, t: number): number {
  const key = prop as Exclude<KeyframeProp, 'opacity' | 'volume'>
  const base = prop === 'opacity' ? clip.opacity : prop === 'volume' ? 1 : (clip.transform[key] ?? 1)
  return propValue(clip, prop, t - clip.start, base)
}
