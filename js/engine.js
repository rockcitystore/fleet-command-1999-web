// Fleet Command '99 — Web Port engine.js
// Game model + simulation + coordinate math. NO DOM. Node-importable.
// Conforms to CONTRACT.md.

import { REAL_PLACEMENTS } from './realdata.js';
import { REAL_SHIP_STATS } from './realstats.js';
import { isPointOnLand, snapToSea } from './terrain.js';

export const WORLD_SIZE = 4000;
export const METERS_PER_UNIT = 92.6; // ~200 nmi across the battlespace
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 8.0;

// ---------------------------------------------------------------------------
// Vec2
// ---------------------------------------------------------------------------
export class Vec2 {
  constructor(x, y) {
    this.x = x;
    this.y = y;
  }
}

export function vec2(x, y) {
  return new Vec2(x, y);
}

export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// ---------------------------------------------------------------------------
// SHIP_STATS
// ---------------------------------------------------------------------------
// Previously hand-tuned values are now replaced by real data reverse-engineered
// from objects.odb / sensors.sdb, compressed to fit the 4000-unit world while
// preserving relative class performance. See realstats.js for source data and
// the spatial-scale caveat.
export const SHIP_STATS = REAL_SHIP_STATS;

// ---------------------------------------------------------------------------
// AIRCRAFT_STATS
// ---------------------------------------------------------------------------
// Air-wing performance, derived from the real types carried by the scenario
// platforms (see REAL_PLACEMENTS). Speeds/altitudes are scaled to the
// 4000-unit world; `maxFuel` is expressed in SECONDS of endurance and is
// consumed 1:1 per simulation second (so a P-3 with maxFuel 240 flies ~4 min
// before the bingo RTB). Missions are the original FC99 vocabulary
// (CAP / ASW / Strike / Intercept / Recon / patrol).
export const AIRCRAFT_STATS = {
  'P-3 Orion':       { display: 'P-3 Orion',       category: 'fixed', maxSpeed: 235, maxAlt: 1400, maxFuel: 260, sensorRange: 900, missions: ['ASW', 'Recon', 'patrol'] },
  'F/A-18 Hornet':   { display: 'F/A-18 Hornet',   category: 'fixed', maxSpeed: 330, maxAlt: 1800, maxFuel: 210, sensorRange: 850, missions: ['CAP', 'Strike', 'Intercept'] },
  'F-14 Tomcat':     { display: 'F-14 Tomcat',     category: 'fixed', maxSpeed: 345, maxAlt: 1900, maxFuel: 220, sensorRange: 900, missions: ['CAP', 'Intercept', 'Strike'] },
  'SH-60F Sea Hawk': { display: 'SH-60F Sea Hawk', category: 'helo',  maxSpeed: 110, maxAlt: 420,  maxFuel: 180, sensorRange: 650, missions: ['ASW', 'Recon', 'patrol'] },
  'SH-60R Sea Hawk': { display: 'SH-60R Sea Hawk', category: 'helo',  maxSpeed: 110, maxAlt: 420,  maxFuel: 180, sensorRange: 650, missions: ['ASW', 'Recon', 'patrol'] },
  'EA-6B Prowler':   { display: 'EA-6B Prowler',   category: 'fixed', maxSpeed: 250, maxAlt: 1500, maxFuel: 230, sensorRange: 800, missions: ['Recon', 'CAP', 'patrol'] },
  'S-3 Viking':      { display: 'S-3 Viking',      category: 'fixed', maxSpeed: 240, maxAlt: 1300, maxFuel: 240, sensorRange: 800, missions: ['ASW', 'Recon', 'patrol'] },
  'ES-3 Viking':     { display: 'ES-3 Viking',     category: 'fixed', maxSpeed: 240, maxAlt: 1300, maxFuel: 240, sensorRange: 800, missions: ['Recon', 'ASW', 'patrol'] },
  'Super Lynx':      { display: 'Super Lynx',      category: 'helo',  maxSpeed: 120, maxAlt: 450,  maxFuel: 170, sensorRange: 600, missions: ['ASW', 'Recon', 'patrol'] },
  '__default':       { display: 'Aircraft',        category: 'fixed', maxSpeed: 240, maxAlt: 1400, maxFuel: 210, sensorRange: 800, missions: ['CAP', 'patrol'] },
};

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------
export function makeCamera() {
  return { zoom: 1.0, center: { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 } };
}

// ---------------------------------------------------------------------------
// RNG (xorshift64) — deterministic, [0,1)
// ---------------------------------------------------------------------------
const MASK64 = (1n << 64n) - 1n;
const TWO64 = Number(1n << 64n);

