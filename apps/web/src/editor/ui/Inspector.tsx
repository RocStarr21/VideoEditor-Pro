import { Bold, ClipboardPaste, Copy, Eraser, FlipHorizontal2, FlipVertical2, Italic, PenTool, Pencil, Pipette, RotateCcw, RotateCw, TextAlignCenter, TextAlignEnd, TextAlignStart, Trash2, Underline } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { keyframeIndexNear, propValue } from '../model/keyframes'
import {
  ANIMATIONS,
  BLEND_MODES,
  CANVAS_RATIOS,
  CAPTION_PRESETS,
  EFFECTS,
  FPS_PRESETS,
  GUIDES,
  LOOP_ANIMATIONS,
  LOUDNESS_TARGETS,
  MARKER_COLORS,
  MASK_SHAPES,
  SHAPES,
  SPEED_PRESETS,
  TRANSITIONS,
  VOICE_EFFECTS,
  defaultChroma,
  defaultMask,
  fullCrop,
  neutralAdjust,
} from '../model/defaults'
import { getClip, nextAdjacent } from '../model/timeline'
import type { Adjust, AnimationName, Clip, EffectClip, KeyframeProp, LoopAnimationName, MediaClip, Project, ShapeClip, TextClip, TextStyle, TransitionName } from '../model/types'
import {
  applyStyleToAllCaptions,
  clearBeats,
  clearKeyframes,
  clearMaskPath,
  copyKeyframes,
  deleteSelected,
  detectBeatsOnSelected,
  duplicateSelected,
  extractAudio,
  hasCopiedKeyframes,
  normalizeLoudness,
  pasteKeyframes,
  previewClipById,
  reattachAudio,
  removeKeyframeAt,
  removeMarker,
  removeTransition,
  renameProject,
  seek,
  setBackgroundImage,
  setCanvasBackground,
  setCanvasRatio,
  setCanvasSize,
  setFps,
  setGuide,
  setKeyframeEase,
  setKeyframeable,
  setMaskDrawing,
  setSpeed,
  startTextEdit,
  toggleExpandedKeyframes,
  toggleKeyframe,
  updateClipById,
  updateMarker,
} from '../state/actions'
import { useEditor } from '../state/store'
import { Button, ColorInput, KeyframeButton, NumberField, Row, Section, Segmented, Select, Slider, Toggle, cx, formatDuration, formatTimecode } from './controls'
import { CurveEditor } from './CurveEditor'
import { FontPicker } from './FontPicker'

/** Everything that can carry keyframes. */
type Keyable = Exclude<Clip, { type: 'effect' }>
type Maskable = MediaClip | ShapeClip

export function Inspector() {
  const project = useEditor((s) => s.project)
  const selection = useEditor((s) => s.selection)
  const clip = selection.length === 1 ? getClip(project, selection[0]) : undefined

  return (
    <div className="ve-scroll flex h-full min-h-0 flex-col overflow-y-auto bg-[#14171d]">
      {selection.length > 1 ? (
        <MultiInspector count={selection.length} />
      ) : !clip ? (
        <ProjectSettings project={project} />
      ) : clip.type === 'text' ? (
        <TextInspector clip={clip} />
      ) : clip.type === 'effect' ? (
        <EffectInspector clip={clip} />
      ) : clip.type === 'shape' ? (
        <ShapeInspector clip={clip} project={project} />
      ) : (
        <MediaInspector clip={clip} project={project} />
      )}
    </div>
  )
}

function MultiInspector({ count }: { count: number }) {
  return (
    <>
      <div className="border-b border-white/[0.06] px-4 py-3">
        <p className="text-sm font-semibold text-white">{count} clips selected</p>
        <p className="text-[11px] text-zinc-500">Drag any of them to move the group; select one clip to edit its properties.</p>
      </div>
      <Section title="Group">
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" onClick={duplicateSelected}>
            <Copy size={13} /> Duplicate
          </Button>
          <Button variant="outline" onClick={() => pasteKeyframes()} disabled={!hasCopiedKeyframes()} title="Paste copied keyframes onto every selected clip">
            <ClipboardPaste size={13} /> Paste keyframes
          </Button>
          <Button variant="danger" onClick={deleteSelected}>
            <Trash2 size={13} /> Delete
          </Button>
        </div>
      </Section>
    </>
  )
}

