// render3d.js — real 3D (WebGL) battle view for Fleet Command '99.
//
// Replaces the flat 2D tactical map with a rotatable / pitchable perspective
// scene rendered by three.js (vendored locally at ./vendor/three.module.js,
// so the page stays zero-build and fully offline). The 2D engine in engine.js
// is untouched — this module only *reads* world state and draws it in 3D.
//
// Coordinate mapping: world (x, y)  ->  scene (x, 0, z), i.e. scene Z == world Y
// (so "north"/increasing world-Y points away from a default camera). Y is up.
//
// The module is deliberately defensive: if WebGL is unavailable the constructor
// throws and main.js falls back to the 2D renderer, so nothing else regresses.

import * as THREE from './vendor/three.module.js';
import { getLand } from './terrain.js';
import { ModelLibrary } from './modellib.js';
import { shipModelKey, aircraftModelKey } from './modelmap.js';

const PLAYER_COLOR = 0x4f8fce;
const ENEMY_COLOR = 0xc85a3c;
const SUB_COLOR = 0x35617f;
const HILITE = 0x39d0ff;

// ---------------------------------------------------------------------------
export class Scene3D {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06121f);
    this.scene.fog = new THREE.Fog(0x06121f, 3200, 14000);

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);

    const hemi = new THREE.HemisphereLight(0x9fc4e8, 0x16242e, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(1200, 2400, 800);
    this.scene.add(sun);

    // Camera controller state (spherical around `target`).
    this.target = new THREE.Vector3(2000, 0, 2000); // world centre
    this.azimuth = 0;          // 0 => camera behind target, looking toward -Z (north away)
    this.elevation = 0.62;     // radians above the horizon
    this.distance = 1300;

    this.shipGroup = new THREE.Group();
    this.acGroup = new THREE.Group();
    this.projGroup = new THREE.Group();
    this.scene.add(this.shipGroup, this.acGroup, this.projGroup);

    this.shipMeshes = new Map(); // id -> Group
    this.acMeshes = new Map();   // id -> Group
    this.projPool = [];          // reused projectile meshes

    this._modelLib = new ModelLibrary(); // authentic .j3d models (lazy)
    this._geoCache = new Map();  // ship-class key -> shared geometries
    this._buildStatic(world);

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const w = canvas.clientWidth || window.innerWidth || 900;
    const h = canvas.clientHeight || window.innerHeight || 640;
    this.resize(w, h);
  }

  // --- static world geometry: water, grid, coastline ---
  _buildStatic(world) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(60000, 60000),
      new THREE.MeshBasicMaterial({ color: 0x0b2336, side: THREE.DoubleSide })
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0;
    this.scene.add(water);

    const grid = new THREE.GridHelper(8000, 32, 0x1d4a66, 0x0e2f44);
    grid.position.y = 0.5;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.scene.add(grid);

    // Land polygons (world.land is an array of point-arrays [[{x,y}...]]).
    let polys = [];
    try { polys = getLand() || []; } catch (_) { polys = (world && world.land) || []; }
    const landMat = new THREE.MeshLambertMaterial({ color: 0x1f5a32, side: THREE.DoubleSide });
    const coastMat = new THREE.LineBasicMaterial({ color: 0x49a06a, transparent: true, opacity: 0.9 });
    for (const poly of polys) {
      const pts = Array.isArray(poly) ? poly : (poly && poly.pts) || [];
      if (!pts || pts.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].y);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].y);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2); // lay flat: shape (x, -y) -> scene (x, 0, y)
      const land = new THREE.Mesh(geo, landMat);
      land.position.y = 0.2;
      this.scene.add(land);

      // coastline outline
      const ringPts = pts.map((p) => new THREE.Vector3(p.x, 0.6, p.y));
      ringPts.push(ringPts[0].clone());
      const lgeo = new THREE.BufferGeometry().setFromPoints(ringPts);
      this.scene.add(new THREE.Line(lgeo, coastMat));
    }
  }

  // --- procedural ship mesh sized by its radius (immediate fallback) ---
  _proceduralShip(ship) {
    const r = ship.radius || 30;
    const len = r * 2.6, wid = r * 0.9, h = r * 0.7;
    const group = new THREE.Group();
    const color = ship.isSub ? SUB_COLOR : (ship.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR);
    const mat = new THREE.MeshLambertMaterial({ color });
    group.userData.hullMat = mat;

    const hull = new THREE.Mesh(new THREE.BoxGeometry(wid, h * 0.6, len), mat);
    hull.position.y = h * 0.2;
    group.add(hull);

    // bow wedge (points toward +Z = forward)
    const bow = new THREE.Mesh(new THREE.ConeGeometry(wid * 0.5, len * 0.28, 4), mat);
    bow.rotation.x = Math.PI / 2;
    bow.position.set(0, h * 0.2, len * 0.5 + len * 0.14);
    bow.scale.set(1, 0.6, 1);
    group.add(bow);

    // superstructure
    const sup = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.55, h * 0.9, len * 0.26), mat);
    sup.position.set(0, h * 0.75, -len * 0.08);
    group.add(sup);

    // bridge tower
    const tower = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.32, h * 0.7, len * 0.1), mat);
    tower.position.set(0, h * 1.25, -len * 0.05);
    group.add(tower);
    return group;
  }

  _proceduralAircraft(ac) {
    const r = 14;
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: ac.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR });
    group.userData.hullMat = mat;

    const body = new THREE.Mesh(new THREE.BoxGeometry(r * 0.4, r * 0.4, r * 2.2), mat);
    group.add(body);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, r * 0.18, r * 0.5), mat);
    group.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, r * 0.14, r * 0.4), mat);
    tail.position.z = -r * 0.9;
    group.add(tail);
    return group;
  }

  _makeRing(len, r) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(len * 0.62, Math.max(1, r * 0.12), 8, 32),
      new THREE.MeshBasicMaterial({ color: HILITE, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.8;
    ring.visible = false;
    return ring;
  }

  // Build a container that shows a procedural mesh at once, then swaps in the
  // authentic .j3d model when it finishes loading (async). Keeps the ring and
  // userData.shipId so the per-frame sync code is unchanged.
  _buildShip(ship) {
    const container = new THREE.Group();
    container.userData.shipId = ship.id;

    const proc = this._proceduralShip(ship);
    container.add(proc);
    container.userData.body = proc;
    container.userData.hullMat = proc.userData.hullMat;
    container.userData.isModel = false;

    const ring = this._makeRing((ship.radius || 30) * 2.6, ship.radius || 30);
    container.add(ring);
    container.userData.ring = ring;

    const key = shipModelKey(ship);
    if (key) {
      const len = (ship.radius || 30) * 2.6;
      this._modelLib.getInstance(key, len, ship.side).then((model) => {
        if (!model || !container.parent) return; // disposed already
        container.remove(proc);
        container.add(model);
        container.userData.body = model;
        container.userData.hullMat = null;
        container.userData.isModel = true;
      }).catch(() => {});
    }
    return container;
  }

  _buildAircraft(ac) {
    const container = new THREE.Group();
    container.userData.shipId = ac.id;

    const proc = this._proceduralAircraft(ac);
    container.add(proc);
    container.userData.body = proc;
    container.userData.hullMat = proc.userData.hullMat;
    container.userData.isModel = false;

    const ring = this._makeRing(28, 14);
    ring.position.y = -8.4;
    container.add(ring);
    container.userData.ring = ring;

    const key = aircraftModelKey(ac);
    if (key) {
      this._modelLib.getInstance(key, 32, ac.side).then((model) => {
        if (!model || !container.parent) return;
        container.remove(proc);
        container.add(model);
        container.userData.body = model;
        container.userData.hullMat = null;
        container.userData.isModel = true;
      }).catch(() => {});
    }
    return container;
  }

  // --- per-frame reconciliation of dynamic objects with world state ---
  sync(world) {
    const sel = (world.__selected && world.__selected) || [];

    // ships
    const seenS = new Set();
    for (const s of world.ships) {
      if (!s.alive) continue;
      seenS.add(s.id);
      let m = this.shipMeshes.get(s.id);
      if (!m) {
        m = this._buildShip(s);
        m.userData.shipId = s.id;
        this.shipGroup.add(m);
        this.shipMeshes.set(s.id, m);
      }
      // Submarines are rendered at the surface (y=0) so they are visible above
      // the opaque water plane — otherwise a submerged sub (negative depth) is
      // hidden by the sea and looks "missing" in 3D. Depth is still tracked in
      // the simulation; this is purely a 3D draw-position fix.
      m.position.set(s.pos.x, 0, s.pos.y);
      m.rotation.y = -s.heading;
      m.visible = s.side === 'player' || !!s.detected;
      this._applySelected(m, sel.includes(s.id));
      if (m.userData.ring) m.userData.ring.visible = sel.includes(s.id);
    }
    for (const [id, m] of this.shipMeshes) {
      if (!seenS.has(id)) { this.shipGroup.remove(m); this._disposeGroup(m); this.shipMeshes.delete(id); }
    }

    // aircraft
    const seenA = new Set();
    for (const a of world.aircraft) {
      if (!a.alive) continue;
      seenA.add(a.id);
      let m = this.acMeshes.get(a.id);
      if (!m) {
        m = this._buildAircraft(a);
        m.userData.shipId = a.id;
        this.acGroup.add(m);
        this.acMeshes.set(a.id, m);
      }
      const y = Math.max(3, Math.min(500, a.alt || 60));
      m.position.set(a.pos.x, y, a.pos.y);
      m.rotation.y = -a.heading;
      m.visible = a.side === 'player' || !!a.detected;
      this._applySelected(m, sel.includes(a.id));
      if (m.userData.ring) m.userData.ring.visible = sel.includes(a.id);
    }
    for (const [id, m] of this.acMeshes) {
      if (!seenA.has(id)) { this.acGroup.remove(m); this._disposeGroup(m); this.acMeshes.delete(id); }
    }

    // projectiles (pooled)
    const live = (world.projectiles || []).filter((p) => !p.dead);
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      let m = this.projPool[i];
      if (!m) {
        m = new THREE.Mesh(
          new THREE.SphereGeometry(4, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        this.projGroup.add(m);
        this.projPool[i] = m;
      }
      m.visible = true;
      m.position.set(p.pos.x, 5, p.pos.y);
      m.material.color.setHex(p.side === 'player' ? 0x6fe0ff : 0xff8a5a);
    }
    for (let i = live.length; i < this.projPool.length; i++) this.projPool[i].visible = false;
  }

  _disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); }
    });
  }

  // Toggle the selection glow on whatever body is currently active (procedural or
  // the loaded authentic model).
  _applySelected(container, on) {
    const hex = on ? 0x123a2a : 0x000000;
    const body = container.userData.body;
    if (!body) return;
    body.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.emissive) m.emissive.setHex(hex);
      }
    });
  }

  // --- camera ---
  _updateCamera() {
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.camera.position.set(
      this.target.x + this.distance * ce * sa,
      this.target.y + this.distance * se,
      this.target.z + this.distance * ce * ca
    );
    // Keep the camera above the waterline so aggressive zoom/orbit cannot
    // duck beneath the ocean plane and reveal the underside of land meshes.
    this.camera.position.y = Math.max(this.target.y + 3, this.camera.position.y);
    this.camera.lookAt(this.target);
  }

  pan(dx, dy) {
    const scale = this.distance * 0.0016;
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.target.x -= (ca * dx + sa * dy) * scale;
    this.target.z -= (-sa * dx + ca * dy) * scale;
  }

  orbit(daz, del) {
    this.azimuth += daz * 0.005;
    this.elevation = Math.max(0.08, Math.min(1.45, this.elevation - del * 0.005));
  }

  zoom(factor) {
    this.distance = Math.max(80, Math.min(6000, this.distance * factor));
  }

  reset() {
    this.target.set(2000, 0, 2000);
    this.azimuth = 0; this.elevation = 0.62; this.distance = 1300;
  }

  // Frame the camera on the current live ships so they are centred and fit in
  // view at battle start (the default target/distance can leave them off-screen
  // or tiny). Called once when a 3D view is created; does not fight user pan.
  // Immobile land installations (airfields) are excluded from the fit so a far
  // inland base does not zoom the whole fleet out to nothing.
  frameShips(world) {
    let cx = 0, cy = 0, n = 0, maxR = 0;
    const movers = world.ships.filter((s) => s.alive && !s.immobile);
    const list = movers.length ? movers : world.ships.filter((s) => s.alive);
    for (const s of list) { cx += s.pos.x; cy += s.pos.y; n++; }
    if (!n) return;
    cx /= n; cy /= n;
    for (const s of list) {
      maxR = Math.max(maxR, Math.hypot(s.pos.x - cx, s.pos.y - cy));
    }
    this.target.set(cx, 0, cy);
    this.azimuth = 0;
    this.elevation = 0.72;
    // Tight fit: zoom in enough that even small units (subs) are clearly seen.
    this.distance = Math.max(260, Math.min(2200, maxR * 1.7 + 320));
  }

  // --- picking / unprojection ---
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const pt = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this._seaPlane, pt);
    return hit ? { x: pt.x, y: pt.z } : null;
  }

  pick(clientX, clientY, world) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const targets = [];
    for (const [, m] of this.shipMeshes) if (m.visible) targets.push(m);
    for (const [, m] of this.acMeshes) if (m.visible) targets.push(m);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && o.userData.shipId === undefined) o = o.parent;
      if (o && o.userData.shipId !== undefined) return o.userData.shipId;
    }
    return null;
  }

  render(world) {
    this.sync(world);
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // 2D top-down zoom that matches the 3D view's vertical extent, so the
  // bottom-panel 2D map stays consistent with what the 3D camera sees.
  topDownZoom(viewportHeight) {
    const halfV = this.distance * Math.tan((this.camera.fov * Math.PI / 180) / 2);
    return (viewportHeight / 2) / halfV;
  }

  resize(w, h) {
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this._disposeGroup(this.shipGroup);
    this._disposeGroup(this.acGroup);
    this._disposeGroup(this.projGroup);
    this.shipMeshes.clear();
    this.acMeshes.clear();
    this.projPool.length = 0;
    this.renderer.dispose();
  }
}
