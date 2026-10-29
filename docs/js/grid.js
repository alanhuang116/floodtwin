// Builds the simulation grid from the 2 m source layers at a chosen cell size
// (2, 4 or 8 m). All arrays are row 0 = south, index = j * nx + i.

export const KIND = { LAND: 0, SEA: 1, BUILDING: 2 };
// Manning's n by land cover class (0 paved, 1 river, 2 grass, 3 tree canopy, 4 bare)
export const DEFAULT_N = { paved: 0.016, river: 0.030, grass: 0.035, tree: 0.060, bare: 0.030 };

function pointInRing(x, y, r) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInBuilding(x, y, polys) {
  for (const poly of polys) {
    if (!pointInRing(x, y, poly[0])) continue;
    let hole = false;
    for (let k = 1; k < poly.length; k++) if (pointInRing(x, y, poly[k])) { hole = true; break; }
    if (!hole) return true;
  }
  return false;
}

/**
 * @param {object} data   loaded assets (dem, land, bldg, buildings, events, meta)
 * @param {object} o      { dx, drainage (mm/h), infiltration (mm/h), nPaved, nGreen,
 *                          porousBuildings, barriers: [{points:[[x,y]..], crest}], breaches: [{x,y,r}],
 *                          waterfrontBarrier: {on, crest} }
 */
