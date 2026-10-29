// FloodTwin: bootstrap, application state and actions, and the frame loop.
import * as THREE from 'three';
import { loadAll, makeGeo } from './data.js';
import { Viewer } from './render.js';
import { Terrain } from './scene/terrain.js';
import { Buildings } from './scene/buildings.js';
import { Water } from './scene/water.js';
import { Vegetation } from './scene/vegetation.js';
import { Tracers } from './scene/tracers.js';
import { Markers } from './scene/markers.js';
import { Simulation } from './sim.js';
import { presetById } from './scenarios.js';
import { Labels } from './labels.js';
import { UI } from './ui.js';

const $ = (s) => document.querySelector(s);

const VIEWS = [
  { name: 'Overview', target: [2050, 1700, 0], dist: 3900, polar: 56, azim: 32 },
  { name: 'Hoboken Terminal', target: [1560, 360, 2], dist: 520, polar: 60, azim: 18 },
  { name: 'Southwest Hoboken', target: [880, 640, 2], dist: 760, polar: 56, azim: 40 },
  { name: 'Hoboken Waterfront', target: [1760, 1250, 3], dist: 950, polar: 62, azim: -62 },
  { name: 'Weehawken Cove', target: [1700, 2860, 1], dist: 720, polar: 56, azim: 12 },
  { name: 'Chelsea Piers and High Line', target: [3250, 1480, 3], dist: 820, polar: 60, azim: 62 },
  { name: 'Hudson Yards', target: [3820, 2380, 5], dist: 1150, polar: 60, azim: 48 },
  { name: 'Street Level, Jackson Street', target: [502, 767, 4], dist: 110, polar: 86, azim: 12.4 },
];

function gpuCheck() {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'FloodTwin needs WebGL 2, which this browser or device does not provide.';
  if (!gl.getExtension('EXT_color_buffer_float')) return 'This GPU cannot render to floating-point textures (EXT_color_buffer_float), which the flood solver needs.';
  const dbg = gl.getExtension('WEBGL_debug_renderer_info');
  const name = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '';
  gl.getExtension('WEBGL_lose_context')?.loseContext();
  return { name };
}

function setLayer(obj, n) { obj.traverse(o => o.layers.set(n)); }

class App {
  constructor() {
    this.views = VIEWS;
    this.tool = 'select';
    this.selected = -1;
    this.draft = [];
    this.dirty = false;
    this.rainWet = 0;
  }

