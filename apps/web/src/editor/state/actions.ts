/**
 * Editor commands. UI components call these; they read and write the store,
 * drive the preview engine, and persist to IndexedDB.
 */
import { toast } from 'sonner'
import { gainAt } from '../model/animation'
import {
  CANVAS_RATIOS,
  CAPTION_PRESETS,
  MARKER_COLORS,
  SHAPE_PRESETS,
  createEffectClip,
  createMediaClip,
  createProject,
  createShapeClip,
  createTextClip,
  createTrack,
  defaultAnimation,
  defaultChroma,
  defaultMask,
  defaultTextStyle,
  neutralAdjust,
  newId,
  type GuideId,
} from '../model/defaults'
import { withKeyframe, withoutKeyframe, keyframeIndexNear, propValue, rescaleKeyframes, retimeKeyframe, withKeyframeEase } from '../model/keyframes'
import * as scenes from '../model/scenes'
import {
  addClip,
  clipEnd,
  clipsAt,
  cutPoints,
  deleteClips,
  duplicateClip,
  ensureFreeTrack,
  getClip,
  getTrack,
  insertTrack,
  isMediaClip,
  isTextClip,
  mainTrack,
  moveClips,
  nextAdjacent,
  prevAdjacent,
  projectDuration,
  setClipSpeed,
  setTransition,
  sourceTimeAt,
  splitClip,
  splitClipsAt,
  trimAtPlayhead,
  updateClip,
  updateTrack,
} from '../model/timeline'
import type {
  Asset,
  CanvasBackground,
  Clip,
  EffectName,
  Keyframe,
  KeyframeProp,
  Keyframes,
  Marker,
  MaskPathPoint,
  MediaAssetKind,
  MediaClip,
  Project,
  ShapeClip,
  TextClip,
  TextStyle,
  Track,
  TransitionName,
  VisualClip,
} from '../model/types'
import type { Lut3D } from '../engine/lut'
import { classifyFile, generateThumbnails, generateWaveform, probeFile } from '../engine/media'
import * as db from '../engine/persistence'
import { PreviewEngine } from '../engine/preview'
import type { WhisperModel } from '../engine/transcribe'
import { getEditorStore, type BusyState, type LeftTab } from './store'

const store = () => getEditorStore()
const st = () => store().getState()
const opts = () => ({ magnet: st().magnet, ripple: st().ripple })

// ── Engine ──────────────────────────────────────────────────────────────────

let engine: PreviewEngine | null = null
const blobs = new Map<string, Blob>()
const lutCache = new Map<string, Lut3D | null>()

export function getEngine(): PreviewEngine {
  if (!engine) {
    engine = new PreviewEngine({
      getProject: () => st().project,
      getAssets: () => st().assets,
      getAssetUrl: (id) => st().assetUrls[id],
      onTime: (t) => store().set({ playhead: t }),
      onEnded: () => store().set({ playing: false }),
    })
    engine.setLutLoader(loadLut)
    engine.onSegmenterStatus = (status, message) => {
      if (status === 'loading') toast.loading('Loading background removal model…', { id: 'segmenter' })
      if (status === 'ready') toast.success('Background removal ready', { id: 'segmenter' })
      if (status === 'failed') toast.error(`Background removal unavailable: ${message ?? 'model failed to load'}`, { id: 'segmenter' })
    }
    // Re-render when anything visual changes while paused.
    let lastProject = st().project
    let lastAssets = st().assetUrls
    store().subscribe(() => {
      const s = st()
      if (s.project !== lastProject || s.assetUrls !== lastAssets) {
        lastProject = s.project
        lastAssets = s.assetUrls
        engine?.requestRender()
      }
    })
  }
  return engine
}

export async function loadBlob(assetId: string): Promise<Blob | null> {
  const cached = blobs.get(assetId)
  if (cached) return cached
  const rec = await db.getAssetRecord(assetId)
  if (rec?.blob) blobs.set(assetId, rec.blob)
  return rec?.blob ?? null
}

export async function loadLut(assetId: string): Promise<Lut3D | null> {
  if (lutCache.has(assetId)) return lutCache.get(assetId) ?? null
  const blob = await loadBlob(assetId)
  if (!blob) return null
  try {
    const { parseCubeLut } = await import('../engine/lut')
    const lut = parseCubeLut(await blob.text())
    lutCache.set(assetId, lut)
    return lut
  } catch (err) {
    console.warn('LUT failed to parse', err)
    lutCache.set(assetId, null)
    return null
  }
}

// ── Busy / progress ─────────────────────────────────────────────────────────

function setBusy(busy: BusyState | null) {
  store().set({ busy })
}

/** Runs a long task with a cancelable progress overlay. */
async function withBusy<T>(label: string, run: (progress: (p: number | null, label?: string) => void, signal: AbortSignal) => Promise<T>): Promise<T | null> {
  const controller = new AbortController()
  setBusy({ label, progress: null, cancel: () => controller.abort() })
  try {
    return await run((p, l) => setBusy({ label: l ?? label, progress: p, cancel: () => controller.abort() }), controller.signal)
  } catch (err) {
    if ((err as Error)?.name === 'AbortError') toast.message('Canceled')
    else {
      console.error(err)
      toast.error((err as Error)?.message || 'Something went wrong')
    }
    return null
  } finally {
    setBusy(null)
  }
}

// ── Projects & autosave ─────────────────────────────────────────────────────

let saveTimer = 0
let thumbTimer = 0
let lastSaved: Project | null = null
let autosaveStarted = false

/** Small poster frame for the Projects dialog, rendered from the current playhead. */
async function saveThumbnail(projectId: string) {
  const { project, playhead } = st()
  if (project.id !== projectId || !project.clips.length) return
  try {
    const w = 320
    const h = Math.max(2, Math.round((w * project.canvas.height) / project.canvas.width / 2) * 2)
    const canvas = new OffscreenCanvas(w, h)
    getEngine().renderTo(canvas, playhead)
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.7 })
    await db.putProjectThumbnail(projectId, blob)
  } catch (err) {
    console.warn('Project thumbnail failed', err)
  }
}

function startAutosave() {
  if (autosaveStarted) return
  autosaveStarted = true
  store().subscribe(() => {
    const project = st().project
    if (project === lastSaved) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(() => {
      lastSaved = project
      void db.saveProject(project).catch((err) => console.error('Autosave failed', err))
      void db.setLastProjectId(project.id)
      window.clearTimeout(thumbTimer)
      thumbTimer = window.setTimeout(() => void saveThumbnail(project.id), 3000)
    }, 600)
  })
  window.addEventListener('beforeunload', () => {
    const project = st().project
    if (project !== lastSaved) void db.saveProject(project)
  })
}

