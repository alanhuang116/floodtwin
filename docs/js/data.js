// Loads and decodes the scene assets in web/data/.
// Rasters are row 0 = south; images are row 0 = north (flipped on upload).

async function fetchBytes(url, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (!res.body || !onProgress) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = []; let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
    onProgress(got, total);
  }
  const out = new Uint8Array(got); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

async function gunzip(bytes) {
  // a server may already have removed the gzip layer (Content-Encoding: gzip)
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const ds = new DecompressionStream('gzip');
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`${url}: image failed to load`));
    img.src = url;
  });
}

/** Decode the row-delta, zigzag uint16 DEM to metres (Float32Array, row 0 = south). */
export function decodeDem(raw, cols, rows, enc) {
  const u = new Uint16Array(raw.buffer, raw.byteOffset, cols * rows);
  const z = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    let acc = 0;
    const o = r * cols;
    for (let c = 0; c < cols; c++) {
      const v = u[o + c];
      const d = (v >>> 1) ^ -(v & 1);
      acc = c === 0 ? d : acc + d;
      z[o + c] = acc * enc.scale - enc.offset;
    }
  }
  return z;
}

/**
 * Load everything. progress(fraction, label) is called as files arrive.
 * Returns { meta, events, dem, land, bldg, fema, buildings, trees, cars, ortho, ao }.
 */
export async function loadAll(base, progress = () => {}) {
  const files = [
    ['meta', 'meta.json', 6e3], ['events', 'events.json', 9e4], ['dem', 'dem_2m.bin.gz', 2.2e6],
    ['land', 'land_2m.bin.gz', 1.4e5], ['bldg', 'bldg_2m.bin.gz', 3.2e5], ['fema', 'fema_2m.bin.gz', 2.4e4],
    ['buildings', 'buildings.json', 3.6e6], ['trees', 'trees.json', 5e5], ['cars', 'cars.json', 1e6],
  ];
  const images = [['ortho', 'ortho_1m.webp', 3.6e6], ['ao', 'ao_2m.webp', 9e5]];
  const weight = [...files, ...images].reduce((s, f) => s + f[2], 0);
  const got = {};
  let done = 0;
  const bump = (key, w, label) => { got[key] = w; const s = Object.values(got).reduce((a, b) => a + b, 0); progress(Math.min(1, s / weight), label); };

  const labels = {
    meta: 'Reading the domain', events: 'Loading Hurricane Sandy records', dem: 'Loading 1 m lidar terrain',
    land: 'Loading land cover', bldg: 'Loading building cover', fema: 'Loading FEMA flood zones',
    buildings: 'Loading 13,152 buildings', trees: 'Loading lidar tree canopy', cars: 'Placing vehicles',
    ortho: 'Loading aerial imagery', ao: 'Loading ambient occlusion',
  };
  const out = {};
  await Promise.all([
    ...files.map(async ([key, name, w]) => {
      const bytes = await fetchBytes(`${base}/${name}`, (g, t) => bump(key, w * (t ? g / t : 0.5), labels[key]));
      bump(key, w, labels[key]);
      if (name.endsWith('.json')) out[key] = JSON.parse(new TextDecoder().decode(bytes));
      else out[key] = await gunzip(bytes);
      done++;
    }),
    ...images.map(async ([key, name, w]) => {
      out[key] = await loadImage(`${base}/${name}`);
      bump(key, w, labels[key]);
    }),
  ]);
  const m = out.meta;
  out.dem = decodeDem(out.dem, m.dem_cols, m.dem_rows, m.dem_encoding);
  return out;
}

/** Local metres (east, north from the grid origin) <-> lon/lat, quadratic fit (error < 1e-4 m). */
export function makeGeo(meta) {
  const q = (c, a, b) => c[0] + c[1] * a + c[2] * b + c[3] * a * a + c[4] * a * b + c[5] * b * b;
  const L = meta.lonlat_from_local, X = meta.local_from_lonlat;
  return {
    toLonLat: (x, y) => [q(L.lon, x, y), q(L.lat, x, y)],
    toLocal: (lon, lat) => [q(X.x, lon, lat), q(X.y, lon, lat)],
  };
}
