"""Download NAIP orthoimagery (USDA/USGS, public domain) for the domain:
four bands (red, green, blue, near-infrared) at 0.5 m, in tiles.

    python scripts/fetch_ortho.py  ->  data/raw/naip_05m.npy (uint8, H x W x 4, row 0 = north)
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
URL = "https://imagery.nationalmap.gov/arcgis/rest/services/USGSNAIPPlus/ImageServer/exportImage"
RES = 0.5
TILE = 2048


def fetch(bbox, w, h, tries=8):
    q = {"bbox": ",".join(f"{v:.3f}" for v in bbox), "bboxSR": 26918, "imageSR": 26918,
         "size": f"{w},{h}", "format": "tiff", "pixelType": "U8", "bandIds": "0,1,2,3",
         "interpolation": "RSP_BilinearInterpolation", "f": "image"}
    url = URL + "?" + urllib.parse.urlencode(q)
    for k in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 FloodTwin/1.0"})
            with urllib.request.urlopen(req, timeout=240) as r:
                b = r.read()
            a = tifffile.imread(io.BytesIO(b))
            if a.ndim == 3 and a.shape[0] == 4:
                a = np.moveaxis(a, 0, -1)
            if a.shape != (h, w, 4):
                raise ValueError(f"shape {a.shape}")
            return a.astype(np.uint8)
        except Exception as e:  # noqa: BLE001
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(4 * (k + 1))
    raise SystemExit("ortho tile failed")


def main():
    g = grid()
    W, H = int(g["width_m"] / RES), int(g["height_m"] / RES)
    img = np.zeros((H, W, 4), np.uint8)
    for r0 in range(0, H, TILE):
        for c0 in range(0, W, TILE):
            h, w = min(TILE, H - r0), min(TILE, W - c0)
            x0, y1 = g["x0"] + c0 * RES, g["y1"] - r0 * RES
            print(f"tile {r0},{c0}", flush=True)
            img[r0:r0 + h, c0:c0 + w] = fetch((x0, y1 - h * RES, x0 + w * RES, y1), w, h)
    np.save(os.path.join(ROOT, "data", "raw", "naip_05m.npy"), img)
    json.dump({**g, "res": RES, "rows": H, "cols": W, "bands": ["red", "green", "blue", "nir"],
               "source": URL, "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())},
              open(os.path.join(ROOT, "data", "raw", "naip_05m.json"), "w"), indent=1)
    print("done", img.shape, img.reshape(-1, 4).mean(0))


if __name__ == "__main__":
    main()
