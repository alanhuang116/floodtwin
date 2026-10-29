// Markers in the scene: USGS high-water marks (observed and simulated levels),
// the probe pin, flood barriers, pumps and the barrier being drawn.
import * as THREE from 'three';

const AMBER = 0xffb547, WHITE = 0xf2f5f7;

export class Markers {
  constructor(data, terrain) {
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.W = W; this.H = H; this.terrain = terrain;
    this.group = new THREE.Group(); this.group.name = 'markers';
    this.scaled = [];       // objects whose size follows the camera distance

    // high-water marks
    this.hwm = new THREE.Group();
    const rodG = new THREE.CylinderGeometry(1, 1, 1, 8); rodG.translate(0, 0.5, 0);
    const discG = new THREE.CylinderGeometry(1, 1, 1, 28);
    const rodM = new THREE.MeshBasicMaterial({ color: 0xd8dde0, transparent: true, opacity: 0.75 });
    const obsM = new THREE.MeshBasicMaterial({ color: AMBER });
    const simM = new THREE.MeshBasicMaterial({ color: WHITE, transparent: true, opacity: 0.92 });
    this.hwmItems = data.events.hwm.map((h) => {
      const g = terrain.heightAt(h.x, h.y);
      const x = h.x - W / 2, z = H / 2 - h.y;
      const rod = new THREE.Mesh(rodG, rodM); rod.position.set(x, g, z);
      const obs = new THREE.Mesh(discG, obsM); obs.position.set(x, h.elev_m, z);
      const sim = new THREE.Mesh(discG, simM); sim.position.set(x, -99, z); sim.visible = false;
      this.hwm.add(rod, obs, sim);
      const item = { h, g, rod, obs, sim, top: Math.max(h.elev_m, g) + 2, world: new THREE.Vector3(x, h.elev_m, z) };
      this.scaled.push({ fn: (s) => {
        const top = Math.max(item.top, (item.simZ ?? -99) + 1.5) + 4 * s;
        rod.scale.set(0.18 * s, top - g, 0.18 * s);
        obs.scale.set(2.2 * s, 0.35 * s, 2.2 * s);
        sim.scale.set(1.6 * s, 0.35 * s, 1.6 * s);
        item.world.y = top;
      }, pos: item.world });
      return item;
    });
    this.group.add(this.hwm);

    // probe
    this.probe = new THREE.Group(); this.probe.visible = false;
    const pr = new THREE.Mesh(rodG, new THREE.MeshBasicMaterial({ color: AMBER }));
    const ph = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: AMBER }));
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.75, 1, 40), new THREE.MeshBasicMaterial({ color: AMBER, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    this.probe.add(pr, ph, ring);
    this.probeParts = { pr, ph, ring };
    this.probeWorld = new THREE.Vector3();
    this.scaled.push({ fn: (s) => {
      if (!this.probe.visible) return;
      const hgt = 10 * s;
      pr.scale.set(0.12 * s, hgt, 0.12 * s);
      ph.scale.setScalar(0.9 * s); ph.position.y = hgt;
      ring.scale.setScalar(3.2 * s);
      this.probeWorld.set(this.probe.position.x, this.probe.position.y + hgt, this.probe.position.z);
    }, pos: this.probeWorld });
    this.group.add(this.probe);

    // defences
    this.wallMat = new THREE.MeshStandardMaterial({ color: 0x8f918d, roughness: 0.85, metalness: 0 });
    this.walls = new THREE.Group();
    this.group.add(this.walls);
    this.pumps = new THREE.Group();
    this.group.add(this.pumps);
    this.draft = new THREE.Group();
    this.group.add(this.draft);
  }

  local(lx, ly, y) { return new THREE.Vector3(lx - this.W / 2, y, this.H / 2 - ly); }

  /** Simulated peak water surface at each high-water mark (m, or <= -90 when dry). */
  setHwmSim(values) {
    this.hwmItems.forEach((it, k) => {
      const v = values?.[k];
      it.simZ = v > -90 ? v : null;
      it.sim.visible = v > -90;
      if (v > -90) it.sim.position.y = v;
    });
  }

  showHwm(on) { this.hwm.visible = on; }

  setProbe(p) {
    if (!p) { this.probe.visible = false; return; }
    this.probe.visible = true;
    this.probe.position.copy(this.local(p.x, p.y, this.terrain.heightAt(p.x, p.y)));
  }

  setProbeWater(wse) {
    const r = this.probeParts.ring;
    r.visible = wse > this.probe.position.y + 0.01;
    r.position.y = wse - this.probe.position.y + 0.05;
  }

  /** Walls for drawn barriers and the waterfront barrier cells of the current grid. */
  setDefences(barriers, grid, waterfront) {
    for (const c of [...this.walls.children]) { c.geometry.dispose(); this.walls.remove(c); }
    for (const b of barriers) {
      for (let k = 0; k + 1 < b.points.length; k++) {
        const [x1, y1] = b.points[k], [x2, y2] = b.points[k + 1];
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 0.5) continue;
        let gmin = 1e9;
        for (let s = 0; s <= 8; s++) gmin = Math.min(gmin, this.terrain.heightAt(x1 + (x2 - x1) * s / 8, y1 + (y2 - y1) * s / 8));
        const hgt = Math.max(0.3, b.crest - gmin + 1);
        const geo = new THREE.BoxGeometry(len, hgt, 0.9);
        const m = new THREE.Mesh(geo, this.wallMat);
        m.position.copy(this.local((x1 + x2) / 2, (y1 + y2) / 2, b.crest - hgt / 2));
        m.rotation.y = Math.atan2(y2 - y1, x2 - x1);
        m.castShadow = true; m.receiveShadow = true;
        this.walls.add(m);
      }
    }
    if (waterfront?.on && grid) {
      const cells = grid.waterfrontCells || [];
      if (cells.length) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const inst = new THREE.InstancedMesh(geo, this.wallMat, cells.length);
        const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
        cells.forEach((c, k) => {
          const i = c % grid.nx, j = Math.floor(c / grid.nx);
          const g = grid.z0[c], hgt = Math.max(0.2, waterfront.crest - g + 0.6);
          p.copy(this.local((i + 0.5) * grid.dx, (j + 0.5) * grid.dx, waterfront.crest - hgt / 2));
          s.set(grid.dx * 0.55, hgt, grid.dx * 0.55);
          m4.compose(p, q, s); inst.setMatrixAt(k, m4);
        });
        inst.castShadow = true; inst.receiveShadow = true;
        this.walls.add(inst);
      }
    }
  }

  setPumps(pumps) {
    for (const c of [...this.pumps.children]) this.pumps.remove(c);
    const geo = new THREE.CylinderGeometry(2.6, 2.6, 3.2, 20);
    const mat = new THREE.MeshStandardMaterial({ color: 0x2f4f63, roughness: 0.6, metalness: 0.2 });
    const cap = new THREE.MeshBasicMaterial({ color: AMBER });
    for (const p of pumps) {
      const g = this.terrain.heightAt(p.x, p.y);
      const m = new THREE.Mesh(geo, mat); m.position.copy(this.local(p.x, p.y, g + 1.6)); m.castShadow = true;
      const c = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 0.3, 20), cap); c.position.copy(this.local(p.x, p.y, g + 3.3));
      this.pumps.add(m, c);
    }
  }

  /** Preview of a barrier being drawn. */
  setDraft(points, crest) {
    for (const c of [...this.draft.children]) { c.geometry?.dispose(); this.draft.remove(c); }
    if (!points.length) return;
    const pts = points.map(([x, y]) => this.local(x, y, Math.max(crest ?? 0, this.terrain.heightAt(x, y)) + 0.6));
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: AMBER, depthTest: false, transparent: true }));
    line.renderOrder = 20;
    this.draft.add(line);
    const dot = new THREE.SphereGeometry(1.4, 12, 8), dm = new THREE.MeshBasicMaterial({ color: AMBER, depthTest: false });
    for (const p of pts) { const s = new THREE.Mesh(dot, dm); s.position.copy(p); s.renderOrder = 21; this.draft.add(s); }
  }

  /** Keep pins a readable size on screen. */
  update(camera) {
    for (const o of this.scaled) {
      const d = camera.position.distanceTo(o.pos);
      o.fn(THREE.MathUtils.clamp(d * 0.0022, 0.5, 14));
    }
  }
}
