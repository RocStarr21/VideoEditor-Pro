import type { Adjust, FilterRef } from '../model/types'
import { neutralAdjust } from '../model/defaults'

type Rgb = [number, number, number]

/** A clip's manual adjustment and its built-in look, merged into one set of shader inputs. */
export interface ColorGrade extends Adjust {
  /** Split-toning color for the shadows, rgb 0..1. */
  shadowTint: Rgb | null
  /** Split-toning color for the highlights, rgb 0..1. */
  highlightTint: Rgb | null
  /** 0..1 */
  tintAmount: number
}

export interface FilterPreset {
  id: string
  name: string
  group: 'Life' | 'Film' | 'Vintage' | 'Mono' | 'Cinematic'
  /** Deltas added on top of the clip's own adjustment, scaled by the filter intensity. */
  adjust: Partial<Adjust>
  shadowTint?: Rgb
  highlightTint?: Rgb
  tintAmount?: number
  /** CSS background used as the preset thumbnail. */
  swatch: string
}

export const FILTER_PRESETS: FilterPreset[] = [
  // Life
  {
    id: 'punch',
    name: 'Punch',
    group: 'Life',
    adjust: { saturation: 30, contrast: 15, exposure: 3, sharpen: 10 },
    swatch: 'linear-gradient(135deg, #ff3d6e 0%, #ffb800 50%, #00c2ff 100%)',
  },
  {
    id: 'sunlit',
    name: 'Sunlit',
    group: 'Life',
    adjust: { temperature: 30, tint: 4, saturation: 8, brightness: 4, highlights: -5 },
    swatch: 'linear-gradient(135deg, #ffcf7a 0%, #ff8a3d 100%)',
  },
  {
    id: 'glacier',
    name: 'Glacier',
    group: 'Life',
    adjust: { temperature: -30, tint: -3, saturation: -5, contrast: 6, brightness: 3 },
    swatch: 'linear-gradient(135deg, #bfe6ff 0%, #3c8dde 100%)',
  },
  {
    id: 'daybreak',
    name: 'Daybreak',
    group: 'Life',
    adjust: { exposure: 12, brightness: 6, shadows: 20, highlights: -10, saturation: 6 },
    swatch: 'linear-gradient(135deg, #fffbe8 0%, #ffd9a0 100%)',
  },
  {
    id: 'cotton',
    name: 'Cotton',
    group: 'Life',
    adjust: { contrast: -18, highlights: -15, shadows: 15, saturation: -10, fade: 15, brightness: 4 },
    swatch: 'linear-gradient(135deg, #fde2e4 0%, #e2ece9 100%)',
  },

  // Film
  {
    id: 'reel-35',
    name: 'Reel 35',
    group: 'Film',
    adjust: { contrast: 12, saturation: -12, fade: 18, grain: 22, temperature: 6 },
    shadowTint: [0.18, 0.32, 0.36],
    highlightTint: [1, 0.86, 0.66],
    tintAmount: 0.25,
    swatch: 'linear-gradient(135deg, #2f4f4f 0%, #d9b48f 100%)',
  },
  {
    id: 'reel-120',
    name: 'Reel 120',
    group: 'Film',
    adjust: { contrast: 8, saturation: 6, highlights: -12, shadows: 8, grain: 12, temperature: -4 },
    shadowTint: [0.2, 0.25, 0.42],
    highlightTint: [0.95, 0.9, 0.78],
    tintAmount: 0.2,
    swatch: 'linear-gradient(135deg, #3a4a6b 0%, #efe3c8 100%)',
  },
  {
    id: 'amber-stock',
    name: 'Amber Stock',
    group: 'Film',
    adjust: { temperature: 25, tint: 6, contrast: 14, saturation: 10, fade: 10, grain: 18 },
    shadowTint: [0.35, 0.22, 0.15],
    highlightTint: [1, 0.78, 0.45],
    tintAmount: 0.3,
    swatch: 'linear-gradient(135deg, #7a3e12 0%, #ffc66b 100%)',
  },
  {
    id: 'faded-print',
    name: 'Faded Print',
    group: 'Film',
    adjust: { fade: 40, contrast: -15, saturation: -20, highlights: -10, temperature: 4 },
    swatch: 'linear-gradient(135deg, #c9c2b8 0%, #8e9aa6 100%)',
  },

  // Vintage
  {
    id: 'heirloom',
    name: 'Heirloom',
    group: 'Vintage',
    adjust: { saturation: -30, temperature: 22, fade: 25, contrast: -5, vignette: 30, grain: 20 },
    shadowTint: [0.32, 0.24, 0.18],
    highlightTint: [1, 0.88, 0.62],
    tintAmount: 0.3,
    swatch: 'linear-gradient(135deg, #8b6b47 0%, #e8d3a8 100%)',
  },
  {
    id: 'arcade-85',
    name: "Arcade '85",
    group: 'Vintage',
    adjust: { saturation: 25, contrast: 20, hue: -6, tint: 10, fade: 12 },
    shadowTint: [0.35, 0.15, 0.5],
    highlightTint: [1, 0.75, 0.55],
    tintAmount: 0.3,
    swatch: 'linear-gradient(135deg, #5b2a86 0%, #ff7eb6 55%, #ffd28a 100%)',
  },
  {
    id: 'instant',
    name: 'Instant',
    group: 'Vintage',
    adjust: { fade: 22, contrast: -8, saturation: -8, temperature: 10, tint: -6, highlights: -15, vignette: 15 },
    shadowTint: [0.2, 0.35, 0.35],
    highlightTint: [1, 0.95, 0.82],
    tintAmount: 0.25,
    swatch: 'linear-gradient(135deg, #a7c4bc 0%, #f5e6c8 100%)',
  },
  {
    id: 'sun-bleached',
    name: 'Sun-Bleached',
    group: 'Vintage',
    adjust: { exposure: 10, saturation: -25, fade: 20, contrast: -10, temperature: 12, highlights: -5 },
    swatch: 'linear-gradient(135deg, #f3e7d3 0%, #c7b8a1 100%)',
  },

  // Mono
  {
    id: 'silver',
    name: 'Silver',
    group: 'Mono',
    adjust: { saturation: -100, contrast: 12 },
    swatch: 'linear-gradient(135deg, #f2f2f2 0%, #3a3a3a 100%)',
  },
  {
    id: 'noir',
    name: 'Noir',
    group: 'Mono',
    adjust: { saturation: -100, contrast: 40, shadows: -20, exposure: -5, vignette: 40, grain: 15 },
    swatch: 'linear-gradient(135deg, #5a5a5a 0%, #050505 100%)',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    group: 'Mono',
    adjust: { saturation: -100, contrast: 70, highlights: 10, shadows: -25, sharpen: 20 },
    swatch: 'linear-gradient(135deg, #ffffff 0%, #ffffff 45%, #000000 55%, #000000 100%)',
  },
  {
    id: 'selenium',
    name: 'Selenium',
    group: 'Mono',
    adjust: { saturation: -100, contrast: 15, fade: 8 },
    shadowTint: [0.3, 0.38, 0.55],
    highlightTint: [0.85, 0.8, 0.72],
    tintAmount: 0.35,
    swatch: 'linear-gradient(135deg, #e6ddd0 0%, #3d4a66 100%)',
  },

  // Cinematic
  {
    id: 'harbor-lights',
    name: 'Harbor Lights',
    group: 'Cinematic',
    adjust: { contrast: 18, saturation: 12, highlights: -8 },
    shadowTint: [0.05, 0.45, 0.5],
    highlightTint: [1, 0.62, 0.3],
    tintAmount: 0.4,
    swatch: 'linear-gradient(135deg, #0f5e66 0%, #ff9a4d 100%)',
  },
  {
    id: 'overcast',
    name: 'Overcast',
    group: 'Cinematic',
    adjust: { exposure: -8, contrast: 15, saturation: -25, highlights: -20, shadows: -10, temperature: -10, vignette: 25 },
    shadowTint: [0.15, 0.22, 0.3],
    tintAmount: 0.2,
    swatch: 'linear-gradient(135deg, #3b4652 0%, #8a96a3 100%)',
  },
  {
    id: 'magic-hour',
    name: 'Magic Hour',
    group: 'Cinematic',
    adjust: { temperature: 35, tint: 8, exposure: 4, saturation: 15, highlights: -10, shadows: 5 },
    highlightTint: [1, 0.72, 0.35],
    tintAmount: 0.25,
    swatch: 'linear-gradient(135deg, #ff8c42 0%, #ffd166 100%)',
  },
  {
    id: 'box-office',
    name: 'Box Office',
    group: 'Cinematic',
    adjust: { contrast: 25, saturation: -5, sharpen: 15, vignette: 20, highlights: -10, shadows: -5 },
    shadowTint: [0.08, 0.3, 0.4],
    highlightTint: [1, 0.75, 0.5],
    tintAmount: 0.3,
    swatch: 'linear-gradient(135deg, #0b2a3a 0%, #e0a060 100%)',
  },
  {
    id: 'velvet-matte',
    name: 'Velvet Matte',
    group: 'Cinematic',
    adjust: { fade: 30, contrast: -10, saturation: -10, highlights: -12, shadows: 10, temperature: 3 },
    swatch: 'linear-gradient(135deg, #6d6875 0%, #e5989b 100%)',
  },
]