function rngNext(state) {
  let x = state;
  x ^= (x << 13n) & MASK64;
  x ^= x >> 7n;
  x ^= (x << 17n) & MASK64;
  return x & MASK64;
}

// ---------------------------------------------------------------------------
// World
// ---------------------------------------------------------------------------
export class World {
  constructor(seed = 1) {
    this.ships = [];
    this.aircraft = []; // airborne airframes (parked ones live on their platform)
    this.time = 0;
    this.phase = 'playing';
    this.nextId = 1;
    this.projectiles = [];
    this.scenarioName = '';
    this.seed = seed;
    this._randState = seed >>> 0 === 0 ? 1n : BigInt(seed >>> 0);
    this.camera = makeCamera();
    this.paused = false;
    this.speed = 1;
    this.lastTick = undefined;
    // Combat stays "cold" until the player commits: no side may fire until the
    // player issues an explicit attack order. This prevents the AI from sinking
    // player ships in the opening seconds (e.g. enemy subs already in torpedo
    // range at spawn) and gives the player agency over when the war starts.
    this.combatStarted = false;
  }

  rand() {
    this._randState = rngNext(this._randState);
    return Number(this._randState) / TWO64;
  }

  resetSeed(s) {
    this.seed = s;
    this._randState = s >>> 0 === 0 ? 1n : BigInt(s >>> 0);
  }

  ship(id) {
    return this.ships.find((s) => s.id === id && s.alive);
  }

  // ---- Aircraft ---------------------------------------------------------
  aircraft(id) {
    return this.aircraft.find((a) => a.id === id && a.alive);
  }

  // Register a parked airframe on a platform (called at scenario load).
  addParkedAircraft(platform, type) {
    const st = AIRCRAFT_STATS[type] || AIRCRAFT_STATS.__default;
    const ac = {
      id: this.nextId++,
      type,
      display: st.display,
      category: st.category,
      side: platform.side,
      homeId: platform.id,
      state: 'parked',
    };
    platform.aircraft = platform.aircraft || [];
    platform.aircraft.push(ac);
    return ac;
  }

  // Launch a parked airframe. `mission` is one of CAP/ASW/Strike/Intercept/
  // Recon/patrol; `waypoints` is an optional [{x,y,alt}] chain. With no
  // waypoints a default CAP racetrack is generated around the home platform.
  // Returns the airborne aircraft (also pushed to world.aircraft) or null.
  launchAircraft(platformId, aircraftId, mission, waypoints) {
    const platform = this.ship(platformId);
    if (!platform || !platform.aircraft) return null;
    const idx = platform.aircraft.findIndex((a) => a.id === aircraftId);
    if (idx < 0) return null;
    const parked = platform.aircraft[idx];
    const st = AIRCRAFT_STATS[parked.type] || AIRCRAFT_STATS.__default;
    const airborne = {
      id: parked.id,
      kind: 'aircraft',
      side: parked.side,
      type: parked.type,
      display: parked.display,
      category: parked.category,
      homeId: platformId,
      state: 'airborne',
      pos: { x: platform.pos.x, y: platform.pos.y },
      alt: 0,
      maxAlt: st.maxAlt,
      targetAlt: st.maxAlt * 0.6,
      speed: 0,
      maxSpeed: st.maxSpeed,
      fuel: st.maxFuel,
      maxFuel: st.maxFuel,
      sensorRange: st.sensorRange,
      mission: mission || null,
      order: null,
      heading: 0,
      detected: false,
      alive: true,
      trail: [],
    };
    platform.aircraft.splice(idx, 1);
    let wps = waypoints && waypoints.length
      ? waypoints
      : (() => {
          const r = 350;
          return [
            { x: platform.pos.x + r, y: platform.pos.y, alt: airborne.targetAlt },
            { x: platform.pos.x, y: platform.pos.y + r, alt: airborne.targetAlt },
            { x: platform.pos.x - r, y: platform.pos.y, alt: airborne.targetAlt },
            { x: platform.pos.x, y: platform.pos.y - r, alt: airborne.targetAlt },
          ];
        })();
    airborne.order = {
      kind: 'flyTo',
      waypoints: wps.map((w) => ({
        x: w.x, y: w.y,
        alt: w.alt != null ? w.alt : airborne.targetAlt,
        speed: w.speed != null ? w.speed : airborne.maxSpeed,
      })),
      wpIndex: 0,
      loop: mission === 'patrol' || mission === 'CAP',
    };
    this.aircraft.push(airborne);
    return airborne;
  }

