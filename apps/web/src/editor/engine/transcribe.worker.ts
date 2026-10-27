/**
 * Whisper speech-to-text worker (transformers.js v4).
 *
 * Receives 16 kHz mono PCM, returns word-level timings. The message protocol
 * is declared in ./transcribe. Requests are processed one at a time because a
 * single ONNX Runtime session cannot run concurrently.
 */

import {
  LogitsProcessor,
  LogitsProcessorList,
  TextStreamer,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type DataType,
  type ProgressInfo,
  type Tensor,
} from '@huggingface/transformers'
import type { TimedWord } from './captions'
import type { TranscribeProgress, TranscribeRequest, TranscribeWorkerMessage, WhisperModel } from './transcribe'

type Asr = AutomaticSpeechRecognitionPipeline
type Device = 'webgpu' | 'wasm'
type Emit = (p: TranscribeProgress) => void

const SAMPLE_RATE = 16000
const CHUNK_SECONDS = 30
const STRIDE_SECONDS = 5
/** Whisper timestamp tokens advance in 20 ms steps. */
const TIME_PRECISION = 0.02

/**
 * The `_timestamped` exports are the ones transformers.js uses for word-level
 * timestamps: their decoder also outputs the cross-attentions that the DTW
 * word alignment needs. All three are multilingual.
 */
const MODEL_IDS: Record<WhisperModel, string> = {
  tiny: 'onnx-community/whisper-tiny_timestamped',
  base: 'onnx-community/whisper-base_timestamped',
  small: 'onnx-community/whisper-small_timestamped',
  medium: 'onnx-community/whisper-medium_timestamped',
  large: 'onnx-community/whisper-large-v3-turbo_timestamped',
}

const MODEL_LABELS: Record<WhisperModel, string> = { tiny: 'Whisper Tiny', base: 'Whisper Base', small: 'Whisper Small', medium: 'Whisper Medium', large: 'Whisper Large v3 Turbo' }

/**
 * Word timestamps are computed in JS from the decoder's cross-attentions, so
 * the decoder must keep fp32 outputs (no fp16 / q4f16), and the encoder must
 * then emit fp32 hidden states too. fp32 encoder + 4-bit decoder is the
 * transformers.js recommendation for Whisper on WebGPU; 8-bit dynamic
 * quantization is the fast path on the WASM (CPU) backend.
 */
const DTYPES: Record<Device, Record<string, DataType>> = {
  webgpu: { encoder_model: 'fp32', decoder_model_merged: 'q4' },
  wasm: { encoder_model: 'q8', decoder_model_merged: 'q8' },
}

/** The subset of Whisper's generation_config.json this worker reads. */
interface WhisperGenerationConfig {
  decoder_start_token_id?: number
  no_timestamps_token_id?: number
  lang_to_id?: Record<string, number>
}

const scope = self as unknown as {
  postMessage(message: TranscribeWorkerMessage): void
  onmessage: ((event: MessageEvent<TranscribeRequest>) => void) | null
}

// ── Device + pipeline cache ──────────────────────────────────────────────────

let devicePromise: Promise<Device> | null = null

const detectDevice = (): Promise<Device> =>
  (devicePromise ??= (async (): Promise<Device> => {
    const gpu = (navigator as unknown as { gpu?: { requestAdapter(): Promise<unknown> } }).gpu
    if (!gpu) return 'wasm'
    try {
      return (await gpu.requestAdapter()) ? 'webgpu' : 'wasm'
    } catch {
      return 'wasm'
    }
  })())

const pipelines = new Map<string, Promise<Asr>>()
/** Progress callbacks are bound when a pipeline starts loading; route them to whichever job is current. */
let emitCurrent: Emit = () => undefined

const megabytes = (bytes: number) => (bytes / 1e6).toFixed(bytes < 1e7 ? 1 : 0)

