import { describe, expect, it } from 'vitest'
import {
  detectBeats,
  encodeWav,
  estimateTempo,
  gainForTargetLufs,
  hasSpeechActivity,
  kWeightingCoefficients,
  measureLoudness,
  mixToMono,
  reverseChannels,
  timeStretch,
  type PcmLike,
} from './audio-dsp'

const pcm = (channels: Float32Array[], sampleRate: number): PcmLike => ({
  sampleRate,
  numberOfChannels: channels.length,
  length: channels[0]?.length ?? 0,
  getChannelData: (c) => channels[c],
})

const sine = (freq: number, seconds: number, sampleRate: number, amplitude: number, phase = 0) => {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate + phase)
  return out
}

const dbToAmp = (db: number) => Math.pow(10, db / 20)

const concat = (...parts: Float32Array[]) => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

// Deterministic noise so the tests never flake.
const prng = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

const clickTrack = (bpm: number, seconds: number, sampleRate: number, firstClick = 0.5) => {
  const out = new Float32Array(Math.round(seconds * sampleRate))
  const random = prng(42)
  for (let i = 0; i < out.length; i++) out[i] = (random() * 2 - 1) * 0.001
  const clickLength = Math.round(0.01 * sampleRate)
  const times: number[] = []
  for (let t = firstClick; t < seconds - 0.05; t += 60 / bpm) {
    times.push(t)
    const start = Math.round(t * sampleRate)
    for (let j = 0; j < clickLength && start + j < out.length; j++) {
      out[start + j] += 0.8 * (random() * 2 - 1) * Math.exp(-j / (0.002 * sampleRate))
    }
  }
  return { samples: out, times }
}

const zeroCrossingsPerSecond = (x: Float32Array, sampleRate: number, from: number, to: number) => {
  let crossings = 0
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 !== x[i] < 0) crossings++
  return crossings / ((to - from) / sampleRate)
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let sum = 0
  for (let i = from; i < to; i++) sum += x[i] * x[i]
  return Math.sqrt(sum / (to - from))
}

describe('K-weighting', () => {
  it('reproduces the BS.1770-4 coefficient tables at 48 kHz', () => {
    const [shelf, highpass] = kWeightingCoefficients(48000)
    expect(shelf.b0).toBeCloseTo(1.53512485958697, 9)
    expect(shelf.b1).toBeCloseTo(-2.69169618940638, 9)
    expect(shelf.b2).toBeCloseTo(1.19839281085285, 9)
    expect(shelf.a1).toBeCloseTo(-1.69065929318241, 9)
    expect(shelf.a2).toBeCloseTo(0.73248077421585, 9)
    expect([highpass.b0, highpass.b1, highpass.b2]).toEqual([1, -2, 1])
    expect(highpass.a1).toBeCloseTo(-1.99004745483398, 9)
    expect(highpass.a2).toBeCloseTo(0.99007225036621, 9)
  })
})