  // Order an airborne aircraft to return and land at its home platform.
  // The actual landing completes in updateAircraft when it reaches home.
  recoverAircraft(aircraftId) {
    const ac = this.aircraft.find((a) => a.id === aircraftId && a.alive);
    if (!ac) return false;
    const home = this.ship(ac.homeId);
    if (!home) return false;
    ac.state = 'rtb';
    ac.mission = null;
    ac.order = {
      kind: 'flyTo',
      waypoints: [{ x: home.pos.x, y: home.pos.y, alt: 0, speed: ac.maxSpeed }],
      wpIndex: 0,
      loop: false,
    };
    return true;
  }

  addShip(side, shipClass, pos, depth) {
    const stat = SHIP_STATS[shipClass];
    const d = depth !== undefined ? depth : stat.defaultDepth;
    const id = this.nextId++;

    // Cosmetic ammo counts for the info panel (deterministic per ship/weapon).
    const weapons = stat.weapons.map((w, idx) => {
      const h = ((id * 37 + idx * 13) ^ 0x9e3779b9) >>> 0;
      let count;
      if (w.type === 'gun') count = 400 + (h % 5601);
      else if (w.type === 'missile') count = 4 + (h % 45);
      else if (w.type === 'torpedo') count = 4 + (h % 21);
      else if (w.type === 'asroc' || w.type === 'depthCharge') count = 8 + (h % 25);
      else count = 10 + (h % 50);
      return { ...w, count };
    });

    const ship = {
      id,
      side,
      shipClass,
      pos: { x: pos.x, y: pos.y },
      heading: 0,
      speed: 0,
      maxSpeed: stat.maxSpeed,
      hp: stat.maxHp,
      maxHp: stat.maxHp,
      depth: d,
      targetDepth: d,
      sensorRange: stat.sensorRange,
      detected: false,
      weapons,
      cooldowns: {},
      targetId: null,
      order: null,
      alive: true,
      radius: stat.radius,
      isSub: stat.isSub,
      immobile: !!stat.immobile,
      aircraft: [], // parked airframes attached to this platform
    };
    this.ships.push(ship);
    return ship;
  }

  issueOrder(order, ids) {
    if (order && order.kind === 'attack') this.combatStarted = true;
    for (const id of ids) {
      const s = this.ships.find((x) => x.id === id);
      if (!s) continue;
      // Immobile installations cannot receive move orders.
      if (order && order.kind === 'moveTo' && s.immobile) continue;
      if (order && order.kind === 'moveTo') {
        // Normalize to a waypoint chain so multi-leg routes (and the legacy
        // single-point form) share one code path. A lone `pos` becomes a
        // one-element waypoint list; an explicit `waypoints` array (with
        // optional per-node `speed`) is preserved as-is. `loop` makes the
        // route patrol (re-arm at the first node) instead of ending.
        const wps = order.waypoints
          ? order.waypoints.map((p) => ({ x: p.x, y: p.y, speed: p.speed }))
          : [{ x: order.pos.x, y: order.pos.y, speed: s.maxSpeed }];
        s.order = { kind: 'moveTo', waypoints: wps, wpIndex: 0, loop: !!order.loop };
      } else {
        s.order = order;
        if (order.kind === 'attack') s.targetId = order.targetId;
        else if (order.kind === 'setDepth') s.targetDepth = order.depth;
      }
    }
  }

  aliveShips(side) {
    return this.ships.filter((s) => s.alive && s.side === side);
  }

  togglePause() {
    this.paused = !this.paused;
  }

  setSpeed(s) {
    this.speed = Math.max(0.25, Math.min(8, s));
  }

  cycleSpeed() {
    this.speed = this.speed >= 4 ? 1 : this.speed * 2;
  }

  zoomBy(f) {
    this.camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.camera.zoom * f));
  }

  resetCamera(size) {
    if (size && size.width > 0 && size.height > 0) {
      fitCameraToWorld(this.camera, size);
    } else {
      this.camera = makeCamera();
    }
  }

  advanceRealtime() {
    if (this.paused) return;
    const now = Date.now();
    let raw = this.lastTick ? (now - this.lastTick) / 1000 : 1 / 60;
    this.lastTick = now;
    if (raw < 0) raw = 0;
    if (raw > 0.05) raw = 0.05;
    const dt = raw * this.speed;
    this.time += dt;
    updateMovement(this, dt);
    updateDetection(this);
    updateWeapons(this, dt);
    updateProjectiles(this, dt);
    updateAircraft(this, dt);
    updateAI(this, dt);
    checkEnd(this);
  }
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------
function scaleFor(size, cam) {
  const base = Math.min(size.width, size.height) / WORLD_SIZE;
  return base * cam.zoom;
}

export function worldToScreen(p, size, cam) {
  const scale = scaleFor(size, cam);
  const cx = size.width / 2 - cam.center.x * scale;
  const cy = size.height / 2 - cam.center.y * scale;
  return { x: cx + p.x * scale, y: cy + p.y * scale };
}

