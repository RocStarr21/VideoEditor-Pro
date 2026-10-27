/**
 * Export: renders the project frame by frame through the same Compositor the
 * preview uses, with exact decoded frames from mediabunny, and encodes with
 * WebCodecs. Also produces GIF, WAV, PNG and caption files.
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
  QUALITY_LOW,
  QUALITY_MEDIUM,
  QUALITY_VERY_HIGH,
  WebMOutputFormat,
  getFirstEncodableAudioCodec,
  getFirstEncodableVideoCodec,
  type Quality,
  type VideoCodec,
  type WrappedCanvas,
} from 'mediabunny'
import { clipEnd, isMediaClip, isTextClip, projectDuration, sourceTimeAt } from '../model/timeline'
import type { Asset, MediaClip, Project, TextClip } from '../model/types'
import { mixdownToChannels, mixdownWindows, type BlobLoader } from './audio-io'
import { Compositor, visualSpan, type Frame, type FrameSource } from './compositor'
import type { Lut3D } from './lut'
import { loadFonts } from './text'

export type ExportFormat = 'mp4' | 'webm' | 'gif' | 'wav' | 'png' | 'srt' | 'vtt' | 'ass'
export type ExportQuality = 'low' | 'medium' | 'high' | 'very_high'

export interface ExportSettings {
  format: ExportFormat
  /** Short-side resolution: 480, 720, 1080, 1440 (2K), 2160 (4K). */
  resolution: number
  fps: number
  quality: ExportQuality
  /** Preferred video codec; falls back to whatever the browser can encode. */
  codec: 'auto' | 'avc' | 'hevc' | 'vp9' | 'av1'
  includeAudio: boolean
  /** Export only this time range (CapCut "Export selected clips" / a marked range). */
  range: { start: number; end: number } | null
  /** Timeline time for PNG still export. */
  frameTime: number
}

export interface ExportResult {
  blob: Blob
  filename: string
  /** e.g. "H.264 + AAC, 1920×1080, 30 fps" */
  description: string
}

export interface ExportDeps {
  project: Project
  assets: Record<string, Asset | undefined>
  loadBlob: BlobLoader
  loadLut: (assetId: string) => Promise<Lut3D | null>
  onProgress: (progress: number, message: string) => void
  signal: AbortSignal
}

const QUALITIES: Record<ExportQuality, Quality> = {
  low: QUALITY_LOW,
  medium: QUALITY_MEDIUM,
  high: QUALITY_HIGH,
  very_high: QUALITY_VERY_HIGH,
}

const CODEC_LABEL: Record<string, string> = { avc: 'H.264', hevc: 'HEVC', vp9: 'VP9', av1: 'AV1', vp8: 'VP8', aac: 'AAC', opus: 'Opus', mp3: 'MP3' }

/** Output size for a short-side resolution, preserving the canvas aspect, even dimensions. */
export function exportSize(project: Project, resolution: number) {
  const { width, height } = project.canvas
  const short = Math.min(width, height)
  const s = resolution / short
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  return { width: even(width * s), height: even(height * s) }
}

const safeName = (name: string) => name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'export'

function abortIfNeeded(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException('Export canceled', 'AbortError')
}

// ── Frame source for export ─────────────────────────────────────────────────

interface ClipStream {
  /** Frame indices (ascending) at which this clip is drawn. */
  frames: number[]
  cursor: number
  next: () => Promise<Frame | null>
  current: Frame | null
  dispose: () => void
}

/**
 * Decodes exactly the frames each clip contributes, in order. mediabunny's
 * canvasesAtTimestamps decodes sequentially, which is far faster than seeking
 * a media element per frame; elements remain as a fallback.
 */
class ExportFrames implements FrameSource {
  private streams = new Map<string, ClipStream>()
  private images = new Map<string, Frame>()
  private luts = new Map<string, Lut3D | null>()
  private segmenter: import('./segmenter').PersonSegmenter | null = null

  constructor(
    private project: Project,
    private assets: Record<string, Asset | undefined>,
    private loadBlob: BlobLoader,
    private loadLut: (assetId: string) => Promise<Lut3D | null>,
  ) {}