  async start() {
    const gpu = gpuCheck();
    if (typeof gpu === 'string') return this.fail(gpu);
    const integrated = /intel|uhd|iris|mali|adreno|powervr|apple gpu|swiftshader|llvmpipe/i.test(gpu.name);
    const t0 = performance.now();
    const data = await loadAll('data', (f, label) => {
      $('#loader-bar').style.width = `${Math.round(f * 92)}%`;
      $('#loader-pct').textContent = `${Math.round(f * 92)}%`;
      $('#loader-text').textContent = label;
    });
    this.validation = await fetch('data/validation.json').then(r => r.json());
    this.data = data;
    this.geo = makeGeo(data.meta);
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H;
    $('#loader-text').textContent = 'Building the city';
    await new Promise(r => setTimeout(r, 30));

    const ortho = new THREE.Texture(data.ortho);
    ortho.colorSpace = THREE.SRGBColorSpace; ortho.anisotropy = 8; ortho.needsUpdate = true;
    const ao = new THREE.Texture(data.ao); ao.needsUpdate = true;
    const fema = new THREE.DataTexture(data.fema, data.meta.dem_cols, data.meta.dem_rows, THREE.RedFormat, THREE.UnsignedByteType);
    fema.needsUpdate = true;
    const shared = this.shared = {
      orthoTex: ortho, aoTex: ao,
      uVis: { value: null }, uState: { value: null }, uStats: { value: null },
      uSimTime: { value: 0 }, uMode: { value: 0 }, uFema: { value: fema }, uShowFema: { value: 0 },
      uDomain: { value: new THREE.Vector2(W, H) }, uDryTime: { value: 5400 }, uRainWet: { value: 0 }, uTEnd: { value: 1 },
      uFemaTexel: { value: new THREE.Vector2(1 / data.meta.dem_cols, 1 / data.meta.dem_rows) },
      uNight: { value: 0 }, uDay: { value: 1 }, uTime: { value: 0 }, uRainVis: { value: 0 }, uWind: { value: 0.1 },
      uFogColor: { value: new THREE.Color(0x8a949c) }, uFogDensity: { value: 0.0002 },
    };

    const viewer = this.viewer = new Viewer($('#view'), shared);
    const terrain = this.terrain = new Terrain(data, shared);
    const buildings = this.buildings = new Buildings(data, shared);
    const water = this.water = new Water(data, shared);
    const veg = this.veg = new Vegetation(data, shared);
    const markers = this.markers = new Markers(data, terrain);
    const tracers = this.tracers = new Tracers(viewer.renderer, shared);
    const sc = viewer.scene;
    for (const o of [terrain.mesh, terrain.skirt, terrain.base, buildings.mesh]) { setLayer(o, 0); sc.add(o); }
    for (const o of [water.group, water.curtain, tracers.mesh]) { setLayer(o, 1); sc.add(o); }
    for (const o of [veg.trees, veg.cars]) { setLayer(o, 2); sc.add(o); }
    setLayer(markers.group, 3); sc.add(markers.group);
    viewer.sun.shadow.camera.layers.enableAll();
    viewer.setWater(water);
    viewer.initPicking(buildings.mesh, terrain.mesh, W, H, (x, y) => terrain.heightAt(x, y));

    const sim = this.sim = new Simulation(viewer.renderer, data, this.geo);
    sim.on('grid', g => {
      water.setRiver(g);
      tracers.setRiver(water.riverTex);
      shared.uVis.value = sim.solver.vis.texture;
      shared.uState.value = sim.solver.a.texture;
      $('#grid-badge').textContent = `${g.dx} m grid`;
      markers.setDefences(this.state.defences.barriers, g, this.state.defences.waterfront);
    });
    sim.on('results', R => {
      buildings.setDynamic(sim.bWseMax, sim.bWseNow, sim.bDr);
      markers.setHwmSim(R.hwm.map(v => v ?? -99));
      this.labels.setHwmValues(R.hwm);
      this.ui?.onResults();
    });
    sim.on('reset', () => {
      buildings.setDynamic(sim.bWseMax, sim.bWseNow, sim.bDr);
      markers.setHwmSim(null);
      this.labels?.setHwmValues(null);
      tracers.reset();
      this.ui?.timeline.setScenario(sim.scenario);
      this.ui?.updateLegend();
      this.rainWet = 0;
    });
    sim.on('probe', v => { markers.setProbeWater(v.wse ?? -99); this.ui?.onProbe(); });
    sim.on('error', msg => this.toast(msg, 6000));

    this.state = this._initialState(integrated);
    viewer.setQuality(this.state.display.quality);
    this.labels = new Labels($('#labels'), viewer, data, terrain);
    this.labels.setHwmValues(null);

    $('#loader-text').textContent = 'Building the model grid';
    await new Promise(r => setTimeout(r, 30));
    this._configure();
    this.ui = new UI(this);
    this.ui.timeline.setScenario(sim.scenario);
    this.applyDisplay();
    viewer.setView(this.state.view || VIEWS[0]);
    this._lightKey = '';
    this._updateLighting(true);

    // first frames compile shaders; keep the loader up until they are done
    $('#loader-text').textContent = 'Compiling shaders';
    await new Promise(r => setTimeout(r, 20));
    this.last = performance.now() / 1000;
    this._frame(this.last);
    viewer.renderer.compile(viewer.scene, viewer.camera);
    this._frame(this.last + 0.016);
    $('#loader-bar').style.width = '100%';
    $('#loader-pct').textContent = '100%';
    $('#loader').classList.add('done');
    setTimeout(() => $('#loader').remove(), 700);
    console.info(`FloodTwin ready in ${Math.round(performance.now() - t0)} ms on ${gpu.name || 'unknown GPU'}`);

    const qa = new URLSearchParams(location.search);
    if (qa.has('qa')) this._qa(qa);
    else if (this.fromLink) { this.toast('Scenario loaded from the link'); if (this.fromLink.run) sim.play(); }
    else this._welcome();
    requestAnimationFrame(t => this._loop(t));
  }

