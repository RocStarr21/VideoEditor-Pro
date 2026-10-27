import type { Clip, CubicBezier, EasingName, Keyframe, KeyframeProp, Keyframes } from './types'

/** Keyframes closer than this are treated as the same keyframe (one frame at 60 fps). */
export const KEYFRAME_TOLERANCE = 1 / 60

export const EASINGS: Record<EasingName, (x: number) => number> = {
  linear: (x) => x,
  easeIn: (x) => x * x * x,
  easeOut: (x) => 1 - (1 - x) ** 3,
  easeInOut: (x) => (x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2),
}

const bezierCache = new Map<string, (x: number) => number>()

/**
 * CSS cubic-bezier(x1, y1, x2, y2) as a function of progress. The curve is
 * parametric, so the parameter for a given x is found by Newton iteration
 * with a bisection fallback; results are memoised per control-point set.
 */
export function cubicBezier(curve: CubicBezier): (x: number) => number {
  const key = curve.join(',')
  const cached = bezierCache.get(key)
  if (cached) return cached
  const [x1, y1, x2, y2] = curve
  const ax = 1 - 3 * x2 + 3 * x1
  const bx = 3 * x2 - 6 * x1
  const cx = 3 * x1
  const ay = 1 - 3 * y2 + 3 * y1
  const by = 3 * y2 - 6 * y1
  const cy = 3 * y1
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t
  const slopeX = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const solve = (x: number) => {
    let t = x
    for (let i = 0; i < 8; i++) {
      const dx = sampleX(t) - x
      if (Math.abs(dx) < 1e-6) return t
      const d = slopeX(t)
      if (Math.abs(d) < 1e-6) break
      t -= dx / d
    }
    let lo = 0
    let hi = 1
    t = x
    while (hi - lo > 1e-6) {
      t = (lo + hi) / 2
      if (sampleX(t) < x) lo = t
      else hi = t
    }
    return t
  }
  const fn = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : sampleY(solve(x)))
  bezierCache.set(key, fn)
  return fn
}

/** Progress curve for a keyframe's easing, preset or custom. */
export const easingFn = (ease: Keyframe['ease']) => (typeof ease === 'string' ? EASINGS[ease] : cubicBezier(ease))

/** Named presets as control points, so the graph editor can show them. */
export const EASING_AS_BEZIER: Record<EasingName, CubicBezier> = {
  linear: [0, 0, 1, 1],
  easeIn: [0.32, 0, 0.67, 0],
  easeOut: [0.33, 1, 0.68, 1],
  easeInOut: [0.65, 0, 0.35, 1],
}

/**
 * Value of a keyframed property at clip-local time `t`.
 * Holds the first/last value outside the keyed range; the easing stored on the
 * left keyframe shapes the segment that follows it.
 */
export function valueAt(kfs: Keyframe[] | undefined, t: number, base: number): number {
  if (!kfs || kfs.length === 0) return base
  if (t <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.v

  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const p = span <= 0 ? 1 : easingFn(a.ease)((t - a.t) / span)
      return a.v + (b.v - a.v) * p
    }
  }
  return last.v
}

export function propValue(clip: Clip, prop: KeyframeProp, local: number, base: number) {
  return valueAt(clip.keyframes[prop], local, base)
}

export function keyframeIndexNear(kfs: Keyframe[] | undefined, t: number, tol = KEYFRAME_TOLERANCE) {
  return kfs ? kfs.findIndex((k) => Math.abs(k.t - t) <= tol) : -1
}

export function withKeyframe(keyframes: Keyframes, prop: KeyframeProp, t: number, v: number, ease: Keyframe['ease'] = 'linear'): Keyframes {
  const list = [...(keyframes[prop] ?? [])]
  const i = keyframeIndexNear(list, t)
  if (i >= 0) list[i] = { ...list[i], v }
  else list.push({ t, v, ease })
  list.sort((a, b) => a.t - b.t)
  return { ...keyframes, [prop]: list }
}

