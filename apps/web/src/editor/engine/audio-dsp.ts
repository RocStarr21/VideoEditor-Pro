/**
 * Offline audio analysis and processing over plain Float32Array PCM.
 *
 * Nothing here touches Web Audio, so it runs on the main thread, in workers,
 * during SSR and in Node tests. An AudioBuffer satisfies PcmLike as is.
 */

export interface PcmLike {
  sampleRate: number
  numberOfChannels: number
  length: number
  getChannelData(channel: number): Float32Array
}

export interface LoudnessMeasurement {
  integratedLufs: number
  truePeakDb: number
  samplePeakDb: number
}

export interface BiquadCoefficients {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

export interface BeatOptions {
  /** Minimum spacing between reported onsets, seconds. Default 0.28. */
  minInterval?: number
  /** 0..1, higher reports more (weaker) onsets. Default 0.5. */
  sensitivity?: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const toDb = (linear: number) => (linear > 0 ? 20 * Math.log10(linear) : -Infinity)
const sinc = (t: number) => (t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t))

// ── Loudness (ITU-R BS.1770-4) ───────────────────────────────────────────────

const LOUDNESS_OFFSET = -0.691
const ABSOLUTE_GATE_LUFS = -70
const RELATIVE_GATE_LU = -10

/**
 * K-weighting as two biquads (pre-filter high shelf, then the RLB high-pass),
 * re-derived from the analog prototypes for any sample rate. At 48 kHz this
 * reproduces the coefficient tables printed in BS.1770-4.
 */
export function kWeightingCoefficients(sampleRate: number): [BiquadCoefficients, BiquadCoefficients] {
  const shelfF0 = 1681.974450955533
  const shelfGainDb = 3.999843853973347
  const shelfQ = 0.7071752369554196
  const k = Math.tan((Math.PI * shelfF0) / sampleRate)
  const vh = Math.pow(10, shelfGainDb / 20)
  const vb = Math.pow(vh, 0.4996667741545416)
  const a0 = 1 + k / shelfQ + k * k
  const shelf: BiquadCoefficients = {
    b0: (vh + (vb * k) / shelfQ + k * k) / a0,
    b1: (2 * (k * k - vh)) / a0,
    b2: (vh - (vb * k) / shelfQ + k * k) / a0,
    a1: (2 * (k * k - 1)) / a0,
    a2: (1 - k / shelfQ + k * k) / a0,
  }

  const hpF0 = 38.13547087602444
  const hpQ = 0.5003270373238773
  const kh = Math.tan((Math.PI * hpF0) / sampleRate)
  const d = 1 + kh / hpQ + kh * kh
  // The standard keeps the numerator at [1, -2, 1] rather than normalising it.
  const highpass: BiquadCoefficients = {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (kh * kh - 1)) / d,
    a2: (1 - kh / hpQ + kh * kh) / d,
  }
  return [shelf, highpass]
}

function channelWeight(channel: number, channels: number): number {
  // 5.1 in SMPTE order (L R C LFE Ls Rs): LFE is excluded, surrounds get +1.5 dB.
  if (channels === 6) return [1, 1, 1, 0, 1.41, 1.41][channel]
  return 1
}

/** Adds weight * (K-weighted sample)^2 into one bucket per `step` samples. */
function accumulateKWeightedEnergy(
  x: Float32Array,
  count: number,
  [shelf, highpass]: [BiquadCoefficients, BiquadCoefficients],
  step: number,
  weight: number,
  out: Float64Array,
) {
  const { b0: sb0, b1: sb1, b2: sb2, a1: sa1, a2: sa2 } = shelf
  const { b0: hb0, b1: hb1, b2: hb2, a1: ha1, a2: ha2 } = highpass
  let x1 = 0
  let x2 = 0
  let s1 = 0
  let s2 = 0
  let h1 = 0
  let h2 = 0
  let acc = 0
  let filled = 0
  let bucket = 0
  for (let i = 0; i < count; i++) {
    const v = x[i]
    const s = sb0 * v + sb1 * x1 + sb2 * x2 - sa1 * s1 - sa2 * s2
    x2 = x1
    x1 = v
    const h = hb0 * s + hb1 * s1 + hb2 * s2 - ha1 * h1 - ha2 * h2
    s2 = s1
    s1 = s
    h2 = h1
    h1 = h
    acc += h * h
    if (++filled === step) {
      out[bucket++] += weight * acc
      acc = 0
      filled = 0
    }
  }
  if (filled > 0) out[bucket] += weight * acc
}