describe('measureLoudness', () => {
  // Reference points: BS.1770-4 states a 0 dBFS 1 kHz sine in one front
  // channel reads -3.01 LKFS; EBU Tech 3341 case 1/2 (stereo 1 kHz sine at
  // -20 / -23 dBFS in both channels) read -20 / -23 LUFS. A stereo 0 dBFS sine
  // therefore reads 0 LUFS (two channels sum +3 dB), not -3.
  it('reads a stereo 1 kHz sine at -20 dBFS as -20 LUFS', () => {
    for (const sr of [48000, 44100]) {
      const s = sine(1000, 10, sr, dbToAmp(-20))
      const m = measureLoudness(pcm([s, s.slice()], sr))
      expect(Math.abs(m.integratedLufs + 20)).toBeLessThan(0.1)
      expect(m.samplePeakDb).toBeCloseTo(-20, 1)
      expect(Math.abs(m.truePeakDb + 20)).toBeLessThan(0.1)
    }
  })

  it('matches EBU Tech 3341 case 1 (-23 dBFS stereo sine)', () => {
    const s = sine(1000, 20, 48000, dbToAmp(-23))
    expect(Math.abs(measureLoudness(pcm([s, s], 48000)).integratedLufs + 23)).toBeLessThan(0.1)
  })

  it('reads a 0 dBFS 1 kHz sine as -3.01 LUFS mono and 0 LUFS stereo', () => {
    const s = sine(1000, 5, 48000, 1)
    expect(Math.abs(measureLoudness(pcm([s], 48000)).integratedLufs + 3.01)).toBeLessThan(0.1)
    expect(Math.abs(measureLoudness(pcm([s, s], 48000)).integratedLufs)).toBeLessThan(0.1)
  })

  it('K-weights frequency content (100 Hz reads quieter than 1 kHz, 4 kHz louder)', () => {
    const low = measureLoudness(pcm([sine(100, 5, 48000, 0.1)], 48000)).integratedLufs
    const mid = measureLoudness(pcm([sine(1000, 5, 48000, 0.1)], 48000)).integratedLufs
    const high = measureLoudness(pcm([sine(4000, 5, 48000, 0.1)], 48000)).integratedLufs
    expect(low).toBeLessThan(mid - 0.5)
    expect(high).toBeGreaterThan(mid + 2)
  })

  it('returns -Infinity for silence and empty buffers', () => {
    const silent = measureLoudness(pcm([new Float32Array(48000), new Float32Array(48000)], 48000))
    expect(silent).toEqual({ integratedLufs: -Infinity, truePeakDb: -Infinity, samplePeakDb: -Infinity })
    expect(measureLoudness(pcm([new Float32Array(0)], 48000)).integratedLufs).toBe(-Infinity)
  })

  it('gates out silence and much quieter passages', () => {
    const sr = 48000
    const withSilence = concat(new Float32Array(5 * sr), sine(1000, 5, sr, dbToAmp(-20)))
    // The three blocks straddling the edge are partly silent yet pass both
    // gates, so the standard itself reads ~0.13 LU low here.
    expect(Math.abs(measureLoudness(pcm([withSilence, withSilence], sr)).integratedLufs + 20)).toBeLessThan(0.2)

    const loudThenQuiet = concat(sine(1000, 10, sr, dbToAmp(-20)), sine(1000, 10, sr, dbToAmp(-40)))
    const m = measureLoudness(pcm([loudThenQuiet, loudThenQuiet], sr))
    // Without the relative gate this would read about -23 LUFS.
    expect(Math.abs(m.integratedLufs + 20)).toBeLessThan(0.3)
  })

  it('measures buffers shorter than one 400 ms block', () => {
    const s = sine(1000, 0.25, 48000, dbToAmp(-20))
    expect(Math.abs(measureLoudness(pcm([s, s], 48000)).integratedLufs + 20)).toBeLessThan(0.2)
  })

  it('finds inter-sample peaks above the sample peak', () => {
    // fs/4 sine at 45° phase: samples sit at ±0.707, the waveform peaks at 1.0.
    const s = sine(12000, 1, 48000, 1, Math.PI / 4)
    const m = measureLoudness(pcm([s], 48000))
    expect(m.samplePeakDb).toBeCloseTo(-3.01, 1)
    expect(Math.abs(m.truePeakDb)).toBeLessThan(0.25)
  })
})

describe('gainForTargetLufs', () => {
  it('moves loudness to the target when the peak allows', () => {
    expect(gainForTargetLufs(-20, -14, -10)).toBeCloseTo(dbToAmp(6), 6)
    expect(gainForTargetLufs(-10, -23, -1)).toBeCloseTo(dbToAmp(-13), 6)
  })

  it('limits gain so the peak stays under the ceiling', () => {
    expect(gainForTargetLufs(-20, -14, -3)).toBeCloseTo(dbToAmp(2), 6)
    expect(gainForTargetLufs(-20, -14, -3, -2)).toBeCloseTo(dbToAmp(1), 6)
    // Peak already over the ceiling: attenuate even though loudness is under target.
    expect(gainForTargetLufs(-20, -14, 0.5)).toBeCloseTo(dbToAmp(-1.5), 6)
  })

  it('leaves silence alone', () => {
    expect(gainForTargetLufs(-Infinity, -14, -Infinity)).toBe(1)
    expect(gainForTargetLufs(Number.NaN, -14, -3)).toBe(1)
  })
})

