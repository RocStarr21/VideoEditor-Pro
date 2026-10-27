import type {
  Adjust,
  AnimationName,
  Asset,
  BlendMode,
  ChromaKey,
  ClipAnimation,
  Crop,
  CubicBezier,
  EffectClip,
  EffectName,
  LoopAnimationName,
  Mask,
  MaskShape,
  MediaAssetKind,
  MediaClip,
  Project,
  ShapeClip,
  ShapeKind,
  TextClip,
  TextStyle,
  Track,
  TrackKind,
  Transform,
  TransitionName,
  VoiceEffect,
} from './types'

export const newId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36)

// ── Catalogs ────────────────────────────────────────────────────────────────

/**
 * Aspect ratios, in the order CapCut ships them in
 * Resources/video_template_ratio.json, plus "original".
 */
export const CANVAS_RATIOS: Array<{ id: string; label: string; width: number; height: number; hint: string }> = [
  { id: '16:9', label: '16:9', width: 1920, height: 1080, hint: 'YouTube' },
  { id: '9:16', label: '9:16', width: 1080, height: 1920, hint: 'TikTok, Reels, Shorts' },
  { id: '1:1', label: '1:1', width: 1080, height: 1080, hint: 'Instagram' },
  { id: '4:3', label: '4:3', width: 1440, height: 1080, hint: 'Presentation' },
  { id: '3:4', label: '3:4', width: 1080, height: 1440, hint: 'Portrait' },
  { id: '4:5', label: '4:5', width: 1080, height: 1350, hint: 'Instagram feed' },
  { id: '2:1', label: '2:1', width: 1920, height: 960, hint: 'Widescreen' },
  { id: '2.35:1', label: '2.35:1', width: 2538, height: 1080, hint: 'Cinema' },
  { id: '1.85:1', label: '1.85:1', width: 1998, height: 1080, hint: 'Film' },
]

export const BLEND_MODES: Array<{ id: BlendMode; label: string }> = [
  { id: 'normal', label: 'Normal' },
  { id: 'multiply', label: 'Multiply' },
  { id: 'screen', label: 'Screen' },
  { id: 'overlay', label: 'Overlay' },
  { id: 'darken', label: 'Darken' },
  { id: 'lighten', label: 'Lighten' },
  { id: 'color-dodge', label: 'Color dodge' },
  { id: 'color-burn', label: 'Color burn' },
  { id: 'soft-light', label: 'Soft light' },
  { id: 'hard-light', label: 'Hard light' },
  { id: 'difference', label: 'Difference' },
  { id: 'exclusion', label: 'Exclusion' },
]

export const MASK_SHAPES: Array<{ id: MaskShape; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'linear', label: 'Split' },
  { id: 'mirror', label: 'Bars' },
  { id: 'circle', label: 'Ellipse' },
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'heart', label: 'Heart' },
  { id: 'star', label: 'Star' },
  { id: 'diamond', label: 'Diamond' },
  { id: 'text', label: 'Text' },
  { id: 'freeform', label: 'Pen' },
]