// 4x oversampling interpolator for true peak: Lanczos-windowed sinc, 12 taps per
// phase (48 taps total, the size BS.1770-4 Annex 2 suggests).
const TP_HALF = 6
const TP_TAPS = 2 * TP_HALF
const TP_PHASES: Float64Array[] = [0.25, 0.5, 0.75].map((frac) => {
  const taps = new Float64Array(TP_TAPS)
  let sum = 0
  for (let j = 0; j < TP_TAPS; j++) {
    // Tap j multiplies x[n - TP_HALF + 1 + j]; t is its distance from n + frac.
    const t = frac + TP_HALF - 1 - j
    taps[j] = sinc(t) * sinc(t / TP_HALF)
    sum += taps[j]
  }
  for (let j = 0; j < TP_TAPS; j++) taps[j] /= sum
  return taps
})
const TP_GAIN_BOUND = Math.max(...TP_PHASES.map((taps) => taps.reduce((s, v) => s + Math.abs(v), 0)))
const TP_CHUNK = 16

function interpolatedPeak(x: Float32Array, count: number, floor: number): number {
  const chunks = Math.ceil(count / TP_CHUNK)
  const chunkMax = new Float32Array(chunks)
  for (let c = 0; c < chunks; c++) {
    let m = 0
    const end = Math.min(count, (c + 1) * TP_CHUNK)
    for (let i = c * TP_CHUNK; i < end; i++) {
      const a = Math.abs(x[i])
      if (a > m) m = a
    }
    chunkMax[c] = m
  }

  const [p1, p2, p3] = TP_PHASES
  let peak = floor
  for (let c = 0; c < chunks; c++) {
    // Each interpolation window spans at most the neighbouring chunks, so this
    // bounds every interpolated value in the chunk; skip chunks that cannot win.
    const local = Math.max(chunkMax[c], c > 0 ? chunkMax[c - 1] : 0, c + 1 < chunks ? chunkMax[c + 1] : 0)
    if (local * TP_GAIN_BOUND <= peak) continue
    const end = Math.min(count, (c + 1) * TP_CHUNK)
    for (let i = c * TP_CHUNK; i < end; i++) {
      const base = i - TP_HALF + 1
      let y1 = 0
      let y2 = 0
      let y3 = 0
      if (base >= 0 && base + TP_TAPS <= count) {
        for (let j = 0; j < TP_TAPS; j++) {
          const v = x[base + j]
          y1 += p1[j] * v
          y2 += p2[j] * v
          y3 += p3[j] * v
        }
      } else {
        for (let j = 0; j < TP_TAPS; j++) {
          const m = base + j
          if (m < 0 || m >= count) continue
          const v = x[m]
          y1 += p1[j] * v
          y2 += p2[j] * v
          y3 += p3[j] * v
        }
      }
      peak = Math.max(peak, Math.abs(y1), Math.abs(y2), Math.abs(y3))
    }
  }
  return peak
}

/**
 * Integrated loudness per ITU-R BS.1770-4 (400 ms blocks, 75 % overlap,
 * -70 LUFS absolute and -10 LU relative gates), plus sample and 4x-oversampled
 * true peak. A mono buffer is measured as a single channel (a 0 dBFS 1 kHz
 * sine reads -3.01 LUFS). Buffers shorter than one block are measured as one
 * block over their whole length.
 */
