/**
 * Caption (subtitle) parsing, serialization and word chunking.
 *
 * Pure functions only — no DOM access — so this module is safe to import from
 * SSR code and from tests. All times are absolute seconds.
 */

export interface TimedWord {
  text: string
  start: number
  end: number
}

export interface CaptionCue {
  start: number
  end: number
  text: string
  words?: TimedWord[]
}

export interface ChunkOptions {
  /** Maximum characters per caption line. Default 32. */
  maxChars?: number
  /** Maximum cue duration in seconds. Default 3.2. */
  maxDuration?: number
  /** A silence longer than this (seconds) between two words starts a new cue. Default 0.7. */
  maxGap?: number
}

// ── Parsing ──────────────────────────────────────────────────────────────────

const TIMESTAMP = String.raw`(?:\d+:)?\d{1,2}:\d{1,2}(?:[.,]\d+)?`
const TIMING_LINE = new RegExp(String.raw`(${TIMESTAMP})\s*-->\s*(${TIMESTAMP})`)
/** The header block and NOTE / STYLE / REGION blocks carry no cues. */
const VTT_SKIP_BLOCK = /^(?:WEBVTT|NOTE|STYLE|REGION)(?:[ \t]|$)/

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  lrm: '',
  rlm: '',
}

/** Parses `hh:mm:ss,mmm`, `mm:ss.mmm` and friends into seconds. */
const parseTimestamp = (value: string): number => {
  const parts = value.trim().replace(',', '.').split(':')
  let seconds = 0
  for (const part of parts) seconds = seconds * 60 + Number(part)
  return seconds
}

const decodeEntities = (text: string) =>
  text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return ENTITIES[body.toLowerCase()] ?? match
  })

/** Strips markup (`<i>`, `<font>`, `<v Speaker>`, `<00:00:01.000>`, ASS `{\an8}`) and tidies lines. */
const cleanCueText = (lines: string[]) =>
  lines
    .map((line) =>
      decodeEntities(line.replace(/<[^>]*>/g, '').replace(/\{\\[^}]*\}/g, ''))
        .replace(/[ \t]+/g, ' ')
        .trim(),
    )
    .filter(Boolean)
    .join('\n')

interface RawCue {
  start: number
  end: number
  lines: string[]
}

/**
 * Line-oriented scanner shared by SRT and VTT. Driving it off the timing line
 * (rather than off blank-line blocks) is what makes it tolerant of missing
 * index lines and of files that forget the blank line between cues.
 */
const scanCues = (input: string, vtt: boolean): CaptionCue[] => {
  const lines = input.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n')
  const raw: RawCue[] = []
  let current: RawCue | null = null
  let skipping = false

  for (let index = 0; index < lines.length; index++) {
    const trimmed = lines[index].trim()
    if (trimmed === '') {
      if (current) raw.push(current)
      current = null
      skipping = false
      continue
    }
    if (skipping) continue
    if (vtt && current === null && VTT_SKIP_BLOCK.test(trimmed)) {
      skipping = true
      continue
    }

    const timing = TIMING_LINE.exec(trimmed)
    if (timing) {
      if (current) {
        // A bare number right before a timing line is the next cue's index, not text.
        if (current.lines.length && /^\d+$/.test(current.lines[current.lines.length - 1])) current.lines.pop()
        raw.push(current)
      }
      current = { start: parseTimestamp(timing[1]), end: parseTimestamp(timing[2]), lines: [] }
      continue
    }

    // Lines before the first timing line of a block are SRT indexes or VTT cue identifiers.
    if (current) current.lines.push(trimmed)
  }
  if (current) raw.push(current)

  return normalizeCues(
    raw.map((cue) => ({ start: cue.start, end: cue.end, text: cleanCueText(cue.lines) })),
  )
}

/**
 * Drops cues that cannot be shown on a single caption track: blank text,
 * non-positive duration, exact duplicates, and cues starting inside the
 * previous one. A cue that merely overlaps the previous one's tail is kept and
 * the previous cue is trimmed to end where it begins.
 */
const normalizeCues = (cues: CaptionCue[]): CaptionCue[] => {
  const valid = cues
    .filter((c) => c.text !== '' && Number.isFinite(c.start) && Number.isFinite(c.end) && c.end > c.start && c.start >= 0)
    .sort((a, b) => a.start - b.start)

  const out: CaptionCue[] = []
  for (const cue of valid) {
    const prev = out[out.length - 1]
    if (prev && cue.start < prev.end) {
      if (cue.start <= prev.start || cue.end <= prev.end) continue
      prev.end = cue.start
    }
    out.push(cue)
  }
  return out
}

