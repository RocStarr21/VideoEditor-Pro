import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react'
import { evaluateExpression } from '../engine/expr'
import { beginEdit, endEdit } from '../state/actions'

export { ColorInput } from './ColorPicker'

export const cx = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(' ')

export function Section({ title, children, right, defaultOpen = true }: { title: string; children: ReactNode; right?: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section className="border-b border-white/[0.06] px-4 py-3">
      <div className="mb-2 flex items-center justify-between">
        <button type="button" onClick={() => setOpen((v) => !v)} className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-zinc-400 hover:text-zinc-200">
          <span className={cx('inline-block transition-transform', open ? 'rotate-90' : '')}>▸</span>
          {title}
        </button>
        {right}
      </div>
      {open && <div className="space-y-3">{children}</div>}
    </section>
  )
}

export function Row({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-24 shrink-0 text-xs text-zinc-400" title={hint}>
        {label}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
    </div>
  )
}

const decimalsOf = (step: number) => Math.max(0, Math.min(6, Math.ceil(-Math.log10(step))))

/**
 * Numeric box (OpenCut "number input"): accepts maths (`100*2`, `+10`, `-5`,
 * `50%`), commits on Enter/blur, and scrubs when dragged sideways (Shift ×10,
 * Alt ×0.1). Scrubs preview live and record one undo step on release.
 */
export function NumberField({
  value,
  min = -Infinity,
  max = Infinity,
  step = 1,
  onChange,
  onLive,
  format,
  suffix,
  disabled,
  width = 'w-[4.25rem]',
  title,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  onChange: (v: number) => void
  onLive?: (v: number) => void
  format?: (v: number) => string
  suffix?: string
  disabled?: boolean
  width?: string
  title?: string
}) {
  const shown = format ? format(value) : String(Math.round(value * 100) / 100)
  const [text, setText] = useState(shown)
  const [editing, setEditing] = useState(false)
  const skipBlur = useRef(false)
  useEffect(() => {
    if (!editing) setText(shown)
  }, [shown, editing])

  const clamp = (n: number) => Math.min(max, Math.max(min, n))
  const quantise = (n: number) => Number((Math.round(n / step) * step).toFixed(decimalsOf(step)))

  const commit = () => {
    setEditing(false)
    if (skipBlur.current) {
      skipBlur.current = false
      return
    }
    const n = evaluateExpression(text, value)
    if (n !== null && Number.isFinite(n)) onChange(clamp(n))
    else setText(shown)
  }

  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (disabled || e.button !== 0) return
    const startX = e.clientX
    const base = value
    let moved = false
    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - startX
      if (!moved && Math.abs(dx) < 4) return
      if (!moved) {
        moved = true
        skipBlur.current = true
        ;(document.activeElement as HTMLElement | null)?.blur()
        if (onLive) beginEdit()
      }
      const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1
      ;(onLive ?? onChange)(clamp(quantise(base + (dx / 2) * step * mult)))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      if (moved && onLive) endEdit()
      skipBlur.current = false
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div
      className={cx('flex shrink-0 cursor-ew-resize items-center rounded-md border border-white/10 bg-black/30 pr-1.5 focus-within:border-blue-500', width, disabled && 'opacity-50')}
      onPointerDown={scrub}
      title={title ?? 'Type a value or expression (e.g. 50%, +10, 1920/2) — drag to scrub'}
    >
      <input
        className="w-full min-w-0 cursor-text bg-transparent px-1.5 py-1 text-right text-xs tabular-nums text-zinc-100 outline-none"
        value={text}
        disabled={disabled}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
          if (e.key === 'Escape') {
            setText(shown)
            ;(e.target as HTMLInputElement).blur()
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault()
            const mult = e.shiftKey ? 10 : 1
            onChange(clamp(quantise(value + (e.key === 'ArrowUp' ? 1 : -1) * step * mult)))
          }
          e.stopPropagation()
        }}
      />
      {suffix && <span className="text-[10px] text-zinc-500">{suffix}</span>}
    </div>
  )
}