/** Loads media for a project from IndexedDB and makes it current. */
async function activateProject(project: Project) {
  // Projects saved before the media bin existed get one built from their clips.
  project = scenes.normalizeScenes({ ...project, bin: project.bin ?? [] })
  const ids = new Set<string>(project.bin)
  const everyClip = [...project.clips, ...(project.otherScenes ?? []).flatMap((s) => s.clips)]
  for (const c of everyClip) if (isMediaClip(c)) ids.add(c.assetId)
  for (const c of everyClip) if ('filter' in c && c.filter?.id.startsWith('lut:')) ids.add(c.filter.id.slice(4))
  if (project.canvas.background.type === 'image') ids.add(project.canvas.background.assetId)

  const assets: Record<string, Asset> = {}
  const urls: Record<string, string> = {}
  const thumbnails = { ...st().thumbnails }
  const waveforms = { ...st().waveforms }
  const regenerate: Asset[] = []

  for (const id of ids) {
    const rec = await db.getAssetRecord(id)
    if (!rec) continue
    assets[id] = rec.asset
    blobs.set(id, rec.blob)
    if (rec.asset.kind !== 'lut') urls[id] = URL.createObjectURL(rec.blob)
    if (rec.thumbnails) thumbnails[id] = rec.thumbnails
    if (rec.waveform) waveforms[id] = rec.waveform
    if (rec.asset.kind !== 'lut' && (!rec.thumbnails || (rec.asset.hasAudio && rec.waveform === undefined))) regenerate.push(rec.asset)
  }

  for (const url of Object.values(st().assetUrls)) URL.revokeObjectURL(url)
  store().loadProject(project, assets, urls)
  store().set({ thumbnails, waveforms })
  lastSaved = project
  await db.setLastProjectId(project.id)
  getEngine().seek(0)
  for (const asset of regenerate) void deriveAssetData(asset, blobs.get(asset.id)!, urls[asset.id])
}

export async function bootstrap() {
  getEngine()
  startAutosave()
  void db.requestPersistentStorage()
  // Without WebGL2 the preview still plays, but filters, LUTs, chroma key and effects are skipped.
  void import('../engine/gl').then((m) => store().set({ gpu: m.ClipProcessor.isSupported() })).catch(() => store().set({ gpu: false }))
  try {
    const lastId = await db.getLastProjectId()
    const project = lastId ? await db.loadProjectRecord(lastId) : undefined
    if (project) {
      await activateProject(project)
      return
    }
  } catch (err) {
    console.error('Could not open the last project', err)
  }
  const fresh = createProject()
  await db.saveProject(fresh)
  await activateProject(fresh)
}

export async function newProject(ratio = '16:9') {
  await db.saveProject(st().project)
  const project = createProject(`Project ${new Date().toLocaleDateString()}`, ratio)
  await db.saveProject(project)
  await activateProject(project)
  store().set({ projectsOpen: false })
}

export async function openProject(id: string) {
  if (id === st().project.id) {
    store().set({ projectsOpen: false })
    return
  }
  await db.saveProject(st().project)
  const project = await db.loadProjectRecord(id)
  if (!project) {
    toast.error('That project could not be found')
    return
  }
  await activateProject(project)
  store().set({ projectsOpen: false })
}

export async function duplicateProject(id: string) {
  const project = await db.loadProjectRecord(id)
  if (!project) return
  const copy: Project = { ...structuredClone(project), id: newId(), name: `${project.name} copy`, createdAt: Date.now(), updatedAt: Date.now() }
  await db.saveProject(copy)
}

export async function deleteProjectById(id: string) {
  if (id === st().project.id) {
    await db.deleteProject(id)
    const remaining = await db.listProjects()
    if (remaining[0]) await openProject(remaining[0].id)
    else await newProject()
  } else {
    await db.deleteProject(id)
  }
}

export function renameProject(name: string) {
  store().commit((p) => ({ ...p, name: name.trim() || 'Untitled project', updatedAt: Date.now() }))
}

// ── Import ──────────────────────────────────────────────────────────────────

async function deriveAssetData(asset: Asset, blob: Blob, url: string | undefined) {
  if (asset.kind === 'lut' || !url) return
  try {
    const [thumbnails, waveform] = await Promise.all([generateThumbnails(asset, blob, url), generateWaveform(asset, blob)])
    store().set((s) => ({
      thumbnails: { ...s.thumbnails, [asset.id]: thumbnails },
      waveforms: waveform ? { ...s.waveforms, [asset.id]: waveform } : s.waveforms,
    }))
    await db.putAssetDerived(asset.id, { thumbnails, waveform })
  } catch (err) {
    console.warn('Thumbnail/waveform generation failed for', asset.name, err)
  }
}

/** Registers a new asset (persisted, URL created, thumbnails scheduled). */
async function registerAsset(asset: Asset, blob: Blob) {
  await db.putAsset(asset, blob)
  blobs.set(asset.id, blob)
  const url = asset.kind === 'lut' ? undefined : URL.createObjectURL(blob)
  store().set((s) => ({
    assets: { ...s.assets, [asset.id]: asset },
    assetUrls: url ? { ...s.assetUrls, [asset.id]: url } : s.assetUrls,
    // Recorded outside undo history: importing is not an edit you undo.
    project: s.project.bin.includes(asset.id) ? s.project : { ...s.project, bin: [...s.project.bin, asset.id], updatedAt: Date.now() },
  }))
  void deriveAssetData(asset, blob, url)
  return asset
}

