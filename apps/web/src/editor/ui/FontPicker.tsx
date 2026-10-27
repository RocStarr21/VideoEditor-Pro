import { ChevronDown, Search } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { FONT_FAMILIES } from '../model/defaults'
import { ensureFontLinked } from '../engine/text'
import { cx } from './controls'

type Catalog = { google: readonly string[]; system: readonly string[] }

let catalogPromise: Promise<Catalog> | null = null
const loadCatalog = () =>
  (catalogPromise ??= import('../engine/fonts').then((m) => ({ google: m.GOOGLE_FONT_FAMILIES, system: m.SYSTEM_FONTS })))

const FEATURED = FONT_FAMILIES as readonly string[]

/** Searchable font menu: featured fonts, system fonts, then every Google Fonts family. */
export function FontPicker({ value, onChange }: { value: string; onChange: (family: string) => void }) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    void loadCatalog().then(setCatalog)
    setTimeout(() => inputRef.current?.focus(), 0)
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    return () => window.removeEventListener('pointerdown', onDown, true)
  }, [open])

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    const match = (f: string) => !q || f.toLowerCase().includes(q)
    const system = (catalog?.system ?? []).filter(match)
    const featured = FEATURED.filter(match)
    const google = (catalog?.google ?? []).filter((f) => match(f) && !FEATURED.includes(f)).slice(0, q ? 200 : 60)
    return { featured, system, google }
  }, [query, catalog])

  const pick = (family: string) => {
    ensureFontLinked(family)
    onChange(family)
    setOpen(false)
  }

  return (
    <div ref={ref} className="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-md border border-white/10 bg-[#1b1f27] px-2 py-1.5 text-left text-xs text-zinc-100 hover:border-white/25"
        title="Choose a font"
      >
        <span className="truncate" style={{ fontFamily: `'${value}', sans-serif` }}>
          {value}
        </span>
        <ChevronDown size={13} className="shrink-0 text-zinc-400" />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-1 overflow-hidden rounded-lg border border-white/10 bg-[#1b1f27] shadow-2xl" onKeyDown={(e) => e.stopPropagation()}>
          <div className="flex items-center gap-1.5 border-b border-white/[0.06] px-2 py-1.5">
            <Search size={12} className="text-zinc-500" />
            <input
              ref={inputRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={catalog ? `Search ${catalog.google.length + catalog.system.length} fonts` : 'Search fonts'}
              className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
            />
          </div>
          <div className="ve-scroll max-h-64 overflow-y-auto py-1">
            {(
              [
                ['Featured', groups.featured],
                ['System', groups.system],
                ['Google Fonts', groups.google],
              ] as Array<[string, readonly string[]]>
            ).map(([title, list]) =>
              list.length ? (
                <div key={title}>
                  <p className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{title}</p>
                  {list.map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => pick(f)}
                      onMouseEnter={() => title !== 'System' && ensureFontLinked(f)}
                      className={cx('block w-full truncate px-2 py-1 text-left text-xs hover:bg-white/10', f === value ? 'bg-blue-500/20 text-white' : 'text-zinc-200')}
                      style={{ fontFamily: `'${f}', sans-serif` }}
                    >
                      {f}
                    </button>
                  ))}
                </div>
              ) : null,
            )}
            {!catalog && <p className="px-2 py-2 text-[11px] text-zinc-500">Loading font list…</p>}
            {catalog && !groups.featured.length && !groups.system.length && !groups.google.length && <p className="px-2 py-2 text-[11px] text-zinc-500">No fonts match.</p>}
          </div>
        </div>
      )}
    </div>
  )
}
