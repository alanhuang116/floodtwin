// Interface: scenario builder (left), analysis tabs (right), transport, view
// modes, legend, camera tools, map tools (probe, barrier drawing, pumps,
// building selection) and keyboard shortcuts. App state and actions live in main.js.
import { PRESETS, clockLabel, shortClock } from './scenarios.js';
import { RAMPS, HAZARD, cssGradient } from './ramps.js';
import { lineChart, scatterChart, curveChart, tableView } from './charts.js';
import { Timeline } from './timeline.js';
import { download, buildingsCSV, seriesCSV, maxDepthASC, portfolioCSV, PRJ_UTM18N } from './exports.js';
import { demoPortfolio, parsePortfolioCSV, SAMPLE_CSV } from './portfolio.js';

const $ = (s) => document.querySelector(s);

export function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k === 'on') for (const [ev, f] of Object.entries(v)) e.addEventListener(ev, f);
    else if (k === 'style') e.style.cssText = v;
    else if (v === true) e.setAttribute(k, '');
    else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c != null && c !== false) e.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return e;
}

export const fmtInt = v => Math.round(v).toLocaleString('en-US');
export const fmtMoney = v => {
  const a = Math.abs(v);
  return a >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : a >= 1e6 ? `$${(v / 1e6).toFixed(a >= 1e8 ? 0 : 1)}M` : a >= 1e3 ? `$${Math.round(v / 1e3)}K` : `$${Math.round(v)}`;
};
const fmtM = (v, d = 2) => `${v.toFixed(d)} m`;
const pct = v => `${Math.round(v * 100)}%`;
const chev = () => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('class', 'chev'); s.innerHTML = '<path d="M4 6l4 4 4-4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>'; return s; };

function slider({ label, min, max, step, value, fmt, hint, ticks, onInput }) {
  const val = h('span', { class: 'field-value' });
  const input = h('input', { type: 'range', min, max, step, 'aria-label': label });
  input.value = value;
  const paint = () => { input.style.setProperty('--p', `${((input.value - min) / (max - min)) * 100}%`); val.textContent = fmt(+input.value); };
  input.addEventListener('input', () => { paint(); onInput(+input.value); });
  paint();
  const f = h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('label', { class: 'field-label', text: label }), val), input);
  if (ticks) {
    const t = h('div', { class: 'ticks' });
    for (const [v, lab] of ticks) t.append(h('span', { style: `left:${((v - min) / (max - min)) * 100}%`, text: lab }));
    f.append(t);
  }
  if (hint) f.append(h('div', { class: 'field-hint', text: hint }));
  return f;
}

function seg(options, value, onChange, cls = 'seg full') {
  const e = h('div', { class: cls, role: 'group' });
  const btns = options.map(([v, label, title]) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value), text: label, title });
    b.dataset.v = String(v);
    b.addEventListener('click', () => { set(v); onChange(v); });
    e.append(b);
    return b;
  });
  function set(v) { btns.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === String(v)))); }
  e.set = set;
  return e;
}

function toggle(label, checked, onChange, title) {
  const input = h('input', { type: 'checkbox', 'aria-label': label });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return h('label', { class: 'switch-row', title }, h('span', { class: 'field-label', text: label }), h('span', { class: 'switch' }, input, h('span')));
}

function field(label, control, hint) {
  return h('div', { class: 'field' }, h('div', { class: 'field-row' }, h('span', { class: 'field-label', text: label })), control, hint ? h('div', { class: 'field-hint', text: hint }) : null);
}

export class UI {
  constructor(app) {
    this.app = app;
    this.closed = new Set(['Model', 'Advanced Numerics']);
    this.tab = 'overview';
    this._buildTop();
    this._buildModes();
    this._buildCamTools();
    this.timeline = new Timeline($('#timeline'), app.sim, t => app.seek(t));
    this._buildRight();
    this.renderLeft();
    this._bindKeys();
    this._bindCanvas();
    this.updateLegend();
    this._last = 0;
  }

  // ---------------- top bar ----------------
  _buildTop() {
    const app = this.app;
    $('#btn-play').addEventListener('click', () => app.togglePlay());
    $('#btn-restart').addEventListener('click', () => app.restart());
    const speeds = [[10, '10×', '10 times real time'], [60, '60×', 'One simulated minute per second'], [300, '300×', 'Five simulated minutes per second'], [1200, '1200×', 'Twenty simulated minutes per second'], [Infinity, 'Max', 'As fast as your GPU allows']];
    const sp = seg(speeds, app.state.speed, v => app.setSpeed(v), 'seg');
    sp.id = 'speed'; sp.classList.add('speed-seg');
    $('#speed').replaceWith(sp);
    $('#btn-share').addEventListener('click', () => app.share());
    $('#btn-export').addEventListener('click', (e) => this._exportMenu(e.currentTarget));
    $('#toggle-left').addEventListener('click', () => { $('#panel-left').classList.toggle('open'); $('#panel-right').classList.remove('open'); });
    $('#toggle-right').addEventListener('click', () => { $('#panel-right').classList.toggle('open'); $('#panel-left').classList.remove('open'); });
  }

  _exportMenu(anchor) {
    const app = this.app;
    if (this._menu) { this._menu.remove(); this._menu = null; return; }
    const r = anchor.getBoundingClientRect();
    const item = (label, sub, fn) => h('button', { on: { click: () => { this._menu?.remove(); this._menu = null; fn(); } } },
      h('div', { text: label }), h('div', { class: 'block-sub', text: sub }));
    const sc = app.sim.scenario;
    const slug = `floodtwin_${app.state.preset}_${Math.round(app.sim.t / 60)}min`;
    const m = h('div', { class: 'views-menu overlay-card', style: `position:fixed;right:${innerWidth - r.right}px;top:${r.bottom + 6}px;left:auto;bottom:auto;min-width:270px;z-index:50` },
      item('Building Results', 'CSV, one row per building', () => download(`${slug}_buildings.csv`, buildingsCSV(app.sim, app.data, app.geo))),
      item('Peak Depth Grid', 'ESRI ASCII grid and .prj, UTM 18N', () => { download(`${slug}_peak_depth.asc`, maxDepthASC(app.sim, app.data.meta), 'text/plain'); setTimeout(() => download(`${slug}_peak_depth.prj`, PRJ_UTM18N, 'text/plain'), 300); }),
      item('Time Series', 'CSV every five simulated minutes', () => download(`${slug}_series.csv`, seriesCSV(app.sim, t => clockLabel(sc, t)))),
      item('Portfolio Results', app.sim.portfolio.length ? 'CSV, one row per property' : 'Load a portfolio first', () => { const c = portfolioCSV(app.sim); if (c) download(`${slug}_portfolio.csv`, c); else app.toast('Load a portfolio in the Portfolio tab first.'); }),
      item('Image', 'PNG of the current view', () => app.screenshot()));
    document.body.appendChild(m);
    this._menu = m;
    setTimeout(() => document.addEventListener('pointerdown', (e) => { if (this._menu && !this._menu.contains(e.target)) { this._menu.remove(); this._menu = null; } }, { once: true }), 0);
  }

  // ---------------- view modes, legend, camera ----------------
  _buildModes() {
    const modes = [[0, 'Photoreal'], [1, 'Depth'], [2, 'Velocity'], [3, 'Hazard'], [4, 'Peak Depth'], [5, 'Arrival'], [6, 'Damage']];
    const s = seg(modes, this.app.state.display.mode, v => { this.app.setMode(+v); }, 'seg');
    s.id = 'modes';
    $('#modes').replaceWith(s);
    this.modesEl = s;
  }