export function measureLoudness(buffer: PcmLike): LoudnessMeasurement {
  const { sampleRate, numberOfChannels, length } = buffer
  if (length <= 0 || numberOfChannels <= 0 || !(sampleRate > 0)) {
    return { integratedLufs: -Infinity, truePeakDb: -Infinity, samplePeakDb: -Infinity }
  }

  const filters = kWeightingCoefficients(sampleRate)
  const step = Math.max(1, Math.round(sampleRate * 0.1))
  const fullSteps = Math.floor(length / step)
  const steps = new Float64Array(Math.ceil(length / step))
  const channels: Array<{ data: Float32Array; count: number }> = []
  let samplePeak = 0

  for (let ch = 0; ch < numberOfChannels; ch++) {
    const data = buffer.getChannelData(ch)
    const count = Math.min(length, data.length)
    channels.push({ data, count })
    for (let i = 0; i < count; i++) {
      const a = Math.abs(data[i])
      if (a > samplePeak) samplePeak = a
    }
    const weight = channelWeight(ch, numberOfChannels)
    if (weight > 0) accumulateKWeightedEnergy(data, count, filters, step, weight, steps)
  }

  let truePeak = samplePeak
  if (samplePeak > 0) {
    for (const { data, count } of channels) truePeak = interpolatedPeak(data, count, truePeak)
  }

  // Each 400 ms block is four consecutive 100 ms steps.
  const blocks: number[] = []
  if (fullSteps >= 4) {
    for (let j = 0; j + 4 <= fullSteps; j++) {
      blocks.push((steps[j] + steps[j + 1] + steps[j + 2] + steps[j + 3]) / (4 * step))
    }
  } else {
    let total = 0
    for (const e of steps) total += e
    blocks.push(total / length)
  }

  const absoluteGate = Math.pow(10, (ABSOLUTE_GATE_LUFS - LOUDNESS_OFFSET) / 10)
  let sum = 0
  let n = 0
  for (const e of blocks) {
    if (e > absoluteGate) {
      sum += e
      n++
    }
  }
  let integratedLufs = -Infinity
  if (n > 0) {
    const relativeGate = (sum / n) * Math.pow(10, RELATIVE_GATE_LU / 10)
    let gatedSum = 0
    let gatedN = 0
    for (const e of blocks) {
      if (e > absoluteGate && e > relativeGate) {
        gatedSum += e
        gatedN++
      }
    }
    if (gatedN > 0) integratedLufs = LOUDNESS_OFFSET + 10 * Math.log10(gatedSum / gatedN)
  }

  return { integratedLufs, truePeakDb: toDb(truePeak), samplePeakDb: toDb(samplePeak) }
}

/**
 * Linear gain that moves `measuredLufs` to `targetLufs`, reduced if needed so
 * the peak (pass true peak for safety) lands at or below `ceilingDb`.
 */
export function gainForTargetLufs(measuredLufs: number, targetLufs: number, peakDb: number, ceilingDb = -1): number {
  if (!Number.isFinite(measuredLufs) || !Number.isFinite(targetLufs)) return 1
  let gainDb = targetLufs - measuredLufs
  if (Number.isFinite(peakDb)) gainDb = Math.min(gainDb, ceilingDb - peakDb)
  return Math.pow(10, gainDb / 20)
}

// ── Channels ─────────────────────────────────────────────────────────────────

export function mixToMono(buffer: PcmLike): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.max(0, buffer.length))
  const channels = buffer.numberOfChannels
  for (let ch = 0; ch < channels; ch++) {
    const data = buffer.getChannelData(ch)
    const count = Math.min(out.length, data.length)
    for (let i = 0; i < count; i++) out[i] += data[i]
  }
  if (channels > 1) {
    const scale = 1 / channels
    for (let i = 0; i < out.length; i++) out[i] *= scale
  }
  return out
}

export function reverseChannels(channels: Float32Array[]): Float32Array<ArrayBuffer>[] {
  return channels.map((c) => c.slice().reverse())
}

// ── Speech activity ──────────────────────────────────────────────────────────

