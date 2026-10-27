/**
 * Editor actions and their keyboard shortcuts. Defaults follow CapCut and
 * OpenCut; the user can rebind any action in the Shortcuts dialog and the
 * result is kept in localStorage on this device.
 */
export interface ActionDef {
  id: string
  label: string
  /** Default combos, e.g. 'Ctrl+B', 'Shift+ArrowLeft', 'Space'. */
  keys: string[]
  group: 'Playback' | 'Editing' | 'Selection' | 'View' | 'Project'
}

export const ACTIONS: ActionDef[] = [
  { id: 'playPause', label: 'Play / pause', keys: ['Space'], group: 'Playback' },
  { id: 'prevFrame', label: 'Previous frame', keys: ['ArrowLeft'], group: 'Playback' },
  { id: 'nextFrame', label: 'Next frame', keys: ['ArrowRight'], group: 'Playback' },
  { id: 'prevCut', label: 'Previous cut', keys: ['ArrowUp'], group: 'Playback' },
  { id: 'nextCut', label: 'Next cut', keys: ['ArrowDown'], group: 'Playback' },
  { id: 'prevMarker', label: 'Previous marker', keys: ['Shift+ArrowLeft'], group: 'Playback' },
  { id: 'nextMarker', label: 'Next marker', keys: ['Shift+ArrowRight'], group: 'Playback' },
  { id: 'goStart', label: 'Go to start', keys: ['Home'], group: 'Playback' },
  { id: 'goEnd', label: 'Go to end', keys: ['End'], group: 'Playback' },
  { id: 'split', label: 'Split at playhead', keys: ['Ctrl+B', 'S'], group: 'Editing' },
  { id: 'trimLeft', label: 'Delete left of playhead', keys: ['Q'], group: 'Editing' },
  { id: 'trimRight', label: 'Delete right of playhead', keys: ['W'], group: 'Editing' },
  { id: 'delete', label: 'Delete selected', keys: ['Delete', 'Backspace'], group: 'Editing' },
  { id: 'duplicate', label: 'Duplicate', keys: ['Ctrl+D'], group: 'Editing' },
  { id: 'copy', label: 'Copy', keys: ['Ctrl+C'], group: 'Editing' },
  { id: 'paste', label: 'Paste at playhead', keys: ['Ctrl+V'], group: 'Editing' },
  { id: 'undo', label: 'Undo', keys: ['Ctrl+Z'], group: 'Editing' },
  { id: 'redo', label: 'Redo', keys: ['Ctrl+Shift+Z', 'Ctrl+Y'], group: 'Editing' },
  { id: 'marker', label: 'Add marker', keys: ['M'], group: 'Editing' },
  { id: 'freeze', label: 'Freeze frame', keys: ['Shift+F'], group: 'Editing' },
  { id: 'editText', label: 'Edit selected text on canvas', keys: ['Enter'], group: 'Editing' },
  { id: 'selectAll', label: 'Select all', keys: ['Ctrl+A'], group: 'Selection' },
  { id: 'deselect', label: 'Clear selection / cancel', keys: ['Escape'], group: 'Selection' },
  { id: 'snapping', label: 'Toggle snapping', keys: ['N'], group: 'View' },
  { id: 'ripple', label: 'Toggle ripple editing', keys: ['R'], group: 'View' },
  { id: 'zoomIn', label: 'Zoom timeline in', keys: ['Ctrl+=', 'Ctrl++'], group: 'View' },
  { id: 'zoomOut', label: 'Zoom timeline out', keys: ['Ctrl+-'], group: 'View' },
  { id: 'zoomFit', label: 'Fit timeline', keys: ['Shift+Z'], group: 'View' },
  { id: 'previewZoomIn', label: 'Zoom preview in', keys: ['Ctrl+Shift+='], group: 'View' },
  { id: 'previewZoomOut', label: 'Zoom preview out', keys: ['Ctrl+Shift+-'], group: 'View' },
  { id: 'previewFit', label: 'Fit preview', keys: ['Ctrl+0'], group: 'View' },
  { id: 'export', label: 'Export', keys: ['Ctrl+E'], group: 'Project' },
  { id: 'projects', label: 'Projects', keys: ['Ctrl+O'], group: 'Project' },
  { id: 'shortcuts', label: 'Show shortcuts', keys: ['?', 'Shift+/'], group: 'Project' },
]

const STORAGE_KEY = 've-keybindings-v1'

export type Bindings = Record<string, string[]>

const defaults = (): Bindings => Object.fromEntries(ACTIONS.map((a) => [a.id, [...a.keys]]))

let cache: Bindings | null = null

export function loadBindings(): Bindings {
  if (cache) return cache
  cache = defaults()
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const saved = JSON.parse(raw) as Bindings
      for (const a of ACTIONS) if (Array.isArray(saved[a.id])) cache[a.id] = saved[a.id].filter((k) => typeof k === 'string')
    }
  } catch {
    // Private mode or corrupt data: defaults apply.
  }
  return cache
}

export function saveBindings(next: Bindings) {
  cache = next
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // Not persisted, still active for this session.
  }
}

export function resetBindings() {
  cache = defaults()
  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    // ignore
  }
  return cache
}

/** Rebinds one action to a single combo, removing that combo from any other action. */
export function rebind(actionId: string, combo: string): Bindings {
  const next: Bindings = {}
  for (const [id, keys] of Object.entries(loadBindings())) next[id] = keys.filter((k) => k !== combo)
  next[actionId] = [combo]
  saveBindings(next)
  return next
}

const KEY_NAMES: Record<string, string> = { ' ': 'Space', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', escape: 'Escape', delete: 'Delete', backspace: 'Backspace', enter: 'Enter', home: 'Home', end: 'End', tab: 'Tab' }

/** Normalised "Ctrl+Shift+Key" string for a keyboard event (Cmd counts as Ctrl). */
export function comboFromEvent(e: KeyboardEvent): string {
  const parts: string[] = []
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl')
  if (e.altKey) parts.push('Alt')
  if (e.shiftKey) parts.push('Shift')
  const raw = e.key
  const lower = raw.toLowerCase()
  let key = KEY_NAMES[lower] ?? (raw.length === 1 ? raw.toUpperCase() : raw)
  // Shift changes the printed character; keep the physical key for letters and digits.
  if (e.shiftKey && /^Digit\d$/.test(e.code)) key = e.code.slice(5)
  if (e.shiftKey && /^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  if (e.code === 'Equal' && (e.ctrlKey || e.metaKey)) key = '='
  if (e.code === 'Minus' && (e.ctrlKey || e.metaKey)) key = '-'
  return [...parts, key].join('+')
}

const MODIFIER_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta'])
export const isModifierOnly = (e: KeyboardEvent) => MODIFIER_KEYS.has(e.key)

/** The action bound to this event, if any. */
export function actionFor(e: KeyboardEvent): string | null {
  const combo = comboFromEvent(e)
  const bindings = loadBindings()
  for (const a of ACTIONS) if (bindings[a.id]?.includes(combo)) return a.id
  // "?" arrives as Shift+/ on most layouts.
  if (combo === 'Shift+/' || e.key === '?') return bindings.shortcuts?.length ? 'shortcuts' : null
  return null
}

/** Human-friendly label for a combo ("Ctrl+Shift+Z" → "Ctrl + Shift + Z"). */
export const prettyCombo = (combo: string) => combo.split('+').join(' + ').replace('Arrow', '').replace('Space', 'Space')
