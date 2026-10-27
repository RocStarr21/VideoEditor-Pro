import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { Toaster } from 'sonner'
import { projectDuration } from '../model/timeline'
import {
  addMarker,
  bootstrap,
  copySelection,
  deleteSelected,
  duplicateSelected,
  freezeFrame,
  importFiles,
  jumpToCut,
  jumpToMarker,
  paste,
  seek,
  selectAll,
  selectedClips,
  setMaskDrawing,
  setPreviewZoom,
  splitAtPlayhead,
  startTextEdit,
  stepFrame,
  stepPreviewZoom,
  stopTextEdit,
  togglePlay,
  trimSelectedToPlayhead,
} from '../state/actions'
import { actionFor, isModifierOnly } from '../state/keybindings'
import { getEditorStore } from '../state/store'
import { linkWebFonts } from '../engine/text'
import { BusyOverlay, ExportDialog, ProjectsDialog, ShortcutsDialog, TopBar } from './Dialogs'
import { Inspector } from './Inspector'
import { LeftPanel } from './LeftPanel'
import { Player } from './Player'
import { Timeline } from './Timeline'

const store = () => getEditorStore()

const isTyping = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)
}

/** Runs the editor action bound to a key; bindings are user-editable (see keybindings.ts). */
function runAction(id: string, ui: { showShortcuts: () => void }): boolean {
  const s = store()
  const st = s.getState()
  switch (id) {
    case 'playPause':
      return togglePlay(), true
    case 'prevFrame':
      return stepFrame(-1), true
    case 'nextFrame':
      return stepFrame(1), true
    case 'prevCut':
      return jumpToCut(-1), true
    case 'nextCut':
      return jumpToCut(1), true
    case 'prevMarker':
      return jumpToMarker(-1), true
    case 'nextMarker':
      return jumpToMarker(1), true
    case 'goStart':
      return seek(0), true
    case 'goEnd':
      return seek(projectDuration(st.project)), true
    case 'split':
      return splitAtPlayhead(), true
    case 'trimLeft':
      return trimSelectedToPlayhead('left'), true
    case 'trimRight':
      return trimSelectedToPlayhead('right'), true
    case 'delete':
      return deleteSelected(), true
    case 'duplicate':
      return duplicateSelected(), true
    case 'copy':
      return copySelection(), true
    case 'paste':
      return paste(), true
    case 'undo':
      return s.undo(), true
    case 'redo':
      return s.redo(), true
    case 'marker':
      return addMarker(), true
    case 'freeze':
      return void freezeFrame(), true
    case 'editText': {
      const sel = selectedClips()[0]
      if (sel?.type !== 'text') return false
      return startTextEdit(sel.id), true
    }
    case 'selectAll':
      return selectAll(), true
    case 'deselect':
      if (st.maskDrawing) setMaskDrawing(false)
      else if (st.editingTextId) stopTextEdit()
      else s.set({ selection: [] })
      return true
    case 'snapping':
      return s.set({ snapping: !st.snapping }), true
    case 'ripple':
      return s.set({ ripple: !st.ripple }), true
    case 'zoomIn':
      return s.set({ zoom: Math.min(600, st.zoom * 1.4) }), true
    case 'zoomOut':
      return s.set({ zoom: Math.max(4, st.zoom / 1.4) }), true
    case 'zoomFit':
      return s.set({ zoom: Math.min(600, Math.max(4, (window.innerWidth - 420) / Math.max(5, projectDuration(st.project)))) }), true
    case 'previewZoomIn':
      return stepPreviewZoom(1, st.previewZoom || 1), true
    case 'previewZoomOut':
      return stepPreviewZoom(-1, st.previewZoom || 1), true
    case 'previewFit':
      return setPreviewZoom(0), true
    case 'export':
      return s.set({ exportOpen: true }), true
    case 'projects':
      return s.set({ projectsOpen: true }), true
    case 'shortcuts':
      return ui.showShortcuts(), true
    default:
      return false
  }
}

