/**
 * Project model for VideoEditor Pro.
 *
 * The feature set mirrors CapCut desktop 7.9 as inventoried from its shipped
 * localization (Resources/po/en.po) and resource bundles: a magnetic main
 * track with overlay, text, effect and audio tracks; per-clip speed, volume,
 * fades, transform, crop, blend modes, masks, chroma key, color adjustment,
 * filters and LUTs, in/out animations and keyframes; transitions between
 * adjacent clips; markers; and canvas aspect ratios.
 *
 * Everything here is plain serializable data. Times are in seconds on the
 * timeline unless a field says otherwise. Positions are in project pixels.
 */

export type Seconds = number

// ── Assets ───────────────────────────────────────────────────────────────────

export type MediaAssetKind = 'video' | 'audio' | 'image'
/** 'lut' assets are imported .cube files: stored with the project, never placed on the timeline. */
export type AssetKind = MediaAssetKind | 'lut'

export interface Asset {
  id: string
  kind: AssetKind
  name: string
  mime: string
  size: number
  /** Source duration. Images report 0 and may be stretched to any length. */
  duration: Seconds
  width: number
  height: number
  hasAudio: boolean
  createdAt: number
  /** Set on assets the editor generated, e.g. a reversed copy or freeze frame. */
  derivedFrom?: { assetId: string; operation: 'reverse' | 'freeze' | 'lut' }
}

// ── Tracks ───────────────────────────────────────────────────────────────────

/**
 * video  — video, image and sticker clips (the main track is a video track)
 * text   — text, caption and emoji-sticker clips
 * effect — full-frame effect / filter / adjustment clips
 * audio  — audio clips (music, voiceover, extracted audio)
 */
export type TrackKind = 'video' | 'text' | 'effect' | 'audio'

export interface Track {
  id: string
  kind: TrackKind
  name: string
  /** The single magnetic main track (CapCut "Main track"). */
  isMain: boolean
  hidden: boolean
  muted: boolean
  locked: boolean
}

// ── Shared clip properties ───────────────────────────────────────────────────

export type EasingName = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut'

/** CSS-style cubic-bezier control points (x1, y1, x2, y2); x in 0..1, y may overshoot. */
export type CubicBezier = [number, number, number, number]

export interface Keyframe {
  /** Clip-local timeline time (0 = clip start). */
  t: Seconds
  v: number
  /** Named preset or a custom curve from the graph editor. */
  ease: EasingName | CubicBezier
}

export type KeyframeProp = 'x' | 'y' | 'scale' | 'scaleX' | 'scaleY' | 'rotation' | 'opacity' | 'volume'

export type Keyframes = Partial<Record<KeyframeProp, Keyframe[]>>

export interface Transform {
  /** Offset of the clip centre from the canvas centre, project pixels. */
  x: number
  y: number
  /** 1 = media fitted to the canvas (CapCut "Fit"). */
  scale: number
  /** Independent horizontal / vertical stretch on top of `scale`; missing = 1. */
  scaleX?: number
  scaleY?: number
  /** Degrees, clockwise. */
  rotation: number
  flipH: boolean
  flipV: boolean
}

/** Normalized crop rectangle in source space (0..1). */
export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

/**
 * Color adjustment, matching CapCut's DefaultAdjustBundle set
 * (brightness, contrast, saturation, exposure, temperature/tint, highlights,
 * shadows, sharpen, vignette, fade, grain, hue).
 * Bipolar values are -100..100 (0 = neutral); unipolar are 0..100.
 */
export interface Adjust {
  brightness: number
  contrast: number
  saturation: number
  exposure: number
  temperature: number
  tint: number
  highlights: number
  shadows: number
  hue: number
  sharpen: number
  vignette: number
  fade: number
  grain: number
}

/** A built-in look, or an imported .cube LUT asset ("lut:<assetId>"). */
export interface FilterRef {
  id: string
  /** 0..100 */
  intensity: number
}

export type MaskShape = 'none' | 'linear' | 'mirror' | 'circle' | 'rectangle' | 'heart' | 'star' | 'diamond' | 'text' | 'freeform'

/** A vertex of a freeform (pen tool) mask, with optional bezier handles; all as fractions of the clip's drawn size from its centre. */
export interface MaskPathPoint {
  x: number
  y: number
  inX?: number
  inY?: number
  outX?: number
  outY?: number
}

