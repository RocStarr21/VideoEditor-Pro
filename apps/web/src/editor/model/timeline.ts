/**
 * Pure timeline operations. Every function takes a Project and returns a new
 * one (or the same object when nothing changed), so the store can keep undo
 * history by reference and the logic is unit-testable without a browser.
 */
import { createTrack, newId } from './defaults'
import { mapKeyframes, partitionKeyframes } from './keyframes'
import type { Asset, Clip, MediaClip, Project, TextClip, Track, TrackKind, Transition } from './types'

export const EPS = 1e-4
/** Shortest clip the editor will create by trimming or splitting. */
export const MIN_CLIP = 0.1
export const MAX_TRANSITION = 2

export type AssetMap = Record<string, Asset | undefined>

export interface EditOptions {
  /** CapCut "Main track magnet": main-track clips stay packed from 0 with no gaps. */
  magnet: boolean
  /** OpenCut "Ripple editing": deleting or trimming on any track closes the gap it leaves. */
  ripple?: boolean
}

// ── Queries ─────────────────────────────────────────────────────────────────

export const clipEnd = (c: Clip) => c.start + c.duration

export const isMediaClip = (c: Clip | undefined): c is MediaClip =>
  !!c && (c.type === 'video' || c.type === 'image' || c.type === 'audio')

export const isTextClip = (c: Clip | undefined): c is TextClip => !!c && c.type === 'text'

export const trackKindForClip = (type: Clip['type']): TrackKind =>
  type === 'audio' ? 'audio' : type === 'text' ? 'text' : type === 'effect' ? 'effect' : 'video'

/**
 * Shifts every clip on `trackId` that starts at or after `from` left by
 * `amount` (right when negative), never letting one run into the clip before it.
 */
export function rippleShift(p: Project, trackId: string, from: number, amount: number, exceptIds: readonly string[] = []): Project {
  if (Math.abs(amount) < EPS) return p
  const ordered = clipsOnTrack(p, trackId, exceptIds)
  const moving = ordered.filter((c) => c.start >= from - EPS)
  if (!moving.length) return p
  const fixed = ordered.filter((c) => c.start < from - EPS)
  let floor = fixed.reduce((m, c) => Math.max(m, clipEnd(c)), 0)
  const starts = new Map<string, number>()
  for (const c of moving) {
    const start = Math.max(0, floor, c.start - amount)
    starts.set(c.id, start)
    floor = start + c.duration
  }
  return { ...p, clips: p.clips.map((c) => (starts.has(c.id) ? { ...c, start: starts.get(c.id)! } : c)) }
}

export const getClip = (p: Project, id: string) => p.clips.find((c) => c.id === id)
export const getTrack = (p: Project, id: string) => p.tracks.find((t) => t.id === id)
export const mainTrack = (p: Project) => p.tracks.find((t) => t.isMain) as Track

export function clipsOnTrack(p: Project, trackId: string, exceptIds: readonly string[] = []): Clip[] {
  return p.clips.filter((c) => c.trackId === trackId && !exceptIds.includes(c.id)).sort((a, b) => a.start - b.start)
}

export function projectDuration(p: Project) {
  return p.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0)
}

export function clipsAt(p: Project, t: number): Clip[] {
  return p.clips.filter((c) => t >= c.start - EPS && t < clipEnd(c) - EPS)
}

/** Source time (seconds into the asset) shown at timeline time `t`. */
export const sourceTimeAt = (c: MediaClip, t: number) => c.sourceIn + (t - c.start) * c.speed

/** Longest timeline duration a media clip can reach from its current source in-point. */
export function maxDurationFor(c: Clip, assets: AssetMap): number {
  if (!isMediaClip(c) || c.type === 'image') return Infinity
  const asset = assets[c.assetId]
  if (!asset) return c.duration
  return Math.max(MIN_CLIP, (asset.duration - c.sourceIn) / c.speed)
}

function overlaps(p: Project, trackId: string, start: number, end: number, exceptIds: readonly string[]) {
  return clipsOnTrack(p, trackId, exceptIds).some((c) => start < clipEnd(c) - EPS && end > c.start + EPS)
}

export function nextAdjacent(p: Project, clip: Clip): Clip | undefined {
  return clipsOnTrack(p, clip.trackId).find((c) => c.id !== clip.id && Math.abs(c.start - clipEnd(clip)) < 1e-3)
}