/** Drag handle that resizes a panel; `axis` is the direction the size grows. */
function useResizable(initial: number, min: number, max: number, axis: 'x' | 'y' | '-x' | '-y') {
  const [size, setSize] = useState(initial)
  const start = (e: ReactPointerEvent) => {
    e.preventDefault()
    const origin = axis.endsWith('x') ? e.clientX : e.clientY
    const base = size
    const sign = axis.startsWith('-') ? -1 : 1
    const move = (ev: PointerEvent) => {
      const pos = axis.endsWith('x') ? ev.clientX : ev.clientY
      setSize(Math.min(max, Math.max(min, base + sign * (pos - origin))))
    }
    const up = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return [size, start] as const
}

export default function Editor() {
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shortcuts, setShortcuts] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const dragDepth = useRef(0)
  const [leftW, startLeft] = useResizable(320, 240, 520, 'x')
  const [rightW, startRight] = useResizable(330, 260, 520, '-x')
  const [timelineH, startTimeline] = useResizable(Math.round(window.innerHeight * 0.36), 160, Math.round(window.innerHeight * 0.7), '-y')

  useEffect(() => {
    linkWebFonts()
    bootstrap()
      .then(() => setReady(true))
      .catch((err: Error) => setError(err.message))
    const keys = (e: KeyboardEvent) => {
      if (isTyping(e) || isModifierOnly(e)) return
      const id = actionFor(e)
      if (id && runAction(id, { showShortcuts: () => setShortcuts(true) })) e.preventDefault()
    }
    // Files on the clipboard (a screenshot, copied images) import at the playhead.
    const onPaste = (e: ClipboardEvent) => {
      if (isTyping(e as unknown as KeyboardEvent)) return
      const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.size > 0)
      if (!files.length) return
      e.preventDefault()
      void importFiles(files, { at: store().getState().playhead })
    }
    window.addEventListener('keydown', keys)
    window.addEventListener('paste', onPaste)
    return () => {
      window.removeEventListener('keydown', keys)
      window.removeEventListener('paste', onPaste)
    }
  }, [])

  // Files dropped anywhere outside the timeline go to the media bin.
  useEffect(() => {
    const enter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes('Files')) return
      dragDepth.current++
      setDragOver(true)
    }
    const leave = () => {
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragOver(false)
    }
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
    }
    const drop = (e: DragEvent) => {
      dragDepth.current = 0
      setDragOver(false)
      if (e.defaultPrevented || !e.dataTransfer?.files.length) return
      e.preventDefault()
      void importFiles([...e.dataTransfer.files])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [])

  if (error) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#0f1115] p-6 text-center text-zinc-200">
        <div>
          <p className="text-lg font-semibold">VideoEditor Pro could not start</p>
          <p className="mt-2 text-sm text-zinc-400">{error}</p>
          <p className="mt-1 text-xs text-zinc-500">It needs a current Chrome or Edge with storage enabled for this site.</p>
        </div>
      </div>
    )
  }

  return (
    <div className="dark flex h-screen flex-col overflow-hidden bg-[#0f1115] text-zinc-100">
      <TopBar onShowShortcuts={() => setShortcuts(true)} />
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 shrink-0" style={{ width: leftW }}>
          <LeftPanel />
        </div>
        <div className="w-1 shrink-0 cursor-col-resize bg-black/40 hover:bg-blue-500/60" onPointerDown={startLeft} />
        <div className="min-h-0 min-w-0 flex-1">{ready ? <Player /> : <div className="flex h-full items-center justify-center text-xs text-zinc-500">Opening your last project…</div>}</div>
        <div className="w-1 shrink-0 cursor-col-resize bg-black/40 hover:bg-blue-500/60" onPointerDown={startRight} />
        <div className="min-h-0 shrink-0" style={{ width: rightW }}>
          <Inspector />
        </div>
      </div>
      <div className="h-1 shrink-0 cursor-row-resize bg-black/40 hover:bg-blue-500/60" onPointerDown={startTimeline} />
      <div className="min-h-0 shrink-0" style={{ height: timelineH }}>
        <Timeline />
      </div>

      <ExportDialog />
      <ProjectsDialog />
      {shortcuts && <ShortcutsDialog onClose={() => setShortcuts(false)} />}
      <BusyOverlay />
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-40 flex items-center justify-center border-4 border-dashed border-blue-400/70 bg-blue-500/10">
          <p className="rounded-xl bg-black/70 px-5 py-3 text-sm font-semibold text-white">Drop to import — drop on the timeline to place it there</p>
        </div>
      )}
      <Toaster theme="dark" position="top-center" richColors closeButton />
    </div>
  )
}