function Tabs<T extends string>({ value, options, onChange }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void }) {
  return (
    <div className="sticky top-0 z-10 flex flex-wrap gap-x-0.5 border-b border-white/[0.06] bg-[#14171d] px-2 pt-2">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          className={cx('border-b-2 px-1.5 pb-2 text-xs font-medium', o.value === value ? 'border-blue-400 text-white' : 'border-transparent text-zinc-400 hover:text-zinc-200')}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

// ── Keyframeable property row ───────────────────────────────────────────────

function KeyedSlider({
  clip,
  prop,
  label,
  min,
  max,
  step = 1,
  base,
  display = (v) => v,
  parse = (v) => v,
  suffix,
}: {
  clip: Keyable
  prop: KeyframeProp
  label: string
  min: number
  max: number
  step?: number
  base: number
  display?: (v: number) => number
  parse?: (v: number) => number
  suffix?: string
}) {
  const playhead = useEditor((s) => s.playhead)
  const local = playhead - clip.start
  const value = propValue(clip, prop, local, base)
  const list = clip.keyframes[prop]
  const atKey = keyframeIndexNear(list, local) >= 0
  return (
    <Row label={label}>
      <Slider
        value={display(value)}
        min={min}
        max={max}
        step={step}
        suffix={suffix}
        onLive={(v) => setKeyframeable(clip.id, prop, parse(v), true)}
        onChange={(v) => setKeyframeable(clip.id, prop, parse(v))}
      />
      <KeyframeButton active={atKey} keyed={!!list?.length} onClick={() => toggleKeyframe(clip.id, prop)} />
    </Row>
  )
}

function TransformSection({ clip, project }: { clip: Keyable; project: Project }) {
  const assets = useEditor((s) => s.assets)
  const fillScale = () => {
    if (clip.type === 'text' || clip.type === 'shape') return 1
    const a = assets[clip.assetId]
    if (!a?.width) return 1
    const w = clip.crop.w * a.width
    const h = clip.crop.h * a.height
    const fit = Math.min(project.canvas.width / w, project.canvas.height / h)
    const fill = Math.max(project.canvas.width / w, project.canvas.height / h)
    return fill / fit
  }
  const setTransform = (patch: Partial<Keyable['transform']>) => updateClipById<Keyable>(clip.id, (c) => ({ ...c, transform: { ...c.transform, ...patch } }) as Keyable)
  return (
    <Section
      title="Transform"
      right={
        <Button onClick={() => updateClipById<Keyable>(clip.id, (c) => ({ ...c, transform: { x: 0, y: 0, scale: 1, scaleX: 1, scaleY: 1, rotation: 0, flipH: false, flipV: false }, opacity: 1, keyframes: {} }) as Keyable)}>
          Reset
        </Button>
      }
    >
      <KeyedSlider clip={clip} prop="scale" label="Scale" min={1} max={500} base={clip.transform.scale} display={(v) => Math.round(v * 100)} parse={(v) => v / 100} suffix="%" />
      <KeyedSlider clip={clip} prop="scaleX" label="Width" min={1} max={500} base={clip.transform.scaleX ?? 1} display={(v) => Math.round(v * 100)} parse={(v) => v / 100} suffix="%" />
      <KeyedSlider clip={clip} prop="scaleY" label="Height" min={1} max={500} base={clip.transform.scaleY ?? 1} display={(v) => Math.round(v * 100)} parse={(v) => v / 100} suffix="%" />
      <KeyedSlider clip={clip} prop="x" label="Position X" min={-project.canvas.width} max={project.canvas.width} base={clip.transform.x} />
      <KeyedSlider clip={clip} prop="y" label="Position Y" min={-project.canvas.height} max={project.canvas.height} base={clip.transform.y} />
      <KeyedSlider clip={clip} prop="rotation" label="Rotation" min={-360} max={360} base={clip.transform.rotation} suffix="°" />
      <KeyedSlider clip={clip} prop="opacity" label="Opacity" min={0} max={100} base={clip.opacity} display={(v) => Math.round(v * 100)} parse={(v) => v / 100} suffix="%" />
      <div className="flex flex-wrap gap-1">
        <Button variant="outline" onClick={() => setTransform({ rotation: clip.transform.rotation - 90 })} title="Rotate left">
          <RotateCcw size={13} />
        </Button>
        <Button variant="outline" onClick={() => setTransform({ rotation: clip.transform.rotation + 90 })} title="Rotate right">
          <RotateCw size={13} />
        </Button>
        <Button variant="outline" onClick={() => setTransform({ flipH: !clip.transform.flipH })} title="Mirror">
          <FlipHorizontal2 size={13} />
        </Button>
        <Button variant="outline" onClick={() => setTransform({ flipV: !clip.transform.flipV })} title="Flip vertically">
          <FlipVertical2 size={13} />
        </Button>
        {clip.type !== 'text' && clip.type !== 'shape' && (
          <>
            <Button variant="outline" onClick={() => setTransform({ scale: 1, scaleX: 1, scaleY: 1, x: 0, y: 0 })}>
              Fit
            </Button>
            <Button variant="outline" onClick={() => setTransform({ scale: fillScale(), scaleX: 1, scaleY: 1, x: 0, y: 0 })}>
              Fill
            </Button>
          </>
        )}
      </div>
    </Section>
  )
}

// ── Keyframes: graph editor, clipboard, lanes ───────────────────────────────

const PROP_LABELS: Record<KeyframeProp, string> = { x: 'Position X', y: 'Position Y', scale: 'Scale', scaleX: 'Width', scaleY: 'Height', rotation: 'Rotation', opacity: 'Opacity', volume: 'Volume' }

function KeyframesSection({ clip }: { clip: Keyable }) {
  const playhead = useEditor((s) => s.playhead)
  const expanded = useEditor((s) => s.expandedKeyframes.includes(clip.id))
  const props = (Object.keys(clip.keyframes) as KeyframeProp[]).filter((p) => clip.keyframes[p]?.length)
  const [chosenProp, setChosenProp] = useState<KeyframeProp | null>(null)
  const [chosenIdx, setChosenIdx] = useState<number | null>(null)
  const prop = chosenProp && props.includes(chosenProp) ? chosenProp : props[0]
  const list = prop ? clip.keyframes[prop] ?? [] : []
  const local = playhead - clip.start
  // Default to the keyframe whose segment the playhead is in.
  const auto = Math.max(0, list.findIndex((k, i) => local >= k.t && (i === list.length - 1 || local < list[i + 1].t)))
  const idx = chosenIdx !== null && chosenIdx < list.length ? chosenIdx : auto
  const key = list[idx]
  const hasNext = idx < list.length - 1

  return (
    <>
      <Section title="Keyframes">
        {!props.length ? (
          <p className="text-[11px] leading-5 text-zinc-500">Click the ◇ next to any property to set a keyframe at the playhead. Add a second one elsewhere and the value animates between them.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1">
              {props.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => {
                    setChosenProp(p)
                    setChosenIdx(null)
                  }}
                  className={cx('rounded-md border px-2 py-0.5 text-[11px]', p === prop ? 'border-blue-400 bg-blue-500/15 text-white' : 'border-white/10 text-zinc-300 hover:bg-white/5')}
                >
                  {PROP_LABELS[p]} · {clip.keyframes[p]!.length}
                </button>
              ))}
            </div>
            <div className="flex flex-wrap gap-1">
              {list.map((k, i) => (
                <button
                  key={`${k.t}-${i}`}
                  type="button"
                  title="Jump to this keyframe"
                  onClick={() => {
                    setChosenIdx(i)
                    seek(clip.start + k.t)
                  }}
                  className={cx('rounded border px-1.5 py-0.5 font-mono text-[10px]', i === idx ? 'border-white bg-white/10 text-white' : 'border-white/10 text-zinc-400 hover:bg-white/5')}
                >
                  ◆ {k.t.toFixed(2)}s
                </button>
              ))}
            </div>
            {key && prop && (
              <>
                <Row label="Value">
                  <span className="text-xs text-zinc-200">
                    {prop === 'opacity' || prop === 'scale' || prop === 'scaleX' || prop === 'scaleY' ? `${Math.round(key.v * 100)}%` : prop === 'volume' ? `${Math.round(key.v * 100)}%` : `${Math.round(key.v * 10) / 10}${prop === 'rotation' ? '°' : ''}`}
                  </span>
                  <Button variant="danger" onClick={() => removeKeyframeAt(clip.id, prop, key.t)} title="Delete this keyframe">
                    <Trash2 size={12} />
                  </Button>
                </Row>
                {hasNext ? (
                  <>
                    <p className="text-[11px] text-zinc-500">Curve from this keyframe to the next — drag the handles or pick a preset.</p>
                    <CurveEditor value={key.ease} onChange={(ease) => setKeyframeEase(clip.id, prop, key.t, ease, true)} onCommit={(ease) => setKeyframeEase(clip.id, prop, key.t, ease)} />
                  </>
                ) : (
                  <p className="text-[11px] text-zinc-500">This is the last keyframe; the value holds from here.</p>
                )}
              </>
            )}
          </>
        )}
        <div className="flex flex-wrap gap-1">
          <Button variant="outline" onClick={() => copyKeyframes(clip.id)} disabled={!props.length} title="Copy every keyframe on this clip">
            <Copy size={13} /> Copy
          </Button>
          <Button variant="outline" onClick={() => pasteKeyframes([clip.id])} disabled={!hasCopiedKeyframes()} title="Paste copied keyframes, stretched to this clip's length">
            <ClipboardPaste size={13} /> Paste
          </Button>
          <Button variant="outline" onClick={() => toggleExpandedKeyframes(clip.id)} title="Show one timeline lane per animated property">
            {expanded ? 'Hide lanes' : 'Show lanes'}
          </Button>
          {prop && (
            <Button variant="danger" onClick={() => clearKeyframes(clip.id, prop)}>
              Clear {PROP_LABELS[prop]}
            </Button>
          )}
        </div>
      </Section>
    </>
  )
}

// ── Media clips ─────────────────────────────────────────────────────────────

type MediaTab = 'video' | 'audio' | 'speed' | 'animation' | 'adjust' | 'keyframes'