export const SHAPES: Array<{ id: ShapeKind; label: string }> = [
  { id: 'rectangle', label: 'Rectangle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'star', label: 'Star' },
]

/** Ready-made shapes for the Stickers panel (OpenCut "Shapes"). */
export const SHAPE_PRESETS: Array<{ id: string; label: string; shape: ShapeKind; params?: Partial<ShapeClip> }> = [
  { id: 'square', label: 'Square', shape: 'rectangle' },
  { id: 'rounded', label: 'Rounded', shape: 'rectangle', params: { cornerRadius: 30 } },
  { id: 'circle', label: 'Circle', shape: 'ellipse' },
  { id: 'triangle', label: 'Triangle', shape: 'polygon', params: { sides: 3 } },
  { id: 'diamond', label: 'Diamond', shape: 'polygon', params: { sides: 4 } },
  { id: 'pentagon', label: 'Pentagon', shape: 'polygon', params: { sides: 5 } },
  { id: 'hexagon', label: 'Hexagon', shape: 'polygon', params: { sides: 6 } },
  { id: 'star', label: 'Star', shape: 'star', params: { points: 5, innerRadius: 0.45 } },
  { id: 'burst', label: 'Burst', shape: 'star', params: { points: 12, innerRadius: 0.75 } },
  { id: 'outline', label: 'Outline', shape: 'rectangle', params: { fill: 'transparent', strokeWidth: 12, strokeColor: '#ffffff' } },
  { id: 'ring', label: 'Ring', shape: 'ellipse', params: { fill: 'transparent', strokeWidth: 12, strokeColor: '#ffffff' } },
  { id: 'bar', label: 'Bar', shape: 'rectangle', params: { fill: '#003594' } },
]

/** Standard frame rates, including the NTSC drop-frame family OpenCut supports. */
export const FPS_PRESETS: Array<{ value: number; label: string }> = [
  { value: 23.976, label: '23.976' },
  { value: 24, label: '24' },
  { value: 25, label: '25' },
  { value: 29.97, label: '29.97' },
  { value: 30, label: '30' },
  { value: 50, label: '50' },
  { value: 59.94, label: '59.94' },
  { value: 60, label: '60' },
]

/** Curve presets for the keyframe graph editor. */
export const EASING_PRESETS: Array<{ id: string; label: string; value: CubicBezier }> = [
  { id: 'linear', label: 'Linear', value: [0, 0, 1, 1] },
  { id: 'smooth', label: 'Smooth', value: [0.25, 0.1, 0.25, 1] },
  { id: 'ease-out', label: 'Ease out', value: [0, 0, 0.2, 1] },
  { id: 'ease-in', label: 'Ease in', value: [0.8, 0, 1, 1] },
  { id: 'ease-in-out', label: 'In & out', value: [0.4, 0, 0.2, 1] },
  { id: 'pop', label: 'Pop', value: [0.175, 0.885, 0.32, 1.275] },
]

export type GuideId = 'none' | 'grid' | 'thirds' | 'tiktok' | 'reels' | 'shorts' | 'spotlight'

/** Preview layout guides: safe areas where each platform's own UI covers the video. */
export const GUIDES: Array<{ id: GuideId; label: string }> = [
  { id: 'none', label: 'No guide' },
  { id: 'grid', label: 'Grid' },
  { id: 'thirds', label: 'Rule of thirds' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'reels', label: 'Instagram Reels' },
  { id: 'shorts', label: 'YouTube Shorts' },
  { id: 'spotlight', label: 'Snapchat Spotlight' },
]

export const ANIMATIONS: Array<{ id: AnimationName; label: string; textOnly?: boolean }> = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'zoomIn', label: 'Zoom in' },
  { id: 'zoomOut', label: 'Zoom out' },
  { id: 'slideLeft', label: 'Slide left' },
  { id: 'slideRight', label: 'Slide right' },
  { id: 'slideUp', label: 'Slide up' },
  { id: 'slideDown', label: 'Slide down' },
  { id: 'rotate', label: 'Rotate' },
  { id: 'bounce', label: 'Bounce' },
  { id: 'blur', label: 'Blur' },
  { id: 'pop', label: 'Pop' },
  { id: 'typewriter', label: 'Typewriter', textOnly: true },
]

export const LOOP_ANIMATIONS: Array<{ id: LoopAnimationName; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'wiggle', label: 'Wiggle' },
  { id: 'float', label: 'Float' },
  { id: 'spin', label: 'Spin' },
]

export const TRANSITIONS: Array<{ id: TransitionName; label: string }> = [
  { id: 'dissolve', label: 'Dissolve' },
  { id: 'fadeBlack', label: 'Fade to black' },
  { id: 'fadeWhite', label: 'Flash white' },
  { id: 'wipeLeft', label: 'Wipe left' },
  { id: 'wipeRight', label: 'Wipe right' },
  { id: 'wipeUp', label: 'Wipe up' },
  { id: 'wipeDown', label: 'Wipe down' },
  { id: 'slideLeft', label: 'Slide left' },
  { id: 'slideRight', label: 'Slide right' },
  { id: 'push', label: 'Push' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'circle', label: 'Circle reveal' },
  { id: 'blur', label: 'Blur' },
]

export const EFFECTS: Array<{ id: EffectName; label: string; group: 'Basic' | 'Retro' | 'Motion' | 'Distort' }> = [
  { id: 'blur', label: 'Blur', group: 'Basic' },
  { id: 'vignette', label: 'Vignette', group: 'Basic' },
  { id: 'blackWhite', label: 'Black & white', group: 'Basic' },
  { id: 'sepia', label: 'Sepia', group: 'Basic' },
  { id: 'invert', label: 'Invert', group: 'Basic' },
  { id: 'filmGrain', label: 'Film grain', group: 'Retro' },
  { id: 'vhs', label: 'VHS', group: 'Retro' },
  { id: 'scanlines', label: 'Scanlines', group: 'Retro' },
  { id: 'shake', label: 'Shake', group: 'Motion' },
  { id: 'zoomPulse', label: 'Zoom pulse', group: 'Motion' },
  { id: 'flash', label: 'Flash', group: 'Motion' },
  { id: 'glitch', label: 'Glitch', group: 'Distort' },
  { id: 'rgbSplit', label: 'RGB split', group: 'Distort' },
  { id: 'pixelate', label: 'Pixelate', group: 'Distort' },
  { id: 'mirror', label: 'Mirror', group: 'Distort' },
]