export function withoutKeyframe(keyframes: Keyframes, prop: KeyframeProp, t: number): Keyframes {
  const list = (keyframes[prop] ?? []).filter((k) => Math.abs(k.t - t) > KEYFRAME_TOLERANCE)
  const next = { ...keyframes }
  if (list.length) next[prop] = list
  else delete next[prop]
  return next
}

export function mapKeyframes(keyframes: Keyframes, fn: (k: Keyframe) => Keyframe | null): Keyframes {
  const next: Keyframes = {}
  for (const [prop, list] of Object.entries(keyframes) as Array<[KeyframeProp, Keyframe[]]>) {
    const mapped = list.map(fn).filter((k): k is Keyframe => k !== null)
    if (mapped.length) next[prop] = mapped.sort((a, b) => a.t - b.t)
  }
  return next
}

/**
 * Splits keyframes at clip-local time `at`. Both halves receive a boundary
 * keyframe carrying the interpolated value so the animation stays continuous
 * across the cut.
 */
export function partitionKeyframes(keyframes: Keyframes, at: number): [Keyframes, Keyframes] {
  const left: Keyframes = {}
  const right: Keyframes = {}
  for (const [prop, list] of Object.entries(keyframes) as Array<[KeyframeProp, Keyframe[]]>) {
    if (!list.length) continue
    const boundary = valueAt(list, at, list[0].v)
    const before = list.filter((k) => k.t < at - KEYFRAME_TOLERANCE)
    const after = list.filter((k) => k.t > at + KEYFRAME_TOLERANCE).map((k) => ({ ...k, t: k.t - at }))
    left[prop] = [...before, { t: at, v: boundary, ease: 'linear' }]
    right[prop] = [{ t: 0, v: boundary, ease: before.at(-1)?.ease ?? 'linear' }, ...after]
  }
  return [left, right]
}

/** All distinct keyframe times on a clip, for drawing diamonds on the timeline. */
export function keyframeTimes(keyframes: Keyframes): number[] {
  const times: number[] = []
  for (const list of Object.values(keyframes)) {
    for (const k of list ?? []) {
      if (!times.some((t) => Math.abs(t - k.t) <= KEYFRAME_TOLERANCE)) times.push(k.t)
    }
  }
  return times.sort((a, b) => a - b)
}

/** Changes the easing of the keyframe at clip-local time `t`. */
export function withKeyframeEase(keyframes: Keyframes, prop: KeyframeProp, t: number, ease: Keyframe['ease']): Keyframes {
  const list = keyframes[prop]
  const i = keyframeIndexNear(list, t)
  if (!list || i < 0) return keyframes
  const next = [...list]
  next[i] = { ...next[i], ease }
  return { ...keyframes, [prop]: next }
}

/** Moves the keyframe at `from` to `to` (clip-local), keeping the list ordered and within [0, duration]. */
export function retimeKeyframe(keyframes: Keyframes, prop: KeyframeProp, from: number, to: number, duration: number): Keyframes {
  const list = keyframes[prop]
  const i = keyframeIndexNear(list, from)
  if (!list || i < 0) return keyframes
  const target = Math.min(duration, Math.max(0, to))
  if (list.some((k, j) => j !== i && Math.abs(k.t - target) <= KEYFRAME_TOLERANCE)) return keyframes
  const next = [...list]
  next[i] = { ...next[i], t: target }
  next.sort((a, b) => a.t - b.t)
  return { ...keyframes, [prop]: next }
}

/** Keyframes rescaled to a clip of a different length, for pasting between clips. */
export function rescaleKeyframes(keyframes: Keyframes, fromDuration: number, toDuration: number): Keyframes {
  if (fromDuration <= 0 || toDuration <= 0 || Math.abs(fromDuration - toDuration) < KEYFRAME_TOLERANCE) return keyframes
  const f = toDuration / fromDuration
  return mapKeyframes(keyframes, (k) => ({ ...k, t: k.t * f }))
}