function MediaInspector({ clip, project }: { clip: MediaClip; project: Project }) {
  const asset = useEditor((s) => s.assets[clip.assetId])
  const isVisual = clip.type !== 'audio'
  const hasAudio = clip.type === 'audio' || !!asset?.hasAudio
  const tabs: Array<{ value: MediaTab; label: string }> = []
  if (isVisual) tabs.push({ value: 'video', label: clip.type === 'image' ? 'Image' : 'Video' })
  if (hasAudio) tabs.push({ value: 'audio', label: 'Audio' })
  if (clip.type !== 'image') tabs.push({ value: 'speed', label: 'Speed' })
  if (isVisual) tabs.push({ value: 'animation', label: 'Animation' }, { value: 'adjust', label: 'Adjust' })
  tabs.push({ value: 'keyframes', label: 'Keyframes' })
  const [tab, setTab] = useState<MediaTab>(tabs[0].value)
  const current = tabs.some((t) => t.value === tab) ? tab : tabs[0].value

  return (
    <>
      <ClipHeader clip={clip} subtitle={asset ? `${asset.width ? `${asset.width}×${asset.height} · ` : ''}${formatDuration(clip.duration)}` : formatDuration(clip.duration)} />
      <Tabs value={current} options={tabs} onChange={setTab} />
      {current === 'video' && (
        <>
          <TransformSection clip={clip} project={project} />
          <BlendSection clip={clip} />
          <TransitionSection clip={clip} project={project} />
          <CropSection clip={clip} />
          <MaskSection clip={clip} />
          <ChromaSection clip={clip} />
          <Section title="Remove background">
            <Row label="AI cutout" hint="Removes the background behind people using an on-device segmentation model">
              <Toggle checked={clip.removeBackground} onChange={(v) => updateClipById<MediaClip>(clip.id, (c) => ({ ...c, removeBackground: v }))} />
              <span className="text-[11px] text-zinc-500">Best for people on camera</span>
            </Row>
          </Section>
        </>
      )}
      {current === 'audio' && <AudioSection clip={clip} />}
      {current === 'speed' && <SpeedSection clip={clip} />}
      {current === 'animation' && <AnimationSection clip={clip} />}
      {current === 'adjust' && <AdjustSection target={clip} />}
      {current === 'keyframes' && <KeyframesSection clip={clip} />}
    </>
  )
}

function ClipHeader({ clip, subtitle }: { clip: Clip; subtitle: string }) {
  return (
    <div className="border-b border-white/[0.06] px-4 py-3">
      <input
        value={clip.name}
        onChange={(e) => updateClipById(clip.id, (c) => ({ ...c, name: e.target.value }))}
        onKeyDown={(e) => e.stopPropagation()}
        className="w-full truncate bg-transparent text-sm font-semibold text-white outline-none focus:underline"
      />
      <p className="mt-0.5 text-[11px] text-zinc-500">
        {subtitle} · starts {formatTimecode(clip.start)}
      </p>
    </div>
  )
}

function BlendSection({ clip }: { clip: Maskable }) {
  return (
    <Section title="Blend">
      <Row label="Mode">
        <Select value={clip.blend} options={BLEND_MODES.map((b) => ({ value: b.id, label: b.label }))} onChange={(blend) => updateClipById<Maskable>(clip.id, (c) => ({ ...c, blend }))} />
      </Row>
    </Section>
  )
}

function TransitionSection({ clip, project }: { clip: MediaClip; project: Project }) {
  const next = nextAdjacent(project, clip)
  if (!clip.transitionOut && !next) return null
  const t = clip.transitionOut
  return (
    <Section title="Transition to next clip">
      {!next ? (
        <p className="text-xs text-zinc-500">The next clip was moved away; this transition will be removed.</p>
      ) : (
        <>
          <Row label="Type">
            <Select
              value={(t?.name ?? 'none') as TransitionName | 'none'}
              options={[{ value: 'none', label: 'None' }, ...TRANSITIONS.map((x) => ({ value: x.id, label: x.label }))]}
              onChange={(name) =>
                name === 'none'
                  ? removeTransition(clip.id)
                  : updateClipById<MediaClip>(clip.id, (c) => ({ ...c, transitionOut: { name, duration: c.transitionOut?.duration ?? 0.5 } }))
              }
            />
          </Row>
          {t && (
            <Row label="Duration">
              <Slider
                value={t.duration}
                min={0.1}
                max={Math.min(2, clip.duration / 2)}
                step={0.1}
                suffix="s"
                onLive={(v) => previewClipById<MediaClip>(clip.id, (c) => ({ ...c, transitionOut: c.transitionOut ? { ...c.transitionOut, duration: v } : null }))}
                onChange={(v) => updateClipById<MediaClip>(clip.id, (c) => ({ ...c, transitionOut: c.transitionOut ? { ...c.transitionOut, duration: v } : null }))}
              />
            </Row>
          )}
        </>
      )}
    </Section>
  )
}

const CROP_RATIOS = [
  { value: 'free', label: 'Free' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '1:1', label: '1:1' },
  { value: '4:3', label: '4:3' },
  { value: '4:5', label: '4:5' },
]

function CropSection({ clip }: { clip: MediaClip }) {
  const asset = useEditor((s) => s.assets[clip.assetId])
  const set = (patch: Partial<MediaClip['crop']>, live = false) => {
    const fn = (c: MediaClip) => {
      const crop = { ...c.crop, ...patch }
      crop.w = Math.min(1, Math.max(0.05, crop.w))
      crop.h = Math.min(1, Math.max(0.05, crop.h))
      crop.x = Math.min(1 - crop.w, Math.max(0, crop.x))
      crop.y = Math.min(1 - crop.h, Math.max(0, crop.y))
      return { ...c, crop }
    }
    if (live) previewClipById<MediaClip>(clip.id, fn)
    else updateClipById<MediaClip>(clip.id, fn)
  }
  const applyRatio = (id: string) => {
    if (id === 'free' || !asset?.width) return
    const [a, b] = id.split(':').map(Number)
    const target = a / b
    const src = asset.width / asset.height
    // Largest centred rectangle of the target ratio inside the source.
    const w = target > src ? 1 : target / src
    const h = target > src ? src / target : 1
    updateClipById<MediaClip>(clip.id, (c) => ({ ...c, crop: { x: (1 - w) / 2, y: (1 - h) / 2, w, h } }))
  }
  const c = clip.crop
  return (
    <Section title="Crop" defaultOpen={false} right={<Button onClick={() => updateClipById<MediaClip>(clip.id, (x) => ({ ...x, crop: fullCrop() }))}>Reset</Button>}>
      <Segmented value="free" options={CROP_RATIOS} onChange={applyRatio} size="xs" />
      <Row label="Left">
        <Slider value={Math.round(c.x * 100)} min={0} max={95} suffix="%" onLive={(v) => set({ x: v / 100 }, true)} onChange={(v) => set({ x: v / 100 })} />
      </Row>
      <Row label="Top">
        <Slider value={Math.round(c.y * 100)} min={0} max={95} suffix="%" onLive={(v) => set({ y: v / 100 }, true)} onChange={(v) => set({ y: v / 100 })} />
      </Row>
      <Row label="Width">
        <Slider value={Math.round(c.w * 100)} min={5} max={100} suffix="%" onLive={(v) => set({ w: v / 100 }, true)} onChange={(v) => set({ w: v / 100 })} />
      </Row>
      <Row label="Height">
        <Slider value={Math.round(c.h * 100)} min={5} max={100} suffix="%" onLive={(v) => set({ h: v / 100 }, true)} onChange={(v) => set({ h: v / 100 })} />
      </Row>
    </Section>
  )
}

const SIZED_MASKS = new Set(['circle', 'rectangle', 'mirror', 'diamond', 'text', 'heart', 'star'])

