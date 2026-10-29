"""Reference CPU implementation of the FloodTwin hydraulic solver.

The browser runs the same scheme on the GPU (web/js/solver.js); this module is
the specification. tests/test_solver.py checks it against analytic results,
and tests/gpu_parity.py checks the GPU against it.

Scheme: local inertial approximation of the 2D shallow-water equations
(Bates, Horritt and Fewtrell 2010) with the momentum-diffusion weighting of
de Almeida, Bates, Freer and Souvignet (2012), on a staggered grid:

    h[j, i]   water depth at cell centres (m)
    qx[j, i]  unit discharge across the east face of cell (i, j)  (m^2/s)
    qy[j, i]  unit discharge across the north face of cell (i, j) (m^2/s)

Row j increases northwards, column i eastwards. One time step:

  1. Momentum, for every face with flow depth hf = max(eta_L, eta_R) - max(z_L, z_R):
        q* = theta q + (1 - theta)/2 (q_upstream_face + q_downstream_face)
        q' = (q* - g hf dt (eta_R - eta_L)/dx) / (1 + g dt n^2 |q| / hf^(7/3))
     |q| is the magnitude of the discharge vector at the face (the cross
     component is the mean of the four surrounding cross faces).
     Then two limiters:
        Froude:     |q'| <= Fr_max hf sqrt(g hf)
        positivity: |q'| dt <= h_donor dx / 4   (no cell can lose more than
                    the water it holds, so depths stay non-negative and mass
                    is conserved exactly)
     Faces touching a solid building cell, faces on the domain edge, faces
     between two boundary (sea) cells, and faces with hf < h_dry carry no flow.
  2. Continuity:
        h += dt/dx (qx_west - qx_east + qy_south - qy_north) + dt (rain - loss)
     where loss = min(capacity, available) represents drainage/infiltration.
     Boundary cells take h = max(stage - z, 0) (prescribed water level).

Time step: dt = alpha dx / max(|u| + sqrt(g h)) over active cells, capped.
All arithmetic is float32, as on the GPU.
"""
from __future__ import annotations

import numpy as np

G = np.float32(9.81)
LAND, SEA, BUILDING = 0, 1, 2


class Grid:
    """Static description of the domain at one resolution."""

    def __init__(self, z, n, kind, dx, loss_capacity=None):
        self.z = np.asarray(z, np.float32)
        self.n = np.asarray(n, np.float32)
        self.kind = np.asarray(kind, np.uint8)
        self.dx = np.float32(dx)
        ny, nx = self.z.shape
        self.shape = (ny, nx)
        self.loss = (np.zeros((ny, nx), np.float32) if loss_capacity is None
                     else np.asarray(loss_capacity, np.float32))


class State:
    def __init__(self, grid: Grid):
        self.h = np.zeros(grid.shape, np.float32)
        self.qx = np.zeros(grid.shape, np.float32)
        self.qy = np.zeros(grid.shape, np.float32)
        self.t = 0.0


def _shift(a, di, dj, fill=0.0):
    """Value of the neighbour at (i + di, j + dj); outside the grid -> fill."""
    out = np.full_like(a, fill)
    ny, nx = a.shape
    ys = slice(max(0, -dj), ny - max(0, dj))
    yd = slice(max(0, dj), ny - max(0, -dj))
    xs = slice(max(0, -di), nx - max(0, di))
    xd = slice(max(0, di), nx - max(0, -di))
    out[ys, xs] = a[yd, xd]
    return out


