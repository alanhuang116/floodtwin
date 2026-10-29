"""Buildings, trees, vehicles and ground occlusion for the browser.

Buildings: OpenStreetMap footprints (and building:parts for detailed towers).
  Roof height = 90th percentile of the lidar normalised surface inside the
  footprint (USGS 3DEP: NJ 2014 west of the Hudson, NYC 2017 east of it);
  OSM height is used when the building is newer than the lidar.
  Attributes from the USACE National Structure Inventory points inside the
  footprint, mapped to a FloodVuln Global archetype.
Trees: lidar canopy peaks where NAIP NDVI shows vegetation.
Vehicles: parked cars along OSM streets (visual scale only, not modelled).
Ground occlusion: horizon-based ambient occlusion of the terrain + buildings.

Outputs in web/data/: buildings.json, trees.json, cars.json, ao_2m.webp,
bldg_2m.bin.gz (building cover fraction 0-255 per 2 m cell, row 0 = south).

    python scripts/build_city.py
"""
from __future__ import annotations

import gzip
import json
import math
import os
import sys
from collections import defaultdict

import numpy as np
from numba import njit, prange
from PIL import Image, ImageDraw
from scipy import ndimage
from shapely.geometry import Polygon, Point, LineString, MultiPolygon
from shapely.ops import unary_union
from shapely.strtree import STRtree

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from domain import grid, to_utm  # noqa: E402

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RAW = os.path.join(ROOT, "data", "raw")
WEB = os.path.join(ROOT, "web", "data")
PROC = os.path.join(ROOT, "data", "processed")
G = grid()
X0, Y0, W, H = G["x0"], G["y0"], G["width_m"], G["height_m"]
SKIP_BUILDING = {"roof", "carport", "construction", "ruins", "no", "bridge"}


# ---------------------------------------------------------------- rasters
def raster_index(x, y, res=1.0):
    c = np.floor((x - X0) / res).astype(np.int64)
    r = np.floor((G["y1"] - y) / res).astype(np.int64)
    return r, c


def dsm_from_lidar(dem1, river1):
    """First-return surface at 1 m (row 0 = north). NJ data west of the river
    centre line, NYC data east of it."""
    rows, cols = dem1.shape
    split = np.zeros(rows, np.float64)
    cc = np.arange(cols)
    for r in range(rows):
        m = river1[r]
        split[r] = X0 + (cc[m].mean() if m.any() else cols * 0.72)
    dsm = np.full(dem1.shape, -np.inf, np.float32)
    for name in ("NJ", "NY"):
        d = np.load(os.path.join(RAW, f"lidar_{name}.npz"))
        keep = (d["rn"] == 1) & np.isin(d["cls"], [1, 2, 10, 17, 18])
        x, y, z = d["x"][keep], d["y"][keep], d["z"][keep]
        r, c = raster_index(x, y)
        ok = (r >= 0) & (r < rows) & (c >= 0) & (c < cols)
        r, c, x, z = r[ok], c[ok], x[ok], z[ok]
        side = (x < split[r]) if name == "NJ" else (x >= split[r])
        r, c, z = r[side], c[side], z[side]
        np.maximum.at(dsm, (r, c), z)
        print(f"  lidar {name}: {side.sum():,} first returns used")
    empty = ~np.isfinite(dsm)
    # fill gaps from the nearest measured cell
    idx = ndimage.distance_transform_edt(empty, return_distances=False, return_indices=True)
    dsm = dsm[tuple(idx)]
    dsm[river1] = dem1[river1]
    return dsm, float(empty.mean())


