import { EASINGS, propValue } from './keyframes'
import type { AnimationName, Clip, ClipAnimation, MediaClip, ShapeClip, TextClip } from './types'

/** Offsets an in/out/loop animation contributes on top of a clip's own transform. */
export interface AnimState {
  dx: number
  dy: number
  scale: number
  rotation: number
  opacity: number
  /** Gaussian blur radius, project pixels. */
  blur: number
  /** Typewriter reveal, 0..1 of characters shown. */
  reveal: number
}

const identity = (): AnimState => ({ dx: 0, dy: 0, scale: 1, rotation: 0, opacity: 1, blur: 0, reveal: 1 })

/** easeOutBack: overshoots then settles, for bounce/pop. */
const easeOutBack = (x: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (x - 1) ** 3 + c1 * (x - 1) ** 2
}

/**
 * Applies one entrance animation at progress `p` (0 = start, 1 = settled).
 * Exit animations reuse this with p running from 1 down to 0.
 */
function applyPhase(s: AnimState, name: AnimationName, p: number, w: number, h: number) {
  const e = EASINGS.easeOut(p)
  switch (name) {
    case 'fade':
      s.opacity *= p
      break
    case 'zoomIn':
      s.scale *= 0.5 + 0.5 * e
      s.opacity *= Math.min(1, p * 2)
      break
    case 'zoomOut':
      s.scale *= 1.5 - 0.5 * e
      s.opacity *= Math.min(1, p * 2)
      break
    case 'slideLeft':
      s.dx += (1 - e) * w * 0.4
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideRight':
      s.dx -= (1 - e) * w * 0.4
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideUp':
      s.dy += (1 - e) * h * 0.4
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'slideDown':
      s.dy -= (1 - e) * h * 0.4
      s.opacity *= Math.min(1, p * 1.5)
      break
    case 'rotate':
      s.rotation += (1 - e) * -180
      s.scale *= 0.3 + 0.7 * e
      s.opacity *= p
      break
    case 'bounce':
      s.scale *= Math.max(0, easeOutBack(p))
      break
    case 'blur':
      s.blur += (1 - e) * 30
      s.opacity *= p
      break
    case 'pop':
      s.scale *= p < 0.7 ? (p / 0.7) * 1.15 : 1.15 - ((p - 0.7) / 0.3) * 0.15
      s.opacity *= Math.min(1, p * 3)
      break
    case 'typewriter':
      s.reveal = Math.min(s.reveal, p)
      break
    case 'none':
      break
  }
}

/** Animation offsets at clip-local time `local` for a clip lasting `duration`. */
export function animationStateAt(anim: ClipAnimation, local: number, duration: number, w: number, h: number): AnimState {
  const s = identity()
  const inDur = anim.in.name === 'none' ? 0 : Math.min(anim.in.duration, duration)
  const outDur = anim.out.name === 'none' ? 0 : Math.min(anim.out.duration, duration - inDur)

  if (inDur > 0 && local < inDur) applyPhase(s, anim.in.name, Math.max(0, local / inDur), w, h)
  if (outDur > 0 && local > duration - outDur) applyPhase(s, anim.out.name, Math.max(0, (duration - local) / outDur), w, h)

  const period = Math.max(0.2, anim.loop.period)
  const phase = (local / period) * Math.PI * 2
  switch (anim.loop.name) {
    case 'pulse':
      s.scale *= 1 + 0.06 * Math.sin(phase)
      break
    case 'wiggle':
      s.rotation += 5 * Math.sin(phase)
      break
    case 'float':
      s.dy += 0.015 * h * Math.sin(phase)
      break
    case 'spin':
      s.rotation += (local / period) * 360
      break
    case 'none':
      break
  }
  return s
}

/** The transform + opacity a visual clip renders with at timeline time `t`, keyframes and animation included. */
export function resolveVisual(clip: MediaClip | TextClip | ShapeClip, t: number, canvasW: number, canvasH: number) {
  const local = t - clip.start
  const base = clip.transform
  const anim = animationStateAt(clip.animation, local, clip.duration, canvasW, canvasH)
  return {
    x: propValue(clip, 'x', local, base.x) + anim.dx,
    y: propValue(clip, 'y', local, base.y) + anim.dy,
    scale: propValue(clip, 'scale', local, base.scale) * anim.scale,
    scaleX: propValue(clip, 'scaleX', local, base.scaleX ?? 1),
    scaleY: propValue(clip, 'scaleY', local, base.scaleY ?? 1),
    rotation: propValue(clip, 'rotation', local, base.rotation) + anim.rotation,
    opacity: Math.max(0, Math.min(1, propValue(clip, 'opacity', local, clip.opacity) * anim.opacity)),
    flipH: base.flipH,
    flipV: base.flipV,
    blur: anim.blur,
    reveal: anim.reveal,
  }
}

/** Linear gain of an audio-bearing clip at timeline time `t`: volume keyframes × fades × mute. */
export function gainAt(clip: MediaClip, t: number): number {
  if (clip.muted) return 0
  const local = t - clip.start
  let g = propValue(clip, 'volume', local, clip.volume)
  if (clip.fadeIn > 0 && local < clip.fadeIn) g *= Math.max(0, local / clip.fadeIn)
  const remaining = clip.duration - local
  if (clip.fadeOut > 0 && remaining < clip.fadeOut) g *= Math.max(0, remaining / clip.fadeOut)
  return Math.max(0, g)
}

/** True when the clip's opacity, transform or volume depends on time, so it must be re-evaluated every frame. */
export function isAnimated(clip: Clip) {
  if (Object.keys(clip.keyframes).length) return true
  if (clip.type === 'effect') return false
  const a = clip.animation
  return a.in.name !== 'none' || a.out.name !== 'none' || a.loop.name !== 'none'
}