function MaskSection({ clip }: { clip: Maskable }) {
  const m = clip.mask
  const drawing = useEditor((s) => s.maskDrawing)
  const set = (patch: Partial<Maskable['mask']>, live = false) => {
    const fn = (c: Maskable) => ({ ...c, mask: { ...c.mask, ...patch } })
    if (live) previewClipById<Maskable>(clip.id, fn)
    else updateClipById<Maskable>(clip.id, fn)
  }
  const points = m.path?.length ?? 0
  return (
    <Section
      title="Mask"
      defaultOpen={m.shape !== 'none'}
      right={
        m.shape !== 'none' ? (
          <Button
            onClick={() => {
              setMaskDrawing(false)
              set(defaultMask())
            }}
          >
            Reset
          </Button>
        ) : undefined
      }
    >
      <div className="grid grid-cols-5 gap-1">
        {MASK_SHAPES.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => {
              set({ shape: s.id })
              setMaskDrawing(s.id === 'freeform' && !(m.path?.length ?? 0))
            }}
            className={cx('rounded-md border px-1 py-1.5 text-[11px]', m.shape === s.id ? 'border-blue-400 bg-blue-500/15 text-white' : 'border-white/10 text-zinc-300 hover:bg-white/5')}
          >
            {s.label}
          </button>
        ))}
      </div>
      {m.shape === 'freeform' && (
        <>
          <div className="flex flex-wrap items-center gap-1">
            <Button variant={drawing ? 'primary' : 'outline'} onClick={() => setMaskDrawing(!drawing)} title="Click on the preview to add points; drag points to adjust">
              <PenTool size={13} /> {drawing ? 'Drawing… click the preview' : 'Draw points'}
            </Button>
            <Button variant="outline" onClick={() => clearMaskPath(clip.id)} disabled={!points}>
              <Eraser size={13} /> Clear
            </Button>
          </div>
          <p className="text-[11px] text-zinc-500">{points < 3 ? `${points} of at least 3 points — click on the preview to add more.` : `${points} points. Drag a point on the preview to reshape; Esc stops drawing.`}</p>
        </>
      )}
      {m.shape === 'text' && (
        <>
          <Row label="Text">
            <input
              value={m.text ?? ''}
              onChange={(e) => set({ text: e.target.value })}
              onKeyDown={(e) => e.stopPropagation()}
              className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
            />
          </Row>
          <Row label="Font">
            <FontPicker value={m.fontFamily ?? 'Anton'} onChange={(fontFamily) => set({ fontFamily })} />
          </Row>
        </>
      )}
      {m.shape !== 'none' && (
        <>
          {m.shape !== 'freeform' && (
            <>
              <Row label="Position X">
                <Slider value={Math.round(m.x * 100)} min={-100} max={100} suffix="%" onLive={(v) => set({ x: v / 100 }, true)} onChange={(v) => set({ x: v / 100 })} />
              </Row>
              <Row label="Position Y">
                <Slider value={Math.round(m.y * 100)} min={-100} max={100} suffix="%" onLive={(v) => set({ y: v / 100 }, true)} onChange={(v) => set({ y: v / 100 })} />
              </Row>
              {m.shape !== 'linear' && (
                <Row label={m.shape === 'mirror' ? 'Band size' : 'Width'}>
                  <Slider value={Math.round(m.width * 100)} min={2} max={200} suffix="%" onLive={(v) => set({ width: v / 100 }, true)} onChange={(v) => set({ width: v / 100 })} />
                </Row>
              )}
              {SIZED_MASKS.has(m.shape) && (
                <Row label="Height">
                  <Slider value={Math.round(m.height * 100)} min={2} max={200} suffix="%" onLive={(v) => set({ height: v / 100 }, true)} onChange={(v) => set({ height: v / 100 })} />
                </Row>
              )}
              <Row label="Rotation">
                <Slider value={m.rotation} min={-180} max={180} suffix="°" onLive={(v) => set({ rotation: v }, true)} onChange={(v) => set({ rotation: v })} />
              </Row>
            </>
          )}
          <Row label="Feather">
            <Slider value={m.feather} min={0} max={100} onLive={(v) => set({ feather: v }, true)} onChange={(v) => set({ feather: v })} />
          </Row>
          {m.shape === 'rectangle' && (
            <Row label="Round corners">
              <Slider value={m.roundness} min={0} max={100} onLive={(v) => set({ roundness: v }, true)} onChange={(v) => set({ roundness: v })} />
            </Row>
          )}
          <Row label="Outline" hint="Draws a line along the mask edge">
            <ColorInput value={m.strokeColor ?? '#ffffff'} onChange={(strokeColor) => set({ strokeColor })} />
            <NumberField value={m.strokeWidth ?? 0} min={0} max={200} onChange={(strokeWidth) => set({ strokeWidth })} onLive={(strokeWidth) => set({ strokeWidth }, true)} suffix="px" />
          </Row>
          <Row label="Invert">
            <Toggle checked={m.invert} onChange={(v) => set({ invert: v })} />
          </Row>
        </>
      )}
    </Section>
  )
}

function ChromaSection({ clip }: { clip: MediaClip }) {
  const k = clip.chroma
  const set = (patch: Partial<MediaClip['chroma']>, live = false) => {
    const fn = (c: MediaClip) => ({ ...c, chroma: { ...c.chroma, ...patch } })
    if (live) previewClipById<MediaClip>(clip.id, fn)
    else updateClipById<MediaClip>(clip.id, fn)
  }
  const eyedropper = typeof window !== 'undefined' && 'EyeDropper' in window
  const pick = async () => {
    try {
      const Ctor = (window as unknown as { EyeDropper: new () => { open: () => Promise<{ sRGBHex: string }> } }).EyeDropper
      const r = await new Ctor().open()
      set({ color: r.sRGBHex, enabled: true })
    } catch {
      // user canceled
    }
  }
  return (
    <Section title="Chroma key" defaultOpen={k.enabled} right={k.enabled ? <Button onClick={() => set(defaultChroma())}>Reset</Button> : undefined}>
      <Row label="Enable">
        <Toggle checked={k.enabled} onChange={(v) => set({ enabled: v })} />
      </Row>
      {k.enabled && (
        <>
          <Row label="Key color">
            <ColorInput value={k.color} allowAlpha={false} onChange={(color) => set({ color })} />
            {eyedropper && (
              <Button variant="outline" onClick={() => void pick()} title="Pick a color from the screen">
                <Pipette size={13} />
              </Button>
            )}
          </Row>
          <Row label="Intensity">
            <Slider value={k.intensity} min={0} max={100} onLive={(v) => set({ intensity: v }, true)} onChange={(v) => set({ intensity: v })} />
          </Row>
          <Row label="Shadow">
            <Slider value={k.shadow} min={0} max={100} onLive={(v) => set({ shadow: v }, true)} onChange={(v) => set({ shadow: v })} />
          </Row>
        </>
      )}
    </Section>
  )
}

const toDb = (g: number) => (g <= 0 ? -60 : Math.round(20 * Math.log10(g) * 10) / 10)
const fromDb = (db: number) => (db <= -60 ? 0 : 10 ** (db / 20))

