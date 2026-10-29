"""Write web/data/meta.json: grid, coordinate transforms, labels, sources.

    python scripts/build_meta.py
"""
from __future__ import annotations

import json
import os
import sys

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_lonlat, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
WEB = os.path.join(ROOT, "web", "data")
PROC = os.path.join(ROOT, "data", "processed")

# (name, lat, lon, kind)  kind: place | park | landmark | water | district
POIS = [
    ("Hoboken Terminal", 40.73497, -74.02840, "landmark"),
    ("Stevens Institute of Technology", 40.74684, -74.02415, "landmark"),
    ("Pier A Park", 40.73707, -74.02676, "park"),
    ("Church Square Park", 40.74222, -74.03225, "park"),
    ("Hoboken City Hall", 40.73724, -74.03140, "landmark"),
    ("Elysian Park", 40.74861, -74.02553, "park"),
    ("Weehawken Cove", 40.75830, -74.02620, "water"),
    ("Lincoln Harbor", 40.76294, -74.02031, "district"),
    ("Hudson Yards", 40.75336, -74.00120, "district"),
    ("Javits Center", 40.75786, -74.00182, "landmark"),
    ("Little Island", 40.74202, -74.01060, "park"),
    ("Chelsea Piers", 40.74650, -74.00860, "landmark"),
    ("The High Line", 40.74464, -74.00750, "park"),
    ("Intrepid Museum", 40.76465, -74.00079, "landmark"),
    ("Hudson River", 40.74900, -74.01700, "water"),
    ("Hoboken", 40.74450, -74.03550, "place"),
    ("Manhattan", 40.74300, -74.00250, "place"),
    ("Jersey City Heights", 40.74300, -74.04350, "place"),
]


def fit(src_a, src_b, dst):
    """Least-squares quadratic dst = f(a, b)."""
    A = np.stack([np.ones_like(src_a), src_a, src_b, src_a * src_a, src_a * src_b, src_b * src_b], 1)
    c, *_ = np.linalg.lstsq(A, dst, rcond=None)
    err = np.abs(A @ c - dst).max()
    return c.tolist(), float(err)


def main():
    g = grid()
    lx, ly = np.meshgrid(np.linspace(0, g["width_m"], 25), np.linspace(0, g["height_m"], 25))
    lon, lat = to_lonlat(lx.ravel() + g["x0"], ly.ravel() + g["y0"])
    c_lon, e_lon = fit(lx.ravel(), ly.ravel(), np.asarray(lon))
    c_lat, e_lat = fit(lx.ravel(), ly.ravel(), np.asarray(lat))
    c_x, e_x = fit(np.asarray(lon), np.asarray(lat), lx.ravel())
    c_y, e_y = fit(np.asarray(lon), np.asarray(lat), ly.ravel())
    pois = []
    for name, la, lo, kind in POIS:
        x, y = to_utm(lo, la)
        pois.append({"name": name, "x": round(x - g["x0"], 1), "y": round(y - g["y0"], 1), "kind": kind})
    _, ys = to_utm(-74.026, 40.7340)
    _, yn = to_utm(-74.026, 40.7605)
    terrain = json.load(open(os.path.join(PROC, "terrain_meta.json")))
    city = json.load(open(os.path.join(PROC, "city_meta.json")))
    manifest = json.load(open(os.path.join(ROOT, "data", "raw", "manifest.json")))
    dem = json.load(open(os.path.join(ROOT, "data", "raw", "dem_1m.json")))
    naip = json.load(open(os.path.join(ROOT, "data", "raw", "naip_05m.json")))
    meta = {
        "name": "Hoboken, New Jersey and Manhattan West Side",
        "grid": g, "dem_res": 2.0, "dem_cols": terrain["cols2"], "dem_rows": terrain["rows2"],
        "dem_encoding": terrain["dem_encoding"], "vertical_datum": "NAVD88 (m)", "crs": "NAD83 / UTM zone 18N (EPSG:26918)",
        "lonlat_from_local": {"lon": c_lon, "lat": c_lat, "max_err_deg": max(e_lon, e_lat)},
        "local_from_lonlat": {"x": c_x, "y": c_y, "max_err_m": max(e_x, e_y)},
        "pois": pois, "hoboken_waterfront_y": [round(ys - g["y0"], 1), round(yn - g["y0"], 1)],
        "fema_bfe_ft": terrain.get("fema_bfe_ft", {}),
        "city": {k: city[k] for k in ("buildings", "with_nsi", "parts", "trees", "cars", "height_sources",
                                       "nsi_value_struct_total", "residents_night", "archetypes")},
        "sources": [
            {"name": "USGS 3DEP bare-earth elevation, 1 m lidar", "use": "Terrain", "url": dem["source"], "retrieved": dem["retrieved"]},
            {"name": "USGS 3DEP lidar point clouds (NJ 2014, NYC 2017)", "use": "Building heights, tree canopy",
             "url": "https://registry.opendata.aws/usgs-lidar/", "retrieved": manifest.get("osm_buildings.json", {}).get("retrieved")},
            {"name": "USDA NAIP orthoimagery, 0.5 m", "use": "Imagery, vegetation", "url": naip["source"], "retrieved": naip["retrieved"]},
            {"name": "OpenStreetMap contributors (ODbL)", "use": "Building footprints, streets", "url": "https://www.openstreetmap.org/copyright",
             "retrieved": manifest.get("osm_buildings.json", {}).get("retrieved")},
            {"name": "USACE National Structure Inventory", "use": "Building values, occupancy, first-floor height, residents",
             "url": "https://www.hec.usace.army.mil/confluence/nsi", "retrieved": manifest.get("nsi.json", {}).get("retrieved")},
            {"name": "NOAA CO-OPS 8518750 The Battery", "use": "Hurricane Sandy water level", "url": "https://tidesandcurrents.noaa.gov/stationhome.html?id=8518750",
             "retrieved": manifest.get("battery_sandy.json", {}).get("retrieved")},
            {"name": "USGS Short-Term Network, Hurricane Sandy high-water marks", "use": "Validation", "url": "https://stn.wim.usgs.gov/FEV/",
             "retrieved": "2026-10-29"},
            {"name": "NOAA Atlas 14 precipitation frequency", "use": "Design rainfall", "url": "https://hdsc.nws.noaa.gov/pfds/",
             "retrieved": manifest.get("atlas14_hoboken.json", {}).get("retrieved")},
            {"name": "FEMA National Flood Hazard Layer", "use": "Effective flood zones", "url": "https://hazards.fema.gov/femaportal/wps/portal/NFHLWMS",
             "retrieved": manifest.get("fema_zones.json", {}).get("retrieved")},
            {"name": "FloodVuln Global (Entanglix)", "use": "Building damage ratios", "url": "https://alanhuang116.github.io/floodvuln/",
             "retrieved": "2026-10-29"},
        ],
    }
    json.dump(meta, open(os.path.join(WEB, "meta.json"), "w"), indent=1)
    print("meta.json written; transform errors:", e_lon, e_lat, "deg;", e_x, e_y, "m; waterfront y", meta["hoboken_waterfront_y"])


if __name__ == "__main__":
    main()
