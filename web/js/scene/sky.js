// Sky dome with an atmospheric gradient, sun and procedural moving clouds.
// Weather (clear, overcast, storm) and time of day drive the colours; the dome
// is also rendered into an environment map for image-based lighting.
import * as THREE from 'three';

const VERT = /* glsl */`
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  // on the far plane; with a reversed depth buffer the far plane is depth 0
#ifdef USE_REVERSED_DEPTH_BUFFER
  gl_Position.z = gl_Position.w * 1e-6;
#else
  gl_Position.z = gl_Position.w * 0.99999;
#endif
}`;

const FRAG = /* glsl */`
uniform vec3 uSunDir, uSunColor, uZenith, uHorizon, uGround;
uniform float uCover, uDark, uTime, uSunVis;
uniform vec2 uWind;
varying vec3 vDir;
float hash(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 r = mat2(0.8, 0.6, -0.6, 0.8);
  for (int k = 0; k < 6; k++) { v += a * noise(p); p = r * p * 2.03 + 11.7; a *= 0.5; }
  return v;
}
void main() {
  vec3 d = normalize(vDir);
  float up = d.y;
  float sd = max(dot(d, uSunDir), 0.0);
  vec3 sky = mix(uHorizon, uZenith, pow(clamp(up, 0.0, 1.0), 0.55));
  sky += uSunColor * (0.06 * pow(sd, 6.0) + 0.25 * pow(sd, 64.0)) * uSunVis;
  vec3 col = sky;
  // below the horizon: haze, so the edges of the model dissolve into it
  if (up < 0.0) col = mix(uHorizon * 0.9, uHorizon * 0.55 + uGround, smoothstep(0.0, 0.7, -up));
  if (up > 0.01) {
    float t = (2200.0 - cameraPosition.y) / up;
    vec2 p = (cameraPosition.xz + d.xz * t) * 0.00028 + uWind * uTime;
    float n = fbm(p);
    float n2 = fbm(p * 2.7 + 3.1);
    float dens = smoothstep(1.0 - uCover - 0.08, 1.0 - uCover + 0.30, n * 0.75 + n2 * 0.25);
    float light = clamp(0.55 + 0.45 * dot(normalize(vec3(n2 - 0.5, 0.6, n - 0.5)), uSunDir), 0.0, 1.0);
    vec3 cloudCol = mix(vec3(0.20, 0.22, 0.25), vec3(0.92, 0.93, 0.95), light) * mix(1.0, 0.32, uDark);
    cloudCol += uSunColor * pow(sd, 8.0) * 0.25 * uSunVis * (1.0 - dens * 0.6);
    float fade = smoothstep(0.01, 0.18, up);
    col = mix(col, cloudCol, dens * fade * 0.97);
  }
  float disk = smoothstep(0.9996, 0.99985, sd) * uSunVis * (1.0 - uCover * 0.9);
  col += uSunColor * disk * 18.0;
  gl_FragColor = vec4(col, 1.0);
}`;

export const WEATHER = {
  clear: { cover: 0.28, dark: 0.0, fog: 0.00006, sun: 1.0 },
  overcast: { cover: 0.74, dark: 0.30, fog: 0.00010, sun: 0.40 },
  storm: { cover: 0.94, dark: 0.70, fog: 0.00015, sun: 0.18 },
  rain: { cover: 0.90, dark: 0.55, fog: 0.00013, sun: 0.22 },
};

export class Sky {
  constructor(renderer, scene) {
    this.renderer = renderer;
    this.uniforms = {
      uSunDir: { value: new THREE.Vector3(0.3, 0.6, 0.4).normalize() }, uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uZenith: { value: new THREE.Color() }, uHorizon: { value: new THREE.Color() }, uGround: { value: new THREE.Color() },
      uCover: { value: 0.5 }, uDark: { value: 0.3 }, uTime: { value: 0 }, uWind: { value: new THREE.Vector2(0.004, 0.0015) },
      uSunVis: { value: 1 },
    };
    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(30000, 48, 24),
      new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader: FRAG, uniforms: this.uniforms,
        side: THREE.BackSide, depthWrite: false, depthTest: false, fog: false }));
    this.mesh.frustumCulled = false; this.mesh.renderOrder = -10;
    scene.add(this.mesh);
    this.envScene = new THREE.Scene();
    this.envMesh = new THREE.Mesh(this.mesh.geometry, this.mesh.material);
    this.envScene.add(this.envMesh);
    this.pmrem = new THREE.PMREMGenerator(renderer);
    this.sunDir = this.uniforms.uSunDir.value;
    this.state = { hour: 15, weather: 'overcast' };
  }

  /** hour 0-24 local solar time; weather key of WEATHER. Returns lighting values. */
  set(hour, weather) {
    this.state = { hour, weather };
    const w = WEATHER[weather] || WEATHER.overcast;
    // sun path for late October at 40.7 N (declination about -13 deg)
    const H = (hour - 12) * 15 * Math.PI / 180, lat = 40.74 * Math.PI / 180, dec = -13 * Math.PI / 180;
    const el = Math.asin(Math.sin(lat) * Math.sin(dec) + Math.cos(lat) * Math.cos(dec) * Math.cos(H));
    const az = Math.atan2(-Math.sin(H), Math.tan(dec) * Math.cos(lat) - Math.sin(lat) * Math.cos(H));
    // scene axes: x east, -z north
    this.sunDir.set(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).normalize();
    const day = THREE.MathUtils.smoothstep(el, -0.12, 0.12);
    const golden = 1 - THREE.MathUtils.smoothstep(el, 0.05, 0.45);
    const u = this.uniforms;
    u.uSunColor.value.setRGB(1.0, 0.93 - 0.25 * golden, 0.82 - 0.45 * golden);
    const zen = new THREE.Color(0.10, 0.22, 0.42).lerp(new THREE.Color(0.20, 0.23, 0.27), w.dark * 0.8 + w.cover * 0.2);
    const hor = new THREE.Color(0.62, 0.68, 0.74).lerp(new THREE.Color(0.38, 0.40, 0.42), w.dark);
    hor.lerp(new THREE.Color(0.85, 0.62, 0.45), golden * 0.45 * (1 - w.dark));
    const night = new THREE.Color(0.012, 0.016, 0.026);
    u.uZenith.value.copy(zen).lerp(night, 1 - day);
    u.uHorizon.value.copy(hor).lerp(new THREE.Color(0.03, 0.035, 0.05), 1 - day);
    u.uGround.value.setRGB(0.035, 0.04, 0.045).multiplyScalar(0.4 + 0.6 * day);
    u.uCover.value = w.cover; u.uDark.value = w.dark; u.uSunVis.value = day * w.sun;
    this.light = { sunIntensity: 3.2 * day * (0.15 + 0.85 * w.sun), ambient: (0.25 + 0.75 * day) * (1 - 0.35 * w.dark),
      fog: u.uHorizon.value.clone().multiplyScalar(0.92), fogDensity: w.fog, day, night: 1 - day, el };
    return this.light;
  }

  updateEnvironment() {
    const prev = this.uniforms.uTime.value;
    const rt = this.pmrem.fromScene(this.envScene, 0, 1, 40000);
    this.uniforms.uTime.value = prev;
    this.envRT?.dispose();
    this.envRT = rt;
    return rt.texture;
  }

  tick(t) { this.uniforms.uTime.value = t; }
}
