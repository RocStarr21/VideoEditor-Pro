import type { ChromaKey, EffectName } from '../model/types'
import type { ColorGrade } from './filters'
import type { Lut3D } from './lut'

/**
 * WebGL2 image processing for clips (grade, LUT, chroma key, matte) and for
 * full-frame effects.
 *
 * Orientation: sources are uploaded with UNPACK_FLIP_Y_WEBGL = false, so texture
 * row 0 is the top of the image. The vertex shader maps clip-space y = +1 (the top
 * of the canvas as displayed) to v = 0, so the output canvas is upright when drawn
 * with drawImage(). `vUv` in both fragment shaders is image space: (0,0) top-left.
 */

export interface ChromaParams {
  /** Key color, rgb 0..1. */
  color: [number, number, number]
  /** CbCr distance below which pixels are fully keyed out, 0..1. */
  similarity: number
  /** Width of the soft edge above `similarity`, 0..1. */
  smoothness: number
  /** Spill suppression strength, 0..1. */
  spill: number
}

type GL = WebGL2RenderingContext
type GLCanvas = HTMLCanvasElement | OffscreenCanvas

const clamp01 = (v: number) => (v > 1 ? 1 : v > 0 ? v : 0)

function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim())
  if (!m) return null
  const s = m[1].length <= 4 ? [...m[1]].map((ch) => ch + ch).join('') : m[1]
  const n = parseInt(s.slice(0, 6), 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}

/** Maps the model's ChromaKey (0..100 sliders, hex color) to shader parameters. Null when disabled or the color is invalid. */
export function chromaFromKey(key: ChromaKey): ChromaParams | null {
  if (!key.enabled) return null
  const color = hexToRgb(key.color)
  if (!color) return null
  const intensity = clamp01(key.intensity / 100)
  const shadow = clamp01(key.shadow / 100)
  return {
    color,
    similarity: 0.05 + intensity * 0.55,
    smoothness: 0.02 + shadow * 0.28,
    spill: shadow,
  }
}

// ── Context plumbing ─────────────────────────────────────────────────────────

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: true,
  premultipliedAlpha: true,
  antialias: false,
  depth: false,
  stencil: false,
  // Callers may drawImage() the result after an await; keep it valid until the next process().
  preserveDrawingBuffer: true,
}

function createContext(): { canvas: GLCanvas; gl: GL } | null {
  if (typeof OffscreenCanvas !== 'undefined') {
    try {
      const canvas = new OffscreenCanvas(1, 1)
      const gl = canvas.getContext('webgl2', CONTEXT_ATTRS)
      if (gl) return { canvas, gl }
    } catch {
      // Some browsers expose OffscreenCanvas without WebGL support on it.
    }
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    const gl = canvas.getContext('webgl2', CONTEXT_ATTRS)
    if (gl) return { canvas, gl }
  }
  return null
}

let webgl2Supported: boolean | null = null

function hasWebGL2(): boolean {
  if (webgl2Supported !== null) return webgl2Supported
  if (typeof OffscreenCanvas === 'undefined' && typeof document === 'undefined') return false
  const made = createContext()
  webgl2Supported = !!made
  made?.gl.getExtension('WEBGL_lose_context')?.loseContext()
  return webgl2Supported
}

function compile(gl: GL, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL: could not create a shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS) && !gl.isContextLost()) {
    const log = gl.getShaderInfoLog(shader)
    gl.deleteShader(shader)
    throw new Error(`WebGL shader failed to compile: ${log}`)
  }
  return shader
}

function program(gl: GL, vertex: string, fragment: string): WebGLProgram {
  const prog = gl.createProgram()
  if (!prog) throw new Error('WebGL: could not create a program')
  const vs = compile(gl, gl.VERTEX_SHADER, vertex)
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragment)
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  gl.deleteShader(vs)
  gl.deleteShader(fs)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS) && !gl.isContextLost()) {
    const log = gl.getProgramInfoLog(prog)
    gl.deleteProgram(prog)
    throw new Error(`WebGL program failed to link: ${log}`)
  }
  return prog
}

function uniforms<K extends string>(gl: GL, prog: WebGLProgram, names: readonly K[]): Record<K, WebGLUniformLocation | null> {
  const out = {} as Record<K, WebGLUniformLocation | null>
  for (const name of names) out[name] = gl.getUniformLocation(prog, name)
  return out
}

