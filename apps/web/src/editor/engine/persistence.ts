/**
 * IndexedDB persistence. Imported files are stored as Blobs so a project
 * reopens with its media after a reload — object URLs alone die with the tab.
 */
import type { Asset, Project } from '../model/types'
import type { Thumbnails } from './media'

const DB_NAME = 'videoeditor-pro'
const DB_VERSION = 1

interface AssetRecord {
  id: string
  asset: Asset
  blob: Blob
  thumbnails?: Thumbnails
  waveform?: Float32Array | null
}

export interface ProjectSummary {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  duration: number
  clipCount: number
  sceneCount: number
  ratio: string
  width: number
  height: number
  fps: number
  /** Object URL of the saved poster frame, if one exists. */
  thumbnail: string | null
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        const db = req.result
        if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('assets')) db.createObjectStore('assets', { keyPath: 'id' })
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta')
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode)
        const req = run(t.objectStore(store))
        t.oncomplete = () => resolve(req ? req.result : (undefined as T))
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error ?? new Error('IndexedDB transaction aborted'))
      }),
  )
}

export const saveProject = (project: Project) => tx('projects', 'readwrite', (s) => s.put(project))

export const loadProjectRecord = (id: string) => tx<Project | undefined>('projects', 'readonly', (s) => s.get(id))

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await tx<Project[]>('projects', 'readonly', (s) => s.getAll())
  const summaries = await Promise.all(
    all.map(async (p) => ({
      id: p.id,
      name: p.name,
      createdAt: p.createdAt,
      updatedAt: p.updatedAt,
      duration: p.clips.reduce((m, c) => Math.max(m, c.start + c.duration), 0),
      clipCount: p.clips.length + (p.otherScenes ?? []).reduce((n, s) => n + s.clips.length, 0),
      sceneCount: 1 + (p.otherScenes?.length ?? 0),
      ratio: p.canvas.ratio,
      width: p.canvas.width,
      height: p.canvas.height,
      fps: p.fps,
      thumbnail: await getProjectThumbnail(p.id),
    })),
  )
  return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
}

const thumbUrls = new Map<string, string>()

/** Saves a small poster frame for the Projects dialog. */
export const putProjectThumbnail = (id: string, blob: Blob) => {
  const old = thumbUrls.get(id)
  if (old) URL.revokeObjectURL(old)
  thumbUrls.delete(id)
  return tx('meta', 'readwrite', (s) => s.put(blob, `thumb:${id}`))
}

export async function getProjectThumbnail(id: string): Promise<string | null> {
  const cached = thumbUrls.get(id)
  if (cached) return cached
  const blob = await tx<Blob | undefined>('meta', 'readonly', (s) => s.get(`thumb:${id}`))
  if (!blob) return null
  const url = URL.createObjectURL(blob)
  thumbUrls.set(id, url)
  return url
}

export async function deleteProject(id: string) {
  await tx('projects', 'readwrite', (s) => s.delete(id))
  await tx('meta', 'readwrite', (s) => s.delete(`thumb:${id}`))
  await collectUnusedAssets()
}

export const setLastProjectId = (id: string) => tx('meta', 'readwrite', (s) => s.put(id, 'lastProjectId'))
export const getLastProjectId = () => tx<string | undefined>('meta', 'readonly', (s) => s.get('lastProjectId'))

export const putAsset = (asset: Asset, blob: Blob) =>
  tx('assets', 'readwrite', (s) => s.put({ id: asset.id, asset, blob } satisfies AssetRecord))

export async function putAssetDerived(id: string, data: { thumbnails?: Thumbnails; waveform?: Float32Array | null }) {
  const rec = await tx<AssetRecord | undefined>('assets', 'readonly', (s) => s.get(id))
  if (!rec) return
  await tx('assets', 'readwrite', (s) => s.put({ ...rec, ...data }))
}

export const getAssetRecord = (id: string) => tx<AssetRecord | undefined>('assets', 'readonly', (s) => s.get(id))

/** Deletes stored media no project references any more. */
export async function collectUnusedAssets() {
  const projects = await tx<Project[]>('projects', 'readonly', (s) => s.getAll())
  const used = new Set<string>()
  for (const p of projects) {
    for (const id of p.bin ?? []) used.add(id)
    const clips = [...p.clips, ...(p.otherScenes ?? []).flatMap((s) => s.clips)]
    for (const c of clips) if ('assetId' in c) used.add(c.assetId)
    if (p.canvas.background.type === 'image') used.add(p.canvas.background.assetId)
    for (const c of clips) {
      if ((c.type === 'video' || c.type === 'image' || c.type === 'audio' || c.type === 'effect') && c.filter?.id.startsWith('lut:')) used.add(c.filter.id.slice(4))
    }
  }
  const keys = await tx<IDBValidKey[]>('assets', 'readonly', (s) => s.getAllKeys())
  for (const key of keys) {
    if (!used.has(String(key))) await tx('assets', 'readwrite', (s) => s.delete(key))
  }
}

/** Rough storage usage, for the projects dialog. */
export async function storageEstimate() {
  if (!navigator.storage?.estimate) return null
  const { usage, quota } = await navigator.storage.estimate()
  return { usage: usage ?? 0, quota: quota ?? 0 }
}

/** Asks the browser not to evict editor data under storage pressure. */
export async function requestPersistentStorage() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist()
  } catch {
    // best effort
  }
}
