// Building damage from FloodVuln Global (fitted to 1.86 million NFIP claims):
// damage ratio distribution against depth above the first floor, by archetype
// and state (NJ / NY calibration), tabulated in events.json.

export function makeVuln(events) {
  const V = events.vulnerability;
  const d0 = V.depth_m[0], step = V.depth_m[1] - V.depth_m[0], nD = V.depth_m.length;
  function look(arr, d) {
    const x = (d - d0) / step;
    if (x <= 0) return arr[0];
    if (x >= nD - 1) return arr[nD - 1];
    const k = Math.floor(x), w = x - k;
    return arr[k] * (1 - w) + arr[k + 1] * w;
  }
  return {
    archetypes: V.archetypes,
    /** Damage ratio summary for water surface wse at a building with ground g,
     *  first-floor height ffh, archetype arch and region 'NJ' | 'NY'. */
    damage(arch, region, wse, g, ffh) {
      if (!(wse > g + 0.02)) return { mean: 0, p10: 0, p50: 0, p90: 0, d: wse - g - ffh };
      const t = V.tables[`${arch}@${region}`] || V.tables[`${arch}@NJ`];
      const d = wse - (g + ffh);
      return { mean: look(t.mean, d), p10: look(t.p10, d), p50: look(t.p50, d), p90: look(t.p90, d), d };
    },
    curve(arch, region) {
      const t = V.tables[`${arch}@${region}`];
      return { depth: V.depth_m, mean: t.mean, p10: t.p10, p90: t.p90 };
    },
  };
}