function texture(gl: GL, target: number = gl.TEXTURE_2D): WebGLTexture {
  const tex = gl.createTexture()
  if (!tex) throw new Error('WebGL: could not create a texture')
  gl.bindTexture(target, tex)
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE)
  return tex
}

/** Uploads a DOM/bitmap source with row 0 = image top (no Y flip). */
function uploadImage(gl: GL, unit: number, tex: WebGLTexture, source: TexImageSource, premultiply: boolean) {
  gl.activeTexture(gl.TEXTURE0 + unit)
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply)
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source)
}

/** WebGL2 rejects ArrayBufferView uploads to 3D textures while these flags are set. */
function resetUnpack(gl: GL) {
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
}

const VERTEX_SHADER = `#version 300 es
out vec2 vUv;
void main() {
  // One oversized triangle covering the viewport; no vertex buffers needed.
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = vec2(p.x, 1.0 - p.y);
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}
`

const GLSL_HASH = `
uint pcg(uint v) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
float rand(uvec3 v) {
  return float(pcg(v.x ^ pcg(v.y ^ pcg(v.z)))) * (1.0 / 4294967295.0);
}
`

/** Owns one WebGL2 context and its canvas; recreates both after a context loss. */
abstract class GLStage {
  private canvas: GLCanvas | null = null
  private gl: GL | null = null
  private width = 0
  private height = 0

  protected abstract init(gl: GL): void
  /** Drop every GL object reference (the context they belong to is gone). */
  protected abstract forget(): void

