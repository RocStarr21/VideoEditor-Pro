/**
 * Tiny arithmetic evaluator for number fields: "100+20", "50*2", "1/3",
 * "(3+4)*2", "+10" (relative), "-5" and "25%" (of a base) all work. Anything
 * else returns null so the field can keep its previous value.
 */
export function evaluateExpression(input: string, current: number): number | null {
  const src = input.trim()
  if (!src) return null
  // A bare "+n" / "-n" adjusts the current value, as OpenCut's inputs do.
  const relative = /^[+-]\s*\d/.test(src) && !/[+\-*/%()]/.test(src.slice(1).replace(/^\s*\d*\.?\d*/, ''))
  let pos = 0
  const peek = () => src[pos]
  const skip = () => {
    while (pos < src.length && src[pos] === ' ') pos++
  }
  const parsePrimary = (): number | null => {
    skip()
    const ch = peek()
    if (ch === '(') {
      pos++
      const v = parseSum()
      skip()
      if (peek() !== ')') return null
      pos++
      return v
    }
    if (ch === '-' || ch === '+') {
      pos++
      const v = parsePrimary()
      return v === null ? null : ch === '-' ? -v : v
    }
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(pos))
    if (!m) return null
    pos += m[0].length
    let v = Number(m[0])
    skip()
    if (peek() === '%') {
      pos++
      v = (v / 100) * current
    }
    return v
  }
  const parseProduct = (): number | null => {
    let v = parsePrimary()
    while (v !== null) {
      skip()
      const op = peek()
      if (op !== '*' && op !== '/') break
      pos++
      const r = parsePrimary()
      if (r === null) return null
      v = op === '*' ? v * r : r === 0 ? null : v / r
    }
    return v
  }
  const parseSum = (): number | null => {
    let v = parseProduct()
    while (v !== null) {
      skip()
      const op = peek()
      if (op !== '+' && op !== '-') break
      pos++
      const r = parseProduct()
      if (r === null) return null
      v = op === '+' ? v + r : v - r
    }
    return v
  }
  const value = parseSum()
  skip()
  if (value === null || pos !== src.length || !Number.isFinite(value)) return null
  return relative ? current + value : value
}
