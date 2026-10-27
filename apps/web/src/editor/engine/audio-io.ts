/**
 * Decoding and offline mixing of project audio. The mixdown reproduces what
 * the preview plays — speed (with optional pitch preservation), fades, volume
 * keyframes, voice effects, noise reduction, track mutes — so export, auto
 * captions and loudness measurement all hear the same thing.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, Input } from 'mediabunny'
import { gainAt } from '../model/animation'
import { clipEnd, isMediaClip } from '../model/timeline'
import type { Asset, MediaClip, Project } from '../model/types'

export interface DecodedAudio {
  sampleRate: number
  channels: Float32Array<ArrayBuffer>[]
}

export type BlobLoader = (assetId: string) => Promise<Blob | null>

/** Decodes source seconds [from, to) of an asset's audio, resampled to `sampleRate`, as stereo. */
export async function decodeAudioRange(blob: Blob, from: number, to: number, sampleRate: number): Promise<DecodedAudio | null> {
  from = Math.max(0, from)
  if (to <= from) return null
  const frames = Math.max(1, Math.round((to - from) * sampleRate))

  let native: DecodedAudio | null = null
  try {
    const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
    const track = await input.getPrimaryAudioTrack()
    if (track && (await track.canDecode())) {
      const sink = new AudioBufferSink(track)
      const rate = track.sampleRate
      const length = Math.ceil((to - from) * rate)
      const left = new Float32Array(length)
      const right = new Float32Array(length)
      for await (const { buffer, timestamp } of sink.buffers(from, to)) {
        const l = buffer.getChannelData(0)
        const r = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : l
        const offset = Math.round((timestamp - from) * rate)
        for (let i = 0; i < l.length; i++) {
          const j = offset + i
          if (j < 0 || j >= length) continue
          left[j] = l[i]
          right[j] = r[i]
        }
      }
      native = { sampleRate: rate, channels: [left, right] }
    }
    input.dispose()
  } catch {
    native = null
  }

  if (!native) {
    // Fallback: let the browser decode the whole file, then slice.
    try {
      const ctx = new OfflineAudioContext(2, 1, sampleRate)
      const buf = await ctx.decodeAudioData(await blob.arrayBuffer())
      const a = Math.floor(from * buf.sampleRate)
      const b = Math.min(buf.length, Math.ceil(to * buf.sampleRate))
      const l = buf.getChannelData(0).slice(a, b)
      const r = (buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0)).slice(a, b)
      native = { sampleRate: buf.sampleRate, channels: [l, r] }
    } catch {
      return null
    }
  }

  if (native.sampleRate === sampleRate) return native
  return resample(native, sampleRate, frames)
}

async function resample(src: DecodedAudio, sampleRate: number, frames: number): Promise<DecodedAudio> {
  const ctx = new OfflineAudioContext(2, frames, sampleRate)
  const buf = ctx.createBuffer(2, src.channels[0].length, src.sampleRate)
  buf.copyToChannel(src.channels[0], 0)
  buf.copyToChannel(src.channels[1] ?? src.channels[0], 1)
  const node = ctx.createBufferSource()
  node.buffer = buf
  node.connect(ctx.destination)
  node.start()
  const out = await ctx.startRendering()
  return { sampleRate, channels: [out.getChannelData(0), out.getChannelData(1)] }
}

export interface MixdownOptions {
  start: number
  end: number
  sampleRate?: number
  /** Only include these clips (e.g. the main track for auto captions). */
  filter?: (clip: MediaClip) => boolean
  onProgress?: (p: number) => void
  signal?: AbortSignal
}

/** Window length for offline rendering; bounds memory on long projects. */
const WINDOW = 30
/** Extra source decoded either side of a window so stretch/effects have context. */
const MARGIN = 0.25
/**
 * Audio rendered before each window and then discarded, so echo and hall
 * tails and noise-reduction state carry across window boundaries instead of
 * restarting every 30 s. Covers the longest built-in tail (hall, 2.2 s).
 */
const PREROLL = 2.5
/**
 * RNNoise compiles its wasm asynchronously inside the worklet and outputs
 * silence until it is ready; an offline render can outrun that. Rendering is
 * paused this long at the first quantum when a window uses noise reduction.
 */
const DENOISE_WARMUP_MS = 300

/**
 * Renders the project's audio for [start, end) as consecutive stereo
 * AudioBuffers of up to WINDOW seconds, so callers can interleave them with
 * video or stream them to disk.
 */
