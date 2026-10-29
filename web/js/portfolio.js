// Portfolios: a demo mortgage book drawn from the NSI residential buildings,
// and CSV upload (id, lat, lon, value, optional loan, type, first_floor_m).

const TYPES = {
  sf: 'RES.SF.2.SLAB', sf1: 'RES.SF.1.SLAB', sf2: 'RES.SF.2.SLAB', basement: 'RES.SF.2.BASEMENT', crawl: 'RES.SF.1.CRAWL',
  elevated: 'RES.SF.1.ELEV_ENCL', mf: 'RES.MF2_4.2.UNK', condo: 'RES.MF2_4.2.UNK', com: 'COM.MIXED.1.UNK', commercial: 'COM.MIXED.1.UNK',
};

function rng(seed) { let s = seed; return () => (s = (s * 16807) % 2147483647) / 2147483647; }

/** 600 small residential properties with synthetic loans (55-90% loan to value). */
export function demoPortfolio(data, geo, n = 600) {
  const B = data.buildings, C = Object.fromEntries(B.columns.map((c, k) => [c, k]));
  const cand = [];
  for (let b = 0; b < B.count; b++) {
    const a = B.attrs[b];
    if (!a?.arch || !/^RES(1|2|3A|3B)/.test(a.occ || '')) continue;
    cand.push(b);
  }
  const r = rng(20121029);
  for (let k = cand.length - 1; k > 0; k--) { const j = Math.floor(r() * (k + 1)); [cand[k], cand[j]] = [cand[j], cand[k]]; }
  return cand.slice(0, n).map((b, k) => {
    const row = B.rows[b], a = B.attrs[b];
    const units = Math.max(1, a.units || 1);
    const value = Math.round((a.vs / units) * 1.0);
    const [lon, lat] = geo.toLonLat(row[C.cx], row[C.cy]);
    return { id: `L-${String(k + 1).padStart(4, '0')}`, b, x: row[C.cx], y: row[C.cy], lon, lat, ground: row[C.g], value,
      loan: Math.round(value * (0.55 + 0.35 * r())), arch: a.arch, side: row[C.side], ffh: a.ffh, share: 1 };
  });
}

function splitCSV(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

/** Parse an uploaded CSV. Returns { assets, skipped, errors }. */
export function parsePortfolioCSV(text, data, geo, heightAt, riverMidX) {
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) return { assets: [], skipped: 0, errors: ['The file has no data rows.'] };
  const head = splitCSV(lines[0]).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  const col = (...names) => head.findIndex(h => names.includes(h));
  const iId = col('id', 'loanid', 'propertyid', 'name'), iLat = col('lat', 'latitude', 'y'), iLon = col('lon', 'lng', 'long', 'longitude', 'x');
  const iVal = col('value', 'propertyvalue', 'tiv', 'buildingvalue', 'replacementvalue'), iLoan = col('loan', 'balance', 'loanamount', 'outstanding');
  const iType = col('type', 'archetype', 'construction', 'occupancy'), iFf = col('firstfloorm', 'ffh', 'firstfloor', 'firstfloorheight');
  const errors = [];
  if (iLat < 0 || iLon < 0) errors.push('Columns lat and lon are required.');
  if (iVal < 0) errors.push('Column value is required.');
  if (errors.length) return { assets: [], skipped: 0, errors };
  const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
  const assets = []; let skipped = 0;
  for (let k = 1; k < lines.length && assets.length < 20000; k++) {
    const c = splitCSV(lines[k]);
    const lat = parseFloat(c[iLat]), lon = parseFloat(c[iLon]), value = parseFloat(String(c[iVal]).replace(/[$,]/g, ''));
    if (!isFinite(lat) || !isFinite(lon) || !(value > 0)) { skipped++; continue; }
    const [x, y] = geo.toLocal(lon, lat);
    if (x < 0 || y < 0 || x > W || y > H) { skipped++; continue; }
    const t = iType >= 0 ? String(c[iType] || '').toLowerCase().replace(/[^a-z0-9]/g, '') : '';
    const arch = data.events.vulnerability.archetypes[c[iType]] ? c[iType] : (TYPES[t] || 'RES.SF.2.SLAB');
    const loan = iLoan >= 0 ? parseFloat(String(c[iLoan]).replace(/[$,]/g, '')) : NaN;
    const ffh = iFf >= 0 ? parseFloat(c[iFf]) : NaN;
    assets.push({ id: iId >= 0 ? c[iId] : `Row ${k}`, x, y, lon, lat, ground: heightAt(x, y), value, loan: loan > 0 ? loan : null,
      arch, side: x > riverMidX(y) ? 'NY' : 'NJ', ffh: isFinite(ffh) ? ffh : 0.3, share: 1 });
  }
  return { assets, skipped, errors };
}

export const SAMPLE_CSV = 'id,lat,lon,value,loan,type,first_floor_m\nA-1,40.7395,-74.0330,650000,480000,sf2,0.6\nA-2,40.7468,-74.0290,820000,600000,basement,0.9\nA-3,40.7505,-74.0025,2400000,,com,0.2\n';
