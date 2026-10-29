// Simulation controller: builds the model for a configuration, advances the
// GPU solver against the scenario clock within a frame-time budget, records
// time series and snapshots (for scrubbing back), and turns the water levels
// around each building into FloodVuln damage ratios and losses.
import { buildGrid, buildSamples, pointSamples, KIND } from './grid.js';
import { FloodSolver } from './solver.js';
import { makeScenario } from './scenarios.js';
import { makeVuln } from './vuln.js';

const LOG_EVERY = 300;            // s of simulated time between time-series points
const SNAP_BUDGET = 160e6;        // bytes of GPU memory for snapshots
const STOREY_M = 3.1;
// FloodVuln curves are conditional on water entering the building. A building
// counts as flooded, and takes damage, once 15 cm of water stands against it;
// thinner sheet flow from rain is treated as not entering.
const ENTRY_M = 0.15;

export class Simulation {
  constructor(renderer, data, geo) {
    this.renderer = renderer; this.data = data; this.geo = geo;
    this.vuln = makeVuln(data.events);
    const B = data.buildings;
    this.nb = B.count;
    this.col = Object.fromEntries(B.columns.map((c, k) => [c, k]));
    this.hwm = data.events.hwm;
    this.carPts = data.cars.rows.map(r => ({ x: r[0], y: r[1], z: r[2] }));
    this.portfolio = [];
    this.handlers = {};
    this.status = 'idle';
    this.speed = 300;
    this.maxSteps = 30;
    this.ft = 1 / 60;
    this.simRate = 0;
    this.t = 0;
    this.series = [];
    this.snaps = [];
    this.probe = null;
    this.bWseMax = new Float32Array(this.nb).fill(-99);
    this.bWseNow = new Float32Array(this.nb).fill(-99);
    this.bDr = new Float32Array(this.nb).fill(-1);
    this.bLoss = new Float32Array(this.nb);
    this.bShare = new Float32Array(this.nb);
    for (let b = 0; b < this.nb; b++) {
      const a = B.attrs[b];
      const floors = a?.stories || Math.max(1, Math.round(B.rows[b][this.col.h] / STOREY_M));
      this.bShare[b] = Math.min(1, 2 / floors);        // damage applies to the two lowest storeys
    }
  }

  on(e, f) { (this.handlers[e] ||= []).push(f); }
  emit(e, x) { for (const f of this.handlers[e] || []) f(x); }

  /**
   * model: { dx, drainage, infiltration, nPaved, nGreen, porous, barriers, waterfront, pumps, theta, frMax, alpha }
   * ev: scenario parameters (see scenarios.js)
   */
  configure(model, ev) {
    const gkey = JSON.stringify([model.dx, model.drainage, model.infiltration, model.nPaved, model.nGreen, model.porous, model.barriers, model.waterfront]);
    if (gkey !== this.gkey) {
      const g = buildGrid(this.data, { dx: model.dx, drainage: model.drainage, infiltration: model.infiltration,
        nPaved: model.nPaved, nGreen: model.nGreen, porousBuildings: model.porous, barriers: model.barriers,
        waterfrontBarrier: model.waterfront });
      if (!this.solver || this.solver.nx !== g.nx || this.solver.ny !== g.ny) {
        this.disposeSnaps();
        this.solver?.dispose();
        this.solver = new FloodSolver(this.renderer, { nx: g.nx, ny: g.ny, dx: g.dx, bed: g.bed });
      } else this.solver.setBed(g.bed);
      this.solver.minCoastZ = g.minCoastZ;
      this.grid = g; this.gkey = gkey;
      const skey = `${model.dx}|${model.porous}`;
      if (skey !== this.skey) {
        this.base = buildSamples(this.data, g, this.hwm); this.carIds = pointSamples(this.carPts, g); this.skey = skey;
        this._groundLevels(g);
      }
      this._uploadSamples();
      const cells = g.nx * g.ny, bytes = cells * 16;
      this.maxSnaps = Math.max(2, Math.floor(SNAP_BUDGET / bytes));
      this.emit('grid', g);
    }
    const p = this.solver.params;
    p.theta = model.theta ?? 0.8; p.frMax = model.frMax ?? 1.0; p.alpha = model.alpha ?? 0.7;
    const dx = this.grid.dx;
    this.solver.setSources((model.pumps || []).map(q => {
      const i = Math.floor(q.x / dx), j = Math.floor(q.y / dx), r = Math.max(1.5, 6 / dx);
      let cells = 0;
      for (let b = -Math.ceil(r); b <= Math.ceil(r); b++) for (let a = -Math.ceil(r); a <= Math.ceil(r); a++) if (Math.hypot(a, b) <= r) cells++;
      return { i, j, r, rate: -Math.abs(q.rate), cells };
    }));
    this.model = model;
    this.params = ev;
    this.scenario = makeScenario(ev, this.data.events);
    this.snapEvery = Math.max(1800, Math.ceil(this.scenario.duration / (this.maxSnaps - 1) / 1800) * 1800);
    this.reset();
  }

