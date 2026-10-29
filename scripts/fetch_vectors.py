"""Download the vector and event data for the domain.

  OpenStreetMap (ODbL, (c) OpenStreetMap contributors) via an Overpass mirror:
      buildings, roads, parks and green space, trees, water
  USACE National Structure Inventory (public domain): structures with values,
      occupancy, storeys, foundation type and first-floor height
  NOAA CO-OPS 8518750 The Battery: observed water level (NAVD88, 6 min) for
      Hurricane Sandy, and harmonic tide predictions for synthetic events
  NOAA Atlas 14 point precipitation frequency at Hoboken
  FEMA National Flood Hazard Layer: effective flood zones and base flood elevations
  USGS STN Hurricane Sandy high-water marks (already in data/raw/hwm_sandy.json)

    python scripts/fetch_vectors.py
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import LAT_N, LAT_S, LON_E, LON_W  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
UA = {"User-Agent": "FloodTwin/1.0 (flood simulation demo; github.com/alanhuang116)"}
OVERPASS = "https://overpass.private.coffee/api/interpreter"
MARGIN = 0.002   # degrees, so features crossing the edge are complete


def http(url, data=None, tries=6, timeout=300):
    for k in range(tries):
        try:
            req = urllib.request.Request(url, data=data, headers=UA)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            print("   retry", k + 1, str(e)[:120], flush=True)
            time.sleep(6 * (k + 1))
    raise SystemExit(f"failed: {url[:100]}")


def save(name, obj, src):
    json.dump(obj, open(os.path.join(RAW, name), "w"))
    man = os.path.join(RAW, "manifest.json")
    m = json.load(open(man)) if os.path.exists(man) else {}
    m[name] = {"source": src, "retrieved": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    json.dump(m, open(man, "w"), indent=1)


def overpass(body, name):
    bbox = f"{LAT_S - MARGIN},{LON_W - MARGIN},{LAT_N + MARGIN},{LON_E + MARGIN}"
    q = f"[out:json][timeout:240][bbox:{bbox}];({body});out body;>;out skel qt;"
    d = json.loads(http(OVERPASS, data=urllib.parse.urlencode({"data": q}).encode()))
    print(f"{name}: {len(d['elements']):,} elements", flush=True)
    save(name, d, OVERPASS)


def main():
    overpass('way["building"];relation["building"];way["building:part"];', "osm_buildings.json")
    overpass('way["highway"];', "osm_roads.json")
    overpass('way["leisure"~"park|garden|pitch|playground"];way["landuse"~"grass|park|recreation_ground|cemetery"];'
             'way["natural"~"wood|scrub|grassland|water"];relation["natural"="water"];node["natural"="tree"];',
             "osm_green.json")

    poly = f"{LON_W},{LAT_S},{LON_W},{LAT_N},{LON_E},{LAT_N},{LON_E},{LAT_S},{LON_W},{LAT_S}"
    nsi = json.loads(http("https://nsi.sec.usace.army.mil/nsiapi/structures?bbox=" + poly))
    print("NSI structures:", len(nsi["features"]))
    save("nsi.json", nsi, "https://nsi.sec.usace.army.mil/nsiapi/structures")

    base = ("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?application=floodtwin"
            "&station=8518750&time_zone=gmt&units=metric&format=json&datum=NAVD")
    obs = json.loads(http(base + "&product=water_level&begin_date=20121028&end_date=20121031"))
    pred = json.loads(http(base + "&product=predictions&interval=6&begin_date=20121028&end_date=20121031"))
    print("Battery observed:", len(obs.get("data", [])), "predicted:", len(pred.get("predictions", [])))
    save("battery_sandy.json", {"observed": obs, "predicted": pred}, base)

    a14 = http("https://hdsc.nws.noaa.gov/cgi-bin/hdsc/new/cgi_readH5.py?lat=40.7450&lon=-74.0300"
               "&type=pf&data=depth&units=metric&series=pds").decode("utf-8", "replace")
    save("atlas14_hoboken.json", {"raw": a14}, "https://hdsc.nws.noaa.gov/pfds/")
    print("Atlas 14:", len(a14), "chars")

    nfhl = ("https://hazards.fema.gov/arcgis/rest/services/public/NFHL/MapServer/28/query?"
            + urllib.parse.urlencode({"geometry": f"{LON_W},{LAT_S},{LON_E},{LAT_N}", "geometryType": "esriGeometryEnvelope",
                                      "inSR": 4326, "outSR": 4326, "spatialRel": "esriSpatialRelIntersects",
                                      "outFields": "FLD_ZONE,ZONE_SUBTY,STATIC_BFE,SFHA_TF", "f": "geojson"}))
    z = json.loads(http(nfhl))
    print("FEMA flood zone polygons:", len(z.get("features", [])))
    save("fema_zones.json", z, nfhl.split("?")[0])


if __name__ == "__main__":
    main()