export const VOICE_EFFECTS: Array<{ id: VoiceEffect; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'echo', label: 'Echo' },
  { id: 'hall', label: 'Hall' },
  { id: 'telephone', label: 'Telephone' },
  { id: 'radio', label: 'Radio' },
  { id: 'megaphone', label: 'Megaphone' },
  { id: 'robot', label: 'Robot' },
  { id: 'deep', label: 'Deep' },
  { id: 'chipmunk', label: 'Chipmunk' },
]

/** CapCut speed presets (Speed → Normal) and its 0.1x–100x range. */
export const SPEED_PRESETS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 5, 10, 25, 50, 100]
export const SPEED_MIN = 0.1
export const SPEED_MAX = 100

/** CapCut loudness targets ("Normalize loudness"). */
export const LOUDNESS_TARGETS = [
  { id: 'default', label: 'Default (-23 LUFS)', lufs: -23 },
  { id: 'youtube', label: 'YouTube (-14 LUFS)', lufs: -14 },
  { id: 'tiktok', label: 'TikTok (-12 LUFS)', lufs: -12 },
] as const

export const FONT_FAMILIES = [
  'Inter',
  'Montserrat',
  'Poppins',
  'Roboto',
  'Oswald',
  'Bebas Neue',
  'Anton',
  'Archivo Black',
  'Playfair Display',
  'Lora',
  'Space Grotesk',
  'Pacifico',
  'Lobster',
  'Dancing Script',
  'Permanent Marker',
  'Bangers',
  'Caveat',
  'Righteous',
] as const

export const STICKERS = [
  '🔥', '⭐', '❤️', '👍', '😂', '😍', '🎉', '💯', '✅', '❌', '👀', '🚀',
  '💰', '📈', '🎯', '⚡', '💡', '🙌', '👇', '👉', '🤯', '😎', '🏆', '📣',
]

export const MARKER_COLORS = ['#3B82F6', '#EF4444', '#F59E0B', '#10B981', '#A855F7', '#EC4899']

// ── Neutral values ──────────────────────────────────────────────────────────

export const neutralAdjust = (): Adjust => ({
  brightness: 0,
  contrast: 0,
  saturation: 0,
  exposure: 0,
  temperature: 0,
  tint: 0,
  highlights: 0,
  shadows: 0,
  hue: 0,
  sharpen: 0,
  vignette: 0,
  fade: 0,
  grain: 0,
})

export const isNeutralAdjust = (a: Adjust | null | undefined) =>
  !a || Object.values(a).every((v) => v === 0)

export const defaultTransform = (): Transform => ({ x: 0, y: 0, scale: 1, rotation: 0, flipH: false, flipV: false })

export const fullCrop = (): Crop => ({ x: 0, y: 0, w: 1, h: 1 })

export const defaultMask = (): Mask => ({
  shape: 'none',
  x: 0,
  y: 0,
  width: 0.6,
  height: 0.6,
  rotation: 0,
  feather: 0,
  roundness: 0,
  invert: false,
  strokeColor: '#ffffff',
  strokeWidth: 0,
  text: 'MASK',
  fontFamily: 'Anton',
  path: [],
})

export const defaultChroma = (): ChromaKey => ({ enabled: false, color: '#00ff00', intensity: 40, shadow: 20 })

export const defaultAnimation = (): ClipAnimation => ({
  in: { name: 'none', duration: 0.5 },
  out: { name: 'none', duration: 0.5 },
  loop: { name: 'none', period: 1.5 },
})

export const defaultTextStyle = (): TextStyle => ({
  fontFamily: 'Inter',
  fontSize: 72,
  color: '#ffffff',
  bold: true,
  italic: false,
  underline: false,
  align: 'center',
  letterSpacing: 0,
  lineHeight: 1.2,
  strokeColor: '#000000',
  strokeWidth: 0,
  shadowColor: 'rgba(0,0,0,0.6)',
  shadowBlur: 8,
  shadowX: 0,
  shadowY: 3,
  bgColor: '#000000',
  bgOpacity: 0,
  bgPadding: 16,
  bgRadius: 12,
  maxWidth: 0.85,
  highlightColor: null,
})

/** CapCut-style caption looks ("Caption templates"). */
export const CAPTION_PRESETS: Array<{ id: string; label: string; style: Partial<TextStyle> }> = [
  { id: 'classic', label: 'Classic', style: { color: '#ffffff', strokeWidth: 6, strokeColor: '#000000', bgOpacity: 0, highlightColor: null } },
  { id: 'boxed', label: 'Boxed', style: { color: '#ffffff', strokeWidth: 0, bgColor: '#000000', bgOpacity: 0.7, highlightColor: null } },
  { id: 'yellow', label: 'Yellow pop', style: { color: '#FFE600', strokeWidth: 8, strokeColor: '#000000', bgOpacity: 0, highlightColor: null } },
  { id: 'karaoke', label: 'Word highlight', style: { color: '#ffffff', strokeWidth: 6, strokeColor: '#000000', bgOpacity: 0, highlightColor: '#22D3EE' } },
  { id: 'brand', label: 'RocStarr blue', style: { color: '#ffffff', strokeWidth: 0, bgColor: '#003594', bgOpacity: 0.9, highlightColor: '#FFD100' } },
  { id: 'minimal', label: 'Minimal', style: { color: '#ffffff', strokeWidth: 0, bgOpacity: 0, shadowBlur: 12, highlightColor: null, bold: false } },
]

