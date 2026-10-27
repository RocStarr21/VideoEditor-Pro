import { describe, expect, it } from 'vitest'
import { createProject, createTextClip, createTrack } from './defaults'
import { clipEnd, deleteClips, moveClips, rippleShift, trimClip } from './timeline'
import type { Project } from './types'

/** Three text clips on one overlay track: [0,2) [3,5) [6,8). */
function fixture() {
  const p = createProject()
  const text = createTrack('text')
  const a = createTextClip(text.id, 0, 'a')
  const b = createTextClip(text.id, 3, 'b')
  const c = createTextClip(text.id, 6, 'c')
  a.duration = b.duration = c.duration = 2
  const project: Project = { ...p, tracks: [...p.tracks, text], clips: [a, b, c] }
  return { project, text, a, b, c }
}

const starts = (p: Project, ids: string[]) => ids.map((id) => p.clips.find((c) => c.id === id)?.start)

describe('ripple editing', () => {
  it('rippleShift moves later clips left without overlapping the one before', () => {
    const { project, text, a, b, c } = fixture()
    const shifted = rippleShift(project, text.id, 3, 2)
    expect(starts(shifted, [a.id, b.id, c.id])).toEqual([0, 2, 4])
    const clamped = rippleShift(project, text.id, 3, 5)
    expect(starts(clamped, [a.id, b.id, c.id])).toEqual([0, 2, 4])
  })

  it('deleting with ripple on closes the hole; off leaves a gap', () => {
    const { project, a, b, c } = fixture()
    const rippled = deleteClips(project, [b.id], { magnet: true, ripple: true })
    expect(starts(rippled, [a.id, c.id])).toEqual([0, 4])
    const plain = deleteClips(project, [b.id], { magnet: true })
    expect(starts(plain, [a.id, c.id])).toEqual([0, 6])
  })

  it('trimming with ripple pulls following clips along', () => {
    const { project, a, b, c } = fixture()
    const shorter = trimClip(project, a.id, 'end', 1, {}, { magnet: true, ripple: true })
    expect(starts(shorter, [a.id, b.id, c.id])).toEqual([0, 2, 5])
    const fromStart = trimClip(project, b.id, 'start', 4, {}, { magnet: true, ripple: true })
    const bb = fromStart.clips.find((x) => x.id === b.id)!
    expect(bb.start).toBe(3)
    expect(bb.duration).toBe(1)
    expect(starts(fromStart, [c.id])).toEqual([5])
  })

  it('moves a multi-selection together and refuses collisions', () => {
    const { project, a, b, c } = fixture()
    const moved = moveClips(project, [a.id, b.id], 0.5, { magnet: true })
    expect(starts(moved, [a.id, b.id, c.id])).toEqual([0.5, 3.5, 6])
    expect(moveClips(project, [a.id, b.id], 2, { magnet: true })).toBe(project)
    const touching = moveClips(project, [b.id, c.id], -1, { magnet: true })
    expect(starts(touching, [a.id, b.id, c.id])).toEqual([0, 2, 5])
    expect(clipEnd(touching.clips.find((x) => x.id === b.id)!)).toBe(4)
    expect(moveClips(project, [b.id, c.id], -10, { magnet: true })).toBe(project)
    expect(moveClips(project, [a.id, b.id], -5, { magnet: true })).toBe(project)
  })
})
