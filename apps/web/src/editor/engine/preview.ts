/**
 * Real-time preview: drives one media element per nearby clip from a master
 * clock, mixes audio through Web Audio (per-clip gain, fades, voice effects,
 * noise reduction) and renders frames with the Compositor.
 */
import { gainAt } from '../model/animation'
import { clipEnd, isMediaClip, sourceTimeAt } from '../model/timeline'
import type { Asset, MediaClip, Project, VoiceEffect } from '../model/types'
import { Compositor, visualSpan, type Frame, type FrameSource } from './compositor'
import type { Lut3D } from './lut'

/** Elements are created this far ahead of a clip and kept this long after it. */
const PREROLL = 2
const KEEP_AFTER = 8
/** Re-seek a playing element when it drifts further than this from the clock. */
const DRIFT_TOLERANCE = 0.2
/** Media elements play reliably between these rates; beyond them we seek frame by frame. */
const MIN_ELEMENT_RATE = 0.0625
const MAX_ELEMENT_RATE = 16

interface ClipMedia {
  clipId: string
  el: HTMLVideoElement | HTMLAudioElement
  url: string
  source: MediaElementAudioSourceNode | null
  chainInput: AudioNode | null
  gain: GainNode | null
  voiceEffect: VoiceEffect
  denoise: boolean
  disposeChain: (() => void) | null
  pendingSeek: number | null
}

export interface PreviewHost {
  getProject(): Project
  getAssets(): Record<string, Asset>
  getAssetUrl(assetId: string): string | undefined
  onTime(t: number): void
  onEnded(): void
}

export class PreviewEngine implements FrameSource {
  private compositor = new Compositor()
  private canvas: HTMLCanvasElement | null = null
  private media = new Map<string, ClipMedia>()
  private images = new Map<string, { img: HTMLImageElement; ready: boolean }>()
  private luts = new Map<string, Lut3D | 'loading'>()
  private audioCtx: AudioContext | null = null
  private master: GainNode | null = null
  private raf = 0
  private renderQueued = false
  private playing = false
  private clockStartWall = 0
  private clockStartT = 0
  private time = 0
  private segmenter: import('./segmenter').PersonSegmenter | null = null
  private segmenterState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private lutLoader: ((assetId: string) => Promise<Lut3D | null>) | null = null
  onSegmenterStatus: ((status: 'loading' | 'ready' | 'failed', message?: string) => void) | null = null

  constructor(private host: PreviewHost) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  attach(canvas: HTMLCanvasElement) {
    this.canvas = canvas
    this.requestRender()
  }

  detach() {
    this.canvas = null
  }

  setLutLoader(loader: (assetId: string) => Promise<Lut3D | null>) {
    this.lutLoader = loader
  }

  dispose() {
    this.pause()
    for (const m of this.media.values()) this.disposeMedia(m)
    this.media.clear()
    this.compositor.dispose()
    this.segmenter?.close()
    void this.audioCtx?.close()
    this.audioCtx = null
  }

