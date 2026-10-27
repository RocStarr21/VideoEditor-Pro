import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { cx } from './controls'

export interface MenuItem {
  label: string
  icon?: ReactNode
  shortcut?: string
  onSelect?: () => void
  disabled?: boolean
  danger?: boolean
  /** Renders a separator above this item. */
  separator?: boolean
}

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

/** Right-click menu positioned at a screen point; closes on outside click, scroll or Escape. */
export function ContextMenu({ menu, onClose }: { menu: MenuState; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: menu.x, top: menu.y })

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(4, Math.min(menu.x, window.innerWidth - r.width - 4)),
      top: Math.max(4, Math.min(menu.y, window.innerHeight - r.height - 4)),
    })
  }, [menu])

  useEffect(() => {
    const down = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('pointerdown', down, true)
    window.addEventListener('keydown', key, true)
    window.addEventListener('wheel', onClose, { passive: true, once: true })
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', down, true)
      window.removeEventListener('keydown', key, true)
      window.removeEventListener('wheel', onClose)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  return (
    <div ref={ref} role="menu" className="fixed z-[80] min-w-48 rounded-lg border border-white/10 bg-[#1b1f27] py-1 text-xs text-zinc-100 shadow-2xl" style={pos} onContextMenu={(e) => e.preventDefault()}>
      {menu.items.map((item, i) => (
        <div key={`${item.label}-${i}`}>
          {item.separator && <div className="my-1 h-px bg-white/10" />}
          <button
            type="button"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              if (item.disabled) return
              onClose()
              item.onSelect?.()
            }}
            className={cx('flex w-full items-center gap-2 px-3 py-1.5 text-left disabled:opacity-40', item.danger ? 'text-red-300 hover:bg-red-500/15' : 'hover:bg-white/10')}
          >
            {item.icon && <span className="w-4 shrink-0 text-zinc-400">{item.icon}</span>}
            <span className="flex-1">{item.label}</span>
            {item.shortcut && <kbd className="font-mono text-[10px] text-zinc-500">{item.shortcut}</kbd>}
          </button>
        </div>
      ))}
    </div>
  )
}
