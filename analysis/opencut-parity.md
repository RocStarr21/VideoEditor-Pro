# OpenCut feature parity — VideoEditor Pro

Prepared for Rodney S. Ford Jr. · RocStarr Media · 2026-10-26

## What was compared

- **Upstream `opencut-app/opencut` (main)** is only 18 commits ahead of this fork's base and contains the Rust desktop scaffolding, a "Coming soon" editor route stub and a changelog. It has no editor features of its own yet.
- **`opencut-app/opencut-classic`** (archived) holds the real OpenCut editor. Its changelog (0.1.0 → 0.4.0) and source modules were used as the feature checklist below.
- VideoEditor Pro's editor lives in `apps/web/src/editor/` (`model/`, `engine/`, `state/`, `ui/`). Everything below ships in this build; items marked *partial* say what differs.

## Feature matrix

| OpenCut classic feature | VideoEditor Pro | Where |
| --- | --- | --- |
| Masks: split, cinematic bars, rectangle, ellipse, heart, star | Yes (Split / Bars / Rectangle / Ellipse / Heart / Star) | `model/defaults.ts` MASK_SHAPES, `engine/compositor.ts` applyMask |
| Masks: diamond, text, freeform pen | Yes — pen tool adds points by clicking the preview, points draggable, Esc finishes | `ui/Player.tsx` MaskHandles, `state/actions.ts` addMaskPoint |
| Mask feather / invert / stroke outline | Yes (outline colour + width) | `ui/Inspector.tsx` MaskSection |
| Mask preview handles | Yes — centre (move) and corner (resize) handles on the preview | `ui/Player.tsx` MaskHandles |
| Keyframe graph editor with bezier presets (Linear, Smooth, Ease in/out, In & out, Pop) | Yes — per-segment cubic-bezier curve, draggable handles, presets | `ui/CurveEditor.tsx`, `model/keyframes.ts` cubicBezier |
| Copy / paste keyframes (rescaled to clip length) | Yes — Inspector buttons and clip context menu | `state/actions.ts` copyKeyframes / pasteKeyframes |
| Expanded keyframe lanes on the timeline, retime by dragging | Yes — "Show lanes" per clip; diamonds drag to retime | `ui/Timeline.tsx` KeyframeLane |
| Independent scale X / Y (width, height) | Yes — keyframeable Width/Height sliders, side stretch handles on the preview | `model/types.ts` Transform.scaleX/Y, `ui/Player.tsx` |
| Volume + speed with maintain pitch | Yes (already present; "Maintain pitch" toggle) | `ui/Inspector.tsx` SpeedSection |
| Custom canvas size | Yes — typed width/height switches the ratio to Custom | `state/actions.ts` setCanvasSize |
| Preview zoom / pan (25–200% presets) | Yes — Fit, 25–400%, Ctrl+wheel zoom, wheel/Alt-drag pan | `ui/Player.tsx` |
| Canvas backgrounds: colour, blur, gradient | Yes (gradient with two colours + angle) | `engine/compositor.ts`, `ui/Inspector.tsx` ProjectSettings |
| Stickers: emoji, shapes, country flags | Yes — Emoji / Shapes / Flags tabs; 270 flags (flag-icons, MIT) rasterised on import | `ui/LeftPanel.tsx` StickersPanel, `engine/flags.ts`, `public/flags/` |
| Graphics: rectangle / ellipse / polygon / star with fill, stroke, stroke align, corner radius | Yes — `ShapeClip` with its own inspector, masks and keyframes | `model/types.ts` ShapeClip, `engine/shapes.ts`, `ui/Inspector.tsx` ShapeInspector |
| Layout guides (grid, thirds, TikTok, Reels, Shorts, Spotlight safe areas) | Yes — preview-only overlay; platform zones are approximations | `ui/Player.tsx` GuideOverlay |
| Scenes (multiple timelines per project) | Yes — scenes menu in the timeline toolbar: add, rename, duplicate, reorder, delete | `model/scenes.ts`, `ui/Timeline.tsx` ScenesMenu |
| Bookmarks with note, colour, duration | Yes — markers carry note + duration; double-click / right-click a marker to edit; drag to move | `ui/Timeline.tsx` MarkerPopover, Inspector Markers |
| Ripple editing | Yes — toolbar toggle (R); deletes and trims close gaps | `model/timeline.ts` rippleShift, `state/store.ts` ripple |
| Box select + multi-clip move | Yes — drag on empty lane to box-select (Shift/Ctrl adds); dragging a selected clip moves the group | `ui/Timeline.tsx` startMarquee, moveClips |
| Shift disables snapping while dragging | Yes | `ui/Timeline.tsx` ClipView |
| Paste media from clipboard | Yes — Ctrl+V with files on the clipboard imports at the playhead | `ui/Editor.tsx` onPaste |
| Number inputs with maths and scrubbing | Yes — `100*2`, `+10`, `50%`; drag sideways to scrub (Shift ×10, Alt ×0.1) | `ui/controls.tsx` NumberField, `engine/expr.ts` |
| Colour picker: eyedropper, hex/rgb/hsl, opacity | Yes — popover with SV square, hue + alpha sliders, formats, swatches, EyeDropper | `ui/ColorPicker.tsx`, `engine/color.ts` |
| 1,000+ Google fonts + system fonts | Yes — searchable picker over 1,920 Google families + system fonts; fonts link on demand | `ui/FontPicker.tsx`, `engine/fonts.ts`, `engine/text.ts` ensureFontLinked |
| Freesound sound search | Yes — Audio → Sound library, with the user's own Freesound API key (kept in localStorage) | `engine/freesound.ts`, `ui/LeftPanel.tsx` SoundsSection |
| Transcription models tiny / small / medium / large-v3-turbo | Yes — tiny, base, small, medium, large (large-v3-turbo); large is a multi-GB download | `engine/transcribe.ts`, `engine/transcribe.worker.ts` |
| Import transcript files | Yes — SRT, VTT, ASS/SSA | `engine/captions.ts` parseCaptions |
| ASS / SRT subtitle export | Yes — SRT, VTT, ASS (Captions panel and Export dialog) | `engine/captions.ts` serializeAss, `engine/export.ts` |
| Customisable keybindings | Yes — Shortcuts dialog: click a key, press the new combination; stored on this device | `state/keybindings.ts`, `ui/Dialogs.tsx` ShortcutsDialog |
| Project thumbnails + info | Yes — poster frame saved on autosave; size, fps, clips, scenes, created/edited | `engine/persistence.ts`, `ui/Dialogs.tsx` ProjectsDialog |
| GPU-unsupported notice | Yes — banner when WebGL2 is missing | `state/actions.ts` bootstrap, `ui/Player.tsx` |
| Text blend modes | Yes | `model/types.ts` TextClip.blend, `engine/compositor.ts` |
| Inline text editing on the canvas | Yes — double-click text (or Enter with it selected); Esc / Ctrl+Enter finishes | `ui/Player.tsx` InlineTextEditor |
| Audio volume line + waveform clipping tips | Yes — drag the yellow line on audio clips; peaks over full scale turn red with a CLIP badge | `ui/Timeline.tsx` VolumeLine, Waveform |
| Detach / reattach audio | Yes — "Detach audio" and "Reattach to video" (context menu + inspector) | `state/actions.ts` extractAudio / reattachAudio |
| Clip context menu | Yes — split, duplicate, copy/paste, detach/reattach, freeze, reverse, keyframe lanes/copy/paste/clear, edit text, delete | `ui/ContextMenu.tsx`, `ui/Timeline.tsx` clipMenuItems |
| Track highlight when a clip on it is selected | Yes | `ui/Timeline.tsx` TrackRow |

## Not carried over (by design)

- **Rust desktop shell** (upstream `opencut` main): VideoEditor Pro stays a browser app served from Roc's machine.
- **OpenCut's hosted services** (Vercel Blob, Upstash, their waitlist/marketing pages): not relevant to a private editor.
- Platform safe-zone guides use published approximations of each app's UI; they are visual aids, not exported.

## Verification

- `npx tsc --noEmit`: clean apart from the three pre-existing errors in `src/components/ui` (calendar, scroll-area, spinner) that predate this work.
- `npx vitest run`: 14 files, 139 tests passing (new suites: scenes, keyframe curves, ripple, expressions, colour, ASS captions, shapes).
- `npx vite build`: production bundle written to `apps/web/dist/`.
