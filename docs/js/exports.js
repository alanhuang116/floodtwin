// Downloads: building results, time series, peak depth grid (ESRI ASCII,
// UTM 18N), portfolio results and the current view as an image.

export function download(name, content, type = 'text/csv') {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const csvCell = v => {
  if (v == null) return '';
  const s = typeof v === 'number' ? (Number.isInteger(v) ? String(v) : v.toFixed(4)) : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
const csv = (header, rows) => [header.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');

export function buildingsCSV(sim, data, geo) {
  const B = data.buildings, c = sim.col;
  const rows = [];
  for (let b = 0; b < B.count; b++) {
    const r = B.rows[b], a = B.attrs[b];
    const [lon, lat] = geo.toLonLat(r[c.cx], r[c.cy]);
    const info = sim.buildingInfo(b);
    rows.push([b, r[c.id], r[c.name], lon.toFixed(6), lat.toFixed(6), r[c.side], B.class_names[r[c.cls]], r[c.h], info.g,
      a?.occ ?? '', a?.arch ?? '', a?.vs ?? '', a?.vc ?? '', a?.ffh ?? '', a?.stories ?? '', a?.yr ?? '', a?.pn ?? '',
      info.wseMax > -90 ? info.wseMax : '', info.depthMax || 0, info.damage ? info.damage.d : '',
      info.damage ? info.damage.mean : '', info.damage ? info.damage.p10 : '', info.damage ? info.damage.p90 : '',
      info.share, info.loss ?? 0]);
  }
  return csv(['index', 'osm_id', 'name', 'lon', 'lat', 'state', 'class', 'height_m', 'ground_m_navd88', 'nsi_occupancy',
    'archetype', 'value_structure_usd', 'value_contents_usd', 'first_floor_height_m', 'stories', 'year_built', 'residents_night',
    'peak_water_surface_m_navd88', 'peak_depth_at_building_m', 'peak_depth_above_first_floor_m', 'damage_ratio_mean',
    'damage_ratio_p10', 'damage_ratio_p90', 'value_share_two_lowest_storeys', 'expected_loss_usd'], rows);
}

export function seriesCSV(sim, label) {
  return csv(['time_s', 'clock', 'boundary_m_navd88', 'rain_mm_h', 'flooded_land_km2', 'water_on_land_million_m3', 'buildings_reached', 'expected_loss_usd'],
    sim.series.map(p => [Math.round(p.t), label(p.t), p.stage, p.rain, p.area, p.vol, p.wet, Math.round(p.loss)]));
}

/** Peak depth so far on land as an ESRI ASCII grid (NAD83 / UTM 18N, metres). */
export function maxDepthASC(sim, meta) {
  const g = sim.grid, st = sim.solver.readStats();
  const lines = [`ncols ${g.nx}`, `nrows ${g.ny}`, `xllcorner ${meta.grid.x0}`, `yllcorner ${meta.grid.y0}`, `cellsize ${g.dx}`, 'NODATA_value -9999'];
  for (let j = g.ny - 1; j >= 0; j--) {
    const row = new Array(g.nx);
    for (let i = 0; i < g.nx; i++) {
      const c = j * g.nx + i;
      row[i] = g.kind[c] !== 0 ? '-9999' : st[4 * c] > 0.005 ? st[4 * c].toFixed(3) : '0';
    }
    lines.push(row.join(' '));
  }
  return lines.join('\n');
}

export function portfolioCSV(sim) {
  const P = sim.portfolio, R = sim.results?.portfolio;
  if (!P.length || !R) return null;
  return csv(['id', 'lon', 'lat', 'value_usd', 'loan_usd', 'archetype', 'peak_depth_m', 'damage_ratio_mean', 'damage_ratio_p10', 'damage_ratio_p90', 'expected_loss_usd', 'ltv_after'],
    P.map((a, k) => { const r = R.rows[k]; return [a.id, a.lon?.toFixed(6), a.lat?.toFixed(6), a.value, a.loan ?? '', a.arch, r.depth, r.dr, r.p10, r.p90, Math.round(r.loss), r.ltvAfter ?? '']; }));
}

export const PRJ_UTM18N = 'PROJCS["NAD_1983_UTM_Zone_18N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],PARAMETER["False_Easting",500000.0],PARAMETER["False_Northing",0.0],PARAMETER["Central_Meridian",-75.0],PARAMETER["Scale_Factor",0.9996],PARAMETER["Latitude_Of_Origin",0.0],UNIT["Meter",1.0]]';