export function prevAdjacent(p: Project, clip: Clip): Clip | undefined {
  return clipsOnTrack(p, clip.trackId).find((c) => c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 1e-3)
}

// ── Low-level helpers ───────────────────────────────────────────────────────

const touch = (p: Project): Project => ({ ...p, updatedAt: Date.now() })

export function updateClip<T extends Clip>(p: Project, id: string, fn: (c: T) => T): Project {
  let changed = false
  const clips = p.clips.map((c) => {
    if (c.id !== id) return c
    const next = fn(c as T)
    if (next !== c) changed = true
    return next
  })
  return changed ? touch({ ...p, clips }) : p
}

export function updateTrack(p: Project, id: string, patch: Partial<Track>): Project {
  return touch({ ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...patch } : t)) })
}

/** Track groups top-to-bottom in the timeline, matching CapCut's layout. */
const GROUP_ORDER = (t: Track) => (t.kind === 'effect' ? 0 : t.kind === 'text' ? 1 : t.kind === 'video' ? (t.isMain ? 3 : 2) : 4)

/** Inserts a track at the top of its kind's group, so newer overlays sit above older ones. */
export function insertTrack(p: Project, track: Track): Project {
  const tracks = [...p.tracks]
  const group = GROUP_ORDER(track)
  const index = tracks.findIndex((t) => GROUP_ORDER(t) >= group)
  tracks.splice(index === -1 ? tracks.length : index, 0, track)
  return touch({ ...p, tracks })
}

/** Removes tracks left empty, except the main track. */
export function pruneEmptyTracks(p: Project): Project {
  const used = new Set(p.clips.map((c) => c.trackId))
  const tracks = p.tracks.filter((t) => t.isMain || used.has(t.id))
  return tracks.length === p.tracks.length ? p : { ...p, tracks }
}

/** A track of `kind` free over [start, end), creating one when every existing track is occupied. */
export function ensureFreeTrack(
  p: Project,
  kind: TrackKind,
  start: number,
  end: number,
  exceptIds: readonly string[] = [],
  prefer?: string,
): { project: Project; trackId: string } {
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked && !(kind === 'video' && t.isMain))
  const ordered = prefer ? [...candidates.filter((t) => t.id === prefer), ...candidates.filter((t) => t.id !== prefer)] : candidates
  // Prefer the track nearest the main track (bottom of the group) so overlays stack upward.
  const bottomUp = prefer ? ordered : [...ordered].reverse()
  const free = bottomUp.find((t) => !overlaps(p, t.id, start, end, exceptIds))
  if (free) return { project: p, trackId: free.id }
  const track = createTrack(kind)
  return { project: insertTrack(p, track), trackId: track.id }
}

/** Keeps main-track clips packed from 0 in time order when the magnet is on. */
export function packMainTrack(p: Project, opts: EditOptions): Project {
  if (!opts.magnet) return p
  const main = mainTrack(p)
  if (!main) return p
  const ordered = clipsOnTrack(p, main.id)
  let cursor = 0
  const starts = new Map<string, number>()
  for (const c of ordered) {
    starts.set(c.id, cursor)
    cursor += c.duration
  }
  let changed = false
  const clips = p.clips.map((c) => {
    const s = starts.get(c.id)
    if (s === undefined || Math.abs(s - c.start) < EPS) return c
    changed = true
    return { ...c, start: s }
  })
  return changed ? touch({ ...p, clips }) : p
}

/** Drops transitions that no longer sit between two adjacent clips. */
export function validateTransitions(p: Project): Project {
  let changed = false
  const clips = p.clips.map((c) => {
    if (!isMediaClip(c) || !c.transitionOut) return c
    const next = nextAdjacent(p, c)
    if (next && isMediaClip(next) && next.type !== 'audio') {
      const limit = Math.min(MAX_TRANSITION, c.duration / 2, next.duration / 2)
      if (c.transitionOut.duration <= limit + EPS) return c
      changed = true
      return { ...c, transitionOut: { ...c.transitionOut, duration: limit } }
    }
    changed = true
    return { ...c, transitionOut: null }
  })
  return changed ? { ...p, clips } : p
}

