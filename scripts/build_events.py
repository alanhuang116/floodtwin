"""Event, validation and vulnerability data for the browser -> web/data/events.json

  - NOAA CO-OPS 8518750 The Battery, observed and predicted water level
    (m NAVD88, 6 min) for 28-31 October 2012 (Hurricane Sandy)
  - USGS STN Hurricane Sandy high-water marks inside the domain
  - NOAA Atlas 14 precipitation frequency estimates at Hoboken (mm)
  - FEMA effective base flood elevations inside the domain
  - FloodVuln Global damage tables (mean, P10, P50, P90 damage ratio against
    depth above the first floor) for every archetype, NJ and NY calibration

    python scripts/build_events.py
"""
from __future__ import annotations

import datetime as dt
import json
import math
import os
import re
import sys

import numpy as np
from scipy.special import betaincinv, expit

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
WEB = os.path.join(ROOT, "web", "data")
FV_MODEL = os.path.join(RAW, "floodvuln_model.json")
DURATIONS = ["5-min", "10-min", "15-min", "30-min", "60-min", "2-hr", "3-hr", "6-hr", "12-hr", "24-hr",
             "2-day", "3-day", "4-day", "7-day", "10-day", "20-day", "30-day", "45-day", "60-day"]
RETURN_PERIODS = [1, 2, 5, 10, 25, 50, 100, 200, 500, 1000]
T0 = dt.datetime(2012, 10, 28, tzinfo=dt.timezone.utc)


def battery():
    d = json.load(open(os.path.join(RAW, "battery_sandy.json")))
    def series(rows, key="v"):
        t, v = [], []
        for r in rows:
            if r.get(key) in (None, ""):
                continue
            ts = dt.datetime.strptime(r["t"], "%Y-%m-%d %H:%M").replace(tzinfo=dt.timezone.utc)
            t.append(round((ts - T0).total_seconds() / 60)); v.append(round(float(r[key]), 3))
        return {"t_min": t, "z": v}
    obs = series(d["observed"]["data"])
    pred = series(d["predicted"]["predictions"])
    k = int(np.argmax(obs["z"]))
    return {"station": "NOAA 8518750 The Battery, NY", "datum": "NAVD88", "units": "m", "t0": T0.isoformat(),
            "observed": obs, "predicted": pred,
            "peak": {"t_min": obs["t_min"][k], "z": obs["z"][k],
                     "time": (T0 + dt.timedelta(minutes=obs["t_min"][k])).isoformat()}}


def hwms(g):
    d = json.load(open(os.path.join(RAW, "hwm_sandy.json")))
    out = []
    for r in d:
        if not r.get("latitude") or r.get("elev_ft") in (None, ""):
            continue
        x, y = to_utm(float(r["longitude"]), float(r["latitude"]))
        if not (g["x0"] + 20 <= x <= g["x1"] - 20 and g["y0"] + 20 <= y <= g["y1"] - 20):
            continue
        out.append({"id": r.get("id"), "x": round(x - g["x0"], 1), "y": round(y - g["y0"], 1),
                    "lat": float(r["latitude"]), "lon": float(r["longitude"]),
                    "elev_m": round(float(r["elev_ft"]) * 0.3048, 3), "elev_ft": float(r["elev_ft"]),
                    "quality": r.get("hwm_quality_name"), "type": r.get("hwm_type_name"),
                    "county": r.get("county_name"), "site": (r.get("site_description") or r.get("location_description") or "")[:140]})
    return out


def atlas14():
    raw = json.load(open(os.path.join(RAW, "atlas14_hoboken.json")))["raw"]
    def grab(name):
        m = re.search(name + r"\s*=\s*(\[\[.*?\]\]);", raw, re.S)
        return [[float(v) for v in row] for row in json.loads(m.group(1).replace("'", '"'))]
    return {"location": "Hoboken, NJ (40.745 N, 74.030 W)", "units": "mm", "series": "partial duration",
            "durations": DURATIONS, "return_periods_yr": RETURN_PERIODS,
            "depth": grab("quantiles"), "upper90": grab("upper"), "lower90": grab("lower")}


