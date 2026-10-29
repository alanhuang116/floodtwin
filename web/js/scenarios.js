// Event definitions: boundary water level (m NAVD88) and rainfall (mm/h) as
// functions of simulation time t (s since the scenario start).

const HOUR = 3600;
const M2 = 12.4206 * HOUR;           // principal lunar semidiurnal period
const TIDE_AMP = 0.72;               // m, typical half-range at The Battery
const MSL = 0.0;                     // m NAVD88 (approximate mean sea level at The Battery)

export const PRESETS = [
  { id: 'sandy', name: 'Hurricane Sandy', tag: 'Replay',
    note: '29 October 2012. Boundary from the observed water level at The Battery (NOAA 8518750); peak 3.44 m NAVD88 at 21:24 EDT.',
    p: { mode: 'replay', slr: 0, offset: -0.216, rain: 0, rainDur: 1, rainStart: 0, drainage: 10, infiltration: 10 } },
  { id: 'coastal100', name: '1-in-100-Year Coastal Flood', tag: 'Design',
    note: 'Peak still-water level 3.05 m NAVD88, the highest FEMA base flood elevation mapped in Hoboken (10 ft), on a high tide.',
    p: { mode: 'surge', peak: 3.05, duration: 12, timing: 'high', slr: 0, rain: 0, rainDur: 1, rainStart: 0, drainage: 10, infiltration: 10 } },
  { id: 'coastal100slr', name: 'Coastal Flood With Sea Level Rise', tag: 'Climate',
    note: 'The 1-in-100-year coastal flood with 0.6 m of sea level rise added to the boundary.',
    p: { mode: 'surge', peak: 3.05, duration: 12, timing: 'high', slr: 0.6, rain: 0, rainDur: 1, rainStart: 0, drainage: 10, infiltration: 10 } },
  { id: 'cloudburst', name: '1-in-100-Year Cloudburst', tag: 'Design',
    note: '73 mm of rain in one hour, the NOAA Atlas 14 1% annual chance depth at Hoboken, with drainage at 25 mm/h.',
    p: { mode: 'tide', slr: 0, rain: 73, rainDur: 1, rainStart: 0.25, drainage: 25, infiltration: 12 } },
  { id: 'ida', name: 'Ida-Like Downpour', tag: 'Historical analogue',
    note: '80 mm in one hour, as recorded in Central Park on 1 September 2021: about a 1-in-170-year hour at Hoboken.',
    p: { mode: 'tide', slr: 0, rain: 80, rainDur: 1, rainStart: 0.25, drainage: 25, infiltration: 12 } },
  { id: 'compound', name: 'Compound Surge and Rain', tag: 'Design',
    note: 'An illustrative 2.3 m NAVD88 surge on a high tide with the 1-in-10-year six-hour rainfall (91 mm, NOAA Atlas 14).',
    p: { mode: 'surge', peak: 2.3, duration: 12, timing: 'high', slr: 0, rain: 15.2, rainDur: 6, rainStart: 1.5, drainage: 15, infiltration: 10 } },
];

export function presetById(id) { return PRESETS.find(p => p.id === id) || PRESETS[0]; }

function tide(t, tHigh) { return MSL + TIDE_AMP * Math.cos((2 * Math.PI * (t - tHigh)) / M2); }

/** Build a runnable scenario from a parameter set. events = events.json */
export function makeScenario(p, events) {
  const s = { params: { ...p } };
  if (p.mode === 'replay') {
    const b = events.battery;
    const t0 = Date.parse(b.t0);
    s.start = Date.UTC(2012, 9, 29, 21, 0);
    s.duration = 9 * HOUR;
    const obs = b.observed, pred = b.predicted;
    const offMin = (s.start - t0) / 60000;
    const interp = (ser, tmin) => {
      const T = ser.t_min, Z = ser.z;
      if (tmin <= T[0]) return Z[0];
      if (tmin >= T[T.length - 1]) return Z[Z.length - 1];
      let lo = 0, hi = T.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (T[mid] <= tmin) lo = mid; else hi = mid; }
      const w = (tmin - T[lo]) / (T[hi] - T[lo]);
      return Z[lo] + w * (Z[hi] - Z[lo]);
    };
    // offset: local correction from The Battery to the Hoboken waterfront (calibrated on four
    // waterfront high-water marks; see validation.json). Zero gives the raw Battery record.
    const off = (p.slr || 0) + (p.offset || 0);
    s.stage = t => interp(obs, offMin + t / 60) + off;
    s.tideOnly = t => interp(pred, offMin + t / 60) + off;
    s.observed = obs.t_min.map((tm, k) => [(tm - offMin) * 60, obs.z[k]]).filter(([t]) => t >= -HOUR && t <= s.duration + HOUR);
    s.clock = 'absolute';
  } else {
    const timing = { high: 0, mid: M2 / 4, low: M2 / 2 }[p.timing || 'high'];
    const tPeak = p.mode === 'surge' ? 5 * HOUR : 2 * HOUR;
    const tHigh = tPeak - timing;
    s.start = Date.UTC(2030, 0, 1, 0, 0);
    s.duration = p.mode === 'surge' ? 9.5 * HOUR : Math.max(4 * HOUR, (p.rainStart + p.rainDur + 2.5) * HOUR);
    if (p.mode === 'surge') {
      const sigma = (p.duration * HOUR) / 4;
      const S = Math.max(0, p.peak - tide(tPeak, tHigh));
      s.stage = t => tide(t, tHigh) + S * Math.exp(-(((t - tPeak) / sigma) ** 2)) + (p.slr || 0);
    } else {
      // rainfall events start near low tide so the river stays in its banks
      const tLow = 0.6 * HOUR;
      s.stage = t => tide(t, tLow + M2 / 2) + (p.slr || 0);
    }
    s.tideOnly = t => tide(t, tHigh) + (p.slr || 0);
    s.observed = null;
    s.clock = 'relative';
  }
  const r0 = (p.rainStart || 0) * HOUR, r1 = r0 + (p.rainDur || 0) * HOUR;
  s.rain = t => (p.rain > 0 && t >= r0 && t < r1 ? p.rain : 0);        // mm/h
  s.rainWindow = [r0, r1];
  s.peakStage = (() => { let m = -9; for (let t = 0; t <= s.duration; t += 300) m = Math.max(m, s.stage(t)); return m; })();
  return s;
}

const pad = v => String(v).padStart(2, '0');
/** Clock label for simulation time t (s). Sandy is shown in local time (EDT, UTC-4). */
export function clockLabel(s, t) {
  if (s.clock === 'absolute') {
    const d = new Date(s.start + t * 1000 - 4 * HOUR * 1000);
    const day = d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    return `${day}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} EDT`;
  }
  const sign = t < 0 ? '-' : '';
  const a = Math.abs(t);
  return `Hour ${sign}${Math.floor(a / HOUR)}:${pad(Math.floor((a % HOUR) / 60))}`;
}

export function shortClock(s, t) {
  if (s.clock === 'absolute') {
    const d = new Date(s.start + t * 1000 - 4 * HOUR * 1000);
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  return `${Math.floor(t / HOUR)}:${pad(Math.floor((t % HOUR) / 60))}`;
}
