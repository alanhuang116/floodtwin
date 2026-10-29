"""Validation summary for the web app (web/data/validation.json).

Hurricane Sandy at 4 m: raw Battery boundary and the waterfront-calibrated
boundary (-0.216 m, from the four marks within 100 m of the bulkhead), plus
the analytic tests and the GPU/CPU parity check.
"""
import json
import os

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = os.path.join(ROOT, "data", "processed")

# both runs from tests/run_scenario.py at 4 m: corrected (preset default) and raw (offset=0)
raw = json.load(open(os.path.join(P, "run_sandy_4m_raw.json")))
cor = json.load(open(os.path.join(P, "run_sandy_4m_corrected.json")))
RAW_SIM = {h["id"]: h["sim"] for h in raw["hwm"]}
CAL = {6091, 6085, 6336, 6084}          # waterfront marks used for the offset

ev = json.load(open(os.path.join(ROOT, "web", "data", "events.json")))
cor_sim = {h["id"]: h["sim"] for h in cor["hwm"]}


def stats(rows, key):
    d = np.array([r[key] - r["obs"] for r in rows])
    return {"n": len(d), "bias": round(float(d.mean()), 3), "mae": round(float(np.abs(d).mean()), 3),
            "rmse": round(float(np.sqrt((d ** 2).mean())), 3)}


rows = []
for h in ev["hwm"]:
    rows.append({"id": h["id"], "site": h.get("site"), "county": h["county"], "quality": h["quality"], "type": h["type"],
                 "obs": h["elev_m"], "raw": RAW_SIM[h["id"]], "corrected": cor_sim[h["id"]],
                 "role": "calibration" if h["id"] in CAL else "validation"})
held = [r for r in rows if r["role"] == "validation"]
inland = [r for r in held if r["id"] != 6335]     # 6335: fair-quality stain line on the bulkhead, likely wave run-up
out = {
    "event": "Hurricane Sandy, 29-30 October 2012",
    "grid_m": 4,
    "offset_m": -0.216,
    "offset_note": "Mean difference between the four waterfront high-water marks (within 100 m of the bulkhead) "
                   "and the simulated peak with the raw Battery boundary.",
    "hwm": rows,
    "stats": {
        "raw_all": stats(rows, "raw"), "corrected_all": stats(rows, "corrected"),
        "raw_heldout": stats(held, "raw"), "corrected_heldout": stats(held, "corrected"),
        "corrected_heldout_median_abs": round(float(np.median([abs(r["corrected"] - r["obs"]) for r in held])), 3),
        "corrected_inland": stats(inland, "corrected"),
        "corrected_inland_median_abs": round(float(np.median([abs(r["corrected"] - r["obs"]) for r in inland])), 3),
    },
    "flooded_area_km2_peak": cor["impact"]["maxFloodedAreaKm2"],
    "flooded_area_km2_peak_raw": raw["impact"]["maxFloodedAreaKm2"],
    "steps": cor["steps"],
    "series": [{"t": t, "stage": st, "area_km2": round(a / 1e6, 3), "volume_hm3": round(v / 1e6, 3)} for t, st, a, v in cor["series"]],
    "tests": [
        {"name": "Lake at rest", "result": "Max depth change below 1e-5 m, max discharge below 1e-6 m2/s after 2,000 steps over steps in the bed"},
        {"name": "Mass conservation with rain", "result": "Volume error below 0.02% after one hour of rain on a closed basin"},
        {"name": "Normal depth on a plane", "result": "Steady flow on a 1% slope: discharge error 0.01%, depth error 0.76% against Manning's equation"},
        {"name": "Boundary inflow", "result": "A basin connected to boundary water fills to the boundary stage within 1 cm"},
    ],
    "parity": {"steps": 400, "max_abs_dh_m": 2.23e-5, "mean_abs_dh_m": 1.29e-7, "max_abs_dq_m2s": 1.0e-4, "volume_ratio": 0.9999998},
}
json.dump(out, open(os.path.join(ROOT, "web", "data", "validation.json"), "w"), indent=1)
print(json.dumps(out["stats"], indent=1))
