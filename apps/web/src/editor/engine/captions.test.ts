import { describe, expect, it } from 'vitest'
import {
  chunkWordsToCues,
  parseCaptions,
  parseSrt,
  parseVtt,
  serializeSrt,
  serializeVtt,
  type CaptionCue,
  type TimedWord,
} from './captions'

const cues: CaptionCue[] = [
  { start: 1, end: 2.5, text: 'Hello there' },
  { start: 2.75, end: 5.125, text: 'Two lines\nof text' },
  { start: 3661.001, end: 3662.999, text: 'Past the hour' },
]

const words = (spec: Array<[string, number, number]>): TimedWord[] =>
  spec.map(([text, start, end]) => ({ text, start, end }))

describe('SRT', () => {
  it('serializes with 1-based indexes, comma millis and a blank line between cues', () => {
    expect(serializeSrt(cues.slice(0, 2))).toBe(
      '1\n00:00:01,000 --> 00:00:02,500\nHello there\n\n2\n00:00:02,750 --> 00:00:05,125\nTwo lines\nof text\n',
    )
  })

  it('round-trips', () => {
    expect(parseSrt(serializeSrt(cues))).toEqual(cues)
  })

  it('handles CRLF line endings and a BOM', () => {
    const text = '﻿1\r\n00:00:00,500 --> 00:00:01,250\r\nFirst\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nSecond\r\nline\r\n'
    expect(parseSrt(text)).toEqual([
      { start: 0.5, end: 1.25, text: 'First' },
      { start: 2, end: 3, text: 'Second\nline' },
    ])
  })

  it('accepts dot millis and missing hours', () => {
    expect(parseSrt('1\n00:00:01.200 --> 00:00:02.400\nDots\n\n2\n00:03.000 --> 00:04.500\nNo hours\n')).toEqual([
      { start: 1.2, end: 2.4, text: 'Dots' },
      { start: 3, end: 4.5, text: 'No hours' },
    ])
  })

  it('tolerates missing index lines and missing blank lines between cues', () => {
    const text = '00:00:01,000 --> 00:00:02,000\nNo index\n\n00:00:02,000 --> 00:00:03,000\nStill fine\n3\n00:00:03,000 --> 00:00:04,000\nCramped\n'
    expect(parseSrt(text).map((c) => c.text)).toEqual(['No index', 'Still fine', 'Cramped'])
  })

  it('strips HTML-ish and ASS tags and decodes entities', () => {
    const text = '1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Hello</i> <font color="#ff0">world</font>\n<b>Tom &amp; Jerry</b>\n'
    expect(parseSrt(text)[0].text).toBe('Hello world\nTom & Jerry')
  })

  it('skips blank, zero-length and overlapping cues, and trims a cue that runs into the next', () => {
    const text = [
      '1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n',
      '2\n00:00:03,000 --> 00:00:03,000\nZero length\n',
      '3\n00:00:04,000 --> 00:00:06,000\nKeep me\n',
      '4\n00:00:04,500 --> 00:00:05,500\nInside the previous cue\n',
      '5\n00:00:05,800 --> 00:00:07,000\nOverlaps the tail\n',
      '6\n00:00:05,800 --> 00:00:07,000\nOverlaps the tail\n',
    ].join('\n')
    expect(parseSrt(text)).toEqual([
      { start: 4, end: 5.8, text: 'Keep me' },
      { start: 5.8, end: 7, text: 'Overlaps the tail' },
    ])
  })

  it('returns nothing for empty or garbage input', () => {
    expect(parseSrt('')).toEqual([])
    expect(parseSrt('﻿\r\n\r\n')).toEqual([])
    expect(parseSrt('just some words\nwith no timings')).toEqual([])
    expect(serializeSrt([])).toBe('')
  })
})

describe('VTT', () => {
  const vtt = [
    'WEBVTT - Example',
    'Kind: captions',
    'Language: en',
    '',
    'NOTE this is a comment',
    'that spans two lines 00:00:00.000 --> 00:00:09.000',
    '',
    'STYLE',
    '::cue { color: yellow }',
    '',
    'intro',
    '00:01.000 --> 00:02.500 align:start position:10%',
    '<v Roger>Hi &lt;there&gt;</v>',
    '',
    'NOTE',
    'another note',
    '',
    '01:00:00.250 --> 01:00:01.000 line:0',
    '<c.loud>Late</c> <00:00:00.500>cue',
    '',
  ].join('\n')

  it('skips the header, NOTE and STYLE blocks and ignores identifiers and cue settings', () => {
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 2.5, text: 'Hi <there>' },
      { start: 3600.25, end: 3601, text: 'Late cue' },
    ])
  })

  it('serializes and round-trips, escaping markup characters', () => {
    const tricky: CaptionCue[] = [...cues, { start: 4000, end: 4001, text: 'Fish & chips <3 -->' }]
    const text = serializeVtt(tricky)
    expect(text.startsWith('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello there\n\n')).toBe(true)
    expect(text).toContain('Fish &amp; chips &lt;3 --&gt;')
    expect(parseVtt(text)).toEqual(tricky)
  })

  it('returns nothing for an empty file', () => {
    expect(parseVtt('WEBVTT\n')).toEqual([])
    expect(serializeVtt([])).toBe('WEBVTT\n')
  })
})

