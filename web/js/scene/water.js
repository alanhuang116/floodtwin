// Water: the simulated free surface, drawn with a physically based material.
// Geometry follows the solver's water surface every frame. Shading combines
// refraction of the scene behind the water with Beer-Lambert absorption,
// Fresnel reflection (planar mirror or sky), sun glints, waves advected by the
// simulated velocity, foam in fast or supercritical flow and rain ripples.
// A cut face along the tile edges shows the water depth in section.
import * as THREE from 'three';
import { RAMPS_GLSL } from './terrain.js';

function lcg(seed) {
  let s = seed % 2147483647;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Tileable wave normal map: sum of cosines with integer wave numbers. */
function makeWaveNormals(size, seed) {
  const rnd = lcg(seed);
  const waves = [];
  while (waves.length < 60) {
    const mag = 2 + Math.floor(rnd() * rnd() * 34);
    const ang = rnd() * Math.PI * 2;
    const kx = Math.round(Math.cos(ang) * mag), ky = Math.round(Math.sin(ang) * mag);
    if (!kx && !ky) continue;
    waves.push([kx, ky, Math.pow(Math.hypot(kx, ky), -1.75), rnd() * Math.PI * 2]);
  }
  const n = size * size, gx = new Float32Array(n), gy = new Float32Array(n), hh = new Float32Array(n);
  let gmax = 0, hmin = 1e9, hmax = -1e9;
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const u = i / size, v = j / size;
    let h = 0, dx = 0, dy = 0;
    for (const [kx, ky, a, p] of waves) {
      const ph = 2 * Math.PI * (kx * u + ky * v) + p;
      h += a * Math.cos(ph);
      const d = -a * Math.sin(ph) * 2 * Math.PI;
      dx += d * kx; dy += d * ky;
    }
    const k = j * size + i;
    gx[k] = dx; gy[k] = dy; hh[k] = h;
    gmax = Math.max(gmax, Math.abs(dx), Math.abs(dy)); hmin = Math.min(hmin, h); hmax = Math.max(hmax, h);
  }
  const data = new Uint8Array(n * 4), s = 1.6 / gmax;
  for (let k = 0; k < n; k++) {
    const x = -gx[k] * s, y = -gy[k] * s, l = Math.hypot(x, y, 1);
    data[4 * k] = (x / l * 0.5 + 0.5) * 255; data[4 * k + 1] = (y / l * 0.5 + 0.5) * 255;
    data[4 * k + 2] = (1 / l * 0.5 + 0.5) * 255; data[4 * k + 3] = (hh[k] - hmin) / (hmax - hmin) * 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

/** Tileable foam pattern: cellular edges with fine grain. */
function makeFoam(size, seed) {
  const rnd = lcg(seed), C = 7;
  const pts = [];
  for (let j = 0; j < C; j++) for (let i = 0; i < C; i++) pts.push([(i + rnd()) / C, (j + rnd()) / C]);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    let f1 = 9, f2 = 9;
    const ci = Math.floor(u * C), cj = Math.floor(v * C);
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const ii = (ci + di + C) % C, jj = (cj + dj + C) % C;
      const p = pts[jj * C + ii];
      // wrapped neighbours are shifted by a whole tile so the pattern tiles
      const px = p[0] + Math.floor((ci + di) / C), py = p[1] + Math.floor((cj + dj) / C);
      const d = Math.hypot(u - px, v - py);
      if (d < f1) { f2 = f1; f1 = d; } else if (d < f2) f2 = d;
    }
    const edge = Math.min(1, (f2 - f1) * C * 2.2);
    const grain = rnd();
    const val = Math.max(0, Math.min(1, (1 - edge) * 0.85 + grain * 0.25 - 0.1));
    const k = 4 * (y * size + x);
    data[k] = data[k + 1] = data[k + 2] = val * 255; data[k + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
  t.generateMipmaps = true; t.needsUpdate = true;
  return t;
}

const PARS = /* glsl */`
uniform sampler2D uVis, uRiver, uStats, uNormalTex, uFoamTex, uSceneColor, uSceneDepth, uRefl;
uniform vec2 uDomain, uVisTexel, uResolution, uWindDir, uRiverFlow;
uniform mat4 uReflMatrix;
uniform float uTime, uRain, uStorm, uReflOn, uFlowScale, uTEnd, uRefrOn, uAnalysisAlpha, uDay;
uniform int uMode;
varying vec2 vTUv;
varying vec3 vWPos;
${RAMPS_GLSL}
float wHash(vec2 p) { p = fract(p * vec2(127.1, 311.7)); p += dot(p, p + 19.19); return fract(p.x * p.y); }
// expanding rings from raindrops, one drop per cell with random phase
vec2 rainRipples(vec2 p, float t) {
  vec2 cell = floor(p), n = vec2(0.0);
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec2 c = cell + vec2(float(i), float(j));
    float r0 = wHash(c);
    vec2 ctr = c + 0.5 + 0.7 * (vec2(wHash(c + 3.7), wHash(c + 9.1)) - 0.5);
    float tt = fract(t * 1.1 + r0);
    vec2 d = p - ctr;
    float r = length(d);
    float x = r - tt * 1.15;
    float amp = (1.0 - tt) * (1.0 - tt);
    float w = sin(x * 34.0) * exp(-x * x * 90.0) * amp * smoothstep(1.2, 0.2, r);
    n += d / max(r, 1e-3) * w;
  }
  return n;
}`;

export class Water {
  constructor(data, shared) {
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H;
    this.normalTex = makeWaveNormals(256, 7);
    this.foamTex = makeFoam(256, 11);
    const blank = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1); blank.needsUpdate = true;
    const u = this.uniforms = {
      uVis: shared.uVis, uStats: shared.uStats, uMode: shared.uMode, uDomain: shared.uDomain, uTEnd: shared.uTEnd,
      uTime: shared.uTime, uRain: shared.uRainVis, uDay: shared.uDay,
      uVisTexel: { value: new THREE.Vector2(1 / 1014, 1 / 928) },
      uRiver: { value: blank }, uNormalTex: { value: this.normalTex }, uFoamTex: { value: this.foamTex },
      uSceneColor: { value: blank }, uSceneDepth: { value: blank }, uResolution: { value: new THREE.Vector2(1, 1) },
      uRefl: { value: blank }, uReflMatrix: { value: new THREE.Matrix4() }, uReflOn: { value: 0 }, uRefrOn: { value: 1 },
      uStorm: { value: 0.5 }, uWindDir: { value: new THREE.Vector2(-0.92, 0.38) }, uRiverFlow: { value: new THREE.Vector2() },
      uFlowScale: { value: 1 }, uAnalysisAlpha: { value: 0.9 },
    };

    const mat = new THREE.MeshPhysicalMaterial({ color: 0x0b1a1c, roughness: 0.05, metalness: 0, ior: 1.333,
      specularIntensity: 1, envMapIntensity: 1, transparent: true, depthWrite: true });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uVis, uRiver;
uniform vec2 uDomain;
uniform float uTime, uStorm;
varying vec2 vTUv;
varying vec3 vWPos;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vTUv = vec2((position.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - position.z) / uDomain.y);
  float eta = texture(uVis, vTUv).r;
  float riv = texture(uRiver, vTUv).r;
  // long, low swell on the river (storms only)
  float sw = sin(dot(position.xz, vec2(0.031, 0.047)) + uTime * 1.05) * 0.6 + sin(dot(position.xz, vec2(-0.052, 0.021)) + uTime * 1.42) * 0.4;
  transformed.y = eta + sw * 0.32 * uStorm * riv;
  vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;`);
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>\n${PARS}`)
        .replace('#include <map_fragment>', /* glsl */`#include <map_fragment>
  vec4 vs = texture2D(uVis, vTUv);
  float wh = vs.g;
  float river = texture2D(uRiver, vTUv).r;
  vec2 vel = mix(vs.ba, uRiverFlow, river);
  float speed = length(vel);
  vec2 wp = vec2(vWPos.x, -vWPos.z);
  vec3 Vw = normalize(cameraPosition - vWPos);

  // thickness of water along the view ray, from the opaque depth copy
  vec2 suv = gl_FragCoord.xy / uResolution;
  float ownD = vViewPosition.z;
  float sceneD = texture2D(uSceneDepth, suv).r;
  float rayK = length(vViewPosition) / max(vViewPosition.z, 1e-3);
  float thick = clamp(sceneD - ownD, 0.0, 400.0) * rayK;
  float dv = thick * max(abs(Vw.y), 0.05);           // vertical depth estimate

  // large-scale slope of the simulated surface
  float eL = texture2D(uVis, vTUv - vec2(uVisTexel.x, 0.0)).r, eR = texture2D(uVis, vTUv + vec2(uVisTexel.x, 0.0)).r;
  float eS = texture2D(uVis, vTUv - vec2(0.0, uVisTexel.y)).r, eN = texture2D(uVis, vTUv + vec2(0.0, uVisTexel.y)).r;
  vec2 grad = vec2(eR - eL, eN - eS) / (2.0 * uVisTexel * uDomain);
  grad = clamp(grad, vec2(-0.08), vec2(0.08));

  // waves: flow-advected detail (two phases) plus wind waves on the river
  float cyc = 5.0;
  float ph0 = fract(uTime / cyc), ph1 = fract(uTime / cyc + 0.5);
  float fw0 = 1.0 - abs(2.0 * ph0 - 1.0);
  vec2 adv = vel * uFlowScale * cyc;
  vec4 a0 = texture2D(uNormalTex, (wp - adv * ph0) / 7.0 + vec2(0.13, 0.71));
  vec4 a1 = texture2D(uNormalTex, (wp - adv * ph1) / 7.0 + vec2(0.57, 0.29));
  vec3 nFlow = normalize(mix(a1.xyz, a0.xyz, fw0) * 2.0 - 1.0);
  vec4 b0 = texture2D(uNormalTex, wp / 2.3 + uWindDir * uTime * 0.11);
  vec3 nRip = b0.xyz * 2.0 - 1.0;
  // three wind-wave octaves at unrelated scales and headings so the tiling never lines up
  mat2 rotA = mat2(0.8, 0.6, -0.6, 0.8), rotB = mat2(0.28, -0.96, 0.96, 0.28);
  vec4 c0 = texture2D(uNormalTex, (rotA * wp) / 23.0 + uWindDir * uTime * (0.034 + 0.03 * uStorm) + vec2(0.31, 0.77));
  vec4 c1 = texture2D(uNormalTex, (rotB * wp) / 71.0 + uWindDir * uTime * (0.018 + 0.02 * uStorm) + vec2(0.71, 0.19));
  vec4 c2 = texture2D(uNormalTex, wp / 233.0 + uWindDir * uTime * 0.008 + vec2(0.11, 0.53));
  float fwp = length(fwidth(wp));
  float nearW = smoothstep(4.0, 0.6, fwp);
  vec2 sw0 = (rotA * (c0.xy * 2.0 - 1.0)) * nearW, sw1 = rotB * (c1.xy * 2.0 - 1.0), sw2 = c2.xy * 2.0 - 1.0;
  vec3 nWind = vec3(sw0 * 0.55 + sw1 * 0.35 + sw2 * 0.3, 1.0);
  float sFlow = (0.10 + clamp(speed * 0.45, 0.0, 0.75)) * (1.0 - river);
  float sRip = (0.10 + 0.25 * uStorm) * smoothstep(3.0, 0.4, fwp);
  float sWind = river * (0.16 + 0.42 * uStorm);
  vec2 slope = nFlow.xy * sFlow + nRip.xy * sRip + nWind.xy * sWind;
  float rainVis = uRain * smoothstep(0.9, 0.12, fwp);
  if (rainVis > 0.001) slope += rainRipples(wp / 0.9, uTime) * 0.55 * rainVis + rainRipples(wp / 0.6 + 7.3, uTime * 1.3) * 0.35 * rainVis;
  slope *= smoothstep(0.0, 0.03, dv + river);         // calm in the thinnest film
  vec3 wN = normalize(vec3(-grad.x + slope.x, 1.0, grad.y - slope.y));
  float NdV = clamp(dot(wN, Vw), 0.0, 1.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // foam: supercritical or fast shallow flow, the leading edge of moving water, storm whitecaps
  float fr = speed / sqrt(9.81 * max(wh, 0.02));
  float fA = texture2D(uFoamTex, (wp - adv * ph0) / 5.0).r, fB = texture2D(uFoamTex, (wp - adv * ph1) / 5.0 + 0.5).r;
  float fpat = mix(fB, fA, fw0);
  float foam = smoothstep(0.75, 1.7, fr) * smoothstep(0.03, 0.2, wh) * (1.0 - river);
  foam += smoothstep(0.12, 0.0, dv) * smoothstep(0.2, 0.9, speed) * (1.0 - river);
  float crest = c0.a * 0.45 + c1.a * 0.35 + c2.a * 0.2;
  foam += river * smoothstep(0.86 - 0.1 * uStorm, 0.99, crest) * uStorm * 0.7;
  foam = clamp(foam, 0.0, 1.0) * smoothstep(0.30, 0.62, fpat + 0.25 * foam);

  // absorption and scattering: estuary water in the river, sediment-laden flood water on land
  vec3 sigma = mix(vec3(3.0, 3.3, 3.9), vec3(1.9, 1.35, 1.3), river);
  vec3 albedo = mix(vec3(0.195, 0.162, 0.112), vec3(0.022, 0.042, 0.043), river);
  vec3 T = exp(-sigma * (thick + dv));

  // refraction of the opaque scene
  vec3 wNv = normalize((viewMatrix * vec4(wN, 0.0)).xyz);
  vec2 roff = wNv.xy * 0.035 * clamp(dv * 1.5, 0.0, 1.0) * uRefrOn;
  if (texture2D(uSceneDepth, suv + roff).r < ownD) roff = vec2(0.0);
  vec3 refr = texture2D(uSceneColor, suv + roff).rgb;

  // planar reflection
  vec4 rp = uReflMatrix * vec4(vWPos, 1.0);
  vec2 ruv = rp.xy / max(rp.w, 1e-4) + wN.xz * vec2(0.6, -0.6) * 0.06;
  vec3 wRefl = texture2D(uRefl, clamp(ruv, vec2(0.001), vec2(0.999))).rgb;
  float wReflW = uReflOn;

  vec3 wEmit = refr * T * (1.0 - fres);
  diffuseColor.rgb = (albedo * (1.0 - T) + vec3(0.82, 0.80, 0.74) * foam) * (0.35 + 0.65 * uDay);
  float wRough = mix(0.035 + 0.05 * uStorm * river + 0.08 * uRain, 0.65, foam);
  float edgeA = smoothstep(0.0, 0.035, dv) * smoothstep(0.0, 0.006, wh + river);
  diffuseColor.a = edgeA;

  // analysis views colour the water on land by the simulated field
  if (uMode >= 1 && uMode <= 3) {
    float hr = wh > 0.02 ? wh * (speed + 0.5) + (wh > 0.25 ? 0.5 : 0.0) : 0.0;
    vec3 ac = uMode == 1 ? rampDepth(wh) : uMode == 2 ? rampSpeed(speed) : rampHazard(hr);
    if (uMode == 1) {
      float cl = abs(fract(wh / 0.5) - 0.5) / max(fwidth(wh / 0.5), 1e-4);
      ac *= 1.0 - 0.28 * (1.0 - smoothstep(0.6, 1.4, cl)) * step(0.25, wh);
    }
    vec3 riverC = vec3(0.045, 0.060, 0.072);
    float landW = 1.0 - river;
    diffuseColor.rgb = mix(diffuseColor.rgb * 0.35 + riverC * 0.5, ac, landW);
    wEmit = mix(wEmit * 0.35, ac * 0.22, landW);
    wRough = mix(0.2, 0.42, landW);
    wReflW *= 0.4 * river;
    diffuseColor.a = mix(edgeA, smoothstep(0.0, 0.004, wh) * uAnalysisAlpha, landW);
  } else if (uMode >= 4) {
    // footprints are drawn on the ground; keep the water as a light glaze
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.30, 0.42, 0.50), 0.4 * (1.0 - river));
    diffuseColor.a = edgeA * mix(0.55, 1.0, river);
    wEmit *= mix(0.5, 1.0, river);
  }`)
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = wRough;')
        .replace('#include <normal_fragment_maps>', '  normal = wNv;')
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n  totalEmissiveRadiance += wEmit;')
        .replace('#include <lights_fragment_end>', `#if defined( RE_IndirectSpecular )
  radiance = mix(radiance, wRefl, wReflW);
#endif
#include <lights_fragment_end>`);
    };
    this.material = mat;

    // surface mesh, split into chunks so off-screen parts are culled
    this.group = new THREE.Group();
    this.group.name = 'water';
    const step = 4, NX = Math.round(W / step), NY = Math.round(H / step), CH = 8;
    for (let cj = 0; cj < CH; cj++) for (let ci = 0; ci < CH; ci++) {
      const i0 = Math.floor((ci * NX) / CH), i1 = Math.floor(((ci + 1) * NX) / CH);
      const j0 = Math.floor((cj * NY) / CH), j1 = Math.floor(((cj + 1) * NY) / CH);
      const vx = i1 - i0 + 1, vy = j1 - j0 + 1;
      const pos = new Float32Array(vx * vy * 3), nor = new Float32Array(vx * vy * 3);
      for (let j = 0; j < vy; j++) for (let i = 0; i < vx; i++) {
        const k = j * vx + i, x = (i0 + i) * step, y = (j0 + j) * step;
        pos[3 * k] = x - W / 2; pos[3 * k + 1] = 0; pos[3 * k + 2] = H / 2 - y;
        nor[3 * k + 1] = 1;
      }
      const idx = new Uint32Array((vx - 1) * (vy - 1) * 6);
      let o = 0;
      for (let j = 0; j < vy - 1; j++) for (let i = 0; i < vx - 1; i++) {
        const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
        idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
      g.setIndex(new THREE.BufferAttribute(idx, 1));
      g.boundingBox = new THREE.Box3(new THREE.Vector3(i0 * step - W / 2, -40, H / 2 - j1 * step), new THREE.Vector3(i1 * step - W / 2, 80, H / 2 - j0 * step));
      g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
      const m = new THREE.Mesh(g, mat);
      m.receiveShadow = true; m.renderOrder = 2;
      this.group.add(m);
    }

    this.curtain = this._makeCurtain(data, shared);
  }

  _makeCurtain(data, shared) {
    const W = this.W, H = this.H, step = 4;
    const ring = [];
    for (let x = 0; x <= W; x += step) ring.push([x, 0, 0, -1]);
    for (let y = 0; y <= H; y += step) ring.push([W, y, 1, 0]);
    for (let x = W; x >= 0; x -= step) ring.push([x, H, 0, 1]);
    for (let y = H; y >= 0; y -= step) ring.push([0, y, -1, 0]);
    const m = data.meta, dem = data.dem, cols = m.dem_cols, rows = m.dem_rows, res = m.dem_res;
    const zAt = (x, y) => {
      const i = Math.min(cols - 1, Math.max(0, Math.floor(x / res))), j = Math.min(rows - 1, Math.max(0, Math.floor(y / res)));
      return dem[j * cols + i];
    };
    const pos = [], uv = [], side = [], idx = [];
    // break the strip at the corners so each side is a separate quad strip
    let start = 0;
    ring.forEach(([x, y, nx, ny], k) => {
      const z = zAt(Math.min(x, W - 0.01), Math.min(y, H - 0.01));
      const u0 = Math.min(Math.max(x / W, 0.0005), 0.9995), v0 = Math.min(Math.max(y / H, 0.0005), 0.9995);
      pos.push(x - W / 2, z, H / 2 - y, x - W / 2, z, H / 2 - y);
      uv.push(u0, v0, u0, v0);
      side.push(0, 1);
      const sameSide = k > start && (ring[k - 1][2] === nx && ring[k - 1][3] === ny);
      if (sameSide) { const a = 2 * (k - 1), b = 2 * k; idx.push(a, b, a + 1, b, b + 1, a + 1); } else start = k;
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('aUv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aTop', new THREE.Float32BufferAttribute(side, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.boundingSphere.radius += 100;
    const mat = new THREE.ShaderMaterial({
      uniforms: { uVis: shared.uVis, uRiver: this.uniforms.uRiver, uDay: shared.uDay, uFogColor: shared.uFogColor, uFogDensity: shared.uFogDensity },
      vertexShader: /* glsl */`
uniform sampler2D uVis;
attribute vec2 aUv;
attribute float aTop;
varying float vDepth, vRiver;
varying vec2 vUv;
varying float vFogDepth;
uniform sampler2D uRiver;
void main() {
  vec4 vs = texture2D(uVis, aUv);
  vec3 p = position;
  float top = max(vs.r, p.y);
  vDepth = aTop > 0.5 ? 0.0 : top - p.y;
  if (aTop > 0.5) p.y = top;
  vRiver = texture2D(uRiver, aUv).r;
  vUv = aUv;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */`
uniform float uDay, uFogDensity;
uniform vec3 uFogColor;
varying float vDepth, vRiver;
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vec3 top = mix(vec3(0.23, 0.19, 0.12), vec3(0.06, 0.15, 0.16), vRiver);
  vec3 deep = mix(vec3(0.07, 0.05, 0.03), vec3(0.008, 0.03, 0.04), vRiver);
  vec3 c = mix(top, deep, 1.0 - exp(-vDepth * 0.22));
  c *= 0.25 + 0.95 * uDay;
  float f = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  gl_FragColor = vec4(mix(c, uFogColor, f), 0.94);
}`,
      transparent: true, depthWrite: true, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(g, mat);
    mesh.renderOrder = 1; mesh.name = 'water-section';
    return mesh;
  }

  /** River mask at simulation resolution (1 = boundary water), softened for blending. */
  setRiver(g) {
    const { nx, ny, kind } = g;
    const a = new Float32Array(nx * ny);
    for (let c = 0; c < nx * ny; c++) a[c] = kind[c] === 1 ? 1 : 0;
    const b = new Uint8Array(nx * ny);
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      let s = 0, n = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= nx || jj >= ny) continue;
        s += a[jj * nx + ii]; n++;
      }
      b[j * nx + i] = Math.round((s / n) * 255);
    }
    this.riverTex?.dispose();
    const t = new THREE.DataTexture(b, nx, ny, THREE.RedFormat, THREE.UnsignedByteType);
    t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
    this.riverTex = t;
    this.uniforms.uRiver.value = t;
    this.uniforms.uVisTexel.value.set(1 / nx, 1 / ny);
    // along-channel direction of the Hudson, from the river centre line
    const mid = g.riverMid, j0 = Math.floor(ny * 0.1), j1 = Math.floor(ny * 0.9);
    const ddx = (mid[j1] - mid[j0]) * g.dx, ddy = (j1 - j0) * g.dx;
    const l = Math.hypot(ddx, ddy);
    this.riverDir = new THREE.Vector2(ddx / l, ddy / l);
  }

  /** Tidal current on the river from the rate of change of the boundary level (m/s). */
  setRiverCurrent(dStageDt) {
    const s = THREE.MathUtils.clamp(dStageDt * 4500, -1.1, 1.1);
    if (this.riverDir) this.uniforms.uRiverFlow.value.copy(this.riverDir).multiplyScalar(s);
  }
}
