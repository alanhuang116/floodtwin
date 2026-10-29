"""Analytic and property tests for the reference solver (sim/solver.py).

    python tests/test_solver.py
"""
from __future__ import annotations

import os
import sys

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
from sim.solver import BUILDING, LAND, SEA, Grid, State, stable_dt, step, volume  # noqa: E402


def test_lake_at_rest():
    """Still water over rough terrain with buildings and dry islands stays still."""
    rng = np.random.default_rng(0)
    ny, nx = 60, 80
    z = rng.uniform(0.0, 2.0, (ny, nx)).astype(np.float32)
    kind = np.full((ny, nx), LAND, np.uint8)
    kind[20:30, 30:40] = BUILDING
    g = Grid(z, np.full((ny, nx), 0.03), kind, 4.0)
    s = State(g)
    s.h = np.maximum(np.float32(1.2) - z, 0).astype(np.float32)
    s.h[kind == BUILDING] = 0
    h0 = s.h.copy()
    for _ in range(500):
        step(g, s, stable_dt(g, s))
    assert np.abs(s.h - h0).max() < 1e-5, np.abs(s.h - h0).max()
    assert np.abs(s.qx).max() < 1e-6 and np.abs(s.qy).max() < 1e-6


def test_mass_conservation_with_rain():
    """In a closed basin, stored volume equals rain input exactly."""
    rng = np.random.default_rng(1)
    ny, nx = 50, 70
    z = (rng.uniform(0, 3, (ny, nx)) + np.linspace(0, 4, nx)[None, :]).astype(np.float32)
    kind = np.full((ny, nx), LAND, np.uint8)
    kind[10:20, 10:15] = BUILDING
    g = Grid(z, np.full((ny, nx), 0.02), kind, 2.0)
    s = State(g)
    rain = 80e-3 / 3600  # 80 mm/h
    t = 0.0
    for _ in range(800):
        dt = stable_dt(g, s, dt_max=2.0)
        step(g, s, dt, rain=rain)
        t += dt
    land_area = float((kind == LAND).sum()) * 4.0
    expected = rain * t * land_area
    got = volume(g, s)
    assert abs(got - expected) / expected < 2e-4, (got, expected)
    assert s.h.min() >= 0


def test_normal_depth_on_plane():
    """Rain on a long inclined plane reaches the analytic kinematic steady
    state: q(x) = r x and h = (n q / sqrt(S))^(3/5)."""
    L, dx, S, n, r = 400.0, 2.0, 0.01, 0.03, 50e-3 / 3600
    nx = int(L / dx)
    x = (np.arange(nx) + 1) * dx            # distance to the downstream face of each cell
    z = (S * (L - x + dx / 2)).astype(np.float32)[None, :]
    z = np.concatenate([z, np.full((1, 1), -5.0, np.float32)], axis=1)   # outlet cell
    kind = np.full(z.shape, LAND, np.uint8)
    kind[0, -1] = SEA
    g = Grid(z, np.full(z.shape, n), kind, dx)
    s = State(g)
    t = 0.0
    while t < 6000:
        dt = stable_dt(g, s, stage=-10.0, dt_max=2.0)
        step(g, s, dt, stage=-10.0, rain=r)
        t += dt
    q = s.qx[0, :nx]
    q_exact = r * x
    h_exact = (n * q_exact / np.sqrt(S)) ** 0.6
    sel = slice(nx // 4, nx - 2)           # away from the upstream end and the outlet
    err_q = np.abs(q[sel] - q_exact[sel]) / q_exact[sel]
    hc = s.h[0, :nx]
    # cell-centre depth against normal depth for the discharge at the centre
    err_h =np.abs(hc[sel] - (n * (r * (x[sel] - dx / 2)) / np.sqrt(S)) ** 0.6) / h_exact[sel]
    print(f"   plane: max rel. error discharge {err_q.max():.4f}, depth {err_h.max():.4f}")
    assert err_q.max() < 0.01, err_q.max()
    assert err_h.max() < 0.03, err_h.max()


def test_boundary_inflow_fills_basin_to_stage():
    """A basin connected to a boundary at fixed stage fills to that stage."""
    ny, nx = 30, 40
    z = np.full((ny, nx), 0.5, np.float32)
    z[:, :5] = -1.0
    z[:, 5] = 1.0          # a sill at 1.0 m
    kind = np.full((ny, nx), LAND, np.uint8)
    kind[:, :5] = SEA
    g = Grid(z, np.full((ny, nx), 0.02), kind, 4.0)
    s = State(g)
    for _ in range(4000):
        step(g, s, stable_dt(g, s, stage=1.6), stage=1.6)
    eta = z + s.h
    assert np.abs(eta[:, 8:] - 1.6).max() < 0.01, np.abs(eta[:, 8:] - 1.6).max()


if __name__ == "__main__":
    for k, f in list(globals().items()):
        if k.startswith("test_"):
            f()
            print("ok", k)
