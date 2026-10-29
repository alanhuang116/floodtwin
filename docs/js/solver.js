// GPU implementation of the FloodTwin hydraulic solver (WebGL2 fragment
// shaders on float render targets). The scheme, variable layout and order of
// operations follow sim/solver.py exactly; tests/gpu_parity.py compares them.
//
// State texture (RGBA32F, one texel per cell):
//   r = h   water depth (m)
//   g = qx  unit discharge across the east face (m^2/s)
//   b = qy  unit discharge across the north face (m^2/s)
//   a = time the cell was last wet (s), used to draw drying ground
// Bed texture (RGBA32F): r = z (m NAVD88), g = Manning n, b = kind
//   (0 land, 1 boundary water, 2 building), a = loss capacity (m/s)
import * as THREE from 'three';

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const COMMON = /* glsl */`
precision highp float;
precision highp int;
precision highp sampler2D;
uniform ivec2 uSize;
bool inside(ivec2 c) { return c.x >= 0 && c.y >= 0 && c.x < uSize.x && c.y < uSize.y; }
bool isSea(float k) { return k > 0.5 && k < 1.5; }
bool isBuilding(float k) { return k > 1.5 && k < 2.5; }
`;

const MOMENTUM = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform float uDt, uDx, uTheta, uThetaC, uFrMax, uHdry, uG;
out vec4 outColor;
vec4 S(ivec2 c) { return inside(c) ? texelFetch(uState, c, 0) : vec4(0.0); }
vec4 Bd(ivec2 c) { return texelFetch(uBed, clamp(c, ivec2(0), uSize - 1), 0); }

float faceFlux(float qn, float qUp, float qDn, float qCross,
               float hL, vec4 bL, float hR, vec4 bR, bool edge) {
  float zL = bL.x, zR = bR.x;
  float etaL = zL + hL, etaR = zR + hR;
  float hf = max(etaL, etaR) - max(zL, zR);
  bool seaL = isSea(bL.z), seaR = isSea(bR.z);
  if (edge || isBuilding(bL.z) || isBuilding(bR.z) || (seaL && seaR) || hf < uHdry) return 0.0;
  float qstar = uTheta * qn + uThetaC * (qUp + qDn);
  float qmag = sqrt(qn * qn + qCross * qCross);
  float nf = 0.5 * (bL.y + bR.y);
  float num = qstar - uG * hf * uDt * (etaR - etaL) / uDx;
  float den = 1.0 + uG * uDt * nf * nf * qmag / pow(hf, 7.0 / 3.0);
  float q = num / den;
  float qfr = uFrMax * hf * sqrt(uG * hf);
  q = clamp(q, -qfr, qfr);
  bool donorSea = q > 0.0 ? seaL : seaR;
  if (!donorSea) {
    float hD = q > 0.0 ? hL : hR;
    float ql = hD * uDx / (4.0 * uDt);
    q = clamp(q, -ql, ql);
  }
  return q;
}

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 sC = S(c);
  vec4 sE = S(c + ivec2(1, 0)), sW = S(c - ivec2(1, 0));
  vec4 sN = S(c + ivec2(0, 1)), sS = S(c - ivec2(0, 1));
  vec4 sSE = S(c + ivec2(1, -1)), sNW = S(c + ivec2(-1, 1));
  vec4 bC = Bd(c), bE = Bd(c + ivec2(1, 0)), bN = Bd(c + ivec2(0, 1));
  float qyCross = 0.25 * (sC.z + sE.z + sS.z + sSE.z);
  float qx = faceFlux(sC.y, sW.y, sE.y, qyCross, sC.x, bC, sE.x, bE, c.x >= uSize.x - 1);
  float qxCross = 0.25 * (sC.y + sN.y + sW.y + sNW.y);
  float qy = faceFlux(sC.z, sS.z, sN.z, qxCross, sC.x, bC, sN.x, bN, c.y >= uSize.y - 1);
  outColor = vec4(sC.x, qx, qy, sC.w);
}`;

const MAX_SOURCES = 16;
const CONTINUITY = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform float uDt, uDx, uStage, uRain, uTime, uWetTh;
// point sources and sinks (pumps, inflows): xy cell, radius in cells, rate in m^3/s
uniform int uNumSources;
uniform vec4 uSources[${MAX_SOURCES}];
uniform float uSourceCells[${MAX_SOURCES}];
// localised rain cells: xy cell, radius in cells, extra rate in m/s
uniform int uNumRainCells;
uniform vec4 uRainCells[4];
out vec4 outColor;

void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 sC = texelFetch(uState, c, 0);
  float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
  float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
  vec4 b = texelFetch(uBed, c, 0);
  float rain = uRain;
  for (int k = 0; k < 4; k++) {
    if (k >= uNumRainCells) break;
    vec4 rc = uRainCells[k];
    float d = length(vec2(c) - rc.xy) / max(rc.z, 1.0);
    rain += rc.w * exp(-2.0 * d * d);
  }
  float h = sC.x + uDt * ((qxW - sC.y + qyS - sC.z) / uDx) + uDt * rain;
  float lost = min(b.w * uDt, max(h, 0.0));
  h = max(h - lost, 0.0);
  for (int k = 0; k < ${MAX_SOURCES}; k++) {
    if (k >= uNumSources) break;
    vec4 s = uSources[k];
    if (length(vec2(c) - s.xy) <= s.z) {
      float dh = s.w * uDt / (uSourceCells[k] * uDx * uDx);
      h = max(h + dh, 0.0);
    }
  }
  if (isSea(b.z)) h = max(uStage - b.x, 0.0);
  if (isBuilding(b.z)) h = 0.0;
  float wet = h > uWetTh ? uTime : sC.w;
  outColor = vec4(h, sC.y, sC.z, wet);
}`;

