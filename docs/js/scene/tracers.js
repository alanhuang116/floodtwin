// Flow tracers: GPU particles advected through the simulated velocity field
// (midpoint integration), drawn as short ribbons on the water surface. Tracers
// move faster than the water by a fixed factor so the flow pattern is readable.
import * as THREE from 'three';
import { RAMPS_GLSL } from './terrain.js';

const SIZE = 192;

const VERT = /* glsl */`
in vec3 position;
void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const UPDATE = /* glsl */`
precision highp float;
uniform sampler2D uPrev, uVis, uRiver;
uniform vec2 uDomain;
uniform float uDt, uScale, uSeed;
out vec4 outColor;
float h1(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
vec2 h2(vec2 p) { return vec2(h1(p), h1(p + 17.31)); }
bool usable(vec2 q) {
  vec2 uv = q / uDomain;
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return false;
  return texture(uVis, uv).g > 0.06 && texture(uRiver, uv).r < 0.5;
}
void main() {
  vec4 p = texelFetch(uPrev, ivec2(gl_FragCoord.xy), 0);
  bool dead = p.z >= p.w || !usable(p.xy);
  if (dead) {
    p = vec4(-1.0, -1.0, 0.0, 0.0);
    for (int k = 0; k < 4; k++) {
      vec2 q = h2(gl_FragCoord.xy * 0.731 + vec2(uSeed * 13.1, uSeed * 7.7 + float(k) * 3.3)) * uDomain;
      if (usable(q)) { p = vec4(q, 0.0, 2.5 + 4.0 * h1(q + uSeed)); break; }
    }
  } else {
    vec2 v1 = texture(uVis, p.xy / uDomain).ba;
    vec2 mid = p.xy + v1 * uDt * uScale * 0.5;
    vec2 v2 = texture(uVis, mid / uDomain).ba;
    p.xy += v2 * uDt * uScale;
    p.z += uDt;
  }
  outColor = p;
}`;

export class Tracers {
  constructor(renderer, shared) {
    this.renderer = renderer;
    const opts = { type: THREE.FloatType, format: THREE.RGBAFormat, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: false };
    this.a = new THREE.WebGLRenderTarget(SIZE, SIZE, opts);
    this.b = new THREE.WebGLRenderTarget(SIZE, SIZE, opts);
    this.scale = 10;
    this.mUpdate = new THREE.RawShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: UPDATE, depthTest: false, depthWrite: false,
      uniforms: { uPrev: { value: null }, uVis: shared.uVis, uRiver: { value: null }, uDomain: shared.uDomain,
        uDt: { value: 0 }, uScale: { value: this.scale }, uSeed: { value: 0 } },
    });
    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.quad = new THREE.Mesh(quad, this.mUpdate); this.quad.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.quad);
    this.cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.reset();

    // ribbons: one quad per particle
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -1, 0, 1, -1, 0, 1, 1, 0, 0, 1, 0]), 3));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    const ref = new Float32Array(SIZE * SIZE * 2);
    for (let j = 0; j < SIZE; j++) for (let i = 0; i < SIZE; i++) { const k = j * SIZE + i; ref[2 * k] = (i + 0.5) / SIZE; ref[2 * k + 1] = (j + 0.5) / SIZE; }
    g.setAttribute('aRef', new THREE.InstancedBufferAttribute(ref, 2));
    g.instanceCount = SIZE * SIZE;
    this.uniforms = { uState: { value: this.a.texture }, uVis: shared.uVis, uDomain: shared.uDomain, uMode: shared.uMode,
      uTrail: { value: 0.6 }, uScale: { value: this.scale }, uDay: shared.uDay };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      vertexShader: /* glsl */`
uniform sampler2D uState, uVis;
uniform vec2 uDomain;
uniform float uTrail, uScale;
attribute vec2 aRef;
varying float vA, vSpeed, vAlong;
void main() {
  vec4 p = texture2D(uState, aRef);
  vec4 v = texture2D(uVis, p.xy / uDomain);
  float speed = length(v.ba);
  vec2 dir = speed > 1e-4 ? v.ba / speed : vec2(1.0, 0.0);
  float len = max(speed * uTrail * uScale, 0.8);
  vec2 head = p.xy, tail = p.xy - dir * len;
  vec2 xy = mix(tail, head, position.x);
  vec3 wp = vec3(xy.x - 0.5 * uDomain.x, v.r + 0.07, 0.5 * uDomain.y - xy.y);
  float w = max(0.35, length(cameraPosition - wp) * 0.0011);
  vec2 perp = vec2(-dir.y, dir.x) * w * position.y;
  wp.x += perp.x; wp.z -= perp.y;
  float life = max(p.w, 1e-3);
  vA = (p.w > 0.0 && p.x >= 0.0) ? smoothstep(0.0, 0.5, p.z) * smoothstep(life, life - 0.8, p.z) * smoothstep(0.02, 0.12, speed) : 0.0;
  vSpeed = speed; vAlong = position.x;
  gl_Position = vA > 0.0 ? projectionMatrix * viewMatrix * vec4(wp, 1.0) : vec4(2.0, 2.0, 2.0, 1.0);
}`,
      fragmentShader: /* glsl */`
uniform int uMode;
uniform float uDay;
varying float vA, vSpeed, vAlong;
${RAMPS_GLSL}
void main() {
  vec3 c = uMode == 2 ? rampSpeed(vSpeed) * 1.6 : vec3(0.85, 0.88, 0.86) * (0.35 + 0.65 * uDay);
  float a = vA * vAlong * (uMode == 2 ? 0.95 : 0.32);
  gl_FragColor = vec4(c * a, a);
}`,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false; this.mesh.renderOrder = 5; this.mesh.name = 'tracers';
  }

  reset() {
    const r = this.renderer, prev = r.getRenderTarget();
    const c = r.getClearColor(new THREE.Color()), al = r.getClearAlpha();
    r.setClearColor(0x000000, 0);
    for (const t of [this.a, this.b]) { r.setRenderTarget(t); r.clear(true, false, false); }
    r.setClearColor(c, al); r.setRenderTarget(prev);
  }

  setRiver(tex) { this.mUpdate.uniforms.uRiver.value = tex; }

  update(dtReal) {
    const u = this.mUpdate.uniforms;
    u.uPrev.value = this.a.texture; u.uDt.value = Math.min(dtReal, 0.1); u.uSeed.value = (u.uSeed.value + 0.6180339) % 97;
    const r = this.renderer, prev = r.getRenderTarget();
    r.setRenderTarget(this.b); r.render(this.scene, this.cam); r.setRenderTarget(prev);
    [this.a, this.b] = [this.b, this.a];
    this.uniforms.uState.value = this.a.texture;
  }
}
