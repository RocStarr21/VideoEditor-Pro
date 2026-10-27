import { describe, expect, it } from 'vitest'
import { createProject, createTextClip } from './defaults'
import { addScene, deleteScene, duplicateScene, moveScene, normalizeScenes, renameScene, sceneList, switchScene } from './scenes'
import type { Project } from './types'

const withClip = (p: Project, text: string) => {
  const track = p.tracks.find((t) => t.kind === 'text') ?? p.tracks[0]
  return { ...p, clips: [...p.clips, createTextClip(track.id, 0, text)] }
}

describe('scenes', () => {
  it('wraps a legacy project in a single scene', () => {
    const legacy = { ...createProject(), scene: undefined, otherScenes: undefined } as Project
    const p = normalizeScenes(legacy)
    expect(p.scene?.name).toBe('Scene 1')
    expect(sceneList(p)).toHaveLength(1)
  })

  it('adds an empty scene after the open one and switches to it', () => {
    const p = withClip(createProject(), 'first')
    const q = addScene(p)
    expect(sceneList(q).map((s) => s.name)).toEqual(['Scene 1', 'Scene 2'])
    expect(q.scene?.name).toBe('Scene 2')
    expect(q.clips).toHaveLength(0)
    expect(q.otherScenes?.[0].clips.map((c) => c.type === 'text' && c.text)).toEqual(['first'])
  })

  it('switching parks the open timeline and restores the other one intact', () => {
    let p = withClip(createProject(), 'A')
    const first = p.scene!.id
    p = addScene(p)
    p = withClip(p, 'B')
    p = switchScene(p, first)
    expect(p.clips.map((c) => c.type === 'text' && c.text)).toEqual(['A'])
    expect(p.otherScenes?.[0].clips.map((c) => c.type === 'text' && c.text)).toEqual(['B'])
    expect(switchScene(p, first)).toBe(p)
    expect(switchScene(p, 'missing')).toBe(p)
  })

  it('duplicates with its clips, renames and reorders', () => {
    let p = withClip(createProject(), 'A')
    p = duplicateScene(p, p.scene!.id)
    expect(p.scene?.name).toBe('Scene 1 copy')
    expect(p.clips).toHaveLength(1)
    expect(p.clips[0].id).not.toBe(p.otherScenes![0].clips[0].id)
    p = renameScene(p, p.scene!.id, '  Intro ')
    expect(p.scene?.name).toBe('Intro')
    expect(sceneList(p).map((s) => s.name)).toEqual(['Scene 1', 'Intro'])
    p = moveScene(p, p.scene!.id, -1)
    expect(sceneList(p).map((s) => s.name)).toEqual(['Intro', 'Scene 1'])
    expect(moveScene(p, p.scene!.id, -1)).toBe(p)
  })

  it('deleting the open scene opens a neighbour, and the last scene cannot go', () => {
    let p = createProject()
    expect(deleteScene(p, p.scene!.id)).toBe(p)
    p = addScene(p)
    const second = p.scene!.id
    p = deleteScene(p, second)
    expect(sceneList(p)).toHaveLength(1)
    expect(p.scene?.name).toBe('Scene 1')
  })
})