export async function* mixdownWindows(
  project: Project,
  assets: Record<string, Asset | undefined>,
  loadBlob: BlobLoader,
  opts: MixdownOptions,
): AsyncGenerator<AudioBuffer> {
  const sampleRate = opts.sampleRate ?? 48000
  const tracks = new Map(project.tracks.map((t) => [t.id, t]))
  const clips = project.clips.filter((c): c is MediaClip => {
    if (!isMediaClip(c) || c.type === 'image' || c.muted) return false
    if (tracks.get(c.trackId)?.muted) return false
    if (c.type === 'video' && !assets[c.assetId]?.hasAudio) return false
    if (c.volume <= 0 && !c.keyframes.volume) return false
    return !opts.filter || opts.filter(c)
  })

  const total = Math.max(0, opts.end - opts.start)
  const dsp = await import('./audio-dsp')

  for (let w0 = opts.start; w0 < opts.end - 1e-6; w0 += WINDOW) {
    if (opts.signal?.aborted) throw new DOMException('Export canceled', 'AbortError')
    const w1 = Math.min(opts.end, w0 + WINDOW)
    const r0 = Math.max(0, w0 - PREROLL)
    const frames = Math.max(1, Math.round((w1 - r0) * sampleRate))
    const ctx = new OfflineAudioContext(2, frames, sampleRate)
    const disposers: Array<() => void> = []
    let usesDenoise = false

    for (const clip of clips) {
      const a = Math.max(clip.start, r0)
      const b = Math.min(clipEnd(clip), w1)
      if (b <= a) continue
      const blob = await loadBlob(clip.assetId)
      if (!blob) continue

      // Source range for this window, with margin for the time-stretcher.
      const srcFrom = clip.sourceIn + (a - clip.start) * clip.speed
      const srcTo = clip.sourceIn + (b - clip.start) * clip.speed
      const lead = Math.min(MARGIN, srcFrom)
      const decoded = await decodeAudioRange(blob, srcFrom - lead, srcTo + MARGIN, sampleRate)
      if (!decoded) continue

      let channels = decoded.channels
      let rate = 1
      let leadOut = lead
      if (Math.abs(clip.speed - 1) > 1e-3) {
        if (clip.preservePitch) {
          channels = dsp.timeStretch(channels, sampleRate, clip.speed)
          leadOut = lead / clip.speed
        } else {
          rate = clip.speed
        }
      }

      const buf = ctx.createBuffer(2, Math.max(1, channels[0].length), sampleRate)
      buf.copyToChannel(channels[0], 0)
      buf.copyToChannel(channels[1] ?? channels[0], 1)

      const node = ctx.createBufferSource()
      node.buffer = buf
      node.playbackRate.value = rate
      let head: AudioNode = node

      if (clip.denoise) {
        try {
          const { createDenoiseNode, destroyDenoiseNode } = await import('./denoise')
          const dn = await createDenoiseNode(ctx)
          head.connect(dn)
          head = dn
          usesDenoise = true
          disposers.push(() => destroyDenoiseNode(dn))
        } catch (err) {
          console.warn('Noise reduction unavailable for export:', err)
        }
      }
      if (clip.voiceEffect !== 'none') {
        const { buildVoiceEffect } = await import('./voice-effects')
        const chain = buildVoiceEffect(ctx, clip.voiceEffect)
        head.connect(chain.input)
        head = chain.output
        disposers.push(() => chain.dispose())
      }

      // Volume envelope (keyframes × fades), sampled every 10 ms.
      const gain = ctx.createGain()
      const steps = Math.max(2, Math.ceil((b - a) * 100))
      const curve = new Float32Array(steps)
      for (let i = 0; i < steps; i++) curve[i] = gainAt(clip, a + ((b - a) * i) / (steps - 1))
      gain.gain.setValueAtTime(curve[0], a - r0)
      gain.gain.setValueCurveAtTime(curve, a - r0, Math.max(0.01, b - a))
      head.connect(gain)
      gain.connect(ctx.destination)

      // start()'s offset and duration are in buffer time. A stretched buffer is
      // already at output speed; a rate-shifted one plays `rate` buffer seconds
      // per output second.
      if (rate === 1) node.start(a - r0, leadOut, b - a)
      else node.start(a - r0, lead, (b - a) * rate)
    }

    if (usesDenoise) {
      void ctx.suspend(128 / sampleRate).then(async () => {
        await new Promise((resolve) => setTimeout(resolve, DENOISE_WARMUP_MS))
        await ctx.resume()
      })
    }
    const rendered = await ctx.startRendering()
    disposers.forEach((d) => d())
    opts.onProgress?.(Math.min(1, (w1 - opts.start) / Math.max(1e-6, total)))

    // Drop the pre-roll so windows butt together exactly.
    const skip = Math.round((w0 - r0) * sampleRate)
    const length = Math.max(1, rendered.length - skip)
    const out = new AudioBuffer({ length, numberOfChannels: 2, sampleRate })
    out.copyToChannel(rendered.getChannelData(0).subarray(skip), 0)
    out.copyToChannel(rendered.getChannelData(1).subarray(skip), 1)
    yield out
  }
}

/** Collects a full mixdown into plain channel arrays (for WAV export and transcription). */
export async function mixdownToChannels(
  project: Project,
  assets: Record<string, Asset | undefined>,
  loadBlob: BlobLoader,
  opts: MixdownOptions,
): Promise<DecodedAudio> {
  const sampleRate = opts.sampleRate ?? 48000
  const total = Math.max(1, Math.round((opts.end - opts.start) * sampleRate))
  const left = new Float32Array(total)
  const right = new Float32Array(total)
  let cursor = 0
  for await (const buf of mixdownWindows(project, assets, loadBlob, { ...opts, sampleRate })) {
    const n = Math.min(buf.length, total - cursor)
    left.set(buf.getChannelData(0).subarray(0, n), cursor)
    right.set(buf.getChannelData(1).subarray(0, n), cursor)
    cursor += n
  }
  return { sampleRate, channels: [left, right] }
}
