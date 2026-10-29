// Place names and high-water-mark chips, drawn as HTML over the canvas.
import * as THREE from 'three';

export class Labels {
  constructor(host, viewer, data, terrain) {
    this.host = host; this.viewer = viewer;
    const W = data.meta.grid.width_m, H = data.meta.grid.height_m;
    this.pois = data.meta.pois.map(p => {
      const e = document.createElement('div');
      e.className = `poi ${p.kind}`;
      e.textContent = p.name;
      host.appendChild(e);
      const g = p.kind === 'water' ? 2 : terrain.heightAt(p.x, p.y);
      const lift = p.kind === 'place' ? 90 : p.kind === 'water' ? 0 : 28;
      return { p, e, pos: new THREE.Vector3(p.x - W / 2, g + lift, H / 2 - p.y), rank: p.kind === 'place' ? 0 : p.kind === 'water' ? 1 : 2 };
    });
    this.chips = data.events.hwm.map(h => {
      const e = document.createElement('div');
      e.className = 'hwm-chip';
      host.appendChild(e);
      return { h, e };
    });
    this.showPois = true; this.showHwm = true;
  }

  setHwmValues(sim) {
    this.chips.forEach((c, k) => {
      const v = sim?.[k];
      c.e.replaceChildren();
      const b = document.createElement('b'); b.textContent = `HWM ${c.h.id}`;
      const o = document.createElement('span'); o.className = 'obs'; o.textContent = ` ${c.h.elev_m.toFixed(2)}`;
      c.e.append(b, o);
      if (v != null) c.e.append(document.createTextNode(` · Sim ${v.toFixed(2)}`));
      c.e.title = `${c.h.site} (${c.h.quality}). Observed ${c.h.elev_m.toFixed(2)} m NAVD88${v != null ? `, simulated ${v.toFixed(2)} m` : ''}`;
    });
  }

  update(markers) {
    const v = this.viewer, cam = v.camera;
    const placed = [];
    const overlaps = (r) => placed.some(q => r.x < q.x + q.w && r.x + r.w > q.x && r.y < q.y + q.h && r.y + r.h > q.y);
    const dist = cam.position.distanceTo(v.controls.target);
    const items = [];
    if (this.showHwm) markers.hwmItems.forEach((it, k) => {
      if (cam.position.distanceTo(it.world) < 2200) items.push({ e: this.chips[k].e, pos: it.world, rank: -1, always: true });
      else this.chips[k].e.style.display = 'none';
    });
    for (const c of this.chips) if (!this.showHwm) c.e.style.display = 'none';
    for (const p of this.pois) {
      if (!this.showPois) { p.e.style.display = 'none'; continue; }
      items.push({ e: p.e, pos: p.pos, rank: p.rank, kind: p.p.kind });
    }
    items.sort((a, b) => a.rank - b.rank);
    for (const it of items) {
      const s = v.project(it.pos);
      if (!s || s.x < -50 || s.y < -20 || s.x > innerWidth + 50 || s.y > innerHeight + 20) { it.e.style.display = 'none'; continue; }
      const d = cam.position.distanceTo(it.pos);
      // landmarks only when reasonably close; place names fade when very close
      const vis = it.always ? 1 : it.kind === 'place' ? (dist > 900 ? 1 : 0) : (d < 3200 ? 1 : 0);
      if (!vis) { it.e.style.display = 'none'; continue; }
      it.e.style.display = '';
      const w = it.e.offsetWidth || 80, h = it.e.offsetHeight || 16;
      const r = { x: s.x - w / 2, y: s.y - h, w, h };
      if (!it.always && overlaps(r)) { it.e.style.display = 'none'; continue; }
      placed.push(r);
      it.e.style.left = `${s.x}px`; it.e.style.top = `${s.y}px`;
    }
  }
}