/** Folds transformers.js' per-file progress events into one monotonic 0..1 download figure. */
function downloadReporter(label: string) {
  const files = new Map<string, { loaded: number; total: number }>()
  let fraction = 0
  let lastSent = -1
  let lastTime = 0
  let fetching = false
  let finished = false

  const track = (file: string, loaded: number, total: number) => {
    if (Number.isFinite(total) && total > 0) files.set(file, { loaded: Number.isFinite(loaded) ? loaded : 0, total })
  }

  return (info: ProgressInfo) => {
    switch (info.status) {
      case 'download':
        fetching = true
        return
      case 'progress_total':
        for (const [file, p] of Object.entries(info.files)) track(file, p.loaded, p.total)
        break
      case 'progress':
        track(info.file, info.loaded, info.total)
        break
      case 'done': {
        const p = files.get(info.file)
        if (p) p.loaded = p.total
        break
      }
      case 'ready':
        emitCurrent({ stage: 'load', progress: 1, message: `${label} ready` })
        return
      default:
        return
    }
    if (finished) return

    let loaded = 0
    let total = 0
    for (const p of files.values()) {
      loaded += Math.min(p.loaded, p.total)
      total += p.total
    }
    if (total <= 0) return
    fraction = Math.max(fraction, Math.min(1, loaded / total))

    const now = Date.now()
    if (fraction < 1 && fraction - lastSent < 0.005 && now - lastTime < 250) return
    lastSent = fraction
    lastTime = now
    const pct = `${Math.round(fraction * 100)}%`
    emitCurrent({
      stage: 'download',
      progress: fraction,
      message: fetching
        ? `Downloading ${label}… ${pct} (${megabytes(loaded)} / ${megabytes(total)} MB)`
        : `Loading ${label} from cache… ${pct}`,
    })
    if (fraction >= 1) {
      finished = true
      emitCurrent({ stage: 'load', progress: 0, message: `Initialising ${label}…` })
    }
  }
}

function loadPipeline(model: WhisperModel, device: Device): Promise<Asr> {
  const key = `${model}:${device}`
  let pending = pipelines.get(key)
  if (!pending) {
    const label = `${MODEL_LABELS[model]} (${device === 'webgpu' ? 'WebGPU' : 'CPU'})`
    emitCurrent({ stage: 'download', progress: 0, message: `Preparing ${label}…` })
    pending = pipeline('automatic-speech-recognition', MODEL_IDS[model], {
      device,
      dtype: DTYPES[device],
      progress_callback: downloadReporter(label),
    })
    pipelines.set(key, pending)
    pending.catch(() => pipelines.delete(key))
  }
  return pending
}

async function getPipeline(model: WhisperModel): Promise<Asr> {
  const device = await detectDevice()
  try {
    return await loadPipeline(model, device)
  } catch (err) {
    if (device !== 'webgpu') throw err
    // An adapter can exist yet still fail to build the session (missing features, driver bugs, out of memory).
    console.warn('transcribe.worker: WebGPU failed, falling back to WASM', err)
    devicePromise = Promise.resolve('wasm')
    return loadPipeline(model, 'wasm')
  }
}

// ── Language detection ───────────────────────────────────────────────────────

/** Masks every logit except the allowed token ids. */
class AllowTokensProcessor extends LogitsProcessor {
  allowed: number[]

  constructor(allowed: number[]) {
    super()
    this.allowed = allowed
  }

  _call(_inputIds: bigint[][], logits: Tensor) {
    const data = logits.data as Float32Array
    const vocab = logits.dims[logits.dims.length - 1]
    for (let row = 0; row < data.length; row += vocab) {
      const kept = this.allowed.map((id) => data[row + id])
      data.fill(-Infinity, row, row + vocab)
      this.allowed.forEach((id, i) => {
        data[row + id] = kept[i]
      })
    }
    return logits
  }
}

/** The most energetic 30 s window — speech is likelier there than in a silent intro. */
function loudestWindow(audio: Float32Array, size: number): Float32Array {
  if (audio.length <= size) return audio
  const block = SAMPLE_RATE / 2
  const energy = new Float64Array(Math.ceil(audio.length / block))
  for (let i = 0; i < audio.length; i++) energy[Math.floor(i / block)] += audio[i] * audio[i]

  const span = Math.floor(size / block)
  let sum = 0
  for (let b = 0; b < span; b++) sum += energy[b]
  let best = sum
  let bestBlock = 0
  for (let b = span; b < energy.length; b++) {
    sum += energy[b] - energy[b - span]
    if (sum > best) {
      best = sum
      bestBlock = b - span + 1
    }
  }
  const start = Math.min(bestBlock * block, audio.length - size)
  return audio.subarray(start, start + size)
}

/**
 * transformers.js v4 does not implement Whisper language detection (it falls
 * back to English), so run one decoder step after <|startoftranscript|> with
 * everything but the language tokens masked out.
 */