@njit(parallel=True, cache=True)
def ambient_occlusion(surf, res, ndir, steps, step_m):
    rows, cols = surf.shape
    out = np.ones((rows, cols), np.float32)
    for r in prange(rows):
        for c in range(cols):
            z0 = surf[r, c]
            acc = 0.0
            for k in range(ndir):
                a = 2.0 * math.pi * k / ndir
                dx, dy = math.cos(a), math.sin(a)
                best = 0.0
                for s in range(1, steps + 1):
                    dist = s * step_m
                    cc = int(c + dx * dist / res); rr = int(r + dy * dist / res)
                    if cc < 0 or rr < 0 or cc >= cols or rr >= rows:
                        break
                    t = (surf[rr, cc] - z0) / dist
                    if t > best:
                        best = t
                elev = math.atan(best)
                acc += 1.0 - math.sin(elev)
            out[r, c] = acc / ndir
    return out


# ---------------------------------------------------------------- OSM
def osm_polygons():
    d = json.load(open(os.path.join(RAW, "osm_buildings.json")))["elements"]
    nodes = {e["id"]: (e["lon"], e["lat"]) for e in d if e["type"] == "node"}
    ways = {e["id"]: e for e in d if e["type"] == "way"}

    def ring(node_ids):
        pts = [nodes[n] for n in node_ids if n in nodes]
        if len(pts) < 4:
            return None
        xs, ys = to_utm(np.array([p[0] for p in pts]), np.array([p[1] for p in pts]))
        return list(zip(xs - X0, ys - Y0))

    out, used_in_rel = [], set()
    for e in d:
        if e["type"] != "relation":
            continue
        tags = e.get("tags", {})
        outers, inners = [], []
        for m in e.get("members", []):
            if m["type"] == "way" and m["ref"] in ways:
                (inners if m.get("role") == "inner" else outers).append(ways[m["ref"]]["nodes"])
                used_in_rel.add(m["ref"])
        # join outer way segments into rings
        polys = []
        for o in merge_rings(outers):
            r = ring(o)
            if r:
                polys.append(Polygon(r))
        holes = [Polygon(ring(i)) for i in merge_rings(inners) if ring(i)]
        for p in polys:
            p = p.buffer(0)
            for hpoly in holes:
                if p.contains(hpoly.representative_point()):
                    p = p.difference(hpoly.buffer(0))
            out.append((e["id"], tags, p))
    for w in ways.values():
        tags = w.get("tags")
        if not tags or w["id"] in used_in_rel and not ("building" in tags or "building:part" in tags):
            continue
        if not ("building" in tags or "building:part" in tags):
            continue
        if len(w["nodes"]) < 4 or w["nodes"][0] != w["nodes"][-1]:
            continue
        r = ring(w["nodes"])
        if r:
            out.append((w["id"], tags, Polygon(r).buffer(0)))
    return out


def merge_rings(segs):
    segs = [list(s) for s in segs if len(s) > 1]
    rings = []
    while segs:
        cur = segs.pop(0)
        changed = True
        while cur[0] != cur[-1] and changed:
            changed = False
            for i, s in enumerate(segs):
                if s[0] == cur[-1]:
                    cur += s[1:]; segs.pop(i); changed = True; break
                if s[-1] == cur[-1]:
                    cur += s[::-1][1:]; segs.pop(i); changed = True; break
        if cur[0] == cur[-1]:
            rings.append(cur)
    return rings


def parse_height(v):
    if v is None:
        return None
    s = str(v).strip().lower().replace(",", ".")
    try:
        if s.endswith("ft") or s.endswith("'"):
            return float(s.rstrip("ft'").strip()) * 0.3048
        return float(s.replace("m", "").strip())
    except ValueError:
        return None


# ---------------------------------------------------------------- NSI
FT = 0.3048


def nsi_points():
    f = json.load(open(os.path.join(RAW, "nsi.json")))["features"]
    lon = np.array([p["properties"]["x"] for p in f]); lat = np.array([p["properties"]["y"] for p in f])
    x, y = to_utm(lon, lat)
    return [dict(p["properties"], lx=float(a - X0), ly=float(b - Y0)) for p, a, b in zip(f, x, y)]