  /** Ground level per building: the median elevation of the open cells around it,
   *  i.e. the street or yard at its doors. The footprint statistic in the data (10th
   *  percentile of the bare-earth surface) catches areaways and the low corner of
   *  sloping lots, and over water (terminals and sheds on piers, moored ships) it is
   *  the river surface. The footprint value is kept only when no open cell is found. */
  _groundLevels(g) {
    const B = this.data.buildings, ig = this.col.g, ids = this.base.ids;
    this.bGround = new Float32Array(this.nb);
    const zs = [];
    for (let b = 0; b < this.nb; b++) {
      zs.length = 0;
      for (let k = 0; k < 8; k++) { const c = ids[b * 8 + k]; if (c >= 0) zs.push(g.z0[c]); }
      if (!zs.length) { this.bGround[b] = B.rows[b][ig]; continue; }
      zs.sort((a, c) => a - c);
      this.bGround[b] = zs.length % 2 ? zs[zs.length >> 1] : 0.5 * (zs[zs.length / 2 - 1] + zs[zs.length / 2]);
    }
  }

  _uploadSamples() {
    const nb = this.base.count, nc = this.carPts.length, np = this.portfolio.length;
    const ids = new Float32Array((nb + nc + np) * 8);
    ids.set(this.base.ids, 0);
    ids.set(this.carIds, nb * 8);
    if (np) ids.set(pointSamples(this.portfolio, this.grid), (nb + nc) * 8);
    this.offCars = nb; this.offPort = nb + nc;
    this.solver.setBuildingSamples(ids, nb + nc + np);
  }

  setPortfolio(assets) {
    this.portfolio = assets;
    if (this.solver) { this._uploadSamples(); this._sampleSoon = true; }
  }

  reset() {
    const s = this.solver, sc = this.scenario;
    this.seekTarget = null;
    s.reset();
    this.disposeSnaps();
    this.t = 0; this.series = []; this.status = 'idle';
    this.lastStats = 0; this.nextLog = 0; this.nextSnap = 0; this.maxArea = 0;
    this.results = null; this.probeSeries = [];
    this.epoch = (this.epoch || 0) + 1;
    this.bWseMax.fill(-99); this.bWseNow.fill(-99); this.bDr.fill(-1); this.bLoss.fill(0);
    s.stage = sc.stage(0); s.rain = 0;
    s.step(1e-4);                 // fill the boundary water
    s.time = 0;
    s.updateStats(); s.updateVis(); s.reduceSync();
    this._snap();
    this._log();
    this._sampleSoon = true;
    this.emit('reset', this);
  }

  play() {
    if (this.status === 'done') { this.seek(0); }
    this.status = 'running';
    this.emit('status', this.status);
  }

  pause() {
    if (this.status === 'running') this.status = 'paused';
    if (this.seekTarget != null) this.resumeAfterSeek = false;
    this.emit('status', this.status);
  }

