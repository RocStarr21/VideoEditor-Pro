import type { ImageSegmenter, ImageSegmenterResult } from '@mediapipe/tasks-vision'
import wasmLoaderUrl from '@mediapipe/tasks-vision/vision_wasm_internal.js?url'
import wasmBinaryUrl from '@mediapipe/tasks-vision/vision_wasm_internal.wasm?url'

type WasmFileset = Parameters<typeof ImageSegmenter.createFromOptions>[0]
type Delegate = 'GPU' | 'CPU'

/** Must match the installed @mediapipe/tasks-vision version; used only if the bundled wasm can't load. */
const MEDIAPIPE_VERSION = '1.1.1'
const CDN_WASM_BASE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`

/** Official MediaPipe selfie segmenter (square, 256x256, float16), pinned to version 1. */
export const SELFIE_SEGMENTER_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite'

/** Longest side of the frame handed to the model; it infers at 256x256, so larger only costs readback time. */
const WORK_MAX = 384

type Ctx2D = Pick<CanvasRenderingContext2D, 'drawImage' | 'putImageData' | 'clearRect' | 'createImageData'> & {
  imageSmoothingEnabled: boolean
  imageSmoothingQuality: ImageSmoothingQuality
}

interface Surface {
  canvas: HTMLCanvasElement | OffscreenCanvas
  ctx: Ctx2D
}

function surface(width: number, height: number): Surface | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height)
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx: ctx as Ctx2D }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (ctx) return { canvas, ctx }
  }
  return null
}

function fit(s: Surface, width: number, height: number) {
  if (s.canvas.width !== width) s.canvas.width = width
  if (s.canvas.height !== height) s.canvas.height = height
}

const isImageData = (s: TexImageSource): s is ImageData => typeof ImageData !== 'undefined' && s instanceof ImageData

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof Event !== 'undefined' && err instanceof Event) {
    const src = (err.target as { src?: string } | null)?.src
    return src ? `failed to load ${src}` : `${err.type} event`
  }
  return String(err)
}

/** AI "Remove background": MediaPipe person segmentation producing a soft alpha matte. */
export class PersonSegmenter {
  private segmenter: ImageSegmenter | null
  private delegate: Delegate
  private lastTimestamp = -1
  private personIndex = -1
  private work: Surface | null = null
  private maskSurface: Surface | null = null
  private out: Surface | null = null
  private imageData: ImageData | null = null
  private scratch: Surface | null = null
  private failures = 0
  private switching = false

  private constructor(segmenter: ImageSegmenter, delegate: Delegate) {
    this.segmenter = segmenter
    this.delegate = delegate
  }

  /**
   * Loads the MediaPipe runtime and selfie model (GPU delegate, falling back to CPU).
   * The wasm is served from the app bundle, falling back to jsDelivr; the model comes from
   * storage.googleapis.com. Throws an Error with a user-presentable message on failure.
   */
  static async create(onProgress?: (msg: string) => void): Promise<PersonSegmenter> {
    if (typeof window === 'undefined' || typeof document === 'undefined') {
      throw new Error('Background removal only runs in the browser.')
    }
    const report = (msg: string) => {
      try {
        onProgress?.(msg)
      } catch {
        // A throwing progress callback must not abort loading.
      }
    }

    report('Loading background removal...')
    let vision: typeof import('@mediapipe/tasks-vision')
    try {
      vision = await import('@mediapipe/tasks-vision')
    } catch (err) {
      throw new Error(`Background removal could not load the MediaPipe library: ${describe(err)}`)
    }
    const { FilesetResolver, ImageSegmenter } = vision

    const simd = await FilesetResolver.isSimdSupported().catch(() => true)
    const runtimes: Array<{ label: string; load: () => Promise<WasmFileset> }> = []
    // Only the SIMD build is bundled; older engines get the matching non-SIMD build from the CDN.
    if (simd) {
      runtimes.push({
        label: 'bundled runtime',
        load: async () => ({
          wasmLoaderPath: new URL(wasmLoaderUrl, document.baseURI).href,
          wasmBinaryPath: new URL(wasmBinaryUrl, document.baseURI).href,
        }),
      })
    }
    runtimes.push({ label: 'CDN runtime', load: () => FilesetResolver.forVisionTasks(CDN_WASM_BASE) })

    const errors: string[] = []
    for (const runtime of runtimes) {
      let fileset: WasmFileset
      try {
        fileset = await runtime.load()
      } catch (err) {
        errors.push(`${runtime.label}: ${describe(err)}`)
        continue
      }
      for (const delegate of ['GPU', 'CPU'] as const) {
        report(`Starting person segmentation (${delegate})...`)
        try {
          const segmenter = await ImageSegmenter.createFromOptions(fileset, {
            baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL_URL, delegate },
            runningMode: 'VIDEO',
            outputConfidenceMasks: true,
            outputCategoryMask: false,
          })
          report('Background removal ready')
          return new PersonSegmenter(segmenter, delegate)
        } catch (err) {
          errors.push(`${runtime.label} (${delegate}): ${describe(err)}`)
        }
      }
    }
    const detail = [...new Set(errors)].join('; ')
    throw new Error(`Background removal could not start. Check your connection and try again. (${detail})`)
  }

  /**
   * Segments `source` stretched to width x height. Returns a canvas of exactly that size whose
   * red, green, blue and alpha all hold person confidence (0..255), or null on failure.
   * The canvas is reused: it is valid until the next segment() call.
   * `timestampMs` may be any timeline time; it is made strictly increasing internally.
   */
  segment(source: TexImageSource, width: number, height: number, timestampMs: number): HTMLCanvasElement | OffscreenCanvas | null {
    const segmenter = this.segmenter
    if (!segmenter || this.switching) return null
    const w = Math.max(1, Math.round(width) || 1)
    const h = Math.max(1, Math.round(height) || 1)
    const scale = Math.min(1, WORK_MAX / Math.max(w, h))
    const ww = Math.max(1, Math.round(w * scale))
    const wh = Math.max(1, Math.round(h * scale))

    try {
      const work = (this.work ??= surface(ww, wh))
      const out = (this.out ??= surface(w, h))
      if (!work || !out) return null
      fit(work, ww, wh)
      work.ctx.clearRect(0, 0, ww, wh)
      if (!this.draw(work.ctx, source, ww, wh)) return null

      let ok = false
      segmenter.segmentForVideo(work.canvas, this.nextTimestamp(timestampMs), (result) => {
        ok = this.writeMask(segmenter, result, out, w, h)
      })
      if (!ok) return null
      this.failures = 0
      return out.canvas
    } catch (err) {
      this.onFailure(err)
      return null
    }
  }

  close(): void {
    try {
      this.segmenter?.close()
    } catch {
      // Already torn down.
    }
    this.segmenter = null
    this.work = null
    this.maskSurface = null
    this.out = null
    this.scratch = null
    this.imageData = null
  }

  private nextTimestamp(timestampMs: number): number {
    const t = Number.isFinite(timestampMs) ? Math.floor(timestampMs) : 0
    this.lastTimestamp = t > this.lastTimestamp ? t : this.lastTimestamp + 1
    return this.lastTimestamp
  }

  private draw(ctx: Ctx2D, source: TexImageSource, width: number, height: number): boolean {
    if (isImageData(source)) {
      const scratch = (this.scratch ??= surface(source.width, source.height))
      if (!scratch) return false
      fit(scratch, source.width, source.height)
      scratch.ctx.putImageData(source, 0, 0)
      ctx.drawImage(scratch.canvas, 0, 0, width, height)
      return true
    }
    ctx.drawImage(source, 0, 0, width, height)
    return true
  }

  private maskIndex(segmenter: ImageSegmenter, count: number): number {
    if (this.personIndex < 0) {
      let labels: string[] = []
      try {
        labels = segmenter.getLabels()
      } catch {
        labels = []
      }
      const named = labels.findIndex((l) => /person|human|selfie|foreground/i.test(l))
      // Two-channel models put background first; the single-channel selfie model is person confidence.
      this.personIndex = named >= 0 ? named : count > 1 ? 1 : 0
    }
    return Math.min(this.personIndex, count - 1)
  }

  private writeMask(segmenter: ImageSegmenter, result: ImageSegmenterResult, out: Surface, width: number, height: number): boolean {
    const masks = result.confidenceMasks
    if (!masks || masks.length === 0) return false
    const mask = masks[this.maskIndex(segmenter, masks.length)]
    const mw = mask.width
    const mh = mask.height
    if (!mw || !mh) return false
    const values = mask.getAsFloat32Array()

    const buf = (this.maskSurface ??= surface(mw, mh))
    if (!buf) return false
    fit(buf, mw, mh)
    let img = this.imageData
    if (!img || img.width !== mw || img.height !== mh) img = this.imageData = buf.ctx.createImageData(mw, mh)
    const px = img.data
    const n = Math.min(values.length, mw * mh)
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const v = values[i] * 255
      px[j] = v
      px[j + 1] = v
      px[j + 2] = v
      px[j + 3] = v
    }
    buf.ctx.putImageData(img, 0, 0)

    fit(out, width, height)
    out.ctx.clearRect(0, 0, width, height)
    out.ctx.imageSmoothingEnabled = true
    out.ctx.imageSmoothingQuality = 'high'
    out.ctx.drawImage(buf.canvas, 0, 0, width, height)
    return true
  }

  /** Repeated GPU failures (e.g. a lost WebGL context inside MediaPipe) switch the task to the CPU delegate. */
  private onFailure(err: unknown) {
    this.failures++
    const segmenter = this.segmenter
    if (this.delegate !== 'GPU' || this.failures < 3 || this.switching || !segmenter) return
    if (typeof console !== 'undefined') console.warn('PersonSegmenter: GPU segmentation failing, switching to CPU', err)
    this.switching = true
    segmenter
      .setOptions({ baseOptions: { modelAssetPath: SELFIE_SEGMENTER_MODEL_URL, delegate: 'CPU' } })
      .then(() => {
        this.delegate = 'CPU'
        this.failures = 0
      })
      .catch(() => undefined)
      .finally(() => {
        this.switching = false
      })
  }
}