def archetype(occ, found, stories):
    o = occ.split("-")[0]
    if o == "RES1":
        if stories >= 2:
            return ("RES.SF.2.BASEMENT", "direct") if found == "B" else ("RES.SF.2.SLAB", "direct")
        return {"S": ("RES.SF.1.SLAB", "direct"), "C": ("RES.SF.1.CRAWL", "direct"),
                "B": ("RES.SF.2.BASEMENT", "proxy"), "P": ("RES.SF.1.ELEV_ENCL", "direct"),
                "I": ("RES.SF.1.ELEV_ENCL", "direct"), "W": ("RES.SF.1.ELEV_ENCL", "proxy")}.get(found, ("RES.SF.1.SLAB", "proxy"))
    if o == "RES2":
        return ("RES.SF.MH.UNK", "direct")
    if o in ("RES3A", "RES3B"):
        return ("RES.MF2_4.2.UNK", "direct" if o == "RES3A" else "proxy")
    if o.startswith("RES3") or o.startswith("RES"):
        return ("RES.MF2_4.2.UNK", "proxy")
    if o in ("COM1", "COM2", "COM4", "COM8"):
        return ("COM.MIXED.1.UNK", "direct" if o in ("COM1", "COM8") else "proxy")
    return ("COM.MIXED.1.UNK", "proxy")


CLASS_NAMES = ["Residential, low-rise", "Residential, mid/high-rise", "Commercial and office",
               "Industrial and utility", "Institutional", "Garage or shed"]


def classify(tags, nsi_occ, height):
    b = (tags.get("building") or tags.get("building:part") or "yes").lower()
    if b in ("shed", "garage", "garages", "hut", "kiosk"):
        return 5
    if b in ("school", "university", "college", "church", "hospital", "civic", "public", "government", "train_station",
             "transportation", "fire_station", "cathedral", "chapel"):
        return 4
    if b in ("industrial", "warehouse", "service", "utility", "manufacture", "parking", "storage_tank"):
        return 3
    if b in ("commercial", "office", "retail", "hotel", "supermarket"):
        return 2
    if nsi_occ:
        o = nsi_occ.split("-")[0]
        if o.startswith("COM"):
            return 2
        if o.startswith("IND"):
            return 3
        if o.startswith(("EDU", "REL", "GOV")):
            return 4
    return 1 if height > 20 else 0