// Running statistics: max depth, arrival time (h > 0.10 m), max speed,
// max DEFRA hazard rating HR = d (v + 0.5) + DF.
const STATS = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform sampler2D uPrev;
uniform float uTime;
out vec4 outColor;
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = texelFetch(uState, c, 0);
  vec4 b = texelFetch(uBed, c, 0);
  vec4 p = texelFetch(uPrev, c, 0);
  if (!isSea(b.z) && !isBuilding(b.z)) {
    float h = s.x;
    float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
    float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
    vec2 q = 0.5 * vec2(s.y + qxW, s.z + qyS);
    float v = h > 0.05 ? length(q) / h : 0.0;
    float df = h > 0.25 ? 0.5 : 0.0;
    float hr = h > 0.02 ? h * (v + 0.5) + df : 0.0;
    p.x = max(p.x, h);
    if (p.y < 0.0 && h > 0.10) p.y = uTime;
    p.z = max(p.z, v);
    p.w = max(p.w, hr);
  }
  outColor = p;
}`;

// Field used to draw the water: r = water surface for rendering (extended one
// ring into dry cells so the mesh meets the terrain cleanly), g = depth,
// b, a = cell-centre velocity (m/s).
const VIS = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform float uVisTh;
out vec4 outColor;
vec4 S(ivec2 c) { return texelFetch(uState, clamp(c, ivec2(0), uSize - 1), 0); }
vec4 Bd(ivec2 c) { return texelFetch(uBed, clamp(c, ivec2(0), uSize - 1), 0); }
void main() {
  ivec2 c = ivec2(gl_FragCoord.xy);
  vec4 s = S(c), b = Bd(c);
  float h = s.x;
  float eta = b.x - 4.0;
  vec2 vel = vec2(0.0);
  if (h > uVisTh) {
    eta = b.x + h;
    vec2 q = 0.5 * vec2(s.y + S(c - ivec2(1, 0)).y, s.z + S(c - ivec2(0, 1)).z);
    vel = q / max(h, 0.05);
  } else {
    float best = -1e9;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      if (i == 0 && j == 0) continue;
      ivec2 n = c + ivec2(i, j);
      if (!inside(n)) continue;
      vec4 sn = S(n);
      if (sn.x > uVisTh) best = max(best, Bd(n).x + sn.x);
    }
    if (best > -1e8) eta = best;
  }
  outColor = vec4(eta, h, vel);
}`;