export function screenToWorld(p, size, cam) {
  const scale = scaleFor(size, cam);
  const cx = size.width / 2 - cam.center.x * scale;
  const cy = size.height / 2 - cam.center.y * scale;
  return { x: (p.x - cx) / scale, y: (p.y - cy) / scale };
}

function clampCamera(cam, size) {
  const scale = scaleFor(size, cam);
  const halfW = size.width / (2 * scale);
  const halfH = size.height / (2 * scale);
  if (halfW >= WORLD_SIZE / 2) {
    cam.center.x = WORLD_SIZE / 2;
  } else {
    cam.center.x = Math.max(halfW, Math.min(WORLD_SIZE - halfW, cam.center.x));
  }
  if (halfH >= WORLD_SIZE / 2) {
    cam.center.y = WORLD_SIZE / 2;
  } else {
    cam.center.y = Math.max(halfH, Math.min(WORLD_SIZE - halfH, cam.center.y));
  }
}

// Fit the camera so the world fills the viewport along its longer axis. This
// removes the empty "outside the map" margins on the left/right or top/bottom.
export function fitCameraToWorld(cam, size, margin = 0.02) {
  const base = Math.min(size.width, size.height) / WORLD_SIZE;
  const minZoom = (Math.max(size.width, size.height) / (base * WORLD_SIZE)) * (1 + margin);
  cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, minZoom));
  cam.center.x = WORLD_SIZE / 2;
  cam.center.y = WORLD_SIZE / 2;
  clampCamera(cam, size);
}

export function panCamera(cam, delta, size) {
  const scale = scaleFor(size, cam);
  cam.center.x -= delta.x / scale;
  cam.center.y -= delta.y / scale;
  clampCamera(cam, size);
}

export function zoomCamera(cam, factor, point, size) {
  const wp = screenToWorld(point, size, cam);
  const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, cam.zoom * factor));
  cam.zoom = newZoom;
  const scale = scaleFor(size, cam);
  cam.center.x = (size.width / 2 - point.x) / scale + wp.x;
  cam.center.y = (size.height / 2 - point.y) / scale + wp.y;
  clampCamera(cam, size);
}

export function shipAtScreen(point, size, cam, world) {
  const scale = scaleFor(size, cam);
  let best = undefined;
  let bestDist = Infinity;
  for (const s of world.ships) {
    if (!s.alive) continue;
    const sp = worldToScreen(s.pos, size, cam);
    const d = Math.hypot(sp.x - point.x, sp.y - point.y);
    const tol = Math.max(s.radius * scale, 16);
    if (d <= tol && d < bestDist) {
      bestDist = d;
      best = s;
    }
  }
  return best;
}