def momentum(grid: Grid, s: State, dt, theta=0.8, fr_max=1.0, h_dry=1e-3):
    """Return the updated face discharges (qx, qy)."""
    dt = np.float32(dt)
    dx = grid.dx
    z, h, kind, n = grid.z, s.h, grid.kind, grid.n
    eta = z + h
    blocked = kind == BUILDING
    sea = kind == SEA

    def face(qn, q_up, q_dn, q_cross, eta_r, z_r, h_r, n_r, blocked_r, sea_r, edge):
        hf = np.maximum(eta, eta_r) - np.maximum(z, z_r)
        qstar = np.float32(theta) * qn + np.float32((1 - theta) * 0.5) * (q_up + q_dn)
        qmag = np.sqrt(qn * qn + q_cross * q_cross)
        nf = np.float32(0.5) * (n + n_r)
        hfs = np.maximum(hf, np.float32(h_dry))
        num = qstar - G * hfs * dt * (eta_r - eta) / dx
        den = np.float32(1.0) + G * dt * nf * nf * qmag / np.power(hfs, np.float32(7.0 / 3.0))
        q = num / den
        qmax_fr = np.float32(fr_max) * hfs * np.sqrt(G * hfs)
        q = np.clip(q, -qmax_fr, qmax_fr)
        # positivity: donor cell cannot lose more than a quarter of its water per face
        h_donor = np.where(q > 0, h, h_r)
        donor_sea = np.where(q > 0, sea, sea_r)
        qlim = np.where(donor_sea, np.float32(np.inf), h_donor * dx / (np.float32(4.0) * dt))
        q = np.clip(q, -qlim, qlim)
        dead = (hf < h_dry) | blocked | blocked_r | (sea & sea_r) | edge
        return np.where(dead, np.float32(0.0), q).astype(np.float32)

    ny, nx = grid.shape
    ii = np.arange(nx)[None, :].repeat(ny, 0)
    jj = np.arange(ny)[:, None].repeat(nx, 1)
    # x faces (east face of each cell)
    qy_cross = np.float32(0.25) * (s.qy + _shift(s.qy, 1, 0) + _shift(s.qy, 0, -1) + _shift(s.qy, 1, -1))
    qx_new = face(s.qx, _shift(s.qx, -1, 0), _shift(s.qx, 1, 0), qy_cross,
                  _shift(eta, 1, 0), _shift(z, 1, 0), _shift(h, 1, 0), _shift(n, 1, 0),
                  _shift(blocked.astype(np.float32), 1, 0) > 0, _shift(sea.astype(np.float32), 1, 0) > 0,
                  ii == nx - 1)
    # y faces (north face of each cell)
    qx_cross = np.float32(0.25) * (s.qx + _shift(s.qx, 0, 1) + _shift(s.qx, -1, 0) + _shift(s.qx, -1, 1))
    qy_new = face(s.qy, _shift(s.qy, 0, -1), _shift(s.qy, 0, 1), qx_cross,
                  _shift(eta, 0, 1), _shift(z, 0, 1), _shift(h, 0, 1), _shift(n, 0, 1),
                  _shift(blocked.astype(np.float32), 0, 1) > 0, _shift(sea.astype(np.float32), 0, 1) > 0,
                  jj == ny - 1)
    return qx_new, qy_new


def continuity(grid: Grid, s: State, qx, qy, dt, stage=0.0, rain=0.0):
    """Return the updated depth. rain and grid.loss are in m/s."""
    dt = np.float32(dt)
    dx = grid.dx
    div = (_shift(qx, -1, 0) - qx + _shift(qy, 0, -1) - qy) / dx
    h = s.h + dt * div + dt * np.float32(rain)
    lost = np.minimum(grid.loss * dt, np.maximum(h, 0))
    h = np.maximum(h - lost, np.float32(0.0))
    h = np.where(grid.kind == SEA, np.maximum(np.float32(stage) - grid.z, np.float32(0.0)), h)
    h = np.where(grid.kind == BUILDING, np.float32(0.0), h)
    return h.astype(np.float32)


def wave_speed(grid: Grid, s: State, stage=0.0):
    """Largest |u| + sqrt(g h) over cells that exchange water, including the
    depth a land cell next to the boundary would have at the boundary stage."""
    h = s.h
    land = grid.kind == LAND
    next_to_sea = land & ((_shift((grid.kind == SEA).astype(np.float32), 1, 0) > 0) |
                          (_shift((grid.kind == SEA).astype(np.float32), -1, 0) > 0) |
                          (_shift((grid.kind == SEA).astype(np.float32), 0, 1) > 0) |
                          (_shift((grid.kind == SEA).astype(np.float32), 0, -1) > 0))
    h_eff = np.where(next_to_sea, np.maximum(h, np.float32(stage) - grid.z), h)
    hs = np.maximum(h, np.float32(1e-3))
    u = np.sqrt(((s.qx + _shift(s.qx, -1, 0)) * 0.5) ** 2 + ((s.qy + _shift(s.qy, 0, -1)) * 0.5) ** 2) / hs
    u = np.where(h > 1e-3, u, 0)
    c = np.where(land, u + np.sqrt(G * np.maximum(h_eff, 0)), 0)
    return float(c.max())


def step(grid: Grid, s: State, dt, stage=0.0, rain=0.0, **kw):
    qx, qy = momentum(grid, s, dt, **kw)
    h = continuity(grid, s, qx, qy, dt, stage=stage, rain=rain)
    s.h, s.qx, s.qy = h, qx, qy
    s.t += float(dt)
    return s


def stable_dt(grid: Grid, s: State, stage=0.0, alpha=0.7, dt_max=5.0):
    c = wave_speed(grid, s, stage)
    return float(min(dt_max, alpha * float(grid.dx) / max(c, 1e-3)))


def volume(grid: Grid, s: State):
    """Water volume on non-boundary cells (m^3)."""
    m = grid.kind != SEA
    return float(s.h[m].astype(np.float64).sum() * float(grid.dx) ** 2)