const finalize = (p: Project, opts: EditOptions) => validateTransitions(pruneEmptyTracks(packMainTrack(p, opts)))

// ── Edits ───────────────────────────────────────────────────────────────────

/**
 * Adds a clip. On the magnetic main track it is inserted at the position its
 * start time falls in and everything after ripples right; elsewhere it moves
 * to a free track of the right kind when its preferred track is occupied.
 */
export function addClip(p: Project, clip: Clip, opts: EditOptions): Project {
  const kind = trackKindForClip(clip.type)
  let target = getTrack(p, clip.trackId)
  if (!target || target.kind !== kind) {
    const fallback = kind === 'video' ? mainTrack(p) : undefined
    if (fallback) target = fallback
    else {
      const free = ensureFreeTrack(p, kind, clip.start, clip.start + clip.duration)
      p = free.project
      target = getTrack(p, free.trackId)!
    }
  }

  if (target.isMain && opts.magnet) {
    const ordered = clipsOnTrack(p, target.id)
    const before = ordered.filter((c) => c.start + c.duration / 2 <= clip.start + EPS)
    const insertAt = before.reduce((sum, c) => sum + c.duration, 0)
    // Shift later clips right by the new clip's length, then pack.
    const shifted = p.clips.map((c) => (c.trackId === target!.id && c.start >= insertAt - EPS ? { ...c, start: c.start + clip.duration } : c))
    return finalize(touch({ ...p, clips: [...shifted, { ...clip, trackId: target.id, start: insertAt }] }), opts)
  }

  let trackId = target.id
  if (overlaps(p, trackId, clip.start, clip.start + clip.duration, [])) {
    const free = ensureFreeTrack(p, kind, clip.start, clip.start + clip.duration)
    p = free.project
    trackId = free.trackId
  }
  return finalize(touch({ ...p, clips: [...p.clips, { ...clip, trackId }] }), opts)
}

export function moveClip(p: Project, id: string, start: number, trackId: string, opts: EditOptions): Project {
  const clip = getClip(p, id)
  const target = getTrack(p, trackId)
  if (!clip || !target || target.locked) return p
  if (target.kind !== trackKindForClip(clip.type)) return p
  start = Math.max(0, start)

  if (target.isMain && opts.magnet) {
    // Reorder: the clip lands before the first clip whose midpoint is past the drop point.
    const others = clipsOnTrack(p, target.id, [id])
    let cursor = 0
    const order: Clip[] = []
    let placed = false
    for (const c of others) {
      if (!placed && start < cursor + c.duration / 2) {
        order.push({ ...clip, trackId: target.id })
        placed = true
      }
      order.push(c)
      cursor += c.duration
    }
    if (!placed) order.push({ ...clip, trackId: target.id })
    let s = 0
    const positioned = new Map(order.map((c) => {
      const entry = [c.id, { ...c, start: s }] as const
      s += c.duration
      return entry
    }))
    const clips = p.clips.map((c) => positioned.get(c.id) ?? c)
    return finalize(touch({ ...p, clips }), opts)
  }

  let finalTrack = target.id
  if (overlaps(p, target.id, start, start + clip.duration, [id])) {
    const free = ensureFreeTrack(p, target.kind, start, start + clip.duration, [id])
    p = free.project
    finalTrack = free.trackId
  }
  return finalize(updateClip(p, id, (c) => ({ ...c, start, trackId: finalTrack })), opts)
}

/**
 * Trims one edge to timeline time `to`. Media clips cannot reveal source
 * outside the asset; non-main clips cannot run into their neighbours.
 * Trimming the start of a main-track clip with the magnet on keeps the clip in
 * place and ripples the rest of the track left, as CapCut does.
 */