  /** Jump to simulated time tt: restore the latest snapshot before it, then run forward. */
  seek(tt) {
    const sc = this.scenario, s = this.solver;
    tt = Math.max(0, Math.min(sc.duration, tt));
    const wasRunning = this.status === 'running' || (this.seekTarget != null && this.resumeAfterSeek);
    if (tt < this.t - 0.5) {
      let snap = this.snaps[0];
      for (const sn of this.snaps) if (sn.time <= tt + 1e-6) snap = sn;
      s.restore(snap);
      this.t = snap.time; s.time = snap.time;
      this.snaps = this.snaps.filter(sn => { if (sn.time > snap.time + 1e-6) { sn.state.dispose(); sn.stats.dispose(); return false; } return true; });
      this.nextSnap = snap.time + this.snapEvery;
      this.series = this.series.filter(p => p.t <= this.t + 1e-6);
      this.probeSeries = this.probeSeries.filter(p => p[0] <= this.t + 1e-6);
      this.nextLog = (Math.floor(this.t / LOG_EVERY) + 1) * LOG_EVERY;
      this.lastStats = this.t;
      this.maxArea = this.series.reduce((m, p) => Math.max(m, p.area), 0);
      this.epoch++;
      s.stage = sc.stage(this.t);
      s.reduceSync();
    }
    if (tt > this.t + 0.01) {
      this.seekTarget = tt; this.resumeAfterSeek = wasRunning; this.status = 'seeking';
    } else {
      this.seekTarget = null; this.status = wasRunning ? 'running' : (this.t >= sc.duration - 1e-6 ? 'done' : 'paused');
    }
    this._sampleSoon = true;
    this.emit('status', this.status);
    this.emit('seek', this.t);
  }

  /** Advance by one display frame. realDt: wall-clock seconds since the last frame. */
  update(realDt, now) {
    const s = this.solver, sc = this.scenario;
    if (!s) return;
    let steps = 0, advanced = 0;
    const seeking = this.seekTarget != null;
    const maxSteps = Math.round(seeking ? this.maxSteps * 1.4 : this.maxSteps);
    if (this.status === 'running' || seeking) {
      const end = seeking ? this.seekTarget : sc.duration;
      let budget = seeking || !isFinite(this.speed) ? Infinity : this.speed * Math.min(realDt, 0.1);
      while (budget > 1e-6 && steps < maxSteps && this.t < end - 1e-6) {
        s.stage = sc.stage(this.t);
        s.rain = sc.rain(this.t) / 3.6e6;
        let dt = Math.min(s.stableDt(), budget, end - this.t);
        if (this.nextSnap > this.t) dt = Math.min(dt, this.nextSnap - this.t);
        dt = Math.max(dt, 1e-4);
        s.step(dt);
        this.t += dt; budget -= dt; advanced += dt; steps++;
        if (this.t - this.lastStats >= 10) { s.updateStats(); this.lastStats = this.t; }
        if (this.t >= this.nextSnap - 1e-6) this._snap();
        if (this.t >= this.nextLog - 1e-6) this._log();
      }
      s.reduce();
      if (!(s.cmax < 1e3) || !(s.hmax < 1e3)) { this.status = 'error'; this.emit('error', 'The solver became unstable. Try a larger cell size or a smaller time step factor.'); return; }
      if (seeking && this.t >= this.seekTarget - 1e-6) {
        this.seekTarget = null;
        this.status = this.resumeAfterSeek ? 'running' : 'paused';
        s.updateStats(); this.lastStats = this.t;
        this._sampleSoon = true;
        this.emit('status', this.status);
      }
      if (this.t >= sc.duration - 1e-6 && this.status !== 'done') {
        this.status = 'done';
        s.updateStats();
        this._log(true);
        this._sampleSoon = true;
        this.emit('status', this.status);
      }
      this._adapt(realDt, steps >= maxSteps);
    }
    s.updateVis();
    this.stepsLastFrame = steps;
    this.simRate = this.simRate * 0.9 + (advanced / Math.max(realDt, 1e-3)) * 0.1;
    if (this._sampleSoon || (steps > 0 && now - (this._lastSample || 0) > 0.45)) this._sample(now);
    if (this.probe && now - (this._lastProbe || 0) > 0.2) this._readProbe(now);
  }

  /** Run synchronously to simulated time tt (tests, screenshots). */
  runSync(tt) {
    const s = this.solver, sc = this.scenario;
    tt = Math.min(tt, sc.duration);
    this.epoch++;
    let n = 0;
    while (this.t < tt - 1e-6) {
      s.stage = sc.stage(this.t); s.rain = sc.rain(this.t) / 3.6e6;
      if (n % 20 === 0) s.reduceSync();
      let dt = Math.min(s.stableDt(), tt - this.t);
      if (this.nextSnap > this.t) dt = Math.min(dt, this.nextSnap - this.t);
      s.step(Math.max(dt, 1e-4)); this.t += Math.max(dt, 1e-4); n++;
      if (this.t - this.lastStats >= 10) { s.updateStats(); this.lastStats = this.t; }
      if (this.t >= this.nextSnap - 1e-6) this._snap();
      if (this.t >= this.nextLog - 1e-6) { s.reduceSync(); this._process(s.sampleBuildingsSync(), this.t); this._log(); }
    }
    s.updateStats(); s.updateVis(); s.reduceSync();
    this._process(s.sampleBuildingsSync(), this.t);
    this.status = this.t >= sc.duration - 1e-6 ? 'done' : 'paused';
    return n;
  }