  updateLegend() {
    const app = this.app, m = app.state.display.mode, L = $('#legend');
    const parts = [];
    const bar = (title, stops, labels, note) => {
      parts.push(h('div', { class: 'legend-title', text: title }), h('div', { class: 'legend-bar', style: `background:${cssGradient(stops)}` }),
        h('div', { class: 'legend-scale' }, labels.map(l => h('span', { text: l }))));
      if (note) parts.push(h('div', { class: 'legend-note', text: note }));
    };
    if (m === 1) bar('Water Depth', RAMPS.depth.stops, ['0', '1 m', '2 m', '3 m +'], 'Deeper than 3 m shows as the darkest blue.');
    if (m === 2) bar('Flow Speed', RAMPS.speed.stops, ['0', '1 m/s', '2 m/s', '3 m/s +'], app.state.display.layers.tracers ? 'Tracers move 10 times faster than the water.' : null);
    if (m === 3) {
      parts.push(h('div', { class: 'legend-title', text: 'Hazard to People' }), h('div', { class: 'legend-classes' },
        HAZARD.map((c, k) => h('div', { class: 'legend-class' }, h('i', { style: `background:${c.color}` }), h('span', { text: c.label }),
          h('span', { text: `${c.note}${k < 3 ? `, HR < ${c.max}` : ''}` })))),
        h('div', { class: 'legend-note', text: 'HR = depth × (speed + 0.5) + debris factor (DEFRA FD2320).' }));
    }
    if (m === 4) bar('Peak Depth So Far', RAMPS.depth.stops, ['0', '1 m', '2 m', '3 m +'], 'Highest water depth reached at each cell up to now.');
    if (m === 5) {
      const sc = app.sim.scenario;
      bar('Flood Arrival', RAMPS.arrival.stops, [shortClock(sc, 0), shortClock(sc, sc.duration / 2), shortClock(sc, sc.duration)], 'Time each cell first held 10 cm of water. Dark is early.');
    }
    if (m === 6) {
      bar('Building Damage Ratio', RAMPS.damage.stops, ['0', '15%', '30%', '45%', '60% +'], null);
      parts.push(h('div', { class: 'legend-classes' },
        h('div', { class: 'legend-class' }, h('i', { style: 'background:#a4a8a6' }), h('span', { text: 'Water at building, no damage data' }), h('span')),
        h('div', { class: 'legend-class' }, h('i', { style: 'background:#5c5e5f' }), h('span', { text: 'Dry' }), h('span'))));
    }
    if (app.state.display.layers.fema) {
      parts.push(h('div', { class: 'legend-title', style: parts.length ? 'margin-top:4px' : '', text: 'FEMA Effective Flood Zones' }), h('div', { class: 'legend-classes' },
        [['#3987e5', '1% annual chance (AE)'], ['#d95926', 'Coastal high hazard (VE)'], ['#199e70', '0.2% annual chance']].map(([c, l]) =>
          h('div', { class: 'legend-class' }, h('i', { style: `background:${c}` }), h('span', { text: l }), h('span')))));
    }
    L.replaceChildren(...parts);
    L.hidden = parts.length === 0;
  }

  _buildCamTools() {
    const app = this.app, menu = $('#views-menu');
    for (const v of app.views) menu.append(h('button', { text: v.name, on: { click: () => { app.viewer.flyTo(v); menu.hidden = true; } } }));
    $('#btn-views').addEventListener('click', () => { menu.hidden = !menu.hidden; });
    $('#btn-north').addEventListener('click', () => { const v = app.viewer.currentView(); v.azim = 0; app.viewer.flyTo(v, 1.2); });
    $('#btn-shot').addEventListener('click', () => app.screenshot());
  }

  frameCompass() {
    const v = this.app.viewer, cam = v.camera, t = v.controls.target;
    const a = Math.atan2(cam.position.x - t.x, cam.position.z - t.z);
    $('#compass').style.transform = `rotate(${a}rad)`;
  }