export interface Mask {
  shape: MaskShape
  /** Centre offset from clip centre, as a fraction of the clip's drawn size. */
  x: number
  y: number
  /** Size as a fraction of the clip's drawn size. */
  width: number
  height: number
  rotation: number
  /** 0..100 */
  feather: number
  /** Corner rounding for rectangle, 0..100 */
  roundness: number
  invert: boolean
  /** Outline drawn along the mask edge; width in project pixels, 0 = none. */
  strokeColor?: string
  strokeWidth?: number
  /** 'text' masks: the glyphs that reveal the clip. */
  text?: string
  fontFamily?: string
  /** 'freeform' masks: closed path drawn with the pen tool. */
  path?: MaskPathPoint[]
}

export interface ChromaKey {
  enabled: boolean
  /** Hex color to key out. */
  color: string
  /** Similarity, 0..100 */
  intensity: number
  /** Edge softness / spill, 0..100 */
  shadow: number
}

/** Canvas 2D composite operations, covering CapCut's MixMode set. */
export type BlendMode =
  | 'normal'
  | 'multiply'
  | 'screen'
  | 'overlay'
  | 'darken'
  | 'lighten'
  | 'color-dodge'
  | 'color-burn'
  | 'soft-light'
  | 'hard-light'
  | 'difference'
  | 'exclusion'

export type AnimationName =
  | 'none'
  | 'fade'
  | 'zoomIn'
  | 'zoomOut'
  | 'slideLeft'
  | 'slideRight'
  | 'slideUp'
  | 'slideDown'
  | 'rotate'
  | 'bounce'
  | 'blur'
  | 'pop'
  /** Text only: characters appear one by one. */
  | 'typewriter'

export type LoopAnimationName = 'none' | 'pulse' | 'wiggle' | 'float' | 'spin'

export interface ClipAnimation {
  in: { name: AnimationName; duration: Seconds }
  out: { name: AnimationName; duration: Seconds }
  loop: { name: LoopAnimationName; period: Seconds }
}

export type TransitionName =
  | 'dissolve'
  | 'fadeBlack'
  | 'fadeWhite'
  | 'wipeLeft'
  | 'wipeRight'
  | 'wipeUp'
  | 'wipeDown'
  | 'slideLeft'
  | 'slideRight'
  | 'push'
  | 'zoom'
  | 'circle'
  | 'blur'

/** A transition from this clip into the next adjacent clip on the same track. */
export interface Transition {
  name: TransitionName
  duration: Seconds
}

export type VoiceEffect = 'none' | 'echo' | 'telephone' | 'radio' | 'megaphone' | 'robot' | 'deep' | 'chipmunk' | 'hall'

// ── Clips ────────────────────────────────────────────────────────────────────

interface ClipBase {
  id: string
  trackId: string
  name: string
  /** Timeline position. */
  start: Seconds
  /** Timeline duration (speed already applied). */
  duration: Seconds
  keyframes: Keyframes
}

export interface MediaClip extends ClipBase {
  type: 'video' | 'image' | 'audio'
  assetId: string
  /** Offset into the source where this clip begins. */
  sourceIn: Seconds
  speed: number
  /** Linear gain, 1 = 100%. CapCut allows boosting to ~+20 dB; we cap at 4. */
  volume: number
  muted: boolean
  fadeIn: Seconds
  fadeOut: Seconds
  /** CapCut "Change audio pitch" off ⇒ preservePitch true. */
  preservePitch: boolean
  /** Audio clips separated from a video clip remember it so the sound can be reattached. */
  detachedFrom?: string
  voiceEffect: VoiceEffect
  denoise: boolean
  transform: Transform
  crop: Crop
  /** 0..1 */
  opacity: number
  blend: BlendMode
  adjust: Adjust
  filter: FilterRef | null
  mask: Mask
  chroma: ChromaKey
  animation: ClipAnimation
  transitionOut: Transition | null
  /** AI "Remove background" (person segmentation). */
  removeBackground: boolean
  /** Beat markers detected on this clip, clip-local seconds. */
  beats: Seconds[]
}

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  fontFamily: string
  /** Pixels at project resolution. */
  fontSize: number
  color: string
  bold: boolean
  italic: boolean
  underline: boolean
  align: TextAlign
  letterSpacing: number
  lineHeight: number
  strokeColor: string
  strokeWidth: number
  shadowColor: string
  shadowBlur: number
  shadowX: number
  shadowY: number
  bgColor: string
  /** 0..1 */
  bgOpacity: number
  bgPadding: number
  bgRadius: number
  /** Wrap width as a fraction of canvas width. */
  maxWidth: number
  /** Karaoke-style color for the word currently being spoken (captions). */
  highlightColor: string | null
}