describe('detectBeats / estimateTempo', () => {
  it('finds every click of a 120 BPM track and its tempo', () => {
    for (const sr of [44100, 48000]) {
      const { samples, times } = clickTrack(120, 12, sr)
      const beats = detectBeats(pcm([samples, samples.slice()], sr))
      expect(beats.length).toBe(times.length)
      beats.forEach((b, i) => expect(Math.abs(b - times[i])).toBeLessThan(0.025))
      const tempo = estimateTempo(beats)
      expect(tempo).not.toBeNull()
      expect(Math.abs((tempo ?? 0) - 120)).toBeLessThan(1)
    }
  })

  it('honours minInterval', () => {
    const sr = 44100
    const { samples } = clickTrack(480, 6, sr)
    const beats = detectBeats(pcm([samples], sr), { minInterval: 0.28 })
    expect(beats.length).toBeGreaterThan(5)
    for (let i = 1; i < beats.length; i++) expect(beats[i] - beats[i - 1]).toBeGreaterThanOrEqual(0.28 - 1e-9)
    const dense = detectBeats(pcm([samples], sr), { minInterval: 0.1 })
    expect(dense.length).toBeGreaterThan(beats.length)
  })

  it('reports nothing for silence', () => {
    expect(detectBeats(pcm([new Float32Array(44100 * 2)], 44100))).toEqual([])
  })

  it('estimates tempo from onset lists', () => {
    expect(estimateTempo([0, 0.5, 1])).toBeNull()
    expect(estimateTempo([0, 0.5, 1, 1.5, 2])).toBeCloseTo(120, 0)
    // 90 BPM with one missed beat and an extra off-beat onset.
    const t90 = [0, 0.667, 1.333, 2.667, 3.333, 3.667, 4, 4.667, 5.333]
    expect(Math.abs((estimateTempo(t90) ?? 0) - 90)).toBeLessThan(1.5)
    // Octave folding: 60 BPM onsets report the 120 BPM octave.
    expect(estimateTempo([0, 1, 2, 3, 4])).toBeCloseTo(120, 0)
  })
})

describe('timeStretch', () => {
  const sr = 44100
  const input = sine(440, 2, sr, 0.5)
  const inputZcr = zeroCrossingsPerSecond(input, sr, 0, input.length)

  it('returns copies at rate 1', () => {
    const [out] = timeStretch([input], sr, 1)
    expect(out).not.toBe(input)
    expect(out).toEqual(input)
  })

  for (const rate of [0.5, 0.8, 1.25, 2, 4]) {
    it(`keeps pitch and level at rate ${rate}`, () => {
      const [left, right] = timeStretch([input, input.slice()], sr, rate)
      expect(left.length).toBe(Math.round(input.length / rate))
      expect(right.length).toBe(left.length)
      const margin = Math.round(0.05 * sr)
      const zcr = zeroCrossingsPerSecond(left, sr, margin, left.length - margin)
      expect(Math.abs(zcr - inputZcr) / inputZcr).toBeLessThan(0.05)
      expect(Math.abs(rms(left, margin, left.length - margin) / rms(input) - 1)).toBeLessThan(0.1)
    })
  }

  it('handles the extremes of the speed range', () => {
    expect(timeStretch([input], sr, 0.1)[0].length).toBe(Math.round(input.length / 0.1))
    expect(timeStretch([input], sr, 16)[0].length).toBe(Math.round(input.length / 16))
    expect(() => timeStretch([input], sr, 0)).toThrow(RangeError)
  })
})