function AudioSection({ clip }: { clip: MediaClip }) {
  const [target, setTarget] = useState<string>('youtube')
  const set = (patch: Partial<MediaClip>, live = false) => {
    const fn = (c: MediaClip) => ({ ...c, ...patch })
    if (live) previewClipById<MediaClip>(clip.id, fn)
    else updateClipById<MediaClip>(clip.id, fn)
  }
  const maxFade = Math.min(10, clip.duration / 2)
  return (
    <>
      <Section title="Basic">
        <KeyedSlider clip={clip} prop="volume" label="Volume" min={-60} max={12} step={0.5} base={clip.volume} display={toDb} parse={fromDb} suffix="dB" />
        <Row label="Mute">
          <Toggle checked={clip.muted} onChange={(v) => set({ muted: v })} />
        </Row>
        <Row label="Fade in">
          <Slider value={clip.fadeIn} min={0} max={maxFade} step={0.1} suffix="s" onLive={(v) => set({ fadeIn: v }, true)} onChange={(v) => set({ fadeIn: v })} />
        </Row>
        <Row label="Fade out">
          <Slider value={clip.fadeOut} min={0} max={maxFade} step={0.1} suffix="s" onLive={(v) => set({ fadeOut: v }, true)} onChange={(v) => set({ fadeOut: v })} />
        </Row>
      </Section>
      <Section title="Enhance">
        <Row label="Reduce noise" hint="AI noise reduction (RNNoise), runs on this device">
          <Toggle checked={clip.denoise} onChange={(v) => set({ denoise: v })} />
        </Row>
        <Row label="Voice effect">
          <Select value={clip.voiceEffect} options={VOICE_EFFECTS.map((v) => ({ value: v.id, label: v.label }))} onChange={(voiceEffect) => set({ voiceEffect })} />
        </Row>
        <Row label="Loudness">
          <Select value={target} options={LOUDNESS_TARGETS.map((t) => ({ value: t.id, label: t.label }))} onChange={setTarget} />
        </Row>
        <div className="flex gap-1">
          <Button variant="outline" onClick={() => void normalizeLoudness(LOUDNESS_TARGETS.find((t) => t.id === target)!.lufs, 'selected')}>
            Normalize this clip
          </Button>
          <Button variant="outline" onClick={() => void normalizeLoudness(LOUDNESS_TARGETS.find((t) => t.id === target)!.lufs, 'all')}>
            All clips
          </Button>
        </div>
      </Section>
      <Section title="Beats">
        <p className="text-[11px] text-zinc-500">{clip.beats.length ? `${clip.beats.length} beat markers — clips snap to them while dragging.` : 'Mark beats to cut and snap edits to the music.'}</p>
        <div className="flex gap-1">
          <Button variant="outline" onClick={() => void detectBeatsOnSelected()}>
            Auto beat
          </Button>
          {clip.beats.length > 0 && (
            <Button variant="danger" onClick={() => clearBeats(clip.id)}>
              Clear beats
            </Button>
          )}
        </div>
      </Section>
      {clip.type === 'video' && (
        <Section title="Separate">
          <Button variant="outline" onClick={extractAudio}>
            Detach audio to its own track
          </Button>
        </Section>
      )}
      {clip.type === 'audio' && clip.detachedFrom && (
        <Section title="Detached audio">
          <p className="text-[11px] text-zinc-500">This sound was detached from a video clip.</p>
          <Button variant="outline" onClick={() => reattachAudio(clip.id)}>
            Reattach to the video
          </Button>
        </Section>
      )}
    </>
  )
}

/** Speed slider on a log scale so 0.1x–100x spreads evenly. */
function SpeedSection({ clip }: { clip: MediaClip }) {
  const asset = useEditor((s) => s.assets[clip.assetId])
  const sourceLen = clip.duration * clip.speed
  return (
    <Section title="Speed">
      <Row label="Speed">
        <Slider
          value={Math.round(Math.log10(clip.speed) * 100) / 100}
          min={-1}
          max={2}
          step={0.01}
          format={() => `${Number(clip.speed.toFixed(2))}`}
          onChange={(v) => setSpeed(clip.id, v === Math.round(Math.log10(clip.speed) * 100) / 100 ? clip.speed : 10 ** v)}
          suffix="x"
        />
      </Row>
      <div className="flex flex-wrap gap-1">
        {SPEED_PRESETS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(clip.id, s)}
            className={cx('rounded-md border px-2 py-0.5 text-[11px]', Math.abs(clip.speed - s) < 1e-3 ? 'border-blue-400 bg-blue-500/15 text-white' : 'border-white/10 text-zinc-300 hover:bg-white/5')}
          >
            {s}x
          </button>
        ))}
      </div>
      <Row label="Duration">
        <span className="text-xs text-zinc-300">
          {formatDuration(sourceLen)} → {formatDuration(clip.duration)}
          {asset && ` (source ${formatDuration(asset.duration)})`}
        </span>
      </Row>
      <Row label="Maintain pitch" hint="On keeps voices natural at other speeds">
        <Toggle checked={clip.preservePitch} onChange={(v) => updateClipById<MediaClip>(clip.id, (c) => ({ ...c, preservePitch: v }))} />
      </Row>
    </Section>
  )
}

function AnimationSection({ clip }: { clip: Keyable }) {
  const a = clip.animation
  const isText = clip.type === 'text'
  const names = ANIMATIONS.filter((x) => !x.textOnly || isText).map((x) => ({ value: x.id, label: x.label }))
  const set = (patch: Partial<Keyable['animation']>) => updateClipById<Keyable>(clip.id, (c) => ({ ...c, animation: { ...c.animation, ...patch } }) as Keyable)
  const maxDur = Math.max(0.1, clip.duration)
  return (
    <>
      <Section title="In">
        <Row label="Animation">
          <Select value={a.in.name} options={names} onChange={(name: AnimationName) => set({ in: { ...a.in, name } })} />
        </Row>
        {a.in.name !== 'none' && (
          <Row label="Duration">
            <Slider value={a.in.duration} min={0.1} max={maxDur} step={0.1} suffix="s" onChange={(duration) => set({ in: { ...a.in, duration } })} />
          </Row>
        )}
      </Section>
      <Section title="Out">
        <Row label="Animation">
          <Select value={a.out.name} options={names} onChange={(name: AnimationName) => set({ out: { ...a.out, name } })} />
        </Row>
        {a.out.name !== 'none' && (
          <Row label="Duration">
            <Slider value={a.out.duration} min={0.1} max={maxDur} step={0.1} suffix="s" onChange={(duration) => set({ out: { ...a.out, duration } })} />
          </Row>
        )}
      </Section>
      <Section title="Loop">
        <Row label="Animation">
          <Select value={a.loop.name} options={LOOP_ANIMATIONS.map((x) => ({ value: x.id, label: x.label }))} onChange={(name: LoopAnimationName) => set({ loop: { ...a.loop, name } })} />
        </Row>
        {a.loop.name !== 'none' && (
          <Row label="Period">
            <Slider value={a.loop.period} min={0.2} max={10} step={0.1} suffix="s" onChange={(period) => set({ loop: { ...a.loop, period } })} />
          </Row>
        )}
      </Section>
    </>
  )
}

// ── Color ───────────────────────────────────────────────────────────────────

const ADJUST_ROWS: Array<{ key: keyof Adjust; label: string; min: number; max: number; group: 'Light' | 'Color' | 'Effects' }> = [
  { key: 'exposure', label: 'Exposure', min: -100, max: 100, group: 'Light' },
  { key: 'brightness', label: 'Brightness', min: -100, max: 100, group: 'Light' },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, group: 'Light' },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, group: 'Light' },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, group: 'Light' },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, group: 'Color' },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, group: 'Color' },
  { key: 'tint', label: 'Tint', min: -100, max: 100, group: 'Color' },
  { key: 'hue', label: 'Hue', min: -100, max: 100, group: 'Color' },
  { key: 'sharpen', label: 'Sharpen', min: 0, max: 100, group: 'Effects' },
  { key: 'vignette', label: 'Vignette', min: 0, max: 100, group: 'Effects' },
  { key: 'fade', label: 'Fade', min: 0, max: 100, group: 'Effects' },
  { key: 'grain', label: 'Grain', min: 0, max: 100, group: 'Effects' },
]

function AdjustSection({ target }: { target: MediaClip | EffectClip }) {
  const adjust = target.adjust ?? neutralAdjust()
  const set = (key: keyof Adjust, v: number, live = false) => {
    const fn = (c: MediaClip | EffectClip) => ({ ...c, adjust: { ...(c.adjust ?? neutralAdjust()), [key]: v } })
    if (live) previewClipById<MediaClip | EffectClip>(target.id, fn)
    else updateClipById<MediaClip | EffectClip>(target.id, fn)
  }
  return (
    <>
      <FilterSection target={target} />
      {(['Light', 'Color', 'Effects'] as const).map((group) => (
        <Section key={group} title={group} right={group === 'Light' ? <Button onClick={() => updateClipById<MediaClip | EffectClip>(target.id, (c) => ({ ...c, adjust: neutralAdjust() }))}>Reset all</Button> : undefined}>
          {ADJUST_ROWS.filter((r) => r.group === group).map((r) => (
            <Row key={r.key} label={r.label}>
              <Slider value={adjust[r.key]} min={r.min} max={r.max} onLive={(v) => set(r.key, v, true)} onChange={(v) => set(r.key, v)} />
            </Row>
          ))}
        </Section>
      ))}
    </>
  )
}

