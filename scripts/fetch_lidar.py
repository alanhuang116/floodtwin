"""Download USGS 3DEP lidar points (public domain) for the domain from the
Entwine Point Tile archive on AWS (s3://usgs-lidar-public), to roughly 1.2 m
point spacing.

Runs in the project venv (laspy + lazrs):
    .venv/Scripts/python.exe scripts/fetch_lidar.py
-> data/raw/lidar_<resource>.npz with x, y (EPSG:26918), z (m), class, return
   number, number of returns.
"""
from __future__ import annotations

import io
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import laspy
import numpy as np
from pyproj import Transformer

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
BASE = "https://s3-us-west-2.amazonaws.com/usgs-lidar-public/"
RESOURCES = ["USGS_Lidar_Point_Cloud_NJ_SdL5_2014_LAS_2015", "NY_NewYorkCity"]
# Domain in EPSG:26918 (see scripts/domain.py), with a 60 m margin.
X0, Y0, X1, Y1 = 580472 - 60, 4509496 - 60, 584528 + 60, 4513208 + 60
MAX_DEPTH = int(os.environ.get("FT_LIDAR_DEPTH", 10))


def get(url, tries=6):
    for k in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "FloodTwin/1.0"}), timeout=120) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            if k == tries - 1:
                raise
            time.sleep(3 * (k + 1))


def run(res):
    ept = json.loads(get(BASE + res + "/ept.json"))
    srs = ept["srs"].get("horizontal") or "3857"
    to_ept = Transformer.from_crs(26918, int(srs), always_xy=True)
    to_utm = Transformer.from_crs(int(srs), 26918, always_xy=True)
    xs, ys = to_ept.transform([X0, X1, X0, X1], [Y0, Y0, Y1, Y1])
    bx0, bx1, by0, by1 = min(xs), max(xs), min(ys), max(ys)
    b = ept["bounds"]
    size0 = b[3] - b[0]

    keys, todo = {}, ["0-0-0-0"]
    while todo:
        hk = todo.pop()
        h = json.loads(get(f"{BASE}{res}/ept-hierarchy/{hk}.json"))
        for k, cnt in h.items():
            d, x, y, z = map(int, k.split("-"))
            if d > MAX_DEPTH:
                continue
            s = size0 / 2 ** d
            nx0, ny0 = b[0] + x * s, b[1] + y * s
            if nx0 > bx1 or nx0 + s < bx0 or ny0 > by1 or ny0 + s < by0:
                continue
            if cnt == -1:
                todo.append(k)
            elif cnt > 0:
                keys[k] = cnt
    print(f"{res}: {len(keys)} nodes to depth {MAX_DEPTH}, {sum(keys.values()):,} points in them", flush=True)

    def load(k):
        las = laspy.read(io.BytesIO(get(f"{BASE}{res}/ept-data/{k}.laz")))
        x, y = np.asarray(las.x), np.asarray(las.y)
        m = (x >= bx0) & (x <= bx1) & (y >= by0) & (y <= by1)
        return (x[m], y[m], np.asarray(las.z)[m].astype(np.float32), np.asarray(las.classification)[m].astype(np.uint8),
                np.asarray(las.return_number)[m].astype(np.uint8), np.asarray(las.number_of_returns)[m].astype(np.uint8))

    parts, done = [], 0
    with ThreadPoolExecutor(max_workers=12) as ex:
        for r in ex.map(load, list(keys)):
            parts.append(r)
            done += 1
            if done % 200 == 0:
                print(f"   {done}/{len(keys)}", flush=True)
    x = np.concatenate([p[0] for p in parts]); y = np.concatenate([p[1] for p in parts])
    ux, uy = to_utm.transform(x, y)
    m = (ux >= X0) & (ux <= X1) & (uy >= Y0) & (uy <= Y1)
    out = os.path.join(ROOT, "data", "raw", f"lidar_{res.split('_')[0] if res.startswith('NY') else 'NJ'}.npz")
    np.savez_compressed(out, x=ux[m].astype(np.float64), y=uy[m].astype(np.float64),
                        z=np.concatenate([p[2] for p in parts])[m], cls=np.concatenate([p[3] for p in parts])[m],
                        rn=np.concatenate([p[4] for p in parts])[m], nr=np.concatenate([p[5] for p in parts])[m])
    print(f"{res}: saved {int(m.sum()):,} points -> {out}", flush=True)


if __name__ == "__main__":
    for r in RESOURCES:
        run(r)