/** Below about -50 dBFS RMS nothing audible is being said. */
const SPEECH_MIN_RMS = 0.003
/** Envelope frame length; short enough to resolve syllables. */
const SPEECH_FRAME_SECONDS = 0.02
/**
 * Minimum coefficient of variation of the loudness envelope. Speech pulses
 * with its syllables (typically 0.5–1); tones, hum and steady noise stay
 * within a few percent.
 */
const SPEECH_MIN_VARIATION = 0.2
const SPEECH_PAD_SECONDS = 0.15

/**
 * Whether mono PCM between `start` and `end` seconds plausibly holds speech.
 * Whisper invents words ("Bye!", "Thank you.") over silence and steady sounds,
 * so recognized text is kept only where the audio actually varies the way
 * speech does.
 */
export function hasSpeechActivity(samples: Float32Array, sampleRate: number, start: number, end: number): boolean {
  const from = Math.max(0, Math.floor((start - SPEECH_PAD_SECONDS) * sampleRate))
  const to = Math.min(samples.length, Math.ceil((end + SPEECH_PAD_SECONDS) * sampleRate))
  const frame = Math.max(1, Math.round(sampleRate * SPEECH_FRAME_SECONDS))
  const envelope: number[] = []
  for (let i = from; i + frame <= to; i += frame) {
    let sum = 0
    for (let j = i; j < i + frame; j++) sum += samples[j] * samples[j]
    envelope.push(Math.sqrt(sum / frame))
  }
  if (envelope.length < 3) return false
  const mean = envelope.reduce((s, v) => s + v, 0) / envelope.length
  if (mean < SPEECH_MIN_RMS) return false
  const variance = envelope.reduce((s, v) => s + (v - mean) ** 2, 0) / envelope.length
  return Math.sqrt(variance) / mean >= SPEECH_MIN_VARIATION
}

// ── Beat detection ───────────────────────────────────────────────────────────

/** In-place iterative radix-2 FFT (forward) for a fixed power-of-two size. */
function createFft(size: number): (re: Float64Array, im: Float64Array) => void {
  const bits = Math.round(Math.log2(size))
  const reversed = new Uint32Array(size)
  for (let i = 0; i < size; i++) {
    let r = 0
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
    reversed[i] = r
  }
  const cos = new Float64Array(size / 2)
  const sin = new Float64Array(size / 2)
  for (let i = 0; i < size / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / size)
    sin[i] = Math.sin((2 * Math.PI * i) / size)
  }
  return (re, im) => {
    for (let i = 0; i < size; i++) {
      const j = reversed[i]
      if (j > i) {
        const tr = re[i]
        re[i] = re[j]
        re[j] = tr
        const ti = im[i]
        im[i] = im[j]
        im[j] = ti
      }
    }
    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1
      const stride = size / len
      for (let start = 0; start < size; start += len) {
        for (let j = 0, k = 0; j < half; j++, k += stride) {
          const a = start + j
          const b = a + half
          const tr = re[b] * cos[k] + im[b] * sin[k]
          const ti = im[b] * cos[k] - re[b] * sin[k]
          re[b] = re[a] - tr
          im[b] = im[a] - ti
          re[a] += tr
          im[a] += ti
        }
      }
    }
  }
}

/** ~1024 points at 44.1/48 kHz, scaled so the analysis window stays ~23 ms. */
function onsetFftSize(sampleRate: number): number {
  return 2 ** clamp(Math.round(Math.log2((sampleRate * 1024) / 44100)), 8, 13)
}

/**
 * Half-wave rectified spectral flux of log-compressed magnitudes. Frames are
 * centred (frame f is centred on sample f * hop), so frame time = f * hop / sr.
 */
