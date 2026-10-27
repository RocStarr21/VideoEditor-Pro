/**
 * Renders one frame of a project at timeline time `t` onto a 2D canvas.
 *
 * Draw order matches CapCut: canvas background, then visual tracks from the
 * bottom (main track) up through overlays and text, then full-frame effect
 * tracks applied over everything. The same code path renders preview frames
 * and export frames; only the FrameSource differs.
 */
import { resolveVisual } from '../model/animation'
import { defaultTextStyle } from '../model/defaults'
import { EASINGS } from '../model/keyframes'
import { clipEnd, clipsOnTrack, isMediaClip, isTextClip, nextAdjacent, sourceTimeAt } from '../model/timeline'
import type { Asset, BlendMode, Clip, EffectClip, Mask, MediaClip, Project, ShapeClip, TextClip, Track, TransitionName } from '../model/types'
import { isGradeNeutral, resolveColorGrade } from './filters'
import { ClipProcessor, EffectProcessor, chromaFromKey } from './gl'
import type { Lut3D } from './lut'
import { traceShape } from './shapes'
import { drawText, ensureFont, fontString, layoutText, textBoxSize } from './text'

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas
type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface Frame {
  image: CanvasImageSource
  width: number
  height: number
}

/** Supplies decoded media to the compositor; preview and export implement it differently. */
export interface FrameSource {
  videoFrame(clip: MediaClip, sourceTime: number): Frame | null
  image(assetId: string): Frame | null
  lut(assetId: string): Lut3D | null
  personMask(clip: MediaClip, frame: Frame, width: number, height: number, t: number): TexImageSource | null
  /** Something became ready asynchronously (font, frame); render again. */
  invalidate(): void
}

const BLEND_OP: Record<BlendMode, GlobalCompositeOperation> = {
  normal: 'source-over',
  multiply: 'multiply',
  screen: 'screen',
  overlay: 'overlay',
  darken: 'darken',
  lighten: 'lighten',
  'color-dodge': 'color-dodge',
  'color-burn': 'color-burn',
  'soft-light': 'soft-light',
  'hard-light': 'hard-light',
  difference: 'difference',
  exclusion: 'exclusion',
}

/** Longest edge the GPU stage processes at; frames are scaled down to the drawn size first. */
const MAX_PROCESS_EDGE = 2048