  // ---------------- left panel ----------------
  renderLeft() {
    const app = this.app, st = app.state, body = $('#left-body');
    const scroll = body.scrollTop;
    body.replaceChildren();
    const sec = (title, build, note) => {
      const b = h('div', { class: 'section-body' });
      const head = h('button', { class: 'section-head', type: 'button', 'aria-expanded': String(!this.closed.has(title)) }, h('span', { text: title }), chev());
      const s = h('div', { class: 'section' + (this.closed.has(title) ? ' closed' : '') }, head, b);
      head.addEventListener('click', () => {
        if (this.closed.has(title)) this.closed.delete(title); else this.closed.add(title);
        s.classList.toggle('closed'); head.setAttribute('aria-expanded', String(!s.classList.contains('closed')));
      });
      build(b);
      if (note) b.append(h('div', { class: 'section-note', text: note }));
      body.append(s);
    };
    const changed = () => { app.markDirty(); this._dirtyBar(); };

    if (app.dirty) body.append(this._dirtyBox());

    sec('Event', b => {
      const list = h('div', { class: 'presets' });
      for (const p of PRESETS) {
        const on = st.preset === p.id;
        list.append(h('button', { class: 'preset', type: 'button', 'aria-pressed': String(on), on: { click: () => app.applyPreset(p.id) } },
          h('div', { class: 'preset-top' }, h('span', { class: 'preset-name', text: p.name }), h('span', { class: 'badge', text: p.tag })),
          on ? h('div', { class: 'preset-note', text: p.note }) : null));
      }
      if (st.preset === 'custom') list.append(h('div', { class: 'callout', text: 'Custom scenario: the parameters below differ from every preset.' }));
      b.append(list);
    });

    const ev = st.ev;
    sec('Coastal Boundary', b => {
      b.append(seg([['replay', 'Sandy Record'], ['surge', 'Synthetic Surge'], ['tide', 'Tide Only']], ev.mode, v => {
        ev.mode = v;
        if (v === 'surge' && !(ev.peak > 0)) { ev.peak = 3.05; ev.duration = 12; ev.timing = 'high'; }
        if (v === 'replay' && ev.offset == null) ev.offset = -0.216;
        app.markCustom(); changed(); this.renderLeft();
      }));
      if (ev.mode === 'replay') {
        b.append(toggle('Local Correction, −0.22 m', (ev.offset || 0) !== 0, on => { ev.offset = on ? -0.216 : 0; app.markCustom(); changed(); },
          'Lowers The Battery record to the Hoboken waterfront, calibrated on four waterfront high-water marks'),
        h('div', { class: 'field-hint', text: 'The Battery peaked about 0.22 m above the marks surveyed along the Hoboken bulkhead. Inland marks are kept for validation.' }));
      }
      if (ev.mode === 'surge') {
        b.append(slider({ label: 'Peak Water Level', min: 1.5, max: 4.5, step: 0.05, value: ev.peak, fmt: v => `${v.toFixed(2)} m NAVD88`,
          ticks: [[3.05, 'FEMA 1%'], [3.44, 'Sandy']], onInput: v => { ev.peak = v; app.markCustom(); changed(); } }));
        b.append(slider({ label: 'Storm Duration', min: 6, max: 36, step: 1, value: ev.duration, fmt: v => `${v} h`,
          hint: 'Width of the surge, as four standard deviations of a Gaussian pulse', onInput: v => { ev.duration = v; app.markCustom(); changed(); } }));
        b.append(field('Peak Timing', seg([['high', 'High Tide'], ['mid', 'Mid Tide'], ['low', 'Low Tide']], ev.timing || 'high', v => { ev.timing = v; app.markCustom(); changed(); })));
      }
      if (ev.mode === 'tide') b.append(h('div', { class: 'section-note', text: 'Astronomical tide only: principal lunar tide, ±0.72 m about mean sea level at The Battery.' }));
      b.append(slider({ label: 'Sea Level Rise', min: 0, max: 1.5, step: 0.05, value: ev.slr || 0, fmt: v => `+${v.toFixed(2)} m`,
        ticks: [[0.4, '2050s'], [0.9, '2100s']], hint: 'Added to the whole boundary record. NPCC 2019 middle range for New York City: 0.28 to 0.53 m by the 2050s, 0.56 to 1.27 m by the 2100s.',
        onInput: v => { ev.slr = v; app.markCustom(); changed(); } }));
    });

    sec('Rainfall', b => {
      const a14 = app.data.events.atlas14;
      const durs = ['15-min', '30-min', '60-min', '2-hr', '3-hr', '6-hr', '12-hr', '24-hr'];
      const rps = [2, 5, 10, 25, 50, 100, 200, 500, 1000];
      const selRp = h('select', { 'aria-label': 'Return period' }, rps.map(r => h('option', { value: r, text: `1 in ${r} years` })));
      const selD = h('select', { 'aria-label': 'Duration' }, durs.map(d => h('option', { value: d, text: d.replace('-min', ' min').replace('-hr', ' h') })));
      selRp.value = '100'; selD.value = '60-min';
      const depthOf = () => a14.depth[a14.durations.indexOf(selD.value)][a14.return_periods_yr.indexOf(+selRp.value)];
      const hoursOf = d => d.endsWith('-min') ? parseInt(d) / 60 : parseInt(d);
      const preview = h('div', { class: 'field-hint' });
      const upd = () => { preview.textContent = `NOAA Atlas 14 at Hoboken: ${depthOf()} mm in ${selD.selectedOptions[0].textContent}`; };
      selRp.addEventListener('change', upd); selD.addEventListener('change', upd); upd();
      b.append(field('Design Storm', h('div', { class: 'select-row' }, selRp, selD)), preview,
        h('button', { class: 'btn small', type: 'button', text: 'Use This Storm', on: { click: () => {
          const hr = hoursOf(selD.value);
          ev.rain = +(depthOf() / hr).toFixed(1); ev.rainDur = hr; if (!(ev.rainStart >= 0)) ev.rainStart = 0.25;
          app.markCustom(); changed(); this.renderLeft();
        } } }));
      b.append(slider({ label: 'Intensity', min: 0, max: 120, step: 1, value: ev.rain || 0, fmt: v => `${v} mm/h`, onInput: v => { ev.rain = v; app.markCustom(); changed(); this._rainNote(); } }));
      b.append(slider({ label: 'Duration', min: 0.25, max: 12, step: 0.25, value: ev.rainDur || 1, fmt: v => `${v} h`, onInput: v => { ev.rainDur = v; app.markCustom(); changed(); this._rainNote(); } }));
      b.append(slider({ label: 'Starts After', min: 0, max: 8, step: 0.25, value: ev.rainStart || 0, fmt: v => `${v} h`, onInput: v => { ev.rainStart = v; app.markCustom(); changed(); } }));
      this.rainNoteEl = h('div', { class: 'callout' });
      b.append(this.rainNoteEl);
      this._rainNote();
    });

    const df = st.defences;
    sec('Defences', b => {
      b.append(toggle('Hoboken Waterfront Barrier', df.waterfront.on, on => { df.waterfront.on = on; changed(); this.renderLeft(); },
        'A continuous wall along the Hoboken bulkhead, from the rail yards to Weehawken Cove'));
      if (df.waterfront.on) b.append(slider({ label: 'Crest Elevation', min: 2.5, max: 5.5, step: 0.05, value: df.waterfront.crest, fmt: v => `${v.toFixed(2)} m NAVD88`,
        ticks: [[3.44, 'Sandy peak']], onInput: v => { df.waterfront.crest = v; changed(); } }));
      const list = h('div', { class: 'list' });
      df.barriers.forEach((bar, k) => {
        let len = 0;
        for (let i = 1; i < bar.points.length; i++) len += Math.hypot(bar.points[i][0] - bar.points[i - 1][0], bar.points[i][1] - bar.points[i - 1][1]);
        list.append(h('div', { class: 'list-item' },
          h('div', { class: 'list-item-top' }, h('span', { text: `Barrier ${k + 1} · ${Math.round(len)} m` }),
            h('button', { class: 'link-btn', type: 'button', text: 'Remove', on: { click: () => { df.barriers.splice(k, 1); changed(); app.refreshDefences(); this.renderLeft(); } } })),
          slider({ label: 'Crest', min: 1, max: 6, step: 0.05, value: bar.crest, fmt: v => `${v.toFixed(2)} m`, onInput: v => { bar.crest = v; changed(); app.refreshDefences(); } })));
      });
      df.pumps.forEach((p, k) => {
        list.append(h('div', { class: 'list-item' },
          h('div', { class: 'list-item-top' }, h('span', { text: `Pump ${k + 1}` }),
            h('button', { class: 'link-btn', type: 'button', text: 'Remove', on: { click: () => { df.pumps.splice(k, 1); changed(); app.refreshDefences(); this.renderLeft(); } } })),
          slider({ label: 'Capacity', min: 0.5, max: 10, step: 0.1, value: p.rate, fmt: v => `${v.toFixed(1)} m³/s · ${Math.round(v * 22.82)} MGD`, onInput: v => { p.rate = v; changed(); } })));
      });
      b.append(list);
      b.append(h('div', { class: 'select-row' },
        h('button', { class: 'btn small', type: 'button', text: app.tool === 'draw' ? 'Drawing…' : 'Draw a Barrier', on: { click: () => app.setTool(app.tool === 'draw' ? 'select' : 'draw') } }),
        h('button', { class: 'btn small', type: 'button', text: app.tool === 'pump' ? 'Click the Map…' : 'Place a Pump', on: { click: () => app.setTool(app.tool === 'pump' ? 'select' : 'pump') } })));
    }, 'Barriers raise the ground to their crest. Pumps remove water and discharge it outside the model. Changes apply when the run restarts.');

    const m = st.model;
    sec('Model', b => {
      const cells = dx => { const nx = Math.floor(2028 / (dx / 2)), ny = Math.floor(1856 / (dx / 2)); return `${fmtInt(nx)} × ${fmtInt(ny)} = ${fmtInt(nx * ny)} cells`; };
      const cellNote = h('div', { class: 'field-hint', text: cells(m.dx) });
      b.append(field('Grid Resolution', seg([[2, '2 m'], [4, '4 m'], [8, '8 m']], m.dx, v => { m.dx = +v; cellNote.textContent = cells(m.dx) + (m.dx === 2 ? '. About eight times slower than 4 m.' : ''); changed(); })), cellNote);
      b.append(slider({ label: 'Roughness, Streets', min: 0.010, max: 0.030, step: 0.001, value: m.nPaved, fmt: v => `n = ${v.toFixed(3)}`, onInput: v => { m.nPaved = v; changed(); } }));
      b.append(slider({ label: 'Roughness, Parks and Lawns', min: 0.025, max: 0.080, step: 0.001, value: m.nGreen, fmt: v => `n = ${v.toFixed(3)}`, onInput: v => { m.nGreen = v; changed(); } }));
      b.append(slider({ label: 'Drainage Capacity', min: 0, max: 50, step: 1, value: m.drainage, fmt: v => `${v} mm/h`, hint: 'Water removed by inlets and sewers from every land cell while it is wet', onInput: v => { m.drainage = v; changed(); } }));
      b.append(slider({ label: 'Infiltration, Green Space', min: 0, max: 40, step: 1, value: m.infiltration, fmt: v => `${v} mm/h`, onInput: v => { m.infiltration = v; changed(); } }));
      b.append(field('Buildings', seg([[false, 'Solid'], [true, 'Porous']], m.porous, v => { m.porous = v === true || v === 'true'; changed(); }), 'Solid blocks flow; porous lets water through ground floors with high roughness.'));
    });

    sec('Advanced Numerics', b => {
      b.append(slider({ label: 'Momentum Weighting θ', min: 0.6, max: 1.0, step: 0.05, value: m.theta, fmt: v => v.toFixed(2), hint: 'de Almeida et al. (2012); 1.0 is the original Bates et al. (2010) scheme', onInput: v => { m.theta = v; changed(); } }));
      b.append(slider({ label: 'Froude Limit', min: 0.5, max: 1.5, step: 0.05, value: m.frMax, fmt: v => v.toFixed(2), onInput: v => { m.frMax = v; changed(); } }));
      b.append(slider({ label: 'Time Step Factor α', min: 0.3, max: 0.9, step: 0.05, value: m.alpha, fmt: v => v.toFixed(2), hint: 'Fraction of the stability limit used for each step', onInput: v => { m.alpha = v; changed(); } }));
    });

    const d = st.display;
    sec('Display', b => {
      b.append(field('Lighting', seg([['day', 'Day'], ['dusk', 'Dusk'], ['night', 'Night'], ['event', 'Event Clock']], d.lighting, v => app.setLighting(v))));
      b.append(field('Weather', seg([['auto', 'Auto'], ['clear', 'Clear'], ['overcast', 'Overcast'], ['storm', 'Storm']], d.weather, v => app.setWeather(v))));
      const L = d.layers, lay = h('div', { class: 'layers' });
      const items = [['hwm', 'Sandy High-Water Marks'], ['fema', 'FEMA Flood Zones'], ['labels', 'Place Names'], ['tracers', 'Flow Tracers'], ['buildings', 'Buildings'], ['trees', 'Trees'], ['cars', 'Parked Vehicles']];
      for (const [k, label] of items) lay.append(toggle(label, L[k], on => app.setLayer(k, on)));
      b.append(lay);
      b.append(field('Render Quality', seg([['high', 'High'], ['balanced', 'Balanced'], ['performance', 'Fast']], d.quality, v => app.setQuality(v)),
        'High adds river reflections and 4K shadows. Fast suits integrated graphics.'));
    });

    body.append(h('div', { class: 'section', style: 'padding:14px 16px 0' }, h('div', { class: 'section-note' },
      'Terrain: USGS 3DEP lidar. Buildings: OpenStreetMap with lidar heights. Values: USACE NSI. ', h('a', { href: 'methodology.html', target: '_blank', text: 'Methodology and sources' }))));
    body.scrollTop = scroll;
  }

