/**
 * Scenes: a project can hold several independent timelines (OpenCut
 * "scenes"). The open scene lives in `project.tracks/clips/markers`; the rest
 * are parked in `project.otherScenes` and swapped in when switched to.
 */
import { createTrack, newId } from './defaults'
import type { Project, SceneData, SceneMeta } from './types'

/** Projects saved before scenes existed get a single scene wrapping their timeline. */
export function normalizeScenes(p: Project): Project {
  if (p.scene && p.otherScenes) return p
  return { ...p, scene: p.scene ?? { id: newId(), name: 'Scene 1', order: 0 }, otherScenes: p.otherScenes ?? [] }
}

/** Every scene in strip order; the open one is included with no timeline data. */
export function sceneList(p: Project): SceneMeta[] {
  const q = normalizeScenes(p)
  const all: SceneMeta[] = [q.scene!, ...(q.otherScenes ?? []).map(({ id, name, order }) => ({ id, name, order }))]
  return all.sort((a, b) => a.order - b.order)
}

export function switchScene(p: Project, id: string): Project {
  const q = normalizeScenes(p)
  if (q.scene!.id === id) return p
  const target = q.otherScenes!.find((s) => s.id === id)
  if (!target) return p
  const parked: SceneData = { ...q.scene!, tracks: q.tracks, clips: q.clips, markers: q.markers }
  return {
    ...q,
    scene: { id: target.id, name: target.name, order: target.order },
    otherScenes: [...q.otherScenes!.filter((s) => s.id !== id), parked],
    tracks: target.tracks,
    clips: target.clips,
    markers: target.markers,
    updatedAt: Date.now(),
  }
}

/** Adds an empty scene after the open one and switches to it. */
export function addScene(p: Project, name?: string): Project {
  const q = normalizeScenes(p)
  const count = sceneList(q).length
  const order = q.scene!.order + 0.5
  const scene: SceneData = {
    id: newId(),
    name: name ?? `Scene ${count + 1}`,
    order,
    tracks: [createTrack('video', { isMain: true, name: 'Main track' }), createTrack('audio')],
    clips: [],
    markers: [],
  }
  return renumber(switchScene({ ...q, otherScenes: [...q.otherScenes!, scene] }, scene.id))
}

export function duplicateScene(p: Project, id: string): Project {
  const q = normalizeScenes(p)
  const source: SceneData | undefined =
    q.scene!.id === id ? { ...q.scene!, tracks: q.tracks, clips: q.clips, markers: q.markers } : q.otherScenes!.find((s) => s.id === id)
  if (!source) return p
  // Fresh ids throughout so clips copied between scenes never collide.
  const trackIds = new Map(source.tracks.map((t) => [t.id, newId()]))
  const copy: SceneData = {
    id: newId(),
    name: `${source.name} copy`,
    order: source.order + 0.5,
    tracks: source.tracks.map((t) => ({ ...t, id: trackIds.get(t.id)! })),
    clips: structuredClone(source.clips).map((c) => ({ ...c, id: newId(), trackId: trackIds.get(c.trackId) ?? c.trackId })),
    markers: source.markers.map((m) => ({ ...m, id: newId() })),
  }
  return renumber(switchScene({ ...q, otherScenes: [...q.otherScenes!, copy] }, copy.id))
}

export function renameScene(p: Project, id: string, name: string): Project {
  const q = normalizeScenes(p)
  const trimmed = name.trim() || 'Scene'
  if (q.scene!.id === id) return { ...q, scene: { ...q.scene!, name: trimmed }, updatedAt: Date.now() }
  return { ...q, otherScenes: q.otherScenes!.map((s) => (s.id === id ? { ...s, name: trimmed } : s)), updatedAt: Date.now() }
}

/** Removes a scene; the last remaining scene cannot be deleted. Deleting the open scene opens its neighbour. */
export function deleteScene(p: Project, id: string): Project {
  const q = normalizeScenes(p)
  const all = sceneList(q)
  if (all.length <= 1) return p
  if (q.scene!.id !== id) return renumber({ ...q, otherScenes: q.otherScenes!.filter((s) => s.id !== id), updatedAt: Date.now() })
  const idx = all.findIndex((s) => s.id === id)
  const neighbour = all[idx + 1] ?? all[idx - 1]
  const switched = switchScene(q, neighbour.id)
  return renumber({ ...switched, otherScenes: switched.otherScenes!.filter((s) => s.id !== id) })
}

/** Moves a scene one step left or right in the strip. */
export function moveScene(p: Project, id: string, direction: -1 | 1): Project {
  const q = normalizeScenes(p)
  const all = sceneList(q)
  const i = all.findIndex((s) => s.id === id)
  const j = i + direction
  if (i < 0 || j < 0 || j >= all.length) return p
  const orders = new Map(all.map((s, k) => [s.id, k]))
  orders.set(all[i].id, j)
  orders.set(all[j].id, i)
  return applyOrders(q, orders)
}

function renumber(p: Project): Project {
  const all = sceneList(p)
  return applyOrders(p, new Map(all.map((s, i) => [s.id, i])))
}

function applyOrders(p: Project, orders: Map<string, number>): Project {
  return {
    ...p,
    scene: { ...p.scene!, order: orders.get(p.scene!.id) ?? 0 },
    otherScenes: p.otherScenes!.map((s) => ({ ...s, order: orders.get(s.id) ?? s.order })),
    updatedAt: Date.now(),
  }
}