describe('encodeWav', () => {
  it('writes a correct 16-bit PCM RIFF header and interleaved samples', async () => {
    const left = Float32Array.from([1, -1, 0.5])
    const right = Float32Array.from([0, 0.25, -0.5])
    const blob = encodeWav([left, right], 44100)
    expect(blob.type).toBe('audio/wav')
    expect(blob.size).toBe(44 + 12)
    const view = new DataView(await blob.arrayBuffer())
    const ascii = (offset: number) => String.fromCharCode(...new Uint8Array(view.buffer, offset, 4))
    expect(ascii(0)).toBe('RIFF')
    expect(view.getUint32(4, true)).toBe(36 + 12)
    expect(ascii(8)).toBe('WAVE')
    expect(ascii(12)).toBe('fmt ')
    expect(view.getUint32(16, true)).toBe(16)
    expect(view.getUint16(20, true)).toBe(1)
    expect(view.getUint16(22, true)).toBe(2)
    expect(view.getUint32(24, true)).toBe(44100)
    expect(view.getUint32(28, true)).toBe(44100 * 4)
    expect(view.getUint16(32, true)).toBe(4)
    expect(view.getUint16(34, true)).toBe(16)
    expect(ascii(36)).toBe('data')
    expect(view.getUint32(40, true)).toBe(12)
    const samples = [0, 1, 2, 3, 4, 5].map((i) => view.getInt16(44 + i * 2, true))
    expect(samples).toEqual([32767, 0, -32768, 8192, 16384, -16384])
  })

  it('clamps out-of-range samples and zero-pads short channels', async () => {
    const view = new DataView(await encodeWav([Float32Array.from([1.5, -2]), Float32Array.from([0.5])], 48000).arrayBuffer())
    expect([0, 1, 2, 3].map((i) => view.getInt16(44 + i * 2, true))).toEqual([32767, 16384, -32768, 0])
  })
})

describe('reverseChannels / mixToMono', () => {
  it('reverses copies without touching the input', () => {
    const a = Float32Array.from([1, 2, 3])
    const b = Float32Array.from([4, 5, 6])
    const [ra, rb] = reverseChannels([a, b])
    expect(Array.from(ra)).toEqual([3, 2, 1])
    expect(Array.from(rb)).toEqual([6, 5, 4])
    expect(Array.from(a)).toEqual([1, 2, 3])
  })

  it('averages channels', () => {
    const mono = mixToMono(pcm([Float32Array.from([1, 0, -1]), Float32Array.from([0, 0.5, 1])], 48000))
    expect(Array.from(mono)).toEqual([0.5, 0.25, 0])
    const single = Float32Array.from([0.1, 0.2])
    const copy = mixToMono(pcm([single], 48000))
    expect(copy).not.toBe(single)
    expect(copy).toEqual(single)
  })
})

describe('hasSpeechActivity', () => {
  const sr = 16000
  // White noise whose loudness pulses at a syllable-like 4 Hz.
  const syllables = (seconds: number) => {
    const out = new Float32Array(seconds * sr)
    let seed = 1
    for (let i = 0; i < out.length; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const noise = seed / 1073741824 - 1
      const pulse = Math.max(0, Math.sin((2 * Math.PI * 4 * i) / sr))
      out[i] = 0.2 * noise * pulse
    }
    return out
  }

  it('rejects a steady test tone (what Whisper captioned as "Bye!")', () => {
    expect(hasSpeechActivity(sine(440, 5, sr, 0.125), sr, 0, 5)).toBe(false)
    expect(hasSpeechActivity(sine(440, 5, sr, 0.125), sr, 4.7, 5)).toBe(false)
  })

  it('rejects silence', () => {
    expect(hasSpeechActivity(new Float32Array(3 * sr), sr, 0.5, 2)).toBe(false)
  })

  it('accepts syllable-modulated sound', () => {
    expect(hasSpeechActivity(syllables(3), sr, 0.5, 2)).toBe(true)
  })

  it('accepts speech over a quieter steady tone', () => {
    const mix = syllables(3)
    const hum = sine(120, 3, sr, 0.03)
    for (let i = 0; i < mix.length; i++) mix[i] += hum[i]
    expect(hasSpeechActivity(mix, sr, 0.5, 2)).toBe(true)
  })

  it('rejects a window past the end of the audio', () => {
    expect(hasSpeechActivity(syllables(2), sr, 2.5, 3)).toBe(false)
  })
})
