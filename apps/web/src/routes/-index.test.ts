import { describe, expect, it } from 'vitest'
import { formatTime } from './index'

describe('formatTime', () => {
  it('formats timeline seconds as m:ss', () => {
    expect(formatTime(0)).toBe('0:00')
    expect(formatTime(9)).toBe('0:09')
    expect(formatTime(75)).toBe('1:15')
  })

  it('clamps negative timeline values to zero', () => {
    expect(formatTime(-4)).toBe('0:00')
  })
})
