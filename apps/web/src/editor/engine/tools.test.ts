import { describe, expect, it } from 'vitest'
import { findCuts } from './tools'

const series = (n: number, at: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ t: (i + 1) * 0.1, diff: at(i) }))

describe('findCuts', () => {
  it('finds a single hard cut', () => {
    expect(findCuts(series(40, (i) => (i === 19 ? 0.4 : 0.01)))).toEqual([2])
  })

  it('ignores a steady brightness ramp or fade', () => {
    expect(findCuts(series(40, () => 0.012))).toEqual([])
  })

  it('ignores busy footage whose differences are uniformly high', () => {
    expect(findCuts(series(60, (i) => 0.15 + 0.05 * Math.sin(i)))).toEqual([])
  })

  it('still finds a cut inside busy footage', () => {
    const cuts = findCuts(series(60, (i) => (i === 30 ? 0.9 : 0.12 + 0.03 * Math.sin(i))))
    expect(cuts).toEqual([3.1])
  })

  it('enforces the minimum shot length', () => {
    const cuts = findCuts(series(20, (i) => (i === 5 || i === 7 ? 0.5 : 0.01)))
    expect(cuts).toHaveLength(1)
    expect(cuts[0]).toBeCloseTo(0.6)
  })
})
