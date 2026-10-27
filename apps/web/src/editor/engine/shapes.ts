/**
 * Vector shape geometry shared by the compositor (Path2D) and the panel
 * previews (SVG path data). Shapes are centred on the origin.
 */
import type { ShapeClip, ShapeKind } from '../model/types'

export type ShapeParams = Pick<ShapeClip, 'shape' | 'cornerRadius' | 'sides' | 'points' | 'innerRadius'>

interface Pt {
  x: number
  y: number
}

function polygonPoints(sides: number, rx: number, ry: number): Pt[] {
  const n = Math.max(3, Math.min(24, Math.round(sides)))
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    out.push({ x: Math.cos(a) * rx, y: Math.sin(a) * ry })
  }
  return out
}

function starPoints(points: number, inner: number, rx: number, ry: number): Pt[] {
  const n = Math.max(3, Math.min(24, Math.round(points)))
  const k = Math.min(0.95, Math.max(0.05, inner))
  const out: Pt[] = []
  for (let i = 0; i < n * 2; i++) {
    const a = (i / (n * 2)) * Math.PI * 2 - Math.PI / 2
    const f = i % 2 ? k : 1
    out.push({ x: Math.cos(a) * rx * f, y: Math.sin(a) * ry * f })
  }
  return out
}

/** Vertices of a polygon-like shape, or null for curves. */
export function shapeVertices(shape: ShapeKind, params: ShapeParams, w: number, h: number): Pt[] | null {
  if (shape === 'polygon') return polygonPoints(params.sides, w / 2, h / 2)
  if (shape === 'star') return starPoints(params.points, params.innerRadius, w / 2, h / 2)
  return null
}

/** Draws the outline into `ctx` (no fill / stroke applied). */
export function traceShape(ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D, shape: ShapeKind, params: ShapeParams, w: number, h: number) {
  ctx.beginPath()
  if (shape === 'rectangle') {
    const r = (Math.max(0, Math.min(100, params.cornerRadius)) / 100) * (Math.min(w, h) / 2)
    ctx.roundRect(-w / 2, -h / 2, w, h, r)
    return
  }
  if (shape === 'ellipse') {
    ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
    return
  }
  const pts = shapeVertices(shape, params, w, h) ?? []
  pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
  ctx.closePath()
}

/** SVG path data for a shape fitted in a `size`×`size` box, centred at size/2. */
export function shapeSvgPath(shape: ShapeKind, params: ShapeParams, size: number, aspect = 1): string {
  const w = aspect >= 1 ? size : size * aspect
  const h = aspect >= 1 ? size / aspect : size
  const cx = size / 2
  const cy = size / 2
  if (shape === 'rectangle') {
    const r = (Math.max(0, Math.min(100, params.cornerRadius)) / 100) * (Math.min(w, h) / 2)
    const x = cx - w / 2
    const y = cy - h / 2
    if (r <= 0) return `M${x} ${y}h${w}v${h}h${-w}Z`
    return `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}Z`
  }
  if (shape === 'ellipse') {
    return `M${cx - w / 2} ${cy}a${w / 2} ${h / 2} 0 1 0 ${w} 0a${w / 2} ${h / 2} 0 1 0 ${-w} 0Z`
  }
  const pts = shapeVertices(shape, params, w, h) ?? []
  return `${pts.map((p, i) => `${i ? 'L' : 'M'}${(cx + p.x).toFixed(2)} ${(cy + p.y).toFixed(2)}`).join('')}Z`
}