function FilterSection({ target }: { target: MediaClip | EffectClip }) {
  const assets = useEditor((s) => s.assets)
  const [presets, setPresets] = useState<Array<{ id: string; name: string }>>([])
  if (!presets.length) {
    void import('../engine/filters').then((m) => setPresets(m.FILTER_PRESETS.map((p) => ({ id: p.id, name: p.name }))))
  }
  const luts = Object.values(assets).filter((a) => a.kind === 'lut')
  const options = [
    { value: 'none', label: 'None' },
    ...presets.map((p) => ({ value: p.id, label: p.name })),
    ...luts.map((l) => ({ value: `lut:${l.id}`, label: `LUT · ${l.name}` })),
  ]
  const f = target.filter
  return (
    <Section title="Filter">
      <Row label="Look">
        <Select value={f?.id ?? 'none'} options={options} onChange={(id) => updateClipById<MediaClip | EffectClip>(target.id, (c) => ({ ...c, filter: id === 'none' ? null : { id, intensity: c.filter?.intensity ?? 100 } }))} />
      </Row>
      {f && (
        <Row label="Intensity">
          <Slider
            value={f.intensity}
            min={0}
            max={100}
            onLive={(v) => previewClipById<MediaClip | EffectClip>(target.id, (c) => ({ ...c, filter: c.filter ? { ...c.filter, intensity: v } : null }))}
            onChange={(v) => updateClipById<MediaClip | EffectClip>(target.id, (c) => ({ ...c, filter: c.filter ? { ...c.filter, intensity: v } : null }))}
          />
        </Row>
      )}
      <p className="text-[11px] text-zinc-500">Browse looks in the Filters panel, or import a .cube LUT there.</p>
    </Section>
  )
}

// ── Shapes ──────────────────────────────────────────────────────────────────

function ShapeInspector({ clip, project }: { clip: ShapeClip; project: Project }) {
  const [tab, setTab] = useState<'shape' | 'animation' | 'keyframes'>('shape')
  const set = (patch: Partial<ShapeClip>, live = false) => {
    const fn = (c: ShapeClip) => ({ ...c, ...patch })
    if (live) previewClipById<ShapeClip>(clip.id, fn)
    else updateClipById<ShapeClip>(clip.id, fn)
  }
  const maxSize = Math.max(project.canvas.width, project.canvas.height) * 2
  return (
    <>
      <ClipHeader clip={clip} subtitle={`${SHAPES.find((s) => s.id === clip.shape)?.label ?? 'Shape'} · ${formatDuration(clip.duration)}`} />
      <Tabs
        value={tab}
        options={[
          { value: 'shape', label: 'Shape' },
          { value: 'animation', label: 'Animation' },
          { value: 'keyframes', label: 'Keyframes' },
        ]}
        onChange={setTab}
      />
      {tab === 'animation' && <AnimationSection clip={clip} />}
      {tab === 'keyframes' && <KeyframesSection clip={clip} />}
      {tab === 'shape' && (
        <>
          <Section title="Shape">
            <Row label="Kind">
              <Segmented value={clip.shape} size="xs" options={SHAPES.map((s) => ({ value: s.id, label: s.label }))} onChange={(shape) => set({ shape })} />
            </Row>
            <Row label="Size">
              <NumberField value={clip.width} min={2} max={maxSize} onChange={(width) => set({ width })} onLive={(width) => set({ width }, true)} suffix="w" />
              <NumberField value={clip.height} min={2} max={maxSize} onChange={(height) => set({ height })} onLive={(height) => set({ height }, true)} suffix="h" />
              <Button variant="outline" onClick={() => set({ height: clip.width })} title="Make the height match the width">
                1:1
              </Button>
            </Row>
            <Row label="Fill">
              <ColorInput value={clip.fill} onChange={(fill) => set({ fill })} />
            </Row>
            <Row label="Stroke">
              <ColorInput value={clip.strokeColor} onChange={(strokeColor) => set({ strokeColor })} />
              <NumberField value={clip.strokeWidth} min={0} max={500} onChange={(strokeWidth) => set({ strokeWidth })} onLive={(strokeWidth) => set({ strokeWidth }, true)} suffix="px" />
            </Row>
            {clip.strokeWidth > 0 && (
              <Row label="Stroke align">
                <Segmented
                  value={clip.strokeAlign}
                  size="xs"
                  options={[
                    { value: 'inside', label: 'Inside' },
                    { value: 'center', label: 'Center' },
                    { value: 'outside', label: 'Outside' },
                  ]}
                  onChange={(strokeAlign) => set({ strokeAlign })}
                />
              </Row>
            )}
            {clip.shape === 'rectangle' && (
              <Row label="Corner radius">
                <Slider value={clip.cornerRadius} min={0} max={100} suffix="%" onLive={(v) => set({ cornerRadius: v }, true)} onChange={(v) => set({ cornerRadius: v })} />
              </Row>
            )}
            {clip.shape === 'polygon' && (
              <Row label="Sides">
                <Slider value={clip.sides} min={3} max={12} onLive={(v) => set({ sides: v }, true)} onChange={(v) => set({ sides: v })} />
              </Row>
            )}
            {clip.shape === 'star' && (
              <>
                <Row label="Points">
                  <Slider value={clip.points} min={3} max={12} onLive={(v) => set({ points: v }, true)} onChange={(v) => set({ points: v })} />
                </Row>
                <Row label="Inner radius">
                  <Slider value={Math.round(clip.innerRadius * 100)} min={5} max={95} suffix="%" onLive={(v) => set({ innerRadius: v / 100 }, true)} onChange={(v) => set({ innerRadius: v / 100 })} />
                </Row>
              </>
            )}
          </Section>
          <TransformSection clip={clip} project={project} />
          <BlendSection clip={clip} />
          <MaskSection clip={clip} />
        </>
      )}
    </>
  )
}

// ── Text ────────────────────────────────────────────────────────────────────

