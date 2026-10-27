/**
 * Voice effects as Web Audio sub-graphs. Every chain is built from standard
 * nodes and starts its internal sources at time 0, so the same code renders in
 * a live AudioContext (preview) and an OfflineAudioContext (export).
 */
import type { VoiceEffect } from '../model/types'

export interface EffectChain {
  input: AudioNode
  output: AudioNode
  dispose(): void
}

// Dual delay-line pitch shifter: each line sweeps its delay over one cycle and
// is silent (crossfaded out) at the moment its sweep resets.
const PITCH_CYCLE_SECONDS = 0.08
const PITCH_MIN_DELAY = 0.004
const PITCH_SHIFTS: Partial<Record<VoiceEffect, { semitones: number; makeup: number }>> = {
  // The sin² crossfade sums to unity only for correlated lines; on voice it
  // loses ~2 dB. Makeup values were set by K-weighted loudness on voice-like input.
  deep: { semitones: -5, makeup: 1.25 },
  chipmunk: { semitones: 7, makeup: 1.05 },
}
// Chrome's DynamicsCompressorNode delays its output by a fixed 6 ms look-ahead.
const COMPRESSOR_LOOKAHEAD = 0.006

/**
 * Average extra delay an effect adds, in seconds. The pitch shifter's delay
 * sweeps continuously; this is the envelope-weighted mean of that sweep.
 */
export function getVoiceEffectLatency(effect: VoiceEffect): number {
  const shift = PITCH_SHIFTS[effect]
  if (shift) {
    const sweep = Math.abs(1 - 2 ** (shift.semitones / 12)) * PITCH_CYCLE_SECONDS
    return PITCH_MIN_DELAY + sweep / 2
  }
  return effect === 'radio' ? COMPRESSOR_LOOKAHEAD : 0
}

interface Kit {
  ctx: BaseAudioContext
  gain(value?: number): GainNode
  filter(type: BiquadFilterType, frequency: number, q?: number, gainDb?: number): BiquadFilterNode
  delay(seconds: number, maxSeconds: number): DelayNode
  shaper(drive: number, oversample?: OverSampleType): WaveShaperNode
  track<T extends AudioNode>(node: T): T
  start<T extends AudioScheduledSourceNode>(source: T): T
  loop(buffer: AudioBuffer): AudioBufferSourceNode
}

type Ends = [input: AudioNode, output: AudioNode]

function series(...nodes: AudioNode[]): Ends {
  for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i])
  return [nodes[0], nodes[nodes.length - 1]]
}

/** tanh soft clipper normalised so ±1 in maps to ±1 out. Inputs beyond ±1 clamp to the curve ends. */
function saturationCurve(drive: number): Float32Array<ArrayBuffer> {
  const points = 4097
  const curve = new Float32Array(points)
  const norm = Math.tanh(drive)
  for (let i = 0; i < points; i++) {
    const x = (i / (points - 1)) * 2 - 1
    curve[i] = Math.tanh(drive * x) / norm
  }
  return curve
}

/** Small seeded PRNG so preview and export get the identical reverb tail. */
function mulberry32(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function hallImpulse(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const rate = ctx.sampleRate
  const length = Math.max(2, Math.round(seconds * rate))
  const predelay = Math.min(length - 1, Math.round(0.015 * rate))
  const ir = ctx.createBuffer(2, length, rate)
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch)
    const random = mulberry32(0x9e3779b9 + ch * 7919)
    let smoothed = 0
    for (let i = predelay; i < length; i++) {
      const t = (i - predelay) / (length - predelay)
      // Decays to -60 dB at the end; a one-pole low-pass that closes over time
      // makes highs die faster than lows, as in a real room.
      const damping = 0.1 + 0.75 * t
      smoothed += (1 - damping) * (random() * 2 - 1 - smoothed)
      data[i] = smoothed * Math.exp(-6.9 * t)
    }
  }
  return ir
}

function echo(kit: Kit): Ends {
  const input = kit.gain()
  const output = kit.gain()
  const delay = kit.delay(0.28, 1)
  const feedback = kit.gain(0.35)
  const wet = kit.gain(0.4)
  input.connect(output)
  input.connect(delay)
  delay.connect(feedback)
  feedback.connect(delay)
  delay.connect(wet)
  wet.connect(output)
  return [input, output]
}

function hall(kit: Kit): Ends {
  const input = kit.gain()
  const output = kit.gain()
  const convolver = kit.track(kit.ctx.createConvolver())
  convolver.buffer = hallImpulse(kit.ctx, 2.2)
  const wet = kit.gain(0.35)
  input.connect(output)
  input.connect(convolver)
  convolver.connect(wet)
  wet.connect(output)
  return [input, output]
}

function telephone(kit: Kit): Ends {
  return series(
    kit.filter('highpass', 400),
    kit.filter('highpass', 400),
    kit.filter('lowpass', 3000),
    kit.filter('lowpass', 3000),
    kit.shaper(1.5),
    kit.gain(0.9),
  )
}

function radio(kit: Kit): Ends {
  const compressor = kit.track(kit.ctx.createDynamicsCompressor())
  compressor.threshold.value = -28
  compressor.knee.value = 8
  compressor.ratio.value = 6
  compressor.attack.value = 0.003
  compressor.release.value = 0.2
  return series(
    kit.filter('highpass', 600),
    kit.filter('lowpass', 4000),
    kit.filter('peaking', 1800, 0.9, 3),
    compressor,
    kit.shaper(2),
    kit.gain(0.95),
  )
}

