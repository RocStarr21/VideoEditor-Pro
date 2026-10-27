/**
 * In-browser speech-to-text for "Auto captions".
 *
 * `decodeToMono16k` turns any media blob the browser can decode into the
 * 16 kHz mono PCM Whisper expects, and `transcribe` runs Whisper
 * (transformers.js) in a dedicated worker so the editor UI stays responsive.
 *
 * Browser globals are only touched inside functions, so importing this module
 * during SSR is harmless; the worker is spawned on the first transcription.
 */

import type { TimedWord } from './captions'

export type WhisperModel = 'tiny' | 'base' | 'small' | 'medium' | 'large'

export type TranscribeStage = 'download' | 'load' | 'transcribe'

export interface TranscribeProgress {
  stage: TranscribeStage
  /** 0..1 within the stage. */
  progress: number
  message: string
}

export interface TranscribeOptions {
  /** 'auto' (default) or an ISO 639-1 code from TRANSCRIBE_LANGUAGES. */
  language?: string
  /** Default 'base'. */
  model?: WhisperModel
  onProgress?: (p: TranscribeProgress) => void
  signal?: AbortSignal
}

export interface TranscribeResult {
  /** Absolute seconds from the start of the audio passed in. */
  words: TimedWord[]
  /** ISO 639-1 code: the requested language, or the detected one for 'auto'. */
  language: string
}

/** main → worker */
export interface TranscribeRequest {
  type: 'transcribe'
  id: number
  /** 16 kHz mono PCM. */
  audio: Float32Array
  language: string
  model: WhisperModel
}

/** worker → main */
export type TranscribeWorkerMessage =
  | ({ type: 'progress'; id: number } & TranscribeProgress)
  | { type: 'result'; id: number; words: TimedWord[]; language: string }
  | { type: 'error'; id: number; message: string }

export const TRANSCRIBE_SAMPLE_RATE = 16000