function spectralFlux(x: Float32Array, size: number, hop: number): Float64Array {
  const half = size / 2
  const bins = half + 1
  const frames = Math.floor(x.length / hop) + 1
  const fft = createFft(size)
  const window = new Float64Array(size)
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size)
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let prev = new Float64Array(bins)
  let cur = new Float64Array(bins)
  const flux = new Float64Array(frames)
  // Magnitudes are scaled so a full-scale sine peaks at 1; the log knee sits near -60 dB.
  const scale = 1000 * (4 / size)
  for (let f = 0; f < frames; f++) {
    const start = f * hop - half
    for (let i = 0; i < size; i++) {
      const k = start + i
      re[i] = k >= 0 && k < x.length ? x[k] * window[i] : 0
      im[i] = 0
    }
    fft(re, im)
    let sum = 0
    for (let b = 0; b < bins; b++) {
      const mag = Math.log1p(scale * Math.sqrt(re[b] * re[b] + im[b] * im[b]))
      cur[b] = mag
      const rise = mag - prev[b]
      if (rise > 0) sum += rise
    }
    flux[f] = sum
    const t = prev
    prev = cur
    cur = t
  }
  return flux
}

function medianOf(values: Float64Array, from: number, to: number): number {
  const sorted = values.slice(Math.max(0, from), Math.min(values.length, to + 1)).sort()
  return sorted.length ? sorted[sorted.length >> 1] : 0
}

/**
 * Onset times in seconds: spectral flux on a mono mixdown, an adaptive
 * (median + offset) threshold, local-maximum peak picking, then the strongest
 * onsets are kept subject to `minInterval` spacing. Sorted ascending.
 */
export function detectBeats(buffer: PcmLike, opts: BeatOptions = {}): number[] {
  const sampleRate = buffer.sampleRate
  if (buffer.length <= 0 || buffer.numberOfChannels <= 0 || !(sampleRate > 0)) return []
  const minInterval = Math.max(0, opts.minInterval ?? 0.28)
  const sensitivity = clamp(opts.sensitivity ?? 0.5, 0, 1)

  const size = onsetFftSize(sampleRate)
  const hop = size / 2
  const frameSeconds = hop / sampleRate
  const envelope = spectralFlux(mixToMono(buffer), size, hop)

  let max = 0
  for (const v of envelope) if (v > max) max = v
  if (max <= 1e-9) return []
  for (let i = 0; i < envelope.length; i++) envelope[i] /= max

  const delta = 0.02 + 0.3 * (1 - sensitivity)
  const lambda = 1.5 - sensitivity
  const medianRadius = Math.max(1, Math.round(0.5 / frameSeconds))
  const peakRadius = Math.max(1, Math.round(0.03 / frameSeconds))

  const candidates: Array<{ time: number; strength: number }> = []
  for (let f = 0; f < envelope.length; f++) {
    const v = envelope[f]
    if (v <= delta) continue
    let isPeak = true
    for (let j = 1; j <= peakRadius && isPeak; j++) {
      if (f - j >= 0 && envelope[f - j] >= v) isPeak = false
      if (f + j < envelope.length && envelope[f + j] > v) isPeak = false
    }
    if (!isPeak) continue
    const threshold = delta + lambda * medianOf(envelope, f - medianRadius, f + medianRadius)
    if (v > threshold) candidates.push({ time: f * frameSeconds, strength: v })
  }

  candidates.sort((a, b) => b.strength - a.strength)
  const accepted: number[] = []
  for (const { time } of candidates) {
    let lo = 0
    let hi = accepted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (accepted[mid] < time) lo = mid + 1
      else hi = mid
    }
    const tooClose =
      (lo > 0 && time - accepted[lo - 1] < minInterval) || (lo < accepted.length && accepted[lo] - time < minInterval)
    if (!tooClose) accepted.splice(lo, 0, time)
  }
  return accepted
}

const TEMPO_MIN = 80
const TEMPO_MAX = 160

/**
 * Tempo in BPM from inter-onset intervals: intervals to the next and
 * second-next onset are folded by octaves into 80–160 BPM, histogrammed with a
 * Gaussian kernel, and the winning cluster's mean interval gives the tempo.
 * Null with fewer than 4 beats.
 */