// Max of (|u| + sqrt(g h_eff)) over blocks of 4 x 4 cells; first level reads
// the state, later levels reduce the previous level.
const REDUCE0 = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform float uStage, uG;
uniform ivec2 uSrcSize;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 4;
  float cmax = 0.0, hmax = 0.0, wet = 0.0, vol = 0.0;
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 c = o + ivec2(i, j);
    if (c.x >= uSrcSize.x || c.y >= uSrcSize.y) continue;
    vec4 b = texelFetch(uBed, c, 0);
    if (b.z > 0.5) continue;
    vec4 s = texelFetch(uState, c, 0);
    float h = s.x;
    // a land cell next to boundary water can be reached at the boundary stage
    float heff = h;
    for (int k = 0; k < 4; k++) {
      ivec2 n = c + (k == 0 ? ivec2(1, 0) : k == 1 ? ivec2(-1, 0) : k == 2 ? ivec2(0, 1) : ivec2(0, -1));
      if (n.x < 0 || n.y < 0 || n.x >= uSrcSize.x || n.y >= uSrcSize.y) continue;
      if (isSea(texelFetch(uBed, n, 0).z)) heff = max(heff, uStage - b.x);
    }
    float u = 0.0;
    if (h > 1e-3) {
      float qxW = c.x > 0 ? texelFetch(uState, c - ivec2(1, 0), 0).y : 0.0;
      float qyS = c.y > 0 ? texelFetch(uState, c - ivec2(0, 1), 0).z : 0.0;
      u = length(0.5 * vec2(s.y + qxW, s.z + qyS)) / max(h, 1e-3);
    }
    cmax = max(cmax, u + sqrt(uG * max(heff, 0.0)));
    hmax = max(hmax, h);
    if (h > 0.10) wet += 1.0;
    vol += h;
  }
  outColor = vec4(cmax, hmax, wet, vol);
}`;
const REDUCE = /* glsl */`${COMMON}
uniform sampler2D uSrc;
uniform ivec2 uSrcSize;
out vec4 outColor;
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * 4;
  vec2 m = vec2(0.0), s = vec2(0.0);
  for (int j = 0; j < 4; j++) for (int i = 0; i < 4; i++) {
    ivec2 c = o + ivec2(i, j);
    if (c.x >= uSrcSize.x || c.y >= uSrcSize.y) continue;
    vec4 t = texelFetch(uSrc, c, 0);
    m = max(m, t.xy);
    s += t.zw;
  }
  outColor = vec4(m, s);
}`;

// Per-building sampling: each building owns two texels of cell indices
// (up to eight cells on the ring around its footprint). Output per building:
// r = current max depth, g = current mean water surface over the wet ring
// cells, b = historical max depth, a = mean of the historical max water surface
// over the ring cells that have been wet. The mean, not the max, keeps sloping
// ground from passing for depth when rain wets every cell.
const BUILDINGS = /* glsl */`${COMMON}
uniform sampler2D uState;
uniform sampler2D uBed;
uniform sampler2D uStats;
uniform sampler2D uSamples;
uniform ivec2 uSampleSize;
uniform int uCount, uOutWidth;
out vec4 outColor;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  int b = p.y * uOutWidth + p.x;
  if (b >= uCount) { outColor = vec4(0.0); return; }
  vec4 res = vec4(0.0, -99.0, 0.0, -99.0);
  float sCur = 0.0, nCur = 0.0, sHist = 0.0, nHist = 0.0;
  for (int t = 0; t < 2; t++) {
    int idx = 2 * b + t;
    vec4 ids = texelFetch(uSamples, ivec2(idx % uSampleSize.x, idx / uSampleSize.x), 0);
    for (int k = 0; k < 4; k++) {
      float id = ids[k];
      if (id < 0.0) continue;
      ivec2 c = ivec2(int(mod(id, float(uSize.x))), int(floor(id / float(uSize.x))));
      float z = texelFetch(uBed, c, 0).x;
      float h = texelFetch(uState, c, 0).x;
      float hm = texelFetch(uStats, c, 0).x;
      res.x = max(res.x, h);
      res.z = max(res.z, hm);
      if (h > 0.005) { sCur += z + h; nCur += 1.0; }
      if (hm > 0.005) { sHist += z + hm; nHist += 1.0; }
    }
  }
  if (nCur > 0.0) res.y = sCur / nCur;
  if (nHist > 0.0) res.w = sHist / nHist;
  outColor = res;
}`;

function floatTarget(w, h, linear = false, type = THREE.FloatType) {
  return new THREE.WebGLRenderTarget(w, h, {
    type, format: THREE.RGBAFormat,
    minFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    magFilter: linear ? THREE.LinearFilter : THREE.NearestFilter,
    wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
    depthBuffer: false, stencilBuffer: false, generateMipmaps: false,
  });
}

function mat(fragmentShader, uniforms) {
  return new THREE.RawShaderMaterial({
    glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader, uniforms,
    depthTest: false, depthWrite: false,
  });
}

export class FloodSolver {
  /**
   * @param {THREE.WebGLRenderer} renderer
   * @param {{nx:number, ny:number, dx:number, bed:Float32Array}} grid  bed is RGBA per cell, row 0 = south
   */
  constructor(renderer, grid) {
    this.renderer = renderer;
    this.nx = grid.nx; this.ny = grid.ny; this.dx = grid.dx;
    this.params = { theta: 0.8, frMax: 1.0, hDry: 1e-3, g: 9.81, alpha: 0.7, dtMax: 2.0, wetTh: 0.02, visTh: 0.015 };
    this.time = 0; this.stage = -10; this.rain = 0;
    this.sources = []; this.rainCells = [];
    this.cmax = 0; this.hmax = 0; this.wetArea = 0; this.volume = 0; this._reducing = false;

    const size = new THREE.Vector2(this.nx, this.ny);
    this.bedTex = new THREE.DataTexture(grid.bed, this.nx, this.ny, THREE.RGBAFormat, THREE.FloatType);
    this.bedTex.minFilter = this.bedTex.magFilter = THREE.NearestFilter;
    this.bedTex.needsUpdate = true;

    this.a = floatTarget(this.nx, this.ny);
    this.b = floatTarget(this.nx, this.ny);
    this.statsA = floatTarget(this.nx, this.ny);
    this.statsB = floatTarget(this.nx, this.ny);
    // half float so linear filtering is available everywhere (drawn, not computed on)
    this.vis = floatTarget(this.nx, this.ny, true, THREE.HalfFloatType);

    const iv = new THREE.Vector2(this.nx, this.ny);
    const isize = { value: iv };
    this.mMom = mat(MOMENTUM, { uSize: isize, uState: { value: null }, uBed: { value: this.bedTex },
      uDt: { value: 1 }, uDx: { value: this.dx }, uTheta: { value: 0.8 }, uThetaC: { value: 0.1 }, uFrMax: { value: 1 }, uHdry: { value: 1e-3 }, uG: { value: 9.81 } });
    this.mCon = mat(CONTINUITY, { uSize: isize, uState: { value: null }, uBed: { value: this.bedTex },
      uDt: { value: 1 }, uDx: { value: this.dx }, uStage: { value: -10 }, uRain: { value: 0 }, uTime: { value: 0 }, uWetTh: { value: 0.02 },
      uNumSources: { value: 0 }, uSources: { value: Array.from({ length: MAX_SOURCES }, () => new THREE.Vector4()) },
      uSourceCells: { value: new Array(MAX_SOURCES).fill(1) },
      uNumRainCells: { value: 0 }, uRainCells: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) } });
    this.mStats = mat(STATS, { uSize: isize, uState: { value: null }, uBed: { value: this.bedTex }, uPrev: { value: null }, uTime: { value: 0 } });
    this.mVis = mat(VIS, { uSize: isize, uState: { value: null }, uBed: { value: this.bedTex }, uVisTh: { value: 0.015 } });
    this.mRed0 = mat(REDUCE0, { uSize: isize, uState: { value: null }, uBed: { value: this.bedTex }, uStage: { value: -10 }, uG: { value: 9.81 }, uSrcSize: { value: iv } });
    this.mRed = mat(REDUCE, { uSize: isize, uSrc: { value: null }, uSrcSize: { value: new THREE.Vector2() } });

    // reduction pyramid
    this.redTargets = [];
    let w = this.nx, h = this.ny;
    while (w > 4 || h > 4) {
      w = Math.ceil(w / 4); h = Math.ceil(h / 4);
      this.redTargets.push(floatTarget(w, h));
    }
    if (!this.redTargets.length) this.redTargets.push(floatTarget(1, 1));
    this.redBuffer = new Float32Array(this.redTargets.at(-1).width * this.redTargets.at(-1).height * 4);

    this.quad = new THREE.Mesh(new THREE.BufferGeometry(), this.mMom);
    this.quad.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.reset();
  }

  _pass(material, target) {
    this.quad.material = material;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.scene, this.camera);
  }

  _clear(target, value = [0, 0, 0, 0]) {
    const r = this.renderer;
    const prev = r.getClearColor(new THREE.Color()); const pa = r.getClearAlpha();
    r.setRenderTarget(target);
    r.setClearColor(new THREE.Color(value[0], value[1], value[2]), value[3]);
    r.clear(true, false, false);
    r.setClearColor(prev, pa);
  }

  reset() {
    this.time = 0;
    this._clear(this.a); this._clear(this.b);
    this._clear(this.statsA, [0, -1, 0, 0]); this._clear(this.statsB, [0, -1, 0, 0]);
    this.cmax = 0; this.hmax = 0; this.wetArea = 0; this.volume = 0;
    this.updateVis();
    this.renderer.setRenderTarget(null);
  }

  /** Replace the bed (after barriers, roughness or drainage changes). */
  setBed(bed) {
    this.bedTex.image.data.set(bed);
    this.bedTex.needsUpdate = true;
  }

  setSources(list) {
    this.sources = list.slice(0, MAX_SOURCES);
    const u = this.mCon.uniforms;
    u.uNumSources.value = this.sources.length;
    this.sources.forEach((s, k) => {
      u.uSources.value[k].set(s.i, s.j, s.r, s.rate);
      u.uSourceCells.value[k] = Math.max(1, s.cells || Math.round(Math.PI * s.r * s.r) || 1);
    });
  }

  setRainCells(list) {
    this.rainCells = list.slice(0, 4);
    const u = this.mCon.uniforms;
    u.uNumRainCells.value = this.rainCells.length;
    this.rainCells.forEach((c, k) => u.uRainCells.value[k].set(c.i, c.j, c.r, c.rate));
  }

  /** Stable time step from the last reduction (with a safety margin). */
  stableDt() {
    const p = this.params;
    const c = Math.max(this.cmax * 1.15, Math.sqrt(p.g * Math.max(0.05, this.stage - this.minCoastZ || 0.05)));
    return Math.min(p.dtMax, p.alpha * this.dx / Math.max(c, 0.05));
  }

  step(dt) {
    const p = this.params;
    const um = this.mMom.uniforms, uc = this.mCon.uniforms;
    um.uState.value = this.a.texture; um.uDt.value = dt; um.uTheta.value = p.theta; um.uThetaC.value = (1 - p.theta) * 0.5; um.uFrMax.value = p.frMax;
    um.uHdry.value = p.hDry; um.uG.value = p.g;
    this._pass(this.mMom, this.b);
    uc.uState.value = this.b.texture; uc.uDt.value = dt; uc.uStage.value = this.stage; uc.uRain.value = this.rain;
    this.time += dt;
    uc.uTime.value = this.time; uc.uWetTh.value = p.wetTh;
    this._pass(this.mCon, this.a);
  }

  updateStats() {
    const u = this.mStats.uniforms;
    u.uState.value = this.a.texture; u.uPrev.value = this.statsA.texture; u.uTime.value = this.time;
    this._pass(this.mStats, this.statsB);
    [this.statsA, this.statsB] = [this.statsB, this.statsA];
  }

  updateVis() {
    const u = this.mVis.uniforms;
    u.uState.value = this.a.texture; u.uVisTh.value = this.params.visTh;
    this._pass(this.mVis, this.vis);
  }

  /** Start an asynchronous reduction for the wave speed; updates cmax when done. */
  reduce() {
    if (this._reducing) return;
    const u0 = this.mRed0.uniforms;
    u0.uState.value = this.a.texture; u0.uStage.value = this.stage; u0.uG.value = this.params.g;
    this._pass(this.mRed0, this.redTargets[0]);
    for (let k = 1; k < this.redTargets.length; k++) {
      const src = this.redTargets[k - 1];
      this.mRed.uniforms.uSrc.value = src.texture;
      this.mRed.uniforms.uSrcSize.value.set(src.width, src.height);
      this._pass(this.mRed, this.redTargets[k]);
    }
    const last = this.redTargets.at(-1);
    this._reducing = true;
    this.renderer.readRenderTargetPixelsAsync(last, 0, 0, last.width, last.height, this.redBuffer).then(buf => {
      this._readReduction(buf); this._reducing = false;
    }).catch(() => { this._reducing = false; });
  }

  /** Synchronous reduction (tests and initial dt). */
  reduceSync() {
    const u0 = this.mRed0.uniforms;
    u0.uState.value = this.a.texture; u0.uStage.value = this.stage; u0.uG.value = this.params.g;
    this._pass(this.mRed0, this.redTargets[0]);
    for (let k = 1; k < this.redTargets.length; k++) {
      const src = this.redTargets[k - 1];
      this.mRed.uniforms.uSrc.value = src.texture;
      this.mRed.uniforms.uSrcSize.value.set(src.width, src.height);
      this._pass(this.mRed, this.redTargets[k]);
    }
    const last = this.redTargets.at(-1);
    this.renderer.readRenderTargetPixels(last, 0, 0, last.width, last.height, this.redBuffer);
    this._readReduction(this.redBuffer);
    return this.cmax;
  }

  _readReduction(buf) {
    let c = 0, h = 0, wet = 0, vol = 0;
    for (let k = 0; k < buf.length; k += 4) { c = Math.max(c, buf[k]); h = Math.max(h, buf[k + 1]); wet += buf[k + 2]; vol += buf[k + 3]; }
    this.cmax = c; this.hmax = h;
    this.wetArea = wet * this.dx * this.dx;        // m2 of land deeper than 0.10 m
    this.volume = vol * this.dx * this.dx;         // m3 of water on land
  }

  /** Read the full state (tests, export). Returns Float32Array RGBA, row 0 = south. */
  readState() {
    const out = new Float32Array(this.nx * this.ny * 4);
    this.renderer.readRenderTargetPixels(this.a, 0, 0, this.nx, this.ny, out);
    return out;
  }

  readStats() {
    const out = new Float32Array(this.nx * this.ny * 4);
    this.renderer.readRenderTargetPixels(this.statsA, 0, 0, this.nx, this.ny, out);
    return out;
  }

  /** Upload a full state (h, qx, qy, wet) — used to restore snapshots. */
  writeState(data) {
    const t = new THREE.DataTexture(data, this.nx, this.ny, THREE.RGBAFormat, THREE.FloatType);
    t.needsUpdate = true;
    const m = mat(`${COMMON}\nuniform sampler2D uSrc;\nout vec4 outColor;\nvoid main(){ outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`,
      { uSize: { value: new THREE.Vector2(this.nx, this.ny) }, uSrc: { value: t } });
    this._pass(m, this.a);
    m.dispose(); t.dispose();
  }

  // ---- snapshots (timeline scrubbing) ----
  _copy(src, dst) {
    if (!this.mCopy) this.mCopy = mat(`${COMMON}
uniform sampler2D uSrc;
out vec4 outColor;
void main(){ outColor = texelFetch(uSrc, ivec2(gl_FragCoord.xy), 0); }`,
      { uSize: { value: new THREE.Vector2(this.nx, this.ny) }, uSrc: { value: null } });
    this.mCopy.uniforms.uSrc.value = src;
    this._pass(this.mCopy, dst);
  }

  /** Copy of the state and running statistics in half precision (8 bytes per cell each). */
  snapshot() {
    const snap = { time: this.time, state: floatTarget(this.nx, this.ny, false, THREE.HalfFloatType),
      stats: floatTarget(this.nx, this.ny, false, THREE.HalfFloatType) };
    this._copy(this.a.texture, snap.state);
    this._copy(this.statsA.texture, snap.stats);
    return snap;
  }

  restore(snap) {
    this._copy(snap.state.texture, this.a);
    this._copy(snap.stats.texture, this.statsA);
    this.time = snap.time;
    this.updateVis();
  }

  /** Asynchronous read of one cell: depth, cell-centre velocity and running statistics. */
  readCell(i, j) {
    if (this._cellReading || i < 1 || j < 1 || i >= this.nx || j >= this.ny) return null;
    this._cellReading = true;
    const a = new Float32Array(16), st = new Float32Array(4);
    const r = this.renderer;
    return Promise.all([
      r.readRenderTargetPixelsAsync(this.a, i - 1, j - 1, 2, 2, a),
      r.readRenderTargetPixelsAsync(this.statsA, i, j, 1, 1, st),
    ]).then(() => {
      this._cellReading = false;
      // a: (i-1, j-1), (i, j-1), (i-1, j), (i, j)
      const h = a[12], qx = 0.5 * (a[13] + a[8 + 1]), qy = 0.5 * (a[14] + a[4 + 2]);
      return { h, u: h > 0.01 ? qx / h : 0, v: h > 0.01 ? qy / h : 0, maxDepth: st[0], arrival: st[1], maxSpeed: st[2], maxHazard: st[3] };
    }).catch(() => { this._cellReading = false; return null; });
  }

  // ---- building sampling ----
  setBuildingSamples(ids, count) {
    // ids: Float32Array of length count * 8 (cell index or -1)
    const nTex = count * 2;
    const sw = 1024, sh = Math.max(1, Math.ceil(nTex / sw));
    const data = new Float32Array(sw * sh * 4).fill(-1);
    data.set(ids.subarray(0, count * 8));
    this.sampleTex?.dispose();
    this.sampleTex = new THREE.DataTexture(data, sw, sh, THREE.RGBAFormat, THREE.FloatType);
    this.sampleTex.minFilter = this.sampleTex.magFilter = THREE.NearestFilter;
    this.sampleTex.needsUpdate = true;
    this.bCount = count;
    this.bOutW = 256; const bh = Math.max(1, Math.ceil(count / 256));
    this.bTarget?.dispose();
    this.bTarget = floatTarget(this.bOutW, bh);
    this.bBuffer = new Float32Array(this.bOutW * bh * 4);
    this.mBld = mat(BUILDINGS, { uSize: { value: new THREE.Vector2(this.nx, this.ny) }, uState: { value: null }, uBed: { value: this.bedTex },
      uStats: { value: null }, uSamples: { value: this.sampleTex }, uSampleSize: { value: new THREE.Vector2(sw, sh) },
      uCount: { value: count }, uOutWidth: { value: this.bOutW } });
    this._bReading = false;
  }

  /** Asynchronously sample all buildings; resolves with the result buffer. */
  sampleBuildings() {
    if (!this.mBld || this._bReading) return null;
    const u = this.mBld.uniforms;
    u.uState.value = this.a.texture; u.uStats.value = this.statsA.texture;
    this._pass(this.mBld, this.bTarget);
    this._bReading = true;
    return this.renderer.readRenderTargetPixelsAsync(this.bTarget, 0, 0, this.bTarget.width, this.bTarget.height, this.bBuffer)
      .then(buf => { this._bReading = false; return buf; })
      .catch(e => { this._bReading = false; throw e; });
  }

  /** Synchronous building sampling (tests and exports). */
  sampleBuildingsSync() {
    const u = this.mBld.uniforms;
    u.uState.value = this.a.texture; u.uStats.value = this.statsA.texture;
    this._pass(this.mBld, this.bTarget);
    this.renderer.readRenderTargetPixels(this.bTarget, 0, 0, this.bTarget.width, this.bTarget.height, this.bBuffer);
    return this.bBuffer;
  }

  dispose() {
    [this.a, this.b, this.statsA, this.statsB, this.vis, ...this.redTargets, this.bTarget].forEach(t => t?.dispose());
    [this.mMom, this.mCon, this.mStats, this.mVis, this.mRed0, this.mRed, this.mBld, this.mCopy].forEach(m => m?.dispose());
    this.bedTex.dispose(); this.sampleTex?.dispose();
  }
}

export { MAX_SOURCES };
