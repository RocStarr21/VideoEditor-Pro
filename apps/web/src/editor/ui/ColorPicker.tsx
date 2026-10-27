import { Pipette } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { formatColor, hsvToRgb, parseColor, rgbToHsv, toCss, type ColorFormat, type Rgba } from '../engine/color'
import { cx } from './controls'

type EyeDropperCtor = new () => { open: () => Promise<{ sRGBHex: string }> }

const SWATCHES = ['#ffffff', '#000000', '#003594', '#FFD100', '#22D3EE', '#EF4444', '#F59E0B', '#10B981', '#A855F7', '#EC4899', '#64748B', 'transparent']

/**
 * Colour field with a popover picker: saturation/value square, hue and
 * alpha sliders, hex / rgb / hsl text entry, swatches and the browser's
 * eyedropper (Chrome and Edge).
 */
export function ColorInput({ value, onChange, allowAlpha = true }: { value: string; onChange: (css: string) => void; allowAlpha?: boolean }) {
  const [open, setOpen] = useState(false)
  const parsed = parseColor(value) ?? { r: 255, g: 255, b: 255, a: 1 }
  const btnRef = useRef<HTMLButtonElement>(null)
  return (
    <div className="relative">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-md border border-white/10 bg-black/30 px-1.5 py-1 hover:border-white/25"
        title="Pick a colour"
      >
        <span className="h-5 w-6 rounded border border-white/20" style={{ background: checker(parsed) }} />
        <span className="font-mono text-[11px] uppercase text-zinc-300">{parsed.a < 1 || value === 'transparent' ? formatColor(parsed, 'hex') : formatColor(parsed, 'hex').slice(0, 7)}</span>
      </button>
      {open && <PickerPopover anchor={btnRef.current} value={parsed} allowAlpha={allowAlpha} onChange={(c) => onChange(toCss(c))} onClose={() => setOpen(false)} />}
    </div>
  )
}

const checker = (c: Rgba) =>
  `linear-gradient(${toCss(c)}, ${toCss(c)}), repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 8px 8px`