  _dirtyBox() {
    return h('div', { style: 'padding:0 16px 12px' }, h('div', { class: 'dirty' },
      h('span', { text: 'Settings changed. The current run still uses the previous settings.' }),
      h('button', { class: 'btn accent small block', type: 'button', text: 'Apply and Restart', on: { click: () => this.app.applyChanges(true) } })));
  }

  _dirtyBar() {
    const body = $('#left-body');
    const has = body.firstChild?.querySelector?.('.dirty');
    if (this.app.dirty && !has) body.prepend(this._dirtyBox());
    if (!this.app.dirty && has) body.firstChild.remove();
  }

  _rainNote() {
    const ev = this.app.state.ev, el = this.rainNoteEl;
    if (!el) return;
    if (!(ev.rain > 0)) { el.textContent = 'No rain. Set an intensity or pick a design storm.'; return; }
    const total = ev.rain * ev.rainDur;
    const rp = this.app.returnPeriod(total, ev.rainDur);
    el.textContent = `${Math.round(total)} mm over ${ev.rainDur} h at a uniform ${ev.rain} mm/h. ` +
      (rp ? (rp.over ? `Rarer than 1 in ${rp.rp} years at Hoboken (NOAA Atlas 14).` : rp.under ? 'More frequent than once a year.' : `About 1 in ${rp.rp} years at Hoboken (NOAA Atlas 14).`) : '');
  }

  // ---------------- right panel ----------------
  _buildRight() {
    const tabs = [['overview', 'Overview'], ['buildings', 'Buildings'], ['portfolio', 'Portfolio'], ['validation', 'Validation'], ['probe', 'Probe']];
    const bar = $('#tabs'), body = $('#right-body');
    this.panels = {};
    this.tabBtns = {};
    for (const [k, label] of tabs) {
      const b = h('button', { class: 'tab', role: 'tab', 'aria-selected': String(k === this.tab), text: label, on: { click: () => this.showTab(k) } });
      bar.append(b); this.tabBtns[k] = b;
      const p = h('div', { class: 'tabpanel', role: 'tabpanel', hidden: k !== this.tab });
      body.append(p); this.panels[k] = p;
    }
    this._buildOverview();
    this._buildBuildings();
    this._buildPortfolio();
    this._buildValidation();
    this._buildProbe();
  }

  showTab(k) {
    this.tab = k;
    for (const [n, b] of Object.entries(this.tabBtns)) b.setAttribute('aria-selected', String(n === k));
    for (const [n, p] of Object.entries(this.panels)) p.hidden = n !== k;
    if (k === 'validation') this.renderValidation();
    if (k === 'buildings') this.renderBuilding();
    if (k === 'portfolio') this.renderPortfolio();
    if (k === 'probe') this.renderProbe();
    if (window.innerWidth <= 1100) $('#panel-right').classList.add('open');
  }