describe('parseCaptions', () => {
  const srt = '1\n00:00:01,000 --> 00:00:02,000\nHello\n'

  it('detects the format by extension, then by header', () => {
    // Only a VTT parser knows the NOTE block hides this timing line.
    const noted = 'WEBVTT\n\nNOTE\n00:00:01.000 --> 00:00:02.000\nhidden\n'
    expect(parseCaptions(noted, 'subs.VTT')).toEqual([])
    expect(parseCaptions(noted)).toEqual([])
    expect(parseCaptions(noted, 'subs.srt')).toEqual([{ start: 1, end: 2, text: 'hidden' }])
    expect(parseCaptions(srt, 'movie.en.srt')).toEqual([{ start: 1, end: 2, text: 'Hello' }])
    expect(parseCaptions('﻿WEBVTT\n\nNOTE skip\n\n00:01.000 --> 00:02.000\nHi\n')).toEqual([
      { start: 1, end: 2, text: 'Hi' },
    ])
    expect(parseCaptions(srt, 'captions.txt')).toEqual([{ start: 1, end: 2, text: 'Hello' }])
  })
})

describe('chunkWordsToCues', () => {
  it('returns no cues for no words', () => {
    expect(chunkWordsToCues([])).toEqual([])
    expect(chunkWordsToCues(words([['  ', 0, 1]]))).toEqual([])
  })

  it('trims Whisper leading spaces, keeps punctuation attached and keeps per-cue words', () => {
    const result = chunkWordsToCues(words([[' And', 0, 0.3], ['  so ', 0.3, 0.6], [' my', 0.6, 0.9], [' friends', 0.9, 1.4]]))
    expect(result).toEqual([
      {
        start: 0,
        end: 1.4,
        text: 'And so my friends',
        words: words([['And', 0, 0.3], ['so', 0.3, 0.6], ['my', 0.6, 0.9], ['friends', 0.9, 1.4]]),
      },
    ])
  })

  it('folds stand-alone punctuation tokens into the previous word', () => {
    const result = chunkWordsToCues(words([[' Wait', 0, 0.4], [',', 0.4, 0.45], [' what', 0.5, 0.8]]))
    expect(result[0].text).toBe('Wait, what')
    expect(result[0].words?.map((w) => w.text)).toEqual(['Wait,', 'what'])
  })

  it('breaks when the next word would exceed maxChars', () => {
    const result = chunkWordsToCues(
      words([['aaaa', 0, 0.2], ['bbbb', 0.2, 0.4], ['cccc', 0.4, 0.6], ['dddd', 0.6, 0.8]]),
      { maxChars: 10 },
    )
    expect(result.map((c) => c.text)).toEqual(['aaaa bbbb', 'cccc dddd'])
    expect(result.every((c) => c.text.length <= 10)).toBe(true)
  })

  it('breaks when the cue would exceed maxDuration', () => {
    const result = chunkWordsToCues(
      words([['one', 0, 1], ['two', 1, 2], ['three', 2, 3], ['four', 3, 4]]),
      { maxDuration: 2.5 },
    )
    expect(result.map((c) => c.text)).toEqual(['one two', 'three four'])
    expect(result.map((c) => [c.start, c.end])).toEqual([[0, 2], [2, 4]])
  })

  it('breaks on a silence longer than maxGap', () => {
    const result = chunkWordsToCues(words([['before', 0, 0.5], ['pause', 0.6, 1], ['after', 2, 2.4]]), { maxGap: 0.7 })
    expect(result.map((c) => c.text)).toEqual(['before pause', 'after'])
  })

  it('breaks after sentence-ending punctuation but not after common abbreviations', () => {
    const result = chunkWordsToCues(
      words([['Hi.', 0, 0.3], ['Mr.', 0.3, 0.5], ['Smith', 0.5, 0.8], ['came?', 0.8, 1.1], ['Yes!', 1.1, 1.4], ['ok', 1.4, 1.7]]),
    )
    expect(result.map((c) => c.text)).toEqual(['Hi.', 'Mr. Smith came?', 'Yes!', 'ok'])
  })

  it('does not insert spaces between CJK words', () => {
    const result = chunkWordsToCues(words([['你好', 0, 0.4], ['世界', 0.4, 0.8]]))
    expect(result[0].text).toBe('你好世界')
  })

  it('keeps a single over-long word as its own cue and stretches instant cues without overlapping', () => {
    const result = chunkWordsToCues(words([['supercalifragilistic', 0, 0], ['next', 0.1, 0.1]]), { maxChars: 8 })
    expect(result.map((c) => c.text)).toEqual(['supercalifragilistic', 'next'])
    expect(result[0].end).toBe(0.1)
    expect(result[1].end).toBeCloseTo(0.4)
  })
})