function PickerPopover({ anchor, value, allowAlpha, onChange, onClose }: { anchor: HTMLElement | null; value: Rgba; allowAlpha: boolean; onChange: (c: Rgba) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [format, setFormat] = useState<ColorFormat>('hex')
  const [text, setText] = useState(formatColor(value, 'hex'))
  const hsvRef = useRef(rgbToHsv(value))
  // Hue is kept separately: it is undefined for greys and would otherwise snap to 0.
  const [hsv, setHsv] = useState(hsvRef.current)
  const [alpha, setAlpha] = useState(value.a)

  useLayoutEffect(() => {
    if (!anchor) return
    const r = anchor.getBoundingClientRect()
    const width = 248
    const left = Math.min(window.innerWidth - width - 8, Math.max(8, r.right - width))
    const top = r.bottom + 6 + 330 > window.innerHeight ? Math.max(8, r.top - 336) : r.bottom + 6
    setPos({ left, top })
  }, [anchor])

  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && e.target !== anchor && !anchor?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [anchor, onClose])

  const emit = (next: { h: number; s: number; v: number }, a = alpha) => {
    setHsv(next)
    const rgb = hsvToRgb(next.h, next.s, next.v)
    const c = { ...rgb, a }
    setText(formatColor(c, format))
    onChange(c)
  }

  const dragArea = (e: ReactPointerEvent<HTMLDivElement>, fn: (fx: number, fy: number) => void) => {
    const el = e.currentTarget
    el.setPointerCapture(e.pointerId)
    const at = (ev: { clientX: number; clientY: number }) => {
      const r = el.getBoundingClientRect()
      fn(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
    }
    at(e)
    const move = (ev: PointerEvent) => at(ev)
    const up = () => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
  }

  const commitText = () => {
    const c = parseColor(text)
    if (!c) {
      setText(formatColor({ ...hsvToRgb(hsv.h, hsv.s, hsv.v), a: alpha }, format))
      return
    }
    const next = rgbToHsv(c)
    setHsv(next)
    setAlpha(c.a)
    onChange(c)
  }

  const eyedrop = async () => {
    const Ctor = (window as unknown as { EyeDropper?: EyeDropperCtor }).EyeDropper
    if (!Ctor) return
    try {
      const { sRGBHex } = await new Ctor().open()
      const c = parseColor(sRGBHex)
      if (c) {
        const next = rgbToHsv(c)
        setHsv(next)
        onChange({ ...c, a: alpha })
        setText(formatColor({ ...c, a: alpha }, format))
      }
    } catch {
      // Cancelled.
    }
  }

  const hueColor = toCss({ ...hsvToRgb(hsv.h, 1, 1), a: 1 })
  const current = { ...hsvToRgb(hsv.h, hsv.s, hsv.v), a: alpha }
  const hasEyeDropper = typeof window !== 'undefined' && 'EyeDropper' in window

  return (
    <div
      ref={ref}
      className="fixed z-[70] w-[248px] rounded-xl border border-white/10 bg-[#1b1f27] p-3 shadow-2xl"
      style={pos ?? { left: 0, top: 0, visibility: 'hidden' }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div
        className="relative h-36 w-full cursor-crosshair rounded-md"
        style={{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }}
        onPointerDown={(e) => dragArea(e, (fx, fy) => emit({ h: hsv.h, s: fx, v: 1 - fy }))}
      >
        <span className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} />
      </div>
      <div className="mt-2 flex items-center gap-2">
        <div className="flex-1 space-y-2">
          <div
            className="relative h-3 cursor-ew-resize rounded-full"
            style={{ background: 'linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)' }}
            onPointerDown={(e) => dragArea(e, (fx) => emit({ ...hsv, h: fx * 359.999 }))}
          >
            <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow" style={{ left: `${(hsv.h / 360) * 100}%`, background: hueColor }} />
          </div>
          {allowAlpha && (
            <div
              className="relative h-3 cursor-ew-resize rounded-full"
              style={{ background: `linear-gradient(to right, transparent, ${toCss({ ...current, a: 1 })}), repeating-conic-gradient(#777 0 25%, #bbb 0 50%) 0 0 / 8px 8px` }}
              onPointerDown={(e) =>
                dragArea(e, (fx) => {
                  setAlpha(fx)
                  emit(hsv, fx)
                })
              }
            >
              <span className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-zinc-800 shadow" style={{ left: `${alpha * 100}%` }} />
            </div>
          )}
        </div>
        <span className="h-9 w-9 shrink-0 rounded-md border border-white/20" style={{ background: checker(current) }} />
      </div>
      <div className="mt-2 flex items-center gap-1">
        <select value={format} onChange={(e) => {
          const f = e.target.value as ColorFormat
          setFormat(f)
          setText(formatColor(current, f))
        }} className="rounded-md border border-white/10 bg-black/30 px-1 py-1 text-[11px] text-zinc-200">
          <option value="hex">HEX</option>
          <option value="rgb">RGB</option>
          <option value="hsl">HSL</option>
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commitText}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitText()
          }}
          className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/30 px-2 py-1 font-mono text-[11px] text-zinc-100 outline-none focus:border-blue-500"
          aria-label="Colour value"
        />
        {hasEyeDropper && (
          <button type="button" onClick={() => void eyedrop()} title="Pick a colour from the screen" className="rounded-md p-1.5 text-zinc-300 hover:bg-white/10 hover:text-white">
            <Pipette size={14} />
          </button>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-1">
        {SWATCHES.map((s) => (
          <button
            key={s}
            type="button"
            title={s}
            onClick={() => {
              const c = parseColor(s)!
              const next = rgbToHsv(c)
              setHsv(next)
              setAlpha(c.a)
              setText(formatColor(c, format))
              onChange(c)
            }}
            className={cx('h-5 w-5 rounded border border-white/20', s === 'transparent' && 'bg-[repeating-conic-gradient(#777_0_25%,#bbb_0_50%)] bg-[length:8px_8px]')}
            style={s === 'transparent' ? undefined : { background: s }}
          />
        ))}
      </div>
    </div>
  )
}