# ---------------------------------------------------------------- main
def main():
    t = np.load(os.path.join(PROC, "terrain.npz"))
    dem1, river1, ndvi1 = t["dem1"], t["river1"], t["ndvi1"]
    rows, cols = dem1.shape
    naip = np.load(os.path.join(RAW, "naip_05m.npy"), mmap_mode="r")

    print("surface model from lidar ...")
    dsm, gap = dsm_from_lidar(dem1, river1)
    ndsm = np.clip(dsm - dem1, -2, 450)
    print(f"  empty 1 m cells filled: {gap:.1%}")

    print("buildings ...")
    polys = osm_polygons()
    bpolys = [(i, tg, p) for i, tg, p in polys if p.is_valid and not p.is_empty and p.area > 4 and
              (tg.get("building") or "").lower() not in SKIP_BUILDING and "building" in tg]
    parts = [(i, tg, p) for i, tg, p in polys if p.is_valid and not p.is_empty and p.area > 2 and
             "building:part" in tg and (tg.get("building:part") or "").lower() not in SKIP_BUILDING]
    # keep footprints that intersect the domain
    dom = Polygon([(0, 0), (W, 0), (W, H), (0, H)])
    bpolys = [(i, tg, p.intersection(dom)) for i, tg, p in bpolys if p.intersects(dom)]
    bpolys = [(i, tg, p) for i, tg, p in bpolys if p.area > 4]
    print(f"  footprints {len(bpolys):,}, parts {len(parts):,}")

    # raster of building ids at 1 m (for lidar statistics) and cover at 0.5 m -> 2 m
    lab = Image.new("I", (cols, rows), 0)
    dr = ImageDraw.Draw(lab)
    cover = Image.new("L", (cols * 2, rows * 2), 0)
    dc = ImageDraw.Draw(cover)
    for k, (_, tg, p) in enumerate(bpolys, start=1):
        for g in (p.geoms if isinstance(p, MultiPolygon) else [p]):
            ext = [(x, H - y) for x, y in g.exterior.coords]
            dr.polygon(ext, fill=k)
            dc.polygon([(2 * x, 2 * y) for x, y in ext], fill=255)
            for hole in g.interiors:
                hh = [(x, H - y) for x, y in hole.coords]
                dr.polygon(hh, fill=0); dc.polygon([(2 * x, 2 * y) for x, y in hh], fill=0)
    lab = np.array(lab, np.int64)
    cov2 = np.array(cover, np.float32).reshape(rows // 2, 4, cols // 2, 4).mean(axis=(1, 3))
    idx = np.arange(1, len(bpolys) + 1)
    flat_lab = lab.ravel()
    order = np.argsort(flat_lab, kind="stable")
    sorted_lab = flat_lab[order]
    starts = np.searchsorted(sorted_lab, idx); ends = np.searchsorted(sorted_lab, idx, side="right")

    nsi = nsi_points()
    tree_idx = STRtree([p for _, _, p in bpolys])
    owner = defaultdict(list)
    for s in nsi:
        pt = Point(s["lx"], s["ly"])
        hits = tree_idx.query(pt, predicate="within")
        if len(hits):
            owner[int(hits[0])].append(s)
        else:
            near = tree_idx.query_nearest(pt, max_distance=12)
            if len(near):
                owner[int(near[0])].append(s)
    print(f"  NSI structures matched: {sum(len(v) for v in owner.values()):,} of {len(nsi):,}")

    naip_full = naip  # 0.5 m, row 0 = north
    out = []
    stats = {"lidar": 0, "osm_height": 0, "levels": 0, "nsi_stories": 0, "default": 0}
    rng = np.random.default_rng(7)
    for k, (oid, tg, p) in enumerate(bpolys):
        cells = order[starts[k]:ends[k]]
        rr, cc = np.divmod(cells, cols)
        osm_h = parse_height(tg.get("height"))
        lev = parse_height(tg.get("building:levels"))
        nsi_list = owner.get(k, [])
        if len(cells) >= 3:
            vals = ndsm[rr, cc]
            lidar_h = float(np.percentile(vals, 90))
            ground = float(np.percentile(dem1[rr, cc], 10))
        else:
            c = p.representative_point()
            r0, c0 = int(H - c.y), int(c.x)
            r0, c0 = min(max(r0, 0), rows - 1), min(max(c0, 0), cols - 1)
            lidar_h = float(ndsm[r0, c0]); ground = float(dem1[r0, c0])
        stories = max([int(s.get("num_story") or 0) for s in nsi_list] or [0])
        if osm_h and (lidar_h < 2.5 or osm_h > lidar_h * 1.5 + 6):
            h, src = osm_h, "osm_height"
        elif lidar_h >= 2.5:
            h, src = lidar_h, "lidar"
        elif lev:
            h, src = lev * 3.2 + 1.0, "levels"
        elif stories:
            h, src = stories * 3.2 + 1.0, "nsi_stories"
        else:
            h, src = 8.0, "default"
        stats[src] += 1
        h = float(np.clip(h, 2.5, 450))
        # roof colour from NAIP (0.5 m) inside the footprint, shrunk 1 m
        inner = p.buffer(-1.0)
        roof = (150, 150, 150)
        if not inner.is_empty and h < 70:
            minx, miny, maxx, maxy = inner.bounds
            c0, c1 = int(max(minx * 2, 0)), int(min(maxx * 2, cols * 2 - 1))
            r0, r1 = int(max((H - maxy) * 2, 0)), int(min((H - miny) * 2, rows * 2 - 1))
            if c1 > c0 and r1 > r0:
                patch = np.asarray(naip_full[r0:r1 + 1, c0:c1 + 1, :3], np.float32)
                roof = tuple(int(v) for v in np.median(patch.reshape(-1, 3), axis=0))
        # attributes
        a = {}
        if nsi_list:
            main = max(nsi_list, key=lambda s: s.get("val_struct") or 0)
            arch, how = archetype(main.get("occtype", "RES1-1SNB"), main.get("found_type", "S"), int(main.get("num_story") or 1))
            a = {"occ": main.get("occtype"), "arch": arch, "map": how, "found": main.get("found_type"),
                 "ffh": round(float(main.get("found_ht") or 0) * FT, 2), "stories": int(main.get("num_story") or 0),
                 "vs": round(sum(float(s.get("val_struct") or 0) for s in nsi_list)),
                 "vc": round(sum(float(s.get("val_cont") or 0) for s in nsi_list)),
                 "units": int(sum(int(s.get("resunits") or 0) for s in nsi_list)),
                 "pn": int(sum(int(s.get("pop2amu65") or 0) + int(s.get("pop2amo65") or 0) for s in nsi_list)),
                 "pd": int(sum(int(s.get("pop2pmu65") or 0) + int(s.get("pop2pmo65") or 0) for s in nsi_list)),
                 "yr": int(main.get("med_yr_blt") or 0), "n": len(nsi_list)}
        cls = classify(tg, a.get("occ"), h)
        cx, cy = p.centroid.x, p.centroid.y
        rings = []
        for g in (p.geoms if isinstance(p, MultiPolygon) else [p]):
            gs = g.simplify(0.25, preserve_topology=True)
            rings.append([list(np.round(np.array(gs.exterior.coords)[:-1], 1).ravel())] +
                         [list(np.round(np.array(hh.coords)[:-1], 1).ravel()) for hh in gs.interiors])
        out.append({"id": oid, "rings": rings, "g": round(ground, 2), "h": round(h, 1), "src": src,
                    "roof": "%02x%02x%02x" % roof, "cls": cls, "name": tg.get("name") or "",
                    "cx": round(cx, 1), "cy": round(cy, 1), "a": a, "area": round(p.area, 1),
                    "side": "NY" if cx > 2900 and cy < H and _is_manhattan(cx, cy, river1) else "NJ"})

    # building parts render instead of their outline
    part_out = []
    if parts:
        pt_tree = STRtree([p for _, _, p in bpolys])
        for oid, tg, p in parts:
            if not p.intersects(dom):
                continue
            hits = pt_tree.query(p.representative_point(), predicate="within")
            if not len(hits):
                continue
            k = int(hits[0])
            top = parse_height(tg.get("height"))
            base = parse_height(tg.get("min_height")) or 0.0
            if top is None:
                lv = parse_height(tg.get("building:levels"))
                top = (lv * 3.2 if lv else out[k]["h"])
            g = p.intersection(dom).simplify(0.25, preserve_topology=True)
            for gg in (g.geoms if isinstance(g, MultiPolygon) else [g]):
                if gg.is_empty or gg.area < 2:
                    continue
                part_out.append({"b": k, "ring": list(np.round(np.array(gg.exterior.coords)[:-1], 1).ravel()),
                                 "min": round(base, 1), "h": round(float(np.clip(top, 1, 460)), 1)})
        has_parts = sorted({q["b"] for q in part_out})
        for k in has_parts:
            out[k]["parts"] = True
    print("  height sources:", stats, "| parts", len(part_out))

    # ---------------- trees from lidar canopy
    print("trees ...")
    bmask = lab > 0
    veg = (ndvi1 > 0.25) & ~bmask & ~river1
    chm = np.where(veg, ndsm, 0).astype(np.float32)
    chm_s = ndimage.gaussian_filter(chm, 1.0)
    peaks = (chm_s == ndimage.maximum_filter(chm_s, size=7)) & (chm_s > 3.5) & veg
    pr, pc = np.nonzero(peaks)
    trees = []
    for r, c in zip(pr, pc):
        hgt = float(chm[max(r - 1, 0):r + 2, max(c - 1, 0):c + 2].max())
        rad = []
        for ang in np.linspace(0, 2 * np.pi, 8, endpoint=False):
            d = 1
            while d < 9:
                rr_, cc_ = int(r + math.sin(ang) * d), int(c + math.cos(ang) * d)
                if rr_ < 0 or cc_ < 0 or rr_ >= rows or cc_ >= cols or chm[rr_, cc_] < 0.45 * hgt:
                    break
                d += 1
            rad.append(d)
        radius = float(np.clip(np.median(rad), 1.5, 8.0))
        patch = np.asarray(naip_full[max(2 * r - 2, 0):2 * r + 3, max(2 * c - 2, 0):2 * c + 3, :3], np.float32).reshape(-1, 3)
        col = np.median(patch, axis=0) if len(patch) else np.array([70, 90, 60])
        trees.append([round(c + 0.5, 1), round(H - r - 0.5, 1), round(float(dem1[r, c]), 2), round(hgt, 1), round(radius, 1),
                      int(col[0]), int(col[1]), int(col[2])])
    print(f"  trees: {len(trees):,}")

    # ---------------- parked cars along streets
    print("vehicles ...")
    rd = json.load(open(os.path.join(RAW, "osm_roads.json")))["elements"]
    rnodes = {e["id"]: (e["lon"], e["lat"]) for e in rd if e["type"] == "node"}
    count = defaultdict(int)
    for e in rd:
        if e["type"] == "way":
            for n in e["nodes"]:
                count[n] += 1
    half = {"primary": 8.0, "secondary": 6.5, "tertiary": 5.5, "residential": 4.6, "unclassified": 4.6}
    cars, crng = [], np.random.default_rng(11)
    palette = [(235, 236, 238), (30, 32, 36), (150, 154, 160), (100, 104, 110), (40, 62, 110), (130, 30, 34), (190, 192, 194), (70, 74, 60)]
    for e in rd:
        if e["type"] != "way":
            continue
        hw = e.get("tags", {}).get("highway")
        if hw not in half or e.get("tags", {}).get("parking:both") == "no":
            continue
        pts = [rnodes[n] for n in e["nodes"] if n in rnodes]
        if len(pts) < 2:
            continue
        xs, ys = to_utm(np.array([q[0] for q in pts]), np.array([q[1] for q in pts]))
        line = LineString(list(zip(xs - X0, ys - Y0)))
        ends = [Point(line.coords[0]), Point(line.coords[-1])]
        L = line.length
        s = 9.0
        while s < L - 9:
            pa, pb = line.interpolate(s - 0.5), line.interpolate(s + 0.5)
            ang = math.atan2(pb.y - pa.y, pb.x - pa.x)
            for side in (-1, 1):
                if crng.random() < 0.28:
                    continue
                off = half[hw] - 1.1
                x = pa.x + 0.5 * (pb.x - pa.x) - side * off * math.sin(ang)
                y = pa.y + 0.5 * (pb.y - pa.y) + side * off * math.cos(ang)
                if not (0 < x < W and 0 < y < H):
                    continue
                r, c = int(H - y), int(x)
                if bmask[r, c] or river1[r, c] or veg[r, c]:
                    continue
                if min(Point(x, y).distance(q) for q in ends) < 10:
                    continue
                col = palette[int(crng.integers(len(palette)))]
                cars.append([round(x, 1), round(y, 1), round(float(dem1[r, c]), 2), round(ang + (math.pi if side < 0 else 0), 2),
                             col[0], col[1], col[2], int(crng.integers(3))])
            s += 5.6 + crng.random() * 1.5
    print(f"  cars: {len(cars):,}")

    # ---------------- ambient occlusion at 2 m
    print("ambient occlusion ...")
    surf1 = dem1.copy()
    hmap = np.zeros(len(bpolys) + 1, np.float32)
    hmap[1:] = [b["h"] for b in out]
    gmap = np.zeros(len(bpolys) + 1, np.float32)
    gmap[1:] = [b["g"] for b in out]
    surf1 = np.where(lab > 0, gmap[lab] + hmap[lab], surf1)
    surf1 = np.maximum(surf1, np.where(veg, dem1 + 0.6 * chm, -1e9))
    surf2 = surf1.reshape(rows // 2, 2, cols // 2, 2).max(axis=(1, 3)).astype(np.float32)
    ao = ambient_occlusion(surf2, 2.0, 16, 12, 2.5)
    ao = np.clip(ao, 0, 1)
    ao8 = (ao * 255).astype(np.uint8)

    def gz(name, a):
        with gzip.open(os.path.join(WEB, name), "wb", compresslevel=9) as fh:
            fh.write(np.ascontiguousarray(a[::-1]).astype(np.uint8).tobytes())
        return os.path.getsize(os.path.join(WEB, name))

    Image.fromarray(ao8, "L").save(os.path.join(WEB, "ao_2m.webp"), quality=88, method=6)   # row 0 = north (image)
    sizes = {"ao_2m.webp": os.path.getsize(os.path.join(WEB, "ao_2m.webp")),
             "bldg_2m.bin.gz": gz("bldg_2m.bin.gz", np.clip(cov2, 0, 255).astype(np.uint8))}

    # ---------------- write
    keys = ["id", "g", "h", "src", "roof", "cls", "name", "cx", "cy", "area", "side"]
    bj = {"count": len(out), "class_names": CLASS_NAMES, "origin": [X0, Y0], "columns": keys,
          "rows": [[b[k] for k in keys] for b in out], "rings": [b["rings"] for b in out],
          "attrs": [b["a"] for b in out], "parts": part_out,
          "has_parts": [k for k, b in enumerate(out) if b.get("parts")]}
    json.dump(bj, open(os.path.join(WEB, "buildings.json"), "w"), separators=(",", ":"))
    json.dump({"columns": ["x", "y", "z", "h", "r", "R", "G", "B"], "rows": trees},
              open(os.path.join(WEB, "trees.json"), "w"), separators=(",", ":"))
    json.dump({"columns": ["x", "y", "z", "heading", "R", "G", "B", "type"], "rows": cars},
              open(os.path.join(WEB, "cars.json"), "w"), separators=(",", ":"))
    for f in ("buildings.json", "trees.json", "cars.json"):
        sizes[f] = os.path.getsize(os.path.join(WEB, f))
    q = {"buildings": len(out), "with_nsi": sum(1 for b in out if b["a"]), "height_sources": stats,
         "parts": len(part_out), "trees": len(trees), "cars": len(cars), "files": sizes,
         "nsi_value_struct_total": sum(b["a"].get("vs", 0) for b in out if b["a"]),
         "residents_night": sum(b["a"].get("pn", 0) for b in out if b["a"]),
         "archetypes": {k: sum(1 for b in out if b["a"].get("arch") == k) for k in sorted({b["a"].get("arch") for b in out if b["a"]})}}
    json.dump(q, open(os.path.join(PROC, "city_meta.json"), "w"), indent=1)
    print(json.dumps(q, indent=1))


def _is_manhattan(cx, cy, river1):
    """True when a point lies east of the river at its latitude."""
    r = int(min(max(H - cy, 0), river1.shape[0] - 1))
    cols = np.nonzero(river1[r])[0]
    return len(cols) > 0 and cx > cols.mean()


if __name__ == "__main__":
    main()
