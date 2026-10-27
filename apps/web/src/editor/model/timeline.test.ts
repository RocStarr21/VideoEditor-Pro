import { describe, expect, it } from 'vitest'
import { createMediaClip, createProject, createTextClip } from './defaults'
import { partitionKeyframes, valueAt, withKeyframe } from './keyframes'
import {
  addClip,
  clipEnd,
  clipsOnTrack,
  deleteClips,
  duplicateClip,
  getClip,
  mainTrack,
  moveClip,
  projectDuration,
  setClipSpeed,
  setTransition,
  snapTime,
  splitClip,
  trimClip,
  type AssetMap,
} from './timeline'
import type { Asset, MediaAssetKind, MediaClip, Project, TextClip } from './types'

const magnet = { magnet: true }
const free = { magnet: false }

type MediaAsset = Asset & { kind: MediaAssetKind }

const asset = (id: string, duration: number, kind: MediaAssetKind = 'video'): MediaAsset => ({
  id,
  kind,
  name: `${id}.mp4`,
  mime: 'video/mp4',
  size: 1,
  duration,
  width: 1920,
  height: 1080,
  hasAudio: true,
  createdAt: 0,
})

const media = { a: asset('a', 10), b: asset('b', 6), img: asset('img', 0, 'image') }
const assets: AssetMap = media

function withMain(...durations: number[]): Project {
  let p = createProject()
  const main = mainTrack(p)
  durations.forEach((_, i) => {
    const id = i === 0 ? 'a' : 'b'
    const clip = createMediaClip(media[id as 'a' | 'b'], main.id, 999)
    p = addClip(p, { ...clip, id: `c${i}` }, magnet)
  })
  return p
}

describe('main track magnet', () => {
  it('packs appended clips end to end from zero', () => {
    const p = withMain(10, 6)
    const clips = clipsOnTrack(p, mainTrack(p).id)
    expect(clips.map((c) => [c.start, c.duration])).toEqual([
      [0, 10],
      [10, 6],
    ])
    expect(projectDuration(p)).toBe(16)
  })

  it('ripples later clips left when a clip is deleted', () => {
    const p = deleteClips(withMain(10, 6), ['c0'], magnet)
    expect(getClip(p, 'c1')!.start).toBe(0)
  })

  it('reorders when a clip is dropped before another', () => {
    const start = withMain(10, 6)
    const p = moveClip(start, 'c1', 0, mainTrack(start).id, magnet)
    expect(getClip(p, 'c1')!.start).toBe(0)
    expect(getClip(p, 'c0')!.start).toBe(6)
  })

  it('keeps a left-trimmed main clip in place and ripples the rest', () => {
    const p = trimClip(withMain(10, 6), 'c0', 'start', 2, assets, magnet)
    const c0 = getClip(p, 'c0') as MediaClip
    expect(c0.start).toBe(0)
    expect(c0.duration).toBeCloseTo(8)
    expect(c0.sourceIn).toBeCloseTo(2)
    expect(getClip(p, 'c1')!.start).toBeCloseTo(8)
  })
})

describe('trim', () => {
  it('cannot reveal source beyond the asset', () => {
    const p = trimClip(withMain(10), 'c0', 'end', 50, assets, magnet)
    expect(getClip(p, 'c0')!.duration).toBe(10)
  })

  it('lets images grow without limit', () => {
    let p = createProject()
    p = addClip(p, { ...createMediaClip(media.img, mainTrack(p).id, 0), id: 'i' }, magnet)
    p = trimClip(p, 'i', 'end', 42, assets, magnet)
    expect(getClip(p, 'i')!.duration).toBe(42)
  })

  it('stops an overlay clip at its neighbour', () => {
    let p = createProject()
    const overlay = { ...createMediaClip(media.b, 'missing', 0), id: 'o1' }
    p = addClip(p, { ...overlay, trackId: mainTrack(p).id }, free)
    p = addClip(p, { ...createMediaClip(media.b, mainTrack(p).id, 0), id: 'o2' }, free)
    // o2 collided with o1 at 0 so it went to a new overlay track.
    expect(getClip(p, 'o2')!.trackId).not.toBe(getClip(p, 'o1')!.trackId)
  })
})

