"""Build the terrain assets for the browser from the raw downloads.

Outputs in web/data/ (all rasters: row 0 = south edge, little-endian):
  dem_2m.bin.gz    uint16 row-delta encoded, z = v * 0.01 - 30  (m NAVD88)
  land_2m.bin.gz   uint8 land cover: 0 paved, 1 river (boundary), 2 grass,
                   3 tree canopy, 4 bare/gravel
  fema_2m.bin.gz   uint8 FEMA effective zone: 0 none/X, 1 0.2% (X shaded),
                   2 AE, 3 VE  (+ base flood elevations in meta)
  ortho_1m.webp    NAIP true colour at 1 m (row 0 = north, as an image)
and data/processed/terrain.npz with the full-resolution layers used by the
building and tree builders.

    python scripts/build_terrain.py
"""
from __future__ import annotations

import gzip
import io
import json
import os
import sys

import numpy as np
from PIL import Image
from scipy import ndimage

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
WEB = os.path.join(ROOT, "web", "data")
PROC = os.path.join(ROOT, "data", "processed")
Z_OFF, Z_SCALE = 30.0, 0.01


def block_mean(a, f):
    h, w = a.shape[0] // f * f, a.shape[1] // f * f
    return a[:h, :w].reshape(h // f, f, w // f, f, *a.shape[2:]).mean(axis=(1, 3))


def write_gz(name, arr):
    """Rows south-to-north, little-endian, gzip."""
    with gzip.open(os.path.join(WEB, name), "wb", compresslevel=9) as fh:
        fh.write(np.ascontiguousarray(arr[::-1]).astype(arr.dtype.newbyteorder("<")).tobytes())
    return os.path.getsize(os.path.join(WEB, name))


def encode_dem(z2):
    """Quantise to 1 cm and delta-encode each row (west to east)."""
    q = np.round((z2 + Z_OFF) / Z_SCALE).astype(np.int32)
    flipped = q[::-1]                      # row 0 = south
    d = np.empty_like(flipped)
    d[:, 0] = flipped[:, 0]
    d[:, 1:] = np.diff(flipped, axis=1)
    zz = ((d << 1) ^ (d >> 31)).astype(np.uint32)     # zigzag
    assert zz.max() < 65536
    with gzip.open(os.path.join(WEB, "dem_2m.bin.gz"), "wb", compresslevel=9) as fh:
        fh.write(zz.astype("<u2").tobytes())
    return os.path.getsize(os.path.join(WEB, "dem_2m.bin.gz"))


def river_mask(dem1):
    """The Hudson is hydro-flattened at about -0.65 m. Its largest connected
    low area is the river; flat water surfaces cut off from it by a pier or a
    bridge deck (slips, the pocket behind Pier 84) join it when they lie within
    40 m. Deep pits (sunken rail yards, excavations, underpasses) stay as
    terrain and can flood."""
    low = dem1 < -0.45
    lab, n = ndimage.label(low)
    sizes = ndimage.sum(low, lab, index=np.arange(1, n + 1))
    keep = np.zeros(n + 1, bool)
    keep[1 + int(np.argmax(sizes))] = True
    river = keep[lab]
    near = ndimage.distance_transform_edt(~river) <= 40
    cand = (dem1 < -0.3) & ~river
    lab2, n2 = ndimage.label(cand)
    idx = np.arange(1, n2 + 1)
    area = ndimage.sum(cand, lab2, idx)
    med = ndimage.median(dem1, lab2, idx)
    sd = ndimage.standard_deviation(dem1, lab2, idx)
    touch = ndimage.maximum(near, lab2, idx)
    add = np.zeros(n2 + 1, bool)
    add[1:] = (area > 300) & (med > -0.8) & (med < -0.3) & (sd < 0.15) & (touch > 0)
    return river | add[lab2]


def fema_raster(g, shape, res):
    from shapely.geometry import shape as shp
    from shapely.ops import transform
    from PIL import ImageDraw
    z = json.load(open(os.path.join(RAW, "fema_zones.json")))
    H, W = shape
    img = Image.new("L", (W, H), 0)
    dr = ImageDraw.Draw(img)
    bfes = {}
    order = {"0.2 PCT ANNUAL CHANCE FLOOD HAZARD": 1, "AE": 2, "VE": 3}
    feats = []
    for f in z["features"]:
        p = f["properties"]
        code = 3 if p["FLD_ZONE"] == "VE" else 2 if p["FLD_ZONE"] in ("AE", "A", "AO") else (
            1 if p.get("ZONE_SUBTY") and "0.2" in str(p.get("ZONE_SUBTY")) else 0)
        if code == 0:
            continue
        feats.append((code, p, shp(f["geometry"])))
        if code >= 2 and p.get("STATIC_BFE") and p["STATIC_BFE"] > -9000:
            bfes.setdefault(p["FLD_ZONE"], set()).add(float(p["STATIC_BFE"]))
    for code, p, geom in sorted(feats, key=lambda t: t[0]):
        geom = transform(lambda x, y, zz=None: to_utm(x, y), geom)
        polys = geom.geoms if hasattr(geom, "geoms") else [geom]
        for poly in polys:
            for ring, fill in [(poly.exterior, code)] + [(r, 0) for r in poly.interiors]:
                xs, ys = ring.xy
                pts = [((x - g["x0"]) / res, (g["y1"] - y) / res) for x, y in zip(xs, ys)]
                if len(pts) > 2:
                    dr.polygon(pts, fill=fill)
    return np.array(img, np.uint8), {k: sorted(v) for k, v in bfes.items()}


def main():
    os.makedirs(WEB, exist_ok=True); os.makedirs(PROC, exist_ok=True)
    g = grid()
    dem1 = np.load(os.path.join(RAW, "dem_1m.npy"))
    naip = np.load(os.path.join(RAW, "naip_05m.npy"), mmap_mode="r")

    river1 = river_mask(dem1)
    dem2 = block_mean(dem1, 2).astype(np.float32)
    river2 = block_mean(river1.astype(np.float32), 2) > 0.5

    # vegetation from NAIP NDVI, at 1 m then 2 m
    rgbn = block_mean(np.asarray(naip, np.float32), 2)            # 1 m, 4 bands
    ndvi1 = (rgbn[..., 3] - rgbn[..., 0]) / np.maximum(rgbn[..., 3] + rgbn[..., 0], 1)
    ndvi2 = block_mean(ndvi1, 2)
    land2 = np.zeros(dem2.shape, np.uint8)
    land2[ndvi2 > 0.22] = 2
    land2[river2] = 1

    fema2, bfes = fema_raster(g, dem2.shape, 2.0)

    # orthophoto: gentle contrast and white balance for display
    rgb = rgbn[..., :3]
    lo = np.percentile(rgb[~river1[:rgb.shape[0], :rgb.shape[1]]], 1, axis=0)
    hi = np.percentile(rgb[~river1[:rgb.shape[0], :rgb.shape[1]]], 99.5, axis=0)
    rgbs = np.clip((rgb - lo) / (hi - lo), 0, 1) ** 0.92
    Image.fromarray((rgbs * 255).astype(np.uint8)).save(os.path.join(WEB, "ortho_1m.webp"), quality=82, method=6)

    sizes = {"dem_2m.bin.gz": encode_dem(dem2), "land_2m.bin.gz": write_gz("land_2m.bin.gz", land2),
             "fema_2m.bin.gz": write_gz("fema_2m.bin.gz", fema2),
             "ortho_1m.webp": os.path.getsize(os.path.join(WEB, "ortho_1m.webp"))}
    np.savez_compressed(os.path.join(PROC, "terrain.npz"), dem1=dem1, river1=river1, ndvi1=ndvi1.astype(np.float32),
                        dem2=dem2, land2=land2, fema2=fema2)
    meta = {"grid": g, "res2": 2.0, "rows2": int(dem2.shape[0]), "cols2": int(dem2.shape[1]),
            "dem_encoding": {"offset": Z_OFF, "scale": Z_SCALE, "delta": "row", "zigzag": True},
            "fema_bfe_ft": bfes, "files": sizes,
            "stats": {"river_km2": float(river1.sum() / 1e6), "land_min": float(dem1[~river1].min()),
                      "land_max": float(dem1.max()), "veg_share": float((land2 == 2).mean())}}
    json.dump(meta, open(os.path.join(PROC, "terrain_meta.json"), "w"), indent=1)
    print(json.dumps(meta, indent=1))


if __name__ == "__main__":
    main()