  async prepare(start: number, fps: number, frameCount: number, maxEdge: number) {
    const hidden = new Set(this.project.tracks.filter((t) => t.hidden).map((t) => t.id))
    const bgAsset = this.project.canvas.background.type === 'image' ? this.project.canvas.background.assetId : null
    const imageIds = new Set<string>(bgAsset ? [bgAsset] : [])
    const lutIds = new Set<string>()

    for (const clip of this.project.clips) {
      if ('filter' in clip && clip.filter?.id.startsWith('lut:')) lutIds.add(clip.filter.id.slice(4))
      if (!isMediaClip(clip) || clip.type === 'audio' || hidden.has(clip.trackId)) continue
      if (clip.type === 'image') {
        imageIds.add(clip.assetId)
        continue
      }
      const span = visualSpan(this.project, clip)
      const frames: number[] = []
      const times: number[] = []
      const asset = this.assets[clip.assetId]
      const maxSource = asset ? Math.max(0, asset.duration - 0.001) : Infinity
      for (let f = 0; f < frameCount; f++) {
        const t = start + f / fps
        if (t >= span.start && t < span.end) {
          frames.push(f)
          times.push(Math.min(maxSource, Math.max(0, sourceTimeAt(clip, t))))
        }
      }
      if (!frames.length) continue
      const blob = await this.loadBlob(clip.assetId)
      if (!blob) continue
      this.streams.set(clip.id, await this.openStream(blob, frames, times, maxEdge))
    }

    for (const id of imageIds) {
      const blob = await this.loadBlob(id)
      if (!blob) continue
      const bitmap = await createImageBitmap(blob)
      this.images.set(id, { image: bitmap, width: bitmap.width, height: bitmap.height })
    }
    for (const id of lutIds) this.luts.set(id, await this.loadLut(id))
  }

  private async openStream(blob: Blob, frames: number[], times: number[], maxEdge: number): Promise<ClipStream> {
    try {
      const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS })
      const track = await input.getPrimaryVideoTrack()
      if (track && (await track.canDecode())) {
        const w = await track.getDisplayWidth()
        const h = await track.getDisplayHeight()
        const s = Math.min(1, maxEdge / Math.max(w, h))
        const sink = new CanvasSink(track, {
          width: Math.max(2, Math.round(w * s)),
          height: Math.max(2, Math.round(h * s)),
          fit: 'fill',
          poolSize: 2,
        })
        const iter = sink.canvasesAtTimestamps(times)
        let last: WrappedCanvas | null = null
        return {
          frames,
          cursor: 0,
          current: null,
          next: async () => {
            const r = await iter.next()
            if (!r.done && r.value) last = r.value
            return last ? { image: last.canvas as CanvasImageSource, width: last.canvas.width, height: last.canvas.height } : null
          },
          dispose: () => {
            void iter.return(undefined)
            input.dispose()
          },
        }
      }
      input.dispose()
    } catch {
      // fall through
    }
    return this.openElementStream(blob, frames, times)
  }

  /** Seeks a media element per frame — slower, but plays anything the browser can. */
  private async openElementStream(blob: Blob, frames: number[], times: number[]): Promise<ClipStream> {
    const url = URL.createObjectURL(blob)
    const v = document.createElement('video')
    v.muted = true
    v.preload = 'auto'
    v.src = url
    await new Promise<void>((resolve, reject) => {
      v.onloadeddata = () => resolve()
      v.onerror = () => reject(new Error('A clip could not be decoded for export'))
    })
    let i = 0
    return {
      frames,
      cursor: 0,
      current: null,
      next: async () => {
        const target = times[i++] ?? 0
        if (Math.abs(v.currentTime - target) > 1 / 240) {
          v.currentTime = target
          await new Promise<void>((resolve) => {
            v.onseeked = () => resolve()
          })
        }
        return { image: v, width: v.videoWidth, height: v.videoHeight }
      },
      dispose: () => {
        v.removeAttribute('src')
        v.load()
        URL.revokeObjectURL(url)
      },
    }
  }

  /** Advances every clip that is drawn at frame `f` to its frame for `f`. */
  async advance(f: number) {
    for (const s of this.streams.values()) {
      if (s.frames[s.cursor] === f) {
        s.current = await s.next()
        s.cursor++
      }
    }
  }

  videoFrame(clip: MediaClip): Frame | null {
    return this.streams.get(clip.id)?.current ?? null
  }

  image(assetId: string): Frame | null {
    return this.images.get(assetId) ?? null
  }

  lut(assetId: string): Lut3D | null {
    return this.luts.get(assetId) ?? null
  }

  personMask(_clip: MediaClip, frame: Frame, width: number, height: number, t: number): TexImageSource | null {
    return this.segmenter?.segment(frame.image as TexImageSource, width, height, t * 1000) as TexImageSource | null
  }

  async prepareSegmenter() {
    if (this.project.clips.some((c) => isMediaClip(c) && c.removeBackground)) {
      const { PersonSegmenter } = await import('./segmenter')
      this.segmenter = await PersonSegmenter.create()
    }
  }

  invalidate() {}

  dispose() {
    for (const s of this.streams.values()) s.dispose()
    for (const f of this.images.values()) (f.image as ImageBitmap).close?.()
    this.streams.clear()
    this.images.clear()
    this.segmenter?.close()
  }
}

