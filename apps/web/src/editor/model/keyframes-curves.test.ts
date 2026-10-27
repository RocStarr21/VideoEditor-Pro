import { describe, expect, it } from 'vitest'
import { cubicBezier, rescaleKeyframes, retimeKeyframe, valueAt, withKeyframeEase } from './keyframes'
import type { Keyframe } from './types'

describe('cubic bezier easing', () => {
  it('is identity for the linear curve and clamps outside 0..1', () => {
    const f = cubicBezier([0, 0, 1, 1])
    expect(f(0.25)).toBeCloseTo(0.25, 5)
    expect(f(-1)).toBe(0)
    expect(f(2)).toBe(1)
  })

  it('matches the CSS ease curve at known points', () => {
    const ease = cubicBezier([0.25, 0.1, 0.25, 1])
    expect(ease(0.5)).toBeCloseTo(0.8024, 3)
    expect(ease(0.1)).toBeCloseTo(0.0948, 3)
  })

  it('allows overshoot for pop-style curves', () => {
    const pop = cubicBezier([0.175, 0.885, 0.32, 1.275])
    expect(pop(0.7)).toBeGreaterThan(1)
    expect(pop(1)).toBe(1)
  })

  it('drives interpolation when stored on a keyframe', () => {
    const kfs: Keyframe[] = [
      { t: 0, v: 0, ease: [0, 0, 1, 1] },
      { t: 1, v: 100, ease: 'linear' },
    ]
    expect(valueAt(kfs, 0.5, 0)).toBeCloseTo(50, 5)
    const eased = withKeyframeEase({ x: kfs }, 'x', 0, [0.8, 0, 1, 1]).x!
    expect(valueAt(eased, 0.5, 0)).toBeLessThan(30)
  })
})

describe('keyframe editing', () => {
  const kfs: Keyframe[] = [
    { t: 0, v: 0, ease: 'linear' },
    { t: 1, v: 10, ease: 'linear' },
    { t: 2, v: 20, ease: 'linear' },
  ]

  it('retimes a keyframe and keeps the list sorted within the clip', () => {
    const moved = retimeKeyframe({ x: kfs }, 'x', 1, 1.8, 2).x!
    expect(moved.map((k) => k.t)).toEqual([0, 1.8, 2])
    expect(retimeKeyframe({ x: kfs }, 'x', 1, 5, 2)).toEqual({ x: kfs })
    expect(retimeKeyframe({ x: kfs }, 'x', 1, 2, 2)).toEqual({ x: kfs })
  })

  it('rescales keyframes to another clip length for pasting', () => {
    expect(rescaleKeyframes({ x: kfs }, 2, 4).x!.map((k) => k.t)).toEqual([0, 2, 4])
    expect(rescaleKeyframes({ x: kfs }, 2, 2)).toEqual({ x: kfs })
  })
})