function TextInspector({ clip }: { clip: TextClip }) {
  const project = useEditor((s) => s.project)
  const [tab, setTab] = useState<'text' | 'animation' | 'keyframes'>('text')
  const style = clip.style
  const setStyle = (patch: Partial<TextStyle>, live = false) => {
    const fn = (c: TextClip) => ({ ...c, style: { ...c.style, ...patch } })
    if (live) previewClipById<TextClip>(clip.id, fn)
    else updateClipById<TextClip>(clip.id, fn)
  }
  return (
    <>
      <ClipHeader clip={clip} subtitle={clip.isCaption ? 'Caption' : clip.isSticker ? 'Sticker' : 'Text'} />
      <Tabs
        value={tab}
        options={[
          { value: 'text', label: clip.isSticker ? 'Sticker' : 'Text' },
          { value: 'animation', label: 'Animation' },
          { value: 'keyframes', label: 'Keyframes' },
        ]}
        onChange={setTab}
      />
      {tab === 'animation' && <AnimationSection clip={clip} />}
      {tab === 'keyframes' && <KeyframesSection clip={clip} />}
      {tab === 'text' && (
        <>
          <Section
            title="Content"
            right={
              <Button onClick={() => startTextEdit(clip.id)} title="Edit the text directly on the preview (double-click it, or press Enter)">
                <Pencil size={12} /> Edit on canvas
              </Button>
            }
          >
            <textarea
              value={clip.text}
              onChange={(e) => updateClipById<TextClip>(clip.id, (c) => ({ ...c, text: e.target.value, name: e.target.value.slice(0, 40) || c.name, words: null }))}
              onKeyDown={(e) => e.stopPropagation()}
              rows={3}
              className="w-full resize-y rounded-md border border-white/10 bg-black/30 p-2 text-sm text-white outline-none focus:border-blue-500"
            />
            {clip.isCaption && (
              <div className="flex flex-wrap gap-1">
                <Button variant="outline" onClick={() => applyStyleToAllCaptions(clip.id)}>
                  Apply style to all captions
                </Button>
              </div>
            )}
          </Section>
          {!clip.isSticker && (
            <Section title="Style">
              <Row label="Preset">
                <Select
                  value="custom"
                  options={[{ value: 'custom', label: 'Choose a look…' }, ...CAPTION_PRESETS.map((p) => ({ value: p.id, label: p.label }))]}
                  onChange={(id) => {
                    const preset = CAPTION_PRESETS.find((p) => p.id === id)
                    if (preset) setStyle(preset.style)
                  }}
                />
              </Row>
              <Row label="Font">
                <FontPicker value={style.fontFamily} onChange={(fontFamily) => setStyle({ fontFamily })} />
              </Row>
              <Row label="Size">
                <Slider value={style.fontSize} min={8} max={400} onLive={(v) => setStyle({ fontSize: v }, true)} onChange={(v) => setStyle({ fontSize: v })} />
              </Row>
              <Row label="Format">
                <div className="flex gap-1">
                  <FormatToggle on={style.bold} onClick={() => setStyle({ bold: !style.bold })} title="Bold">
                    <Bold size={13} />
                  </FormatToggle>
                  <FormatToggle on={style.italic} onClick={() => setStyle({ italic: !style.italic })} title="Italic">
                    <Italic size={13} />
                  </FormatToggle>
                  <FormatToggle on={style.underline} onClick={() => setStyle({ underline: !style.underline })} title="Underline">
                    <Underline size={13} />
                  </FormatToggle>
                  <span className="mx-1 w-px bg-white/10" />
                  <FormatToggle on={style.align === 'left'} onClick={() => setStyle({ align: 'left' })} title="Align left">
                    <TextAlignStart size={13} />
                  </FormatToggle>
                  <FormatToggle on={style.align === 'center'} onClick={() => setStyle({ align: 'center' })} title="Center">
                    <TextAlignCenter size={13} />
                  </FormatToggle>
                  <FormatToggle on={style.align === 'right'} onClick={() => setStyle({ align: 'right' })} title="Align right">
                    <TextAlignEnd size={13} />
                  </FormatToggle>
                </div>
              </Row>
              <Row label="Color">
                <ColorInput value={style.color} onChange={(color) => setStyle({ color })} />
              </Row>
              <Row label="Blend">
                <Select value={clip.blend ?? 'normal'} options={BLEND_MODES.map((b) => ({ value: b.id, label: b.label }))} onChange={(blend) => updateClipById<TextClip>(clip.id, (c) => ({ ...c, blend }))} />
              </Row>
              <Row label="Letter spacing">
                <Slider value={style.letterSpacing} min={-10} max={60} onLive={(v) => setStyle({ letterSpacing: v }, true)} onChange={(v) => setStyle({ letterSpacing: v })} />
              </Row>
              <Row label="Line height">
                <Slider value={style.lineHeight} min={0.8} max={3} step={0.05} onLive={(v) => setStyle({ lineHeight: v }, true)} onChange={(v) => setStyle({ lineHeight: v })} />
              </Row>
              <Row label="Wrap width">
                <Slider value={Math.round(style.maxWidth * 100)} min={10} max={100} suffix="%" onLive={(v) => setStyle({ maxWidth: v / 100 }, true)} onChange={(v) => setStyle({ maxWidth: v / 100 })} />
              </Row>
            </Section>
          )}
          {!clip.isSticker && (
            <Section title="Stroke, shadow & background" defaultOpen={false}>
              <Row label="Stroke">
                <ColorInput value={style.strokeColor} onChange={(strokeColor) => setStyle({ strokeColor })} />
              </Row>
              <Row label="Stroke width">
                <Slider value={style.strokeWidth} min={0} max={40} onLive={(v) => setStyle({ strokeWidth: v }, true)} onChange={(v) => setStyle({ strokeWidth: v })} />
              </Row>
              <Row label="Shadow">
                <ColorInput value={style.shadowColor} onChange={(shadowColor) => setStyle({ shadowColor })} />
              </Row>
              <Row label="Shadow blur">
                <Slider value={style.shadowBlur} min={0} max={60} onLive={(v) => setStyle({ shadowBlur: v }, true)} onChange={(v) => setStyle({ shadowBlur: v })} />
              </Row>
              <Row label="Shadow offset">
                <Slider value={style.shadowY} min={-40} max={40} onLive={(v) => setStyle({ shadowY: v, shadowX: v / 2 }, true)} onChange={(v) => setStyle({ shadowY: v, shadowX: v / 2 })} />
              </Row>
              <Row label="Background">
                <ColorInput value={style.bgColor} onChange={(bgColor) => setStyle({ bgColor, bgOpacity: style.bgOpacity || 0.7 })} />
              </Row>
              <Row label="Bg opacity">
                <Slider value={Math.round(style.bgOpacity * 100)} min={0} max={100} suffix="%" onLive={(v) => setStyle({ bgOpacity: v / 100 }, true)} onChange={(v) => setStyle({ bgOpacity: v / 100 })} />
              </Row>
              <Row label="Bg padding">
                <Slider value={style.bgPadding} min={0} max={80} onLive={(v) => setStyle({ bgPadding: v }, true)} onChange={(v) => setStyle({ bgPadding: v })} />
              </Row>
              <Row label="Bg corners">
                <Slider value={style.bgRadius} min={0} max={80} onLive={(v) => setStyle({ bgRadius: v }, true)} onChange={(v) => setStyle({ bgRadius: v })} />
              </Row>
            </Section>
          )}
          {clip.isCaption && (
            <Section title="Word highlight">
              <Row label="Highlight" hint="Colors the word being spoken (needs auto captions)">
                <Toggle checked={!!style.highlightColor} onChange={(v) => setStyle({ highlightColor: v ? '#22D3EE' : null })} />
                {style.highlightColor && <ColorInput value={style.highlightColor} onChange={(highlightColor) => setStyle({ highlightColor })} />}
              </Row>
              {!clip.words?.length && <p className="text-[11px] text-zinc-500">This caption has no word timings, so highlighting has nothing to follow.</p>}
            </Section>
          )}
          <TransformSection clip={clip} project={project} />
        </>
      )}
    </>
  )
}

function FormatToggle({ children, on, onClick, title }: { children: ReactNode; on: boolean; onClick: () => void; title: string }) {
  return (
    <button type="button" title={title} aria-label={title} aria-pressed={on} onClick={onClick} className={cx('flex h-7 w-7 items-center justify-center rounded-md border', on ? 'border-blue-400 bg-blue-500/20 text-white' : 'border-white/10 text-zinc-300 hover:bg-white/5')}>
      {children}
    </button>
  )
}

// ── Effects ─────────────────────────────────────────────────────────────────