export function estimateTempo(beats: number[]): number | null {
  if (beats.length < 4) return null
  const sorted = beats.filter(Number.isFinite).sort((a, b) => a - b)
  if (sorted.length < 4) return null
  const intervals: Array<{ seconds: number; bpm: number; weight: number }> = []
  for (let i = 0; i < sorted.length; i++) {
    for (const [ahead, weight] of [[1, 1], [2, 0.5]] as const) {
      if (i + ahead >= sorted.length) continue
      let seconds = sorted[i + ahead] - sorted[i]
      if (seconds < 0.05 || seconds > 4) continue
      let bpm = 60 / seconds
      while (bpm < TEMPO_MIN) {
        bpm *= 2
        seconds /= 2
      }
      while (bpm >= TEMPO_MAX) {
        bpm /= 2
        seconds *= 2
      }
      intervals.push({ seconds, bpm, weight })
    }
  }
  if (intervals.length === 0) return null

  const resolution = 0.5
  const sigma = 1.5
  const bins = new Float64Array(Math.round((TEMPO_MAX - TEMPO_MIN) / resolution) + 1)
  for (const { bpm, weight } of intervals) {
    const from = Math.max(0, Math.floor((bpm - 3 * sigma - TEMPO_MIN) / resolution))
    const to = Math.min(bins.length - 1, Math.ceil((bpm + 3 * sigma - TEMPO_MIN) / resolution))
    for (let b = from; b <= to; b++) {
      const d = TEMPO_MIN + b * resolution - bpm
      bins[b] += weight * Math.exp((-d * d) / (2 * sigma * sigma))
    }
  }
  let best = 0
  for (let b = 1; b < bins.length; b++) if (bins[b] > bins[best]) best = b
  const peakBpm = TEMPO_MIN + best * resolution

  let total = 0
  let weightSum = 0
  for (const { seconds, bpm, weight } of intervals) {
    if (Math.abs(bpm - peakBpm) > 4) continue
    total += seconds * weight
    weightSum += weight
  }
  if (weightSum === 0) return Math.round(peakBpm * 10) / 10
  return Math.round((60 / (total / weightSum)) * 10) / 10
}

// ── Time stretch (WSOLA) ─────────────────────────────────────────────────────

function alignmentScore(guide: Float32Array, candidate: number, target: number, length: number, stride: number): number {
  let dot = 0
  let energy = 0
  for (let j = 0; j < length; j += stride) {
    const v = guide[candidate + j]
    dot += v * guide[target + j]
    energy += v * v
  }
  return energy > 1e-12 ? dot / Math.sqrt(energy) : 0
}

/**
 * Time-scale modification by WSOLA: 40 ms Hann frames at 50 % overlap; each
 * frame's input position is searched within ±10 ms of nominal for the best
 * waveform match with the natural continuation of the previous frame. The
 * alignment is computed on the channel average and applied to all channels,
 * so the stereo image stays coherent. rate > 1 plays faster (shorter output);
 * pitch is preserved. Tuned for 0.1..16; any positive rate is accepted.
 */