  /** Silences preview output without touching clip gains (used while recording a voiceover). */
  setMuted(muted: boolean) {
    const ctx = this.ensureAudio()
    this.master?.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02)
  }

  get isPlaying() {
    return this.playing
  }

  get currentTime() {
    return this.time
  }

  // ── Transport ─────────────────────────────────────────────────────────────

  private ensureAudio() {
    if (!this.audioCtx) {
      // RNNoise needs 48 kHz; using it everywhere keeps one graph for all clips.
      this.audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' })
      this.master = this.audioCtx.createGain()
      this.master.connect(this.audioCtx.destination)
    }
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume()
    return this.audioCtx
  }

  play() {
    if (this.playing) return
    const project = this.host.getProject()
    const end = project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
    if (end <= 0) return
    if (this.time >= end - 1 / project.fps) this.time = 0
    this.ensureAudio()
    this.playing = true
    this.clockStartWall = performance.now()
    this.clockStartT = this.time
    this.loop()
  }

  pause() {
    if (!this.playing) return
    this.playing = false
    cancelAnimationFrame(this.raf)
    for (const m of this.media.values()) m.el.pause()
    this.requestRender()
  }

  toggle() {
    if (this.playing) this.pause()
    else this.play()
  }

  seek(t: number) {
    this.time = Math.max(0, t)
    if (this.playing) {
      this.clockStartWall = performance.now()
      this.clockStartT = this.time
    }
    this.sync(this.playing ? this.time : this.heldTime(this.time), this.playing, true)
    this.requestRender()
  }

  private loop = () => {
    if (!this.playing) return
    const project = this.host.getProject()
    const end = project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
    const t = this.clockStartT + (performance.now() - this.clockStartWall) / 1000
    if (t >= end) {
      this.time = end
      this.pause()
      this.host.onTime(end)
      this.host.onEnded()
      return
    }
    this.time = t
    this.sync(t, true, false)
    this.renderNow()
    this.host.onTime(t)
    this.raf = requestAnimationFrame(this.loop)
  }

  /** Schedules a single render (scrubbing, edits) when not playing. */
  requestRender() {
    if (this.playing || this.renderQueued) return
    this.renderQueued = true
    requestAnimationFrame(() => {
      this.renderQueued = false
      if (!this.playing) {
        const t = this.heldTime(this.time)
        this.sync(t, false, false)
        this.renderNow(t)
      }
    })
  }

  /**
   * Nothing is on screen at exactly the end of the timeline, so a paused
   * playhead there shows the last frame instead of black, as CapCut does.
   */
  private heldTime(t: number) {
    const project = this.host.getProject()
    const end = project.clips.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
    return end > 0 && t >= end ? Math.max(0, end - 0.5 / project.fps) : t
  }

  invalidate() {
    this.requestRender()
  }

  private renderNow(t = this.time) {
    const canvas = this.canvas
    if (!canvas) return
    this.compositor.render(canvas, this.host.getProject(), t, this)
  }

  /** Renders the frame at `t` into an arbitrary canvas (used for freeze frame and PNG export of the current frame). */
  renderTo(canvas: HTMLCanvasElement | OffscreenCanvas, t: number) {
    this.compositor.render(canvas, this.host.getProject(), t, this)
  }

  bounds(clipId: string, t: number) {
    const project = this.host.getProject()
    const clip = project.clips.find((c) => c.id === clipId)
    return clip ? this.compositor.bounds(project, this.host.getAssets(), clip, t) : null
  }

  // ── Media sync ────────────────────────────────────────────────────────────

  private sync(t: number, playing: boolean, forceSeek: boolean) {
    const project = this.host.getProject()
    const assets = this.host.getAssets()
    const live = new Set<string>()
    const trackById = new Map(project.tracks.map((tr) => [tr.id, tr]))

    for (const clip of project.clips) {
      if (!isMediaClip(clip) || clip.type === 'image') continue
      const asset = assets[clip.assetId]
      const url = this.host.getAssetUrl(clip.assetId)
      if (!asset || !url) continue
      const track = trackById.get(clip.trackId)
      const span = visualSpan(project, clip)
      const near = t >= span.start - PREROLL && t < span.end + KEEP_AFTER
      if (!near) continue
      live.add(clip.id)

      const m = this.getMedia(clip, url)
      const visualActive = t >= span.start && t < span.end
      const audible = t >= clip.start && t < clipEnd(clip)
      const desired = Math.min(Math.max(0, sourceTimeAt(clip, t)), Math.max(0, asset.duration - 0.02))

      // Hiding a track only hides visuals (CapCut's eye icon); the speaker icon mutes.
      const gain = track?.muted ? 0 : audible ? gainAt(clip, t) : 0
      this.updateAudio(m, clip, gain, playing)

      if (visualActive || audible) {
        const rate = clip.speed
        const elementRate = rate >= MIN_ELEMENT_RATE && rate <= MAX_ELEMENT_RATE
        if (playing && elementRate && t >= clip.start && t < clipEnd(clip)) {
          if (m.el.playbackRate !== rate) m.el.playbackRate = rate
          m.el.preservesPitch = clip.preservePitch
          if (m.el.paused) {
            this.seekElement(m, desired)
            void m.el.play().catch(() => undefined)
          } else if (Math.abs(m.el.currentTime - desired) > DRIFT_TOLERANCE * Math.max(1, rate)) {
            this.seekElement(m, desired)
          }
        } else {
          // Paused, out-of-range speed, or inside a transition overlap: show the exact frame.
          if (!m.el.paused) m.el.pause()
          if (forceSeek || Math.abs(m.el.currentTime - desired) > 1 / 120) this.seekElement(m, desired)
        }
      } else {
        if (!m.el.paused) m.el.pause()
        // Pre-roll: park upcoming clips on their first frame so playback starts clean.
        if (t < span.start && Math.abs(m.el.currentTime - clip.sourceIn) > 0.05) this.seekElement(m, Math.max(0, clip.sourceIn))
      }
    }

    for (const [id, m] of this.media) {
      if (!live.has(id)) {
        this.disposeMedia(m)
        this.media.delete(id)
      }
    }
  }

  private seekElement(m: ClipMedia, time: number) {
    if (m.el.seeking) {
      m.pendingSeek = time
      return
    }
    m.pendingSeek = null
    m.el.currentTime = time
  }

  private getMedia(clip: MediaClip, url: string): ClipMedia {
    let m = this.media.get(clip.id)
    if (m && m.url !== url) {
      this.disposeMedia(m)
      m = undefined
    }
    if (m) return m

    const el = clip.type === 'audio' ? document.createElement('audio') : document.createElement('video')
    el.preload = 'auto'
    el.src = url
    if (el instanceof HTMLVideoElement) {
      el.playsInline = true
      el.disablePictureInPicture = true
    }
    const media: ClipMedia = {
      clipId: clip.id,
      el,
      url,
      source: null,
      chainInput: null,
      gain: null,
      voiceEffect: 'none',
      denoise: false,
      disposeChain: null,
      pendingSeek: null,
    }
    el.addEventListener('seeked', () => {
      if (media.pendingSeek !== null) {
        const next = media.pendingSeek
        media.pendingSeek = null
        el.currentTime = next
      }
      this.requestRender()
    })
    el.addEventListener('loadeddata', () => this.requestRender())
    this.media.set(clip.id, media)
    return media
  }

  private disposeMedia(m: ClipMedia) {
    m.el.pause()
    m.disposeChain?.()
    m.source?.disconnect()
    m.gain?.disconnect()
    m.el.removeAttribute('src')
    m.el.load()
  }

  // ── Audio graph ───────────────────────────────────────────────────────────

  private updateAudio(m: ClipMedia, clip: MediaClip, gain: number, playing: boolean) {
    const asset = this.host.getAssets()[clip.assetId]
    const hasAudio = clip.type === 'audio' || !!asset?.hasAudio
    if (!hasAudio) {
      m.el.muted = true
      return
    }
    if (!this.audioCtx || !this.master) {
      // No audio context until the first play(); stay silent while scrubbing.
      m.el.muted = true
      return
    }
    m.el.muted = false
    if (!m.source) {
      m.source = this.audioCtx.createMediaElementSource(m.el)
      m.gain = this.audioCtx.createGain()
      m.gain.connect(this.master)
      m.source.connect(m.gain)
    }
    if (m.voiceEffect !== clip.voiceEffect || m.denoise !== clip.denoise) void this.rebuildChain(m, clip)
    const g = playing ? gain : 0
    m.gain!.gain.setTargetAtTime(g, this.audioCtx.currentTime, 0.015)
  }

  /** Inserts the clip's voice effect and noise reduction between the element and its gain. */
  private async rebuildChain(m: ClipMedia, clip: MediaClip) {
    if (!this.audioCtx || !m.source || !m.gain) return
    m.voiceEffect = clip.voiceEffect
    m.denoise = clip.denoise
    m.disposeChain?.()
    m.disposeChain = null
    m.source.disconnect()

    const ctx = this.audioCtx
    let head: AudioNode = m.source
    const disposers: Array<() => void> = []
    try {
      if (clip.denoise) {
        const { createDenoiseNode, destroyDenoiseNode } = await import('./denoise')
        const node = await createDenoiseNode(ctx)
        head.connect(node)
        head = node
        // disconnect() alone leaves the worklet processing; destroy frees it.
        disposers.push(() => destroyDenoiseNode(node))
      }
      if (clip.voiceEffect !== 'none') {
        const { buildVoiceEffect } = await import('./voice-effects')
        const chain = buildVoiceEffect(ctx, clip.voiceEffect)
        head.connect(chain.input)
        head = chain.output
        disposers.push(() => chain.dispose())
      }
    } catch (err) {
      console.warn('Audio effect unavailable, playing dry:', err)
    }
    head.connect(m.gain)
    m.disposeChain = () => disposers.forEach((d) => d())
  }

  // ── FrameSource ───────────────────────────────────────────────────────────

  videoFrame(clip: MediaClip): Frame | null {
    const m = this.media.get(clip.id)
    const el = m?.el
    if (!(el instanceof HTMLVideoElement) || el.readyState < 2 || !el.videoWidth) return null
    return { image: el, width: el.videoWidth, height: el.videoHeight }
  }

  image(assetId: string): Frame | null {
    let entry = this.images.get(assetId)
    if (!entry) {
      const url = this.host.getAssetUrl(assetId)
      if (!url) return null
      const img = new Image()
      entry = { img, ready: false }
      this.images.set(assetId, entry)
      img.onload = () => {
        entry!.ready = true
        this.requestRender()
      }
      img.src = url
    }
    return entry.ready ? { image: entry.img, width: entry.img.naturalWidth, height: entry.img.naturalHeight } : null
  }

  lut(assetId: string): Lut3D | null {
    const cached = this.luts.get(assetId)
    if (cached && cached !== 'loading') return cached
    if (!cached && this.lutLoader) {
      this.luts.set(assetId, 'loading')
      void this.lutLoader(assetId).then((lut) => {
        if (lut) this.luts.set(assetId, lut)
        else this.luts.delete(assetId)
        this.requestRender()
      })
    }
    return null
  }

  personMask(_clip: MediaClip, frame: Frame, width: number, height: number, t: number): TexImageSource | null {
    if (this.segmenterState === 'idle') {
      this.segmenterState = 'loading'
      this.onSegmenterStatus?.('loading')
      void import('./segmenter')
        .then(({ PersonSegmenter }) => PersonSegmenter.create())
        .then((s) => {
          this.segmenter = s
          this.segmenterState = 'ready'
          this.onSegmenterStatus?.('ready')
          this.requestRender()
        })
        .catch((err: Error) => {
          this.segmenterState = 'failed'
          this.onSegmenterStatus?.('failed', err.message)
        })
    }
    if (!this.segmenter) return null
    return this.segmenter.segment(frame.image as TexImageSource, width, height, t * 1000) as TexImageSource | null
  }

  /** Forgets decoded images/LUTs for assets that changed (e.g. after reverse). */
  forgetAsset(assetId: string) {
    this.images.delete(assetId)
    this.luts.delete(assetId)
  }
}
