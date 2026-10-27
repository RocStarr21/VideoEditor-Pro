/**
 * Media ingestion: classify, probe, thumbnail and waveform imported files.
 * Uses mediabunny (WebCodecs demux/decode) where it can read the container and
 * falls back to media elements, so odd formats still import with sane metadata.
 */
import { ALL_FORMATS, AudioBufferSink, BlobSource, CanvasSink, Input } from 'mediabunny'
import { newId } from '../model/defaults'
import type { Asset, AssetKind } from '../model/types'

export interface Thumbnails {
  /** Source seconds between consecutive thumbnails. */
  interval: number
  urls: string[]
}

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|ogv|3gp)$/i
const AUDIO_EXT = /\.(mp3|wav|m4a|aac|ogg|oga|opus|flac|weba)$/i
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i

export function classifyFile(file: File): AssetKind | null {
  if (file.type.startsWith('video/') || VIDEO_EXT.test(file.name)) return 'video'
  if (file.type.startsWith('audio/') || AUDIO_EXT.test(file.name)) return 'audio'
  if (file.type.startsWith('image/') || IMAGE_EXT.test(file.name)) return 'image'
  return null
}

const openInput = (blob: Blob) => new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })

function waitFor(el: HTMLMediaElement, event: string, timeoutMs = 15000) {
  return new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${event}`))
    }, timeoutMs)
    const ok = () => {
      cleanup()
      resolve()
    }
    const fail = () => {
      cleanup()
      reject(new Error(el.error?.message || 'This file could not be decoded by the browser'))
    }
    const cleanup = () => {
      window.clearTimeout(timer)
      el.removeEventListener(event, ok)
      el.removeEventListener('error', fail)
    }
    el.addEventListener(event, ok, { once: true })
    el.addEventListener('error', fail, { once: true })
  })
}

/** Duration via a media element, resolving MediaRecorder WebM files that report Infinity. */
async function elementDuration(el: HTMLMediaElement): Promise<number> {
  if (Number.isFinite(el.duration) && el.duration > 0) return el.duration
  el.currentTime = 1e7
  await waitFor(el, 'timeupdate').catch(() => undefined)
  const d = el.duration
  el.currentTime = 0
  return Number.isFinite(d) ? d : 0
}

async function probeVideoElement(url: string) {
  const v = document.createElement('video')
  v.preload = 'metadata'
  v.muted = true
  v.src = url
  await waitFor(v, 'loadedmetadata')
  const duration = await elementDuration(v)
  const result = { duration, width: v.videoWidth, height: v.videoHeight }
  v.removeAttribute('src')
  v.load()
  return result
}

async function probeAudioElement(url: string) {
  const a = document.createElement('audio')
  a.preload = 'metadata'
  a.src = url
  await waitFor(a, 'loadedmetadata')
  const duration = await elementDuration(a)
  a.removeAttribute('src')
  a.load()
  return duration
}

export async function probeFile(file: File, url: string): Promise<Asset> {
  const kind = classifyFile(file)
  if (!kind) throw new Error(`${file.name} is not a supported video, audio or image file`)
  const base = { id: newId(), kind, name: file.name, mime: file.type, size: file.size, createdAt: Date.now() }

  if (kind === 'image') {
    const bitmap = await createImageBitmap(file)
    const asset: Asset = { ...base, duration: 0, width: bitmap.width, height: bitmap.height, hasAudio: false }
    bitmap.close()
    return asset
  }

  // mediabunny gives exact duration, dimensions (rotation-aware) and audio presence.
  try {
    const input = openInput(file)
    const [video, audio] = await Promise.all([input.getPrimaryVideoTrack(), input.getPrimaryAudioTrack()])
    const duration = await input.computeDuration()
    if (kind === 'video' && video) {
      const asset: Asset = {
        ...base,
        duration,
        width: await video.getDisplayWidth(),
        height: await video.getDisplayHeight(),
        hasAudio: !!audio,
      }
      input.dispose()
      if (asset.width > 0 && asset.duration > 0) return asset
    } else if (kind === 'audio' && audio) {
      input.dispose()
      if (duration > 0) return { ...base, duration, width: 0, height: 0, hasAudio: true }
    } else {
      input.dispose()
    }
  } catch {
    // Unsupported container for WebCodecs; the element path below still works for anything the browser can play.
  }

  if (kind === 'video') {
    const meta = await probeVideoElement(url)
    return { ...base, ...meta, hasAudio: true }
  }
  return { ...base, duration: await probeAudioElement(url), width: 0, height: 0, hasAudio: true }
}

// ── Thumbnails ──────────────────────────────────────────────────────────────

const THUMB_HEIGHT = 72

function canvasToDataUrl(canvas: HTMLCanvasElement | OffscreenCanvas, w: number, h: number): string {
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  out.getContext('2d')!.drawImage(canvas as CanvasImageSource, 0, 0, w, h)
  return out.toDataURL('image/jpeg', 0.6)
}

/** One thumbnail every few seconds (denser for short clips), capped for memory. */
const thumbInterval = (duration: number) => Math.max(0.5, Math.min(10, duration / 40))

export async function generateThumbnails(asset: Asset, blob: Blob, url: string): Promise<Thumbnails> {
  if (asset.kind === 'audio') return { interval: 0, urls: [] }
  const aspect = asset.width && asset.height ? asset.width / asset.height : 16 / 9
  const w = Math.round(THUMB_HEIGHT * aspect)

  if (asset.kind === 'image') {
    const bitmap = await createImageBitmap(blob)
    const c = document.createElement('canvas')
    c.width = w
    c.height = THUMB_HEIGHT
    c.getContext('2d')!.drawImage(bitmap, 0, 0, w, THUMB_HEIGHT)
    bitmap.close()
    return { interval: 0, urls: [c.toDataURL('image/jpeg', 0.7)] }
  }

  const interval = thumbInterval(asset.duration)
  const times: number[] = []
  for (let t = 0; t < asset.duration; t += interval) times.push(t)
  if (!times.length) times.push(0)

  try {
    const input = openInput(blob)
    const track = await input.getPrimaryVideoTrack()
    if (track && (await track.canDecode())) {
      const sink = new CanvasSink(track, { width: w, height: THUMB_HEIGHT, fit: 'cover' })
      const urls: string[] = []
      let last = ''
      for await (const frame of sink.canvasesAtTimestamps(times)) {
        last = frame ? canvasToDataUrl(frame.canvas, w, THUMB_HEIGHT) : last
        urls.push(last)
      }
      input.dispose()
      if (urls.some(Boolean)) return { interval, urls: urls.map((u) => u || urls.find(Boolean)!) }
    } else {
      input.dispose()
    }
  } catch {
    // fall through to element seeking
  }

  return thumbnailsViaElement(url, times.slice(0, 24), interval * Math.max(1, times.length / 24), w)
}

async function thumbnailsViaElement(url: string, times: number[], interval: number, w: number): Promise<Thumbnails> {
  const v = document.createElement('video')
  v.muted = true
  v.preload = 'auto'
  v.src = url
  await waitFor(v, 'loadeddata')
  const c = document.createElement('canvas')
  c.width = w
  c.height = THUMB_HEIGHT
  const ctx = c.getContext('2d')!
  const urls: string[] = []
  for (const t of times) {
    v.currentTime = Math.min(t, Math.max(0, v.duration - 0.05))
    await waitFor(v, 'seeked').catch(() => undefined)
    ctx.drawImage(v, 0, 0, w, THUMB_HEIGHT)
    urls.push(c.toDataURL('image/jpeg', 0.6))
  }
  v.removeAttribute('src')
  v.load()
  return { interval, urls }
}

// ── Waveforms ───────────────────────────────────────────────────────────────

export const WAVEFORM_RATE = 100

/** Peak envelope at WAVEFORM_RATE values per second, streamed so long files never sit fully decoded in memory. */
export async function generateWaveform(asset: Asset, blob: Blob): Promise<Float32Array | null> {
  if (!asset.hasAudio || asset.kind === 'image') return null
  const total = Math.ceil(asset.duration * WAVEFORM_RATE) + 1
  const peaks = new Float32Array(total)

  try {
    const input = openInput(blob)
    const track = await input.getPrimaryAudioTrack()
    if (!track || !(await track.canDecode())) {
      input.dispose()
      return waveformViaDecode(blob, total)
    }
    const sink = new AudioBufferSink(track)
    for await (const { buffer, timestamp } of sink.buffers()) {
      const rate = buffer.sampleRate
      const ch0 = buffer.getChannelData(0)
      const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0
      const step = rate / WAVEFORM_RATE
      for (let i = 0; i < ch0.length; i++) {
        const bucket = Math.floor((timestamp + i / rate) * WAVEFORM_RATE)
        if (bucket < 0 || bucket >= total) continue
        const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]))
        if (v > peaks[bucket]) peaks[bucket] = v
        // Skip ahead within a bucket on very high sample rates; peaks only need coarse sampling.
        if (step > 400) i += 3
      }
    }
    input.dispose()
    return normalize(peaks)
  } catch {
    return waveformViaDecode(blob, total)
  }
}

async function waveformViaDecode(blob: Blob, total: number): Promise<Float32Array | null> {
  try {
    const ctx = new OfflineAudioContext(1, 1, 44100)
    const buffer = await ctx.decodeAudioData(await blob.arrayBuffer())
    const peaks = new Float32Array(total)
    const data = buffer.getChannelData(0)
    const perBucket = buffer.sampleRate / WAVEFORM_RATE
    for (let b = 0; b < total; b++) {
      let max = 0
      const from = Math.floor(b * perBucket)
      const to = Math.min(data.length, Math.floor((b + 1) * perBucket))
      for (let i = from; i < to; i++) max = Math.max(max, Math.abs(data[i]))
      peaks[b] = max
    }
    return normalize(peaks)
  } catch {
    return null
  }
}

function normalize(peaks: Float32Array) {
  let max = 0
  for (const v of peaks) max = Math.max(max, v)
  if (max > 0) for (let i = 0; i < peaks.length; i++) peaks[i] /= max
  return peaks
}
