/**
 * Canvas text layout and drawing for text, caption and sticker clips.
 * Layout is word-based so captions can highlight the word being spoken and
 * typewriter animations can reveal character by character.
 */
import { FONT_FAMILIES } from '../model/defaults'
import type { TextStyle } from '../model/types'

type Ctx = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D

export interface LayoutToken {
  text: string
  x: number
  width: number
  /** Running index across all lines, matching caption word order. */
  index: number
}

export interface LayoutLine {
  tokens: LayoutToken[]
  width: number
}

export interface TextLayout {
  lines: LayoutLine[]
  width: number
  height: number
  lineHeight: number
  font: string
  spaceWidth: number
  charCount: number
}

export function fontString(style: TextStyle, k: number) {
  const weight = style.bold ? 700 : 400
  return `${style.italic ? 'italic ' : ''}${weight} ${Math.max(1, style.fontSize * k)}px "${style.fontFamily}", "Inter Variable", system-ui, sans-serif`
}

function applyFont(ctx: Ctx, style: TextStyle, k: number) {
  ctx.font = fontString(style, k)
  if ('letterSpacing' in ctx) (ctx as CanvasRenderingContext2D).letterSpacing = `${style.letterSpacing * k}px`
}

/** Greedy word wrap within `maxWidth`; explicit newlines always break. */
export function layoutText(ctx: Ctx, text: string, style: TextStyle, k: number, canvasWidth: number): TextLayout {
  applyFont(ctx, style, k)
  const maxWidth = Math.max(10, style.maxWidth * canvasWidth * k)
  const spaceWidth = ctx.measureText(' ').width
  const lineHeight = style.fontSize * k * style.lineHeight
  const lines: LayoutLine[] = []
  let index = 0
  let charCount = 0

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/\s+/).filter(Boolean)
    let line: LayoutLine = { tokens: [], width: 0 }
    if (!words.length) {
      lines.push(line)
      continue
    }
    for (const word of words) {
      const w = ctx.measureText(word).width
      const next = line.tokens.length ? line.width + spaceWidth + w : w
      if (line.tokens.length && next > maxWidth) {
        lines.push(line)
        line = { tokens: [], width: 0 }
      }
      const x = line.tokens.length ? line.width + spaceWidth : 0
      line.tokens.push({ text: word, x, width: w, index: index++ })
      line.width = x + w
      charCount += word.length
    }
    lines.push(line)
  }

  const width = lines.reduce((m, l) => Math.max(m, l.width), 0)
  return { lines, width, height: lines.length * lineHeight, lineHeight, font: ctx.font, spaceWidth, charCount }
}