// ── Shared helpers ──────────────────────────────────────────────────────────

function rangeOf(project: Project, settings: ExportSettings) {
  const end = projectDuration(project)
  if (!settings.range) return { start: 0, end }
  return { start: Math.max(0, settings.range.start), end: Math.min(end, settings.range.end) }
}

const textStyles = (p: Project) => p.clips.filter(isTextClip).map((c) => c.style)

const hasAudibleClips = (p: Project, assets: Record<string, Asset | undefined>) =>
  p.clips.some((c) => isMediaClip(c) && !c.muted && (c.type === 'audio' || (c.type === 'video' && !!assets[c.assetId]?.hasAudio)))

// ── Video (MP4 / WebM) ──────────────────────────────────────────────────────

async function exportVideo(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  const { project, signal, onProgress } = deps
  const { start, end } = rangeOf(project, settings)
  if (end - start <= 0) throw new Error('Nothing to export — add clips to the timeline first.')

  const { width, height } = exportSize(project, settings.resolution)
  const fps = settings.fps
  const frameCount = Math.max(1, Math.round((end - start) * fps))

  const format = settings.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' })
  const supported = format.getSupportedVideoCodecs()
  const preference: VideoCodec[] = settings.codec === 'auto' ? ['avc', 'hevc', 'vp9', 'av1', 'vp8'] : [settings.codec, 'avc', 'vp9', 'av1', 'vp8']
  const order = preference.filter((c, i, arr) => supported.includes(c) && arr.indexOf(c) === i)
  const codec = await getFirstEncodableVideoCodec(order, { width, height })
  if (!codec) throw new Error(`This browser cannot encode ${settings.format.toUpperCase()} at ${width}×${height}. Try a lower resolution or the other format.`)

  onProgress(0, 'Preparing media…')
  await loadFonts(textStyles(project))
  const frames = new ExportFrames(project, deps.assets, deps.loadBlob, deps.loadLut)
  const canvas = new OffscreenCanvas(width, height)
  const compositor = new Compositor()
  const output = new Output({ format, target: new BufferTarget() })

  try {
    await frames.prepare(start, fps, frameCount, Math.max(width, height))
    await frames.prepareSegmenter()

    const videoSource = new CanvasSource(canvas, { codec, bitrate: QUALITIES[settings.quality], keyFrameInterval: 2 })
    output.addVideoTrack(videoSource, { frameRate: fps })

    let audioSource: AudioBufferSource | null = null
    let audioCodec: string | null = null
    if (settings.includeAudio && hasAudibleClips(project, deps.assets)) {
      audioCodec = await getFirstEncodableAudioCodec(format.getSupportedAudioCodecs(), { numberOfChannels: 2, sampleRate: 48000 })
      if (audioCodec) {
        audioSource = new AudioBufferSource({ codec: audioCodec as never, bitrate: QUALITIES[settings.quality] })
        output.addAudioTrack(audioSource)
      }
    }

    await output.start()

    // Audio is produced in windows and fed just ahead of the video so the muxer
    // can interleave without buffering the whole program.
    const audioIter = audioSource ? mixdownWindows(project, deps.assets, deps.loadBlob, { start, end, sampleRate: 48000, signal }) : null
    let audioCursor = start
    const feedAudio = async (until: number) => {
      while (audioIter && audioSource && audioCursor < Math.min(end, until)) {
        const r = await audioIter.next()
        if (r.done) {
          audioCursor = end
          break
        }
        await audioSource.add(r.value)
        audioCursor += r.value.duration
      }
    }

    for (let f = 0; f < frameCount; f++) {
      abortIfNeeded(signal)
      const t = start + f / fps
      await feedAudio(t + 2)
      await frames.advance(f)
      compositor.render(canvas, project, t, frames)
      await videoSource.add(f / fps, 1 / fps)
      if (f % 5 === 0) onProgress(f / frameCount, `Rendering frame ${f + 1} of ${frameCount}`)
    }
    await feedAudio(end + 1)

    onProgress(0.99, 'Finalizing file…')
    await output.finalize()
    const buffer = (output.target as BufferTarget).buffer
    if (!buffer) throw new Error('The encoder produced no data.')
    onProgress(1, 'Done')

    return {
      blob: new Blob([buffer], { type: format.mimeType }),
      filename: `${safeName(project.name)}.${format.fileExtension.replace('.', '')}`,
      description: `${CODEC_LABEL[codec] ?? codec}${audioCodec ? ` + ${CODEC_LABEL[audioCodec] ?? audioCodec}` : ''}, ${width}×${height}, ${fps} fps`,
    }
  } catch (err) {
    if (output.state === 'started') await output.cancel().catch(() => undefined)
    throw err
  } finally {
    frames.dispose()
    compositor.dispose()
  }
}

