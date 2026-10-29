"""Run a scenario headlessly on the GPU and report validation numbers.

    python tests/run_scenario.py sandy 4          # preset, cell size (m)
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from browser import run_page  # noqa: E402


def run(preset="sandy", dx=4, extra=""):
    res = run_page(f"tests/run_scenario.html?preset={preset}&dx={dx}{extra}", budget_ms=900000, timeout=3600)
    if not res.get("ok"):
        raise SystemExit("run failed: " + res.get("error", "?"))
    return res


def main():
    preset = sys.argv[1] if len(sys.argv) > 1 else "sandy"
    dx = int(sys.argv[2]) if len(sys.argv) > 2 else 4
    extra = sys.argv[3] if len(sys.argv) > 3 else ""
    r = run(preset, dx, extra)
    print(f"{r['preset']} at {r['dx']} m ({r['nx']} x {r['ny']} cells): {r['steps']:,} steps, {r['simSeconds']/3600:.1f} h simulated "
          f"in {r['runMs']/1000:.1f} s (x{r['speedup']}), prep {r['prepMs']/1000:.1f} s; peak stage {r['peakStage']:.3f} m, "
          f"lowest coast {r['minCoastZ']:.2f} m")
    for t, st, wet, vol in r["series"]:
        print(f"   t={t/3600:5.2f} h  stage {st:6.3f} m  flooded {wet/1e6:6.3f} km2  volume {vol/1e6:7.3f} hm3")
    if r["preset"] == "sandy":
        obs = np.array([h["obs"] for h in r["hwm"]]); sim = np.array([h["sim"] for h in r["hwm"]])
        for h in r["hwm"]:
            print(f"   HWM {h['id']}: observed {h['obs']:.3f} m, simulated {h['sim']:.3f} m, diff {h['sim'] - h['obs']:+.3f}  "
                  f"({h['county']}, {h['type']}, {h['quality'][:9]})")
        ok = sim > 0
        d = sim[ok] - obs[ok]
        print(f"   HWMs wet {ok.sum()}/{len(ok)}; bias {d.mean():+.3f} m, MAE {np.abs(d).mean():.3f} m, RMSE {np.sqrt((d**2).mean()):.3f} m")
    print("   impact:", r["impact"])
    json.dump(r, open(os.path.join(HERE, "..", "data", "processed", f"run_{preset}_{dx}m.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