async function detectLanguage(asr: Asr, audio: Float32Array): Promise<string> {
  const config = asr.model.generation_config as unknown as WhisperGenerationConfig | null
  const langToId = config?.lang_to_id
  const start = config?.decoder_start_token_id
  if (!langToId || start == null) return 'en'

  const languages = Object.entries(langToId)
  const processors = new LogitsProcessorList()
  processors.push(new AllowTokensProcessor(languages.map(([, id]) => id)))

  const { input_features } = await asr.processor(loudestWindow(audio, CHUNK_SECONDS * SAMPLE_RATE))
  const output = (await asr.model.generate({
    inputs: input_features,
    decoder_input_ids: [start],
    max_new_tokens: 1,
    return_timestamps: false,
    return_token_timestamps: false,
    logits_processor: processors,
  })) as Tensor
  const sequence = output.tolist()[0] as Array<bigint | number>
  const predicted = Number(sequence[sequence.length - 1])
  const token = languages.find(([, id]) => id === predicted)?.[0]
  return token ? token.slice(2, -2) : 'en'
}

// ── Transcription ────────────────────────────────────────────────────────────

/**
 * Reports how far into the current 30 s window the decoder is, from the
 * timestamp tokens it emits. Extends TextStreamer only because that is the
 * type generate() accepts; put/end are fully overridden, so nothing is decoded.
 */
class TimestampStreamer extends TextStreamer {
  timestampBegin: number
  onTime: (seconds: number) => void

  constructor(asr: Asr, timestampBegin: number, onTime: (seconds: number) => void) {
    super(asr.tokenizer, { skip_prompt: true, callback_function: () => undefined })
    this.timestampBegin = timestampBegin
    this.onTime = onTime
  }

  put(value: bigint[][]) {
    const tokens = value[0]
    // Multi-token puts are the prompt, not generated output.
    if (!tokens || tokens.length !== 1) return
    const offset = Number(tokens[0]) - this.timestampBegin
    if (offset >= 0) this.onTime(offset * TIME_PRECISION)
  }

  end() {}
}

/** Mirrors the window loop in transformers.js' Whisper pipeline. */
function countWindows(samples: number) {
  const window = CHUNK_SECONDS * SAMPLE_RATE
  const jump = window - 2 * STRIDE_SECONDS * SAMPLE_RATE
  let count = 1
  for (let offset = 0; offset + window < samples; offset += jump) count++
  return count
}