function roundRect(ctx: Ctx, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.min(r, w / 2, h / 2)
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

export interface DrawTextOptions {
  /** 0..1 fraction of characters shown (typewriter). */
  reveal: number
  /** Index of the word to highlight, or null. */
  activeWord: number | null
}

/** Size of the drawn block including background padding, in target pixels. */
export function textBoxSize(layout: TextLayout, style: TextStyle, k: number) {
  const pad = style.bgOpacity > 0 ? style.bgPadding * k : 0
  return { width: layout.width + pad * 2, height: layout.height + pad * 2 }
}

/** Draws a laid-out block centred on the current origin. */
export function drawText(ctx: Ctx, layout: TextLayout, style: TextStyle, k: number, opts: DrawTextOptions) {
  applyFont(ctx, style, k)
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  const { width, height } = textBoxSize(layout, style, k)

  if (style.bgOpacity > 0) {
    ctx.save()
    ctx.globalAlpha *= style.bgOpacity
    ctx.fillStyle = style.bgColor
    roundRect(ctx, -width / 2, -height / 2, width, height, style.bgRadius * k)
    ctx.fill()
    ctx.restore()
  }

  let remaining = opts.reveal >= 1 ? Infinity : Math.floor(opts.reveal * layout.charCount)
  const top = -layout.height / 2

  layout.lines.forEach((line, li) => {
    const offset =
      style.align === 'left' ? -layout.width / 2 : style.align === 'right' ? layout.width / 2 - line.width : -line.width / 2
    const y = top + layout.lineHeight * (li + 0.5)

    for (const token of line.tokens) {
      if (remaining <= 0) return
      const text = remaining >= token.text.length ? token.text : token.text.slice(0, remaining)
      remaining -= token.text.length
      const x = offset + token.x
      const highlighted = opts.activeWord !== null && token.index === opts.activeWord && !!style.highlightColor

      if (style.strokeWidth > 0) {
        ctx.save()
        ctx.lineJoin = 'round'
        ctx.miterLimit = 2
        ctx.strokeStyle = style.strokeColor
        ctx.lineWidth = style.strokeWidth * k
        ctx.strokeText(text, x, y)
        ctx.restore()
      }

      ctx.save()
      if (style.shadowBlur > 0 || style.shadowX !== 0 || style.shadowY !== 0) {
        ctx.shadowColor = style.shadowColor
        ctx.shadowBlur = style.shadowBlur * k
        ctx.shadowOffsetX = style.shadowX * k
        ctx.shadowOffsetY = style.shadowY * k
      }
      ctx.fillStyle = highlighted ? style.highlightColor! : style.color
      ctx.fillText(text, x, y)
      ctx.restore()

      if (style.underline) {
        const w = text === token.text ? token.width : ctx.measureText(text).width
        ctx.fillStyle = highlighted ? style.highlightColor! : style.color
        ctx.fillRect(x, y + style.fontSize * k * 0.45, w, Math.max(1, style.fontSize * k * 0.06))
      }
    }
  })
}

// ── Fonts ───────────────────────────────────────────────────────────────────

const GOOGLE_FONTS = FONT_FAMILIES.filter((f) => f !== 'Inter')
let fontsLinked = false

/** Adds the Google Fonts stylesheet for the text panel's font list (once). */
export function linkWebFonts() {
  if (fontsLinked || typeof document === 'undefined') return
  fontsLinked = true
  const families = GOOGLE_FONTS.map((f) => `family=${encodeURIComponent(f).replace(/%20/g, '+')}:ital,wght@0,400;0,700;1,400;1,700`).join('&')
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?${families}&display=swap`
  document.head.appendChild(link)
}

const fontState = new Map<string, 'loading' | 'ready'>()
const linkedFamilies = new Set<string>()
const SYSTEM = new Set(['arial', 'helvetica', 'times new roman', 'georgia', 'courier new', 'verdana', 'trebuchet ms', 'impact', 'tahoma', 'segoe ui', 'monospace', 'sans-serif', 'serif', 'inter'])

/** Adds a Google Fonts stylesheet for one family the first time it is used (system fonts need none). */
export function ensureFontLinked(family: string) {
  if (typeof document === 'undefined') return
  const name = family.trim()
  if (!name || SYSTEM.has(name.toLowerCase()) || linkedFamilies.has(name) || (FONT_FAMILIES as readonly string[]).includes(name)) return
  linkedFamilies.add(name)
  const link = document.createElement('link')
  link.rel = 'stylesheet'
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(name).replace(/%20/g, '+')}:ital,wght@0,400;0,700;1,400;1,700&display=swap`
  document.head.appendChild(link)
}

/**
 * Starts loading a font face and reports whether it is ready now. Canvas text
 * silently falls back while a web font loads, so the caller re-renders once
 * `onReady` fires.
 */
export function ensureFont(style: TextStyle, onReady: () => void): boolean {
  if (typeof document === 'undefined' || !document.fonts) return true
  const key = `${style.fontFamily}|${style.bold}|${style.italic}`
  const state = fontState.get(key)
  if (state === 'ready') return true
  if (state === 'loading') return false
  fontState.set(key, 'loading')
  ensureFontLinked(style.fontFamily)
  document.fonts
    .load(fontString({ ...style, fontSize: 48 }, 1))
    .then(() => {
      fontState.set(key, 'ready')
      onReady()
    })
    .catch(() => fontState.set(key, 'ready'))
  return false
}

/** Waits until every font used by `styles` is ready (for export). */
export async function loadFonts(styles: TextStyle[]) {
  if (typeof document === 'undefined' || !document.fonts) return
  for (const s of styles) ensureFontLinked(s.fontFamily)
  await Promise.all(styles.map((s) => document.fonts.load(fontString({ ...s, fontSize: 48 }, 1)).catch(() => undefined)))
}
