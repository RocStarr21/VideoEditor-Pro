import { describe, expect, it } from 'vitest'
import { parseCubeLut } from './lut'

// Identity 2x2x2 cube, red index fastest.
const IDENTITY_ROWS = ['0 0 0', '1 0 0', '0 1 0', '1 1 0', '0 0 1', '1 0 1', '0 1 1', '1 1 1']

const cube = (header: string[], rows = IDENTITY_ROWS, eol = '\n') => [...header, ...rows].join(eol)

describe('parseCubeLut', () => {
  it('parses a 2x2x2 identity cube', () => {
    const lut = parseCubeLut(cube(['TITLE "Identity"', 'LUT_3D_SIZE 2']))
    expect(lut.size).toBe(2)
    expect(lut.title).toBe('Identity')
    expect(lut.data).toBeInstanceOf(Float32Array)
    expect(lut.data.length).toBe(2 * 2 * 2 * 3)
    expect(Array.from(lut.data)).toEqual(IDENTITY_ROWS.flatMap((r) => r.split(' ').map(Number)))
    // entry index = r + g*size + b*size^2
    const at = (r: number, g: number, b: number) => Array.from(lut.data.slice((r + g * 2 + b * 4) * 3, (r + g * 2 + b * 4) * 3 + 3))
    expect(at(1, 0, 0)).toEqual([1, 0, 0])
    expect(at(0, 1, 0)).toEqual([0, 1, 0])
    expect(at(0, 0, 1)).toEqual([0, 0, 1])
    expect(lut.domainMin).toEqual([0, 0, 0])
    expect(lut.domainMax).toEqual([1, 1, 1])
  })

  it('defaults the title to an empty string', () => {
    expect(parseCubeLut(cube(['LUT_3D_SIZE 2'])).title).toBe('')
  })

  it('reads DOMAIN_MIN and DOMAIN_MAX', () => {
    const lut = parseCubeLut(cube(['LUT_3D_SIZE 2', 'DOMAIN_MIN -0.1 0 0.05', 'DOMAIN_MAX 1.2 1 2']))
    expect(lut.domainMin[0]).toBeCloseTo(-0.1)
    expect(lut.domainMin[1]).toBe(0)
    expect(lut.domainMin[2]).toBeCloseTo(0.05)
    expect(lut.domainMax).toEqual([1.2, 1, 2])
  })

  it('reads the LUT_3D_INPUT_RANGE shorthand', () => {
    const lut = parseCubeLut(cube(['LUT_3D_SIZE 2', 'LUT_3D_INPUT_RANGE 0 4']))
    expect(lut.domainMin).toEqual([0, 0, 0])
    expect(lut.domainMax).toEqual([4, 4, 4])
  })

  it('handles CRLF line endings, comments, blank lines and a BOM', () => {
    const rows = IDENTITY_ROWS.map((r, i) => (i === 3 ? `${r}   # trailing comment` : r))
    const text = '﻿' + cube(['# Created by a test', '', 'TITLE "Has # inside"', '  LUT_3D_SIZE 2  ', '', '# data follows'], rows, '\r\n') + '\r\n\r\n'
    const lut = parseCubeLut(text)
    expect(lut.size).toBe(2)
    expect(lut.title).toBe('Has # inside')
    expect(lut.data[9]).toBe(1)
    expect(lut.data[10]).toBe(1)
  })

  it('accepts tabs, exponents and signs in values', () => {
    const rows = IDENTITY_ROWS.slice()
    rows[0] = '0.0\t-0.0\t+1e-3'
    const lut = parseCubeLut(cube(['LUT_3D_SIZE 2'], rows))
    expect(lut.data[2]).toBeCloseTo(0.001)
  })

  it('ignores unknown keywords before the data', () => {
    const lut = parseCubeLut(cube(['LUT_3D_SIZE 2', 'LUT_IN_VIDEO_RANGE', 'SOME_VENDOR_FLAG 1 2']))
    expect(lut.size).toBe(2)
  })

  it('rejects 1D LUTs', () => {
    expect(() => parseCubeLut(['LUT_1D_SIZE 2', '0 0 0', '1 1 1'].join('\n'))).toThrow(/1D LUTs are not supported/)
  })

  it('rejects a missing LUT_3D_SIZE', () => {
    expect(() => parseCubeLut('TITLE "x"\n')).toThrow(/missing LUT_3D_SIZE/)
    expect(() => parseCubeLut(IDENTITY_ROWS.join('\n'))).toThrow(/before LUT_3D_SIZE/)
  })

  it('rejects sizes outside 2..256', () => {
    expect(() => parseCubeLut('LUT_3D_SIZE 1\n0 0 0')).toThrow(/outside 2\.\.256/)
    expect(() => parseCubeLut('LUT_3D_SIZE 257')).toThrow(/outside 2\.\.256/)
    expect(() => parseCubeLut('LUT_3D_SIZE 2.5')).toThrow(/whole number/)
    expect(() => parseCubeLut('LUT_3D_SIZE')).toThrow(/whole number/)
  })

  it('rejects the wrong number of entries', () => {
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], IDENTITY_ROWS.slice(0, 7)))).toThrow(/expected 8 entries.*found 7/)
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], [...IDENTITY_ROWS, '1 1 1']))).toThrow(/more than 8 entries/)
  })

  it('rejects non-numeric values and malformed rows', () => {
    const bad = IDENTITY_ROWS.slice()
    bad[2] = '0 abc 0'
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], bad))).toThrow(/line 4.*"abc" is not a number/)

    const short = IDENTITY_ROWS.slice()
    short[5] = '1 0'
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], short))).toThrow(/needs 3 values, got 2/)

    const nan = IDENTITY_ROWS.slice()
    nan[1] = 'NaN 0 0'
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], nan))).toThrow(/unexpected "NaN"/)

    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 x 0']))).toThrow(/DOMAIN_MIN value "x"/)
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2', 'DOMAIN_MAX 1 1']))).toThrow(/DOMAIN_MAX needs 3 values/)
  })

  it('rejects an empty or inverted domain', () => {
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2', 'DOMAIN_MIN 0 0 0', 'DOMAIN_MAX 1 0 1']))).toThrow(/DOMAIN_MAX must be greater/)
  })

  it('rejects keywords after the data starts', () => {
    expect(() => parseCubeLut(cube(['LUT_3D_SIZE 2'], [...IDENTITY_ROWS.slice(0, 4), 'DOMAIN_MIN 0 0 0', ...IDENTITY_ROWS.slice(4)]))).toThrow(
      /after the LUT data started/,
    )
  })

  it('rejects an empty file', () => {
    expect(() => parseCubeLut('')).toThrow(/missing LUT_3D_SIZE/)
  })
})
