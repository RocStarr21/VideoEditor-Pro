/**
 * AI noise reduction: RNNoise running in an AudioWorklet, via
 * @sapphi-red/web-noise-suppressor. Works in AudioContext and
 * OfflineAudioContext, but only at 48 kHz.
 */
import rnnoiseWorkletUrl from '@sapphi-red/web-noise-suppressor/rnnoiseWorklet.js?url'
import rnnoiseWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise.wasm?url'
import rnnoiseSimdWasmUrl from '@sapphi-red/web-noise-suppressor/rnnoise_simd.wasm?url'

type SuppressorModule = typeof import('@sapphi-red/web-noise-suppressor')

export const DENOISE_SAMPLE_RATE = 48000

/** Fixed delay of the worklet's 480-sample framing ring buffer: 512 samples at 48 kHz. */
export const DENOISE_LATENCY_SECONDS = 512 / DENOISE_SAMPLE_RATE

let modulePromise: Promise<SuppressorModule> | null = null
let wasmPromise: Promise<ArrayBuffer> | null = null
const workletReady = new WeakMap<BaseAudioContext, Promise<void>>()

// The package declares classes extending AudioWorkletNode at module scope, so
// importing it statically would throw during SSR.
function loadModule(): Promise<SuppressorModule> {
  modulePromise ??= import('@sapphi-red/web-noise-suppressor').catch((error: unknown) => {
    modulePromise = null
    throw error
  })
  return modulePromise
}

function loadWasm(lib: SuppressorModule): Promise<ArrayBuffer> {
  wasmPromise ??= lib.loadRnnoise({ url: rnnoiseWasmUrl, simdUrl: rnnoiseSimdWasmUrl }).catch((error: unknown) => {
    wasmPromise = null
    throw error
  })
  return wasmPromise
}

function ensureWorklet(ctx: BaseAudioContext): Promise<void> {
  let ready = workletReady.get(ctx)
  if (!ready) {
    ready = ctx.audioWorklet.addModule(rnnoiseWorkletUrl).catch((error: unknown) => {
      workletReady.delete(ctx)
      throw error
    })
    workletReady.set(ctx, ready)
  }
  return ready
}

export function isDenoiseSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof WebAssembly !== 'undefined' &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof AudioContext !== 'undefined' &&
    'audioWorklet' in AudioContext.prototype
  )
}

/**
 * A mono/stereo RNNoise node for `ctx`. The wasm binary is fetched once per
 * page and the worklet module is added once per context. Channels beyond the
 * first two pass through silent, so feed it mono or stereo.
 */
export async function createDenoiseNode(ctx: BaseAudioContext): Promise<AudioNode> {
  if (ctx.sampleRate !== DENOISE_SAMPLE_RATE) {
    throw new Error(
      `AI noise reduction (RNNoise) only runs at ${DENOISE_SAMPLE_RATE} Hz, but this audio context runs at ${ctx.sampleRate} Hz. Create the context with sampleRate: ${DENOISE_SAMPLE_RATE}.`,
    )
  }
  if (!isDenoiseSupported() || !ctx.audioWorklet) {
    throw new Error('AI noise reduction needs AudioWorklet and WebAssembly support, which this browser does not provide.')
  }
  const lib = await loadModule()
  const [wasmBinary] = await Promise.all([loadWasm(lib), ensureWorklet(ctx)])
  // Typed as AudioContext upstream, but AudioWorkletNode accepts any BaseAudioContext, OfflineAudioContext included.
  return new lib.RnnoiseWorkletNode(ctx as AudioContext, { maxChannels: 2, wasmBinary })
}

/** Disconnects the node and frees its RNNoise state inside the worklet. */
export function destroyDenoiseNode(node: AudioNode): void {
  node.disconnect()
  if ('destroy' in node && typeof node.destroy === 'function') node.destroy()
}
