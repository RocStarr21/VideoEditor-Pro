import { describe, expect, it } from 'vitest'
import { formatColor, hsvToRgb, parseColor, rgbToHsv, toCss, toHex } from './color'

describe('color', () => {
  it('parses every accepted syntax', () => {
    expect(parseColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(parseColor('#00359480')).toEqual({ r: 0, g: 53, b: 148, a: 128 / 255 })
    expect(parseColor('rgba(0,0,0,0.6)')).toEqual({ r: 0, g: 0, b: 0, a: 0.6 })
    expect(parseColor('rgb(10 20 30 / 50%)')).toEqual({ r: 10, g: 20, b: 30, a: 0.5 })
    expect(parseColor('hsl(0, 100%, 50%)')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor('transparent')?.a).toBe(0)
    expect(parseColor('nope')).toBeNull()
  })

  it('round-trips through hsv and hex', () => {
    for (const hex of ['#003594', '#ffd100', '#22d3ee', '#123456']) {
      const c = parseColor(hex)!
      const { h, s, v } = rgbToHsv(c)
      expect(toHex({ ...hsvToRgb(h, s, v), a: 1 })).toBe(hex)
    }
  })

  it('formats for css and the picker', () => {
    const c = parseColor('#003594')!
    expect(toCss(c)).toBe('#003594')
    expect(toCss({ ...c, a: 0.5 })).toBe('rgba(0,53,148,0.5)')
    expect(formatColor(c, 'rgb')).toBe('rgb(0, 53, 148)')
    expect(formatColor({ ...c, a: 0.25 }, 'hex')).toBe('#00359440')
    expect(formatColor(parseColor('#ff0000')!, 'hsl')).toBe('hsl(0, 100%, 50%)')
  })
})
