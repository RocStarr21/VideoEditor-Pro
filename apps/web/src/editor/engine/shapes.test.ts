import { describe, expect, it } from 'vitest'
import { shapeSvgPath, shapeVertices } from './shapes'

const params = { shape: 'polygon' as const, cornerRadius: 0, sides: 6, points: 5, innerRadius: 0.5 }

describe('shapes', () => {
  it('builds regular polygons starting from the top', () => {
    const pts = shapeVertices('polygon', params, 100, 100)!
    expect(pts).toHaveLength(6)
    expect(pts[0].x).toBeCloseTo(0, 6)
    expect(pts[0].y).toBeCloseTo(-50, 6)
    for (const p of pts) expect(Math.hypot(p.x, p.y)).toBeCloseTo(50, 6)
  })

  it('alternates outer and inner radii for stars', () => {
    const pts = shapeVertices('star', params, 100, 100)!
    expect(pts).toHaveLength(10)
    expect(Math.hypot(pts[0].x, pts[0].y)).toBeCloseTo(50, 6)
    expect(Math.hypot(pts[1].x, pts[1].y)).toBeCloseTo(25, 6)
  })

  it('clamps side counts and inner radius', () => {
    expect(shapeVertices('polygon', { ...params, sides: 1 }, 10, 10)).toHaveLength(3)
    expect(shapeVertices('star', { ...params, innerRadius: 5 }, 10, 10)![1].x).toBeCloseTo(4.75 * Math.cos(-Math.PI / 2 + Math.PI / 5), 3)
  })

  it('emits closed svg paths for every kind', () => {
    for (const shape of ['rectangle', 'ellipse', 'polygon', 'star'] as const) {
      const d = shapeSvgPath(shape, { ...params, shape, cornerRadius: 25 }, 40)
      expect(d.startsWith('M')).toBe(true)
      expect(d.endsWith('Z')).toBe(true)
    }
    expect(shapeSvgPath('rectangle', { ...params, shape: 'rectangle' }, 40)).toBe('M0 0h40v40h-40Z')
  })
})
