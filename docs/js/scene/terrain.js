// Terrain tile: lidar surface draped with NAIP imagery and baked occlusion,
// wetting and silt left by the flood, analysis footprints and FEMA zones,
// and dark skirts so the model reads as a cut tile.
import * as THREE from 'three';
import { RAMPS_GLSL } from '../ramps.js';

export const MODES = { PHOTO: 0, DEPTH: 1, VELOCITY: 2, HAZARD: 3, MAXDEPTH: 4, ARRIVAL: 5, IMPACT: 6 };

export { RAMPS_GLSL };

function sampleDem(dem, cols, rows, res, x, y) {
  const fx = Math.min(Math.max(x / res - 0.5, 0), cols - 1.001), fy = Math.min(Math.max(y / res - 0.5, 0), rows - 1.001);
  const i = Math.floor(fx), j = Math.floor(fy), a = fx - i, b = fy - j;
  const k = j * cols + i;
  return (dem[k] * (1 - a) + dem[k + 1] * a) * (1 - b) + (dem[k + cols] * (1 - a) + dem[k + cols + 1] * a) * b;
}

export class Terrain {
  constructor(data, shared) {
    const m = data.meta;
    const W = m.grid.width_m, H = m.grid.height_m;
    this.W = W; this.H = H;
    const step = 4, nx = Math.round(W / step), ny = Math.round(H / step);
    const vx = nx + 1, vy = ny + 1;
    const pos = new Float32Array(vx * vy * 3), nor = new Float32Array(vx * vy * 3), uv = new Float32Array(vx * vy * 2);
    const res = m.dem_res, cols = m.dem_cols, rows = m.dem_rows, dem = data.dem;
    const zAt = (x, y) => sampleDem(dem, cols, rows, res, x, y);
    for (let j = 0; j < vy; j++) {
      for (let i = 0; i < vx; i++) {
        const x = i * step, y = j * step, k = j * vx + i;
        const z = zAt(x, y);
        pos[3 * k] = x - W / 2; pos[3 * k + 1] = z; pos[3 * k + 2] = H / 2 - y;
        const dzx = (zAt(x + step, y) - zAt(x - step, y)) / (2 * step);
        const dzy = (zAt(x, y + step) - zAt(x, y - step)) / (2 * step);
        // scene: +x east, -z north => normal = (-dz/dx, 1, +dz/dy)
        const l = Math.hypot(dzx, 1, dzy);
        nor[3 * k] = -dzx / l; nor[3 * k + 1] = 1 / l; nor[3 * k + 2] = dzy / l;
        uv[2 * k] = x / W; uv[2 * k + 1] = y / H;
      }
    }
    const idx = new Uint32Array(nx * ny * 6);
    let o = 0;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const a = j * vx + i, b = a + 1, c = a + vx, d = c + 1;
      idx[o++] = a; idx[o++] = b; idx[o++] = c; idx[o++] = b; idx[o++] = d; idx[o++] = c;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.zAt = zAt;

    this.uniforms = shared;   // uVis, uState, uStats, uSimTime, uMode, uFema, uShowFema, uDomain, uDryTime, uRainWet, uTEnd
    const mat = new THREE.MeshStandardMaterial({ map: shared.orthoTex, aoMap: shared.aoTex, aoMapIntensity: 1.0,
      roughness: 0.93, metalness: 0.0, envMapIntensity: 0.55 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, {
        uVis: shared.uVis, uState: shared.uState, uStats: shared.uStats, uSimTime: shared.uSimTime, uMode: shared.uMode,
        uFema: shared.uFema, uShowFema: shared.uShowFema, uDomain: shared.uDomain, uDryTime: shared.uDryTime,
        uRainWet: shared.uRainWet, uTEnd: shared.uTEnd, uFemaTexel: shared.uFemaTexel, uNight: shared.uNight,
      });
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec2 vTUv;\nuniform vec2 uDomain;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvTUv = vec2((position.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - position.z) / uDomain.y);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vTUv;
uniform sampler2D uVis, uState, uStats, uFema;
uniform float uSimTime, uDryTime, uRainWet, uTEnd, uShowFema, uNight;
uniform vec2 uFemaTexel;
uniform int uMode;
${RAMPS_GLSL}
float femaCode(vec2 uv) { return floor(texture2D(uFema, uv).r * 255.0 + 0.5); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  vec4 st = texture2D(uStats, vTUv);
  vec4 vis = texture2D(uVis, vTUv);
  float lastWet = texture2D(uState, vTUv).w;
  float wetness = lastWet > 0.0 ? clamp(1.0 - (uSimTime - lastWet) / uDryTime, 0.0, 1.0) : 0.0;
  wetness = max(wetness, uRainWet);
  diffuseColor.rgb *= mix(1.0, 0.52, wetness);
  float silt = smoothstep(0.05, 0.7, st.x) * (1.0 - step(0.03, vis.y));
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.42, 0.36, 0.27) * (0.6 + 0.8 * dot(diffuseColor.rgb, vec3(0.33))), 0.38 * silt);
  if (uMode != 0) {
    float l = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
    diffuseColor.rgb = mix(diffuseColor.rgb, vec3(l) * 0.85, 0.72);
  }
  if (uMode == 4 && st.x > 0.03) diffuseColor.rgb = mix(diffuseColor.rgb, rampDepth(st.x), 0.92);
  if (uMode == 5 && st.y >= 0.0) diffuseColor.rgb = mix(diffuseColor.rgb, rampArrival(st.y, uTEnd), 0.92);
  if (uShowFema > 0.5) {
    float zc = femaCode(vTUv);
    if (zc > 0.5) {
      vec3 zcol = zc > 2.5 ? vec3(0.694, 0.100, 0.019) : zc > 1.5 ? vec3(0.041, 0.242, 0.783) : vec3(0.010, 0.342, 0.162);
      float e = 0.0;
      e += step(0.5, abs(femaCode(vTUv + vec2(uFemaTexel.x, 0.0)) - zc));
      e += step(0.5, abs(femaCode(vTUv - vec2(uFemaTexel.x, 0.0)) - zc));
      e += step(0.5, abs(femaCode(vTUv + vec2(0.0, uFemaTexel.y)) - zc));
      e += step(0.5, abs(femaCode(vTUv - vec2(0.0, uFemaTexel.y)) - zc));
      diffuseColor.rgb = mix(diffuseColor.rgb, zcol, 0.22 + 0.6 * min(e, 1.0));
    }
  }`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.28, wetness * 0.85);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  // sodium street lighting at night: pavement (light grey in the image) catches a warm glow
  float lum = dot(diffuseColor.rgb, vec3(0.33));
  float pave = smoothstep(0.04, 0.16, lum) * (1.0 - smoothstep(0.03, 0.09, abs(diffuseColor.g - 0.5 * (diffuseColor.r + diffuseColor.b))));
  totalEmissiveRadiance += vec3(1.0, 0.56, 0.24) * uNight * pave * 0.10;`);
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.receiveShadow = true;
    this.mesh.name = 'terrain';

