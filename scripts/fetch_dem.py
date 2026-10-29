"""Download the 1 m bare-earth DEM for the domain from the USGS 3DEP dynamic
elevation service (public domain), in tiles, and mosaic it.

    python scripts/fetch_dem.py   ->  data/raw/dem_1m.npy (float32, metres NAVD88,
                                       row 0 = north edge), data/raw/dem_1m.json
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.parse
import urllib.request

import numpy as np
import tifffile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
URL = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer/exportImage"
RES = 1.0
TILE = 2048


def fetch(bbox, w, h, tries=8):
    q = {"bbox": ",".join(f"{v:.3f}" for v in bbox), "bboxSR": 26918, "imageSR": 26918,
         "size": f"{w},{h}", "format": "tiff", "pixelType": "F32",
         "noDataInterpretation": "esriNoDataMatchAny", "interpolation": "RSP_BilinearInterpolation",
         "f": "image"}
    url = URL + "?" + urllib.parse.urlencode(q)
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 FloodTwin/1.0"})
            with urllib.request.urlopen(req, timeout=180) as r:
                b = r.read()
            a = tifffile.imread(io.BytesIO(b)).astype(np.float32)
            if a.shape != (h, w):
                raise ValueError(f"shape {a.shape} != {(h, w)}")
            return a
        except Exception as e:  # noqa: BLE001
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(4 * (k + 1))
    raise SystemExit("DEM tile failed")


def main():
    g = grid()
    W = int(round(g["width_m"] / RES))
    H = int(round(g["height_m"] / RES))
    dem = np.full((H, W), np.nan, np.float32)
    for r0 in range(0, H, TILE):
        for c0 in range(0, W, TILE):
            h, w = min(TILE, H - r0), min(TILE, W - c0)
            x0 = g["x0"] + c0 * RES
            y1 = g["y1"] - r0 * RES
            bbox = (x0, y1 - h * RES, x0 + w * RES, y1)
            print(f"tile rows {r0}:{r0 + h} cols {c0}:{c0 + w}", flush=True)
            dem[r0:r0 + h, c0:c0 + w] = fetch(bbox, w, h)
    bad = ~np.isfinite(dem) | (dem < -50) | (dem > 500)
    dem[bad] = np.nan
    np.save(os.path.join(ROOT, "data", "raw", "dem_1m.npy"), dem)
    meta = {**g, "res": RES, "rows": H, "cols": W, "nodata_cells": int(bad.sum()),
            "min": float(np.nanmin(dem)), "max": float(np.nanmax(dem)),
            "source": URL, "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    json.dump(meta, open(os.path.join(ROOT, "data", "raw", "dem_1m.json"), "w"), indent=1)
    print(meta)


if __name__ == "__main__":
    main()