export function parseSrt(text: string): CaptionCue[] {
  return scanCues(text, false)
}

export function parseVtt(text: string): CaptionCue[] {
  return scanCues(text, true)
}

const ASS_TIME = /^(\d+):(\d{1,2}):(\d{1,2})[.:](\d{1,2})$/

const parseAssTime = (value: string) => {
  const m = ASS_TIME.exec(value.trim())
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(2, '0')) / 100
}

/** SubStation Alpha (.ass/.ssa): Dialogue lines; override tags are dropped, \N becomes a line break. */
export function parseAss(text: string): CaptionCue[] {
  const cues: CaptionCue[] = []
  let format = ['Layer', 'Start', 'End', 'Style', 'Name', 'MarginL', 'MarginR', 'MarginV', 'Effect', 'Text']
  let inEvents = false
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (/^\[/.test(line)) {
      inEvents = /^\[events\]$/i.test(line)
      continue
    }
    if (!inEvents) continue
    const formatMatch = /^Format:\s*(.+)$/i.exec(line)
    if (formatMatch) {
      format = formatMatch[1].split(',').map((f) => f.trim())
      continue
    }
    const dialogue = /^Dialogue:\s*(.+)$/i.exec(line)
    if (!dialogue) continue
    const parts = dialogue[1].split(',')
    if (parts.length < format.length) continue
    const fields = Object.fromEntries(format.slice(0, -1).map((name, i) => [name.toLowerCase(), parts[i].trim()]))
    const body = parts.slice(format.length - 1).join(',')
    const start = parseAssTime(fields.start ?? '')
    const end = parseAssTime(fields.end ?? '')
    if (start === null || end === null) continue
    const textOut = decodeEntities(
      body
        .replace(/\{[^}]*\}/g, '')
        .replace(/\\[Nn]/g, '\n')
        .replace(/\\h/g, ' ')
        .trim(),
    )
    if (textOut) cues.push({ start, end, text: textOut })
  }
  return normalizeCues(cues)
}

export function parseCaptions(text: string, filename?: string): CaptionCue[] {
  const ext = filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'vtt') return parseVtt(text)
  if (ext === 'srt') return parseSrt(text)
  if (ext === 'ass' || ext === 'ssa') return parseAss(text)
  if (/^\s*\[Script Info\]/i.test(text)) return parseAss(text)
  return /^﻿?\s*WEBVTT/.test(text) ? parseVtt(text) : parseSrt(text)
}

// ── Serialization ────────────────────────────────────────────────────────────

const pad = (n: number, width: number) => String(n).padStart(width, '0')

