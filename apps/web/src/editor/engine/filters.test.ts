import { describe, expect, it } from 'vitest'
import { neutralAdjust } from '../model/defaults'
import type { Adjust } from '../model/types'
import { FILTER_PRESETS, getFilterPreset, isGradeNeutral, resolveColorGrade } from './filters'

const KEYS = Object.keys(neutralAdjust()) as Array<keyof Adjust>
const UNIPOLAR: Array<keyof Adjust> = ['sharpen', 'vignette', 'fade', 'grain']

describe('FILTER_PRESETS', () => {
  it('has about twenty presets with unique ids and in-range deltas', () => {
    expect(FILTER_PRESETS.length).toBeGreaterThanOrEqual(18)
    expect(new Set(FILTER_PRESETS.map((p) => p.id)).size).toBe(FILTER_PRESETS.length)
    for (const p of FILTER_PRESETS) {
      expect(p.id.startsWith('lut:')).toBe(false)
      expect(p.swatch).toMatch(/gradient|#/)
      for (const [k, v] of Object.entries(p.adjust)) {
        expect(KEYS).toContain(k)
        expect(Math.abs(v as number)).toBeLessThanOrEqual(100)
      }
      if (p.tintAmount !== undefined) {
        expect(p.tintAmount).toBeGreaterThan(0)
        expect(p.tintAmount).toBeLessThanOrEqual(1)
        expect(p.shadowTint || p.highlightTint).toBeTruthy()
      }
    }
  })

  it('covers every group', () => {
    const groups = new Set(FILTER_PRESETS.map((p) => p.group))
    expect([...groups].sort()).toEqual(['Cinematic', 'Film', 'Life', 'Mono', 'Vintage'])
  })

  it('looks presets up by id', () => {
    expect(getFilterPreset('noir')?.name).toBe('Noir')
    expect(getFilterPreset('does-not-exist')).toBeUndefined()
  })
})

describe('resolveColorGrade', () => {
  it('neutral in gives neutral out', () => {
    for (const g of [resolveColorGrade(null, null), resolveColorGrade(neutralAdjust(), null)]) {
      expect(g).toEqual({ ...neutralAdjust(), shadowTint: null, highlightTint: null, tintAmount: 0 })
      expect(isGradeNeutral(g)).toBe(true)
    }
  })

  it('passes the clip adjustment through', () => {
    const g = resolveColorGrade({ ...neutralAdjust(), contrast: 20, grain: 30 }, null)
    expect(g.contrast).toBe(20)
    expect(g.grain).toBe(30)
    expect(isGradeNeutral(g)).toBe(false)
  })

  it('applies a preset at full intensity', () => {
    const preset = getFilterPreset('harbor-lights')!
    const g = resolveColorGrade(null, { id: preset.id, intensity: 100 })
    for (const k of KEYS) expect(g[k]).toBeCloseTo(preset.adjust[k] ?? 0)
    expect(g.shadowTint).toEqual(preset.shadowTint)
    expect(g.highlightTint).toEqual(preset.highlightTint)
    expect(g.tintAmount).toBeCloseTo(preset.tintAmount!)
  })

  it('intensity 50 halves the preset deltas and tint amount', () => {
    const preset = getFilterPreset('amber-stock')!
    const full = resolveColorGrade(null, { id: preset.id, intensity: 100 })
    const half = resolveColorGrade(null, { id: preset.id, intensity: 50 })
    for (const k of KEYS) expect(half[k]).toBeCloseTo(full[k] / 2)
    expect(half.tintAmount).toBeCloseTo(full.tintAmount / 2)
    expect(half.shadowTint).toEqual(preset.shadowTint)
  })

  it('adds the preset on top of the clip adjustment', () => {
    const g = resolveColorGrade({ ...neutralAdjust(), saturation: 10 }, { id: 'punch', intensity: 50 })
    expect(g.saturation).toBeCloseTo(10 + 30 * 0.5)
  })

  it('intensity 0 contributes nothing', () => {
    const g = resolveColorGrade(null, { id: 'noir', intensity: 0 })
    expect(isGradeNeutral(g)).toBe(true)
    expect(g.shadowTint).toBeNull()
  })

  it('clamps bipolar fields to -100..100 and unipolar fields to 0..100', () => {
    const adjust: Adjust = { ...neutralAdjust(), saturation: -90, contrast: 95, vignette: 90, grain: -20, fade: 5 }
    const g = resolveColorGrade(adjust, { id: 'noir', intensity: 100 })
    expect(g.saturation).toBe(-100)
    expect(g.contrast).toBe(100)
    expect(g.vignette).toBe(100)
    // -20 from the clip plus +15 from the preset clamps at the unipolar floor
    expect(g.grain).toBe(0)
    expect(g.fade).toBe(5)

    const wild = resolveColorGrade({ ...neutralAdjust(), hue: 500, sharpen: -40, exposure: -300 }, null)
    expect(wild.hue).toBe(100)
    expect(wild.exposure).toBe(-100)
    expect(wild.sharpen).toBe(0)
    for (const k of UNIPOLAR) expect(wild[k]).toBeGreaterThanOrEqual(0)
  })

  it('clamps out-of-range intensity', () => {
    const over = resolveColorGrade(null, { id: 'punch', intensity: 400 })
    const full = resolveColorGrade(null, { id: 'punch', intensity: 100 })
    expect(over).toEqual(full)
  })

  it('ignores lut: ids', () => {
    const g = resolveColorGrade({ ...neutralAdjust(), brightness: 12 }, { id: 'lut:asset-123', intensity: 100 })
    expect(g).toEqual({ ...neutralAdjust(), brightness: 12, shadowTint: null, highlightTint: null, tintAmount: 0 })
  })

  it('ignores unknown ids', () => {
    const g = resolveColorGrade(null, { id: 'no-such-look', intensity: 100 })
    expect(isGradeNeutral(g)).toBe(true)
  })

  it('treats non-finite values as zero', () => {
    const g = resolveColorGrade({ ...neutralAdjust(), contrast: Number.NaN }, { id: 'punch', intensity: Number.NaN })
    expect(isGradeNeutral(g)).toBe(true)
  })

  it('does not share tint arrays with the preset', () => {
    const preset = getFilterPreset('selenium')!
    const g = resolveColorGrade(null, { id: preset.id, intensity: 100 })
    g.shadowTint![0] = 99
    expect(preset.shadowTint![0]).not.toBe(99)
  })
})

describe('isGradeNeutral', () => {
  it('ignores tint colors when the tint amount is zero', () => {
    const g = { ...neutralAdjust(), shadowTint: [1, 0, 0] as [number, number, number], highlightTint: null, tintAmount: 0 }
    expect(isGradeNeutral(g)).toBe(true)
    expect(isGradeNeutral({ ...g, tintAmount: 0.2 })).toBe(false)
  })
})