// ── GIF ─────────────────────────────────────────────────────────────────────

async function exportGif(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  const { project, signal, onProgress } = deps
  const { start, end } = rangeOf(project, settings)
  if (end - start <= 0) throw new Error('Nothing to export — add clips to the timeline first.')
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc')

  // CapCut offers 320p and 640p GIFs; keep the frame rate modest to bound size.
  const { width, height } = exportSize(project, settings.resolution)
  const fps = Math.min(settings.fps, 15)
  const frameCount = Math.max(1, Math.round((end - start) * fps))
  const delay = Math.round(1000 / fps)

  await loadFonts(textStyles(project))
  const frames = new ExportFrames(project, deps.assets, deps.loadBlob, deps.loadLut)
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  const compositor = new Compositor()
  const gif = GIFEncoder()
  try {
    await frames.prepare(start, fps, frameCount, Math.max(width, height))
    await frames.prepareSegmenter()
    for (let f = 0; f < frameCount; f++) {
      abortIfNeeded(signal)
      await frames.advance(f)
      compositor.render(canvas, project, start + f / fps, frames)
      const { data } = ctx.getImageData(0, 0, width, height)
      const palette = quantize(data, 256)
      gif.writeFrame(applyPalette(data, palette), width, height, { palette, delay })
      if (f % 3 === 0) onProgress(f / frameCount, `Encoding GIF frame ${f + 1} of ${frameCount}`)
    }
    gif.finish()
    onProgress(1, 'Done')
    return {
      blob: new Blob([gif.bytes() as Uint8Array<ArrayBuffer>], { type: 'image/gif' }),
      filename: `${safeName(project.name)}.gif`,
      description: `GIF, ${width}×${height}, ${fps} fps`,
    }
  } finally {
    frames.dispose()
    compositor.dispose()
  }
}

// ── Audio, still frame, captions ────────────────────────────────────────────