export interface CaptionWord {
  text: string
  /** Clip-local seconds. */
  start: Seconds
  end: Seconds
}

export interface TextClip extends ClipBase {
  type: 'text'
  text: string
  style: TextStyle
  transform: Transform
  opacity: number
  blend?: BlendMode
  animation: ClipAnimation
  /** Generated or imported caption (subtitle) rather than free text. */
  isCaption: boolean
  /** Emoji / sticker rendered as large glyph art. */
  isSticker: boolean
  /** Word timings for karaoke highlighting, when known. */
  words: CaptionWord[] | null
}

export type EffectName =
  | 'none'
  | 'blur'
  | 'glitch'
  | 'shake'
  | 'vhs'
  | 'filmGrain'
  | 'vignette'
  | 'blackWhite'
  | 'sepia'
  | 'pixelate'
  | 'mirror'
  | 'zoomPulse'
  | 'flash'
  | 'invert'
  | 'rgbSplit'
  | 'scanlines'

/** Applies to the whole composited frame for its span (CapCut effects / filters / adjustment layers). */
export interface EffectClip extends ClipBase {
  type: 'effect'
  effect: EffectName
  /** 0..100 */
  intensity: number
  filter: FilterRef | null
  adjust: Adjust | null
}

export type ShapeKind = 'rectangle' | 'ellipse' | 'polygon' | 'star'

/** Vector graphic drawn by the editor (OpenCut "graphics"): no asset behind it, fully editable. */
export interface ShapeClip extends ClipBase {
  type: 'shape'
  shape: ShapeKind
  /** Project pixels before `transform.scale`. */
  width: number
  height: number
  fill: string
  strokeColor: string
  /** Project pixels, 0 = none. */
  strokeWidth: number
  strokeAlign: 'inside' | 'center' | 'outside'
  /** Rectangle corner radius as a percentage of the shorter side, 0..100. */
  cornerRadius: number
  /** Polygon sides (3..12). */
  sides: number
  /** Star points (3..12) and inner radius as a fraction of the outer radius. */
  points: number
  innerRadius: number
  transform: Transform
  opacity: number
  blend: BlendMode
  mask: Mask
  animation: ClipAnimation
}

export type Clip = MediaClip | TextClip | EffectClip | ShapeClip

/** Clips that draw something on the canvas. */
export type VisualClip = Exclude<MediaClip, { type: 'audio' }> | TextClip | ShapeClip

// ── Project ──────────────────────────────────────────────────────────────────

export interface Marker {
  id: string
  t: Seconds
  color: string
  label: string
  /** Longer planning note (OpenCut bookmarks). */
  note?: string
  /** Optional span the marker covers, seconds; 0 or missing = a point. */
  duration?: Seconds
}

export type CanvasBackground =
  | { type: 'color'; color: string }
  | { type: 'blur'; amount: number }
  | { type: 'image'; assetId: string }
  | { type: 'gradient'; from: string; to: string; angle: number }

export interface CanvasSettings {
  /** One of CANVAS_RATIOS ids, 'original', or 'custom' for a typed-in size. */
  ratio: string
  width: number
  height: number
  background: CanvasBackground
}

export interface SceneMeta {
  id: string
  name: string
  /** Position in the scene strip. */
  order: number
}

/** A scene that is not currently open: its timeline is parked here until it is switched to. */
export interface SceneData extends SceneMeta {
  tracks: Track[]
  clips: Clip[]
  markers: Marker[]
}

export interface Project {
  id: string
  name: string
  version: 1
  fps: number
  canvas: CanvasSettings
  /** The open scene; `tracks`, `clips` and `markers` below belong to it. Missing on older projects. */
  scene?: SceneMeta
  /** Every other scene in the project. */
  otherScenes?: SceneData[]
  /** UI order, top to bottom. */
  tracks: Track[]
  clips: Clip[]
  markers: Marker[]
  /** Every asset imported into this project, used on the timeline or not (the media bin). */
  bin: string[]
  createdAt: number
  updatedAt: number
}
