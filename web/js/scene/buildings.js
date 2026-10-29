// Buildings: extruded OSM footprints at lidar-measured heights (detailed
// building:parts for towers) with a procedural facade shader.
import * as THREE from 'three';
import { RAMPS_GLSL } from '../ramps.js';

const TEX_W = 256;

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] * r[i + 1] - r[i] * r[j + 1]);
  return a / 2;
}
function oriented(r, ccw) {
  const a = ringArea(r);
  if ((a > 0) === ccw) return r;
  const out = [];
  for (let i = r.length - 2; i >= 0; i -= 2) out.push(r[i], r[i + 1]);
  return out;
}
function hash(n) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

export class Buildings {
  constructor(data, shared) {
    const B = data.buildings;
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.count = B.count;
    const C = B.columns, ig = C.indexOf('g'), ih = C.indexOf('h'), icls = C.indexOf('cls'), iroof = C.indexOf('roof');
    const hasParts = new Set(B.has_parts);
    const pos = [], nor = [], wall = [], idx = [];
    let v = 0;
    const sx = x => x - W / 2, sz = y => H / 2 - y;

    const addPrism = (outer, holes, b, z0, z1, g) => {
      const rings = [oriented(outer, true), ...holes.map(h => oriented(h, false))];
      // walls
      for (const r of rings) {
        const n = r.length / 2;
        let u = 0;
        for (let k = 0; k < n; k++) {
          const x1 = r[2 * k], y1 = r[2 * k + 1], x2 = r[(2 * k + 2) % r.length], y2 = r[(2 * k + 3) % r.length];
          const len = Math.hypot(x2 - x1, y2 - y1);
          if (len < 0.05) continue;
          const nlx = (y2 - y1) / len, nly = -(x2 - x1) / len;   // outward (right of travel)
          const nx = nlx, nz = -nly;
          const A = [sx(x1), z0, sz(y1)], Bv = [sx(x2), z0, sz(y2)], Cv = [sx(x2), z1, sz(y2)], D = [sx(x1), z1, sz(y1)];
          const vb = z0 - g, vt = z1 - g;
          pos.push(...A, ...Bv, ...Cv, ...D);
          for (let q = 0; q < 4; q++) nor.push(nx, 0, nz);
          wall.push(u, vb, b, 0, u + len, vb, b, 0, u + len, vt, b, 0, u, vt, b, 0);
          // winding so that the face normal matches the outward normal
          const e1 = [Bv[0] - A[0], Bv[1] - A[1], Bv[2] - A[2]], e2 = [Cv[0] - A[0], Cv[1] - A[1], Cv[2] - A[2]];
          const cxp = e1[1] * e2[2] - e1[2] * e2[1], czp = e1[0] * e2[1] - e1[1] * e2[0];
          if (cxp * nx + czp * nz >= 0) idx.push(v, v + 1, v + 2, v, v + 2, v + 3);
          else idx.push(v, v + 2, v + 1, v, v + 3, v + 2);
          v += 4; u += len;
        }
      }
      // roof
      const contour = [], holeV = [];
      for (let k = 0; k < rings[0].length; k += 2) contour.push(new THREE.Vector2(rings[0][k], rings[0][k + 1]));
      for (let h = 1; h < rings.length; h++) {
        const hv = [];
        for (let k = 0; k < rings[h].length; k += 2) hv.push(new THREE.Vector2(rings[h][k], rings[h][k + 1]));
        holeV.push(hv);
      }
      let faces;
      try { faces = THREE.ShapeUtils.triangulateShape(contour, holeV); } catch { faces = []; }
      const all = contour.concat(...holeV);
      const base = v;
      for (const p of all) {
        pos.push(sx(p.x), z1, sz(p.y)); nor.push(0, 1, 0);
        wall.push(sx(p.x), sz(p.y), b, 1);
        v++;
      }
      for (const f of faces) {
        const [a, bb, c] = f;
        const pa = all[a], pb = all[bb], pc = all[c];
        // normal.y of the scene triangle = -(cross in local xy) because z = -y
        const cr = (pb.x - pa.x) * (pc.y - pa.y) - (pb.y - pa.y) * (pc.x - pa.x);
        if (cr > 0) idx.push(base + a, base + c, base + bb); else idx.push(base + a, base + bb, base + c);
      }
    };

    for (let b = 0; b < B.count; b++) {
      if (hasParts.has(b)) continue;
      const row = B.rows[b], g = row[ig], h = row[ih];
      for (const poly of B.rings[b]) addPrism(poly[0], poly.slice(1), b, g - 4, g + h, g);
    }
    for (const p of B.parts) {
      const g = B.rows[p.b][ig];
      addPrism(p.ring, [], p.b, g + (p.min > 0.5 ? p.min : -4), g + p.h, g);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    geo.setAttribute('aWall', new THREE.Float32BufferAttribute(wall, 4));
    geo.setIndex(v > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    this.vertexCount = v;

    // static per-building info: class, height, seed, ground; roof colour in a second texture
    const th = Math.ceil(B.count / TEX_W);
    const info = new Float32Array(TEX_W * th * 4), roof = new Float32Array(TEX_W * th * 4);
    for (let b = 0; b < B.count; b++) {
      const r = B.rows[b];
      info.set([r[icls], r[ih], hash(b + 1), r[ig]], 4 * b);
      const c = parseInt(r[iroof], 16);
      roof.set([((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255, 1], 4 * b);
    }
    const tex = (d) => { const t = new THREE.DataTexture(d, TEX_W, th, THREE.RGBAFormat, THREE.FloatType); t.needsUpdate = true; return t; };
    this.infoTex = tex(info); this.roofTex = tex(roof);
    // dynamic: max water surface, current water surface, damage ratio (-1 none), flags
    this.dyn = new Float32Array(TEX_W * th * 4);
    for (let b = 0; b < B.count; b++) this.dyn.set([-99, -99, -1, 0], 4 * b);
    this.dynTex = tex(this.dyn);
    this.texH = th;

    const u = {
      uBInfo: { value: this.infoTex }, uBRoof: { value: this.roofTex }, uBDyn: { value: this.dynTex },
      uOrtho: { value: shared.orthoTex }, uDomain: shared.uDomain, uMode: shared.uMode, uNight: shared.uNight,
      uSelected: { value: -1 }, uTime: shared.uTime,
    };
    this.uniforms = u;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.82, metalness: 0.0, envMapIntensity: 0.9 });
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec4 aWall;\nvarying vec4 vWall;\nvarying vec3 vWPos;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWall = aWall;\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec4 vWall;
varying vec3 vWPos;
uniform sampler2D uBInfo, uBRoof, uBDyn, uOrtho;
uniform vec2 uDomain;
uniform int uMode;
uniform float uNight, uSelected, uTime;
float h21(vec2 p) { p = fract(p * vec2(234.34, 435.345)); p += dot(p, p + 34.23); return fract(p.x * p.y); }
${RAMPS_GLSL}
vec3 damageRamp(float d) { return d < 0.0 ? vec3(0.30) : d < 0.005 ? vec3(0.62, 0.64, 0.62) : rampDamage(d); }`)
        .replace('#include <map_fragment>', `#include <map_fragment>
  int bi = int(vWall.z + 0.5);
  ivec2 tc = ivec2(bi % ${TEX_W}, bi / ${TEX_W});
  vec4 info = texelFetch(uBInfo, tc, 0);
  vec4 dyn = texelFetch(uBDyn, tc, 0);
  float cls = info.x, bh = info.y, seed = info.z, g0 = info.w;
  bool roofFace = vWall.w > 0.5;
  bool tall = bh > 55.0;
  vec3 albedo;
  float glass = 0.0, lit = 0.0;
  if (roofFace) {
    vec2 ouv = vec2((vWPos.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - vWPos.z) / uDomain.y);
    vec3 ortho = texture2D(uOrtho, ouv).rgb;
    vec3 rc = texelFetch(uBRoof, tc, 0).rgb;
    rc = rc * rc;      // sRGB-ish to linear
    albedo = tall ? mix(vec3(0.20, 0.21, 0.22), rc, 0.35) : mix(rc, ortho, 0.65);
  } else {
    float floorH = cls > 1.5 && cls < 2.5 ? 3.9 : cls > 2.5 && cls < 3.5 ? 5.0 : cls > 3.5 && cls < 4.5 ? 4.0 : 3.05;
    float colW = tall ? 1.6 : (cls > 1.5 && cls < 2.5 ? 3.0 : 2.6);
    // palette
    vec3 pal;
    float s = fract(seed * 7.13);
    if (tall) pal = mix(vec3(0.08, 0.11, 0.14), vec3(0.16, 0.19, 0.21), s);
    else if (cls < 0.5) {
      pal = s < 0.30 ? vec3(0.36, 0.14, 0.10) : s < 0.52 ? vec3(0.44, 0.22, 0.15) : s < 0.66 ? vec3(0.30, 0.19, 0.15)
          : s < 0.78 ? vec3(0.52, 0.33, 0.23) : s < 0.90 ? vec3(0.60, 0.56, 0.49) : vec3(0.42, 0.43, 0.43);
    } else if (cls < 1.5) pal = s < 0.4 ? vec3(0.50, 0.47, 0.42) : s < 0.75 ? vec3(0.40, 0.39, 0.38) : vec3(0.38, 0.24, 0.18);
    else if (cls < 2.5) pal = s < 0.5 ? vec3(0.44, 0.43, 0.41) : vec3(0.52, 0.48, 0.42);
    else if (cls < 3.5) pal = vec3(0.40, 0.40, 0.39);
    else if (cls < 4.5) pal = vec3(0.56, 0.52, 0.46);
    else pal = vec3(0.36, 0.35, 0.33);
    pal *= 0.9 + 0.2 * fract(seed * 13.7);
    albedo = pal;
    // brick courses and weathering
    albedo *= 0.93 + 0.07 * h21(floor(vec2(vWall.x * 4.0, vWall.y * 12.0)));
    if (cls < 4.5 && vWall.y > 0.6) {
      float fl = floor(vWall.y / floorH), fy = fract(vWall.y / floorH);
      float cx = floor(vWall.x / colW), fx = fract(vWall.x / colW);
      float ww = tall ? 0.90 : 0.46, wh = tall ? 0.80 : 0.54;
      float inX = step(0.5 - ww * 0.5, fx) * step(fx, 0.5 + ww * 0.5);
      float inY = step(0.30, fy) * step(fy, 0.30 + wh);
      float win = inX * inY * step(fl + 1.0, max(1.0, floor(bh / floorH)));
      if (cls > 1.5 && cls < 2.5 && fl < 0.5) win = step(0.08, fx) * step(fx, 0.92) * step(0.12, fy) * step(fy, 0.86);
      // fade the window grid to its average tone once a window is smaller than a pixel or two
      float aa = clamp(1.6 - 2.2 * max(fwidth(vWall.x / colW), fwidth(vWall.y / floorH)) * 4.0, 0.0, 1.0);
      float cover = ww * wh * step(1.0, floor(bh / floorH));
      vec3 glassCol = tall ? vec3(0.05, 0.08, 0.11) : vec3(0.07, 0.08, 0.09);
      albedo = mix(mix(albedo, glassCol, cover * 0.85), mix(albedo, glassCol, win), aa);
      glass = mix(cover, win, aa);
      float id = h21(vec2(cx + seed * 91.0, fl + seed * 37.0));
      // about a third of windows lit; far away the facade glows at that average
      lit = mix(cover * 0.34, win * step(0.66, id) * (0.6 + 0.8 * fract(id * 17.0)), aa);
    }
    // occlusion near the ground
    albedo *= mix(0.62, 1.0, smoothstep(0.0, 3.5, vWall.y));
  }
  // water marks left by the flood
  float wseMax = dyn.x, wseNow = dyn.y;
  if (wseMax > g0 + 0.02) {
    float below = step(vWPos.y, wseMax);
    albedo = mix(albedo, albedo * vec3(0.66, 0.60, 0.50), 0.75 * below);
    float line = 1.0 - smoothstep(0.0, 0.05, abs(vWPos.y - wseMax));
    albedo *= 1.0 - 0.45 * line;
  }
  if (uMode == 6) albedo = mix(damageRamp(dyn.z), damageRamp(dyn.z) * (roofFace ? 1.0 : 0.85), 0.5);
  if (abs(float(bi) - uSelected) < 0.5) albedo = mix(albedo, vec3(1.0, 0.62, 0.20), 0.45);
  diffuseColor.rgb = albedo;
  float powerOut = step(g0 + 0.4, wseMax);`)
        .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
  roughnessFactor = mix(roughnessFactor, 0.12, glass);`)
        .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
  metalnessFactor = mix(metalnessFactor, tall ? 0.55 : 0.25, glass);`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
  totalEmissiveRadiance += vec3(1.0, 0.74, 0.46) * lit * uNight * (1.0 - powerOut) * 1.5;
  if (abs(float(bi) - uSelected) < 0.5) totalEmissiveRadiance += vec3(0.35, 0.18, 0.04);`);
    };
    this.material = mat;
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.castShadow = true; this.mesh.receiveShadow = true;
    this.mesh.name = 'buildings';
  }

  /** Update per-building water levels and damage (arrays of length count). */
  setDynamic(wseMax, wseNow, dr) {
    const d = this.dyn;
    for (let b = 0; b < this.count; b++) { d[4 * b] = wseMax[b]; d[4 * b + 1] = wseNow[b]; d[4 * b + 2] = dr[b]; }
    this.dynTex.needsUpdate = true;
  }

  select(b) { this.uniforms.uSelected.value = b ?? -1; }

  /** Building index from a raycast hit on the merged mesh. */
  indexFromHit(hit) {
    const a = this.mesh.geometry.getAttribute('aWall');
    return Math.round(a.getZ(hit.face.a));
  }
}