export function buildGrid(data, o) {
  const m = data.meta;
  const cols = m.dem_cols, rows = m.dem_rows;
  const dx = o.dx, f = Math.round(dx / m.dem_res);
  const nx = Math.floor(cols / f), ny = Math.floor(rows / f), N = nx * ny;
  const z = new Float32Array(N), z0 = new Float32Array(N), n = new Float32Array(N), loss = new Float32Array(N);
  const kind = new Uint8Array(N), veg = new Float32Array(N);
  const nP = o.nPaved ?? DEFAULT_N.paved, nG = o.nGreen ?? DEFAULT_N.grass;
  const nClass = [nP, DEFAULT_N.river, nG, Math.max(nG, DEFAULT_N.tree), DEFAULT_N.bare];
  const drain = (o.drainage ?? 0) / 3.6e6, infil = (o.infiltration ?? 0) / 3.6e6;
  const ff = f * f;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      let zs = 0, riv = 0, bc = 0, ns = 0, vg = 0;
      for (let b = 0; b < f; b++) {
        const r = j * f + b;
        for (let a = 0; a < f; a++) {
          const k = r * cols + i * f + a;
          const lc = data.land[k];
          zs += data.dem[k];
          if (lc === 1) riv++;
          if (lc === 2 || lc === 3) vg++;
          bc += data.bldg[k];
          ns += nClass[lc] ?? nP;
        }
      }
      const c = j * nx + i;
      z[c] = zs / ff; z0[c] = z[c];
      veg[c] = vg / ff;
      if (riv * 2 > ff) kind[c] = KIND.SEA;
      else if (bc / ff > 127.5 && !o.porousBuildings) kind[c] = KIND.BUILDING;
      n[c] = kind[c] === KIND.SEA ? DEFAULT_N.river : (bc / ff > 127.5 && o.porousBuildings ? 0.15 : ns / ff);
      loss[c] = kind[c] === KIND.LAND ? drain + infil * veg[c] : 0;
    }
  }

  // marinas, slips and coves below +0.5 m that connect to the river are river
  // water too: they sit outside the hydro-flattened river mask, and every
  // bulkhead and pier deck in the domain is higher than this
  {
    const queue = [];
    for (let c = 0; c < N; c++) if (kind[c] === KIND.SEA) queue.push(c);
    while (queue.length) {
      const c = queue.pop(), i = c % nx, j = (c - i) / nx;
      const nb = [i > 0 ? c - 1 : -1, i < nx - 1 ? c + 1 : -1, j > 0 ? c - nx : -1, j < ny - 1 ? c + nx : -1];
      for (const q of nb) {
        if (q < 0 || kind[q] !== KIND.LAND || z[q] >= 0.5) continue;
        kind[q] = KIND.SEA; n[q] = DEFAULT_N.river; loss[q] = 0;
        queue.push(q);
      }
    }
  }

  // river centre line per row, to tell the New Jersey bank from Manhattan
  const riverMid = new Float32Array(ny);
  for (let j = 0; j < ny; j++) {
    let s = 0, cnt = 0;
    for (let i = 0; i < nx; i++) if (kind[j * nx + i] === KIND.SEA) { s += i; cnt++; }
    riverMid[j] = cnt ? s / cnt : nx * 0.7;
  }
  const seaAdj = (c, i, j) =>
    (i > 0 && kind[c - 1] === KIND.SEA) || (i < nx - 1 && kind[c + 1] === KIND.SEA) ||
    (j > 0 && kind[c - nx] === KIND.SEA) || (j < ny - 1 && kind[c + nx] === KIND.SEA);

  // barriers: raise the bed along the line to the crest elevation
  const barrierCells = new Set(), waterfrontCells = [];
  const raise = (c, crest) => {
    if (kind[c] === KIND.SEA) return;
    if (kind[c] === KIND.BUILDING) kind[c] = KIND.LAND;
    z[c] = Math.max(z[c], crest); barrierCells.add(c);
  };
  if (o.waterfrontBarrier?.on) {
    const [ys, yn] = m.hoboken_waterfront_y;
    for (let j = 0; j < ny; j++) {
      const y = (j + 0.5) * dx;
      if (y < ys || y > yn) continue;
      for (let i = 0; i < nx; i++) {
        const c = j * nx + i;
        if (kind[c] === KIND.SEA || i > riverMid[j]) continue;
        if (seaAdj(c, i, j)) { raise(c, o.waterfrontBarrier.crest); waterfrontCells.push(c); }
      }
    }
  }
  for (const b of o.barriers || []) {
    for (let k = 0; k + 1 < b.points.length; k++) {
      const [x1, y1] = b.points[k], [x2, y2] = b.points[k + 1];
      const len = Math.hypot(x2 - x1, y2 - y1), steps = Math.max(1, Math.ceil(len / (dx * 0.4)));
      for (let s = 0; s <= steps; s++) {
        const x = x1 + (x2 - x1) * s / steps, y = y1 + (y2 - y1) * s / steps;
        const i = Math.floor(x / dx), j = Math.floor(y / dx);
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        raise(j * nx + i, b.crest);
        // make the line 4-connected so water cannot slip through diagonally
        if (s > 0) {
          const xp = x1 + (x2 - x1) * (s - 1) / steps, yp = y1 + (y2 - y1) * (s - 1) / steps;
          const ip = Math.floor(xp / dx), jp = Math.floor(yp / dx);
          if (ip !== i && jp !== j && jp >= 0 && jp < ny && i >= 0 && i < nx) raise(jp * nx + i, b.crest);
        }
      }
    }
  }
  for (const br of o.breaches || []) {
    const r = Math.max(br.r / dx, 0.5);
    const ci = br.x / dx, cj = br.y / dx;
    for (let j = Math.floor(cj - r - 1); j <= Math.ceil(cj + r + 1); j++) {
      for (let i = Math.floor(ci - r - 1); i <= Math.ceil(ci + r + 1); i++) {
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const c = j * nx + i;
        if (barrierCells.has(c) && Math.hypot(i + 0.5 - ci, j + 0.5 - cj) <= r + 0.5) { z[c] = z0[c]; barrierCells.delete(c); }
      }
    }
  }
  for (const c of barrierCells) loss[c] = 0;

  let minCoastZ = 99;
  for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
    const c = j * nx + i;
    if (kind[c] === KIND.LAND && seaAdj(c, i, j)) minCoastZ = Math.min(minCoastZ, z[c]);
  }

  const bed = new Float32Array(N * 4);
  for (let c = 0; c < N; c++) { bed[4 * c] = z[c]; bed[4 * c + 1] = n[c]; bed[4 * c + 2] = kind[c]; bed[4 * c + 3] = loss[c]; }
  return { nx, ny, dx, f, N, z, z0, n, kind, loss, veg, bed, riverMid, minCoastZ, barrierCells: [...barrierCells],
    waterfrontCells: waterfrontCells.filter(c => barrierCells.has(c)) };
}