const clock = (seconds: number) => {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

interface RawChunk {
  text: string
  timestamp?: [number | null, number | null]
}

async function runAsr(asr: Asr, audio: Float32Array, language: string, emit: Emit): Promise<RawChunk[]> {
  const duration = audio.length / SAMPLE_RATE
  const windows = countWindows(audio.length)
  const jumpSeconds = CHUNK_SECONDS - 2 * STRIDE_SECONDS
  const config = asr.model.generation_config as unknown as WhisperGenerationConfig | null
  const timestampBegin = (config?.no_timestamps_token_id ?? 50363) + 1

  let windowIndex = 0
  let windowTime = 0
  let lastReport = 0
  const report = (force: boolean) => {
    const now = Date.now()
    if (!force && now - lastReport < 200) return
    lastReport = now
    const windowStart = windowIndex * jumpSeconds
    const windowLength = Math.max(0.001, Math.min(CHUNK_SECONDS, duration - windowStart))
    const within = Math.min(1, windowTime / windowLength)
    emit({
      stage: 'transcribe',
      progress: Math.min(1, (windowIndex + within) / windows),
      message: `Transcribing… ${clock(Math.min(duration, windowStart + windowTime))} / ${clock(duration)}`,
    })
  }

  const streamer = new TimestampStreamer(asr, timestampBegin, (t) => {
    if (t <= windowTime) return
    windowTime = t
    report(false)
  })

  // The pipeline calls model.generate() once per 30 s window but exposes no
  // per-window hook, so count windows by wrapping it for this call only.
  const model = asr.model as unknown as { generate: (...args: unknown[]) => Promise<unknown> }
  const ownGenerate = Object.prototype.hasOwnProperty.call(model, 'generate')
  const generate = model.generate
  model.generate = async (...args: unknown[]) => {
    windowTime = 0
    try {
      return await generate.apply(asr.model, args)
    } finally {
      windowIndex = Math.min(windows, windowIndex + 1)
      windowTime = 0
      report(true)
    }
  }

  emit({ stage: 'transcribe', progress: 0, message: `Transcribing… 0:00 / ${clock(duration)}` })
  try {
    const output = await asr(audio, {
      language,
      task: 'transcribe',
      return_timestamps: 'word',
      chunk_length_s: CHUNK_SECONDS,
      stride_length_s: STRIDE_SECONDS,
      streamer,
    })
    return (output.chunks ?? []) as RawChunk[]
  } finally {
    if (ownGenerate) model.generate = generate
    else delete (model as { generate?: unknown }).generate
  }
}

const finiteOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
const round3 = (value: number) => Math.round(value * 1000) / 1000

/**
 * Whisper occasionally leaves a word's start or end null (e.g. audio cut off
 * mid-word). Borrow the neighbour's touching edge where possible, otherwise
 * spread the untimed run across the surrounding gap by text length; then
 * force the timeline to be monotonic and inside the audio.
 */
function toWords(chunks: RawChunk[], duration: number): TimedWord[] {
  const items = chunks
    .map((c) => ({ text: c.text.trim(), start: finiteOrNull(c.timestamp?.[0]), end: finiteOrNull(c.timestamp?.[1]) }))
    .filter((w) => w.text !== '')
  const n = items.length

  for (let i = 1; i < n; i++) if (items[i].start === null) items[i].start = items[i - 1].end
  for (let i = n - 2; i >= 0; i--) if (items[i].end === null) items[i].end = items[i + 1].start

  for (let i = 0; i < n; ) {
    if (items[i].start !== null && items[i].end !== null) {
      i++
      continue
    }
    let j = i
    while (j + 1 < n && (items[j + 1].start === null || items[j + 1].end === null)) j++

    const left = items[i].start ?? (i > 0 ? (items[i - 1].end ?? 0) : 0)
    let right = items[j].end ?? (j + 1 < n ? items[j + 1].start : null)
    if (right === null || right < left) right = Math.min(Math.max(duration, left), left + 0.35 * (j - i + 1))

    const weights = items.slice(i, j + 1).map((w) => w.text.length + 1)
    const totalWeight = weights.reduce((a, b) => a + b, 0)
    let acc = 0
    for (let k = i; k <= j; k++) {
      const from = left + ((right - left) * acc) / totalWeight
      acc += weights[k - i]
      const to = left + ((right - left) * acc) / totalWeight
      items[k].start ??= from
      items[k].end ??= to
    }
    i = j + 1
  }

  let prevEnd = 0
  return items.map((w) => {
    const start = Math.min(Math.max(w.start ?? 0, prevEnd), duration)
    const end = Math.min(Math.max(w.end ?? start, start), duration)
    prevEnd = end
    return { text: w.text, start: round3(start), end: round3(end) }
  })
}

// ── Message loop ─────────────────────────────────────────────────────────────

const describeError = (err: unknown) => {
  // ONNX Runtime's WASM build throws bare numbers (pointers) on allocation failures.
  if (typeof err === 'number') return 'Ran out of memory while running the speech model. Try a smaller model or a shorter clip.'
  if (err instanceof Error) return err.message || err.name
  return String(err)
}

async function handle(request: TranscribeRequest) {
  const emit: Emit = (p) => scope.postMessage({ type: 'progress', id: request.id, ...p })
  emitCurrent = emit
  try {
    const audio = request.audio
    const duration = audio.length / SAMPLE_RATE
    const requested = (request.language || 'auto').toLowerCase()
    if (audio.length === 0) {
      scope.postMessage({ type: 'result', id: request.id, words: [], language: requested === 'auto' ? 'und' : requested })
      return
    }

    const asr = await getPipeline(request.model in MODEL_IDS ? request.model : 'base')
    let language = requested
    if (language === 'auto') {
      emit({ stage: 'transcribe', progress: 0, message: 'Detecting language…' })
      language = await detectLanguage(asr, audio)
    }
    const chunks = await runAsr(asr, audio, language, emit)
    const words = toWords(chunks, duration)
    emit({ stage: 'transcribe', progress: 1, message: `Transcribed ${words.length} words` })
    scope.postMessage({ type: 'result', id: request.id, words, language })
  } catch (err) {
    console.error('transcribe.worker:', err)
    scope.postMessage({ type: 'error', id: request.id, message: describeError(err) })
  } finally {
    emitCurrent = () => undefined
  }
}

let queue: Promise<void> = Promise.resolve()

scope.onmessage = (event) => {
  const request = event.data
  if (request?.type !== 'transcribe') return
  queue = queue.then(() => handle(request))
}