export function trimClip(p: Project, id: string, edge: 'start' | 'end', to: number, assets: AssetMap, opts: EditOptions): Project {
  const clip = getClip(p, id)
  if (!clip) return p
  const track = getTrack(p, clip.trackId)
  if (track?.locked) return p
  const magnetic = !!track?.isMain && opts.magnet
  const ripple = magnetic || !!opts.ripple
  const neighbours = clipsOnTrack(p, clip.trackId, [id])
  const end = clipEnd(clip)

  if (edge === 'start') {
    const speed = isMediaClip(clip) ? clip.speed : 1
    const sourceLimited = isMediaClip(clip) && clip.type !== 'image'
    // Earliest start the source allows (images and text can grow freely).
    let minStart = sourceLimited ? clip.start - (clip as MediaClip).sourceIn / speed : -Infinity
    if (!ripple) {
      // Off the magnetic track the clip really moves left, so it is also
      // bounded by its left neighbour and by 0. On it the clip stays put and
      // the track ripples, so only the source limit applies.
      const prev = neighbours.filter((c) => clipEnd(c) <= clip.start + EPS).at(-1)
      minStart = Math.max(minStart, prev ? clipEnd(prev) : 0)
    } else if (!sourceLimited) {
      minStart = clip.start - 3600
    }
    const newStart = Math.min(Math.max(to, minStart), end - MIN_CLIP)
    const delta = newStart - clip.start
    if (Math.abs(delta) < EPS) return p
    let next = updateClip<Clip>(p, id, (c) => {
      const base = {
        ...c,
        start: ripple ? c.start : newStart,
        duration: c.duration - delta,
        keyframes: mapKeyframes(c.keyframes, (k) => ({ ...k, t: k.t - delta })),
      }
      if (isMediaClip(c)) return { ...base, sourceIn: Math.max(0, c.sourceIn + delta * c.speed) } as MediaClip
      return base as Clip
    })
    // Off the magnetic track the clip stays put and later clips close in by the removed length.
    if (ripple && !magnetic) next = rippleShift(next, clip.trackId, end - EPS, delta, [id])
    return finalize(next, opts)
  }

  let maxEnd = clip.start + maxDurationFor(clip, assets)
  if (!ripple) {
    const nextClip = neighbours.find((c) => c.start >= end - EPS)
    if (nextClip) maxEnd = Math.min(maxEnd, nextClip.start)
  }
  const newEnd = Math.min(Math.max(to, clip.start + MIN_CLIP), maxEnd)
  if (Math.abs(newEnd - end) < EPS) return p
  let next = updateClip<Clip>(p, id, (c) => ({ ...c, duration: newEnd - c.start }))
  if (ripple && !magnetic) next = rippleShift(next, clip.trackId, end - EPS, end - newEnd, [id])
  return finalize(next, opts)
}

/**
 * Moves several clips by the same offset (multi-selection drag). Clips keep
 * their tracks; the move is refused when any of them would land on a clip that
 * is not part of the group. Magnetic main-track clips fall back to moveClip.
 */
export function moveClips(p: Project, ids: readonly string[], delta: number, opts: EditOptions): Project {
  const moving = ids.map((id) => getClip(p, id)).filter((c): c is Clip => !!c && !getTrack(p, c.trackId)?.locked)
  if (!moving.length) return p
  const minStart = Math.min(...moving.map((c) => c.start))
  const shift = Math.max(delta, -minStart)
  if (Math.abs(shift) < EPS) return p
  const group = new Set(moving.map((c) => c.id))
  const magnetic = moving.filter((c) => getTrack(p, c.trackId)?.isMain && opts.magnet)
  const free = moving.filter((c) => !magnetic.includes(c))
  for (const c of free) {
    if (overlaps(p, c.trackId, c.start + shift, clipEnd(c) + shift, [...group])) return p
  }
  let next: Project = { ...p, clips: p.clips.map((c) => (group.has(c.id) && !magnetic.includes(c) ? { ...c, start: c.start + shift } : c)) }
  for (const c of magnetic) next = moveClip(next, c.id, c.start + shift, c.trackId, opts)
  return finalize(touch(next), opts)
}