const formatTimestamp = (seconds: number, separator: ',' | '.') => {
  const totalMs = Math.max(0, Math.round(seconds * 1000))
  const ms = totalMs % 1000
  const totalSeconds = Math.floor(totalMs / 1000)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}${separator}${pad(ms, 3)}`
}

/** Collapses blank lines, which would otherwise terminate the cue early. */
const cueBody = (text: string) =>
  text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')

const writableCues = (cues: CaptionCue[]) =>
  cues
    .map((cue) => ({ ...cue, text: cueBody(cue.text) }))
    .filter((cue) => cue.text !== '' && Number.isFinite(cue.start) && Number.isFinite(cue.end))

export function serializeSrt(cues: CaptionCue[]): string {
  return writableCues(cues)
    .map(
      (cue, i) =>
        `${i + 1}\n${formatTimestamp(cue.start, ',')} --> ${formatTimestamp(Math.max(cue.end, cue.start), ',')}\n${cue.text}\n`,
    )
    .join('\n')
}

const escapeVtt = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const formatAssTime = (seconds: number) => {
  const total = Math.max(0, Math.round(seconds * 100))
  const cs = total % 100
  const totalSeconds = Math.floor(total / 100)
  const s = totalSeconds % 60
  const m = Math.floor(totalSeconds / 60) % 60
  const h = Math.floor(totalSeconds / 3600)
  return `${h}:${pad(m, 2)}:${pad(s, 2)}.${pad(cs, 2)}`
}

/** SubStation Alpha file with one default style, for players and editors that expect .ass. */
export function serializeAss(cues: CaptionCue[], opts: { width?: number; height?: number; fontFamily?: string; fontSize?: number } = {}): string {
  const width = opts.width ?? 1920
  const height = opts.height ?? 1080
  const font = (opts.fontFamily ?? 'Arial').replace(/,/g, ' ')
  const size = Math.round(opts.fontSize ?? height * 0.05)
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,${font},${size},&H00FFFFFF,&H000000FF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,3,0,2,40,40,60,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ]
  const lines = writableCues(cues).map(
    (cue) => `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(Math.max(cue.end, cue.start))},Default,,0,0,0,,${cue.text.replace(/\n/g, '\\N')}`,
  )
  return `${[...header, ...lines].join('\n')}\n`
}

export function serializeVtt(cues: CaptionCue[]): string {
  const body = writableCues(cues)
    .map(
      (cue) =>
        `${formatTimestamp(cue.start, '.')} --> ${formatTimestamp(Math.max(cue.end, cue.start), '.')}\n${escapeVtt(cue.text)}\n`,
    )
    .join('\n')
  return body ? `WEBVTT\n\n${body}` : 'WEBVTT\n'
}

// ── Word chunking ────────────────────────────────────────────────────────────

/** Punctuation that belongs to the previous word when Whisper emits it as its own token. */
const TRAILING_PUNCTUATION = /^[.,!?;:…%)\]}»”’、。，！？：；]+$/u

/** Scripts written without spaces between words. */
const NO_SPACE_SCRIPT = /[฀-໿က-႟぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/u

const SENTENCE_END = /[.?!…。？！]["'”’)\]»]*$/u
const ABBREVIATION = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|e\.g|i\.e|approx)\.$/i

/** Cues shorter than this are stretched (never past the next cue) so they stay readable. */
const MIN_CUE_DURATION = 0.3

const joinWords = (left: string, right: string) => {
  if (!left) return right
  const glue = NO_SPACE_SCRIPT.test(left.slice(-1)) && NO_SPACE_SCRIPT.test(right[0] ?? '') ? '' : ' '
  return left + glue + right
}

const normalizeWords = (words: TimedWord[]): TimedWord[] => {
  const out: TimedWord[] = []
  const ordered = words
    .map((w) => ({ text: w.text.replace(/\s+/g, ' ').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter((w) => w.text !== '' && Number.isFinite(w.start) && Number.isFinite(w.end))
    .sort((a, b) => a.start - b.start)

  for (const word of ordered) {
    if (word.end < word.start) word.end = word.start
    const prev = out[out.length - 1]
    if (prev && TRAILING_PUNCTUATION.test(word.text)) {
      prev.text += word.text
      prev.end = Math.max(prev.end, word.end)
      continue
    }
    out.push(word)
  }
  return out
}

const endsSentence = (text: string) => SENTENCE_END.test(text) && !ABBREVIATION.test(text)

export function chunkWordsToCues(words: TimedWord[], opts: ChunkOptions = {}): CaptionCue[] {
  const maxChars = opts.maxChars ?? 32
  const maxDuration = opts.maxDuration ?? 3.2
  const maxGap = opts.maxGap ?? 0.7

  const cues: CaptionCue[] = []
  let group: TimedWord[] = []
  let text = ''

  const flush = () => {
    if (!group.length) return
    cues.push({
      start: group[0].start,
      end: Math.max(...group.map((w) => w.end)),
      text,
      words: group,
    })
    group = []
    text = ''
  }

  for (const word of normalizeWords(words)) {
    if (group.length) {
      const last = group[group.length - 1]
      const tooLong = joinWords(text, word.text).length > maxChars
      const tooSlow = word.end - group[0].start > maxDuration
      const pause = word.start - last.end > maxGap
      if (tooLong || tooSlow || pause) flush()
    }
    group.push(word)
    text = joinWords(text, word.text)
    if (endsSentence(word.text)) flush()
  }
  flush()

  cues.forEach((cue, i) => {
    const next = cues[i + 1]
    if (cue.end - cue.start < MIN_CUE_DURATION) {
      const limit = next ? next.start : Infinity
      cue.end = Math.max(cue.end, Math.min(cue.start + MIN_CUE_DURATION, limit))
    }
  })
  return cues
}
