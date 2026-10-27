export interface Lut3D {
  size: number
  /** size^3 * 3 RGB values, red index varying fastest (Adobe .cube order). */
  data: Float32Array
  title: string
  domainMin: [number, number, number]
  domainMax: [number, number, number]
}

const NUMBER_RE = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/

const MIN_SIZE = 2
const MAX_SIZE = 256

function fail(line: number, message: string): never {
  throw new Error(line > 0 ? `Invalid .cube LUT (line ${line}): ${message}` : `Invalid .cube LUT: ${message}`)
}

function parseTriplet(tokens: string[], line: number, what: string): [number, number, number] {
  if (tokens.length !== 3) fail(line, `${what} needs 3 values, got ${tokens.length}`)
  return tokens.map((t) => {
    if (!NUMBER_RE.test(t)) fail(line, `${what} value "${t}" is not a number`)
    return Number(t)
  }) as [number, number, number]
}

/** Parses an Adobe/Resolve .cube file containing a 3D LUT. Throws a descriptive Error for anything else. */
export function parseCubeLut(text: string): Lut3D {
  if (typeof text !== 'string') fail(0, 'expected text')

  let title = ''
  let size = 0
  let domainMin: [number, number, number] = [0, 0, 0]
  let domainMax: [number, number, number] = [1, 1, 1]
  let data: Float32Array | null = null
  let count = 0
  let expected = 0

  const lines = text.replace(/^﻿/, '').split(/\r\n|\r|\n/)
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1
    const raw = lines[i].trim()
    if (!raw || raw.startsWith('#')) continue

    // TITLE is read before comment stripping so a '#' inside the quoted title survives.
    const titleMatch = /^TITLE\b\s*(.*)$/i.exec(raw)
    if (titleMatch) {
      if (count > 0) fail(lineNo, 'TITLE must appear before the LUT data')
      const rest = titleMatch[1]
      const quoted = /^"([^"]*)"/.exec(rest)
      title = quoted ? quoted[1] : rest.replace(/#.*$/, '').trim()
      continue
    }

    const hash = raw.indexOf('#')
    const content = (hash >= 0 ? raw.slice(0, hash) : raw).trim()
    if (!content) continue
    const tokens = content.split(/\s+/)
    const head = tokens[0]

    if (NUMBER_RE.test(head)) {
      if (!data) fail(lineNo, 'LUT data found before LUT_3D_SIZE')
      if (count >= expected) fail(lineNo, `more than ${expected} entries for LUT_3D_SIZE ${size}`)
      const [r, g, b] = parseTriplet(tokens, lineNo, 'LUT entry')
      data[count * 3] = r
      data[count * 3 + 1] = g
      data[count * 3 + 2] = b
      count++
      continue
    }

    if (count > 0) fail(lineNo, `unexpected "${head}" after the LUT data started`)

    const keyword = head.toUpperCase()
    const args = tokens.slice(1)
    switch (keyword) {
      case 'LUT_1D_SIZE':
      case 'LUT_1D_INPUT_RANGE':
        fail(lineNo, '1D LUTs are not supported; export a 3D LUT (LUT_3D_SIZE) instead')
        break
      case 'LUT_3D_SIZE': {
        if (args.length !== 1 || !/^\d+$/.test(args[0])) fail(lineNo, 'LUT_3D_SIZE needs one whole number')
        size = Number(args[0])
        if (size < MIN_SIZE || size > MAX_SIZE) fail(lineNo, `LUT_3D_SIZE ${size} is outside ${MIN_SIZE}..${MAX_SIZE}`)
        expected = size * size * size
        data = new Float32Array(expected * 3)
        break
      }
      case 'DOMAIN_MIN':
        domainMin = parseTriplet(args, lineNo, 'DOMAIN_MIN')
        break
      case 'DOMAIN_MAX':
        domainMax = parseTriplet(args, lineNo, 'DOMAIN_MAX')
        break
      case 'LUT_3D_INPUT_RANGE': {
        // Resolve's single-range form of DOMAIN_MIN / DOMAIN_MAX.
        if (args.length !== 2 || !args.every((a) => NUMBER_RE.test(a))) fail(lineNo, 'LUT_3D_INPUT_RANGE needs 2 numbers')
        const [lo, hi] = args.map(Number)
        domainMin = [lo, lo, lo]
        domainMax = [hi, hi, hi]
        break
      }
      default:
        // Unknown keywords before the data (vendor extensions) are ignored, per the .cube spec.
        if (!/^[A-Z_][A-Z0-9_]*$/.test(keyword)) fail(lineNo, `unrecognized line "${content}"`)
    }
  }

  if (!data) fail(0, 'missing LUT_3D_SIZE')
  if (count !== expected) fail(0, `expected ${expected} entries for LUT_3D_SIZE ${size}, found ${count}`)
  for (let c = 0; c < 3; c++) {
    if (!(domainMax[c] > domainMin[c])) fail(0, `DOMAIN_MAX must be greater than DOMAIN_MIN (channel ${'RGB'[c]})`)
  }

  return { size, data, title, domainMin, domainMax }
}