const UNIPOLAR = new Set<keyof Adjust>(['sharpen', 'vignette', 'fade', 'grain'])

const ADJUST_KEYS = Object.keys(neutralAdjust()) as Array<keyof Adjust>

const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)

const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v)

export function getFilterPreset(id: string): FilterPreset | undefined {
  return FILTER_PRESETS.find((p) => p.id === id)
}

export function resolveColorGrade(adjust: Adjust | null, filter: FilterRef | null): ColorGrade {
  const out = neutralAdjust()
  if (adjust) for (const k of ADJUST_KEYS) out[k] += finite(adjust[k])

  // 'lut:<assetId>' filters are applied as a 3D LUT by the renderer, not as adjust deltas.
  const preset = filter && !filter.id.startsWith('lut:') ? getFilterPreset(filter.id) : undefined
  const scale = preset ? clamp(finite(filter?.intensity), 0, 100) / 100 : 0

  if (preset && scale > 0) {
    for (const k of ADJUST_KEYS) out[k] += finite(preset.adjust[k]) * scale
  }
  for (const k of ADJUST_KEYS) out[k] = UNIPOLAR.has(k) ? clamp(out[k], 0, 100) : clamp(out[k], -100, 100)

  const tintAmount = preset ? clamp(finite(preset.tintAmount) * scale, 0, 1) : 0
  const shadowTint: Rgb | null = tintAmount > 0 && preset?.shadowTint ? [...preset.shadowTint] : null
  const highlightTint: Rgb | null = tintAmount > 0 && preset?.highlightTint ? [...preset.highlightTint] : null
  return { ...out, shadowTint, highlightTint, tintAmount: shadowTint || highlightTint ? tintAmount : 0 }
}

export function isGradeNeutral(g: ColorGrade): boolean {
  for (const k of ADJUST_KEYS) if (g[k] !== 0) return false
  return !(g.tintAmount > 0 && (g.shadowTint || g.highlightTint))
}
