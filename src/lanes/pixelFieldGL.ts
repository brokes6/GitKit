// WebGL1 renderer for the pixel field: one full-screen triangle and a fragment
// shader that works out which 7 px cell it is in, evaluates the same value noise
// + Bayer dither for that cell, and lights the 4 px square inside it. The main
// thread only sets a few uniforms per frame.
//
// The noise lattice hash is baked into a 256×256 texture from the same JS hash
// the Canvas2D path uses (16 bits per value), so both renderers match exactly.
import {
  CELL, DOT, DOT_OFFSET, LEVELS, RIPPLE_BAND, RIPPLE_GAIN, RIPPLE_LIFE, RIPPLE_SPEED, hash,
} from "./pixelFieldShared";
import type { FieldRenderer, FieldTheme, Ripple } from "./pixelFieldShared";

const MAX_RIPPLES = 4;
const f = (n: number) => n.toFixed(4);

const VERTEX = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

const FRAGMENT = `
precision highp float;
uniform highp sampler2D uHash;
uniform vec2 uSize;            // drawing buffer, device px
uniform float uDpr;
uniform float uTime;           // seconds
uniform vec4 uColor;           // premultiplied colour at full field alpha
uniform vec4 uRipple[${MAX_RIPPLES}];       // xy centre (CSS px), z radius, w strength (0 = unused)

const float CELL = ${f(CELL)};
const float DOT_LO = ${f(DOT_OFFSET)};
const float DOT_HI = ${f(DOT_OFFSET + DOT)};

// Lattice hash: 16 bits split across luminance (high byte) and alpha (low byte).
float lattice(vec2 i) {
  vec4 s = texture2D(uHash, (mod(i, 256.0) + 0.5) / 256.0);
  return (floor(s.r * 255.0 + 0.5) * 256.0 + floor(s.a * 255.0 + 0.5)) / 65535.0;
}

float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 t = p - i;
  vec2 u = t * t * (3.0 - 2.0 * t);
  float a = lattice(i), b = lattice(i + vec2(1.0, 0.0));
  float c = lattice(i + vec2(0.0, 1.0)), d = lattice(i + vec2(1.0, 1.0));
  return a + (b - a) * u.x + (c - a) * u.y + (a - b - c + d) * u.x * u.y;
}

// 4×4 Bayer threshold, built from two 2×2 levels: M2 = [0 2; 3 1].
float m2(vec2 b) { return b.y * 3.0 + b.x * 2.0 - 4.0 * b.x * b.y; }
float bayer(vec2 cell) {
  vec2 p = mod(cell, 4.0);
  return (4.0 * m2(mod(p, 2.0)) + m2(floor(p * 0.5)) + 0.5) / 16.0;
}

void main() {
  // CSS px, top-left origin (gl_FragCoord is bottom-left).
  vec2 css = vec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y) / uDpr;
  vec2 cell = floor(css / CELL);
  vec2 local = css - cell * CELL;
  // The gaps between squares are most of the screen; bail before any noise.
  if (local.x < DOT_LO || local.y < DOT_LO || local.x >= DOT_HI || local.y >= DOT_HI) discard;

  // Two layers drifting in different directions give a slow, organic flow.
  float v = noise(vec2(cell.x * 0.045 + uTime * 0.05, cell.y * 0.06 - uTime * 0.02)) * 0.65
          + noise(vec2(cell.x * 0.11 - uTime * 0.07, cell.y * 0.12 + uTime * 0.04)) * 0.35;
  v = (v - 0.42) * 1.9;

  for (int k = 0; k < ${MAX_RIPPLES}; k++) {
    vec4 r = uRipple[k];
    if (r.w > 0.0) {
      float band = (distance(cell * CELL, r.xy) - r.z) / ${f(RIPPLE_BAND)};
      v += exp(-band * band) * r.w;
    }
  }

  float level = floor(v * ${f(LEVELS - 1)} + bayer(cell));
  if (level <= 0.0) discard;
  gl_FragColor = uColor * (min(level, ${f(LEVELS)}) / ${f(LEVELS)});
}`;

function hashTexturePixels(): Uint8Array {
  const data = new Uint8Array(256 * 256 * 2);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      const h = Math.round(hash(x, y) * 65535);
      const i = (y * 256 + x) * 2;
      data[i] = h >> 8;
      data[i + 1] = h & 255;
    }
  }
  return data;
}

interface GLState {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  texture: WebGLTexture;
  u: Record<"size" | "dpr" | "time" | "color" | "ripple", WebGLUniformLocation | null>;
}