async function exportWav(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  const { project, onProgress, signal } = deps
  const { start, end } = rangeOf(project, settings)
  if (end - start <= 0) throw new Error('Nothing to export — add clips to the timeline first.')
  if (!hasAudibleClips(project, deps.assets)) throw new Error('The timeline has no audible clips.')
  const mix = await mixdownToChannels(project, deps.assets, deps.loadBlob, {
    start,
    end,
    sampleRate: 48000,
    signal,
    onProgress: (p) => onProgress(p * 0.95, 'Mixing audio…'),
  })
  const { encodeWav } = await import('./audio-dsp')
  onProgress(1, 'Done')
  return { blob: encodeWav(mix.channels, mix.sampleRate), filename: `${safeName(project.name)}.wav`, description: 'WAV, 48 kHz, 16-bit stereo' }
}

async function exportPng(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  const { project } = deps
  const { width, height } = exportSize(project, settings.resolution)
  await loadFonts(textStyles(project))
  const fps = project.fps
  const frames = new ExportFrames(project, deps.assets, deps.loadBlob, deps.loadLut)
  const canvas = new OffscreenCanvas(width, height)
  const compositor = new Compositor()
  try {
    // Prepare a one-frame "range" at the requested time.
    await frames.prepare(settings.frameTime, fps, 1, Math.max(width, height))
    await frames.prepareSegmenter()
    await frames.advance(0)
    compositor.render(canvas, project, settings.frameTime, frames)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const stamp = settings.frameTime.toFixed(2).replace('.', '_')
    return { blob, filename: `${safeName(project.name)}-${stamp}s.png`, description: `PNG still, ${width}×${height}` }
  } finally {
    frames.dispose()
    compositor.dispose()
  }
}

/** Caption cues from caption text clips (falls back to all text clips when none are marked as captions). */
export function captionCues(project: Project) {
  const text = project.clips.filter(isTextClip)
  const captions = text.some((c) => c.isCaption) ? text.filter((c) => c.isCaption) : text.filter((c) => !c.isSticker)
  return captions
    .sort((a, b) => a.start - b.start)
    .map((c: TextClip) => ({
      start: c.start,
      end: clipEnd(c),
      text: c.text,
      words: c.words?.map((w) => ({ text: w.text, start: c.start + w.start, end: c.start + w.end })),
    }))
}

async function exportCaptions(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  const cues = captionCues(deps.project)
  if (!cues.length) throw new Error('There are no captions or text clips to export.')
  const { serializeAss, serializeSrt, serializeVtt } = await import('./captions')
  const first = deps.project.clips.find((c): c is TextClip => isTextClip(c) && c.isCaption)
  const body =
    settings.format === 'vtt'
      ? serializeVtt(cues)
      : settings.format === 'ass'
        ? serializeAss(cues, { width: deps.project.canvas.width, height: deps.project.canvas.height, fontFamily: first?.style.fontFamily, fontSize: first?.style.fontSize })
        : serializeSrt(cues)
  return {
    blob: new Blob([body], { type: settings.format === 'vtt' ? 'text/vtt' : settings.format === 'ass' ? 'text/plain' : 'application/x-subrip' }),
    filename: `${safeName(deps.project.name)}.${settings.format}`,
    description: `${cues.length} captions`,
  }
}

export async function runExport(deps: ExportDeps, settings: ExportSettings): Promise<ExportResult> {
  abortIfNeeded(deps.signal)
  switch (settings.format) {
    case 'mp4':
    case 'webm':
      return exportVideo(deps, settings)
    case 'gif':
      return exportGif(deps, settings)
    case 'wav':
      return exportWav(deps, settings)
    case 'png':
      return exportPng(deps, settings)
    case 'srt':
    case 'vtt':
    case 'ass':
      return exportCaptions(deps, settings)
  }
}

/** Which video codecs this browser can encode at a size, for the export dialog. */
export async function probeEncoders(width: number, height: number) {
  const result: Record<string, boolean> = {}
  for (const codec of ['avc', 'hevc', 'vp9', 'av1'] as VideoCodec[]) {
    result[codec] = !!(await getFirstEncodableVideoCodec([codec], { width, height }).catch(() => null))
  }
  return result
}