# ---- FloodVuln Global damage tables (port of the fitted ZOIB model) ----
def fv_tables():
    m = json.load(open(FV_MODEL))
    knots, width, th = np.array(m["knots"]), m["width"], np.array(m["theta"])
    NK = len(knots); PB = NK + 1
    sp = lambda x: np.where(x > 30, x, np.log1p(np.exp(np.minimum(x, 30))))  # noqa: E731
    depths = np.round(np.arange(-1.5, 5.0001, 0.05), 2)

    def dist(d, off):
        B = expit((d[:, None] - knots[None, :]) / width)
        s0 = (B * sp(th[1:1 + NK])).sum(1); s1 = (B * sp(th[PB + 1:PB + 1 + NK])).sum(1)
        sm = (B * sp(th[2 * PB + 1:2 * PB + 1 + NK])).sum(1)
        dc = np.clip(d, -2, 8)
        p0 = np.clip(expit(th[0] - s0 + off[0]), 1e-6, 1 - 1e-6)
        p1c = np.clip(expit(th[PB] + s1 + off[1]), 1e-6, 1 - 1e-6)
        mu = np.clip(expit(th[2 * PB] + sm + off[2]), 1e-4, 1 - 1e-4)
        phi = np.clip(np.exp(th[3 * PB] + th[3 * PB + 1] * dc + off[3]), 0.6, 400)
        p1 = (1 - p0) * p1c; rest = (1 - p0) * (1 - p1c)
        a, b = mu * phi, (1 - mu) * phi
        def q(p):
            inner = np.clip((p - p0) / rest, 1e-9, 1 - 1e-9)
            v = betaincinv(a, b, inner)
            return np.where(p <= p0, 0.0, np.where(p >= 1 - p1, 1.0, v))
        mean = p1 + rest * mu
        return mean, q(0.1), q(0.5), q(0.9)

    tables = {}
    for A in m["archetypes"]:
        for region in ("NJ", "NY"):
            off = np.array(A["offsets"], float)
            lo = m["locals"].get(f"{A['key']}@{region}")
            if lo:
                off = off + np.array(lo["offsets"], float)
            mean, p10, p50, p90 = dist(depths, off)
            tables[f"{A['key']}@{region}"] = {"n_local": lo["n"] if lo else 0,
                                              "mean": np.round(mean, 4).tolist(), "p10": np.round(p10, 4).tolist(),
                                              "p50": np.round(p50, 4).tolist(), "p90": np.round(p90, 4).tolist()}
    return {"model": "FloodVuln Global", "model_version": m["model_version"], "claims": m["meta"]["n_global"] if "n_global" in m["meta"] else None,
            "depth_m": depths.tolist(), "depth_reference": "water surface minus first-floor elevation",
            "archetypes": {A["key"]: A["label"] for A in m["archetypes"]}, "tables": tables}


def main():
    g = grid()
    tm = json.load(open(os.path.join(ROOT, "data", "processed", "terrain_meta.json")))
    ev = {"battery": battery(), "hwm": hwms(g), "atlas14": atlas14(),
          "fema_bfe_ft": tm.get("fema_bfe_ft", {}), "vulnerability": fv_tables()}
    json.dump(ev, open(os.path.join(WEB, "events.json"), "w"), separators=(",", ":"))
    b = ev["battery"]
    print("Battery peak", b["peak"], "| obs points", len(b["observed"]["z"]))
    print("HWMs in domain:", len(ev["hwm"]), [h["elev_m"] for h in ev["hwm"]])
    a = ev["atlas14"]; print("Atlas14 60-min (mm):", dict(zip(a["return_periods_yr"], a["depth"][4])))
    t = ev["vulnerability"]["tables"]
    i1 = ev["vulnerability"]["depth_m"].index(1.0)
    print("FloodVuln mean DR at 1 m above first floor:", {k: v["mean"][i1] for k, v in t.items() if k.endswith("@NJ")})
    print("events.json", os.path.getsize(os.path.join(WEB, "events.json")) // 1024, "KB")


if __name__ == "__main__":
    main()
