import { describe, expect, it } from 'vitest'
import { evaluateExpression } from './expr'

describe('evaluateExpression', () => {
  it('evaluates arithmetic with precedence and parentheses', () => {
    expect(evaluateExpression('100+20', 0)).toBe(120)
    expect(evaluateExpression('50*2', 0)).toBe(100)
    expect(evaluateExpression('1/4', 0)).toBe(0.25)
    expect(evaluateExpression('(3+4)*2', 0)).toBe(14)
    expect(evaluateExpression('2+3*4', 0)).toBe(14)
    expect(evaluateExpression(' 1.5 * -2 ', 0)).toBe(-3)
  })

  it('treats a leading sign as a relative change', () => {
    expect(evaluateExpression('+10', 50)).toBe(60)
    expect(evaluateExpression('-5', 50)).toBe(45)
    expect(evaluateExpression('-5*2', 50)).toBe(-10)
  })

  it('reads percentages of the current value', () => {
    expect(evaluateExpression('50%', 200)).toBe(100)
  })

  it('rejects garbage without throwing', () => {
    expect(evaluateExpression('abc', 1)).toBeNull()
    expect(evaluateExpression('1/0', 1)).toBeNull()
    expect(evaluateExpression('(1+2', 1)).toBeNull()
    expect(evaluateExpression('', 1)).toBeNull()
    expect(evaluateExpression('2 3', 1)).toBeNull()
  })
})