export function projectileAtScreen(point, size, cam, world) {
  const scale = scaleFor(size, cam);
  let best = undefined;
  let bestDist = Infinity;
  if (!world.projectiles) return undefined;
  for (const p of world.projectiles) {
    const sp = worldToScreen(p.pos, size, cam);
    const d = Math.hypot(sp.x - point.x, sp.y - point.y);
    const tol = Math.max(10 * scale, 12);
    if (d <= tol && d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  return best;
}

export function aircraftAtScreen(point, size, cam, world) {
  const scale = scaleFor(size, cam);
  let best = undefined;
  let bestDist = Infinity;
  if (!world.aircraft) return undefined;
  for (const a of world.aircraft) {
    if (!a.alive) continue;
    if (a.side === 'enemy' && !a.detected) continue;
    const sp = worldToScreen(a.pos, size, cam);
    const d = Math.hypot(sp.x - point.x, sp.y - point.y);
    const tol = Math.max(10 * scale, 14);
    if (d <= tol && d < bestDist) {
      best = a;
      bestDist = d;
    }
  }
  return best;
}

export function playerShipsInRect(rect, size, cam, world) {
  const out = [];
  for (const s of world.ships) {
    if (!s.alive || s.side !== 'player') continue;
    const sp = worldToScreen(s.pos, size, cam);
    if (sp.x >= rect.x && sp.x <= rect.x + rect.w && sp.y >= rect.y && sp.y <= rect.y + rect.h) {
      out.push(s.id);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------
export function nearestEnemy(ship, world) {
  let best = undefined;
  let bd = Infinity;
  for (const o of world.ships) {
    if (!o.alive || o.side === ship.side) continue;
    const d = distance(ship.pos, o.pos);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

// Resolve the active navigation goal for a unit following a moveTo waypoint
// chain. Mutates `order.wpIndex` to advance along the route as nodes are
// reached. Returns:
//   { goal: {x,y}|null, speed: number, arrived: bool }
// `arrived` is true only when the unit reaches the FINAL waypoint of a
// non-looping route — the caller should then cancel the order (station keep).
// Aircraft reuse this exact helper for their own altitude-aware movement.
export function resolveWaypointGoal(s, order) {
  const wps = order.waypoints;
  if (!wps || !wps.length) return { goal: null, speed: 0, arrived: false };
  const idx = order.wpIndex || 0;
  const wp = wps[idx];
  const d = Math.hypot(s.pos.x - wp.x, s.pos.y - wp.y);
  if (d < 8) {
    const next = idx + 1;
    if (next >= wps.length) {
      if (order.loop) {
        order.wpIndex = 0;
        const w0 = wps[0];
        return { goal: { x: w0.x, y: w0.y }, speed: w0.speed != null ? w0.speed : s.maxSpeed, arrived: false };
      }
      return { goal: null, speed: 0, arrived: true };
    }
    order.wpIndex = next;
    const wn = wps[next];
    return { goal: { x: wn.x, y: wn.y }, speed: wn.speed != null ? wn.speed : s.maxSpeed, arrived: false };
  }
  return { goal: { x: wp.x, y: wp.y }, speed: wp.speed != null ? wp.speed : s.maxSpeed, arrived: false };
}

export function updateMovement(world, dt) {
  const ships = world.ships.filter((s) => s.alive && !s.immobile);
  const prev = new Map();
  for (const s of ships) prev.set(s, { x: s.pos.x, y: s.pos.y });
  for (const s of ships) {
    let goal = null;
    let desired = 0;
    const order = s.order;
    if (order && order.kind === 'attack') {
      const t = world.ship(order.targetId);
      if (t && t.alive) {
        const maxR = Math.max(...s.weapons.map((w) => w.range));
        const standoff = maxR * 0.85;
        const d = distance(s.pos, t.pos) || 1e-9;
        const dir = { x: (t.pos.x - s.pos.x) / d, y: (t.pos.y - s.pos.y) / d };
        goal = { x: t.pos.x - dir.x * standoff, y: t.pos.y - dir.y * standoff };
      }
      desired = s.maxSpeed;
    } else if (order && order.kind === 'moveTo') {
      const res = resolveWaypointGoal(s, order);
      if (res.arrived) {
        s.order = null; // final waypoint reached — hold station
        desired = 0;
      } else {
        goal = res.goal;
        desired = res.speed;
      }
    }

    // depth approach
    if (s.depth < s.targetDepth) s.depth = Math.min(s.targetDepth, s.depth + 30 * dt);
    else if (s.depth > s.targetDepth) s.depth = Math.max(s.targetDepth, s.depth - 20 * dt);

    // speed accel/decel
    if (s.speed < desired) s.speed = Math.min(desired, s.speed + 1.5 * s.maxSpeed * dt);
    else s.speed = Math.max(desired, s.speed - 2 * s.maxSpeed * dt);

    // move toward goal
    if (goal) {
      const d = distance(s.pos, goal);
      const dir = d > 1e-9 ? { x: (goal.x - s.pos.x) / d, y: (goal.y - s.pos.y) / d } : { x: 0, y: 0 };
      if (dir.x !== 0 || dir.y !== 0) s.heading = Math.atan2(dir.y, dir.x);
      s.pos.x += dir.x * s.speed * dt;
      s.pos.y += dir.y * s.speed * dt;
    }
  }

  // separation pass
  for (let i = 0; i < ships.length; i++) {
    for (let j = i + 1; j < ships.length; j++) {
      const a = ships[i];
      const b = ships[j];
      const d = distance(a.pos, b.pos);
      const minD = a.radius + b.radius;
      if (d > 1e-9 && d < minD) {
        const overlap = minD - d;
        const push = 0.5 * overlap;
        const nx = (b.pos.x - a.pos.x) / d;
        const ny = (b.pos.y - a.pos.y) / d;
        a.pos.x -= nx * push;
        a.pos.y -= ny * push;
        b.pos.x += nx * push;
        b.pos.y += ny * push;
      }
    }
  }

  // clamp to world
  for (const s of ships) {
    s.pos.x = Math.max(s.radius, Math.min(WORLD_SIZE - s.radius, s.pos.x));
    s.pos.y = Math.max(s.radius, Math.min(WORLD_SIZE - s.radius, s.pos.y));
  }

  // land collision: ships cannot drive onto land; snap back toward last safe position.
  for (const s of ships) {
    if (isPointOnLand(s.pos.x, s.pos.y)) {
      const safe = snapToSea(s.pos, prev.get(s));
      s.pos.x = safe.x;
      s.pos.y = safe.y;
      s.speed = 0;
    }
  }
}

// Detection is mutual across ALL contacts (ships + airborne aircraft). A
// contact is detected if any opposing, alive contact's sensor reaches it. The
// submarine depth factor only applies to the DETECTOR when it is submerged.
function sensorFactor(o) {
  return o.depth != null && o.depth < 0 ? Math.max(0.3, 1 + o.depth / 300) : 1;
}

export function updateDetection(world) {
  const contacts = [];
  for (const s of world.ships) if (s.alive) contacts.push(s);
  for (const a of world.aircraft) if (a.alive) contacts.push(a);
  for (const c of contacts) {
    let detected = false;
    for (const o of contacts) {
      if (!o.alive || o.side === c.side) continue;
      if (distance(c.pos, o.pos) <= o.sensorRange * sensorFactor(o)) {
        detected = true;
        break;
      }
    }
    c.detected = detected;
  }
}

function projectileSpeed(type) {
  // World units per second, tuned for the 4000-unit battlespace.
  if (type === 'missile') return 800;
  if (type === 'torpedo') return 120;
  if (type === 'gun') return 1500;
  if (type === 'asroc') return 500;
  if (type === 'depthCharge') return 300;
  return 600;
}

function projectileColor(type) {
  if (type === 'missile') return '#ffaa00';
  if (type === 'torpedo') return '#00ff88';
  if (type === 'gun') return '#ffffff';
  if (type === 'asroc') return '#66ccff';
  if (type === 'depthCharge') return '#aaddff';
  return '#ffffff';
}

function spawnProjectile(world, source, target, weapon) {
  const speed = projectileSpeed(weapon.type);
  const maxLifetime = Math.max(3, weapon.range / speed * 1.5);
  const originDist = distance(source.pos, target.pos);
  world.projectiles.push({
    id: world.nextId++,
    type: weapon.type,
    side: source.side,
    sourceId: source.id,
    targetId: target.id,
    pos: { x: source.pos.x, y: source.pos.y },
    speed,
    damage: weapon.damage,
    range: weapon.range,
    originDist,
    realName: weapon.realName,
    maxLifetime,
    lifetime: 0,
    color: projectileColor(weapon.type),
    trail: [{ x: source.pos.x, y: source.pos.y }],
  });
}

export function updateWeapons(world, dt) {
  // Cold war until the player commits: no firing (either side) before the first
  // player attack order. Keeps positioning safe and playable.
  if (!world.combatStarted) return;
  for (const s of world.ships) {
    if (!s.alive) continue;
    for (const w of s.weapons) {
      let cd = s.cooldowns[w.type] || 0;
      cd -= dt;
      if (cd <= 0) {
        cd = 0;
        const target = s.targetId != null ? world.ship(s.targetId) : nearestEnemy(s, world);
        if (target && target.alive) {
          const d = distance(s.pos, target.pos);
          if (d <= w.range && target.depth >= w.minDepth - 5 && target.depth <= w.maxDepth + 5) {
            spawnProjectile(world, s, target, w);
            cd = w.cooldown;
          }
        }
      }
      s.cooldowns[w.type] = cd;
    }
  }
}

export function updateProjectiles(world, dt) {
  const remaining = [];
  for (const p of world.projectiles) {
    p.lifetime += dt;
    if (p.lifetime > p.maxLifetime) continue;

    const target = world.ship(p.targetId);
    if (!target || !target.alive) continue;

    const dx = target.pos.x - p.pos.x;
    const dy = target.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;

    if (d <= step + target.radius) {
      // Impact: accuracy falls with stand-off distance at launch.
      const accuracy = Math.max(0.3, 1 - (p.originDist / Math.max(p.range, 1)) * 0.6);
      if (world.rand() <= accuracy) {
        const dmg = p.damage * (0.8 + 0.4 * world.rand());
        target.hp -= dmg;
        if (target.hp <= 0) target.alive = false;
      }
      continue;
    }

    if (d > 0) {
      p.pos.x += (dx / d) * step;
      p.pos.y += (dy / d) * step;
    }
    p.trail.push({ x: p.pos.x, y: p.pos.y });
    if (p.trail.length > 12) p.trail.shift();
    remaining.push(p);
  }
  world.projectiles = remaining;
}

export function updateAircraft(world, dt) {
  const acs = world.aircraft.filter((a) => a.alive);
  for (const a of acs) {
    // Fuel burn (1 unit/sec). Bingo RTB at 15% remaining; ditch at 0.
    a.fuel -= dt;
    if (a.fuel <= 0) {
      a.fuel = 0;
      a.alive = false;
      a.state = 'lost';
      continue;
    }
    if (a.fuel < a.maxFuel * 0.15 && a.state !== 'rtb' && a.state !== 'recovering') {
      const home = world.ship(a.homeId);
      if (home) {
        a.state = 'rtb';
        a.mission = null;
        a.order = {
          kind: 'flyTo',
          waypoints: [{ x: home.pos.x, y: home.pos.y, alt: 0, speed: a.maxSpeed }],
          wpIndex: 0,
          loop: false,
        };
      }
    }

    // Keep the RTB waypoint glued to a moving home platform.
    if (a.state === 'rtb' && a.order && a.order.waypoints.length) {
      const home = world.ship(a.homeId);
      if (home) {
        a.order.waypoints[0].x = home.pos.x;
        a.order.waypoints[0].y = home.pos.y;
      }
    }

    // Altitude approach (descend toward 0 when recovering).
    const tAlt = a.state === 'rtb' ? 0 : a.targetAlt;
    if (a.alt < tAlt) a.alt = Math.min(tAlt, a.alt + 70 * dt);
    else if (a.alt > tAlt) a.alt = Math.max(tAlt, a.alt - 90 * dt);

    // Transit along the flight plan (reuses the ship waypoint helper).
    let goal = null;
    let desired = 0;
    let arrived = false;
    if (a.order && a.order.kind === 'flyTo') {
      const res = resolveWaypointGoal(a, a.order);
      if (res.arrived) arrived = true;
      else { goal = res.goal; desired = res.speed; }
    }

    // speed accel/decel
    if (a.speed < desired) a.speed = Math.min(desired, a.speed + 2 * a.maxSpeed * dt);
    else a.speed = Math.max(desired, a.speed - 2.5 * a.maxSpeed * dt);

    // move toward goal (x/y only; altitude handled above)
    if (goal) {
      const d = Math.hypot(goal.x - a.pos.x, goal.y - a.pos.y);
      const dir = d > 1e-9 ? { x: (goal.x - a.pos.x) / d, y: (goal.y - a.pos.y) / d } : { x: 0, y: 0 };
      if (dir.x !== 0 || dir.y !== 0) a.heading = Math.atan2(dir.y, dir.x);
      a.pos.x += dir.x * a.speed * dt;
      a.pos.y += dir.y * a.speed * dt;
      a.trail.push({ x: a.pos.x, y: a.pos.y });
      if (a.trail.length > 40) a.trail.shift();
    }

    // Arrival handling
    if (arrived) {
      if (a.state === 'rtb') {
        const home = world.ship(a.homeId);
        if (home) {
          a.state = 'parked';
          a.alt = 0;
          a.fuel = a.maxFuel;
          a.speed = 0;
          a.order = null;
          a.mission = null;
          home.aircraft = home.aircraft || [];
          home.aircraft.push({
            id: a.id, type: a.type, display: a.display,
            category: a.category, side: a.side, homeId: a.homeId, state: 'parked',
          });
          world.aircraft = world.aircraft.filter((x) => x.id !== a.id);
          continue;
        }
      } else {
        // Non-loop route finished (e.g. a Strike run to a fixed point): hold.
        a.order = null;
      }
    }

    // clamp to world
    a.pos.x = Math.max(0, Math.min(WORLD_SIZE, a.pos.x));
    a.pos.y = Math.max(0, Math.min(WORLD_SIZE, a.pos.y));
  }
}

export function updateAI(world, dt) {
  // Enemy air wings launch on patrol once the war has gone hot (throttled).
  if (world.combatStarted) {
    for (const s of world.ships) {
      if (!s.alive || s.side !== 'enemy' || !s.aircraft || !s.aircraft.length) continue;
      if (world.time - (s._lastLaunch != null ? s._lastLaunch : -999) < 4) continue;
      const parked = s.aircraft[0];
      const launched = world.launchAircraft(s.id, parked.id, 'patrol', null);
      if (launched) s._lastLaunch = world.time;
    }
  }
  for (const s of world.ships) {
    if (!s.alive || s.side !== 'enemy') continue;
    const cur = s.targetId != null ? world.ship(s.targetId) : undefined;
    if (!cur || !cur.alive) {
      const t = nearestEnemy(s, world);
      if (t) {
        s.targetId = t.id;
        s.order = { kind: 'attack', targetId: t.id };
      } else {
        s.targetId = null;
      }
    }
    if (s.isSub && s.targetId == null) {
      s.targetDepth = -160;
    }
  }
}

export function checkEnd(world) {
  const p = world.aliveShips('player').length;
  const e = world.aliveShips('enemy').length;
  if (p === 0) world.phase = 'enemyWon';
  else if (e === 0) world.phase = 'playerWon';
  else world.phase = 'playing';
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
// Real mission titles/briefs from the original 1999 Fleet Command .scs files
// (Single07 / Single01 / Single08). The in-game fleets are a balanced
// recreation, not a 1:1 port of the original unit placements.
export const SCENARIOS = [
  { name: 'Wyoming Deploys', brief: 'Help an SSBN start her ballistic missile deterrence patrol.' },
  { name: 'CVBG Norwegian Sea', brief: 'Protect your Carrier from cruise missile attack.' },
  { name: 'Hair Trigger', brief: 'Defend against long-range cruise missile attacks and diesel submarine torpedoes. CVBG deployed in the Eastern Mediterranean.' },
];

export function makeWorld(index) {
  let i = index;
  if (i < 0) i = 0;
  if (i > 2) i = 2;
  const w = new World();
  w.scenarioName = SCENARIOS[i].name;

  const real = REAL_PLACEMENTS && REAL_PLACEMENTS[i];
  if (real && real.length) {
    // 1:1 real unit placements from the original 1999 .scs mission files.
    for (const u of real) {
      const ship = w.addShip(u.side, u.shipClass, { x: u.x, y: u.y }, u.depth);
      ship.name = u.name;
      ship.realSpeed = u.speed || 0;
      ship.heading = 0;
      if (u.speed) ship.speed = Math.min(u.speed, ship.maxSpeed);
      if (u.aircraft && u.aircraft.length) {
        ship.aircraft = [];
        for (const a of u.aircraft) {
          const cnt = a.count || 1;
          for (let i = 0; i < cnt; i++) w.addParkedAircraft(ship, a.type);
        }
      }
    }
    return w;
  }

  // Fallback: balanced recreation if real data is unavailable.
  if (i === 0) {
    // ASW screen vs 1 submerged submarine + 1 destroyer escort.
    w.addShip('player', 'destroyer', { x: 700, y: 1600 });
    w.addShip('player', 'destroyer', { x: 900, y: 2200 });
    w.addShip('player', 'frigate', { x: 600, y: 2600 });
    w.addShip('enemy', 'submarine', { x: 3300, y: 1200 }, -150);
    w.addShip('enemy', 'destroyer', { x: 3100, y: 2000 });
  } else if (i === 1) {
    // Carrier battle group vs strike cruisers + lurking submarine.
    w.addShip('player', 'carrier', { x: 800, y: 1900 });
    w.addShip('player', 'cruiser', { x: 1000, y: 1400 });
    w.addShip('player', 'cruiser', { x: 1000, y: 2400 });
    w.addShip('enemy', 'cruiser', { x: 3200, y: 1500 });
    w.addShip('enemy', 'cruiser', { x: 3300, y: 2300 });
    w.addShip('enemy', 'submarine', { x: 3400, y: 2900 }, -150);
  } else {
    // Convoy: battleship escorted by destroyers vs two submerged submarines.
    w.addShip('player', 'battleship', { x: 800, y: 2000 });
    w.addShip('player', 'destroyer', { x: 1000, y: 1500 });
    w.addShip('player', 'destroyer', { x: 1000, y: 2500 });
    w.addShip('enemy', 'submarine', { x: 3200, y: 1400 }, -150);
    w.addShip('enemy', 'submarine', { x: 3300, y: 2600 }, -150);
  }
  return w;
}

// Custom engagement builder for the MISSION EDITOR.
export function makeCustomWorld(opts = {}) {
  const clampN = (v, lo, hi, d) => {
    v = Number(v);
    if (!Number.isFinite(v)) v = d;
    return Math.max(lo, Math.min(hi, Math.round(v)));
  };
  const playerCount = clampN(opts.playerCount, 1, 6, 3);
  const enemyCount = clampN(opts.enemyCount, 1, 6, 2);
  const theater = opts.theater || 'norwegian';

  const w = new World();
  w.scenarioName = 'Custom Engagement';
  w.isCustom = true;

  const playerPool = ['destroyer', 'frigate', 'cruiser', 'carrier'];
  const enemyPool = ['submarine', 'destroyer', 'cruiser'];
  // Theater just shifts the spawn band so it feels different; same safe classes.
  const yBase = theater === 'med' ? 1600 : 1200;

  for (let i = 0; i < playerCount; i++) {
    const cls = playerPool[Math.floor(w.rand() * playerPool.length)];
    w.addShip('player', cls, { x: 600 + (i % 3) * 260, y: yBase + i * 320 });
  }
  for (let i = 0; i < enemyCount; i++) {
    const cls = enemyPool[Math.floor(w.rand() * enemyPool.length)];
    const depth = cls === 'submarine' ? -150 : 0;
    w.addShip('enemy', cls, { x: 3200 - (i % 3) * 260, y: yBase + i * 320 }, depth);
  }
  return w;
}

// ---------------------------------------------------------------------------
// Module-level RNG (for E.rand() convenience used by tests/UI)
// ---------------------------------------------------------------------------
const _moduleWorld = new World();
_moduleWorld.resetSeed(1);
export function rand() {
  return _moduleWorld.rand();
}