export const TRANSCRIBE_LANGUAGES: Array<{ code: string; label: string }> = [
  { code: 'auto', label: 'Auto-detect' },
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'nl', label: 'Dutch' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'pl', label: 'Polish' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ar', label: 'Arabic' },
  { code: 'he', label: 'Hebrew' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ur', label: 'Urdu' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'th', label: 'Thai' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'tl', label: 'Filipino (Tagalog)' },
  { code: 'sv', label: 'Swedish' },
  { code: 'no', label: 'Norwegian' },
  { code: 'da', label: 'Danish' },
  { code: 'fi', label: 'Finnish' },
  { code: 'el', label: 'Greek' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'hu', label: 'Hungarian' },
]

// ── Worker lifecycle ─────────────────────────────────────────────────────────

interface Job {
  resolve: (result: TranscribeResult) => void
  reject: (error: unknown) => void
  onProgress: (p: TranscribeProgress) => void
}

let worker: Worker | null = null
let nextJobId = 1
const jobs = new Map<number, Job>()
/** Jobs run one at a time: aborting means killing the worker, which must not take a queued job down with it. */
let queue: Promise<void> = Promise.resolve()

const abortError = () => new DOMException('Transcription was cancelled', 'AbortError')

function resetWorker(reason: unknown) {
  const current = worker
  worker = null
  current?.terminate()
  const pending = [...jobs.values()]
  jobs.clear()
  for (const job of pending) job.reject(reason)
}

function ensureWorker(): Worker {
  if (worker) return worker
  if (typeof Worker === 'undefined') throw new Error('Speech-to-text needs a browser with Web Worker support')

  const spawned = new Worker(new URL('./transcribe.worker.ts', import.meta.url), { type: 'module' })
  spawned.onmessage = (event: MessageEvent<TranscribeWorkerMessage>) => {
    const msg = event.data
    const job = jobs.get(msg.id)
    if (!job) return
    if (msg.type === 'progress') {
      job.onProgress({ stage: msg.stage, progress: msg.progress, message: msg.message })
      return
    }
    jobs.delete(msg.id)
    if (msg.type === 'result') job.resolve({ words: msg.words, language: msg.language })
    else job.reject(new Error(msg.message))
  }
  spawned.onerror = (event: ErrorEvent) => {
    event.preventDefault()
    resetWorker(new Error(event.message || 'The speech-to-text worker failed to start'))
  }
  spawned.onmessageerror = () => resetWorker(new Error('The speech-to-text worker sent an unreadable message'))
  worker = spawned
  return spawned
}

/** Transfers the caller's buffer when the view owns all of it; otherwise copies so unrelated data is not detached. */
const transferable = (audio: Float32Array): Float32Array<ArrayBuffer> =>
  audio.buffer instanceof ArrayBuffer && audio.byteOffset === 0 && audio.byteLength === audio.buffer.byteLength
    ? (audio as Float32Array<ArrayBuffer>)
    : audio.slice()

function runJob(audio: Float32Array, language: string, model: WhisperModel, onProgress: Job['onProgress']) {
  return new Promise<TranscribeResult>((resolve, reject) => {
    try {
      const target = ensureWorker()
      const id = nextJobId++
      const payload = transferable(audio)
      const request: TranscribeRequest = { type: 'transcribe', id, audio: payload, language, model }
      jobs.set(id, { resolve, reject, onProgress })
      try {
        target.postMessage(request, [payload.buffer])
      } catch (err) {
        jobs.delete(id)
        throw err
      }
    } catch (err) {
      reject(err)
    }
  })
}

const normalizeLanguage = (language: string | undefined) => {
  const code = (language ?? 'auto').trim().toLowerCase().split(/[-_]/)[0]
  return code === '' ? 'auto' : code
}

/**
 * Transcribes 16 kHz mono PCM into word timings. The audio buffer is
 * transferred to the worker, so the caller's array is detached afterwards
 * (copy it first if you still need it). Calls are queued and run one at a time.
 */
export async function transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<TranscribeResult> {
  const { signal, onProgress } = opts
  const language = normalizeLanguage(opts.language)
  const model = opts.model ?? 'base'
  if (signal?.aborted) throw abortError()
  // Too short to contain speech (< 0.1 s): skip loading a model for nothing.
  if (audio.length < TRANSCRIBE_SAMPLE_RATE / 10) return { words: [], language: language === 'auto' ? 'und' : language }

  return new Promise<TranscribeResult>((resolve, reject) => {
    let state: 'queued' | 'running' | 'settled' = 'queued'

    const settle = (finish: () => void) => {
      if (state === 'settled') return
      state = 'settled'
      signal?.removeEventListener('abort', onAbort)
      finish()
    }

    const onAbort = () => {
      const wasRunning = state === 'running'
      settle(() => reject(abortError()))
      // ONNX inference cannot be interrupted from outside, so stop it by killing the worker.
      if (wasRunning) resetWorker(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    const report = (p: TranscribeProgress) => {
      if (state !== 'running' || !onProgress) return
      try {
        onProgress(p)
      } catch (err) {
        console.error('transcribe: onProgress threw', err)
      }
    }

    queue = queue.then(async () => {
      if (state !== 'queued') return
      state = 'running'
      try {
        const result = await runJob(audio, language, model, report)
        settle(() => resolve(result))
      } catch (err) {
        settle(() => reject(err))
      }
    })
  })
}

// ── Audio decoding ───────────────────────────────────────────────────────────

type AudioContextCtor = new () => BaseAudioContext & { close(): Promise<void> }
type OfflineAudioContextCtor = new (channels: number, length: number, sampleRate: number) => OfflineAudioContext

const decodeAudio = (ctx: BaseAudioContext, data: ArrayBuffer) =>
  new Promise<AudioBuffer>((resolve, reject) => {
    const fail = (err?: unknown) =>
      reject(err instanceof Error ? err : new Error('This file has no audio track the browser can decode'))
    // Older Safari only supports the callback form and returns undefined.
    const pending = ctx.decodeAudioData(data, resolve, fail) as Promise<AudioBuffer> | undefined
    pending?.then(resolve, fail)
  })

/**
 * Decodes a media blob (audio or video) and returns 16 kHz mono PCM, optionally
 * limited to [start, end) seconds of the source.
 */
export async function decodeToMono16k(blob: Blob, range?: { start: number; end: number }): Promise<Float32Array> {
  const scope = globalThis as typeof globalThis & {
    webkitAudioContext?: AudioContextCtor
    webkitOfflineAudioContext?: OfflineAudioContextCtor
  }
  const AudioCtx: AudioContextCtor | undefined = scope.AudioContext ?? scope.webkitAudioContext
  const OfflineCtx: OfflineAudioContextCtor | undefined = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext
  if (!AudioCtx || !OfflineCtx) throw new Error('Audio decoding needs a browser with the Web Audio API')

  const encoded = await blob.arrayBuffer()
  const ctx = new AudioCtx()
  let decoded: AudioBuffer
  try {
    decoded = await decodeAudio(ctx, encoded)
  } finally {
    ctx.close().catch(() => undefined)
  }

  const rate = decoded.sampleRate
  const total = decoded.length
  const clampFrame = (seconds: number) => Math.min(total, Math.max(0, Math.round(seconds * rate)))
  const from = range ? clampFrame(range.start) : 0
  const to = range ? clampFrame(range.end) : total
  const frames = to - from
  if (frames <= 0) return new Float32Array(0)

  const mono = new Float32Array(frames)
  const channels = decoded.numberOfChannels
  for (let c = 0; c < channels; c++) {
    const data = decoded.getChannelData(c)
    for (let i = 0; i < frames; i++) mono[i] += data[from + i]
  }
  if (channels > 1) for (let i = 0; i < frames; i++) mono[i] /= channels

  if (rate === TRANSCRIBE_SAMPLE_RATE) return mono

  const outFrames = Math.max(1, Math.round((frames * TRANSCRIBE_SAMPLE_RATE) / rate))
  const offline = new OfflineCtx(1, outFrames, TRANSCRIBE_SAMPLE_RATE)
  const source = offline.createBufferSource()
  const buffer = offline.createBuffer(1, frames, rate)
  buffer.copyToChannel(mono, 0)
  source.buffer = buffer
  source.connect(offline.destination)
  source.start()
  const rendered = await offline.startRendering()
  // Copy out rather than hand back getChannelData(): the result is transferred to the worker later.
  const out = new Float32Array(outFrames)
  rendered.copyFromChannel(out, 0)
  return out
}
