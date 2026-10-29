// Bottom timeline: boundary water level (with the predicted tide for the
// Sandy replay), rainfall in its own band, the part of the event already
// computed, snapshots and the playhead. Click or drag to move through the event.
import { niceTicks } from './charts.js';
import { clockLabel, shortClock } from './scenarios.js';

const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
};

export class Timeline {
  constructor(host, sim, onSeek) {
    this.host = host; this.sim = sim; this.onSeek = onSeek;
    host.replaceChildren();
    const head = document.createElement('div'); head.className = 'timeline-head';
    this.title = document.createElement('div');
    this.legend = document.createElement('div'); this.legend.className = 'legend-row';
    this.note = document.createElement('div'); this.note.className = 'block-sub';
    const left = document.createElement('div'); left.style.cssText = 'display:flex;gap:14px;align-items:center;min-width:0';
    left.append(this.title, this.legend);
    head.append(left, this.note);
    this.svg = el('svg', { role: 'slider', tabindex: 0, 'aria-label': 'Event time' });
    host.append(head, this.svg);
    this.tip = document.createElement('div'); this.tip.className = 'chart-tip'; this.tip.hidden = true;
    host.style.position = 'fixed';
    host.appendChild(this.tip);
    this._bind();
    new ResizeObserver(() => this.draw()).observe(this.svg);
  }

  setScenario(sc) {
    this.sc = sc;
    const N = 240, pts = [], tide = [], rain = [];
    for (let k = 0; k <= N; k++) {
      const t = (k / N) * sc.duration;
      pts.push([t, sc.stage(t)]);
      tide.push([t, sc.tideOnly(t)]);
    }
    const RB = 72;
    for (let k = 0; k < RB; k++) {
      const t0 = (k / RB) * sc.duration, t1 = ((k + 1) / RB) * sc.duration;
      rain.push([t0, t1, sc.rain((t0 + t1) / 2)]);
    }
    this.stage = pts; this.tide = sc.observed ? tide : null; this.rain = rain;
    this.hasRain = rain.some(r => r[2] > 0);
    let peak = pts[0];
    for (const p of pts) if (p[1] > peak[1]) peak = p;
    this.peak = peak;
    const replay = sc.params.mode === 'replay';
    this.title.textContent = replay ? 'Water Level at The Battery, m NAVD88' : 'Boundary Water Level, m NAVD88';
    this.legend.replaceChildren();
    const key = (color, name) => {
      const s = document.createElement('span'); s.className = 'key';
      const i = document.createElement('i'); i.style.background = color;
      s.append(i, document.createTextNode(name)); this.legend.appendChild(s);
    };
    if (this.tide) { key('var(--series-1)', sc.params.offset ? 'Observed, Corrected' : 'Observed'); key('var(--series-2)', 'Predicted Tide'); }
    const total = rain.reduce((s, r) => s + r[2] * (r[1] - r[0]) / 3600, 0);
    this.note.textContent = `Peak ${peak[1].toFixed(2)} m at ${shortClock(sc, peak[0])}` + (this.hasRain ? ` · Rain ${Math.round(total)} mm` : '');
    this.draw();
  }