export async function importFiles(files: File[], place?: { at?: number; trackId?: string }) {
  const list = files.filter((f) => f.size > 0)
  if (!list.length) return []
  const added: Asset[] = []
  await withBusy(`Importing ${list.length} file${list.length > 1 ? 's' : ''}…`, async (progress) => {
    for (let i = 0; i < list.length; i++) {
      const file = list[i]
      progress(i / list.length, `Importing ${file.name}…`)
      try {
        if (/\.cube$/i.test(file.name)) {
          await importLutFile(file)
          continue
        }
        if (/\.(srt|vtt|ass|ssa)$/i.test(file.name)) {
          await importCaptionsFile(file)
          continue
        }
        if (!classifyFile(file)) {
          toast.error(`${file.name}: unsupported file type`)
          continue
        }
        const url = URL.createObjectURL(file)
        const asset = await probeFile(file, url)
        URL.revokeObjectURL(url)
        added.push(await registerAsset(asset, file))
      } catch (err) {
        toast.error(`${file.name}: ${(err as Error).message}`)
      }
    }
  })
  if (place && added.length) {
    let at = place.at ?? st().playhead
    for (const asset of added) {
      const id = addAssetToTimeline(asset.id, at, place.trackId)
      const clip = id ? getClip(st().project, id) : undefined
      if (clip) at = clipEnd(clip)
    }
  }
  if (added.length) toast.success(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`)
  return added
}

/** First visual clip on an empty project sets the canvas to the media's own shape (CapCut "Original"). */
function adoptCanvasFrom(project: Project, asset: Asset): Project {
  if (project.clips.length || !asset.width || !asset.height || asset.kind === 'audio') return project
  const ratio = asset.width / asset.height
  const preset = CANVAS_RATIOS.find((r) => Math.abs(r.width / r.height - ratio) < 0.01)
  if (preset) return { ...project, canvas: { ...project.canvas, ratio: preset.id, width: preset.width, height: preset.height } }
  const short = 1080
  const width = ratio >= 1 ? Math.round((short * ratio) / 2) * 2 : short
  const height = ratio >= 1 ? short : Math.round(short / ratio / 2) * 2
  return { ...project, canvas: { ...project.canvas, ratio: 'original', width, height } }
}

/** Adds a media asset at timeline time `at` (CapCut's "+" / drag from the media panel). Returns the new clip id. */
export function addAssetToTimeline(assetId: string, at = st().playhead, trackId?: string, asOverlay = false): string | null {
  const asset = st().assets[assetId]
  if (!asset || asset.kind === 'lut') return null
  const media = asset as Asset & { kind: MediaAssetKind }
  const project = st().project
  const target = trackId ? getTrack(project, trackId) : undefined
  let clip: MediaClip
  if (media.kind === 'audio') {
    clip = createMediaClip(media, target?.kind === 'audio' ? target.id : '', at)
  } else {
    const track = target?.kind === 'video' ? target : mainTrack(project)
    clip = createMediaClip(media, track.id, at)
  }
  store().commit((p) => {
    let next = adoptCanvasFrom(p, asset)
    if (asOverlay && media.kind !== 'audio') {
      // Picture-in-picture / sticker: a free overlay track above the main track.
      const free = ensureFreeTrack(next, 'video', at, at + clip.duration)
      next = free.project
      clip = { ...clip, trackId: free.trackId }
    }
    return addClip(next, clip, opts())
  }, { selection: [clip.id] })
  return clip.id
}

// ── Selection & clipboard ───────────────────────────────────────────────────

export function select(ids: string[]) {
  store().set({ selection: ids })
}

export function toggleSelect(id: string, additive: boolean) {
  const sel = st().selection
  if (!additive) store().set({ selection: [id] })
  else store().set({ selection: sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id] })
}

export function selectAll() {
  store().set({ selection: st().project.clips.map((c) => c.id) })
}

export function selectedClips(): Clip[] {
  const { project, selection } = st()
  return selection.map((id) => getClip(project, id)).filter((c): c is Clip => !!c)
}

let clipboard: Clip[] = []

export function copySelection() {
  clipboard = structuredClone(selectedClips())
  if (clipboard.length) toast.message(`Copied ${clipboard.length} clip${clipboard.length > 1 ? 's' : ''}`)
}

export function paste() {
  if (!clipboard.length) return
  const origin = Math.min(...clipboard.map((c) => c.start))
  const at = st().playhead
  const ids: string[] = []
  store().commit((p) => {
    let next = p
    for (const c of clipboard) {
      const copy = { ...structuredClone(c), id: newId(), start: at + (c.start - origin) }
      if (isMediaClip(copy)) copy.transitionOut = null
      // Same track as the original; addClip moves it to a free track if that spot is taken.
      next = addClip(next, copy, opts())
      ids.push(copy.id)
    }
    return next
  }, { selection: ids })
}

// ── Clip edits ──────────────────────────────────────────────────────────────

export function updateClipById<T extends Clip>(id: string, fn: (c: T) => T) {
  store().commit((p) => updateClip<T>(p, id, fn))
}

/** Live update during a slider/drag gesture; call endEdit() when it finishes. */
export function previewClipById<T extends Clip>(id: string, fn: (c: T) => T) {
  store().preview((p) => updateClip<T>(p, id, fn))
}

export const beginEdit = () => store().beginGesture()
export const endEdit = () => store().endGesture()

/** Applies an edit to every selected clip of a matching kind (CapCut "Apply to all" uses `all`). */
export function updateSelected<T extends Clip>(guard: (c: Clip) => c is T, fn: (c: T) => T, all = false) {
  const ids = (all ? st().project.clips : selectedClips()).filter(guard).map((c) => c.id)
  if (!ids.length) return
  store().commit((p) => ids.reduce((acc, id) => updateClip<T>(acc, id, fn), p))
}

export function splitAtPlayhead() {
  const t = st().playhead
  const sel = st().selection
  const under = clipsAt(st().project, t)
  const targets = under.filter((c) => sel.includes(c.id))
  const ids = targets.length ? targets.map((c) => c.id) : under.map((c) => c.id)
  if (!ids.length) {
    toast.message('Move the playhead over a clip to split it')
    return
  }
  store().commit((p) => splitClipsAt(p, t, ids, opts()))
}

export function deleteSelected() {
  const ids = st().selection
  if (!ids.length) return
  store().commit((p) => deleteClips(p, ids, opts()), { selection: [] })
}

export function duplicateSelected() {
  const ids = st().selection
  if (!ids.length) return
  const created: string[] = []
  store().commit((p) =>
    ids.reduce((acc, id) => {
      const r = duplicateClip(acc, id, opts())
      if (r.newId) created.push(r.newId)
      return r.project
    }, p),
    { selection: created },
  )
}

/** CapCut Q / W: delete the part of the selected clip left / right of the playhead. */
export function trimSelectedToPlayhead(side: 'left' | 'right') {
  const t = st().playhead
  const sel = selectedClips()
  const targets = sel.length ? sel : clipsAt(st().project, t).filter((c) => getTrack(st().project, c.trackId)?.isMain)
  store().commit((p) => targets.reduce((acc, c) => trimAtPlayhead(acc, c.id, t, side, st().assets, opts()), p))
  if (side === 'left') {
    const first = targets[0]
    if (first && getTrack(st().project, first.trackId)?.isMain && st().magnet) seek(Math.max(0, first.start))
  }
}

export function setSpeed(id: string, speed: number) {
  store().commit((p) => setClipSpeed(p, id, speed, st().assets, opts()))
}

const isVisual = (c: Clip): c is VisualClip => c.type !== 'effect' && c.type !== 'audio'

export function rotateSelected(deg: number) {
  updateSelected(isVisual, (c) => ({ ...c, transform: { ...c.transform, rotation: (((c.transform.rotation + deg) % 360) + 360) % 360 } }))
}

export function flipSelected(axis: 'h' | 'v') {
  updateSelected(
    isVisual,
    (c) => ({ ...c, transform: { ...c.transform, flipH: axis === 'h' ? !c.transform.flipH : c.transform.flipH, flipV: axis === 'v' ? !c.transform.flipV : c.transform.flipV } }),
  )
}

/** Toggles a keyframe for `prop` at the playhead on clip `id`, capturing the current value. */
export function toggleKeyframe(id: string, prop: KeyframeProp) {
  const clip = getClip(st().project, id)
  if (!clip || clip.type === 'effect') return
  const local = st().playhead - clip.start
  if (local < 0 || local > clip.duration) {
    toast.message('Move the playhead over the clip to add a keyframe')
    return
  }
  const list = clip.keyframes[prop]
  if (keyframeIndexNear(list, local) >= 0) {
    updateClipById(id, (c) => ({ ...c, keyframes: withoutKeyframe(c.keyframes, prop, local) }))
    return
  }
  const base = currentBaseValue(clip, prop)
  updateClipById(id, (c) => ({ ...c, keyframes: withKeyframe(c.keyframes, prop, local, propValue(c, prop, local, base)) }))
}

function currentBaseValue(clip: Clip, prop: KeyframeProp): number {
  if (clip.type === 'effect') return 0
  if (prop === 'volume') return isMediaClip(clip) ? clip.volume : 1
  if (prop === 'opacity') return clip.opacity
  return clip.transform[prop] ?? 1
}

/**
 * Sets a keyframeable property. When the property already has keyframes the
 * value is written into the keyframe at the playhead (adding one), as CapCut
 * does; otherwise the static value changes.
 */
export function setKeyframeable(id: string, prop: KeyframeProp, value: number, live = false) {
  const clip = getClip(st().project, id)
  if (!clip || clip.type === 'effect') return
  const local = Math.min(clip.duration, Math.max(0, st().playhead - clip.start))
  const keyed = !!clip.keyframes[prop]?.length
  const apply = (c: Clip): Clip => {
    if (c.type === 'effect') return c
    if (keyed) return { ...c, keyframes: withKeyframe(c.keyframes, prop, local, value) }
    if (prop === 'volume') return isMediaClip(c) ? { ...c, volume: value } : c
    if (prop === 'opacity') return { ...c, opacity: value }
    return { ...c, transform: { ...c.transform, [prop]: value } } as Clip
  }
  if (live) previewClipById(id, apply)
  else updateClipById(id, apply)
}

// ── Adding elements ─────────────────────────────────────────────────────────

const minSide = () => Math.min(st().project.canvas.width, st().project.canvas.height)

export function addText(preset?: Partial<TextStyle>, text = 'Add text', position?: { x: number; y: number }) {
  const at = st().playhead
  const style = { ...defaultTextStyle(), fontSize: Math.round(minSide() * 0.075), ...preset }
  const clip = createTextClip('', at, text, { style })
  if (position) clip.transform = { ...clip.transform, ...position }
  store().commit((p) => {
    const free = ensureFreeTrack(p, 'text', at, at + clip.duration)
    return addClip(free.project, { ...clip, trackId: free.trackId }, opts())
  }, { selection: [clip.id] })
}

export function addSticker(emoji: string) {
  const at = st().playhead
  const style: TextStyle = { ...defaultTextStyle(), fontSize: Math.round(minSide() * 0.2), shadowBlur: 0, shadowY: 0, strokeWidth: 0 }
  const clip = createTextClip('', at, emoji, { style, isSticker: true, name: `Sticker ${emoji}` })
  store().commit((p) => {
    const free = ensureFreeTrack(p, 'text', at, at + clip.duration)
    return addClip(free.project, { ...clip, trackId: free.trackId }, opts())
  }, { selection: [clip.id] })
}

export function addEffect(effect: EffectName) {
  const at = st().playhead
  const clip = createEffectClip('', at, effect)
  store().commit((p) => {
    const free = ensureFreeTrack(p, 'effect', at, at + clip.duration)
    return addClip(free.project, { ...clip, trackId: free.trackId }, opts())
  }, { selection: [clip.id] })
}

/** Adds a filter/adjustment layer clip (CapCut puts filters on their own track too). */
export function addFilterLayer(filterId: string | null, name: string) {
  const at = st().playhead
  const clip = createEffectClip('', at, 'none', {
    name,
    filter: filterId ? { id: filterId, intensity: 100 } : null,
    adjust: filterId ? null : { brightness: 0, contrast: 0, saturation: 0, exposure: 0, temperature: 0, tint: 0, highlights: 0, shadows: 0, hue: 0, sharpen: 0, vignette: 0, fade: 0, grain: 0 },
  })
  store().commit((p) => {
    const free = ensureFreeTrack(p, 'effect', at, at + clip.duration)
    return addClip(free.project, { ...clip, trackId: free.trackId }, opts())
  }, { selection: [clip.id] })
}

/** Applies a filter to the selected visual clips, or adds a filter layer when nothing is selected. */
export function applyFilter(filterId: string | null, name: string) {
  const sel = selectedClips().filter((c) => c.type === 'video' || c.type === 'image' || c.type === 'effect')
  if (!sel.length) {
    if (filterId) addFilterLayer(filterId, name)
    return
  }
  updateSelected(
    (c): c is MediaClip | Extract<Clip, { type: 'effect' }> => c.type === 'video' || c.type === 'image' || c.type === 'effect',
    (c) => ({ ...c, filter: filterId ? { id: filterId, intensity: c.filter?.intensity ?? 100 } : null }),
  )
}

/**
 * Adds a transition at the cut nearest the playhead on the selected clip's
 * track (or the main track), between two adjacent clips.
 */
export function addTransition(name: TransitionName, duration = 0.5) {
  const { project, playhead } = st()
  const sel = selectedClips()[0]
  const track = sel ? getTrack(project, sel.trackId) : mainTrack(project)
  if (!track) return
  const candidates = project.clips
    .filter((c): c is MediaClip => c.trackId === track.id && isMediaClip(c) && c.type !== 'audio' && !!nextAdjacent(project, c))
    .sort((a, b) => Math.abs(clipEnd(a) - playhead) - Math.abs(clipEnd(b) - playhead))
  const from = sel && isMediaClip(sel) && nextAdjacent(project, sel) ? sel : candidates[0]
  if (!from) {
    toast.message('Transitions go between two clips that touch on the same track')
    return
  }
  store().commit((p) => setTransition(p, from.id, { name, duration }, opts()), { selection: [from.id] })
}

export function removeTransition(id: string) {
  store().commit((p) => setTransition(p, id, null, opts()))
}

// ── Canvas & project settings ───────────────────────────────────────────────

export function setCanvasRatio(ratioId: string) {
  const preset = CANVAS_RATIOS.find((r) => r.id === ratioId)
  if (ratioId === 'original') {
    const first = st().project.clips.find((c): c is MediaClip => isMediaClip(c) && c.type !== 'audio')
    const asset = first ? st().assets[first.assetId] : undefined
    if (!asset) return
    // adoptCanvasFrom only adapts an empty project, so evaluate it as if empty.
    store().commit((p) => ({ ...adoptCanvasFrom({ ...p, clips: [] }, asset), clips: p.clips, updatedAt: Date.now() }))
    return
  }
  if (!preset) return
  store().commit((p) => ({ ...p, canvas: { ...p.canvas, ratio: preset.id, width: preset.width, height: preset.height }, updatedAt: Date.now() }))
}

export function setCanvasBackground(background: CanvasBackground) {
  store().commit((p) => ({ ...p, canvas: { ...p.canvas, background }, updatedAt: Date.now() }))
}

export async function setBackgroundImage(file: File) {
  const added = await importFiles([file])
  const asset = added[0]
  if (asset?.kind === 'image') setCanvasBackground({ type: 'image', assetId: asset.id })
}

export function setFps(fps: number) {
  store().commit((p) => ({ ...p, fps, updatedAt: Date.now() }))
}

export function setTrackFlag(trackId: string, flag: 'hidden' | 'muted' | 'locked') {
  const track = getTrack(st().project, trackId)
  if (track) store().commit((p) => updateTrack(p, trackId, { [flag]: !track[flag] } as Partial<Track>))
}

export function addEmptyTrack(kind: Track['kind']) {
  store().commit((p) => insertTrack(p, createTrack(kind)))
}

// ── Markers & navigation ────────────────────────────────────────────────────

export function addMarker(label = '') {
  const t = st().playhead
  const color = MARKER_COLORS[st().project.markers.length % MARKER_COLORS.length]
  store().commit((p) => ({ ...p, markers: [...p.markers.filter((m) => Math.abs(m.t - t) > 1e-3), { id: newId(), t, color, label }].sort((a, b) => a.t - b.t) }))
}

export function updateMarker(id: string, patch: Partial<Pick<Marker, 'label' | 'color' | 'note' | 'duration' | 't'>>) {
  store().commit((p) => ({ ...p, markers: p.markers.map((m) => (m.id === id ? { ...m, ...patch } : m)) }))
}

export function removeMarker(id: string) {
  store().commit((p) => ({ ...p, markers: p.markers.filter((m) => m.id !== id) }))
}

export function jumpToCut(direction: -1 | 1) {
  const t = st().playhead
  const points = cutPoints(st().project)
  const target = direction > 0 ? points.find((x) => x > t + 1e-3) : [...points].reverse().find((x) => x < t - 1e-3)
  if (target !== undefined) seek(target)
}

export function jumpToMarker(direction: -1 | 1) {
  const t = st().playhead
  const markers = st().project.markers.map((m) => m.t)
  const target = direction > 0 ? markers.find((x) => x > t + 1e-3) : [...markers].reverse().find((x) => x < t - 1e-3)
  if (target !== undefined) seek(target)
}

// ── Transport ───────────────────────────────────────────────────────────────

export function seek(t: number) {
  const clamped = Math.max(0, Math.min(t, Math.max(0, projectDuration(st().project))))
  store().set({ playhead: clamped })
  getEngine().seek(clamped)
}

export function togglePlay() {
  const e = getEngine()
  e.seek(st().playhead)
  e.toggle()
  store().set({ playing: e.isPlaying })
}

export function pause() {
  getEngine().pause()
  store().set({ playing: false })
}

export function stepFrame(direction: -1 | 1) {
  pause()
  seek(st().playhead + direction / st().project.fps)
}

export function setLeftTab(leftTab: LeftTab) {
  store().set({ leftTab })
}

// ── Clip tools (CapCut toolbar) ─────────────────────────────────────────────

/** The clip a tool should act on: the selection, or the main-track clip under the playhead. */
function toolTarget(filter: (c: Clip) => boolean): Clip | null {
  const sel = selectedClips().find(filter)
  if (sel) return sel
  const t = st().playhead
  return clipsAt(st().project, t).find((c) => filter(c) && getTrack(st().project, c.trackId)?.isMain) ?? clipsAt(st().project, t).find(filter) ?? null
}

export async function freezeFrame(duration = 3) {
  const clip = toolTarget((c) => c.type === 'video') as MediaClip | null
  if (!clip) {
    toast.message('Select a video clip and put the playhead on the frame to freeze')
    return
  }
  const t = Math.min(Math.max(st().playhead, clip.start), clipEnd(clip) - 1 / st().project.fps)
  const asset = st().assets[clip.assetId]
  const blob = await loadBlob(clip.assetId)
  if (!asset || !blob) return

  await withBusy('Freezing frame…', async () => {
    const { captureFrame } = await import('../engine/tools')
    const png = await captureFrame(blob, Math.max(0, sourceTimeAt(clip, t)))
    const bitmap = await createImageBitmap(png)
    const frameAsset: Asset = {
      id: newId(),
      kind: 'image',
      name: `${asset.name} freeze ${t.toFixed(2)}s.png`,
      mime: 'image/png',
      size: png.size,
      duration: 0,
      width: bitmap.width,
      height: bitmap.height,
      hasAudio: false,
      createdAt: Date.now(),
      derivedFrom: { assetId: asset.id, operation: 'freeze' },
    }
    bitmap.close()
    await registerAsset(frameAsset, png)

    store().commit((p) => {
      const track = getTrack(p, clip.trackId)!
      let next = splitClip(p, clip.id, t, opts()).project
      if (!(track.isMain && st().magnet)) {
        // Overlay tracks: push the rest of the track right to make room.
        next = { ...next, clips: next.clips.map((c) => (c.trackId === track.id && c.start >= t - 1e-4 ? { ...c, start: c.start + duration } : c)) }
      }
      const frozen: MediaClip = {
        ...createMediaClip(frameAsset as Asset & { kind: 'image' }, track.id, t),
        duration,
        name: 'Freeze frame',
        transform: clip.transform,
        crop: clip.crop,
        opacity: clip.opacity,
        blend: clip.blend,
        adjust: clip.adjust,
        filter: clip.filter,
        mask: clip.mask,
        chroma: clip.chroma,
      }
      return addClip(next, frozen, opts())
    })
    toast.success('Freeze frame added')
  })
}

export function extractAudio() {
  const sel = selectedClips().filter((c): c is MediaClip => c.type === 'video' && !!st().assets[(c as MediaClip).assetId]?.hasAudio)
  if (!sel.length) {
    toast.message('Select a video clip that has sound')
    return
  }
  const created: string[] = []
  store().commit((p) => {
    let next = p
    for (const v of sel) {
      const free = ensureFreeTrack(next, 'audio', v.start, clipEnd(v))
      next = free.project
      // Only the sound carries over; visual settings mean nothing on an audio clip.
      const audio: MediaClip = {
        ...structuredClone(v),
        id: newId(),
        type: 'audio',
        trackId: free.trackId,
        name: `${v.name} (audio)`,
        detachedFrom: v.id,
        transitionOut: null,
        muted: false,
        filter: null,
        adjust: neutralAdjust(),
        mask: defaultMask(),
        chroma: defaultChroma(),
        removeBackground: false,
        animation: defaultAnimation(),
      }
      next = addClip(next, audio, opts())
      next = updateClip<MediaClip>(next, v.id, (c) => ({ ...c, muted: true }))
      created.push(audio.id)
    }
    return next
  }, { selection: created })
  toast.success('Audio extracted to its own track')
}

export async function reverseSelected() {
  const clip = toolTarget((c) => c.type === 'video') as MediaClip | null
  if (!clip) {
    toast.message('Select a video clip to reverse')
    return
  }
  const asset = st().assets[clip.assetId]
  const blob = await loadBlob(clip.assetId)
  if (!asset || !blob) return
  const from = clip.sourceIn
  const to = Math.min(asset.duration, clip.sourceIn + clip.duration * clip.speed)

  await withBusy('Reversing clip…', async (progress, signal) => {
    const { reverseVideo } = await import('../engine/tools')
    const result = await reverseVideo(blob, from, to, { signal, onProgress: (p) => progress(p, `Reversing… ${Math.round(p * 100)}%`) })
    const reversed: Asset = {
      ...asset,
      id: newId(),
      name: `${asset.name.replace(/\.[^.]+$/, '')} reversed.${result.ext}`,
      mime: result.mime,
      size: result.blob.size,
      duration: to - from,
      createdAt: Date.now(),
      derivedFrom: { assetId: asset.id, operation: 'reverse' },
    }
    await registerAsset(reversed, result.blob)
    updateClipById<MediaClip>(clip.id, (c) => ({ ...c, assetId: reversed.id, sourceIn: 0, name: `${c.name} (reversed)` }))
    toast.success('Reverse completed')
  })
}

export async function splitByScene() {
  const clip = toolTarget((c) => c.type === 'video') as MediaClip | null
  if (!clip) {
    toast.message('Select a video clip to split by scene')
    return
  }
  const blob = await loadBlob(clip.assetId)
  if (!blob) return
  await withBusy('Detecting scenes…', async (progress, signal) => {
    const { detectScenes } = await import('../engine/tools')
    const from = clip.sourceIn
    const to = clip.sourceIn + clip.duration * clip.speed
    const cuts = await detectScenes(blob, from, to, { signal, onProgress: (p) => progress(p) })
    if (!cuts.length) {
      toast.message('No scene changes found in this clip')
      return
    }
    store().commit((p) => {
      let next = p
      let current = clip.id
      for (const s of cuts) {
        const t = clip.start + (s - from) / clip.speed
        const r = splitClip(next, current, t, opts())
        next = r.project
        if (r.rightId) current = r.rightId
      }
      return next
    })
    toast.success(`Split into ${cuts.length + 1} scenes`)
  })
}

/** Decodes the source audio a clip plays, as a PcmLike for analysis. */
async function clipPcm(clip: MediaClip) {
  const blob = await loadBlob(clip.assetId)
  if (!blob) return null
  const { decodeAudioRange } = await import('../engine/audio-io')
  const decoded = await decodeAudioRange(blob, clip.sourceIn, clip.sourceIn + clip.duration * clip.speed, 48000)
  if (!decoded) return null
  return {
    sampleRate: decoded.sampleRate,
    numberOfChannels: decoded.channels.length,
    length: decoded.channels[0].length,
    getChannelData: (i: number) => decoded.channels[i] ?? decoded.channels[0],
  }
}

const audible = (c: Clip): c is MediaClip => isMediaClip(c) && (c.type === 'audio' || (c.type === 'video' && !!st().assets[c.assetId]?.hasAudio))

export async function detectBeatsOnSelected() {
  const clip = toolTarget(audible) as MediaClip | null
  if (!clip) {
    toast.message('Select a music or video clip to mark beats')
    return
  }
  await withBusy('Detecting beats…', async () => {
    const pcm = await clipPcm(clip)
    if (!pcm) throw new Error('Could not decode this clip’s audio')
    const { detectBeats, estimateTempo } = await import('../engine/audio-dsp')
    const beats = detectBeats(pcm).map((b) => b / clip.speed)
    updateClipById<MediaClip>(clip.id, (c) => ({ ...c, beats }))
    const bpm = estimateTempo(beats.map((b) => b * clip.speed))
    toast.success(`Marked ${beats.length} beats${bpm ? ` (~${Math.round(bpm)} BPM)` : ''}`)
  })
}

export function clearBeats(id: string) {
  updateClipById<MediaClip>(id, (c) => ({ ...c, beats: [] }))
}

/** CapCut "Normalize loudness": sets each clip's volume so it measures `targetLufs`. */
export async function normalizeLoudness(targetLufs: number, scope: 'selected' | 'all') {
  const clips = (scope === 'all' ? st().project.clips : selectedClips()).filter(audible)
  if (!clips.length) {
    toast.message('Select a clip with sound, or choose “All clips”')
    return
  }
  await withBusy('Measuring loudness…', async (progress) => {
    const { measureLoudness, gainForTargetLufs } = await import('../engine/audio-dsp')
    const updates = new Map<string, number>()
    for (let i = 0; i < clips.length; i++) {
      progress(i / clips.length, `Measuring ${clips[i].name}…`)
      const pcm = await clipPcm(clips[i])
      if (!pcm) continue
      const m = measureLoudness(pcm)
      if (!Number.isFinite(m.integratedLufs)) continue
      updates.set(clips[i].id, Math.min(4, Math.max(0, gainForTargetLufs(m.integratedLufs, targetLufs, m.truePeakDb))))
    }
    store().commit((p) => [...updates].reduce((acc, [id, volume]) => updateClip<MediaClip>(acc, id, (c) => ({ ...c, volume })), p))
    toast.success(`Normalized ${updates.size} clip${updates.size === 1 ? '' : 's'} to ${targetLufs} LUFS`)
  })
}

// ── Captions ────────────────────────────────────────────────────────────────

function captionStyle(presetId = 'classic'): TextStyle {
  const preset = CAPTION_PRESETS.find((p) => p.id === presetId) ?? CAPTION_PRESETS[0]
  return { ...defaultTextStyle(), fontSize: Math.round(minSide() * 0.055), maxWidth: 0.8, shadowBlur: 0, shadowY: 0, ...preset.style }
}

/** Replaces caption clips with `cues` on a captions track near the bottom of the frame. */
function placeCaptions(cues: Array<{ start: number; end: number; text: string; words?: Array<{ text: string; start: number; end: number }> }>, presetId?: string, replace = true) {
  const { project } = st()
  const style = captionStyle(presetId)
  const y = Math.round(project.canvas.height * 0.32)
  store().commit((p) => {
    let next = replace ? deleteClips(p, p.clips.filter((c) => isTextClip(c) && c.isCaption).map((c) => c.id), opts()) : p
    const track = createTrack('text', { name: 'Captions' })
    next = insertTrack(next, track)
    for (const cue of cues) {
      if (cue.end - cue.start < 0.05 || !cue.text.trim()) continue
      const clip = createTextClip(track.id, cue.start, cue.text.trim(), {
        duration: cue.end - cue.start,
        style,
        isCaption: true,
        transform: { x: 0, y, scale: 1, rotation: 0, flipH: false, flipV: false },
        words: cue.words?.map((w) => ({ text: w.text, start: Math.max(0, w.start - cue.start), end: Math.max(0, w.end - cue.start) })) ?? null,
      })
      next = { ...next, clips: [...next.clips, clip] }
    }
    return next
  })
}

export interface AutoCaptionOptions {
  language: string
  model: WhisperModel
  source: 'main' | 'all'
  preset: string
}

/** CapCut "Auto captions": speech-to-text on the timeline audio, entirely in the browser. */
export async function autoCaptions(o: AutoCaptionOptions) {
  const { project, assets } = st()
  const end = projectDuration(project)
  const main = mainTrack(project)
  const anyAudio = project.clips.some((c) => audible(c))
  const hasSpeech = project.clips.some((c) => audible(c) && (o.source === 'all' || c.trackId === main.id))
  if (!end || !anyAudio) {
    toast.message('Add a clip with speech to the timeline first')
    return
  }
  if (!hasSpeech) {
    toast.message('The main track has no audio — choose “All audio” to caption voiceover or music tracks')
    return
  }
  await withBusy('Preparing audio…', async (progress, signal) => {
    const { mixdownToChannels } = await import('../engine/audio-io')
    const mix = await mixdownToChannels(project, assets, loadBlob, {
      start: 0,
      end,
      sampleRate: 16000,
      signal,
      filter: o.source === 'main' ? (c) => c.trackId === main.id : undefined,
      onProgress: (p) => progress(p * 0.15, 'Preparing audio…'),
    })
    const mono = new Float32Array(mix.channels[0].length)
    for (let i = 0; i < mono.length; i++) mono[i] = (mix.channels[0][i] + (mix.channels[1]?.[i] ?? mix.channels[0][i])) / 2

    const { transcribe } = await import('../engine/transcribe')
    // transcribe() transfers (detaches) its input; the speech check below still needs the samples.
    const result = await transcribe(mono.slice(), {
      language: o.language,
      model: o.model,
      signal,
      onProgress: (p) => {
        const base = p.stage === 'download' ? 0.15 : p.stage === 'load' ? 0.45 : 0.5
        const span = p.stage === 'download' ? 0.3 : p.stage === 'load' ? 0.05 : 0.5
        progress(base + p.progress * span, p.message)
      },
    })
    const { chunkWordsToCues } = await import('../engine/captions')
    const { hasSpeechActivity } = await import('../engine/audio-dsp')
    // Whisper can time invented words at or past the end of the audio, and
    // invents text over silence and steady sounds; keep only cues with speech under them.
    const words = result.words.filter((w) => w.start < end - 0.01).map((w) => ({ ...w, end: Math.min(w.end, end) }))
    const cues = chunkWordsToCues(words)
      .filter((c) => hasSpeechActivity(mono, 16000, c.start, c.end))
      .map((c) => ({ ...c, end: Math.min(c.end, end) }))
    if (!cues.length) {
      toast.message('No speech was recognized')
      return
    }
    placeCaptions(cues, o.preset)
    store().set({ leftTab: 'captions' })
    toast.success(`Created ${cues.length} captions (${result.language})`)
  })
}

export async function importCaptionsFile(file: File) {
  const { parseCaptions } = await import('../engine/captions')
  const cues = parseCaptions(await file.text(), file.name)
  if (!cues.length) {
    toast.error(`${file.name}: no captions found`)
    return
  }
  placeCaptions(cues, 'classic', false)
  toast.success(`Imported ${cues.length} captions`)
}

export function applyCaptionPreset(presetId: string) {
  const style = captionStyle(presetId)
  const ids = st().project.clips.filter((c) => isTextClip(c) && c.isCaption).map((c) => c.id)
  store().commit((p) => ids.reduce((acc, id) => updateClip<TextClip>(acc, id, (c) => ({ ...c, style: { ...style, fontFamily: c.style.fontFamily } })), p))
}

/** CapCut "Apply to all captions": copies one caption's style to every caption. */
export function applyStyleToAllCaptions(fromId: string) {
  const source = getClip(st().project, fromId)
  if (!isTextClip(source)) return
  const ids = st().project.clips.filter((c) => isTextClip(c) && c.isCaption && c.id !== fromId).map((c) => c.id)
  store().commit((p) => ids.reduce((acc, id) => updateClip<TextClip>(acc, id, (c) => ({ ...c, style: { ...source.style }, transform: { ...source.transform } })), p))
}

// ── LUTs ────────────────────────────────────────────────────────────────────

export async function importLutFile(file: File) {
  const { parseCubeLut } = await import('../engine/lut')
  const lut = parseCubeLut(await file.text())
  const asset: Asset = {
    id: newId(),
    kind: 'lut',
    name: lut.title || file.name.replace(/\.cube$/i, ''),
    mime: 'text/plain',
    size: file.size,
    duration: 0,
    width: lut.size,
    height: lut.size,
    hasAudio: false,
    createdAt: Date.now(),
  }
  lutCache.set(asset.id, lut)
  await registerAsset(asset, file)
  toast.success(`LUT “${asset.name}” imported`)
  return asset
}

/** Removes an asset from the media bin; refused while a clip still uses it. */
export function removeFromBin(assetId: string) {
  const inUse = st().project.clips.some((c) => isMediaClip(c) && c.assetId === assetId)
  if (inUse) {
    toast.message('That media is used on the timeline — delete those clips first')
    return
  }
  store().set((s) => ({ project: { ...s.project, bin: s.project.bin.filter((id) => id !== assetId), updatedAt: Date.now() } }))
}

// ── Voiceover ───────────────────────────────────────────────────────────────

let recorder: { rec: MediaRecorder; stream: MediaStream; start: number; chunks: Blob[] } | null = null

export const isRecording = () => !!recorder

/**
 * CapCut "Record audio": records the microphone from the playhead while the
 * timeline plays silently, then drops the take onto an audio track there.
 */
export async function startVoiceover() {
  if (recorder) return
  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
  } catch {
    toast.error('Microphone access was blocked. Allow it in the browser’s site settings to record.')
    return
  }
  const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? ''
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
  const chunks: Blob[] = []
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  recorder = { rec, stream, start: st().playhead, chunks }
  rec.start(250)
  getEngine().setMuted(true)
  if (!st().playing && projectDuration(st().project) > st().playhead) togglePlay()
  store().set({ recording: true })
}

export async function stopVoiceover() {
  const r = recorder
  if (!r) return
  recorder = null
  await new Promise<void>((resolve) => {
    r.rec.onstop = () => resolve()
    r.rec.stop()
  })
  r.stream.getTracks().forEach((t) => t.stop())
  pause()
  getEngine().setMuted(false)
  store().set({ recording: false })
  const type = r.rec.mimeType || 'audio/webm'
  const ext = type.includes('mp4') ? 'm4a' : 'webm'
  const file = new File(r.chunks, `Voiceover ${new Date().toLocaleTimeString().replace(/:/g, '.')}.${ext}`, { type })
  const [asset] = await importFiles([file])
  if (asset) {
    addAssetToTimeline(asset.id, r.start)
    seek(r.start)
  }
}

/** Undoes "Extract audio": the detached clip is removed and the video plays its own sound again. */
export function reattachAudio(audioClipId: string) {
  const audio = getClip(st().project, audioClipId)
  if (!isMediaClip(audio) || !audio.detachedFrom) return
  const video = getClip(st().project, audio.detachedFrom)
  if (!video) {
    toast.message('The original video clip is gone, so there is nothing to reattach to')
    return
  }
  store().commit((p) => {
    let next = deleteClips(p, [audioClipId], { magnet: st().magnet })
    next = updateClip<MediaClip>(next, video.id, (c) => ({ ...c, muted: false }))
    return next
  }, { selection: [video.id] })
}

// ── Scenes ──────────────────────────────────────────────────────────────────

export function switchSceneTo(id: string) {
  pause()
  store().commit((p) => scenes.switchScene(p, id), { selection: [] })
  seek(0)
}

export function addNewScene() {
  pause()
  store().commit((p) => scenes.addScene(p), { selection: [] })
  seek(0)
}

export function duplicateSceneById(id: string) {
  pause()
  store().commit((p) => scenes.duplicateScene(p, id), { selection: [] })
  seek(0)
}

export function renameSceneById(id: string, name: string) {
  store().commit((p) => scenes.renameScene(p, id, name))
}

export function deleteSceneById(id: string) {
  if (scenes.sceneList(st().project).length <= 1) {
    toast.message('A project needs at least one scene')
    return
  }
  pause()
  store().commit((p) => scenes.deleteScene(p, id), { selection: [] })
  seek(Math.min(st().playhead, projectDuration(st().project)))
}

export function moveSceneBy(id: string, direction: -1 | 1) {
  store().commit((p) => scenes.moveScene(p, id, direction))
}

// ── Shapes, flags & canvas size ─────────────────────────────────────────────

/** Adds a vector shape (OpenCut "graphics") as an overlay at the playhead. */
export function addShape(presetId: string) {
  const preset = SHAPE_PRESETS.find((s) => s.id === presetId) ?? SHAPE_PRESETS[0]
  const at = st().playhead
  const clip = createShapeClip('', at, preset.shape, Math.round(minSide() * 0.4), { ...preset.params, name: preset.label })
  store().commit((p) => {
    const free = ensureFreeTrack(p, 'video', at, at + clip.duration)
    return addClip(free.project, { ...clip, trackId: free.trackId }, opts())
  }, { selection: [clip.id] })
}

/** Flag stickers ship as SVG; the compositor wants a bitmap, so one is rasterised on import. */
export async function addFlagSticker(code: string, name: string) {
  const existing = Object.values(st().assets).find((a) => a.kind === 'image' && a.name === `Flag ${name}.png`)
  if (existing) {
    addAssetToTimeline(existing.id, undefined, undefined, true)
    return
  }
  try {
    const svg = await fetch(`/flags/${code}.svg`).then((r) => {
      if (!r.ok) throw new Error(`flag ${code} not found`)
      return r.blob()
    })
    const url = URL.createObjectURL(svg)
    const img = new Image()
    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve()
      img.onerror = () => reject(new Error('flag failed to render'))
      img.src = url
    })
    const w = 960
    const h = Math.round((w * (img.naturalHeight || 480)) / (img.naturalWidth || 640))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
    URL.revokeObjectURL(url)
    const png = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'))
    if (!png) throw new Error('flag failed to encode')
    const [asset] = await importFiles([new File([png], `Flag ${name}.png`, { type: 'image/png' })])
    if (asset) addAssetToTimeline(asset.id, undefined, undefined, true)
  } catch (err) {
    toast.error((err as Error).message)
  }
}

/** Typed-in canvas size (OpenCut custom canvas); even dimensions keep every encoder happy. */
export function setCanvasSize(width: number, height: number) {
  const w = Math.max(16, Math.min(7680, Math.round(width / 2) * 2))
  const h = Math.max(16, Math.min(7680, Math.round(height / 2) * 2))
  store().commit((p) => ({ ...p, canvas: { ...p.canvas, ratio: 'custom', width: w, height: h }, updatedAt: Date.now() }))
}

// ── Keyframes: curves, lanes & clipboard ────────────────────────────────────

type Keyable = Exclude<Clip, { type: 'effect' }>

export function setKeyframeEase(id: string, prop: KeyframeProp, t: number, ease: Keyframe['ease'], live = false) {
  const fn = (c: Keyable) => ({ ...c, keyframes: withKeyframeEase(c.keyframes, prop, t, ease) }) as Keyable
  if (live) previewClipById<Keyable>(id, fn)
  else updateClipById<Keyable>(id, fn)
}

export function moveKeyframeTime(id: string, prop: KeyframeProp, from: number, to: number, live = false) {
  const fn = (c: Keyable) => ({ ...c, keyframes: retimeKeyframe(c.keyframes, prop, from, to, c.duration) }) as Keyable
  if (live) previewClipById<Keyable>(id, fn)
  else updateClipById<Keyable>(id, fn)
}

export function removeKeyframeAt(id: string, prop: KeyframeProp, t: number) {
  updateClipById<Keyable>(id, (c) => ({ ...c, keyframes: withoutKeyframe(c.keyframes, prop, t) }) as Keyable)
}

export function clearKeyframes(id: string, prop?: KeyframeProp) {
  updateClipById<Keyable>(id, (c) => {
    if (!prop) return { ...c, keyframes: {} } as Keyable
    const { [prop]: _dropped, ...rest } = c.keyframes
    return { ...c, keyframes: rest } as Keyable
  })
}

let keyframeClipboard: { keyframes: Keyframes; duration: number } | null = null

export const hasCopiedKeyframes = () => !!keyframeClipboard

export function copyKeyframes(id: string) {
  const clip = getClip(st().project, id)
  if (!clip || clip.type === 'effect') return
  const count = Object.values(clip.keyframes).reduce((n, list) => n + (list?.length ?? 0), 0)
  if (!count) {
    toast.message('This clip has no keyframes to copy')
    return
  }
  keyframeClipboard = { keyframes: structuredClone(clip.keyframes), duration: clip.duration }
  toast.message(`Copied ${count} keyframe${count === 1 ? '' : 's'}`)
}

/** Pastes copied keyframes, stretched to the target clip's length; animated properties are replaced, others kept. */
export function pasteKeyframes(ids = st().selection) {
  if (!keyframeClipboard) {
    toast.message('Copy keyframes from a clip first')
    return
  }
  const src = keyframeClipboard
  store().commit((p) =>
    ids.reduce((acc, id) => {
      const target = getClip(acc, id)
      if (!target || target.type === 'effect') return acc
      const scaled = rescaleKeyframes(src.keyframes, src.duration, target.duration)
      const keep = target.type === 'audio' ? (['volume'] as KeyframeProp[]) : (Object.keys(scaled) as KeyframeProp[])
      const merged: Keyframes = { ...target.keyframes }
      for (const prop of keep) if (scaled[prop]) merged[prop] = scaled[prop]
      return updateClip<Keyable>(acc, id, (c) => ({ ...c, keyframes: merged }) as Keyable)
    }, p),
  )
}

export function toggleExpandedKeyframes(id: string) {
  const list = st().expandedKeyframes
  store().set({ expandedKeyframes: list.includes(id) ? list.filter((x) => x !== id) : [...list, id] })
}

// ── Group moves ─────────────────────────────────────────────────────────────

/** Nudges every selected clip by `delta` seconds (arrow keys with a selection). */
export function nudgeSelected(delta: number) {
  const ids = st().selection
  if (!ids.length) return
  store().commit((p) => moveClips(p, ids, delta, opts()))
}

// ── Preview view state ──────────────────────────────────────────────────────

export const PREVIEW_ZOOMS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4]

export function setPreviewZoom(zoom: number) {
  store().set({ previewZoom: zoom, previewPan: zoom === 0 ? { x: 0, y: 0 } : st().previewPan })
}

/** Steps through the preset zoom levels; `fitScale` is the current fit-to-panel factor so stepping starts from what is shown. */
export function stepPreviewZoom(direction: -1 | 1, fitScale: number) {
  const current = st().previewZoom || fitScale
  const next = direction > 0 ? PREVIEW_ZOOMS.find((z) => z > current + 1e-3) : [...PREVIEW_ZOOMS].reverse().find((z) => z < current - 1e-3)
  if (next !== undefined) setPreviewZoom(next)
}

export function setPreviewPan(pan: { x: number; y: number }) {
  store().set({ previewPan: pan })
}

export function setGuide(guide: GuideId) {
  store().set({ guide })
}

// ── In-place text editing & pen masks ───────────────────────────────────────

export function startTextEdit(id: string) {
  const clip = getClip(st().project, id)
  if (!isTextClip(clip)) return
  pause()
  store().set({ editingTextId: id, selection: [id] })
}

export function stopTextEdit() {
  if (st().editingTextId) store().set({ editingTextId: null })
}

export function setMaskDrawing(on: boolean) {
  store().set({ maskDrawing: on })
}

/** Appends a vertex to the selected clip's freeform mask (pen tool click on the preview). */
export function addMaskPoint(id: string, point: MaskPathPoint) {
  updateClipById<MediaClip | ShapeClip>(id, (c) => ({ ...c, mask: { ...c.mask, shape: 'freeform', path: [...(c.mask.path ?? []), point] } }))
}

export function updateMaskPoint(id: string, index: number, point: MaskPathPoint, live = false) {
  const fn = (c: MediaClip | ShapeClip) => ({ ...c, mask: { ...c.mask, path: (c.mask.path ?? []).map((p, i) => (i === index ? point : p)) } })
  if (live) previewClipById<MediaClip | ShapeClip>(id, fn)
  else updateClipById<MediaClip | ShapeClip>(id, fn)
}

export function clearMaskPath(id: string) {
  updateClipById<MediaClip | ShapeClip>(id, (c) => ({ ...c, mask: { ...c.mask, path: [] } }))
}

// ── Misc helpers for UI ─────────────────────────────────────────────────────

export const clipGainAt = (clip: MediaClip, t: number) => gainAt(clip, t)

export function adjacentClips(id: string) {
  const p = st().project
  const c = getClip(p, id)
  return c ? { prev: prevAdjacent(p, c), next: nextAdjacent(p, c) } : { prev: undefined, next: undefined }
}