export function timeStretch(channels: Float32Array[], sampleRate: number, rate: number): Float32Array<ArrayBuffer>[] {
  if (!Number.isFinite(rate) || rate <= 0) throw new RangeError(`timeStretch rate must be a positive number, got ${rate}`)
  if (rate === 1) return channels.map((c) => c.slice())
  if (channels.length === 0) return []

  const inLength = channels.reduce((m, c) => Math.max(m, c.length), 0)
  const outLength = Math.round(inLength / rate)
  if (inLength === 0 || outLength === 0) return channels.map(() => new Float32Array(outLength))

  const sr = sampleRate > 0 ? sampleRate : 44100
  const frame = Math.max(64, 2 * Math.round(sr * 0.02))
  const hop = frame / 2
  const tolerance = Math.max(1, Math.round(sr * 0.01))
  const stride = Math.max(1, Math.round(sr / 8000))
  const lagStep = Math.max(1, Math.round(sr / 16000))

  const window = new Float32Array(frame)
  for (let j = 0; j < frame; j++) window[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / frame)

  // Zero-padded mono guide so the search can read past either end without bounds checks.
  const pad = frame + tolerance + 4
  const guide = new Float32Array(inLength + 2 * pad)
  for (const c of channels) for (let i = 0; i < c.length; i++) guide[pad + i] += c[i]
  if (channels.length > 1) for (let i = 0; i < guide.length; i++) guide[i] /= channels.length

  const out = channels.map(() => new Float32Array(outLength))
  const norm = new Float32Array(outLength)

  const bestStart = (natural: number, nominal: number): number => {
    const lo = Math.max(0, nominal - tolerance)
    const hi = Math.min(inLength + tolerance, nominal + tolerance)
    const score = (c: number, s: number) => alignmentScore(guide, pad + c, pad + natural, hop, s)
    let best = Math.min(hi, Math.max(lo, nominal))
    let bestScore = score(best, stride)
    if (natural >= lo && natural <= hi) {
      const s = score(natural, stride)
      if (s >= bestScore) {
        best = natural
        bestScore = s
      }
    }
    for (let c = lo; c <= hi; c += lagStep) {
      const s = score(c, stride)
      if (s > bestScore) {
        best = c
        bestScore = s
      }
    }
    if (stride === 1 && lagStep === 1) return best
    const center = best
    let fine = score(center, 1)
    for (let c = Math.max(lo, center - lagStep); c <= Math.min(hi, center + lagStep); c++) {
      const s = score(c, 1)
      if (s > fine) {
        best = c
        fine = s
      }
    }
    return best
  }

  // Frame k covers output [(k - 1) * hop, (k + 1) * hop). Frame 0 is pinned so
  // its falling half carries the first `hop` input samples into the output.
  let prevStart = -hop
  for (let k = 0; ; k++) {
    const outStart = (k - 1) * hop
    if (outStart >= outLength) break
    const inStart = k === 0 ? -hop : bestStart(prevStart + hop, Math.round(outStart * rate))
    const jFrom = Math.max(0, -outStart)
    const jTo = Math.min(frame, outLength - outStart)
    for (let j = jFrom; j < jTo; j++) norm[outStart + j] += window[j]
    for (let ch = 0; ch < channels.length; ch++) {
      const src = channels[ch]
      const dst = out[ch]
      const from = Math.max(jFrom, -inStart)
      const to = Math.min(jTo, src.length - inStart)
      for (let j = from; j < to; j++) dst[outStart + j] += src[inStart + j] * window[j]
    }
    prevStart = inStart
  }

  for (let i = 0; i < outLength; i++) {
    const w = norm[i]
    if (w > 1e-6 && Math.abs(w - 1) > 1e-6) for (const dst of out) dst[i] /= w
  }
  return out
}

// ── WAV ──────────────────────────────────────────────────────────────────────

function writeAscii(view: DataView, offset: number, text: string) {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
}

/** 16-bit PCM, little-endian, interleaved RIFF/WAVE. Shorter channels are zero-padded. */
export function encodeWav(channels: Float32Array[], sampleRate: number): Blob {
  const channelCount = Math.max(1, channels.length)
  const frames = channels.reduce((m, c) => Math.max(m, c.length), 0)
  const rate = Math.round(sampleRate)
  const blockAlign = channelCount * 2
  const dataBytes = frames * blockAlign
  if (dataBytes > 0xffffffff - 36) throw new RangeError('Audio is too long for a WAV file (4 GB limit)')

  const bytes = new ArrayBuffer(44 + dataBytes)
  const view = new DataView(bytes)
  writeAscii(view, 0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  writeAscii(view, 8, 'WAVE')
  writeAscii(view, 12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channelCount, true)
  view.setUint32(24, rate, true)
  view.setUint32(28, rate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, 16, true)
  writeAscii(view, 36, 'data')
  view.setUint32(40, dataBytes, true)

  let offset = 44
  for (let i = 0; i < frames; i++) {
    for (let ch = 0; ch < channelCount; ch++) {
      const data = channels[ch]
      const s = data && i < data.length ? clamp(data[i], -1, 1) : 0
      view.setInt16(offset, s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff), true)
      offset += 2
    }
  }
  return new Blob([bytes], { type: 'audio/wav' })
}