/** Returns null when WebGL is unavailable or would be software-rendered. */
export function createWebGLRenderer(canvas: HTMLCanvasElement, onContextChange: (ready: boolean) => void): FieldRenderer | null {
  const gl = canvas.getContext("webgl", {
    alpha: true, premultipliedAlpha: true, antialias: false, depth: false, stencil: false,
    preserveDrawingBuffer: false,
    powerPreference: "low-power",          // never wake a discrete GPU for a background
    failIfMajorPerformanceCaveat: true,    // software GL would be worse than Canvas2D
  });
  if (!gl) return null;

  let hashPixels: Uint8Array | null = null;
  let state: GLState | null = null;
  let dpr = 1;
  let sizeDirty = true;
  let lastColor = "";
  let lastAlpha = -1;
  let hadRipples = false;
  const rippleData = new Float32Array(MAX_RIPPLES * 4);

  const compile = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      console.warn("PixelField shader:", gl.getShaderInfoLog(s));
    }
    return s;
  };

  // (Re)build all GPU resources; also used after a context restore.
  const init = (): GLState | null => {
    const program = gl.createProgram();
    const buffer = gl.createBuffer();
    const texture = gl.createTexture();
    if (!program || !buffer || !texture) return null;
    const vs = compile(gl.VERTEX_SHADER, VERTEX), fs = compile(gl.FRAGMENT_SHADER, FRAGMENT);
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.bindAttribLocation(program, 0, "aPos");
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;
    gl.useProgram(program);

    // One triangle that covers the whole viewport.
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE_ALPHA, 256, 256, 0, gl.LUMINANCE_ALPHA, gl.UNSIGNED_BYTE,
      hashPixels ??= hashTexturePixels());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(gl.getUniformLocation(program, "uHash"), 0);

    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    return {
      program, buffer, texture,
      u: {
        size: gl.getUniformLocation(program, "uSize"),
        dpr: gl.getUniformLocation(program, "uDpr"),
        time: gl.getUniformLocation(program, "uTime"),
        color: gl.getUniformLocation(program, "uColor"),
        ripple: gl.getUniformLocation(program, "uRipple[0]"),
      },
    };
  };

  state = init();
  if (!state) return null;

  // Context loss (GPU reset, sleep/wake, too many contexts): keep the canvas
  // and rebuild once the browser hands it back.
  const onLost = (e: Event) => { e.preventDefault(); state = null; onContextChange(false); };
  const onRestore = () => { state = init(); sizeDirty = true; lastAlpha = -1; onContextChange(!!state); };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestore);

  return {
    kind: "webgl",
    resize(w, h, nextDpr) {
      sizeDirty = true;
      dpr = nextDpr;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    },
    draw(t: number, now: number, ripples: readonly Ripple[], theme: FieldTheme) {
      if (!state || gl.isContextLost()) return;
      const { u } = state;
      if (sizeDirty) {
        const bw = gl.drawingBufferWidth, bh = gl.drawingBufferHeight;
        gl.viewport(0, 0, bw, bh);
        gl.uniform2f(u.size, bw, bh);
        gl.uniform1f(u.dpr, dpr * (bw / Math.max(1, canvas.width)));
        sizeDirty = false;
      }
      gl.uniform1f(u.time, t);
      if (lastColor !== theme.css || lastAlpha !== theme.alpha) {
        const a = theme.alpha * theme.a;
        gl.uniform4f(u.color, theme.r * a, theme.g * a, theme.b * a, a);
        lastColor = theme.css;
        lastAlpha = theme.alpha;
      }
      if (ripples.length || hadRipples) {
        rippleData.fill(0);
        for (let i = 0; i < ripples.length; i++) {
          const r = ripples[i], age = (now - r.start) / 1000;
          rippleData[4 * i] = r.x;
          rippleData[4 * i + 1] = r.y;
          rippleData[4 * i + 2] = age * RIPPLE_SPEED;
          rippleData[4 * i + 3] = Math.max(0, 1 - age / RIPPLE_LIFE) * RIPPLE_GAIN;
        }
        gl.uniform4fv(u.ripple, rippleData);
        hadRipples = ripples.length > 0;
      }
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },
    dispose() {
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestore);
      if (state && !gl.isContextLost()) {
        gl.deleteProgram(state.program);
        gl.deleteBuffer(state.buffer);
        gl.deleteTexture(state.texture);
      }
      state = null;
    },
  };
}