  fail(msg) {
    const l = $('#loader');
    l.querySelector('.loader-bar')?.remove();
    l.querySelector('.loader-status')?.remove();
    const e = document.createElement('div'); e.className = 'loader-error'; e.textContent = msg;
    l.querySelector('.loader-inner').appendChild(e);
  }

  _initialState(integrated) {
    const p = presetById('sandy');
    const st = {
      preset: 'sandy',
      ev: { ...p.p },
      model: { dx: 4, drainage: p.p.drainage, infiltration: p.p.infiltration, nPaved: 0.016, nGreen: 0.035, porous: false, theta: 0.8, frMax: 1.0, alpha: 0.7 },
      defences: { waterfront: { on: false, crest: 3.8 }, barriers: [], pumps: [] },
      display: { mode: 0, lighting: 'day', weather: 'auto', quality: integrated || innerWidth < 900 ? 'balanced' : 'high',
        layers: { hwm: true, fema: false, labels: true, tracers: true, trees: true, cars: true, buildings: true } },
      speed: 300,
    };
    const m = location.hash.match(/s=([A-Za-z0-9_-]+)/);
    if (m) {
      try {
        const json = JSON.parse(decodeURIComponent(escape(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')))));
        for (const k of ['preset', 'ev', 'model', 'defences', 'speed', 'view']) if (json[k] != null) st[k] = json[k];
        if (json.display) Object.assign(st.display, json.display, { layers: { ...st.display.layers, ...(json.display.layers || {}) } });
        this.fromLink = { run: !!json.run };
      } catch (e) { console.warn('Could not read the link', e); }
    }
    return st;
  }

  _configure() {
    const st = this.state;
    const model = { ...st.model, barriers: st.defences.barriers, waterfront: st.defences.waterfront, pumps: st.defences.pumps };
    this.sim.speed = st.speed;
    this.sim.configure(model, { ...st.ev, drainage: st.model.drainage, infiltration: st.model.infiltration });
    this.shared.uTEnd.value = this.sim.scenario.duration;
    this.markers.setPumps(st.defences.pumps);
    this.dirty = false;
  }

  /** Apply pending settings (rebuilds the grid if needed) and restart. */
  applyChanges(run) {
    const busy = $('#busy');
    $('#busy-text').textContent = 'Building the model grid';
    busy.hidden = false;
    setTimeout(() => {
      try { this._configure(); } catch (e) { console.error(e); this.toast(`Could not build the model: ${e.message}`, 6000); }
      busy.hidden = true;
      this.ui.renderLeft();
      this.ui.updateLegend();
      this._lightKey = '';
      if (run) this.sim.play();
    }, 40);
  }

  applyPreset(id) {
    const p = presetById(id), st = this.state;
    st.preset = id;
    st.ev = { ...p.p };
    st.model.drainage = p.p.drainage; st.model.infiltration = p.p.infiltration;
    this.applyChanges(true);
  }

  markDirty() { this.dirty = true; }
  markCustom() { this.state.preset = 'custom'; }

  togglePlay() {
    const s = this.sim;
    if (s.status === 'running' || (s.status === 'seeking' && s.resumeAfterSeek)) s.pause(); else s.play();
    this._closeWelcome();
  }

  restart() { this.sim.reset(); this.sim.play(); }

  seek(t) { this.sim.seek(t); }

  setSpeed(v) { this.state.speed = v; this.sim.speed = v; }

  setMode(m) {
    this.state.display.mode = m;
    this.shared.uMode.value = m;
    this.ui.modesEl.set(m);
    this.ui.updateLegend();
  }

  setLighting(l) { this.state.display.lighting = l; this._lightKey = ''; }
  setWeather(w) { this.state.display.weather = w; this._lightKey = ''; }

  setLayer(k, on) {
    this.state.display.layers[k] = on;
    this.applyDisplay();
    if (k === 'fema' || k === 'tracers') this.ui.updateLegend();
  }

  setQuality(q) { this.state.display.quality = q; this.viewer.setQuality(q); }

  applyDisplay() {
    const L = this.state.display.layers;
    this.shared.uShowFema.value = L.fema ? 1 : 0;
    this.shared.uMode.value = this.state.display.mode;
    this.markers.showHwm(L.hwm);
    this.labels.showHwm = L.hwm; this.labels.showPois = L.labels;
    this.veg.trees.visible = L.trees; this.veg.cars.visible = L.cars;
    this.buildings.mesh.visible = L.buildings;
    this.tracers.mesh.visible = L.tracers;
  }

  _hour() {
    const l = this.state.display.lighting, sc = this.sim.scenario;
    if (l === 'day') return 14.5;
    if (l === 'dusk') return 17.35;
    if (l === 'night') return 22;
    if (sc.clock === 'absolute') { const d = new Date(sc.start + this.sim.t * 1000 - 4 * 3600 * 1000); return d.getUTCHours() + d.getUTCMinutes() / 60; }
    return (8 + this.sim.t / 3600) % 24;
  }

  _weather() {
    const w = this.state.display.weather;
    if (w !== 'auto') return w;
    const sc = this.sim.scenario;
    return sc.rain(this.sim.t) > 0 ? 'rain' : 'overcast';
  }

  _updateLighting(force) {
    const hour = this._hour(), weather = this._weather();
    const key = `${Math.round(hour * 6)}|${weather}`;
    if (!force && key === this._lightKey) return;
    this._lightKey = key;
    this.viewer.setLighting(hour, weather);
    const wind = { clear: 0.03, overcast: 0.07, rain: 0.14, storm: 0.26 }[weather];
    this.shared.uWind.value = wind;
    // sea state follows the event: storm surges bring wind waves whatever the sky looks like
    const ev = this.state.ev;
    const surge = ev.mode === 'replay' ? 1 : ev.mode === 'surge' ? Math.min(1, Math.max(0.35, (ev.peak - 1.5) / 1.6)) : 0;
    this.water.uniforms.uStorm.value = Math.max(surge * 0.9, { clear: 0.12, overcast: 0.25, rain: 0.4, storm: 0.9 }[weather]);
    this.shared.uWind.value = Math.max(wind, surge * 0.2);
  }

  // ---------- selection, probe, tools ----------
  selectBuilding(b, showTab = true) {
    this.selected = b;
    this.buildings.select(b >= 0 ? b : -1);
    if (showTab && b >= 0) this.ui.showTab('buildings');
    else if (this.ui.tab === 'buildings') this.ui.renderBuilding();
  }

  hoverBuilding() {}

  flyToBuilding(b) {
    const B = this.data.buildings, c = this.sim.col, r = B.rows[b];
    const v = this.viewer.currentView();
    this.viewer.flyTo({ target: [r[c.cx], r[c.cy], r[c.g] + Math.min(r[c.h], 60) * 0.4], dist: Math.max(220, Math.min(r[c.h] * 4, 900)), polar: 58, azim: v.azim });
  }

  flyToPoint(x, y, dist = 380) {
    const v = this.viewer.currentView();
    this.viewer.flyTo({ target: [x, y, this.terrain.heightAt(x, y)], dist, polar: 58, azim: v.azim });
  }

  setProbe(p) {
    this.sim.setProbe(p);
    this.markers.setProbe(p);
    if (p) this.ui.showTab('probe'); else this.ui.renderProbe();
  }

  setTool(t) {
    if (this.tool === 'draw' && t !== 'draw') { this.draft = []; this.markers.setDraft([]); }
    this.tool = t;
    this.ui.setToolBanner(t, this.draft.length);
    this.ui.renderLeft();
    if (this.ui.tab === 'probe') this.ui.renderProbe();
  }

  addDraftPoint(x, y) {
    this.draft.push([x, y]);
    this.markers.setDraft(this.draft, 3.8);
    this.ui.setToolBanner('draw', this.draft.length);
  }

  finishDraft() {
    if (this.draft.length >= 2) {
      this.state.defences.barriers.push({ points: this.draft.slice(), crest: 3.8 });
      this.markDirty();
      this.toast('Barrier added. Apply and restart to include it in the model.');
    }
    this.draft = [];
    this.markers.setDraft([]);
    this.refreshDefences();
    this.setTool('select');
  }

  addPump(x, y) {
    this.state.defences.pumps.push({ x, y, rate: 2.2 });
    this.markDirty();
    this.refreshDefences();
    this.ui.renderLeft();
    this.toast('Pump placed at 2.2 m³/s (50 million gallons a day). Apply and restart to include it.');
  }

  refreshDefences() {
    this.markers.setDefences(this.state.defences.barriers, this.sim.grid, this.state.defences.waterfront);
    this.markers.setPumps(this.state.defences.pumps);
  }

  riverMidX(y) {
    const g = this.sim.grid, j = Math.min(g.ny - 1, Math.max(0, Math.floor(y / g.dx)));
    return (g.riverMid[j] + 0.5) * g.dx;
  }

  setPortfolio(assets, name) {
    this.portfolioName = name;
    this.sim.setPortfolio(assets);
    this.ui.renderPortfolio();
    this.toast(`${assets.length.toLocaleString('en-US')} properties loaded`);
  }

  /** Return period of a rainfall depth over a duration, from NOAA Atlas 14. */
  returnPeriod(totalMm, hours) {
    const a = this.data.events.atlas14;
    const hrs = a.durations.map(d => d.endsWith('-min') ? parseInt(d) / 60 : d.endsWith('-hr') ? parseInt(d) : parseInt(d) * 24);
    let k = hrs.findIndex(x => x >= hours);
    if (k < 0) k = hrs.length - 1;
    const k0 = Math.max(0, k - 1), w = k === k0 ? 0 : (Math.log(hours) - Math.log(hrs[k0])) / (Math.log(hrs[k]) - Math.log(hrs[k0]));
    const depth = a.return_periods_yr.map((_, r) => a.depth[k0][r] * (1 - Math.min(1, Math.max(0, w))) + a.depth[k][r] * Math.min(1, Math.max(0, w)));
    const R = a.return_periods_yr;
    if (totalMm < depth[0]) return { under: true };
    if (totalMm > depth.at(-1)) return { over: true, rp: R.at(-1) };
    for (let r = 1; r < R.length; r++) {
      if (totalMm <= depth[r]) {
        const f = (Math.log(totalMm) - Math.log(depth[r - 1])) / (Math.log(depth[r]) - Math.log(depth[r - 1]));
        const rp = Math.exp(Math.log(R[r - 1]) + f * (Math.log(R[r]) - Math.log(R[r - 1])));
        return { rp: rp < 10 ? Math.round(rp) : rp < 100 ? Math.round(rp / 5) * 5 : Math.round(rp / 10) * 10 };
      }
    }
    return null;
  }

  share() {
    const st = this.state;
    const payload = { preset: st.preset, ev: st.ev, model: st.model, defences: st.defences, speed: isFinite(st.speed) ? st.speed : 1200,
      display: { mode: st.display.mode, lighting: st.display.lighting, weather: st.display.weather, layers: st.display.layers }, view: this.viewer.currentView(), run: true };
    const enc = btoa(unescape(encodeURIComponent(JSON.stringify(payload)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const url = `${location.origin}${location.pathname}#s=${enc}`;
    history.replaceState(null, '', url);
    navigator.clipboard?.writeText(url).then(() => this.toast('Link copied. It opens this scenario, settings and view.'), () => this.toast('Link is in the address bar.'));
  }

  screenshot() {
    const url = this.viewer.capture(performance.now() / 1000);
    const a = document.createElement('a'); a.href = url; a.download = `floodtwin_${this.state.preset}_${Math.round(this.sim.t / 60)}min.png`; a.click();
  }

  toast(msg, ms = 3200) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(this._toastT);
    this._toastT = setTimeout(() => { t.hidden = true; }, ms);
  }

  _welcome() {
    $('#welcome').hidden = false;
    $('#welcome-sandy').addEventListener('click', () => { this._closeWelcome(); this.viewer.flyTo(VIEWS[0], 2.5); this.sim.play(); });
    $('#welcome-explore').addEventListener('click', () => { this._closeWelcome(); this.toast('Pick an event on the left, then press Run.'); });
  }
  _closeWelcome() { const w = $('#welcome'); if (w && !w.hidden) w.hidden = true; }

  /** Screenshot and test hook: ?qa&preset=sandy&t=15840&mode=1&view=2&light=day&tab=validation&sel=123 */
  _qa(q) {
    const st = this.state;
    if (q.has('preset')) { const p = presetById(q.get('preset')); st.preset = p.id; st.ev = { ...p.p }; st.model.drainage = p.p.drainage; st.model.infiltration = p.p.infiltration; }
    if (q.has('dx')) st.model.dx = +q.get('dx');
    if (q.has('barrier')) st.defences.waterfront = { on: true, crest: +q.get('barrier') };
    if (q.has('quality')) this.setQuality(q.get('quality'));
    this._configure();
    this.ui.renderLeft();
    this.ui.timeline.setScenario(this.sim.scenario);
    if (q.has('light')) this.setLighting(q.get('light'));
    if (q.has('weather')) this.setWeather(q.get('weather'));
    if (q.has('mode')) this.setMode(+q.get('mode'));
    if (q.has('fema')) this.setLayer('fema', true);
    if (q.has('view')) { const v = VIEWS[+q.get('view')] || VIEWS[0]; this.viewer.setView(v); }
    const t = +(q.get('t') || 0);
    const t0 = performance.now();
    const n = t > 0 ? this.sim.runSync(t) : 0;
    console.info(`qa: ${n} steps to t=${t} in ${Math.round(performance.now() - t0)} ms`);
    if (q.has('sel')) this.selectBuilding(+q.get('sel'));
    if (q.has('probe')) { const [x, y] = q.get('probe').split(',').map(Number); this.setProbe({ x, y }); }
    if (q.has('tab')) this.ui.showTab(q.get('tab'));
    for (const k of (q.get('hide') || '').split(',').filter(Boolean)) {
      const o = { water: this.water.group, terrain: this.terrain.mesh, buildings: this.buildings.mesh, trees: this.veg.trees, cars: this.veg.cars, tracers: this.tracers.mesh }[k];
      if (o) o.visible = false;
    }
    if (q.has('seek')) this.sim.seek(+q.get('seek'));
    if (q.has('clean')) document.body.classList.add('clean');
    if (q.has('cam')) { const [x, y, z, d, p, a] = q.get('cam').split(',').map(Number); this.viewer.setView({ target: [x, y, z], dist: d, polar: p, azim: a }); }
    if (q.has('run')) this.sim.play();
    this._lightKey = '';
    let frames = 0;
    const need = +(q.get('frames') || 4);
    const report = (now) => {
      if (now !== true && ++frames < need) { requestAnimationFrame(report); return; }
      const R = this.sim.results, s = this.sim.solver;
      window.__qaReport?.({ ok: true, t: this.sim.t, status: this.sim.status, snaps: this.sim.snaps.map(x => x.time), series: this.sim.series.length, maxSteps: Math.round(this.sim.maxSteps), frames, steps: n, ms: Math.round(performance.now() - t0), wetKm2: +(s.wetArea / 1e6).toFixed(3),
        loss: R ? Math.round(R.struct + R.contents) : null, wet: R?.wet, aboveFF: R?.aboveFF, hwm: R?.hwm, cars30: R?.cars30,
        info: this.viewer.renderer.info.render, programs: this.viewer.renderer.info.programs?.length, reversed: this.viewer.reversed,
        diag: this._diag() });
    };
    report(true);
    requestAnimationFrame(report);
  }

  _diag() {
    const g = this.sim.grid, v = this.viewer, r = v.renderer;
    let deep = 0, minZ = 99;
    for (let c = 0; c < g.N; c++) if (g.kind[c] === 0) { if (g.z[c] < -1) deep++; minZ = Math.min(minZ, g.z[c]); }
    // render the sky alone into a small target and read its centre
    const rt = new THREE.WebGLRenderTarget(8, 8, { type: THREE.HalfFloatType });
    const cam = v.camera.clone(); cam.position.set(0, 50, 0); cam.lookAt(0, 300, -1000); cam.layers.set(0);
    const keep = [];
    v.scene.traverse(o => { if (o.isMesh && o !== v.sky.mesh && o.visible) { keep.push(o); o.visible = false; } });
    r.setRenderTarget(rt); r.setClearColor(0xff00ff, 1); r.clear(); r.render(v.scene, cam);
    const px = new Uint16Array(4); r.readRenderTargetPixels(rt, 4, 4, 1, 1, px);
    keep.forEach(o => { o.visible = true; }); r.setClearColor(0x000000, 1); r.setRenderTarget(null);
    const f = THREE.DataUtils.fromHalfFloat;
    return { deepLand: deep, landMinZ: +minZ.toFixed(2), sky: [f(px[0]), f(px[1]), f(px[2])].map(x => +x.toFixed(3)),
      zenith: v.sky.uniforms.uZenith.value.toArray().map(x => +x.toFixed(3)), skyVisible: v.sky.mesh.visible, near: v.camera.near, far: v.camera.far,
      top: (this.sim.results?.top || []).slice(0, 12).map(b => { const i = this.sim.buildingInfo(b); return [b, i.name, i.cls, +i.g.toFixed(2), +i.wseMax.toFixed(2), i.side, Math.round(this.data.buildings.rows[b][7]), Math.round(this.data.buildings.rows[b][8]), Math.round(i.loss / 1e6)]; }) };
  }

  // ---------- frame loop ----------
  _loop(tms) {
    const t = tms / 1000;
    this._frame(t);
    requestAnimationFrame(x => this._loop(x));
  }

  _frame(t) {
    const dt = Math.min(0.25, Math.max(0, t - (this.last ?? t)));
    this.last = t;
    const sim = this.sim, sh = this.shared, sc = sim.scenario;
    const t0 = sim.t;
    sim.update(dt, t);
    const adv = sim.t - t0;
    sh.uTime.value = t;
    sh.uSimTime.value = sim.t;
    sh.uStats.value = sim.solver.statsA.texture;
    const rain = sc.rain(sim.t);
    sh.uRainVis.value = Math.min(1, rain / 45);
    this.viewer.rain = Math.min(1, rain / 40);
    const target = rain > 0 ? Math.min(1, rain / 15) : 0;
    this.rainWet = target > this.rainWet ? Math.min(target, this.rainWet + adv / 300 + dt * 0.5) : Math.max(target, this.rainWet - Math.max(0, adv) / 3600);
    sh.uRainWet.value = this.rainWet;
    const stage = sc.stage(sim.t);
    this.viewer.waterLevel = Math.max(-1.5, Math.min(6, stage));
    this.water.setRiverCurrent((sc.stage(sim.t + 120) - sc.stage(sim.t - 120)) / 240);
    if (this.state.display.layers.tracers) this.tracers.update(dt);
    if (this.state.display.lighting === 'event' || this.state.display.weather === 'auto') this._updateLighting();
    this.markers.update(this.viewer.camera);
    this.viewer.render(t);
    this.labels.update(this.markers);
    this.ui?.frame(t);
  }
}

// QA runs collect errors into <pre id="out"> so a headless DOM dump can read them
if (new URLSearchParams(location.search).has('qa')) {
  const out = document.createElement('pre'); out.id = 'out'; out.hidden = true; out.textContent = 'running'; document.body.appendChild(out);
  const errors = [];
  window.__qaErrors = errors;
  const ce = console.error.bind(console);
  console.error = (...a) => { errors.push(a.map(x => String(x?.stack || x)).join(' ').slice(0, 4000)); ce(...a); };
  window.addEventListener('error', e => errors.push(`error: ${e.message} at ${e.filename}:${e.lineno}`));
  window.addEventListener('unhandledrejection', e => errors.push(`rejection: ${e.reason?.stack || e.reason}`));
  window.__qaReport = (info) => { out.textContent = JSON.stringify({ errors, ...info }); };
  // live tests: an image from a delayed test endpoint holds the load event open,
  // so a DOM dump taken after load sees the app after that much wall-clock time
  const hold = new URLSearchParams(location.search).get('hold');
  if (hold) { const img = new Image(); img.src = `/__delay?ms=${+hold}`; img.style.display = 'none'; document.body.appendChild(img); }
}

const app = new App();
window.floodtwin = app;
app.start().catch(e => { console.error(e); app.fail(`Something went wrong while starting: ${e.message}`); window.__qaReport?.({ ok: false, fatal: String(e?.stack || e) }); });