  protected begin(width: number, height: number): { gl: GL; canvas: GLCanvas; width: number; height: number } {
    let gl = this.gl
    let canvas = this.canvas
    if (!gl || !canvas || gl.isContextLost()) {
      this.forget()
      this.gl = null
      this.canvas = null
      const made = createContext()
      if (!made) throw new Error('WebGL2 is not available')
      try {
        this.init(made.gl)
      } catch (err) {
        this.forget()
        made.gl.getExtension('WEBGL_lose_context')?.loseContext()
        throw err
      }
      gl = this.gl = made.gl
      canvas = this.canvas = made.canvas
      this.width = this.height = 0
    }
    const w = Math.max(1, Math.round(width) || 1)
    const h = Math.max(1, Math.round(height) || 1)
    if (w !== this.width || h !== this.height) {
      canvas.width = w
      canvas.height = h
      this.width = w
      this.height = h
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    gl.viewport(0, 0, w, h)
    gl.disable(gl.BLEND)
    return { gl, canvas, width: w, height: h }
  }

  dispose(): void {
    const gl = this.gl
    this.forget()
    this.gl = null
    this.canvas = null
    this.width = this.height = 0
    if (gl && !gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext()
  }
}

// ── Clip processor ───────────────────────────────────────────────────────────

const CLIP_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSrc;
uniform sampler2D uMask;
uniform sampler3D uLut;
uniform vec2 uTexel;
uniform uint uFrame;

uniform bool uKeyOn;
uniform vec2 uKeyCbCr;
uniform float uKeySim;
uniform float uKeySoft;
uniform float uSpill;
uniform vec3 uKeyDom;

uniform bool uGradeOn;
uniform float uSharpen;
uniform float uExposure;
uniform float uTemperature;
uniform float uTint;
uniform float uBrightness;
uniform float uContrast;
uniform float uHighlights;
uniform float uShadows;
uniform float uSaturation;
uniform bool uHueOn;
uniform mat3 uHue;
uniform float uFade;
uniform float uVignette;
uniform float uGrain;

uniform bool uSplitOn;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;

uniform bool uLutOn;
uniform float uLutSize;
uniform vec3 uLutMin;
uniform vec3 uLutMax;
uniform float uLutMix;

uniform bool uMaskOn;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
${GLSL_HASH}
void main() {
  vec4 src = texture(uSrc, vUv);

  if (uGradeOn && uSharpen > 0.0) {
    vec4 sum = src;
    sum += texture(uSrc, vUv + vec2(-uTexel.x, -uTexel.y));
    sum += texture(uSrc, vUv + vec2(0.0, -uTexel.y));
    sum += texture(uSrc, vUv + vec2(uTexel.x, -uTexel.y));
    sum += texture(uSrc, vUv + vec2(-uTexel.x, 0.0));
    sum += texture(uSrc, vUv + vec2(uTexel.x, 0.0));
    sum += texture(uSrc, vUv + vec2(-uTexel.x, uTexel.y));
    sum += texture(uSrc, vUv + vec2(0.0, uTexel.y));
    sum += texture(uSrc, vUv + vec2(uTexel.x, uTexel.y));
    src.rgb = clamp(src.rgb + (src.rgb - sum.rgb / 9.0) * uSharpen, 0.0, src.a);
  }

  float alpha = src.a;
  vec3 c = alpha > 0.0 ? src.rgb / alpha : vec3(0.0);

  // The matte is pulled from the ungraded pixel so a key color sampled from the
  // source still matches whatever grade or LUT is applied afterwards.
  if (uKeyOn) {
    vec2 cbcr = vec2(dot(c, vec3(-0.168736, -0.331264, 0.5)), dot(c, vec3(0.5, -0.418688, -0.081312)));
    alpha *= smoothstep(uKeySim, uKeySim + uKeySoft, distance(cbcr, uKeyCbCr));
    float dom = dot(c, uKeyDom);
    float rest = (c.r + c.g + c.b - dom) * 0.5;
    c -= uKeyDom * (max(dom - rest, 0.0) * uSpill);
  }

  if (uGradeOn) {
    c *= uExposure;
    c += vec3(uTemperature, 0.0, -uTemperature);
    c += vec3(0.5, -1.0, 0.5) * uTint;
    c += uBrightness;
    c = (c - 0.5) * uContrast + 0.5;
    float l = dot(c, LUMA);
    c += uShadows * (1.0 - smoothstep(0.0, 0.55, l)) + uHighlights * smoothstep(0.45, 1.0, l);
    c = mix(vec3(dot(c, LUMA)), c, uSaturation);
    if (uHueOn) c = uHue * c;
    c = c * (1.0 - 0.2 * uFade) + 0.12 * uFade;
    c = clamp(c, 0.0, 1.0);
  }

  if (uSplitOn) {
    float l = dot(c, LUMA);
    c += uShadowTint * (1.0 - smoothstep(0.0, 0.6, l)) + uHighlightTint * smoothstep(0.4, 1.0, l);
    c = clamp(c, 0.0, 1.0);
  }

  if (uLutOn) {
    vec3 n = clamp((c - uLutMin) / (uLutMax - uLutMin), 0.0, 1.0);
    vec3 graded = texture(uLut, n * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize).rgb;
    c = mix(c, graded, uLutMix);
  }

  // Vignette and grain finish the image after the LUT so the LUT doesn't reshape them.
  if (uGradeOn) {
    if (uVignette > 0.0) {
      float r = length(vUv - 0.5) * 1.41421356;
      c *= 1.0 - uVignette * 0.85 * smoothstep(0.35, 1.0, r);
    }
    if (uGrain > 0.0) {
      uvec3 seed = uvec3(uvec2(gl_FragCoord.xy), uFrame);
      c += (rand(seed) + rand(seed + uvec3(0u, 0u, 7919u)) - 1.0) * uGrain;
    }
  }

  if (uMaskOn) {
    vec4 m = texture(uMask, vUv);
    alpha *= min(m.r, m.a);
  }

  c = clamp(c, 0.0, 1.0);
  outColor = vec4(c * alpha, alpha);
}
`

const CLIP_UNIFORMS = [
  'uSrc', 'uMask', 'uLut', 'uTexel', 'uFrame',
  'uKeyOn', 'uKeyCbCr', 'uKeySim', 'uKeySoft', 'uSpill', 'uKeyDom',
  'uGradeOn', 'uSharpen', 'uExposure', 'uTemperature', 'uTint', 'uBrightness', 'uContrast',
  'uHighlights', 'uShadows', 'uSaturation', 'uHueOn', 'uHue', 'uFade', 'uVignette', 'uGrain',
  'uSplitOn', 'uShadowTint', 'uHighlightTint',
  'uLutOn', 'uLutSize', 'uLutMin', 'uLutMax', 'uLutMix',
  'uMaskOn',
] as const

const GRADE_KEYS = [
  'brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint',
  'highlights', 'shadows', 'hue', 'sharpen', 'vignette', 'fade', 'grain',
] as const

/** Column-major rotation about the gray axis (the CSS hue-rotate() matrix). */
function hueMatrix(degrees: number): Float32Array {
  const a = (degrees * Math.PI) / 180
  const c = Math.cos(a)
  const s = Math.sin(a)
  const r = [
    0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928,
    0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.14, 0.072 - c * 0.072 - s * 0.283,
    0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072,
  ]
  return new Float32Array([r[0], r[3], r[6], r[1], r[4], r[7], r[2], r[5], r[8]])
}

const luma = (c: readonly number[]) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]

/** Chroma-only offset of a tint color, scaled: shifts hue without changing luma. */
function tintOffset(tint: readonly number[] | null, amount: number): [number, number, number] {
  if (!tint) return [0, 0, 0]
  const l = luma(tint)
  return [(tint[0] - l) * amount, (tint[1] - l) * amount, (tint[2] - l) * amount]
}

export interface ClipProcessOptions {
  width: number
  height: number
  grade: ColorGrade | null
  lut: Lut3D | null
  /** 0..1 */
  lutIntensity: number
  chroma: ChromaParams | null
  /** Segmentation/matte: keep = min(red, alpha), multiplied into the output alpha. */
  alphaMask: TexImageSource | null
  /** Seconds; seeds the grain. */
  time: number
}

export class ClipProcessor extends GLStage {
  static isSupported(): boolean {
    return hasWebGL2()
  }

  private prog: WebGLProgram | null = null
  private u: Record<(typeof CLIP_UNIFORMS)[number], WebGLUniformLocation | null> | null = null
  private vao: WebGLVertexArrayObject | null = null
  private srcTex: WebGLTexture | null = null
  private maskTex: WebGLTexture | null = null
  private blankLut: WebGLTexture | null = null
  private luts = new WeakMap<Lut3D, WebGLTexture | null>()
  private floatLinear = false
  private max3D = 256

  protected init(gl: GL): void {
    this.floatLinear = !!gl.getExtension('OES_texture_float_linear')
    this.max3D = gl.getParameter(gl.MAX_3D_TEXTURE_SIZE) as number
    const prog = program(gl, VERTEX_SHADER, CLIP_FRAGMENT)
    const u = uniforms(gl, prog, CLIP_UNIFORMS)
    gl.useProgram(prog)
    gl.uniform1i(u.uSrc, 0)
    gl.uniform1i(u.uMask, 1)
    gl.uniform1i(u.uLut, 2)

    resetUnpack(gl)
    gl.activeTexture(gl.TEXTURE0)
    this.srcTex = texture(gl)
    gl.activeTexture(gl.TEXTURE1)
    this.maskTex = texture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]))
    gl.activeTexture(gl.TEXTURE2)
    this.blankLut = texture(gl, gl.TEXTURE_3D)
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA8, 1, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]))

    this.vao = gl.createVertexArray()
    this.prog = prog
    this.u = u
  }

  protected forget(): void {
    this.prog = null
    this.u = null
    this.vao = null
    this.srcTex = null
    this.maskTex = null
    this.blankLut = null
    this.luts = new WeakMap()
  }

  /** Uploads (once per Lut3D object) and returns the LUT's 3D texture, or null if it can't be used. */
  private lutTexture(gl: GL, lut: Lut3D): WebGLTexture | null {
    const cached = this.luts.get(lut)
    if (cached !== undefined) return cached
    const { size, data } = lut
    let tex: WebGLTexture | null = null
    if (Number.isInteger(size) && size >= 2 && size <= this.max3D && data.length === size * size * size * 3) {
      resetUnpack(gl)
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4)
      gl.activeTexture(gl.TEXTURE2)
      tex = texture(gl, gl.TEXTURE_3D)
      // RGB32F is only filterable with OES_texture_float_linear; RGB16F always is.
      gl.texImage3D(gl.TEXTURE_3D, 0, this.floatLinear ? gl.RGB32F : gl.RGB16F, size, size, size, 0, gl.RGB, gl.FLOAT, data)
    }
    this.luts.set(lut, tex)
    return tex
  }

  /**
   * Renders `source` stretched to width x height through
   * chroma key → grade → split tones → LUT → vignette/grain → alpha mask.
   * Returns the internal canvas (premultiplied alpha, upright); valid until the next process() call.
   * Throws if WebGL2 is unavailable.
   */
  process(source: TexImageSource, opts: ClipProcessOptions): HTMLCanvasElement | OffscreenCanvas {
    const { gl, canvas, width, height } = this.begin(opts.width, opts.height)
    const u = this.u!
    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)

    uploadImage(gl, 0, this.srcTex!, source, true)
    gl.uniform2f(u.uTexel, 1 / width, 1 / height)
    gl.uniform1ui(u.uFrame, Math.floor(Math.max(0, opts.time || 0) * 60) >>> 0)

    const key = opts.chroma
    gl.uniform1i(u.uKeyOn, key ? 1 : 0)
    if (key) {
      const [kr, kg, kb] = key.color
      gl.uniform2f(u.uKeyCbCr, -0.168736 * kr - 0.331264 * kg + 0.5 * kb, 0.5 * kr - 0.418688 * kg - 0.081312 * kb)
      gl.uniform1f(u.uKeySim, clamp01(key.similarity))
      gl.uniform1f(u.uKeySoft, Math.max(1e-3, key.smoothness))
      gl.uniform1f(u.uSpill, clamp01(key.spill))
      const dom = kg >= kr && kg >= kb ? 1 : kb >= kr ? 2 : 0
      gl.uniform3f(u.uKeyDom, dom === 0 ? 1 : 0, dom === 1 ? 1 : 0, dom === 2 ? 1 : 0)
    }

    const g = opts.grade
    const gradeOn = !!g && GRADE_KEYS.some((k) => g[k] !== 0)
    gl.uniform1i(u.uGradeOn, gradeOn ? 1 : 0)
    if (g && gradeOn) {
      gl.uniform1f(u.uSharpen, g.sharpen / 100)
      gl.uniform1f(u.uExposure, Math.pow(2, (g.exposure / 100) * 2))
      gl.uniform1f(u.uTemperature, (g.temperature / 100) * 0.1)
      // Positive tint = magenta, negative = green.
      gl.uniform1f(u.uTint, (g.tint / 100) * 0.1)
      gl.uniform1f(u.uBrightness, (g.brightness / 100) * 0.25)
      gl.uniform1f(u.uContrast, Math.max(0, 1 + g.contrast / 100))
      gl.uniform1f(u.uHighlights, (g.highlights / 100) * 0.25)
      gl.uniform1f(u.uShadows, (g.shadows / 100) * 0.25)
      gl.uniform1f(u.uSaturation, Math.max(0, 1 + g.saturation / 100))
      gl.uniform1i(u.uHueOn, g.hue !== 0 ? 1 : 0)
      if (g.hue !== 0) gl.uniformMatrix3fv(u.uHue, false, hueMatrix(g.hue * 1.8))
      gl.uniform1f(u.uFade, g.fade / 100)
      gl.uniform1f(u.uVignette, g.vignette / 100)
      gl.uniform1f(u.uGrain, (g.grain / 100) * 0.15)
    }

    const splitOn = !!g && g.tintAmount > 0 && !!(g.shadowTint || g.highlightTint)
    gl.uniform1i(u.uSplitOn, splitOn ? 1 : 0)
    if (g && splitOn) {
      gl.uniform3fv(u.uShadowTint, tintOffset(g.shadowTint, g.tintAmount))
      gl.uniform3fv(u.uHighlightTint, tintOffset(g.highlightTint, g.tintAmount))
    }

    const lutMix = clamp01(opts.lutIntensity)
    const lutTex = opts.lut && lutMix > 0 ? this.lutTexture(gl, opts.lut) : null
    gl.activeTexture(gl.TEXTURE2)
    gl.bindTexture(gl.TEXTURE_3D, lutTex ?? this.blankLut)
    gl.uniform1i(u.uLutOn, lutTex ? 1 : 0)
    if (opts.lut && lutTex) {
      const { domainMin: lo, domainMax: hi, size } = opts.lut
      const valid = hi[0] > lo[0] && hi[1] > lo[1] && hi[2] > lo[2]
      gl.uniform1f(u.uLutSize, size)
      gl.uniform3fv(u.uLutMin, valid ? lo : [0, 0, 0])
      gl.uniform3fv(u.uLutMax, valid ? hi : [1, 1, 1])
      gl.uniform1f(u.uLutMix, lutMix)
    }

    if (opts.alphaMask) {
      uploadImage(gl, 1, this.maskTex!, opts.alphaMask, false)
    } else {
      gl.activeTexture(gl.TEXTURE1)
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex)
    }
    gl.uniform1i(u.uMaskOn, opts.alphaMask ? 1 : 0)

    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    return canvas
  }
}

// ── Effect processor ─────────────────────────────────────────────────────────

const EFFECT_IDS: Record<EffectName, number> = {
  none: 0,
  blur: 1,
  glitch: 2,
  shake: 3,
  vhs: 4,
  filmGrain: 5,
  vignette: 6,
  blackWhite: 7,
  sepia: 8,
  pixelate: 9,
  mirror: 10,
  zoomPulse: 11,
  flash: 12,
  invert: 13,
  rgbSplit: 14,
  scanlines: 15,
}

const EFFECT_FRAGMENT = `#version 300 es
precision highp float;
precision highp int;

in vec2 vUv;
out vec4 outColor;

uniform sampler2D uSrc;
uniform bool uFlipSrc;
uniform int uEffect;
uniform float uK;
uniform float uTime;
uniform float uLocal;
uniform vec2 uRes;
uniform float uScale;
uniform vec2 uStep;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
const float TAU = 6.28318530718;
${GLSL_HASH}
// Render-target textures are stored bottom-up; DOM uploads are top-down.
vec4 tap(vec2 uv) {
  return texture(uSrc, uFlipSrc ? vec2(uv.x, 1.0 - uv.y) : uv);
}

vec3 straight(vec4 p) {
  return p.a > 0.0 ? p.rgb / p.a : vec3(0.0);
}

vec4 premul(vec3 c, float a) {
  return vec4(clamp(c, 0.0, 1.0) * a, a);
}

float vnoise(float x, uint seed) {
  float i = floor(x);
  float f = fract(x);
  float a = rand(uvec3(uint(i), seed, 3u));
  float b = rand(uvec3(uint(i) + 1u, seed, 3u));
  return mix(a, b, f * f * (3.0 - 2.0 * f)) * 2.0 - 1.0;
}

vec4 blur(vec2 uv) {
  vec4 acc = vec4(0.0);
  float total = 0.0;
  for (int i = -6; i <= 6; i++) {
    float fi = float(i);
    float w = exp(-fi * fi / 18.0);
    acc += tap(uv + uStep * fi) * w;
    total += w;
  }
  return acc / total;
}

vec4 glitch(vec2 uv) {
  uint tick = uint(floor(uTime * 12.0));
  float burst = step(1.0 - (0.2 + 0.5 * uK), rand(uvec3(uint(floor(uTime * 5.0)), 17u, 1u)));
  float rows = 12.0 + floor(rand(uvec3(tick, 5u, 2u)) * 36.0);
  uint row = uint(floor(uv.y * rows));
  float pick = rand(uvec3(tick, row, 3u));
  float shift = pick < (0.15 + 0.35 * uK) * burst ? (rand(uvec3(tick, row, 4u)) - 0.5) * 0.2 * uK : 0.0;
  vec2 p = vec2(fract(uv.x + shift), uv.y);
  float split = (0.002 + 0.016 * burst) * uK;
  vec4 mid = tap(p);
  return vec4(tap(p + vec2(split, 0.0)).r, mid.g, tap(p - vec2(split, 0.0)).b, mid.a);
}

vec4 shake(vec2 uv) {
  vec2 amp = vec2(8.0 * uScale * uK) / uRes;
  float t = uTime * 14.0;
  vec2 off = vec2(vnoise(t, 1u), vnoise(t, 2u)) * amp;
  // Zoom in by the jitter range so the edges never smear.
  return tap((uv - 0.5) * (1.0 - 2.0 * amp) + 0.5 + off);
}

vec4 vhs(vec2 uv) {
  uint tick = uint(floor(uTime * 30.0));
  float wobble = (sin(uv.y * 40.0 + uTime * 3.0) * 0.5 + sin(uv.y * 6.0 - uTime * 1.7)) * 0.0015 * uK;
  float band = 1.0 - smoothstep(0.0, 0.04, abs(uv.y - fract(uTime * 0.07 + 0.3)));
  wobble += band * (rand(uvec3(tick, uint(uv.y * uRes.y), 9u)) - 0.5) * 0.02 * uK;
  vec2 p = vec2(uv.x + wobble, uv.y);
  float bleed = 3.0 * uScale * uK / uRes.x;
  vec4 base = tap(p);
  vec3 c = straight(base);
  c.r = mix(c.r, straight(tap(p + vec2(bleed, 0.0))).r, 0.85);
  c.b = mix(c.b, straight(tap(p - vec2(bleed, 0.0))).b, 0.85);
  c = mix(c, vec3(dot(c, LUMA)), 0.2 * uK) * mix(vec3(1.0), vec3(1.04, 1.0, 0.94), uK);
  float period = max(2.0, 3.0 * uScale);
  c *= 1.0 - 0.15 * uK * (0.5 + 0.5 * sin(TAU * uv.y * uRes.y / period));
  uvec3 seed = uvec3(uvec2(gl_FragCoord.xy), tick);
  c += (rand(seed) - 0.5) * 0.12 * uK + band * 0.15 * uK * rand(seed + uvec3(0u, 0u, 99u));
  return premul(c, base.a);
}

vec3 filmGrain(vec3 c) {
  uint tick = uint(floor(uTime * 24.0));
  uvec3 seed = uvec3(uvec2(floor(gl_FragCoord.xy / max(uScale, 1.0))), tick);
  float n = rand(seed) + rand(seed + uvec3(0u, 0u, 7919u)) - 1.0;
  float midtones = 1.0 - 0.6 * abs(dot(c, LUMA) * 2.0 - 1.0);
  c += n * 0.18 * uK * midtones;
  return c * (1.0 + (rand(uvec3(tick, 3u, 5u)) - 0.5) * 0.04 * uK);
}

void main() {
  vec2 uv = vUv;
  if (uEffect == 1) { outColor = blur(uv); return; }
  if (uEffect == 2) { outColor = glitch(uv); return; }
  if (uEffect == 3) { outColor = shake(uv); return; }
  if (uEffect == 4) { outColor = vhs(uv); return; }
  if (uEffect == 9) {
    float size = mix(1.0, 40.0, uK) * uScale;
    if (size <= 1.0) { outColor = tap(uv); return; }
    vec2 cell = size / uRes;
    outColor = tap((floor((uv - 0.5) / cell) + 0.5) * cell + 0.5);
    return;
  }
  if (uEffect == 10) {
    outColor = mix(tap(uv), tap(vec2(uv.x > 0.5 ? 1.0 - uv.x : uv.x, uv.y)), uK);
    return;
  }
  if (uEffect == 11) {
    float s = 1.0 + 0.08 * uK * (0.5 - 0.5 * cos(TAU * 4.0 * uLocal));
    outColor = tap((uv - 0.5) / s + 0.5);
    return;
  }
  if (uEffect == 14) {
    vec2 off = vec2(10.0, 2.0) * uScale * uK / uRes;
    vec4 mid = tap(uv);
    outColor = vec4(tap(uv + off).r, mid.g, tap(uv - off).b, mid.a);
    return;
  }

  vec4 base = tap(uv);
  vec3 c = straight(base);
  if (uEffect == 5) {
    c = filmGrain(c);
  } else if (uEffect == 6) {
    c *= 1.0 - 0.9 * uK * smoothstep(0.25, 1.0, length(uv - 0.5) * 1.41421356);
  } else if (uEffect == 7) {
    c = mix(c, vec3(dot(c, LUMA)), uK);
  } else if (uEffect == 8) {
    vec3 sepia = vec3(dot(c, vec3(0.393, 0.769, 0.189)), dot(c, vec3(0.349, 0.686, 0.168)), dot(c, vec3(0.272, 0.534, 0.131)));
    c = mix(c, sepia, uK);
  } else if (uEffect == 12) {
    c = mix(c, vec3(1.0), uK * pow(0.5 + 0.5 * cos(TAU * 2.0 * uLocal), 6.0));
  } else if (uEffect == 13) {
    c = mix(c, 1.0 - c, uK);
  } else if (uEffect == 15) {
    float period = max(2.0, 4.0 * uScale);
    c *= (1.0 - 0.45 * uK * (0.5 + 0.5 * cos(TAU * uv.y * uRes.y / period))) * (1.0 + 0.15 * uK);
  } else {
    outColor = base;
    return;
  }
  outColor = premul(c, base.a);
}
`

const EFFECT_UNIFORMS = ['uSrc', 'uFlipSrc', 'uEffect', 'uK', 'uTime', 'uLocal', 'uRes', 'uScale', 'uStep'] as const

export interface EffectProcessOptions {
  width: number
  height: number
  effect: EffectName
  /** 0..1 */
  intensity: number
  /** Timeline seconds; seeds the random effects so renders are deterministic. */
  time: number
  /** Seconds since the effect clip started (zoomPulse, flash). */
  localTime: number
}

export class EffectProcessor extends GLStage {
  static isSupported(): boolean {
    return hasWebGL2()
  }

  private prog: WebGLProgram | null = null
  private u: Record<(typeof EFFECT_UNIFORMS)[number], WebGLUniformLocation | null> | null = null
  private vao: WebGLVertexArrayObject | null = null
  private srcTex: WebGLTexture | null = null
  private fbo: WebGLFramebuffer | null = null
  private fboTex: WebGLTexture | null = null
  private fboW = 0
  private fboH = 0

  protected init(gl: GL): void {
    const prog = program(gl, VERTEX_SHADER, EFFECT_FRAGMENT)
    const u = uniforms(gl, prog, EFFECT_UNIFORMS)
    gl.useProgram(prog)
    gl.uniform1i(u.uSrc, 0)
    gl.activeTexture(gl.TEXTURE0)
    this.srcTex = texture(gl)
    this.vao = gl.createVertexArray()
    this.prog = prog
    this.u = u
  }

  protected forget(): void {
    this.prog = null
    this.u = null
    this.vao = null
    this.srcTex = null
    this.fbo = null
    this.fboTex = null
    this.fboW = this.fboH = 0
  }

  private target(gl: GL, w: number, h: number): WebGLFramebuffer {
    if (this.fbo && this.fboW === w && this.fboH === h) return this.fbo
    if (this.fbo) gl.deleteFramebuffer(this.fbo)
    if (this.fboTex) gl.deleteTexture(this.fboTex)
    gl.activeTexture(gl.TEXTURE1)
    const tex = texture(gl)
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
    const fbo = gl.createFramebuffer()
    if (!fbo) throw new Error('WebGL: could not create a framebuffer')
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo)
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)
    this.fbo = fbo
    this.fboTex = tex
    this.fboW = w
    this.fboH = h
    return fbo
  }

  /**
   * Applies one full-frame effect to `source` stretched to width x height.
   * Returns the internal canvas (premultiplied alpha, upright); valid until the next process() call.
   * Throws if WebGL2 is unavailable.
   */
  process(source: TexImageSource, opts: EffectProcessOptions): HTMLCanvasElement | OffscreenCanvas {
    const { gl, canvas, width, height } = this.begin(opts.width, opts.height)
    const u = this.u!
    const k = clamp01(opts.intensity)
    let effect = k > 0 ? (EFFECT_IDS[opts.effect] ?? 0) : 0
    const scale = height / 1080

    gl.useProgram(this.prog)
    gl.bindVertexArray(this.vao)
    uploadImage(gl, 0, this.srcTex!, source, true)
    gl.uniform1f(u.uK, k)
    gl.uniform1f(u.uTime, Math.max(0, opts.time || 0))
    gl.uniform1f(u.uLocal, Math.max(0, opts.localTime || 0))
    gl.uniform2f(u.uRes, width, height)
    gl.uniform1f(u.uScale, scale)
    gl.uniform1i(u.uFlipSrc, 0)
    gl.uniform2f(u.uStep, 0, 0)

    if (effect === EFFECT_IDS.blur) {
      const radius = 12 * k * scale
      if (radius >= 0.5) {
        // Separable gaussian: horizontal into an offscreen target, then vertical onto the canvas.
        const step = radius / 6
        gl.uniform1i(u.uEffect, effect)
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.target(gl, width, height))
        gl.viewport(0, 0, width, height)
        gl.uniform2f(u.uStep, step / width, 0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)

        gl.bindFramebuffer(gl.FRAMEBUFFER, null)
        gl.activeTexture(gl.TEXTURE0)
        gl.bindTexture(gl.TEXTURE_2D, this.fboTex)
        gl.uniform1i(u.uFlipSrc, 1)
        gl.uniform2f(u.uStep, 0, step / height)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.bindVertexArray(null)
        return canvas
      }
      effect = 0
    }

    gl.uniform1i(u.uEffect, effect)
    gl.drawArrays(gl.TRIANGLES, 0, 3)
    gl.bindVertexArray(null)
    return canvas
  }
}