/**
 * Slider with a numeric box. Dragging previews live and records a single undo
 * step on release (via `live` + begin/end edit); typing commits on blur/enter.
 */
export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onLive,
  format,
  suffix,
  disabled,
}: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  /** Called during drag; when omitted, onChange is used for every movement. */
  onLive?: (v: number) => void
  format?: (v: number) => string
  suffix?: string
  disabled?: boolean
}) {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <input
        type="range"
        className="ve-range min-w-0 flex-1"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        disabled={disabled}
        onPointerDown={() => onLive && beginEdit()}
        onPointerUp={() => onLive && endEdit()}
        onKeyUp={() => onLive && endEdit()}
        onChange={(e) => (onLive ?? onChange)(Number(e.target.value))}
      />
      <NumberField value={value} min={min} max={max} step={step} onChange={onChange} onLive={onLive} format={format} suffix={suffix} disabled={disabled} />
    </div>
  )
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cx('relative h-5 w-9 shrink-0 rounded-full transition-colors', checked ? 'bg-blue-500' : 'bg-zinc-700')}
    >
      <span className={cx('absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-[18px]' : 'translate-x-0.5')} />
    </button>
  )
}

export function Segmented<T extends string | number>({
  value,
  options,
  onChange,
  size = 'sm',
}: {
  value: T
  options: Array<{ value: T; label: ReactNode; title?: string }>
  onChange: (v: T) => void
  size?: 'sm' | 'xs'
}) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg bg-black/30 p-0.5">
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          title={o.title}
          onClick={() => onChange(o.value)}
          className={cx(
            'rounded-md font-medium transition-colors',
            size === 'xs' ? 'px-2 py-0.5 text-[11px]' : 'px-2.5 py-1 text-xs',
            o.value === value ? 'bg-blue-500 text-white shadow' : 'text-zinc-300 hover:bg-white/10',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function Select<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as T)}
      className="w-full min-w-0 rounded-md border border-white/10 bg-[#1b1f27] px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-blue-500"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function Button({
  children,
  onClick,
  variant = 'ghost',
  disabled,
  title,
  className,
  type = 'button',
}: {
  children: ReactNode
  onClick?: () => void
  variant?: 'primary' | 'ghost' | 'outline' | 'danger'
  disabled?: boolean
  title?: string
  className?: string
  type?: 'button' | 'submit'
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40',
        variant === 'primary' && 'bg-blue-500 text-white hover:bg-blue-400',
        variant === 'ghost' && 'text-zinc-200 hover:bg-white/10',
        variant === 'outline' && 'border border-white/15 text-zinc-100 hover:bg-white/10',
        variant === 'danger' && 'text-red-300 hover:bg-red-500/15',
        className,
      )}
    >
      {children}
    </button>
  )
}

/** Small diamond toggle shown next to keyframeable properties. */
export function KeyframeButton({ active, keyed, onClick }: { active: boolean; keyed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      title={active ? 'Remove keyframe at playhead' : 'Add keyframe at playhead'}
      onClick={onClick}
      className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-white/10', keyed ? 'text-blue-400' : 'text-zinc-500')}
    >
      <span className={cx('block h-2.5 w-2.5 rotate-45 border', active ? 'border-blue-400 bg-blue-400' : 'border-current')} />
    </button>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="px-4 py-8 text-center text-xs leading-5 text-zinc-500">{children}</div>
}

export function formatTimecode(seconds: number, fps = 30) {
  const s = Math.max(0, seconds)
  const m = Math.floor(s / 60)
  const sec = Math.floor(s % 60)
  const f = Math.floor((s - Math.floor(s)) * fps)
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`
}

export function formatDuration(seconds: number) {
  const s = Math.max(0, Math.round(seconds * 10) / 10)
  if (s < 60) return `${s.toFixed(1)}s`
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}