describe('split', () => {
  it('splits media into contiguous pieces with continuous source', () => {
    const { project, rightId } = splitClip(withMain(10), 'c0', 4, magnet)
    const left = getClip(project, 'c0') as MediaClip
    const right = getClip(project, rightId!) as MediaClip
    expect([left.start, left.duration]).toEqual([0, 4])
    expect([right.start, right.duration, right.sourceIn]).toEqual([4, 6, 4])
  })

  it('moves the outgoing transition and fades to the correct side', () => {
    let p = withMain(10, 6)
    p = setTransition(p, 'c0', { name: 'dissolve', duration: 1 }, magnet)
    p = { ...p, clips: p.clips.map((c) => (c.id === 'c0' ? { ...(c as MediaClip), fadeIn: 1, fadeOut: 1 } : c)) }
    const { project, rightId } = splitClip(p, 'c0', 5, magnet)
    const left = getClip(project, 'c0') as MediaClip
    const right = getClip(project, rightId!) as MediaClip
    expect(left.transitionOut).toBeNull()
    expect(right.transitionOut?.name).toBe('dissolve')
    expect([left.fadeIn, left.fadeOut, right.fadeIn, right.fadeOut]).toEqual([1, 0, 0, 1])
  })

  it('refuses to create pieces shorter than the minimum', () => {
    const { rightId } = splitClip(withMain(10), 'c0', 0.05, magnet)
    expect(rightId).toBeNull()
  })

  it('splits caption words between the halves', () => {
    let p = createProject()
    const words = [
      { text: 'hello', start: 0, end: 0.5 },
      { text: 'there', start: 0.6, end: 1 },
      { text: 'friend', start: 1.6, end: 2 },
    ]
    const caption: TextClip = { ...createTextClip('x', 0, 'hello there friend'), id: 't', isCaption: true, words }
    p = addClip(p, caption, magnet)
    const { project, rightId } = splitClip(p, 't', 1.5, magnet)
    expect((getClip(project, 't') as TextClip).text).toBe('hello there')
    const right = getClip(project, rightId!) as TextClip
    expect(right.text).toBe('friend')
    expect(right.words![0].start).toBeCloseTo(0.1)
  })
})

describe('speed', () => {
  it('halves duration at 2x and keeps source span', () => {
    const p = setClipSpeed(withMain(10, 6), 'c0', 2, assets, magnet)
    expect(getClip(p, 'c0')!.duration).toBe(5)
    expect(getClip(p, 'c1')!.start).toBe(5)
  })

  it('scales keyframe times with the new speed', () => {
    let p = withMain(10)
    p = { ...p, clips: p.clips.map((c) => ({ ...c, keyframes: withKeyframe({}, 'opacity', 8, 0) })) }
    p = setClipSpeed(p, 'c0', 2, assets, magnet)
    expect(getClip(p, 'c0')!.keyframes.opacity![0].t).toBe(4)
  })
})

describe('transitions', () => {
  it('are only allowed between adjacent clips and are capped by clip length', () => {
    let p = withMain(10, 6)
    p = setTransition(p, 'c1', { name: 'dissolve', duration: 1 }, magnet)
    expect((getClip(p, 'c1') as MediaClip).transitionOut).toBeNull()
    p = setTransition(p, 'c0', { name: 'dissolve', duration: 9 }, magnet)
    expect((getClip(p, 'c0') as MediaClip).transitionOut?.duration).toBe(2)
  })

  it('are dropped when the neighbour is deleted', () => {
    let p = setTransition(withMain(10, 6), 'c0', { name: 'push', duration: 1 }, magnet)
    p = deleteClips(p, ['c1'], magnet)
    expect((getClip(p, 'c0') as MediaClip).transitionOut).toBeNull()
  })
})

describe('duplicate', () => {
  it('inserts the copy right after the original on the main track', () => {
    const { project, newId } = duplicateClip(withMain(10, 6), 'c0', magnet)
    expect(getClip(project, newId!)!.start).toBe(10)
    expect(getClip(project, 'c1')!.start).toBe(20)
    expect(clipEnd(getClip(project, 'c1')!)).toBe(26)
  })
})

describe('snap', () => {
  it('snaps within threshold to the nearest point', () => {
    expect(snapTime(4.96, [0, 5, 10], 0.1)).toEqual({ t: 5, snappedTo: 5 })
    expect(snapTime(4.5, [0, 5, 10], 0.1).snappedTo).toBeNull()
  })
})

describe('keyframes', () => {
  it('interpolates with the left keyframe easing and holds outside the range', () => {
    const kfs = [
      { t: 0, v: 0, ease: 'linear' as const },
      { t: 2, v: 10, ease: 'linear' as const },
    ]
    expect(valueAt(kfs, -1, 99)).toBe(0)
    expect(valueAt(kfs, 1, 99)).toBe(5)
    expect(valueAt(kfs, 3, 99)).toBe(10)
    expect(valueAt(undefined, 1, 7)).toBe(7)
  })

  it('partitions with a continuous boundary value', () => {
    const kf = withKeyframe(withKeyframe({}, 'scale', 0, 1), 'scale', 4, 2)
    const [left, right] = partitionKeyframes(kf, 2)
    expect(valueAt(left.scale, 2, 0)).toBeCloseTo(1.5)
    expect(valueAt(right.scale, 0, 0)).toBeCloseTo(1.5)
    expect(valueAt(right.scale, 2, 0)).toBeCloseTo(2)
  })
})