function EffectInspector({ clip }: { clip: EffectClip }) {
  return (
    <>
      <ClipHeader clip={clip} subtitle="Applies to everything below it" />
      <Section title="Effect">
        <Row label="Effect">
          <Select
            value={clip.effect}
            options={[{ value: 'none', label: 'None (filter / adjust only)' }, ...EFFECTS.map((e) => ({ value: e.id, label: `${e.group} · ${e.label}` }))]}
            onChange={(effect) => updateClipById<EffectClip>(clip.id, (c) => ({ ...c, effect, name: EFFECTS.find((e) => e.id === effect)?.label ?? c.name }))}
          />
        </Row>
        {clip.effect !== 'none' && (
          <Row label="Intensity">
            <Slider
              value={clip.intensity}
              min={0}
              max={100}
              onLive={(v) => previewClipById<EffectClip>(clip.id, (c) => ({ ...c, intensity: v }))}
              onChange={(v) => updateClipById<EffectClip>(clip.id, (c) => ({ ...c, intensity: v }))}
            />
          </Row>
        )}
      </Section>
      <AdjustSection target={clip} />
    </>
  )
}

// ── Project ─────────────────────────────────────────────────────────────────

function ProjectSettings({ project }: { project: Project }) {
  const bg = project.canvas.background
  const guide = useEditor((s) => s.guide)
  const gpu = useEditor((s) => s.gpu)
  const fpsValue = FPS_PRESETS.some((f) => f.value === project.fps) ? String(project.fps) : 'custom'
  return (
    <>
      <div className="border-b border-white/[0.06] px-4 py-3">
        <p className="text-sm font-semibold text-white">Project</p>
        <p className="text-[11px] text-zinc-500">Select a clip on the timeline or in the preview to edit it.</p>
      </div>
      {!gpu && (
        <div className="border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-[11px] leading-5 text-amber-100">
          This browser has no WebGL2, so filters, LUTs, chroma key and effects will not render. Chrome or Edge with hardware acceleration turned on fixes this.
        </div>
      )}
      <Section title="Details">
        <Row label="Name">
          <input
            defaultValue={project.name}
            key={project.id}
            onBlur={(e) => renameProject(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
            className="w-full rounded-md border border-white/10 bg-black/30 px-2 py-1.5 text-xs text-white outline-none focus:border-blue-500"
          />
        </Row>
        <Row label="Frame rate">
          <Select
            value={fpsValue}
            options={[...FPS_PRESETS.map((f) => ({ value: String(f.value), label: `${f.label} fps` })), ...(fpsValue === 'custom' ? [{ value: 'custom', label: `${project.fps} fps` }] : [])]}
            onChange={(v) => v !== 'custom' && setFps(Number(v))}
          />
        </Row>
      </Section>
      <Section title="Canvas">
        <Row label="Ratio">
          <Select
            value={project.canvas.ratio}
            options={[
              ...(project.canvas.ratio === 'original' ? [{ value: 'original', label: 'Original' }] : [{ value: 'original', label: 'Original (first clip)' }]),
              ...CANVAS_RATIOS.map((r) => ({ value: r.id, label: `${r.label} · ${r.hint}` })),
              { value: 'custom', label: 'Custom size' },
            ]}
            onChange={(v) => (v === 'custom' ? setCanvasSize(project.canvas.width, project.canvas.height) : setCanvasRatio(v))}
          />
        </Row>
        <Row label="Size" hint="Typing a size switches the ratio to Custom">
          <NumberField value={project.canvas.width} min={16} max={7680} step={2} onChange={(w) => setCanvasSize(w, project.canvas.height)} suffix="w" />
          <span className="text-xs text-zinc-500">×</span>
          <NumberField value={project.canvas.height} min={16} max={7680} step={2} onChange={(h) => setCanvasSize(project.canvas.width, h)} suffix="h" />
        </Row>
        <Row label="Background">
          <Segmented
            value={bg.type}
            options={[
              { value: 'color', label: 'Color' },
              { value: 'gradient', label: 'Gradient' },
              { value: 'blur', label: 'Blur' },
              { value: 'image', label: 'Image' },
            ]}
            onChange={(type) => {
              if (type === 'color') setCanvasBackground({ type: 'color', color: bg.type === 'gradient' ? bg.from : '#000000' })
              if (type === 'gradient') setCanvasBackground({ type: 'gradient', from: bg.type === 'color' ? bg.color : '#003594', to: '#0b0d11', angle: 180 })
              if (type === 'blur') setCanvasBackground({ type: 'blur', amount: 50 })
              if (type === 'image') {
                const input = document.createElement('input')
                input.type = 'file'
                input.accept = 'image/*'
                input.onchange = () => input.files?.[0] && void setBackgroundImage(input.files[0])
                input.click()
              }
            }}
            size="xs"
          />
        </Row>
        {bg.type === 'color' && (
          <Row label="Color">
            <ColorInput value={bg.color} onChange={(color) => setCanvasBackground({ type: 'color', color })} />
          </Row>
        )}
        {bg.type === 'gradient' && (
          <>
            <Row label="Colors">
              <ColorInput value={bg.from} onChange={(from) => setCanvasBackground({ ...bg, from })} />
              <ColorInput value={bg.to} onChange={(to) => setCanvasBackground({ ...bg, to })} />
            </Row>
            <Row label="Angle">
              <Slider value={bg.angle} min={0} max={360} suffix="°" onChange={(angle) => setCanvasBackground({ ...bg, angle })} />
            </Row>
          </>
        )}
        {bg.type === 'blur' && (
          <Row label="Blur">
            <Slider value={bg.amount} min={0} max={100} onChange={(amount) => setCanvasBackground({ type: 'blur', amount })} />
          </Row>
        )}
        <Row label="Guides" hint="Overlay on the preview only; never exported">
          <Select value={guide} options={GUIDES.map((g) => ({ value: g.id, label: g.label }))} onChange={setGuide} />
        </Row>
      </Section>
      <Section title={`Markers (${project.markers.length})`} defaultOpen={project.markers.length > 0}>
        {project.markers.length === 0 ? (
          <p className="text-[11px] text-zinc-500">Press M to mark the playhead position. Markers can carry a note and span a range.</p>
        ) : (
          project.markers.map((m) => <MarkerRow key={m.id} marker={m} fps={project.fps} />)
        )}
      </Section>
    </>
  )
}

function MarkerRow({ marker: m, fps }: { marker: Project['markers'][number]; fps: number }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="rounded-md border border-white/[0.06] px-2 py-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          title="Change colour"
          className="h-3 w-3 shrink-0 rounded-sm"
          style={{ background: m.color }}
          onClick={() => updateMarker(m.id, { color: MARKER_COLORS[(MARKER_COLORS.indexOf(m.color) + 1) % MARKER_COLORS.length] })}
        />
        <button type="button" className="font-mono text-[10px] text-blue-300 hover:underline" onClick={() => seek(m.t)}>
          {formatTimecode(m.t, fps)}
        </button>
        <input
          value={m.label}
          placeholder="Label"
          onChange={(e) => updateMarker(m.id, { label: e.target.value })}
          onKeyDown={(e) => e.stopPropagation()}
          className="min-w-0 flex-1 bg-transparent text-xs text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <button type="button" onClick={() => setOpen((o) => !o)} className="text-[10px] text-zinc-400 hover:text-white" title="Note and duration">
          {open ? 'Less' : 'More'}
        </button>
        <Button variant="danger" onClick={() => removeMarker(m.id)} title="Remove marker">
          <Trash2 size={12} />
        </Button>
      </div>
      {open && (
        <div className="mt-2 space-y-2">
          <Row label="Duration" hint="0 keeps it a single point">
            <NumberField value={m.duration ?? 0} min={0} max={3600} step={0.1} onChange={(duration) => updateMarker(m.id, { duration })} suffix="s" />
          </Row>
          <textarea
            value={m.note ?? ''}
            placeholder="Note…"
            rows={2}
            onChange={(e) => updateMarker(m.id, { note: e.target.value })}
            onKeyDown={(e) => e.stopPropagation()}
            className="w-full resize-y rounded-md border border-white/10 bg-black/30 p-2 text-xs text-white outline-none focus:border-blue-500"
          />
        </div>
      )}
    </div>
  )
}