// ── Factories ───────────────────────────────────────────────────────────────

export const createTrack = (kind: TrackKind, opts: Partial<Track> = {}): Track => ({
  id: newId(),
  kind,
  name: opts.name ?? { video: 'Video', text: 'Text', effect: 'Effects', audio: 'Audio' }[kind],
  isMain: false,
  hidden: false,
  muted: false,
  locked: false,
  ...opts,
})

export const createProject = (name = 'Untitled project', ratio = '16:9'): Project => {
  const r = CANVAS_RATIOS.find((x) => x.id === ratio) ?? CANVAS_RATIOS[0]
  const now = Date.now()
  return {
    id: newId(),
    name,
    version: 1,
    fps: 30,
    canvas: { ratio: r.id, width: r.width, height: r.height, background: { type: 'color', color: '#000000' } },
    scene: { id: newId(), name: 'Scene 1', order: 0 },
    otherScenes: [],
    tracks: [createTrack('video', { isMain: true, name: 'Main track' }), createTrack('audio')],
    clips: [],
    markers: [],
    bin: [],
    createdAt: now,
    updatedAt: now,
  }
}

const IMAGE_DEFAULT_DURATION = 5

export const createMediaClip = (asset: Asset & { kind: MediaAssetKind }, trackId: string, start: number): MediaClip => ({
  id: newId(),
  trackId,
  name: asset.name,
  type: asset.kind,
  assetId: asset.id,
  start,
  duration: asset.kind === 'image' ? IMAGE_DEFAULT_DURATION : Math.max(0.1, asset.duration),
  sourceIn: 0,
  speed: 1,
  volume: 1,
  muted: false,
  fadeIn: 0,
  fadeOut: 0,
  preservePitch: true,
  voiceEffect: 'none',
  denoise: false,
  transform: defaultTransform(),
  crop: fullCrop(),
  opacity: 1,
  blend: 'normal',
  adjust: neutralAdjust(),
  filter: null,
  mask: defaultMask(),
  chroma: defaultChroma(),
  animation: defaultAnimation(),
  transitionOut: null,
  removeBackground: false,
  beats: [],
  keyframes: {},
})

export const createTextClip = (trackId: string, start: number, text = 'Default text', opts: Partial<TextClip> = {}): TextClip => ({
  id: newId(),
  trackId,
  name: text.slice(0, 40),
  type: 'text',
  start,
  duration: 3,
  text,
  style: defaultTextStyle(),
  transform: defaultTransform(),
  opacity: 1,
  animation: defaultAnimation(),
  isCaption: false,
  isSticker: false,
  words: null,
  keyframes: {},
  ...opts,
})

export const createShapeClip = (trackId: string, start: number, shape: ShapeKind, size: number, opts: Partial<ShapeClip> = {}): ShapeClip => ({
  id: newId(),
  trackId,
  name: SHAPES.find((s) => s.id === shape)?.label ?? 'Shape',
  type: 'shape',
  start,
  duration: 5,
  shape,
  width: size,
  height: size,
  fill: '#FFD100',
  strokeColor: '#ffffff',
  strokeWidth: 0,
  strokeAlign: 'center',
  cornerRadius: 0,
  sides: 6,
  points: 5,
  innerRadius: 0.45,
  transform: defaultTransform(),
  opacity: 1,
  blend: 'normal',
  mask: defaultMask(),
  animation: defaultAnimation(),
  keyframes: {},
  ...opts,
})

/** Looks that read as broken when half-applied start at full strength; motion and texture effects start subtler. */
const FULL_STRENGTH: EffectName[] = ['blackWhite', 'sepia', 'invert', 'mirror', 'pixelate']

export const createEffectClip = (trackId: string, start: number, effect: EffectName, opts: Partial<EffectClip> = {}): EffectClip => ({
  id: newId(),
  trackId,
  name: EFFECTS.find((e) => e.id === effect)?.label ?? 'Effect',
  type: 'effect',
  start,
  duration: 3,
  effect,
  intensity: FULL_STRENGTH.includes(effect) ? 100 : 60,
  filter: null,
  adjust: null,
  keyframes: {},
  ...opts,
})