/** Ring of open cells around each building (and each high-water mark): up to
 *  eight cell indices per entry, spread by angle. Returns Float32Array(count * 8). */
export function buildSamples(data, g, extraPoints = []) {
  const B = data.buildings, nb = B.count;
  const cx = B.columns.indexOf('cx'), cy = B.columns.indexOf('cy');
  const total = nb + extraPoints.length;
  const ids = new Float32Array(total * 8).fill(-1);
  const { nx, ny, dx, kind } = g;
  const open = c => kind[c] === 0;
  const pick = (cands, x0, y0, out) => {
    if (!cands.length) return;
    cands.sort((a, b) => Math.atan2((Math.floor(a / nx) + 0.5) * dx - y0, (a % nx + 0.5) * dx - x0) -
                         Math.atan2((Math.floor(b / nx) + 0.5) * dx - y0, (b % nx + 0.5) * dx - x0));
    const k = Math.min(8, cands.length);
    for (let s = 0; s < k; s++) ids[out * 8 + s] = cands[Math.floor((s * cands.length) / k)];
  };
  for (let b = 0; b < nb; b++) {
    const polys = B.rings[b];
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const poly of polys) { const r = poly[0]; for (let k = 0; k < r.length; k += 2) { minx = Math.min(minx, r[k]); maxx = Math.max(maxx, r[k]); miny = Math.min(miny, r[k + 1]); maxy = Math.max(maxy, r[k + 1]); } }
    const i0 = Math.max(0, Math.floor(minx / dx) - 1), i1 = Math.min(nx - 1, Math.floor(maxx / dx) + 1);
    const j0 = Math.max(0, Math.floor(miny / dx) - 1), j1 = Math.min(ny - 1, Math.floor(maxy / dx) + 1);
    const inside = new Set();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++)
      if (pointInBuilding((i + 0.5) * dx, (j + 0.5) * dx, polys)) inside.add(j * nx + i);
    const x0 = B.rows[b][cx], y0 = B.rows[b][cy];
    if (!inside.size) {
      const i = Math.min(nx - 1, Math.max(0, Math.floor(x0 / dx))), j = Math.min(ny - 1, Math.max(0, Math.floor(y0 / dx)));
      inside.add(j * nx + i);
    }
    let cands = [];
    for (let rad = 1; rad <= 4 && !cands.length; rad++) {
      const seen = new Set();
      for (const c of inside) {
        const ci = c % nx, cj = Math.floor(c / nx);
        for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
          const q = j * nx + i;
          if (!inside.has(q) && open(q) && !seen.has(q)) { seen.add(q); cands.push(q); }
        }
      }
    }
    pick(cands, x0, y0, b);
  }
  extraPoints.forEach((p, k) => {
    const ci = Math.floor(p.x / dx), cj = Math.floor(p.y / dx);
    let cands = [];
    for (let rad = 0; rad <= 4 && cands.length < 3; rad++) {
      cands = [];
      for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const q = j * nx + i;
        if (open(q)) cands.push(q);
      }
    }
    pick(cands, p.x, p.y, nb + k);
  });
  return { ids, count: total };
}

/** One open cell per point (vehicles, portfolio assets): the cell under the
 *  point, or the nearest open cell within four cells. Returns Float32Array(n * 8). */
export function pointSamples(points, g) {
  const { nx, ny, dx, kind } = g;
  const ids = new Float32Array(points.length * 8).fill(-1);
  points.forEach((p, k) => {
    const ci = Math.floor(p.x / dx), cj = Math.floor(p.y / dx);
    let best = -1, bd = 1e9;
    for (let rad = 0; rad <= 4 && best < 0; rad++) {
      for (let dj = -rad; dj <= rad; dj++) for (let di = -rad; di <= rad; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== rad) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= nx || j >= ny) continue;
        const q = j * nx + i;
        if (kind[q] !== KIND.LAND) continue;
        const d = di * di + dj * dj;
        if (d < bd) { bd = d; best = q; }
      }
    }
    ids[k * 8] = best;
  });
  return ids;
}