  _buildOverview() {
    const p = this.panels.overview;
    this.ov = {};
    this.ov.status = h('div', { class: 'status-line' });
    const kpi = (key, label, hero) => {
      const v = h('div', { class: 'kpi-value', text: '–' }), s = h('div', { class: 'kpi-sub', text: ' ' });
      this.ov[key] = { v, s };
      return h('div', { class: `kpi${hero ? ' hero' : ''}` }, h('div', { class: 'kpi-label', text: label }), v, s);
    };
    const grid = h('div', { class: 'kpis' },
      kpi('loss', 'Expected Building Loss', true), kpi('area', 'Flooded Land'), kpi('vol', 'Water on Land'),
      kpi('wet', 'Buildings Reached'), kpi('ff', 'Above First Floor'), kpi('res', 'Residents Affected'), kpi('cars', 'Vehicles in 30 cm or More'));
    const c1 = h('div'), c2 = h('div');
    const fmtT = (t) => shortClock(this.app.sim.scenario, t);
    const xTicks = (a, b) => { const out = [], step = b > 6 * 3600 ? 3 * 3600 : b > 3 * 3600 ? 3600 : 1800; for (let t = 0; t <= b + 1; t += step) out.push(t); return out; };
    this.chArea = lineChart(c1, { height: 112, title: 'Flooded land over time', series: [{ key: 'area', name: 'Flooded land', color: 'var(--series-1)', area: true }],
      xFmt: fmtT, xTicks, yFmt: (v, tip) => tip ? `${v.toFixed(2)} km²` : v.toFixed(1), yMaxMin: 0.5 });
    this.chLoss = lineChart(c2, { height: 112, title: 'Expected loss over time', series: [{ key: 'loss', name: 'Expected loss', color: 'var(--series-1)', area: true }],
      xFmt: fmtT, xTicks, yFmt: (v, tip) => tip ? fmtMoney(v) : fmtMoney(v).replace('.00', ''), yMaxMin: 1e8 });
    this.ov.region = h('div', { class: 'table-wrap' });
    this.ov.tableToggle = h('button', { class: 'link-btn', type: 'button', text: 'Show as Table' });
    this.ov.table = h('div', { class: 'table-wrap', hidden: true });
    this.ov.tableToggle.addEventListener('click', () => { this.ov.table.hidden = !this.ov.table.hidden; this.ov.tableToggle.textContent = this.ov.table.hidden ? 'Show as Table' : 'Hide Table'; this.renderOverview(true); });
    p.append(this.ov.status, grid,
      h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Flooded Land' }), h('span', { class: 'block-sub', text: 'km², land deeper than 10 cm' })), c1),
      h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Expected Building Loss' }), h('span', { class: 'block-sub', text: 'structure and contents' })), c2,
        h('div', { style: 'display:flex;justify-content:flex-end' }, this.ov.tableToggle), this.ov.table),
      h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'By State' })), this.ov.region),
      h('div', { class: 'callout' }, 'Losses use FloodVuln Global damage curves on National Structure Inventory values. Damage is applied to the two lowest storeys of taller buildings. ',
        h('a', { href: 'methodology.html#losses', target: '_blank', text: 'How losses are estimated' })));
  }

  renderOverview(force) {
    const app = this.app, sim = app.sim, sc = sim.scenario, s = sim.solver, R = sim.results, o = this.ov;
    if (!sc || !s) return;
    const dt = s.stableDt();
    o.status.replaceChildren(
      h('span', {}, 'Boundary ', h('b', { text: `${sc.stage(sim.t).toFixed(2)} m` })),
      h('span', {}, 'Rain ', h('b', { text: `${sc.rain(sim.t).toFixed(0)} mm/h` })),
      h('span', {}, 'Speed ', h('b', { text: sim.status === 'running' || sim.status === 'seeking' ? `${fmtInt(sim.simRate)}×` : '–' })),
      h('span', {}, 'Steps ', h('b', { text: `${sim.stepsLastFrame || 0}/frame` })),
      h('span', {}, 'Δt ', h('b', { text: `${dt.toFixed(2)} s` })));
    o.area.v.textContent = `${(s.wetArea / 1e6).toFixed(2)} km²`;
    o.area.s.textContent = `Peak ${sim.maxArea.toFixed(2)} km²`;
    o.vol.v.textContent = `${(s.volume / 1e6).toFixed(2)} M m³`;
    o.vol.s.textContent = s.wetArea > 1e3 ? `Average depth ${(s.volume / s.wetArea).toFixed(2)} m` : 'No standing water';
    if (R) {
      o.loss.v.textContent = fmtMoney(R.struct + R.contents);
      o.loss.s.textContent = `Structure ${fmtMoney(R.struct)} · Contents ${fmtMoney(R.contents)} · Range ${fmtMoney(R.low)} to ${fmtMoney(R.high)}`;
      o.wet.v.textContent = fmtInt(R.wet); o.wet.s.textContent = '15 cm or more at the walls';
      o.ff.v.textContent = fmtInt(R.aboveFF); o.ff.s.textContent = 'water above the first floor';
      o.res.v.textContent = fmtInt(R.residents); o.res.s.textContent = 'night population, NSI';
      o.cars.v.textContent = fmtInt(R.cars30); o.cars.s.textContent = `${fmtInt(R.cars60)} in over 60 cm`;
      tableView(o.region, [{ key: 'name', label: 'State' }, { key: 'wet', label: 'Reached', fmt: fmtInt }, { key: 'aboveFF', label: 'Above Floor', fmt: fmtInt },
        { key: 'loss', label: 'Loss', fmt: fmtMoney }, { key: 'residents', label: 'Residents', fmt: fmtInt }],
      [{ name: 'New Jersey', ...R.region.NJ }, { name: 'New York', ...R.region.NY }]);
    }
    const ser = sim.series;
    const data = { area: ser.map(p => [p.t, p.area]) };
    this.chArea.update(data, 0, sc.duration, sim.t);
    this.chLoss.update({ loss: ser.map(p => [p.t, p.loss]) }, 0, sc.duration, sim.t);
    if (!o.table.hidden && (force || this._tableT !== ser.length)) {
      this._tableT = ser.length;
      const rows = ser.filter((p, k) => k % 3 === 0 || k === ser.length - 1);
      tableView(o.table, [{ key: 't', label: 'Time', fmt: t => shortClock(sc, t) }, { key: 'stage', label: 'Boundary', fmt: v => v.toFixed(2) }, { key: 'area', label: 'Flooded km²', fmt: v => v.toFixed(2) }, { key: 'loss', label: 'Loss', fmt: fmtMoney }], rows);
    }
  }

  _buildBuildings() { this.bd = {}; }

  renderBuilding() {
    const app = this.app, p = this.panels.buildings, sim = app.sim, b = app.selected;
    p.replaceChildren();
    if (b != null && b >= 0) {
      const info = sim.buildingInfo(b), a = info.attrs;
      const title = info.name || `${info.cls}`;
      const facts = h('dl', { class: 'facts' });
      const add = (k, v) => facts.append(h('dt', { text: k }), h('dd', { text: v }));
      add('Class', info.cls);
      add('Height', `${info.h.toFixed(1)} m`);
      add('Ground', `${info.g.toFixed(2)} m NAVD88`);
      add('Footprint', `${fmtInt(info.area)} m²`);
      if (a) {
        add('Occupancy', a.occ);
        if (a.stories) add('Storeys', String(a.stories));
        if (a.yr) add('Year Built', String(a.yr));
        add('First Floor', `${a.ffh.toFixed(2)} m above ground`);
        add('Foundation', { C: 'Crawlspace', B: 'Basement', S: 'Slab', P: 'Pier', I: 'Pile', F: 'Fill', W: 'Solid wall' }[a.found] || a.found || 'Unknown');
        add('Structure Value', fmtMoney(a.vs));
        add('Contents Value', fmtMoney(a.vc));
        if (a.pn) add('Residents', fmtInt(a.pn));
      }
      const water = h('dl', { class: 'facts' });
      const addW = (k, v) => water.append(h('dt', { text: k }), h('dd', { text: v }));
      addW('Depth Now', info.depthNow > 0.005 ? fmtM(info.depthNow) : 'Dry');
      addW('Peak Depth', info.depthMax > 0.005 ? fmtM(info.depthMax) : 'Dry');
      if (info.wseMax > -90) addW('Peak Water Surface', `${info.wseMax.toFixed(2)} m NAVD88`);
      const kids = [h('div', { class: 'block' },
        h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: title }), h('button', { class: 'link-btn', type: 'button', text: 'Clear', on: { click: () => app.selectBuilding(-1) } })),
        h('div', { class: 'block-sub', text: `${info.side === 'NY' ? 'Manhattan, New York' : 'New Jersey'} · OSM ${info.id}` }), facts)];
      kids.push(h('div', { class: 'block' }, h('div', { class: 'block-title', text: 'Water at the Building' }), water));
      if (info.damage) {
        const d = info.damage;
        const dm = h('dl', { class: 'facts' });
        const addD = (k, v) => dm.append(h('dt', { text: k }), h('dd', { text: v }));
        addD('Depth Above First Floor', info.wseMax > -90 ? fmtM(d.d) : '–');
        addD('Damage Ratio', `${pct(d.mean)} (10th to 90th: ${pct(d.p10)} to ${pct(d.p90)})`);
        if (info.share < 1) addD('Value Exposed', `${pct(info.share)} (two lowest of ${a.stories || Math.round(info.h / 3.1)} storeys)`);
        addD('Expected Loss', fmtMoney(info.loss));
        const cv = h('div');
        kids.push(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Damage' }),
          h('span', { class: 'block-sub', text: app.data.events.vulnerability.archetypes[a.arch] })), dm, cv,
        h('div', { class: 'block-sub', text: `FloodVuln Global curve for ${a.arch}, ${info.side} calibration. Band: 10th to 90th percentile.` })));
        requestAnimationFrame(() => curveChart(cv, { depth: info.curve.depth, mean: info.curve.mean, p10: info.curve.p10, p90: info.curve.p90, at: info.wseMax > -90 && info.depthMax > 0.005 ? d : null }));
      } else kids.push(h('div', { class: 'hint', text: 'No National Structure Inventory record is matched to this footprint, so no value or damage is estimated.' }));
      p.append(...kids);
    } else {
      p.append(h('div', { class: 'hint' }, h('strong', { text: 'Click any building' }), ' to see its water depth, damage ratio and loss. Hover for a quick read-out.'));
    }
    const R = sim.results;
    if (R?.top?.length) {
      const t = h('div', { class: 'table-wrap' });
      const tbl = tableView(t, [{ key: 'rank', label: '#' }, { key: 'name', label: 'Building' }, { key: 'depth', label: 'Peak Depth', fmt: v => fmtM(v) }, { key: 'loss', label: 'Loss', fmt: fmtMoney }],
        R.top.map((bb, k) => { const i = sim.buildingInfo(bb); return { rank: k + 1, name: (i.name || i.attrs?.occ || i.cls).slice(0, 22), depth: i.depthMax, loss: sim.bLoss[bb], b: bb }; }));
      [...tbl.tBodies[0].rows].forEach((tr, k) => { tr.classList.add('clickable'); tr.addEventListener('click', () => { app.selectBuilding(R.top[k]); app.flyToBuilding(R.top[k]); }); });
      p.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Largest Losses' }), h('span', { class: 'block-sub', text: 'click to fly there' })), t));
    }
  }

  _buildPortfolio() {}

  renderPortfolio() {
    const app = this.app, p = this.panels.portfolio, sim = app.sim, R = sim.results?.portfolio;
    p.replaceChildren();
    const file = h('input', { type: 'file', accept: '.csv,text/csv', hidden: true });
    file.addEventListener('change', async () => {
      const f = file.files[0]; if (!f) return;
      const res = parsePortfolioCSV(await f.text(), app.data, app.geo, (x, y) => app.terrain.heightAt(x, y), y => app.riverMidX(y));
      if (res.errors.length) { app.toast(res.errors.join(' ')); return; }
      app.setPortfolio(res.assets, `${f.name}: ${fmtInt(res.assets.length)} properties${res.skipped ? `, ${fmtInt(res.skipped)} outside the model or unreadable` : ''}`);
    });
    p.append(h('div', { class: 'hint', text: 'Score a book of properties against the running scenario: water depth at each property, FloodVuln damage, expected loss and the loan-to-value effect.' }),
      h('div', { class: 'select-row' },
        h('button', { class: 'btn small', type: 'button', text: 'Load Demo Book', on: { click: () => app.setPortfolio(demoPortfolio(app.data, app.geo), 'Demo mortgage book: 600 small residential properties from the NSI with synthetic loans') } }),
        h('button', { class: 'btn small', type: 'button', text: 'Upload CSV', on: { click: () => file.click() } })), file,
      h('div', { class: 'field-hint' }, 'Columns: id, lat, lon, value, and optionally loan, type (sf1, sf2, basement, mf, com) and first_floor_m. ',
        h('button', { class: 'link-btn', type: 'button', text: 'Download a template', on: { click: () => download('floodtwin_portfolio_template.csv', SAMPLE_CSV) } })));
    if (!sim.portfolio.length) return;
    p.append(h('div', { class: 'callout', text: app.portfolioName || '' }));
    if (!R) { p.append(h('div', { class: 'hint', text: 'Waiting for the next sample…' })); return; }
    const tile = (label, value, sub, hero) => h('div', { class: `kpi${hero ? ' hero' : ''}` }, h('div', { class: 'kpi-label', text: label }), h('div', { class: 'kpi-value', text: value }), h('div', { class: 'kpi-sub', text: sub || ' ' }));
    p.append(h('div', { class: 'kpis' },
      tile('Expected Portfolio Loss', fmtMoney(R.loss), `${(100 * R.loss / R.exposure).toFixed(2)}% of ${fmtMoney(R.exposure)} insured value`, true),
      tile('Properties Flooded', fmtInt(R.flooded), `of ${fmtInt(R.n)}`),
      tile('Average Loss', fmtMoney(R.loss / Math.max(1, R.flooded)), 'per flooded property'),
      R.loans ? tile('Pushed Over 80% LTV', fmtInt(R.ltv80), 'loans, after damage') : null,
      R.loans ? tile('Pushed Over 100% LTV', fmtInt(R.ltv100), 'loans in negative equity') : null));
    const rows = sim.portfolio.map((a, k) => ({ ...R.rows[k], id: a.id, k })).filter(r => r.depth > 0.02).sort((x, y) => y.loss - x.loss).slice(0, 25);
    if (rows.length) {
      const t = h('div', { class: 'table-wrap' });
      const tbl = tableView(t, [{ key: 'id', label: 'Property' }, { key: 'depth', label: 'Depth', fmt: v => fmtM(v) }, { key: 'dr', label: 'Damage', fmt: pct }, { key: 'loss', label: 'Loss', fmt: fmtMoney },
        { key: 'ltvAfter', label: 'LTV After', fmt: v => v == null ? '–' : pct(v) }], rows);
      [...tbl.tBodies[0].rows].forEach((tr, k) => { tr.classList.add('clickable'); tr.addEventListener('click', () => { const a = sim.portfolio[rows[k].k]; app.flyToPoint(a.x, a.y); if (a.b != null) app.selectBuilding(a.b, false); }); });
      p.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Largest Losses' }), h('span', { class: 'block-sub', text: 'top 25' })), t));
    }
    p.append(h('button', { class: 'btn small', type: 'button', text: 'Download Portfolio Results', on: { click: () => { const c = portfolioCSV(sim); if (c) download('floodtwin_portfolio_results.csv', c); } } }));
  }

  _buildValidation() { this.valSource = 'corrected'; }

  renderValidation() {
    const app = this.app, p = this.panels.validation, V = app.validation, sim = app.sim;
    p.replaceChildren();
    const live = sim.scenario?.params.mode === 'replay' && sim.results?.hwm;
    p.append(h('div', { class: 'hint', text: 'After Hurricane Sandy the USGS surveyed high-water marks: mud, debris and seed lines left at the peak. Ten fall inside the model. Four along the waterfront set the boundary correction; the other six are held out.' }));
    const opts = [['corrected', 'Corrected Boundary'], ['raw', 'Raw Battery Record']];
    if (live) opts.push(['live', 'This Run']);
    if (!live && this.valSource === 'live') this.valSource = 'corrected';
    p.append(seg(opts, this.valSource, v => { this.valSource = v; this.renderValidation(); }));
    const rows = V.hwm.map((r, k) => ({ ...r, sim: this.valSource === 'live' ? sim.results.hwm[k] : r[this.valSource] }));
    const valid = rows.filter(r => r.sim != null);
    const stat = (set) => {
      if (!set.length) return null;
      const d = set.map(r => r.sim - r.obs);
      return { bias: d.reduce((a, b) => a + b, 0) / d.length, mae: d.reduce((a, b) => a + Math.abs(b), 0) / d.length, rmse: Math.sqrt(d.reduce((a, b) => a + b * b, 0) / d.length), n: d.length };
    };
    const all = stat(valid), held = stat(valid.filter(r => r.role === 'validation')), inland = stat(valid.filter(r => r.role === 'validation' && r.id !== 6335));
    const sgn = v => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)} m`;
    if (all) {
      const tile = (label, s) => h('div', { class: 'kpi wrap' }, h('div', { class: 'kpi-label', text: label }), h('div', { class: 'kpi-value', text: s ? `${s.mae.toFixed(2)} m` : '–' }),
        h('div', { class: 'kpi-sub', text: s ? `MAE · bias ${sgn(s.bias)} · RMSE ${s.rmse.toFixed(2)} · n ${s.n}` : 'no marks wet yet' }));
      p.append(h('div', { class: 'kpis' }, tile('All Marks', all), tile('Held Out', held), h('div', { class: 'kpi hero' },
        h('div', { class: 'kpi-label', text: 'Held Out, Inland Only' }), h('div', { class: 'kpi-value', text: inland ? `${inland.mae.toFixed(2)} m` : '–' }),
        h('div', { class: 'kpi-sub', text: inland ? `MAE · bias ${sgn(inland.bias)} · excludes mark 6335, a fair-quality stain line on the bulkhead likely raised by waves` : '' }))));
    }
    const sc = h('div');
    p.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Simulated Against Observed Peak' }), h('span', { class: 'block-sub', text: 'm NAVD88' })),
      h('div', { class: 'legend-row' }, h('span', { class: 'key' }, h('i', { class: 'dot', style: 'background:var(--series-1)' }), 'Calibration, waterfront'),
        h('span', { class: 'key' }, h('i', { class: 'dot', style: 'background:var(--series-2)' }), 'Held out')), sc));
    requestAnimationFrame(() => scatterChart(sc, {
      points: valid.map(r => ({ x: r.obs, y: r.sim, cat: r.role, label: `HWM ${r.id} · ${r.quality.split(':')[0]} ${r.type.toLowerCase()} mark` })),
      cats: [{ key: 'calibration', name: 'Calibration', color: 'var(--series-1)' }, { key: 'validation', name: 'Held out', color: 'var(--series-2)' }],
      domain: [2.6, 4.0], fmt: (v, tip) => tip ? `${v.toFixed(2)} m` : v.toFixed(1), xLabel: 'Observed', yLabel: 'Simulated' }));
    const t = h('div', { class: 'table-wrap' });
    const tbl = tableView(t, [{ key: 'id', label: 'Mark' }, { key: 'role', label: 'Use', fmt: v => v === 'calibration' ? 'Calibration' : 'Held out' }, { key: 'quality', label: 'Quality', fmt: v => v.split(':')[0] },
      { key: 'obs', label: 'Observed', fmt: v => v.toFixed(2) }, { key: 'sim', label: 'Simulated', fmt: v => v == null ? 'Dry' : v.toFixed(2) },
      { key: 'diff', label: 'Error', fmt: (v, r) => r.sim == null ? '–' : `${r.sim - r.obs >= 0 ? '+' : '−'}${Math.abs(r.sim - r.obs).toFixed(2)}` }], rows);
    [...tbl.tBodies[0].rows].forEach((tr, k) => { tr.classList.add('clickable'); tr.title = rows[k].site; tr.addEventListener('click', () => app.flyToPoint(rows[k].x ?? app.data.events.hwm[k].x, rows[k].y ?? app.data.events.hwm[k].y, 260)); });
    p.append(t);
    if (this.valSource === 'live' && sim.t < 4.5 * 3600) p.append(h('div', { class: 'callout', text: 'The storm peaked at 21:24 EDT. Simulated values grow until the run passes the peak.' }));
    p.append(h('div', { class: 'block' }, h('div', { class: 'block-title', text: 'Verification' }),
      h('dl', { class: 'facts' }, V.tests.flatMap(tt => [h('dt', { text: tt.name }), h('dd', { style: 'text-align:left;white-space:normal;color:var(--text-2)', text: tt.result })])),
      h('div', { class: 'block-sub', text: `GPU against CPU reference over ${V.parity.steps} steps: maximum depth difference ${V.parity.max_abs_dh_m.toExponential(1)} m, volume ratio ${V.parity.volume_ratio}.` })));
  }

  _buildProbe() {}

  renderProbe() {
    const app = this.app, p = this.panels.probe, sim = app.sim, v = sim.probeValue, pr = sim.probe;
    p.replaceChildren();
    p.append(h('div', { class: 'select-row' },
      h('button', { class: `btn small${app.tool === 'probe' ? ' accent' : ''}`, type: 'button', text: app.tool === 'probe' ? 'Click the Map…' : 'Place Probe', on: { click: () => app.setTool(app.tool === 'probe' ? 'select' : 'probe') } }),
      h('button', { class: 'btn small', type: 'button', text: 'Clear', disabled: !pr, on: { click: () => app.setProbe(null) } })));
    if (!pr) { p.append(h('div', { class: 'hint', text: 'A probe reads the model at one point every fraction of a second: depth, water surface, speed, hazard and arrival time.' })); return; }
    const [lon, lat] = app.geo.toLonLat(pr.x, pr.y);
    const f = h('dl', { class: 'facts' });
    const add = (k, val) => f.append(h('dt', { text: k }), h('dd', {}, val));
    add('Location', `${lat.toFixed(5)}, ${lon.toFixed(5)}`);
    if (v) {
      add('Ground', `${v.z.toFixed(2)} m NAVD88`);
      if (v.kind === 2) add('Cell', 'Inside a building');
      else if (v.kind === 1) add('Cell', 'River (boundary water)');
      add('Depth', v.h > 0.005 ? fmtM(v.h) : 'Dry');
      add('Water Surface', v.wse != null ? `${v.wse.toFixed(2)} m NAVD88` : '–');
      add('Speed', `${v.speed.toFixed(2)} m/s`);
      const hz = HAZARD.find(c => v.hazard < c.max) || HAZARD[3];
      add('Hazard', v.h > 0.02 ? h('span', { class: 'chip' }, h('i', { style: `background:${hz.color}` }), `${hz.label} · HR ${v.hazard.toFixed(2)}`) : 'None');
      add('Peak Depth So Far', v.maxDepth > 0.005 ? fmtM(v.maxDepth) : 'Dry');
      add('Peak Speed So Far', `${v.maxSpeed.toFixed(2)} m/s`);
      add('Arrival of 10 cm', v.arrival >= 0 ? clockLabel(sim.scenario, v.arrival) : 'Not yet');
    }
    p.append(f);
    const c = h('div');
    p.append(h('div', { class: 'block' }, h('div', { class: 'block-head' }, h('span', { class: 'block-title', text: 'Depth at the Probe' }), h('span', { class: 'block-sub', text: 'since it was placed' })), c));
    if (!this.chProbe || this.chProbeHost !== c) {
      this.chProbe = lineChart(c, { height: 120, title: 'Depth at the probe', series: [{ key: 'h', name: 'Depth', color: 'var(--series-1)', area: true }],
        xFmt: t => shortClock(sim.scenario, t), yFmt: (val, tip) => tip ? `${val.toFixed(2)} m` : val.toFixed(1), yMaxMin: 0.5 });
      this.chProbeHost = c;
    }
    this.chProbe.update({ h: sim.probeSeries.map(q => [q[0], q[1]]) }, 0, sim.scenario.duration, sim.t);
  }

  // ---------------- per-frame updates ----------------
  frame(now) {
    const app = this.app, sim = app.sim, sc = sim.scenario;
    if (!sc) return;
    const playing = sim.status === 'running' || (sim.status === 'seeking' && sim.resumeAfterSeek);
    $('#ico-play').hidden = playing; $('#ico-pause').hidden = !playing;
    $('#btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Run');
    $('#clock').firstChild.nodeValue = clockLabel(sc, sim.t);
    const sub = sim.status === 'seeking' ? `Computing to ${shortClock(sc, sim.seekTarget)}…` : sim.status === 'done' ? 'Event complete' :
      sim.status === 'paused' ? 'Paused' : sim.status === 'idle' ? 'Ready' : sim.status === 'error' ? 'Stopped' : `${fmtInt(sim.simRate)}× real time`;
    $('#clock-sub').textContent = sub;
    this.timeline.update();
    this.frameCompass();
    if (now - this._last > 0.25) {
      this._last = now;
      if (this.tab === 'overview') this.renderOverview();
      if (this.tab === 'probe' && this._probeDirty) { this._probeDirty = false; this.renderProbe(); }
    }
  }

  onResults() {
    if (this.tab === 'buildings' && (now() - (this._bT || 0) > 1.5)) { this._bT = now(); this.renderBuilding(); }
    if (this.tab === 'portfolio' && (now() - (this._pT || 0) > 1.5)) { this._pT = now(); this.renderPortfolio(); }
    if (this.tab === 'validation' && this.valSource === 'live' && (now() - (this._vT || 0) > 2)) { this._vT = now(); this.renderValidation(); }
  }

  onProbe() { this._probeDirty = true; }

  // ---------------- map interaction ----------------
  _bindCanvas() {
    const app = this.app, cv = $('#view'), card = $('#hovercard');
    let down = null, lastPick = 0, pend = null;
    cv.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button }; app.viewer.cancelFly(); });
    cv.addEventListener('pointerup', e => {
      if (!down || e.button !== 0) { down = null; return; }
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      down = null;
      if (moved > 5) return;
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      if (app.tool === 'select') { const b = app.viewer.pickBuilding(x, y); app.selectBuilding(b); return; }
      const g = app.viewer.groundAt(x, y);
      if (!g) return;
      if (app.tool === 'probe') { app.setProbe({ x: g.x, y: g.y }); app.setTool('select'); }
      else if (app.tool === 'pump') { app.addPump(g.x, g.y); app.setTool('select'); }
      else if (app.tool === 'draw') app.addDraftPoint(g.x, g.y);
    });
    cv.addEventListener('dblclick', e => { if (app.tool === 'draw') { e.preventDefault(); app.finishDraft(); } });
    cv.addEventListener('pointermove', e => {
      if (e.buttons || app.tool !== 'select') { card.hidden = true; return; }
      pend = e;
      const t = performance.now();
      if (t - lastPick < 90) return;
      lastPick = t;
      const r = cv.getBoundingClientRect();
      const b = app.viewer.pickBuilding(pend.clientX - r.left, pend.clientY - r.top);
      app.hoverBuilding(b);
      if (b < 0) { card.hidden = true; return; }
      const info = app.sim.buildingInfo(b);
      card.replaceChildren(h('div', { class: 'hovercard-title', text: info.name || info.cls }),
        h('div', { class: 'hovercard-row' }, 'Height', h('b', { text: `${info.h.toFixed(0)} m` })),
        h('div', { class: 'hovercard-row' }, 'Water Now', h('b', { text: info.depthNow > 0.005 ? fmtM(info.depthNow) : 'Dry' })),
        h('div', { class: 'hovercard-row' }, 'Peak', h('b', { text: info.depthMax > 0.005 ? fmtM(info.depthMax) : 'Dry' })),
        info.damage ? h('div', { class: 'hovercard-row' }, 'Damage', h('b', { text: info.depthMax > 0.005 ? `${pct(info.damage.mean)} · ${fmtMoney(info.loss)}` : 'None' })) : null);
      card.hidden = false;
      card.style.left = `${Math.min(innerWidth - card.offsetWidth - 10, pend.clientX + 14)}px`;
      card.style.top = `${Math.min(innerHeight - card.offsetHeight - 10, pend.clientY + 14)}px`;
    });
    cv.addEventListener('pointerleave', () => { card.hidden = true; app.hoverBuilding(-1); });
  }

  setToolBanner(tool, n = 0) {
    const b = $('#draw-banner'), cv = $('#view');
    cv.classList.toggle('drawing', tool === 'draw' || tool === 'pump');
    cv.classList.toggle('probing', tool === 'probe');
    if (tool === 'select') { b.hidden = true; return; }
    const msg = tool === 'draw' ? (n < 2 ? 'Click the map to place barrier points.' : `${n} points. Double-click or press Enter to finish.`) :
      tool === 'probe' ? 'Click the map to place the probe.' : 'Click the map where the pump should draw water.';
    b.replaceChildren(h('span', { text: msg }),
      tool === 'draw' && n >= 2 ? h('button', { class: 'btn small accent', type: 'button', text: 'Finish', on: { click: () => this.app.finishDraft() } }) : null,
      h('button', { class: 'btn small', type: 'button', text: 'Cancel', on: { click: () => this.app.setTool('select') } }));
    b.hidden = false;
  }

  _bindKeys() {
    const app = this.app;
    window.addEventListener('keydown', e => {
      if (e.target.closest?.('input, select, textarea')) return;
      if (e.key === ' ') { e.preventDefault(); app.togglePlay(); }
      else if (e.key === 'r' || e.key === 'R') app.restart();
      else if (e.key >= '1' && e.key <= '7') { app.setMode(+e.key - 1); }
      else if (e.key === 'Escape') { app.setTool('select'); $('#views-menu').hidden = true; }
      else if (e.key === 'Enter' && app.tool === 'draw') app.finishDraft();
    });
  }
}

const now = () => performance.now() / 1000;
