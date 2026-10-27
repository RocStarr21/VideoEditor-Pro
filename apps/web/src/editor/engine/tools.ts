/**
 * Clip processing tools: freeze frame, reverse, scene detection.
 * Each works on decoded source frames via mediabunny so results are exact.
 */
import {
  ALL_FORMATS,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
} from 'mediabunny'
import { decodeAudioRange } from './audio-io'

const openInput = (blob: Blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })

/** Exact frame at `sourceTime` as a PNG (CapCut "Freeze frame"). */
export async function captureFrame(blob: Blob, sourceTime: number): Promise<Blob> {
  try {
    const input = openInput(blob)
    const track = await input.getPrimaryVideoTrack()
    if (track && (await track.canDecode())) {
      const sink = new CanvasSink(track)
      const frame = await sink.getCanvas(Math.max(0, sourceTime))
      if (frame) {
        const canvas = frame.canvas
        const png =
          canvas instanceof OffscreenCanvas
            ? await canvas.convertToBlob({ type: 'image/png' })
            : await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error('Frame capture failed'))), 'image/png'))
        input.dispose()
        return png
      }
    }
    input.dispose()
  } catch {
    // element fallback below
  }

  const url = URL.createObjectURL(blob)
  try {
    const v = document.createElement('video')
    v.muted = true
    v.src = url
    await new Promise<void>((res, rej) => {
      v.onloadeddata = () => res()
      v.onerror = () => rej(new Error('This clip could not be decoded'))
    })
    v.currentTime = sourceTime
    await new Promise<void>((res) => (v.onseeked = () => res()))
    const c = document.createElement('canvas')
    c.width = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    return await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Frame capture failed'))), 'image/png'))
  } finally {
    URL.revokeObjectURL(url)
  }
}

export interface ToolProgress {
  onProgress?: (p: number) => void
  signal?: AbortSignal
}

/** Seconds of source decoded and held in memory at once while reversing. */
const REVERSE_CHUNK = 1
const REVERSE_MAX_EDGE = 1920

/**
 * Encodes source range [from, to) played backwards, audio included, as a new
 * file (CapCut "Reverse"). Works through the range in one-second chunks from
 * the end so only a chunk of decoded frames is in memory at a time.
 */
export async function reverseVideo(blob: Blob, from: number, to: number, opts: ToolProgress = {}): Promise<{ blob: Blob; mime: string; ext: string }> {
  const input = openInput(blob)
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) {
    input.dispose()
    throw new Error('This clip’s video format cannot be decoded for reversing in this browser.')
  }
  const sw = await track.getDisplayWidth()
  const sh = await track.getDisplayHeight()
  const s = Math.min(1, REVERSE_MAX_EDGE / Math.max(sw, sh))
  const width = Math.max(2, Math.round((sw * s) / 2) * 2)
  const height = Math.max(2, Math.round((sh * s) / 2) * 2)

  // MP4/H.264 where possible for compatibility; WebM/VP9 otherwise.
  let format: Mp4OutputFormat | WebMOutputFormat = new Mp4OutputFormat({ fastStart: 'in-memory' })
  let codec = await getFirstEncodableVideoCodec(['avc', 'hevc'], { width, height })
  if (!codec) {
    format = new WebMOutputFormat()
    codec = await getFirstEncodableVideoCodec(['vp9', 'vp8', 'av1'], { width, height })
  }
  if (!codec) {
    input.dispose()
    throw new Error('No video encoder is available in this browser.')
  }

  const output = new Output({ format, target: new BufferTarget() })
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  const videoSource = new CanvasSource(canvas, { codec, bitrate: QUALITY_HIGH, keyFrameInterval: 1 })
  output.addVideoTrack(videoSource)

  const hasAudio = !!(await input.getPrimaryAudioTrack())
  let audioSource: AudioBufferSource | null = null
  let reversedAudio: Float32Array[] | null = null
  if (hasAudio) {
    const audioCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: 2, sampleRate: 48000 })
    const decoded = audioCodec ? await decodeAudioRange(blob, from, to, 48000) : null
    if (audioCodec && decoded) {
      const { reverseChannels } = await import('./audio-dsp')
      reversedAudio = reverseChannels(decoded.channels)
      audioSource = new AudioBufferSource({ codec: audioCodec as never, bitrate: QUALITY_HIGH })
      output.addAudioTrack(audioSource)
    }
  }

  await output.start()
  const sink = new CanvasSink(track, { width, height, fit: 'fill' })
  const span = to - from

  try {
    for (let chunkEnd = to; chunkEnd > from + 1e-6; chunkEnd -= REVERSE_CHUNK) {
      if (opts.signal?.aborted) throw new DOMException('Canceled', 'AbortError')
      const chunkStart = Math.max(from, chunkEnd - REVERSE_CHUNK)
      const frames: Array<{ bitmap: ImageBitmap; timestamp: number; duration: number }> = []
      for await (const f of sink.canvases(chunkStart, chunkEnd)) {
        if (f.timestamp < chunkStart - 1e-6 || f.timestamp >= chunkEnd) continue
        frames.push({ bitmap: await createImageBitmap(f.canvas as ImageBitmapSource), timestamp: f.timestamp, duration: f.duration })
      }

      // Audio for the same output window: reversed output time [to - chunkEnd, to - chunkStart).
      if (audioSource && reversedAudio) {
        const sr = 48000
        const a = Math.round((to - chunkEnd) * sr)
        const b = Math.min(reversedAudio[0].length, Math.round((to - chunkStart) * sr))
        if (b > a) {
          const buf = new AudioBuffer({ length: b - a, numberOfChannels: 2, sampleRate: sr })
          buf.copyToChannel(reversedAudio[0].subarray(a, b) as Float32Array<ArrayBuffer>, 0)
          buf.copyToChannel((reversedAudio[1] ?? reversedAudio[0]).subarray(a, b) as Float32Array<ArrayBuffer>, 1)
          await audioSource.add(buf)
        }
      }

      for (let i = frames.length - 1; i >= 0; i--) {
        const f = frames[i]
        ctx.drawImage(f.bitmap, 0, 0, width, height)
        f.bitmap.close()
        const outTime = Math.max(0, to - (f.timestamp + f.duration))
        await videoSource.add(outTime, f.duration)
      }
      opts.onProgress?.(Math.min(1, (to - chunkStart) / span))
    }
    await output.finalize()
  } catch (err) {
    await output.cancel().catch(() => undefined)
    throw err
  } finally {
    input.dispose()
  }

  const buffer = (output.target as BufferTarget).buffer!
  return { blob: new Blob([buffer], { type: format.mimeType }), mime: format.mimeType, ext: format.fileExtension.replace('.', '') }
}

