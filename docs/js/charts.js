// Small SVG charts: line/area over time with a crosshair read-out, a scatter
// with a 1:1 line, and a damage curve with its uncertainty band. Marks follow
// one spec: 2px lines, 10% area washes, solid hairline grid, 8px markers with a
// surface ring, tooltips that list every series. Text never takes series colour.
const NS = 'http://www.w3.org/2000/svg';

function el(tag, attrs = {}, parent) {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  if (parent) parent.appendChild(e);
  return e;
}

export function niceTicks(min, max, n = 4) {
  if (!(max > min)) max = min + 1;
  const span = max - min, step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const err = step0 / mag;
  const step = (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag;
  const t0 = Math.ceil(min / step - 1e-9) * step, out = [];
  for (let t = t0; t <= max + step * 1e-6; t += step) out.push(+t.toFixed(10));
  return { ticks: out, step };
}

function tooltip(host) {
  const t = document.createElement('div');
  t.className = 'chart-tip';
  t.hidden = true;
  host.appendChild(t);
  return {
    show(x, y, title, rows) {
      t.replaceChildren();
      const h = document.createElement('div'); h.className = 'chart-tip-title'; h.textContent = title; t.appendChild(h);
      for (const r of rows) {
        const row = document.createElement('div'); row.className = 'chart-tip-row';
        const key = document.createElement('span'); key.className = 'chart-tip-key'; key.style.background = r.color;
        const v = document.createElement('strong'); v.textContent = r.value;
        const n = document.createElement('span'); n.className = 'chart-tip-name'; n.textContent = r.name;
        row.append(key, v, n); t.appendChild(row);
      }
      t.hidden = false;
      const hw = host.clientWidth, tw = t.offsetWidth;
      t.style.left = `${Math.min(Math.max(0, x + 12), hw - tw)}px`;
      t.style.top = `${Math.max(0, y - 8)}px`;
    },
    hide() { t.hidden = true; },
  };
}

/**
 * Line chart over a shared x.
 * opts: { height, series: [{ key, name, color, area }], xFmt, yFmt, yMin, yMaxMin, title }
 * update(data, xMin, xMax, now): data[key] = [[x, y], ...]
 */
export function lineChart(host, opts) {
  host.classList.add('chart');
  const H = opts.height || 120, M = { l: 40, r: 10, t: 8, b: 20 };
  const svg = el('svg', { class: 'chart-svg', height: H, role: 'img', tabindex: 0, 'aria-label': opts.title || 'Chart' }, host);
  const gGrid = el('g', {}, svg), gAxis = el('g', {}, svg), gData = el('g', {}, svg), gOver = el('g', {}, svg);
  const cross = el('line', { class: 'chart-cross', y1: M.t, y2: H - M.b, visibility: 'hidden' }, gOver);
  const nowLine = el('line', { class: 'chart-now', y1: M.t, y2: H - M.b, visibility: 'hidden' }, gOver);
  const dots = opts.series.map(s => el('circle', { r: 4, fill: s.color, class: 'chart-dot', visibility: 'hidden' }, gOver));
  const paths = opts.series.map(s => ({
    area: s.area ? el('path', { fill: s.color, 'fill-opacity': 0.1, stroke: 'none' }, gData) : null,
    line: el('path', { fill: 'none', stroke: s.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }, gData),
  }));
  const tip = tooltip(host);
  let state = null, hoverX = null;

  function draw() {
    if (!state) return;
    const W = Math.max(120, host.clientWidth);
    svg.setAttribute('width', W); svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const { data, xMin, xMax, now } = state;
    let yMax = opts.yMaxMin ?? 1, yMin = opts.yMin ?? 0;
    for (const s of opts.series) for (const p of data[s.key] || []) { yMax = Math.max(yMax, p[1]); if (opts.yMin == null) yMin = Math.min(yMin, p[1]); }
    const yt = niceTicks(yMin, yMax, 3);
    yMax = Math.max(yMax, yt.ticks.at(-1)); yMin = Math.min(yMin, yt.ticks[0]);
    const sx = x => M.l + ((x - xMin) / (xMax - xMin || 1)) * (W - M.l - M.r);
    const sy = y => H - M.b - ((y - yMin) / (yMax - yMin || 1)) * (H - M.t - M.b);
    state.sx = sx; state.sy = sy; state.W = W;
    gGrid.replaceChildren(); gAxis.replaceChildren();
    for (const t of yt.ticks) {
      el('line', { x1: M.l, x2: W - M.r, y1: sy(t), y2: sy(t), class: t === 0 ? 'chart-base' : 'chart-grid' }, gGrid);
      const tx = el('text', { x: M.l - 6, y: sy(t) + 3.5, class: 'chart-tick', 'text-anchor': 'end' }, gAxis);
      tx.textContent = opts.yFmt ? opts.yFmt(t) : t;
    }
    const xt = opts.xTicks ? opts.xTicks(xMin, xMax) : niceTicks(xMin, xMax, 4).ticks;
    for (const t of xt) {
      const tx = el('text', { x: sx(t), y: H - 5, class: 'chart-tick', 'text-anchor': 'middle' }, gAxis);
      tx.textContent = opts.xFmt ? opts.xFmt(t) : t;
    }
    opts.series.forEach((s, k) => {
      const pts = data[s.key] || [];
      if (!pts.length) { paths[k].line.setAttribute('d', ''); paths[k].area?.setAttribute('d', ''); return; }
      const d = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)},${sy(p[1]).toFixed(1)}`).join('');
      paths[k].line.setAttribute('d', d);
      if (paths[k].area) paths[k].area.setAttribute('d', `${d}L${sx(pts.at(-1)[0]).toFixed(1)},${sy(Math.max(yMin, 0))}L${sx(pts[0][0]).toFixed(1)},${sy(Math.max(yMin, 0))}Z`);
    });
    if (now != null) { nowLine.setAttribute('x1', sx(now)); nowLine.setAttribute('x2', sx(now)); nowLine.setAttribute('visibility', 'visible'); }
    else nowLine.setAttribute('visibility', 'hidden');
    if (hoverX != null) hover(hoverX);
  }

  function nearest(pts, x) {
    if (!pts?.length) return null;
    let lo = 0, hi = pts.length - 1;
    if (x <= pts[0][0]) return pts[0];
    if (x >= pts[hi][0]) return pts[hi];
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= x) lo = m; else hi = m; }
    return x - pts[lo][0] < pts[hi][0] - x ? pts[lo] : pts[hi];
  }

  function hover(px) {
    if (!state?.sx) return;
    const { data, xMin, xMax, sx, sy, W } = state;
    const x = xMin + ((px - M.l) / (W - M.l - M.r)) * (xMax - xMin);
    const rows = [];
    let cx = null;
    opts.series.forEach((s, k) => {
      const p = nearest(data[s.key], x);
      if (!p) { dots[k].setAttribute('visibility', 'hidden'); return; }
      cx = sx(p[0]);
      dots[k].setAttribute('cx', sx(p[0])); dots[k].setAttribute('cy', sy(p[1])); dots[k].setAttribute('visibility', 'visible');
      rows.push({ color: s.color, name: s.name, value: opts.yFmt ? opts.yFmt(p[1], true) : p[1].toFixed(2), x: p[0] });
    });
    if (cx == null) return;
    cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('visibility', 'visible');
    tip.show(cx, M.t, opts.xFmt ? opts.xFmt(rows[0].x, true) : String(rows[0].x), rows);
  }
  function leave() { hoverX = null; cross.setAttribute('visibility', 'hidden'); dots.forEach(d => d.setAttribute('visibility', 'hidden')); tip.hide(); }
  svg.addEventListener('pointermove', e => { const r = svg.getBoundingClientRect(); hoverX = e.clientX - r.left; hover(hoverX); });
  svg.addEventListener('pointerleave', leave);
  svg.addEventListener('blur', leave);
  svg.addEventListener('keydown', e => {
    if (!state?.sx || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    hoverX = Math.min(state.W - M.r, Math.max(M.l, (hoverX ?? M.l) + (e.key === 'ArrowRight' ? 12 : -12)));
    hover(hoverX); e.preventDefault();
  });
  new ResizeObserver(() => draw()).observe(host);
  return {
    update(data, xMin, xMax, now) { state = { data, xMin, xMax, now }; draw(); },
  };
}

/**
 * Scatter of observed against simulated values with a 1:1 line.
 * points: [{ x, y, cat, label }], cats: [{ key, name, color }]
 */
export function scatterChart(host, { points, cats, domain, fmt, xLabel, yLabel, height = 230 }) {
  host.classList.add('chart'); host.replaceChildren();
  const W = Math.max(200, host.clientWidth), H = height, M = { l: 44, r: 12, t: 10, b: 34 };
  const svg = el('svg', { class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `${yLabel} against ${xLabel}` }, host);
  const [d0, d1] = domain;
  const sx = v => M.l + ((v - d0) / (d1 - d0)) * (W - M.l - M.r), sy = v => H - M.b - ((v - d0) / (d1 - d0)) * (H - M.t - M.b);
  const t = niceTicks(d0, d1, 4).ticks;
  for (const v of t) {
    el('line', { x1: M.l, x2: W - M.r, y1: sy(v), y2: sy(v), class: 'chart-grid' }, svg);
    el('line', { y1: M.t, y2: H - M.b, x1: sx(v), x2: sx(v), class: 'chart-grid' }, svg);
    el('text', { x: M.l - 6, y: sy(v) + 3.5, class: 'chart-tick', 'text-anchor': 'end' }, svg).textContent = fmt(v);
    el('text', { x: sx(v), y: H - M.b + 14, class: 'chart-tick', 'text-anchor': 'middle' }, svg).textContent = fmt(v);
  }
  el('line', { x1: sx(d0), y1: sy(d0), x2: sx(d1), y2: sy(d1), class: 'chart-ref' }, svg);
  el('text', { x: sx(d1) - 4, y: sy(d1) + 12, class: 'chart-note', 'text-anchor': 'end' }, svg).textContent = '1:1';
  el('text', { x: (M.l + W - M.r) / 2, y: H - 4, class: 'chart-axis-label', 'text-anchor': 'middle' }, svg).textContent = xLabel;
  const yl = el('text', { x: 12, y: (M.t + H - M.b) / 2, class: 'chart-axis-label', 'text-anchor': 'middle', transform: `rotate(-90 12 ${(M.t + H - M.b) / 2})` }, svg);
  yl.textContent = yLabel;
  const tip = tooltip(host);
  const color = Object.fromEntries(cats.map(c => [c.key, c.color]));
  for (const p of points) {
    const g = el('g', { class: 'chart-pt', tabindex: 0 }, svg);
    el('circle', { cx: sx(p.x), cy: sy(p.y), r: 12, fill: 'transparent' }, g);
    el('circle', { cx: sx(p.x), cy: sy(p.y), r: 4.5, fill: color[p.cat], class: 'chart-dot' }, g);
    const show = () => tip.show(sx(p.x), sy(p.y) - 30, p.label, [
      { color: color[p.cat], name: 'Simulated', value: fmt(p.y, true) },
      { color: 'transparent', name: 'Observed', value: fmt(p.x, true) },
      { color: 'transparent', name: 'Difference', value: `${p.y - p.x >= 0 ? '+' : ''}${(p.y - p.x).toFixed(2)} m` },
    ]);
    g.addEventListener('pointerenter', show); g.addEventListener('focus', show);
    g.addEventListener('pointerleave', () => tip.hide()); g.addEventListener('blur', () => tip.hide());
  }
}

/** Damage ratio against depth above the first floor: mean line, 10th-90th percentile band, current point. */
export function curveChart(host, { depth, mean, p10, p90, at, height = 150 }) {
  host.classList.add('chart'); host.replaceChildren();
  const W = Math.max(200, host.clientWidth), H = height, M = { l: 38, r: 10, t: 10, b: 30 };
  const svg = el('svg', { class: 'chart-svg', width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Damage ratio against depth above the first floor' }, host);
  const x0 = -1, x1 = 4, i0 = depth.findIndex(d => d >= x0 - 1e-6), i1 = depth.findIndex(d => d > x1 + 1e-6);
  const D = depth.slice(i0, i1 < 0 ? undefined : i1), idx = D.map((_, k) => k + i0);
  const sx = v => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r), sy = v => H - M.b - v * (H - M.t - M.b);
  for (const v of [0, 0.25, 0.5, 0.75, 1]) {
    el('line', { x1: M.l, x2: W - M.r, y1: sy(v), y2: sy(v), class: v === 0 ? 'chart-base' : 'chart-grid' }, svg);
    el('text', { x: M.l - 6, y: sy(v) + 3.5, class: 'chart-tick', 'text-anchor': 'end' }, svg).textContent = `${Math.round(v * 100)}%`;
  }
  for (let v = x0; v <= x1; v++) el('text', { x: sx(v), y: H - M.b + 13, class: 'chart-tick', 'text-anchor': 'middle' }, svg).textContent = `${v} m`;
  el('line', { x1: sx(0), x2: sx(0), y1: M.t, y2: H - M.b, class: 'chart-ref' }, svg);
  el('text', { x: (M.l + W - M.r) / 2, y: H - 3, class: 'chart-axis-label', 'text-anchor': 'middle' }, svg).textContent = 'Water depth above the first floor';
  const band = idx.map((k, j) => `${j ? 'L' : 'M'}${sx(depth[k]).toFixed(1)},${sy(p90[k]).toFixed(1)}`).join('')
    + idx.slice().reverse().map(k => `L${sx(depth[k]).toFixed(1)},${sy(p10[k]).toFixed(1)}`).join('') + 'Z';
  el('path', { d: band, fill: 'var(--series-1)', 'fill-opacity': 0.12, stroke: 'none' }, svg);
  el('path', { d: idx.map((k, j) => `${j ? 'L' : 'M'}${sx(depth[k]).toFixed(1)},${sy(mean[k]).toFixed(1)}`).join(''),
    fill: 'none', stroke: 'var(--series-1)', 'stroke-width': 2, 'stroke-linejoin': 'round' }, svg);
  const lbl = (x, y, s) => { el('text', { x, y, class: 'chart-note' }, svg).textContent = s; };
  const kLab = depth.findIndex(d => d >= 2.6);
  if (kLab > 0) { lbl(sx(depth[kLab]) + 4, sy(mean[kLab]) + 14, 'Mean'); lbl(sx(depth[kLab]) + 4, sy(p90[kLab]) - 5, '90th percentile'); }
  if (at && at.d > x0) {
    const cx = sx(Math.min(at.d, x1)), cy = sy(at.mean);
    el('line', { x1: cx, x2: cx, y1: cy, y2: H - M.b, class: 'chart-now' }, svg);
    el('circle', { cx, cy, r: 5, fill: 'var(--accent)', class: 'chart-dot' }, svg);
  }
}

/** Accessible table twin for a chart. columns: [{ key, label, fmt }] */
export function tableView(host, columns, rows) {
  const t = document.createElement('table');
  t.className = 'data-table';
  const thead = t.createTHead().insertRow();
  for (const c of columns) { const th = document.createElement('th'); th.textContent = c.label; thead.appendChild(th); }
  const tb = t.createTBody();
  for (const r of rows) {
    const tr = tb.insertRow();
    for (const c of columns) { const td = tr.insertCell(); td.textContent = c.fmt ? c.fmt(r[c.key], r) : r[c.key]; }
  }
  host.replaceChildren(t);
  return t;
}