    // skirts: vertical sides down to the base of the tile
    const base = -42;
    const ring = [];
    for (let i = 0; i <= nx; i++) ring.push([i * step, 0]);
    for (let j = 1; j <= ny; j++) ring.push([W, j * step]);
    for (let i = nx - 1; i >= 0; i--) ring.push([i * step, H]);
    for (let j = ny - 1; j >= 1; j--) ring.push([0, j * step]);
    const sp = [], sc = [], si = [];
    ring.forEach(([x, y], k) => {
      const z = zAt(Math.min(x, W - 0.01), Math.min(y, H - 0.01));
      sp.push(x - W / 2, z, H / 2 - y, x - W / 2, base, H / 2 - y);
      const t = 0.11 + 0.05 * Math.sin(z * 0.9);
      sc.push(t * 1.05, t * 1.1, t * 1.15, 0.035, 0.04, 0.045);
    });
    const n = ring.length;
    for (let k = 0; k < n; k++) {
      const a = 2 * k, b = 2 * ((k + 1) % n);
      si.push(a, a + 1, b, b, a + 1, b + 1);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(sp, 3));
    sg.setAttribute('color', new THREE.Float32BufferAttribute(sc, 3));
    sg.setIndex(si);
    sg.computeVertexNormals();
    this.skirt = new THREE.Mesh(sg, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, side: THREE.DoubleSide }));
    this.skirt.name = 'skirt';
    // base slab
    const bg = new THREE.BoxGeometry(W, 2, H);
    this.base = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x0b0d0f, roughness: 1 }));
    this.base.position.y = base - 1;
  }

  heightAt(lx, ly) { return this.zAt(lx, ly); }
}