/**
 * Picks hard cuts from a series of frame-to-frame differences.
 *
 * A cut is a spike relative to the recent baseline, not merely a large
 * change: camera motion and fades produce steady differences, while a cut is
 * a sudden jump well above them. Comparing against a rolling median makes the
 * threshold adapt to how busy the footage is.
 */
export function findCuts(samples: Array<{ t: number; diff: number }>, sensitivity = 0.5, minShot = 0.6): number[] {
  // Higher sensitivity → lower thresholds → more cuts.
  const floor = 0.18 - sensitivity * 0.12
  const ratio = 5 - sensitivity * 2.5
  const window: number[] = []
  const cuts: number[] = []
  let lastCut = -Infinity
  for (const { t, diff } of samples) {
    const sorted = [...window].sort((a, b) => a - b)
    const baseline = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0
    // A few samples of history are needed before a jump can be judged a spike.
    const warmedUp = window.length >= 3
    if (warmedUp && diff > floor && diff > baseline * ratio + 0.02 && t - lastCut >= minShot) {
      cuts.push(t)
      lastCut = t
      // The cut itself must not raise the baseline for the next shot.
      window.length = 0
      continue
    }
    window.push(diff)
    if (window.length > 12) window.shift()
  }
  return cuts
}

/**
 * Hard-cut detection for CapCut "Split by scene": mean color difference
 * between consecutive small decoded frames, sampled ~10 times per second,
 * fed to findCuts. Returns source times of cuts.
 */
export async function detectScenes(blob: Blob, from: number, to: number, opts: ToolProgress & { sensitivity?: number } = {}): Promise<number[]> {
  const input = openInput(blob)
  const track = await input.getPrimaryVideoTrack()
  if (!track || !(await track.canDecode())) {
    input.dispose()
    throw new Error('This clip’s video format cannot be decoded for scene detection in this browser.')
  }
  const W = 64
  const H = 36
  const sink = new CanvasSink(track, { width: W, height: H, fit: 'fill' })
  const work = new OffscreenCanvas(W, H)
  const wctx = work.getContext('2d', { willReadFrequently: true })!
  const minShot = 0.6

  let prev: Uint8ClampedArray | null = null
  let lastSample = -Infinity
  const samples: Array<{ t: number; diff: number }> = []

  try {
    for await (const f of sink.canvases(from, to)) {
      if (opts.signal?.aborted) throw new DOMException('Canceled', 'AbortError')
      if (f.timestamp - lastSample < 0.1) continue
      lastSample = f.timestamp
      wctx.drawImage(f.canvas as CanvasImageSource, 0, 0)
      const data = wctx.getImageData(0, 0, W, H).data
      if (prev) {
        let sum = 0
        for (let i = 0; i < data.length; i += 4) {
          sum += Math.abs(data[i] - prev[i]) + Math.abs(data[i + 1] - prev[i + 1]) + Math.abs(data[i + 2] - prev[i + 2])
        }
        samples.push({ t: f.timestamp, diff: sum / (W * H * 3 * 255) })
      }
      prev = data
      opts.onProgress?.(Math.min(1, (f.timestamp - from) / Math.max(1e-6, to - from)))
    }
  } finally {
    input.dispose()
  }
  return findCuts(samples, opts.sensitivity ?? 0.5, minShot).filter((t) => t > from + minShot / 2 && t < to - minShot / 2)
}