/** Splits one clip at timeline time `t`; returns the id of the right-hand piece. */
export function splitClip(p: Project, id: string, t: number, opts: EditOptions): { project: Project; rightId: string | null } {
  const clip = getClip(p, id)
  if (!clip || t <= clip.start + MIN_CLIP - EPS || t >= clipEnd(clip) - MIN_CLIP + EPS) return { project: p, rightId: null }
  if (getTrack(p, clip.trackId)?.locked) return { project: p, rightId: null }

  const local = t - clip.start
  const [leftKf, rightKf] = partitionKeyframes(clip.keyframes, local)
  const rightId = newId()

  let left: Clip = { ...clip, duration: local, keyframes: leftKf }
  let right: Clip = { ...clip, id: rightId, start: t, duration: clip.duration - local, keyframes: rightKf }

  if (isMediaClip(clip)) {
    left = {
      ...(left as MediaClip),
      fadeOut: 0,
      fadeIn: Math.min(clip.fadeIn, local),
      transitionOut: null,
      animation: { ...clip.animation, out: { ...clip.animation.out, name: 'none' } },
      beats: clip.beats.filter((b) => b < local),
    }
    right = {
      ...(right as MediaClip),
      sourceIn: clip.sourceIn + local * clip.speed,
      fadeIn: 0,
      fadeOut: Math.min(clip.fadeOut, clip.duration - local),
      animation: { ...clip.animation, in: { ...clip.animation.in, name: 'none' } },
      beats: clip.beats.filter((b) => b >= local).map((b) => b - local),
    }
  } else if (isTextClip(clip)) {
    const words = clip.words
    left = {
      ...(left as TextClip),
      animation: { ...clip.animation, out: { ...clip.animation.out, name: 'none' } },
      words: words ? words.filter((w) => w.start < local) : null,
    }
    right = {
      ...(right as TextClip),
      animation: { ...clip.animation, in: { ...clip.animation.in, name: 'none' } },
      words: words ? words.filter((w) => w.start >= local).map((w) => ({ ...w, start: w.start - local, end: w.end - local })) : null,
    }
    // Captions split word-accurately carry only their own words' text.
    const lw = (left as TextClip).words
    const rw = (right as TextClip).words
    if (clip.isCaption && lw?.length && rw?.length) {
      left = { ...(left as TextClip), text: lw.map((w) => w.text).join(' ') }
      right = { ...(right as TextClip), text: rw.map((w) => w.text).join(' ') }
    }
  }

  const clips = p.clips.flatMap((c) => (c.id === id ? [left, right] : [c]))
  return { project: finalize(touch({ ...p, clips }), opts), rightId }
}

/** Splits every clip under the playhead (or only `ids`) at `t`. */
export function splitClipsAt(p: Project, t: number, ids: readonly string[] | null, opts: EditOptions): Project {
  const targets = clipsAt(p, t).filter((c) => !ids || ids.includes(c.id))
  return targets.reduce((acc, c) => splitClip(acc, c.id, t, opts).project, p)
}

export function deleteClips(p: Project, ids: readonly string[], opts: EditOptions): Project {
  const victims = p.clips.filter((c) => ids.includes(c.id) && !getTrack(p, c.trackId)?.locked)
  if (!victims.length) return p
  const gone = new Set(victims.map((c) => c.id))
  let next: Project = { ...p, clips: p.clips.filter((c) => !gone.has(c.id)) }
  if (opts.ripple) {
    // Close each hole from the latest to the earliest so earlier shifts do not move later holes.
    const holes = victims.filter((c) => !(getTrack(p, c.trackId)?.isMain && opts.magnet)).sort((a, b) => b.start - a.start)
    for (const v of holes) next = rippleShift(next, v.trackId, clipEnd(v) - EPS, v.duration)
  }
  return finalize(touch(next), opts)
}

/** CapCut Q / W: split at the playhead and delete the left or right piece. */
export function trimAtPlayhead(p: Project, id: string, t: number, side: 'left' | 'right', assets: AssetMap, opts: EditOptions): Project {
  const clip = getClip(p, id)
  if (!clip || t <= clip.start || t >= clipEnd(clip)) return p
  return trimClip(p, id, side === 'left' ? 'start' : 'end', t, assets, opts)
}

export function duplicateClip(p: Project, id: string, opts: EditOptions): { project: Project; newId: string | null } {
  const clip = getClip(p, id)
  if (!clip) return { project: p, newId: null }
  const copy: Clip = { ...structuredClone(clip), id: newId(), start: clipEnd(clip) }
  if (isMediaClip(copy)) copy.transitionOut = null
  const track = getTrack(p, clip.trackId)!
  if (track.isMain && opts.magnet) {
    // Insert immediately after the original; later clips ripple right.
    const after = clipEnd(clip)
    const shifted = p.clips.map((c) => (c.trackId === track.id && c.start >= after - EPS ? { ...c, start: c.start + clip.duration } : c))
    return { project: finalize(touch({ ...p, clips: [...shifted, copy] }), opts), newId: copy.id }
  }
  let trackId = track.id
  if (overlaps(p, trackId, copy.start, clipEnd(copy), [])) {
    const free = ensureFreeTrack(p, track.kind, copy.start, clipEnd(copy))
    p = free.project
    trackId = free.trackId
  }
  return { project: finalize(touch({ ...p, clips: [...p.clips, { ...copy, trackId }] }), opts), newId: copy.id }
}

