"""The model domain: Hoboken, NJ, the Hudson River and Manhattan's West Side.

All data are projected to NAD83 / UTM zone 18N (EPSG:26918) on one grid whose
origin is a multiple of 8 m, so the 1, 2, 4 and 8 m grids nest exactly.
Elevations are metres above NAVD88.
"""
from __future__ import annotations

import math

from pyproj import Transformer

EPSG = 26918
# Geographic extent requested (degrees): Hoboken with the Palisades to the west,
# Weehawken Cove to the north, Newport (Jersey City) to the south, and the
# Manhattan waterfront from the West Village to Hudson Yards to the east.
LON_W, LON_E = -74.0465, -73.9990
LAT_S, LAT_N = 40.7325, 40.7655

_fwd = Transformer.from_crs(4326, EPSG, always_xy=True)
_inv = Transformer.from_crs(EPSG, 4326, always_xy=True)


def to_utm(lon, lat):
    return _fwd.transform(lon, lat)


def to_lonlat(x, y):
    return _inv.transform(x, y)


def _snap(v, step, up):
    return (math.ceil(v / step) if up else math.floor(v / step)) * step


def grid():
    """Domain corners in UTM, snapped outward to 8 m."""
    xs, ys = zip(*(to_utm(lo, la) for lo in (LON_W, LON_E) for la in (LAT_S, LAT_N)))
    x0, x1 = _snap(min(xs), 8, False), _snap(max(xs), 8, True)
    y0, y1 = _snap(min(ys), 8, False), _snap(max(ys), 8, True)
    return {"epsg": EPSG, "x0": x0, "y0": y0, "x1": x1, "y1": y1,
            "width_m": x1 - x0, "height_m": y1 - y0}


if __name__ == "__main__":
    g = grid()
    print(g, "cells at 4 m:", g["width_m"] // 4, "x", g["height_m"] // 4)
