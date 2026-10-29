"""GPU solver (web/js/solver.js in headless Edge) against the reference solver
(sim/solver.py) on a case with terrain, buildings, a boundary at storm stage,
wetting and drying, rain and drainage.

    python tests/gpu_parity.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
from browser import run_page  # noqa: E402
from sim.solver import BUILDING, LAND, SEA, Grid, State, stable_dt, step  # noqa: E402


def make_case(nx=96, ny=72, dx=4.0, steps=400, seed=3):
    rng = np.random.default_rng(seed)
    x = np.linspace(0, 1, nx)[None, :]
    y = np.linspace(0, 1, ny)[:, None]
    z = (0.6 + 1.6 * x + 0.4 * np.sin(6 * y) + 0.25 * rng.standard_normal((ny, nx))).astype(np.float32)
    z[:, :8] = -0.65                                   # boundary water on the west
    kind = np.full((ny, nx), LAND, np.uint8)
    kind[:, :8] = SEA
    for _ in range(14):                               # building blocks
        i, j = rng.integers(14, nx - 8), rng.integers(4, ny - 8)
        kind[j:j + rng.integers(2, 6), i:i + rng.integers(2, 7)] = BUILDING
    n = np.where(rng.random((ny, nx)) < 0.3, 0.035, 0.016).astype(np.float32)
    loss = np.where(kind == LAND, 10e-3 / 3600, 0).astype(np.float32)
    h0 = np.where((kind == LAND) & (rng.random((ny, nx)) < 0.15), rng.uniform(0, 0.5, (ny, nx)), 0).astype(np.float32)
    g = Grid(z, n, kind, dx, loss)
    s = State(g)
    s.h = h0.copy()
    stage, rain = 1.7, 60e-3 / 3600
    params = {"theta": 0.8, "frMax": 1.0, "hDry": 1e-3}
    dts = []
    for _ in range(steps):
        dt = stable_dt(g, s, stage=stage, dt_max=1.5)
        dts.append(dt)
        step(g, s, dt, stage=stage, rain=rain, theta=0.8, fr_max=1.0, h_dry=1e-3)
    case = {"nx": nx, "ny": ny, "dx": dx, "z": z.ravel().tolist(), "n": n.ravel().tolist(),
            "kind": kind.ravel().astype(int).tolist(), "loss": loss.ravel().tolist(),
            "h0": h0.ravel().tolist(), "stage": stage, "rain": rain, "params": params, "dts": dts}
    return case, s, g


def main():
    case, ref, g = make_case()
    json.dump(case, open(os.path.join(HERE, "parity_case.json"), "w"))
    res = run_page("tests/gpu_parity.html", budget_ms=60000)
    if not res.get("ok"):
        raise SystemExit("GPU run failed: " + res.get("error", "?"))
    shape = (case["ny"], case["nx"])
    h = np.array(res["h"], np.float32).reshape(shape)
    qx = np.array(res["qx"], np.float32).reshape(shape)
    qy = np.array(res["qy"], np.float32).reshape(shape)
    wet = ref.h > 0.01
    dh = np.abs(h - ref.h)
    dq = max(np.abs(qx - ref.qx).max(), np.abs(qy - ref.qy).max())
    vol_ref = float(ref.h[g.kind != SEA].sum()); vol_gpu = float(h[g.kind != SEA].sum())
    print(f"steps {len(case['dts'])}, simulated {sum(case['dts']):.0f} s, GPU {res['ms']:.0f} ms ({res['gl']})")
    print(f"wet cells {int(wet.sum())}; max |dh| {dh.max():.2e} m, mean {dh[wet].mean():.2e} m; "
          f"max |dq| {dq:.2e} m2/s; volume ratio {vol_gpu / vol_ref:.7f}")
    os.remove(os.path.join(HERE, "parity_case.json"))
    if dh.max() > 2e-3 or abs(vol_gpu / vol_ref - 1) > 1e-4:
        raise SystemExit("FAIL")
    print("PASS")


if __name__ == "__main__":
    main()
