import { describe, expect, it } from 'vitest'
import { parseAss, parseCaptions, serializeAss } from './captions'

const SAMPLE = `[Script Info]
ScriptType: v4.00+

[V4+ Styles]
Format: Name, Fontname
Style: Default,Arial

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:01.50,0:00:03.00,Default,,0,0,0,,{\\b1}Hello{\\b0} there,\\Nfriend
Dialogue: 0,0:00:04.00,0:00:02.00,Default,,0,0,0,,backwards
Comment: 0,0:00:05.00,0:00:06.00,Default,,0,0,0,,ignored
`

describe('ASS subtitles', () => {
  it('parses dialogue lines, strips override tags and keeps commas in text', () => {
    const cues = parseAss(SAMPLE)
    expect(cues).toHaveLength(1)
    expect(cues[0]).toEqual({ start: 1.5, end: 3, text: 'Hello there,\nfriend' })
  })

  it('is detected by extension and by header', () => {
    expect(parseCaptions(SAMPLE, 'subs.ass')).toHaveLength(1)
    expect(parseCaptions(SAMPLE)).toHaveLength(1)
  })

  it('serializes a file that parses back to the same cues', () => {
    const cues = [
      { start: 0.5, end: 2.25, text: 'One\ntwo' },
      { start: 3661, end: 3662.5, text: 'Past the hour' },
    ]
    const out = serializeAss(cues, { width: 1080, height: 1920, fontFamily: 'Inter', fontSize: 72 })
    expect(out).toContain('PlayResX: 1080')
    expect(out).toContain('Style: Default,Inter,72,')
    expect(out).toContain('Dialogue: 0,0:00:00.50,0:00:02.25,Default,,0,0,0,,One\\NTwo'.replace('Two', 'two'))
    expect(parseAss(out)).toEqual(cues)
  })
})
