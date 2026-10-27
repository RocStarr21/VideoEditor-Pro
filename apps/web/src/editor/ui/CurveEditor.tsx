import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { EASING_PRESETS } from '../model/defaults'
import { EASING_AS_BEZIER, cubicBezier } from '../model/keyframes'
import type { CubicBezier, Keyframe } from '../model/types'
import { cx } from './controls'

const SIZE = 180
const PAD = 24

/** The control points a keyframe's easing shows as; presets map to equivalent curves. */
export const toBezier = (ease: Keyframe['ease']): CubicBezier => (typeof ease === 'string' ? EASING_AS_BEZIER[ease] : ease)

const matchesPreset = (curve: CubicBezier) => EASING_PRESETS.find((p) => p.value.every((v, i) => Math.abs(v - curve[i]) < 0.02))?.id ?? null

/**
 * Graph editor for one keyframe segment (OpenCut "Graph editor"): drag the two
 * bezier handles, or pick a preset. `onChange` fires live; `onCommit` once per
 * drag so undo gets one step.
 */
export function CurveEditor({ value, onChange, onCommit }: { value: Keyframe['ease']; onChange: (ease: CubicBezier) => void; onCommit: (ease: CubicBezier) => void }) {
  const [curve, setCurve] = useState<CubicBezier>(() => toBezier(value))
  const svgRef = useRef<SVGSVGElement>(null)
  useEffect(() => setCurve(toBezier(value)), [value])

  // y grows downward in SVG; curve space has y up and may overshoot 0..1.
  const toSvg = (x: number, y: number) => ({ x: PAD + x * (SIZE - PAD * 2), y: PAD + (1 - y) * (SIZE - PAD * 2) })
  const fromSvg = (px: number, py: number) => ({ x: Math.min(1, Math.max(0, (px - PAD) / (SIZE - PAD * 2))), y: Math.min(1.6, Math.max(-0.6, 1 - (py - PAD) / (SIZE - PAD * 2))) })

  const drag = (e: ReactPointerEvent, handle: 0 | 1) => {
    e.preventDefault()
    const svg = svgRef.current
    if (!svg) return
    svg.setPointerCapture(e.pointerId)
    let latest = curve
    const move = (ev: PointerEvent) => {
      const r = svg.getBoundingClientRect()
      const p = fromSvg(((ev.clientX - r.left) / r.width) * SIZE, ((ev.clientY - r.top) / r.height) * SIZE)
      latest = (handle === 0 ? [p.x, p.y, curve[2], curve[3]] : [curve[0], curve[1], p.x, p.y]).map((v) => Math.round(v * 1000) / 1000) as CubicBezier
      setCurve(latest)
      onChange(latest)
    }
    const up = () => {
      svg.removeEventListener('pointermove', move)
      svg.removeEventListener('pointerup', up)
      onCommit(latest)
    }
    svg.addEventListener('pointermove', move)
    svg.addEventListener('pointerup', up)
  }

  const fn = cubicBezier(curve)
  const samples = Array.from({ length: 41 }, (_, i) => i / 40).map((x) => toSvg(x, fn(x)))
  const path = samples.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const p0 = toSvg(0, 0)
  const p3 = toSvg(1, 1)
  const h1 = toSvg(curve[0], curve[1])
  const h2 = toSvg(curve[2], curve[3])
  const active = matchesPreset(curve)

  return (
    <div className="space-y-2">
      <svg ref={svgRef} viewBox={`0 0 ${SIZE} ${SIZE}`} className="h-44 w-full touch-none select-none rounded-md border border-white/10 bg-black/30" aria-label="Easing curve editor">
        {[0.25, 0.5, 0.75].map((g) => (
          <g key={g}>
            <line x1={toSvg(g, 0).x} y1={PAD} x2={toSvg(g, 0).x} y2={SIZE - PAD} stroke="rgba(255,255,255,0.06)" />
            <line x1={PAD} y1={toSvg(0, g).y} x2={SIZE - PAD} y2={toSvg(0, g).y} stroke="rgba(255,255,255,0.06)" />
          </g>
        ))}
        <rect x={PAD} y={PAD} width={SIZE - PAD * 2} height={SIZE - PAD * 2} fill="none" stroke="rgba(255,255,255,0.15)" />
        <line x1={p0.x} y1={p0.y} x2={h1.x} y2={h1.y} stroke="#60a5fa" strokeWidth={1.5} />
        <line x1={p3.x} y1={p3.y} x2={h2.x} y2={h2.y} stroke="#f472b6" strokeWidth={1.5} />
        <path d={path} fill="none" stroke="#fff" strokeWidth={2} />
        <circle cx={p0.x} cy={p0.y} r={3} fill="#fff" />
        <circle cx={p3.x} cy={p3.y} r={3} fill="#fff" />
        <circle cx={h1.x} cy={h1.y} r={6} fill="#60a5fa" className="cursor-grab" onPointerDown={(e) => drag(e, 0)} />
        <circle cx={h2.x} cy={h2.y} r={6} fill="#f472b6" className="cursor-grab" onPointerDown={(e) => drag(e, 1)} />
      </svg>
      <div className="flex flex-wrap gap-1">
        {EASING_PRESETS.map((p) => (
          <button
            key={p.id}
            type="button"
            onClick={() => {
              setCurve(p.value)
              onCommit(p.value)
            }}
            className={cx('rounded-md border px-2 py-0.5 text-[11px]', active === p.id ? 'border-blue-400 bg-blue-500/15 text-white' : 'border-white/10 text-zinc-300 hover:bg-white/5')}
          >
            {p.label}
          </button>
        ))}
      </div>
      <p className="font-mono text-[10px] text-zinc-500">cubic-bezier({curve.map((v) => v.toFixed(2)).join(', ')})</p>
    </div>
  )
}
