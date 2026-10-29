// Trees from the lidar canopy (position, height, crown radius, colour from
// the aerial image) and parked vehicles along the streets. Trees sway with the
// wind; vehicles lift and bob once the simulated water is deep enough to float them.
import * as THREE from 'three';

function noise3(x, y, z) {
  const s = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453;
  return s - Math.floor(s);
}

function mergeParts(parts) {
  let nv = 0, ni = 0;
  for (const p of parts) { nv += p.geo.attributes.position.count; ni += p.geo.index.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), extra = new Float32Array(nv), idx = new Uint32Array(ni);
  let ov = 0, oi = 0;
  for (const p of parts) {
    const g = p.geo, n = g.attributes.position.count;
    pos.set(g.attributes.position.array, ov * 3); nor.set(g.attributes.normal.array, ov * 3);
    extra.fill(p.tag, ov, ov + n);
    const ix = g.index.array;
    for (let k = 0; k < ix.length; k++) idx[oi + k] = ix[k] + ov;
    ov += n; oi += ix.length;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  geo.setAttribute('aTag', new THREE.BufferAttribute(extra, 1));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  return geo;
}

function treeGeometry() {
  // unit tree: trunk to 0.45, crown ellipsoid centred at 0.64 (scaled by radius, height, radius)
  const crown = new THREE.SphereGeometry(1, 10, 7);
  const p = crown.attributes.position;
  for (let k = 0; k < p.count; k++) {
    const x = p.getX(k), y = p.getY(k), z = p.getZ(k);
    const r = 0.86 + 0.28 * noise3(Math.round(x * 50), Math.round(y * 50), Math.round(z * 50));
    p.setXYZ(k, x * r, 0.64 + y * 0.36 * r, z * r);
  }
  crown.computeVertexNormals();
  const trunk = new THREE.CylinderGeometry(0.06, 0.09, 0.5, 6, 1, true);
  trunk.translate(0, 0.25, 0);
  return mergeParts([{ geo: crown, tag: 0 }, { geo: trunk, tag: 1 }]);
}

function carGeometry() {
  const body = new THREE.BoxGeometry(4.4, 0.72, 1.8); body.translate(0, 0.62, 0);
  const cabin = new THREE.BoxGeometry(2.3, 0.56, 1.58); cabin.translate(-0.25, 1.26, 0);
  const wheels = new THREE.BoxGeometry(3.5, 0.5, 1.84); wheels.translate(0, 0.3, 0);
  return mergeParts([{ geo: body, tag: 0 }, { geo: cabin, tag: 1 }, { geo: wheels, tag: 2 }]);
}

const srgbToLinear = v => Math.pow(v / 255, 2.2);

export class Vegetation {
  constructor(data, shared) {
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.shared = shared;
    this.trees = this._trees(data.trees, W, H, shared);
    this.cars = this._cars(data.cars, W, H, shared);
  }

  _trees(T, W, H, shared) {
    const rows = T.rows, n = rows.length;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0, envMapIntensity: 0.6 });
    const u = { uTime: shared.uTime, uWind: shared.uWind };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTag;\nuniform float uTime, uWind;\nvarying float vTag;\nvarying float vShade;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vTag = aTag;
  vShade = 0.72 + 0.28 * smoothstep(0.3, 1.0, position.y) + 0.1 * normal.y;
  vec3 ip = instanceMatrix[3].xyz;
  float ph = ip.x * 0.37 + ip.z * 0.21;
  float bend = position.y * position.y * uWind;
  transformed.x += (sin(uTime * 1.9 + ph) * 0.05 + 0.07) * bend;
  transformed.z += cos(uTime * 1.4 + ph * 1.3) * 0.04 * bend;`)
        .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb = mix(vColor.rgb, vec3(0.16, 0.12, 0.09), aTag);');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTag;\nvarying float vShade;')
        .replace('#include <color_fragment>', '#include <color_fragment>\n  diffuseColor.rgb *= mix(vShade, 1.0, vTag);');
    };
    const mesh = new THREE.InstancedMesh(treeGeometry(), mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    for (let k = 0; k < n; k++) {
      const [x, y, z, h, r, R, G, B] = rows[k];
      const hh = Math.max(h, 3.5), rr = Math.min(Math.max(r, 1.5), hh * 0.55);
      q.setFromAxisAngle(yAxis, noise3(x, y, 1) * Math.PI * 2);
      s.set(rr, hh, rr * (0.9 + 0.2 * noise3(x, y, 2)));
      p.set(x - W / 2, z - 0.2, H / 2 - y);
      m.compose(p, q, s);
      mesh.setMatrixAt(k, m);
      const v = 0.82 + 0.3 * noise3(x, y, 3);
      c.setRGB(srgbToLinear(R) * v * 1.45, srgbToLinear(G) * v * 1.5, srgbToLinear(B) * v * 1.2);
      mesh.setColorAt(k, c);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'trees';
    return mesh;
  }

  _cars(C, W, H, shared) {
    const rows = C.rows, n = rows.length;
    const mat = new THREE.MeshStandardMaterial({ roughness: 0.38, metalness: 0.35, envMapIntensity: 1.0 });
    const u = { uVis: shared.uVis, uDomain: shared.uDomain, uTime: shared.uTime };
    mat.onBeforeCompile = (sh) => {
      Object.assign(sh.uniforms, u);
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aTag;\nuniform sampler2D uVis;\nuniform vec2 uDomain;\nuniform float uTime;\nvarying float vTag;\nfloat carLift;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
  vTag = aTag;
  vec3 ip = instanceMatrix[3].xyz;
  vec2 cuv = vec2((ip.x + 0.5 * uDomain.x) / uDomain.x, (0.5 * uDomain.y - ip.z) / uDomain.y);
  vec4 cv = texture(uVis, cuv);
  carLift = cv.g > 0.55 ? clamp(cv.r - 0.5 - ip.y, 0.0, 6.0) : 0.0;
  if (carLift > 0.0) {
    float a = sin(uTime * 0.9 + ip.x * 0.3) * 0.07, b = cos(uTime * 0.7 + ip.z * 0.3) * 0.05;
    transformed.yz = mat2(cos(a), -sin(a), sin(a), cos(a)) * transformed.yz;
    transformed.xy = mat2(cos(b), -sin(b), sin(b), cos(b)) * transformed.xy;
  }`)
        .replace('#include <project_vertex>', `vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
  mvPosition.y += carLift;
  mvPosition = modelViewMatrix * mvPosition;
  gl_Position = projectionMatrix * mvPosition;`)
        .replace('#include <color_vertex>', '#include <color_vertex>\n  vColor.rgb = aTag > 1.5 ? vec3(0.02) : aTag > 0.5 ? mix(vColor.rgb, vec3(0.03, 0.035, 0.04), 0.82) : vColor.rgb;');
      sh.fragmentShader = sh.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying float vTag;')
        .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\n  roughnessFactor = vTag > 0.5 && vTag < 1.5 ? 0.08 : vTag > 1.5 ? 0.9 : roughnessFactor;');
    };
    const mesh = new THREE.InstancedMesh(carGeometry(), mat, n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), c = new THREE.Color();
    const yAxis = new THREE.Vector3(0, 1, 0);
    const scales = [[1, 1, 1], [1.06, 1.2, 1.06], [0.86, 1.02, 0.96]];
    for (let k = 0; k < n; k++) {
      const [x, y, z, hd, R, G, B, type] = rows[k];
      q.setFromAxisAngle(yAxis, hd);
      s.fromArray(scales[type] || scales[0]);
      p.set(x - W / 2, z, H / 2 - y);
      m.compose(p, q, s);
      mesh.setMatrixAt(k, m);
      c.setRGB(srgbToLinear(R), srgbToLinear(G), srgbToLinear(B));
      mesh.setColorAt(k, c);
    }
    mesh.instanceMatrix.needsUpdate = true; mesh.instanceColor.needsUpdate = true;
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    mesh.name = 'cars';
    return mesh;
  }
}
