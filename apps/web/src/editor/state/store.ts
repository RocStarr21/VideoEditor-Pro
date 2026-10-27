import { useCallback, useRef, useSyncExternalStore } from 'react'
import { createProject, type GuideId } from '../model/defaults'
import { projectDuration } from '../model/timeline'
import type { Thumbnails } from '../engine/media'
import type { Asset, Project } from '../model/types'

export type LeftTab = 'media' | 'audio' | 'text' | 'stickers' | 'effects' | 'transitions' | 'filters' | 'captions'

export interface BusyState {
  label: string
  /** 0..1, or null for indeterminate. */
  progress: number | null
  cancel?: () => void
}

export interface EditorState {
  project: Project
  assets: Record<string, Asset>
  /** Object URLs for assets in this session; never persisted. */
  assetUrls: Record<string, string>
  /** Filmstrip thumbnails per asset. */
  thumbnails: Record<string, Thumbnails>
  /** Normalized peak envelopes per asset, ~100 values per second. */
  waveforms: Record<string, Float32Array>
  selection: string[]
  playhead: number
  playing: boolean
  /** Timeline zoom, pixels per second. */
  zoom: number
  magnet: boolean
  snapping: boolean
  /** OpenCut ripple editing: deletes and trims close gaps on every track. */
  ripple: boolean
  /** WebGL2 is available, so filters, LUTs, chroma key and effects render. */
  gpu: boolean
  /** Preview zoom factor; 0 = fit to the panel. */
  previewZoom: number
  /** Preview pan offset in screen pixels when zoomed. */
  previewPan: { x: number; y: number }
  guide: GuideId
  /** Clips showing one timeline lane per animated property. */
  expandedKeyframes: string[]
  /** Text clip being edited in place on the canvas. */
  editingTextId: string | null
  /** Pen tool active: clicks on the preview add freeform mask points to the selected clip. */
  maskDrawing: boolean
  leftTab: LeftTab
  busy: BusyState | null
  exportOpen: boolean
  projectsOpen: boolean
  /** Microphone voiceover in progress. */
  recording: boolean
  canUndo: boolean
  canRedo: boolean
}

const HISTORY_LIMIT = 200

/** Undo/redo never removes imported media from the bin; only timeline edits are undone. */
function keepBin(target: Project, current: Project): Project {
  const bin = [...new Set([...(target.bin ?? []), ...(current.bin ?? [])])]
  return bin.length === (target.bin ?? []).length ? target : { ...target, bin }
}

type Listener = () => void

function createEditorStore(initial: EditorState) {
  let state = initial
  const listeners = new Set<Listener>()
  let past: Project[] = []
  let future: Project[] = []
  let gestureBase: Project | null = null

  const emit = () => listeners.forEach((l) => l())

  const set = (patch: Partial<EditorState> | ((s: EditorState) => Partial<EditorState>)) => {
    const next = typeof patch === 'function' ? patch(state) : patch
    state = { ...state, ...next }
    emit()
  }

  const syncHistoryFlags = () => ({ canUndo: past.length > 0, canRedo: future.length > 0 })

  /** Drops selection entries that no longer exist after an edit or undo. */
  const pruneSelection = (project: Project, selection: string[]) => {
    const ids = new Set(project.clips.map((c) => c.id))
    const kept = selection.filter((id) => ids.has(id))
    return kept.length === selection.length ? selection : kept
  }

  const clampPlayhead = (project: Project, playhead: number) => Math.min(playhead, Math.max(0, projectDuration(project)))

  return {
    getState: () => state,
    subscribe: (l: Listener) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    set,

    /** Applies an edit as one undoable step. */
    commit(update: (p: Project) => Project, extra?: Partial<EditorState>) {
      const next = update(state.project)
      if (next === state.project) {
        if (extra) set(extra)
        return
      }
      past.push(gestureBase ?? state.project)
      if (past.length > HISTORY_LIMIT) past.shift()
      future = []
      gestureBase = null
      set({
        ...extra,
        project: next,
        selection: pruneSelection(next, extra?.selection ?? state.selection),
        ...syncHistoryFlags(),
      })
    },

    /** Starts a continuous edit (drag, slider); intermediate updates are not recorded. */
    beginGesture() {
      if (!gestureBase) gestureBase = state.project
    },

    /** Applies an intermediate update inside a gesture. */
    preview(update: (p: Project) => Project) {
      if (!gestureBase) gestureBase = state.project
      const next = update(state.project)
      if (next !== state.project) set({ project: next })
    },

    /** Ends a gesture, recording one undo step if anything changed. */
    endGesture() {
      if (!gestureBase) return
      if (gestureBase !== state.project) {
        past.push(gestureBase)
        if (past.length > HISTORY_LIMIT) past.shift()
        future = []
      }
      gestureBase = null
      set({ selection: pruneSelection(state.project, state.selection), ...syncHistoryFlags() })
    },

    undo() {
      const popped = past.pop()
      if (!popped) return
      future.push(state.project)
      const prev = keepBin(popped, state.project)
      set({ project: prev, selection: pruneSelection(prev, state.selection), playhead: clampPlayhead(prev, state.playhead), ...syncHistoryFlags() })
    },

    redo() {
      const popped = future.pop()
      if (!popped) return
      past.push(state.project)
      const next = keepBin(popped, state.project)
      set({ project: next, selection: pruneSelection(next, state.selection), ...syncHistoryFlags() })
    },

    /** Replaces the project wholesale (open / new) and clears history. */
    loadProject(project: Project, assets: Record<string, Asset>, assetUrls: Record<string, string>) {
      past = []
      future = []
      gestureBase = null
      set({ project, assets, assetUrls, selection: [], playhead: 0, playing: false, ...syncHistoryFlags() })
    },
  }
}

export type EditorStore = ReturnType<typeof createEditorStore>

export const initialEditorState = (): EditorState => ({
  project: createProject(),
  assets: {},
  assetUrls: {},
  thumbnails: {},
  waveforms: {},
  selection: [],
  playhead: 0,
  playing: false,
  zoom: 60,
  magnet: true,
  snapping: true,
  ripple: false,
  gpu: true,
  previewZoom: 0,
  previewPan: { x: 0, y: 0 },
  guide: 'none',
  expandedKeyframes: [],
  editingTextId: null,
  maskDrawing: false,
  leftTab: 'media',
  busy: null,
  exportOpen: false,
  projectsOpen: false,
  recording: false,
  canUndo: false,
  canRedo: false,
})

let singleton: EditorStore | null = null

/** The editor runs client-only, so a module singleton is safe and avoids prop drilling the engine. */
export function getEditorStore(): EditorStore {
  if (!singleton) singleton = createEditorStore(initialEditorState())
  return singleton
}

/**
 * Subscribes a component to a slice of editor state. Re-renders only when the
 * selected value changes (Object.is), so per-frame playhead updates touch only
 * the components that read the playhead.
 */
export function useEditor<T>(selector: (s: EditorState) => T): T {
  const store = getEditorStore()
  const selectorRef = useRef(selector)
  selectorRef.current = selector
  const getSnapshot = useCallback(() => selectorRef.current(store.getState()), [store])
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot)
}

export const editor = () => getEditorStore()