/**
 * Changes playback speed, rescaling duration and keyframe times so the same
 * source range plays faster or slower. If a slower clip would run into its
 * neighbour on an overlay track it moves to a free track.
 */
export function setClipSpeed(p: Project, id: string, speed: number, assets: AssetMap, opts: EditOptions): Project {
  const clip = getClip(p, id)
  if (!isMediaClip(clip) || clip.type === 'image') return p
  speed = Math.min(100, Math.max(0.1, speed))
  if (Math.abs(speed - clip.speed) < 1e-6) return p
  const ratio = clip.speed / speed
  const asset = assets[clip.assetId]
  const maxSource = asset ? asset.duration - clip.sourceIn : clip.duration * clip.speed
  const sourceSpan = Math.min(clip.duration * clip.speed, maxSource)
  const duration = Math.max(MIN_CLIP, sourceSpan / speed)

  let next = updateClip<MediaClip>(p, id, (c) => ({
    ...c,
    speed,
    duration,
    fadeIn: Math.min(c.fadeIn, duration / 2),
    fadeOut: Math.min(c.fadeOut, duration / 2),
    keyframes: mapKeyframes(c.keyframes, (k) => ({ ...k, t: k.t * ratio })),
    beats: c.beats.map((b) => b * ratio),
  }))

  const track = getTrack(next, clip.trackId)!
  if (!(track.isMain && opts.magnet)) {
    const updated = getClip(next, id)!
    if (overlaps(next, track.id, updated.start, clipEnd(updated), [id])) {
      const free = ensureFreeTrack(next, track.kind, updated.start, clipEnd(updated), [id])
      next = updateClip(free.project, id, (c) => ({ ...c, trackId: free.trackId }))
    }
  }
  return finalize(next, opts)
}

export function setTransition(p: Project, id: string, transition: Transition | null, opts: EditOptions): Project {
  const clip = getClip(p, id)
  if (!isMediaClip(clip)) return p
  if (transition) {
    const next = nextAdjacent(p, clip)
    if (!next || !isMediaClip(next) || clip.type === 'audio') return p
    const limit = Math.min(MAX_TRANSITION, clip.duration / 2, next.duration / 2)
    transition = { ...transition, duration: Math.max(0.1, Math.min(transition.duration, limit)) }
  }
  return finalize(updateClip<MediaClip>(p, id, (c) => ({ ...c, transitionOut: transition })), opts)
}

// ── Snapping ────────────────────────────────────────────────────────────────

export function snapPoints(p: Project, excludeIds: readonly string[], extra: number[] = []): number[] {
  const points = new Set<number>([0, ...extra, ...p.markers.map((m) => m.t)])
  for (const c of p.clips) {
    if (excludeIds.includes(c.id)) continue
    points.add(c.start)
    points.add(clipEnd(c))
    if (isMediaClip(c)) for (const b of c.beats) points.add(c.start + b)
  }
  return [...points]
}

/** Snaps `t` to the nearest point within `threshold` seconds. */
export function snapTime(t: number, points: readonly number[], threshold: number): { t: number; snappedTo: number | null } {
  let best: number | null = null
  let bestDist = threshold
  for (const point of points) {
    const d = Math.abs(point - t)
    if (d <= bestDist) {
      best = point
      bestDist = d
    }
  }
  return best === null ? { t, snappedTo: null } : { t: best, snappedTo: best }
}

// ── Navigation ──────────────────────────────────────────────────────────────

/** All clip boundaries, for CapCut's previous / next cut point navigation. */
export function cutPoints(p: Project): number[] {
  const points = new Set<number>([0])
  for (const c of p.clips) {
    points.add(c.start)
    points.add(clipEnd(c))
  }
  return [...points].sort((a, b) => a - b)
}