  _adapt(realDt, limited) {
    this.ft = this.ft * 0.92 + Math.min(realDt, 0.2) * 0.08;
    if (this.ft > 1 / 34) this.maxSteps = Math.max(2, this.maxSteps * 0.9);
    else if (this.ft < 1 / 52 && limited) this.maxSteps = Math.min(800, this.maxSteps * 1.07 + 0.5);
  }

  _snap() {
    if (this.snaps.length < this.maxSnaps && (!this.snaps.length || this.t > this.snaps.at(-1).time + 1)) this.snaps.push(this.solver.snapshot());
    this.nextSnap = (Math.floor(this.t / this.snapEvery + 1e-6) + 1) * this.snapEvery;
  }

  disposeSnaps() {
    for (const sn of this.snaps) { sn.state.dispose(); sn.stats.dispose(); }
    this.snaps = [];
  }

  _log(force) {
    const s = this.solver, sc = this.scenario, r = this.results;
    const p = { t: this.t, stage: sc.stage(this.t), rain: sc.rain(this.t), area: s.wetArea / 1e6, vol: s.volume / 1e6,
      wet: r?.wet ?? 0, loss: r ? r.struct + r.contents : 0 };
    if (this.series.length && Math.abs(this.series.at(-1).t - p.t) < 1) this.series[this.series.length - 1] = p;
    else this.series.push(p);
    this.maxArea = Math.max(this.maxArea, p.area);
    if (!force) this.nextLog = (Math.floor(this.t / LOG_EVERY + 1e-6) + 1) * LOG_EVERY;
    this.emit('log', p);
  }

  _sample(now) {
    const pr = this.solver.sampleBuildings();
    if (!pr) return;
    this._sampleSoon = false;
    this._lastSample = now;
    const tAt = this.t, epoch = this.epoch;
    // a reset, a jump back or a synchronous run makes in-flight samples stale
    pr.then(buf => { if (epoch === this.epoch) this._process(buf, tAt); }).catch(() => {});
  }

  _process(buf, tAt) {
    const B = this.data.buildings, rows = B.rows, attrs = B.attrs, c = this.col, nb = this.nb, V = this.vuln;
    const reg = () => ({ wet: 0, aboveFF: 0, loss: 0, residents: 0, exposed: 0 });
    const R = { t: tAt, wet: 0, aboveFF: 0, struct: 0, contents: 0, low: 0, high: 0, residents: 0, region: { NJ: reg(), NY: reg() } };
    for (let b = 0; b < nb; b++) {
      const cur = buf[4 * b + 1], mx = buf[4 * b + 3];
      this.bWseNow[b] = cur; this.bWseMax[b] = mx;
      const row = rows[b], g = this.bGround[b], side = row[c.side] === 'NY' ? 'NY' : 'NJ', rg = R.region[side];
      const a = attrs[b];
      if (a) rg.exposed += a.vs + a.vc;
      let dr = -1, loss = 0;
      if (mx > g + ENTRY_M) {
        R.wet++; rg.wet++;
        dr = 0;
        if (a && a.arch) {
          const d = V.damage(a.arch, side, mx, g, a.ffh), sh = this.bShare[b];
          dr = d.mean;
          loss = d.mean * (a.vs + a.vc) * sh;
          R.struct += d.mean * a.vs * sh; R.contents += d.mean * a.vc * sh;
          R.low += d.p10 * (a.vs + a.vc) * sh; R.high += d.p90 * (a.vs + a.vc) * sh;
          if (d.d > 0) { R.aboveFF++; rg.aboveFF++; R.residents += a.pn || 0; rg.residents += a.pn || 0; }
          rg.loss += loss;
        }
      }
      this.bDr[b] = dr; this.bLoss[b] = loss;
    }
    R.hwm = this.hwm.map((h, k) => { const v = buf[4 * (nb + k) + 3]; return v > -90 ? v : null; });
    let c30 = 0, c60 = 0;
    for (let k = 0; k < this.carPts.length; k++) {
      const d = buf[4 * (this.offCars + k) + 2];
      if (d > 0.3) c30++;
      if (d > 0.6) c60++;
    }
    R.cars30 = c30; R.cars60 = c60;
    R.portfolio = this._portfolio(buf);
    // largest losses
    const idx = [];
    for (let b = 0; b < nb; b++) if (this.bLoss[b] > 0) idx.push(b);
    idx.sort((a, b) => this.bLoss[b] - this.bLoss[a]);
    R.top = idx.slice(0, 12);
    this.results = R;
    if (this.series.length) { const last = this.series.at(-1); if (Math.abs(last.t - tAt) < LOG_EVERY) { last.wet = R.wet; last.loss = R.struct + R.contents; } }
    this.emit('results', R);
  }