  draw() {
    if (!this.sc) return;
    const svg = this.svg, W = Math.max(200, svg.clientWidth), H = Math.max(40, svg.clientHeight);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.replaceChildren();
    const M = { l: 34, r: 8, t: 2, b: 14 };
    const rainH = this.hasRain ? 14 : 0;
    const y0 = M.t + rainH + (rainH ? 4 : 0), y1 = H - M.b;
    let lo = Infinity, hi = -Infinity;
    for (const p of this.stage) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    if (this.tide) for (const p of this.tide) { lo = Math.min(lo, p[1]); hi = Math.max(hi, p[1]); }
    const yt = niceTicks(lo - 0.1, hi + 0.1, 2);
    lo = Math.min(lo, yt.ticks[0]); hi = Math.max(hi, yt.ticks.at(-1));
    const D = this.sc.duration;
    const sx = t => M.l + (t / D) * (W - M.l - M.r);
    const sy = z => y1 - ((z - lo) / (hi - lo || 1)) * (y1 - y0);
    this.sx = sx; this.W = W; this.M = M;
    this.gDone = el('rect', { x: M.l, y: M.t, height: H - M.t - M.b, width: 0, class: 'tl-done' }, svg);
    for (const z of yt.ticks) {
      el('line', { x1: M.l, x2: W - M.r, y1: sy(z), y2: sy(z), class: 'chart-grid' }, svg);
      el('text', { x: M.l - 5, y: sy(z) + 3.5, class: 'tl-label', 'text-anchor': 'end' }, svg).textContent = z.toFixed(z % 1 ? 1 : 0);
    }
    // hourly ticks
    const step = D > 10 * 3600 ? 7200 : 3600;
    for (let t = 0; t <= D + 1; t += step) {
      el('line', { x1: sx(t), x2: sx(t), y1: y1, y2: y1 + 3, class: 'chart-base' }, svg);
      el('text', { x: sx(t), y: H - 2, class: 'tl-label', 'text-anchor': t === 0 ? 'start' : 'middle' }, svg).textContent = shortClock(this.sc, t);
    }
    if (this.hasRain) {
      const rmax = Math.max(...this.rain.map(r => r[2]), 10);
      for (const [a, b, r] of this.rain) {
        if (r <= 0) continue;
        const h = (r / rmax) * rainH;
        el('rect', { x: sx(a) + 0.5, width: Math.max(1, sx(b) - sx(a) - 1), y: M.t + rainH - h, height: h, class: 'tl-rain' }, svg);
      }
      el('text', { x: M.l - 5, y: M.t + 10, class: 'tl-label', 'text-anchor': 'end' }, svg).textContent = 'Rain';
    }
    const path = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
    if (this.tide) el('path', { d: path(this.tide), fill: 'none', stroke: 'var(--series-2)', 'stroke-width': 1.5, 'stroke-linejoin': 'round', opacity: 0.9 }, svg);
    el('path', { d: path(this.stage), fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, svg);
    const pk = this.peak;
    el('circle', { cx: sx(pk[0]), cy: sy(pk[1]), r: 3.5, fill: 'var(--series-1)', class: 'chart-dot' }, svg);
    this.gSnaps = el('g', {}, svg);
    this.hoverLine = el('line', { y1: M.t, y2: y1, class: 'tl-hover', visibility: 'hidden' }, svg);
    this.head = el('line', { y1: M.t, y2: y1, class: 'tl-head' }, svg);
    this.knob = el('circle', { r: 5, cy: M.t + 3, class: 'tl-knob' }, svg);
    this.sy = sy;
    this.update(true);
  }

  update(force) {
    if (!this.sx || !this.sc) return;
    const t = this.dragT ?? this.sim.t;
    const x = this.sx(Math.min(t, this.sc.duration));
    this.head.setAttribute('x1', x); this.head.setAttribute('x2', x); this.knob.setAttribute('cx', x);
    this.gDone.setAttribute('width', Math.max(0, this.sx(this.sim.t) - this.M.l));
    this.svg.setAttribute('aria-valuenow', Math.round(this.sim.t));
    this.svg.setAttribute('aria-valuetext', clockLabel(this.sc, this.sim.t));
    const n = this.sim.snaps.length;
    if (force || n !== this._nSnaps) {
      this._nSnaps = n;
      this.gSnaps.replaceChildren();
      for (const s of this.sim.snaps) {
        const sx = this.sx(s.time);
        el('line', { x1: sx, x2: sx, y1: this.svg.clientHeight - this.M.b - 4, y2: this.svg.clientHeight - this.M.b, class: 'tl-snap' }, this.gSnaps);
      }
    }
  }

  _tAt(clientX) {
    const r = this.svg.getBoundingClientRect();
    const f = (clientX - r.left - this.M.l) / (r.width - this.M.l - this.M.r);
    return Math.max(0, Math.min(1, f)) * this.sc.duration;
  }

  _bind() {
    const svg = this.svg;
    let dragging = false;
    svg.addEventListener('pointerdown', e => {
      if (!this.sc) return;
      dragging = true; svg.setPointerCapture(e.pointerId);
      this.dragT = this._tAt(e.clientX); this.update();
    });
    svg.addEventListener('pointermove', e => {
      if (!this.sc) return;
      const t = this._tAt(e.clientX);
      if (dragging) { this.dragT = t; this.update(); }
      const x = this.sx(t);
      this.hoverLine.setAttribute('x1', x); this.hoverLine.setAttribute('x2', x); this.hoverLine.setAttribute('visibility', 'visible');
      this._showTip(e.clientX, t);
    });
    const end = e => {
      if (!dragging) return;
      dragging = false;
      const t = this.dragT; this.dragT = null;
      this.onSeek(t);
      this.update();
    };
    svg.addEventListener('pointerup', end);
    svg.addEventListener('pointercancel', end);
    svg.addEventListener('pointerleave', () => { this.hoverLine?.setAttribute('visibility', 'hidden'); this.tip.hidden = true; });
    svg.addEventListener('keydown', e => {
      if (!this.sc) return;
      const d = e.shiftKey ? 3600 : 600;
      if (e.key === 'ArrowRight') { this.onSeek(Math.min(this.sc.duration, this.sim.t + d)); e.preventDefault(); }
      if (e.key === 'ArrowLeft') { this.onSeek(Math.max(0, this.sim.t - d)); e.preventDefault(); }
    });
  }

  _showTip(clientX, t) {
    const sc = this.sc, tip = this.tip;
    tip.replaceChildren();
    const h = document.createElement('div'); h.className = 'chart-tip-title'; h.textContent = clockLabel(sc, t); tip.appendChild(h);
    const row = (color, value, name) => {
      const r = document.createElement('div'); r.className = 'chart-tip-row';
      const k = document.createElement('span'); k.className = 'chart-tip-key'; k.style.background = color;
      const v = document.createElement('strong'); v.textContent = value;
      const n = document.createElement('span'); n.className = 'chart-tip-name'; n.textContent = name;
      r.append(k, v, n); tip.appendChild(r);
    };
    row('var(--series-1)', `${sc.stage(t).toFixed(2)} m`, sc.observed ? 'Observed' : 'Boundary');
    if (sc.observed) row('var(--series-2)', `${sc.tideOnly(t).toFixed(2)} m`, 'Predicted tide');
    if (this.hasRain) row('transparent', `${sc.rain(t).toFixed(0)} mm/h`, 'Rain');
    if (t > this.sim.t + 1) { const r = document.createElement('div'); r.className = 'chart-tip-name'; r.textContent = 'Not computed yet: click to run ahead'; tip.appendChild(r); }
    tip.hidden = false;
    const hr = this.host.getBoundingClientRect();
    const x = clientX - hr.left;
    tip.style.left = `${Math.min(Math.max(0, x + 12), hr.width - tip.offsetWidth)}px`;
    tip.style.top = `${-tip.offsetHeight - 6}px`;
  }
}