function megaphone(kit: Kit): Ends {
  return series(
    kit.filter('highpass', 500),
    kit.filter('highpass', 500),
    kit.filter('lowpass', 2500),
    kit.filter('lowpass', 2500),
    kit.filter('peaking', 1400, 1.2, 5),
    // Makeup: restores the level the narrow band removed, so the distortion
    // amount does not depend on how bass-heavy the source was.
    kit.gain(4),
    kit.shaper(6, '4x'),
    // Tames the fizz the hard clipping adds above the horn's range.
    kit.filter('lowpass', 4500),
    kit.gain(0.3),
  )
}

function robot(kit: Kit): Ends {
  const input = kit.gain()
  // Gain 0 plus the oscillator's output: the signal is multiplied by the sine.
  const ring = kit.gain(0)
  const carrier = kit.track(kit.ctx.createOscillator())
  carrier.type = 'sine'
  carrier.frequency.value = 60
  carrier.connect(ring.gain)
  kit.start(carrier)
  const comb = kit.delay(0.01, 0.05)
  const combFeedback = kit.gain(0.5)
  const output = kit.gain(0.8)
  input.connect(ring)
  ring.connect(output)
  ring.connect(comb)
  comb.connect(combFeedback)
  combFeedback.connect(comb)
  comb.connect(output)
  return [input, output]
}

/**
 * Pitch shift without changing duration. A delay whose length changes at
 * d' seconds per second replays at rate (1 - d'), so a sawtooth sweep of slope
 * (1 - ratio) shifts pitch by `ratio`. Two lines half a cycle apart, each faded
 * by sin² (the pair sums to 1), hide the sweep resets.
 */
function pitchShift(kit: Kit, semitones: number, makeup: number): Ends {
  const { ctx } = kit
  const ratio = 2 ** (semitones / 12)
  const rate = ctx.sampleRate
  const cycle = Math.max(2, 2 * Math.round((PITCH_CYCLE_SECONDS * rate) / 2))
  const sweep = (Math.abs(1 - ratio) * cycle) / rate
  const input = kit.gain()
  const output = kit.gain(makeup)

  for (let line = 0; line < 2; line++) {
    const offset = (line * cycle) / 2
    const ramp = ctx.createBuffer(1, cycle, rate)
    const fade = ctx.createBuffer(1, cycle, rate)
    const rampData = ramp.getChannelData(0)
    const fadeData = fade.getChannelData(0)
    for (let i = 0; i < cycle; i++) {
      const phase = ((i + offset) % cycle) / cycle
      // Rising delay lowers pitch, falling delay raises it.
      rampData[i] = ratio < 1 ? sweep * phase : sweep * (1 - phase)
      fadeData[i] = Math.sin(Math.PI * phase) ** 2
    }
    const delay = kit.delay(PITCH_MIN_DELAY, PITCH_MIN_DELAY + sweep + 0.01)
    const mix = kit.gain(0)
    kit.loop(ramp).connect(delay.delayTime)
    kit.loop(fade).connect(mix.gain)
    input.connect(delay)
    delay.connect(mix)
    mix.connect(output)
  }
  return [input, output]
}

export function buildVoiceEffect(ctx: BaseAudioContext, effect: VoiceEffect): EffectChain {
  const nodes: AudioNode[] = []
  const sources: AudioScheduledSourceNode[] = []
  const track = <T extends AudioNode>(node: T): T => {
    nodes.push(node)
    return node
  }
  const start = <T extends AudioScheduledSourceNode>(source: T): T => {
    sources.push(source)
    source.start(0)
    return source
  }
  const kit: Kit = {
    ctx,
    track,
    start,
    gain(value = 1) {
      const node = track(ctx.createGain())
      node.gain.value = value
      return node
    },
    filter(type, frequency, q = Math.SQRT1_2, gainDb = 0) {
      const node = track(ctx.createBiquadFilter())
      node.type = type
      node.frequency.value = frequency
      node.Q.value = q
      node.gain.value = gainDb
      return node
    },
    delay(seconds, maxSeconds) {
      const node = track(ctx.createDelay(maxSeconds))
      node.delayTime.value = seconds
      return node
    },
    shaper(drive, oversample = '2x') {
      const node = track(ctx.createWaveShaper())
      node.curve = saturationCurve(drive)
      node.oversample = oversample
      return node
    },
    loop(buffer) {
      const source = track(ctx.createBufferSource())
      source.buffer = buffer
      source.loop = true
      return start(source)
    },
  }

  let ends: Ends
  switch (effect) {
    case 'none': {
      const passthrough = kit.gain()
      ends = [passthrough, passthrough]
      break
    }
    case 'echo':
      ends = echo(kit)
      break
    case 'hall':
      ends = hall(kit)
      break
    case 'telephone':
      ends = telephone(kit)
      break
    case 'radio':
      ends = radio(kit)
      break
    case 'megaphone':
      ends = megaphone(kit)
      break
    case 'robot':
      ends = robot(kit)
      break
    case 'deep':
    case 'chipmunk': {
      const { semitones, makeup } = PITCH_SHIFTS[effect] ?? { semitones: 0, makeup: 1 }
      ends = pitchShift(kit, semitones, makeup)
      break
    }
    default: {
      const unknown: never = effect
      throw new Error(`Unknown voice effect: ${String(unknown)}`)
    }
  }

  let disposed = false
  return {
    input: ends[0],
    output: ends[1],
    dispose() {
      if (disposed) return
      disposed = true
      for (const source of sources) {
        try {
          source.stop()
        } catch {
          // Already stopped, or the context is closed.
        }
      }
      for (const node of nodes) {
        try {
          node.disconnect()
        } catch {
          // Nothing left to disconnect.
        }
      }
    },
  }
}