  _portfolio(buf) {
    const P = this.portfolio;
    if (!P.length) return null;
    const out = { n: P.length, flooded: 0, exposure: 0, loss: 0, loans: 0, ltv80: 0, ltv100: 0, rows: [] };
    P.forEach((a, k) => {
      const wse = buf[4 * (this.offPort + k) + 3];
      const g = a.ground;
      const d = this.vuln.damage(a.arch, a.side, wse > g + ENTRY_M ? wse : -99, g, a.ffh);
      const loss = d.mean * a.value * (a.share ?? 1);
      out.exposure += a.value; out.loss += loss;
      const depth = wse > -90 ? Math.max(0, wse - g) : 0;
      if (depth > 0.02) out.flooded++;
      let ltvAfter = null;
      if (a.loan) {
        out.loans += a.loan;
        ltvAfter = a.loan / Math.max(1, a.value - loss);
        if (a.loan / a.value <= 0.8 && ltvAfter > 0.8) out.ltv80++;
        if (a.loan / a.value <= 1 && ltvAfter > 1) out.ltv100++;
      }
      out.rows.push({ id: a.id, depth, dr: d.mean, p10: d.p10, p90: d.p90, loss, ltvAfter });
    });
    return out;
  }

  // ---- probe ----
  setProbe(p) {
    this.probe = p;
    this.probeSeries = [];
    this.probeValue = null;
    this._lastProbeT = -1e9;
    if (p) this._readProbe(0, true);
  }

  _readProbe(now) {
    const g = this.grid, p = this.probe;
    const i = Math.floor(p.x / g.dx), j = Math.floor(p.y / g.dx);
    const pr = this.solver.readCell(i, j);
    if (!pr) return;
    this._lastProbe = now;
    const c = j * g.nx + i, tAt = this.t;
    pr.then(v => {
      if (!v || this.probe !== p) return;
      const z = g.z[c];
      v.z = z; v.kind = g.kind[c]; v.wse = v.h > 0.005 ? z + v.h : null;
      v.speed = Math.hypot(v.u, v.v);
      v.hazard = v.h > 0.02 ? v.h * (v.speed + 0.5) + (v.h > 0.25 ? 0.5 : 0) : 0;
      this.probeValue = v;
      if (tAt - this._lastProbeT >= 60 || !this.probeSeries.length) {
        this.probeSeries.push([tAt, v.h, v.speed]);
        this._lastProbeT = tAt;
      }
      this.emit('probe', v);
    });
  }

  /** Water at a point from the last building sample, for hover read-outs. */
  buildingInfo(b) {
    const B = this.data.buildings, row = B.rows[b], c = this.col, a = B.attrs[b];
    const g = this.bGround ? this.bGround[b] : row[c.g];
    const info = { b, id: row[c.id], name: row[c.name], cls: B.class_names[row[c.cls]], h: row[c.h], g, side: row[c.side],
      area: row[c.area], attrs: a, wseMax: this.bWseMax[b], wseNow: this.bWseNow[b], share: this.bShare[b] };
    info.depthMax = info.wseMax > -90 ? Math.max(0, info.wseMax - g) : 0;
    info.depthNow = info.wseNow > -90 ? Math.max(0, info.wseNow - g) : 0;
    if (a?.arch) {
      info.damage = this.vuln.damage(a.arch, info.side, info.wseMax > g + ENTRY_M ? info.wseMax : -99, g, a.ffh);
      info.loss = info.damage.mean * (a.vs + a.vc) * info.share;
      info.curve = this.vuln.curve(a.arch, info.side);
    }
    return info;
  }
}

export { KIND };