function makeCanvas(w: number, h: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

type TrackItem =
  | { kind: 'single'; clip: Clip }
  | { kind: 'pair'; from: MediaClip; to: MediaClip; name: TransitionName; progress: number }

/** What a visual track shows at `t`: one clip, a transition between two, or nothing. */
export function trackItemAt(project: Project, track: Track, t: number): TrackItem | null {
  const clips = clipsOnTrack(project, track.id)
  for (const a of clips) {
    if (!isMediaClip(a) || !a.transitionOut) continue
    const half = a.transitionOut.duration / 2
    const cut = clipEnd(a)
    if (t >= cut - half && t < cut + half) {
      const b = nextAdjacent(project, a)
      if (b && isMediaClip(b)) {
        return { kind: 'pair', from: a, to: b, name: a.transitionOut.name, progress: (t - (cut - half)) / (half * 2) }
      }
    }
  }
  const active = clips.find((c) => t >= c.start && t < clipEnd(c))
  return active ? { kind: 'single', clip: active } : null
}

/**
 * Span during which a clip is on screen, including the overlap a transition
 * adds into its neighbours. Preview and export both decode frames for this span.
 */
export function visualSpan(project: Project, clip: MediaClip) {
  let start = clip.start
  let end = clipEnd(clip)
  if (clip.transitionOut) end += clip.transitionOut.duration / 2
  const prev = project.clips.find(
    (c) => c.trackId === clip.trackId && isMediaClip(c) && c.transitionOut && Math.abs(clipEnd(c) - clip.start) < 1e-3,
  ) as MediaClip | undefined
  if (prev?.transitionOut) start -= prev.transitionOut.duration / 2
  return { start, end }
}

/** Media fitted into the canvas (CapCut "Fit"), before the clip's own scale. */
function fitScale(project: Project, cropW: number, cropH: number) {
  return Math.min(project.canvas.width / cropW, project.canvas.height / cropH)
}

export class Compositor {
  private clipGl: ClipProcessor | null | undefined
  private fxGl: EffectProcessor | null | undefined
  private layers: AnyCanvas[] = []
  private scratch: AnyCanvas | null = null
  private measureCtx: Ctx | null = null

  private gl() {
    if (this.clipGl === undefined) this.clipGl = ClipProcessor.isSupported() ? new ClipProcessor() : null
    return this.clipGl
  }

  private fx() {
    if (this.fxGl === undefined) this.fxGl = EffectProcessor.isSupported() ? new EffectProcessor() : null
    return this.fxGl
  }

  private layer(i: number, w: number, h: number): { canvas: AnyCanvas; ctx: Ctx } {
    let c = this.layers[i]
    if (!c || c.width !== w || c.height !== h) {
      c = makeCanvas(w, h)
      this.layers[i] = c
    }
    const ctx = c.getContext('2d') as Ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.clearRect(0, 0, w, h)
    return { canvas: c, ctx }
  }

  render(target: AnyCanvas, project: Project, t: number, src: FrameSource) {
    const W = target.width
    const H = target.height
    const k = W / project.canvas.width
    const ctx = target.getContext('2d') as Ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.globalCompositeOperation = 'source-over'
    ctx.filter = 'none'
    ctx.clearRect(0, 0, W, H)

    this.drawBackground(ctx, project, t, src, W, H)

    const visual = project.tracks.filter((tr) => (tr.kind === 'video' || tr.kind === 'text') && !tr.hidden).reverse()
    for (const track of visual) {
      const item = trackItemAt(project, track, t)
      if (!item) continue
      if (item.kind === 'single') {
        this.drawClip(ctx, item.clip, t, project, src, k, W, H)
      } else {
        const a = this.layer(0, W, H)
        const b = this.layer(1, W, H)
        this.drawClip(a.ctx, item.from, t, project, src, k, W, H)
        this.drawClip(b.ctx, item.to, t, project, src, k, W, H)
        this.composeTransition(ctx, a.canvas, b.canvas, item.name, item.progress, W, H)
      }
    }

    const effectTracks = project.tracks.filter((tr) => tr.kind === 'effect' && !tr.hidden).reverse()
    for (const track of effectTracks) {
      const clip = clipsOnTrack(project, track.id).find((c) => t >= c.start && t < clipEnd(c)) as EffectClip | undefined
      if (clip) this.applyEffect(target, ctx, clip, t, src, W, H)
    }
  }

  // ── Background ────────────────────────────────────────────────────────────

  private drawBackground(ctx: Ctx, project: Project, t: number, src: FrameSource, W: number, H: number) {
    const bg = project.canvas.background
    if (bg.type === 'color') {
      ctx.fillStyle = bg.color
      ctx.fillRect(0, 0, W, H)
      return
    }
    if (bg.type === 'gradient') {
      // CSS angle convention: 0° points up, 90° points right.
      const a = (bg.angle * Math.PI) / 180
      const len = Math.abs(W * Math.sin(a)) + Math.abs(H * Math.cos(a))
      const dx = (Math.sin(a) * len) / 2
      const dy = (-Math.cos(a) * len) / 2
      const g = ctx.createLinearGradient(W / 2 - dx, H / 2 - dy, W / 2 + dx, H / 2 + dy)
      g.addColorStop(0, bg.from)
      g.addColorStop(1, bg.to)
      ctx.fillStyle = g
      ctx.fillRect(0, 0, W, H)
      return
    }
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, W, H)

    let frame: Frame | null = null
    if (bg.type === 'image') {
      frame = src.image(bg.assetId)
    } else {
      // CapCut "Blur canvas": the main-track clip, scaled to cover and blurred, fills the letterbox.
      const main = project.tracks.find((tr) => tr.isMain)
      const item = main ? trackItemAt(project, main, t) : null
      const clip = item ? (item.kind === 'single' ? item.clip : item.from) : undefined
      if (isMediaClip(clip) && clip.type !== 'audio') {
        frame = clip.type === 'image' ? src.image(clip.assetId) : src.videoFrame(clip, Math.max(0, sourceTimeAt(clip, t)))
      }
    }
    if (!frame) return

    const cover = Math.max(W / frame.width, H / frame.height)
    const dw = frame.width * cover
    const dh = frame.height * cover
    ctx.save()
    if (bg.type === 'blur') {
      ctx.filter = `blur(${Math.max(4, (bg.amount / 100) * 60 * (W / project.canvas.width))}px)`
      // Overscan so the blur does not fade to transparent at the edges.
      ctx.drawImage(frame.image, (W - dw * 1.1) / 2, (H - dh * 1.1) / 2, dw * 1.1, dh * 1.1)
    } else {
      ctx.drawImage(frame.image, (W - dw) / 2, (H - dh) / 2, dw, dh)
    }
    ctx.restore()
  }

  // ── Clips ─────────────────────────────────────────────────────────────────

  private drawClip(ctx: Ctx, clip: Clip, t: number, project: Project, src: FrameSource, k: number, W: number, H: number) {
    if (isTextClip(clip)) this.drawTextClip(ctx, clip, t, project, src, k)
    else if (clip.type === 'shape') this.drawShapeClip(ctx, clip, t, project, src, k, W, H)
    else if (isMediaClip(clip) && clip.type !== 'audio') this.drawMediaClip(ctx, clip, t, project, src, k, W, H)
  }

  /** Vector shapes render through a layer so fill, stroke and mask combine before opacity and blending apply. */
  private drawShapeClip(ctx: Ctx, clip: ShapeClip, t: number, project: Project, src: FrameSource, k: number, W: number, H: number) {
    const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
    if (v.opacity <= 0.001) return
    const dw = Math.max(1, Math.abs(clip.width * v.scale * v.scaleX * k))
    const dh = Math.max(1, Math.abs(clip.height * v.scale * v.scaleY * k))
    const dest = this.layer(2, W, H).ctx
    dest.save()
    dest.translate(W / 2 + v.x * k, H / 2 + v.y * k)
    dest.rotate((v.rotation * Math.PI) / 180)
    dest.scale(v.flipH ? -1 : 1, v.flipV ? -1 : 1)
    if (v.blur > 0.5) dest.filter = `blur(${v.blur * k}px)`
    traceShape(dest, clip.shape, clip, dw, dh)
    if (clip.fill !== 'transparent') {
      dest.fillStyle = clip.fill
      dest.fill()
    }
    const sw = clip.strokeWidth * v.scale * k
    if (sw > 0) {
      dest.strokeStyle = clip.strokeColor
      dest.lineJoin = 'round'
      if (clip.strokeAlign === 'center') {
        dest.lineWidth = sw
        dest.stroke()
      } else if (clip.strokeAlign === 'inside') {
        dest.save()
        dest.clip()
        dest.lineWidth = sw * 2
        dest.stroke()
        dest.restore()
      } else {
        // Outside: a double-width stroke with its inner half erased, then the fill restored on top.
        dest.lineWidth = sw * 2
        dest.stroke()
        dest.globalCompositeOperation = 'destination-out'
        dest.fill()
        dest.globalCompositeOperation = 'source-over'
        if (clip.fill !== 'transparent') {
          dest.fillStyle = clip.fill
          dest.fill()
        }
      }
    }
    dest.filter = 'none'
    if (clip.mask.shape !== 'none') this.applyMask(dest, clip.mask, dw, dh, k, src)
    dest.restore()
    ctx.save()
    ctx.globalAlpha = v.opacity
    ctx.globalCompositeOperation = BLEND_OP[clip.blend]
    ctx.drawImage(this.layers[2] as CanvasImageSource, 0, 0)
    ctx.restore()
  }

  private drawMediaClip(ctx: Ctx, clip: MediaClip, t: number, project: Project, src: FrameSource, k: number, W: number, H: number) {
    const frame = clip.type === 'image' ? src.image(clip.assetId) : src.videoFrame(clip, Math.max(0, sourceTimeAt(clip, t)))
    if (!frame || !frame.width || !frame.height) return

    const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
    if (v.opacity <= 0.001) return

    const crop = clip.crop
    const cropW = crop.w * frame.width
    const cropH = crop.h * frame.height
    const fit = fitScale(project, cropW, cropH)
    const dw = cropW * fit * v.scale * v.scaleX * k
    const dh = cropH * fit * v.scale * v.scaleY * k

    // GPU stage: color grade, LUT, chroma key, background removal.
    let image: CanvasImageSource = frame.image
    let iw = frame.width
    let ih = frame.height
    const grade = resolveColorGrade(clip.adjust, clip.filter)
    const lut = clip.filter?.id.startsWith('lut:') ? src.lut(clip.filter.id.slice(4)) : null
    const chroma = chromaFromKey(clip.chroma)
    const gl = this.gl()
    if (gl && (!isGradeNeutral(grade) || lut || chroma || clip.removeBackground)) {
      const scale = Math.min(1, Math.max(Math.abs(dw) / Math.max(1, cropW), Math.abs(dh) / Math.max(1, cropH)) * 1.25)
      const longEdge = Math.max(frame.width, frame.height) * scale
      const s = scale * Math.min(1, MAX_PROCESS_EDGE / Math.max(1, longEdge))
      iw = Math.max(2, Math.round(frame.width * s))
      ih = Math.max(2, Math.round(frame.height * s))
      const mask = clip.removeBackground ? src.personMask(clip, frame, iw, ih, t) : null
      image = gl.process(frame.image as TexImageSource, {
        width: iw,
        height: ih,
        grade: isGradeNeutral(grade) ? null : grade,
        lut,
        lutIntensity: (clip.filter?.intensity ?? 100) / 100,
        chroma,
        alphaMask: mask,
        time: t,
      }) as CanvasImageSource
    }

    const masked = clip.mask.shape !== 'none'
    const dest = masked ? this.layer(2, W, H).ctx : ctx
    dest.save()
    dest.translate(W / 2 + v.x * k, H / 2 + v.y * k)
    dest.rotate((v.rotation * Math.PI) / 180)
    dest.scale(v.flipH ? -1 : 1, v.flipV ? -1 : 1)
    if (!masked) {
      dest.globalAlpha = v.opacity
      dest.globalCompositeOperation = BLEND_OP[clip.blend]
    }
    if (v.blur > 0.5) dest.filter = `blur(${v.blur * k}px)`
    dest.drawImage(image, crop.x * iw, crop.y * ih, crop.w * iw, crop.h * ih, -dw / 2, -dh / 2, dw, dh)
    dest.filter = 'none'

    if (masked) {
      this.applyMask(dest, clip.mask, dw, dh, k, src)
      dest.restore()
      ctx.save()
      ctx.globalAlpha = v.opacity
      ctx.globalCompositeOperation = BLEND_OP[clip.blend]
      ctx.drawImage(this.layers[2] as CanvasImageSource, 0, 0)
      ctx.restore()
    } else {
      dest.restore()
    }
  }

  /** Cuts the clip layer to a mask shape in the clip's own (rotated, flipped) space, then draws any outline. */
  private applyMask(ctx: Ctx, mask: Mask, dw: number, dh: number, k: number, src: FrameSource) {
    const cx = mask.x * dw
    const cy = mask.y * dh
    const mw = Math.max(1, Math.abs(mask.width * dw))
    const mh = Math.max(1, Math.abs(mask.height * dh))
    const span = Math.hypot(dw, dh) * 2

    ctx.globalCompositeOperation = mask.invert ? 'destination-out' : 'destination-in'
    if (mask.feather > 0) ctx.filter = `blur(${(mask.feather / 100) * Math.min(mw, mh) * 0.25 + k}px)`
    ctx.fillStyle = '#000'
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate((mask.rotation * Math.PI) / 180)
    ctx.beginPath()
    if (mask.shape === 'text') {
      const text = (mask.text ?? '').trim() || 'MASK'
      const style = { ...defaultTextStyle(), fontFamily: mask.fontFamily ?? 'Anton', bold: true, fontSize: Math.max(2, mh) }
      ensureFont(style, () => src.invalidate())
      ctx.font = fontString(style, 1)
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      const lines = text.split('\n')
      const lineH = mh * 1.1
      lines.forEach((line, i) => ctx.fillText(line, 0, (i - (lines.length - 1) / 2) * lineH))
      ctx.restore()
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
      return
    }
    switch (mask.shape) {
      case 'linear':
        // Keeps everything above the line through the mask centre.
        ctx.rect(-span, -span, span * 2, span)
        break
      case 'mirror':
        ctx.rect(-span, -mh / 2, span * 2, mh)
        break
      case 'circle':
        ctx.ellipse(0, 0, mw / 2, mh / 2, 0, 0, Math.PI * 2)
        break
      case 'rectangle': {
        const r = (mask.roundness / 100) * Math.min(mw, mh) / 2
        ctx.roundRect(-mw / 2, -mh / 2, mw, mh, r)
        break
      }
      case 'heart': {
        const s = Math.min(mw, mh) / 2
        ctx.moveTo(0, s * 0.85)
        ctx.bezierCurveTo(-s * 1.4, -s * 0.1, -s * 0.6, -s * 1.05, 0, -s * 0.45)
        ctx.bezierCurveTo(s * 0.6, -s * 1.05, s * 1.4, -s * 0.1, 0, s * 0.85)
        break
      }
      case 'star': {
        const outer = Math.min(mw, mh) / 2
        const inner = outer * 0.45
        for (let i = 0; i < 10; i++) {
          const r = i % 2 ? inner : outer
          const a = (i * Math.PI) / 5 - Math.PI / 2
          if (i === 0) ctx.moveTo(Math.cos(a) * r, Math.sin(a) * r)
          else ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r)
        }
        ctx.closePath()
        break
      }
      case 'diamond':
        ctx.moveTo(0, -mh / 2)
        ctx.lineTo(mw / 2, 0)
        ctx.lineTo(0, mh / 2)
        ctx.lineTo(-mw / 2, 0)
        ctx.closePath()
        break
      case 'freeform': {
        const pts = mask.path ?? []
        if (pts.length < 2) {
          // Nothing drawn yet: keep the whole clip visible instead of blanking it.
          ctx.rect(-span, -span, span * 2, span * 2)
          break
        }
        const P = (p: { x: number; y: number }) => ({ x: p.x * dw, y: p.y * dh })
        ctx.moveTo(P(pts[0]).x, P(pts[0]).y)
        for (let i = 1; i <= pts.length; i++) {
          const a = pts[i - 1]
          const b = pts[i % pts.length]
          const c1 = a.outX !== undefined && a.outY !== undefined ? P({ x: a.x + a.outX, y: a.y + a.outY }) : null
          const c2 = b.inX !== undefined && b.inY !== undefined ? P({ x: b.x + b.inX, y: b.y + b.inY }) : null
          const end = P(b)
          if (c1 || c2) {
            const s = P(a)
            ctx.bezierCurveTo((c1 ?? s).x, (c1 ?? s).y, (c2 ?? end).x, (c2 ?? end).y, end.x, end.y)
          } else ctx.lineTo(end.x, end.y)
        }
        ctx.closePath()
        break
      }
      case 'none':
        break
    }
    ctx.fill()
    const strokeW = (mask.strokeWidth ?? 0) * k
    if (strokeW > 0 && mask.shape !== 'none') {
      ctx.filter = 'none'
      ctx.globalCompositeOperation = 'source-over'
      ctx.strokeStyle = mask.strokeColor ?? '#ffffff'
      ctx.lineWidth = strokeW
      ctx.lineJoin = 'round'
      if (mask.shape === 'linear') {
        ctx.beginPath()
        ctx.moveTo(-span, 0)
        ctx.lineTo(span, 0)
      } else if (mask.shape === 'mirror') {
        ctx.beginPath()
        ctx.moveTo(-span, -mh / 2)
        ctx.lineTo(span, -mh / 2)
        ctx.moveTo(-span, mh / 2)
        ctx.lineTo(span, mh / 2)
      }
      ctx.stroke()
    }
    ctx.restore()
    ctx.filter = 'none'
    ctx.globalCompositeOperation = 'source-over'
  }

  private drawTextClip(ctx: Ctx, clip: TextClip, t: number, project: Project, src: FrameSource, k: number) {
    ensureFont(clip.style, () => src.invalidate())
    const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
    if (v.opacity <= 0.001 || !clip.text.trim()) return
    const W = project.canvas.width * k
    const H = project.canvas.height * k

    const layout = layoutText(ctx, clip.text, clip.style, k, project.canvas.width)
    let activeWord: number | null = null
    if (clip.words?.length && clip.style.highlightColor) {
      const local = t - clip.start
      const idx = clip.words.findIndex((w) => local >= w.start && local < w.end)
      activeWord = idx >= 0 ? idx : null
    }

    ctx.save()
    ctx.translate(W / 2 + v.x * k, H / 2 + v.y * k)
    ctx.rotate((v.rotation * Math.PI) / 180)
    ctx.scale(v.scale * v.scaleX * (v.flipH ? -1 : 1), v.scale * v.scaleY * (v.flipV ? -1 : 1))
    ctx.globalAlpha = v.opacity
    ctx.globalCompositeOperation = BLEND_OP[clip.blend ?? 'normal']
    if (v.blur > 0.5) ctx.filter = `blur(${v.blur * k}px)`
    drawText(ctx, layout, clip.style, k, { reveal: v.reveal, activeWord })
    ctx.restore()
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  private composeTransition(ctx: Ctx, a: AnyCanvas, b: AnyCanvas, name: TransitionName, p: number, W: number, H: number) {
    const A = a as CanvasImageSource
    const B = b as CanvasImageSource
    const e = EASINGS.easeInOut(Math.min(1, Math.max(0, p)))
    ctx.save()
    switch (name) {
      case 'dissolve':
        ctx.drawImage(A, 0, 0)
        ctx.globalAlpha = e
        ctx.drawImage(B, 0, 0)
        break
      case 'fadeBlack':
      case 'fadeWhite': {
        ctx.drawImage(e < 0.5 ? A : B, 0, 0)
        ctx.globalAlpha = 1 - Math.abs(e - 0.5) * 2
        ctx.fillStyle = name === 'fadeBlack' ? '#000' : '#fff'
        ctx.fillRect(0, 0, W, H)
        break
      }
      case 'wipeLeft':
      case 'wipeRight':
      case 'wipeUp':
      case 'wipeDown': {
        ctx.drawImage(A, 0, 0)
        ctx.beginPath()
        if (name === 'wipeLeft') ctx.rect(W * (1 - e), 0, W * e, H)
        if (name === 'wipeRight') ctx.rect(0, 0, W * e, H)
        if (name === 'wipeUp') ctx.rect(0, H * (1 - e), W, H * e)
        if (name === 'wipeDown') ctx.rect(0, 0, W, H * e)
        ctx.clip()
        ctx.drawImage(B, 0, 0)
        break
      }
      case 'slideLeft':
        ctx.drawImage(A, 0, 0)
        ctx.drawImage(B, W * (1 - e), 0)
        break
      case 'slideRight':
        ctx.drawImage(A, 0, 0)
        ctx.drawImage(B, -W * (1 - e), 0)
        break
      case 'push':
        ctx.drawImage(A, -W * e, 0)
        ctx.drawImage(B, W * (1 - e), 0)
        break
      case 'zoom': {
        const s = 1 + e * 0.6
        ctx.globalAlpha = 1 - e
        ctx.drawImage(A, (W - W * s) / 2, (H - H * s) / 2, W * s, H * s)
        const s2 = 1.3 - 0.3 * e
        ctx.globalAlpha = e
        ctx.drawImage(B, (W - W * s2) / 2, (H - H * s2) / 2, W * s2, H * s2)
        break
      }
      case 'circle': {
        ctx.drawImage(A, 0, 0)
        ctx.beginPath()
        ctx.arc(W / 2, H / 2, (Math.hypot(W, H) / 2) * e, 0, Math.PI * 2)
        ctx.clip()
        ctx.drawImage(B, 0, 0)
        break
      }
      case 'blur': {
        const amount = (1 - Math.abs(e - 0.5) * 2) * 24 * (W / 1920)
        ctx.filter = `blur(${amount}px)`
        ctx.drawImage(A, 0, 0)
        ctx.globalAlpha = e
        ctx.drawImage(B, 0, 0)
        break
      }
    }
    ctx.restore()
  }

  // ── Effects ───────────────────────────────────────────────────────────────

  private applyEffect(target: AnyCanvas, ctx: Ctx, clip: EffectClip, t: number, src: FrameSource, W: number, H: number) {
    const replace = (out: CanvasImageSource) => {
      // Copy through a scratch canvas: the GL output may alias the target's pixels.
      if (!this.scratch || this.scratch.width !== W || this.scratch.height !== H) this.scratch = makeCanvas(W, H)
      const s = this.scratch.getContext('2d') as Ctx
      s.clearRect(0, 0, W, H)
      s.drawImage(out, 0, 0, W, H)
      ctx.save()
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.globalAlpha = 1
      ctx.globalCompositeOperation = 'copy'
      ctx.drawImage(this.scratch as CanvasImageSource, 0, 0)
      ctx.restore()
    }

    const grade = resolveColorGrade(clip.adjust, clip.filter)
    const lut = clip.filter?.id.startsWith('lut:') ? src.lut(clip.filter.id.slice(4)) : null
    const gl = this.gl()
    if (gl && (!isGradeNeutral(grade) || lut)) {
      replace(
        gl.process(target as TexImageSource, {
          width: W,
          height: H,
          grade: isGradeNeutral(grade) ? null : grade,
          lut,
          lutIntensity: (clip.filter?.intensity ?? 100) / 100,
          chroma: null,
          alphaMask: null,
          time: t,
        }) as CanvasImageSource,
      )
    }

    const fx = this.fx()
    if (fx && clip.effect !== 'none') {
      replace(
        fx.process(target as TexImageSource, {
          width: W,
          height: H,
          effect: clip.effect,
          intensity: clip.intensity / 100,
          time: t,
          localTime: t - clip.start,
        }) as CanvasImageSource,
      )
    }
  }

  // ── Hit testing for the preview overlay ───────────────────────────────────

  /**
   * Where a visual clip is drawn at `t`, in project pixels: centre offset from
   * the canvas centre, size and rotation. Drives the selection box and drag
   * handles in the player.
   */
  bounds(project: Project, assets: Record<string, Asset>, clip: Clip, t: number) {
    if (isTextClip(clip)) {
      if (!this.measureCtx) this.measureCtx = makeCanvas(8, 8).getContext('2d') as Ctx
      const layout = layoutText(this.measureCtx, clip.text || ' ', clip.style, 1, project.canvas.width)
      const box = textBoxSize(layout, clip.style, 1)
      const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
      return { x: v.x, y: v.y, width: box.width * v.scale * v.scaleX, height: box.height * v.scale * v.scaleY, rotation: v.rotation }
    }
    if (clip.type === 'shape') {
      const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
      return { x: v.x, y: v.y, width: clip.width * v.scale * v.scaleX, height: clip.height * v.scale * v.scaleY, rotation: v.rotation }
    }
    if (!isMediaClip(clip) || clip.type === 'audio') return null
    const asset = assets[clip.assetId]
    if (!asset?.width || !asset.height) return null
    const v = resolveVisual(clip, t, project.canvas.width, project.canvas.height)
    const cropW = clip.crop.w * asset.width
    const cropH = clip.crop.h * asset.height
    const fit = fitScale(project, cropW, cropH)
    return { x: v.x, y: v.y, width: cropW * fit * v.scale * v.scaleX, height: cropH * fit * v.scale * v.scaleY, rotation: v.rotation }
  }

  dispose() {
    this.clipGl?.dispose()
    this.fxGl?.dispose()
    this.clipGl = undefined
    this.fxGl = undefined
    this.layers = []
    this.scratch = null
  }
}
