// Fleet Command '99 — Web Port engine.js
// Game model + simulation + coordinate math. NO DOM. Node-importable.
// Conforms to CONTRACT.md.

import { REAL_PLACEMENTS } from './realdata.js';
import { REAL_SHIP_STATS } from './realstats.js';
import { isPointOnLand, snapToSea, snapToLand, setLand } from './terrain.js';
import { buildLandPolygons } from './geo.js';

export const WORLD_SIZE = 4000;
export const METERS_PER_UNIT = 92.6; // ~200 nmi across the battlespace

// Knots -> world units per GAME-second. Tied to METERS_PER_UNIT so that speed
// and the 50-nmi scale bar stay mutually consistent.
//   1 knot = 1 nmi/h = 1852 m / 3600 s; divide by meters-per-unit.
//   => 30 kts traverses 30 nmi in 1 game-hour == 30*0.005555 = 0.1667 u/s_game.
export const KNOTS_TO_UPS = 1852 / 3600 / METERS_PER_UNIT; // ≈ 0.005555 (≈ 1/180)

// Convert a real speed in knots to world units per game-second.
export const ktsToUps = (knots) => knots * KNOTS_TO_UPS;
// Convert internal units-per-game-second back to knots (for HUD readouts).
export const upsToKts = (ups) => ups / KNOTS_TO_UPS;

export const MIN_ZOOM = 0.1; // allows zooming out to frame distant real coastlines
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

// SHIP_STATS carries REAL max speeds in knots (maxSpeedKts). Convert them to
// world units per game-second so movement stays consistent with the scale bar.
for (const key of Object.keys(SHIP_STATS)) {
  const s = SHIP_STATS[key];
  if (s.maxSpeedKts != null) s.maxSpeed = ktsToUps(s.maxSpeedKts);
}

// Game-speed multipliers (time compression) offered in the HUD. Time is
// real-time (see advanceRealtime): ×1 = 1 real second = 1 game second.
// Because ship/aircraft speeds are now REAL knots (see SHIP_STATS /
// AIRCRAFT_STATS), ×1 makes units crawl at true pace — the battle needs a
// high multiplier to be watchable. The engine sub-steps integration so even
// ×200 stays stable (movement/AI/firing don't jump in a single huge step).
export const SPEED_STEPS = [1, 10, 25, 50, 100, 200];

// ---------------------------------------------------------------------------
// AIRCRAFT_STATS
// ---------------------------------------------------------------------------
// Air-wing performance, derived from the real types carried by the scenario
// platforms (see REAL_PLACEMENTS). maxSpeedKts are REAL knots; altitudes are
// realistic ceiling (m). `maxFuel` is REAL endurance expressed in GAME-SECONDS
// (so a P-3 at 6 h = 21600 s can patrol far before the bingo RTB). Because the
// battle runs under time compression, large fuel-second values are expected.
export const AIRCRAFT_STATS = {
  'P-3 Orion':       { display: 'P-3 Orion',       category: 'fixed', maxSpeedKts: 300, maxAlt: 1400, maxFuel: 21600, sensorRange: 900, missions: ['ASW', 'Recon', 'patrol'], weapon: { type: 'torpedo', range: 600, damage: 30, realName: 'Mk46 Torpedo', cooldown: 6 }, ordnance: 4 },
  'F/A-18 Hornet':   { display: 'F/A-18 Hornet',   category: 'fixed', maxSpeedKts: 480, maxAlt: 1800, maxFuel: 10800, sensorRange: 850, missions: ['CAP', 'Strike', 'Intercept'], weapon: { type: 'missile', range: 900, damage: 35, realName: 'AGM-84 Harpoon', cooldown: 6 }, ordnance: 4 },
  'F-14 Tomcat':     { display: 'F-14 Tomcat',     category: 'fixed', maxSpeedKts: 520, maxAlt: 1900, maxFuel: 10800, sensorRange: 900, missions: ['CAP', 'Intercept', 'Strike'], weapon: { type: 'missile', range: 1000, damage: 40, realName: 'AIM-54 Phoenix', cooldown: 6 }, ordnance: 4 },
  'SH-60F Sea Hawk': { display: 'SH-60F Sea Hawk', category: 'helo',  maxSpeedKts: 145, maxAlt: 420,  maxFuel: 10800, sensorRange: 650, missions: ['ASW', 'Recon', 'patrol'], weapon: { type: 'torpedo', range: 500, damage: 28, realName: 'Mk46 Torpedo', cooldown: 6 }, ordnance: 2 },
  'SH-60R Sea Hawk': { display: 'SH-60R Sea Hawk', category: 'helo',  maxSpeedKts: 145, maxAlt: 420,  maxFuel: 10800, sensorRange: 650, missions: ['ASW', 'Recon', 'patrol'], weapon: { type: 'torpedo', range: 500, damage: 28, realName: 'Mk46 Torpedo', cooldown: 6 }, ordnance: 2 },
  'EA-6B Prowler':   { display: 'EA-6B Prowler',   category: 'fixed', maxSpeedKts: 420, maxAlt: 1500, maxFuel: 14400, sensorRange: 800, missions: ['Recon', 'CAP', 'patrol'], weapon: null, ordnance: 0 },
  'S-3 Viking':      { display: 'S-3 Viking',      category: 'fixed', maxSpeedKts: 350, maxAlt: 1300, maxFuel: 14400, sensorRange: 800, missions: ['ASW', 'Recon', 'patrol'], weapon: { type: 'torpedo', range: 600, damage: 30, realName: 'Mk46 Torpedo', cooldown: 6 }, ordnance: 3 },
  'ES-3 Viking':     { display: 'ES-3 Viking',     category: 'fixed', maxSpeedKts: 350, maxAlt: 1300, maxFuel: 14400, sensorRange: 800, missions: ['Recon', 'ASW', 'patrol'], weapon: null, ordnance: 0 },
  'Super Lynx':      { display: 'Super Lynx',      category: 'helo',  maxSpeedKts: 130, maxAlt: 450,  maxFuel: 9000,  sensorRange: 600, missions: ['ASW', 'Recon', 'patrol'], weapon: { type: 'torpedo', range: 450, damage: 26, realName: 'Mk46 Torpedo', cooldown: 6 }, ordnance: 2 },
  '__default':       { display: 'Aircraft',        category: 'fixed', maxSpeedKts: 350, maxAlt: 1400, maxFuel: 14400, sensorRange: 800, missions: ['CAP', 'patrol'], weapon: { type: 'missile', range: 800, damage: 30, realName: 'AGM-84 Harpoon', cooldown: 6 }, ordnance: 3 },
};

// Convert real-knot airframe speeds into world units per game-second.
for (const key of Object.keys(AIRCRAFT_STATS)) {
  const a = AIRCRAFT_STATS[key];
  if (a.maxSpeedKts != null) a.maxSpeed = ktsToUps(a.maxSpeedKts);
}

// Default flight-plan geometry per MISSION, scaled by airframe category. The
// original FC99 lets the player hand-draw routes per mission; this mirrors that
// by giving each mission a sensible default whose SIZE differs for long-range
// fixed-wing aircraft vs short-range helicopters (the original's "range" is an
// endurance limit, so shorter-endurance airframes fly tighter patterns).
// `transit` missions fly a leg OUT from the platform and hold (non-looping);
// the rest orbit a racetrack around the launch point (looping).
const ROUTE_DEFAULTS = {
  CAP:      { fixed: 400, helo: 180 },
  patrol:   { fixed: 350, helo: 160 },
  ASW:      { fixed: 280, helo: 140 },
  Recon:    { fixed: 500, helo: 250, transit: true },
  Strike:   { fixed: 700, helo: 350, transit: true },
  Intercept:{ fixed: 700, helo: 350, transit: true },
};

// Build the default flight plan for a freshly launched (or re-tasked) aircraft.
// `ac` must carry { pos, targetAlt, maxSpeed, type }.
export function makeAircraftOrder(ac, mission) {
  const st = AIRCRAFT_STATS[ac.type] || AIRCRAFT_STATS.__default;
  const def = ROUTE_DEFAULTS[mission] || ROUTE_DEFAULTS.patrol;
  const r = def[st.category] || def.fixed;
  if (def.transit) {
    // Fly a leg outward from the platform and hold there (non-looping).
    const leg = r;
    return {
      kind: 'flyTo',
      waypoints: [
        { x: ac.pos.x + leg, y: ac.pos.y, alt: ac.targetAlt, speed: ac.maxSpeed },
        { x: ac.pos.x + leg * 0.6, y: ac.pos.y + leg * 0.6, alt: ac.targetAlt, speed: ac.maxSpeed },
      ],
      wpIndex: 0,
      loop: false,
    };
  }
  // Racetrack orbit around the launch point.
  return {
    kind: 'flyTo',
    waypoints: [
      { x: ac.pos.x + r, y: ac.pos.y, alt: ac.targetAlt, speed: ac.maxSpeed },
      { x: ac.pos.x, y: ac.pos.y + r, alt: ac.targetAlt, speed: ac.maxSpeed },
      { x: ac.pos.x - r, y: ac.pos.y, alt: ac.targetAlt, speed: ac.maxSpeed },
      { x: ac.pos.x, y: ac.pos.y - r, alt: ac.targetAlt, speed: ac.maxSpeed },
    ],
    wpIndex: 0,
    loop: true,
  };
}

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
    // Default time compression. Ship/aircraft speeds are now REAL knots, so
    // ×1 would crawl; 25x keeps the opening battle watchable out of the box.
    this.speed = 25;
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
      weapon: st.weapon ? { ...st.weapon } : null,
      ordnance: st.ordnance || 0,
      ordnanceMax: st.ordnance || 0,
      _acCd: 0,
      _rtbReason: null,
      mission: mission || null,
      order: null,
      heading: 0,
      detected: false,
      alive: true,
      trail: [],
    };
    platform.aircraft.splice(idx, 1);
    if (waypoints && waypoints.length) {
      airborne.order = {
        kind: 'flyTo',
        waypoints: waypoints.map((w) => ({
          x: w.x, y: w.y,
          alt: w.alt != null ? w.alt : airborne.targetAlt,
          speed: w.speed != null ? w.speed : airborne.maxSpeed,
        })),
        wpIndex: 0,
        loop: mission === 'patrol' || mission === 'CAP',
      };
    } else {
      airborne.order = makeAircraftOrder(airborne, mission);
    }
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
      return { ...w, count, magMax: count };
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

  // Available game-speed multipliers (real-time × N). Exposed in the HUD.
  // Time is real-time: dt = wallClockDelta × speed, so ×1 = 1 real sec = 1
  // game sec, ×20 fast-forwards 20×.
  speedSteps() { return SPEED_STEPS.slice(); }

  setSpeed(s) {
    this.speed = Math.max(0.25, Math.min(SPEED_STEPS[SPEED_STEPS.length - 1], s));
  }

  cycleSpeed() {
    const steps = SPEED_STEPS;
    const i = steps.indexOf(this.speed);
    this.speed = steps[(i + 1) % steps.length];
  }

  zoomBy(f) {
    this.camera.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.camera.zoom * f));
  }

  resetCamera(size) {
    if (size && size.width > 0 && size.height > 0) {
      fitCameraToWorld(this.camera, size, this);
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
    let remaining = raw * this.speed; // real-time × speed
    // Sub-step so a high multiplier (e.g. ×20) integrates as many small steps
    // rather than one huge Euler jump — keeps movement/AI/firing stable.
    const MAX_STEP = 0.05;
    let guard = 0;
    while (remaining > 1e-6 && guard < 512) {
      const step = Math.min(remaining, MAX_STEP);
      this.time += step;
      updateMovement(this, step);
      updateDetection(this);
      updateWeapons(this, step);
      updateProjectiles(this, step);
      updateAircraft(this, step);
      updateAI(this, step);
      checkEnd(this);
      remaining -= step;
      guard++;
    }
  }
}

// ---------------------------------------------------------------------------
// Coordinate helpers
// ---------------------------------------------------------------------------
export function scaleFor(size, cam) {
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

// No hard camera clamp. The tactical map is rendered as an unbounded area
// (infinite grid + coastline extending beyond the scenario box), so the player
// is free to pan and zoom past the nominal [0, WORLD_SIZE] gameplay box.
function clampCamera(cam, size) {}

// Fit the camera so the playable box AND any real coastline (plus the SCS
// nine-dash line) are visible. Like the original FC99, the operational chart
// is framed by geography rather than locked to a fixed 200 nmi box. The camera
// centers on the projection/geo center (WORLD_SIZE/2), which is also where the
// fleets spawn, and zooms out just far enough to bring the nearest coastline
// into view at the map edge.
export function fitCameraToWorld(cam, size, world, margin = 0.12) {
  const cx = WORLD_SIZE / 2;
  const cy = WORLD_SIZE / 2;

  // Farthest land / nine-dash vertex from the center dictates the zoom.
  let maxR = 0;
  if (world) {
    const consider = (pt) => {
      const r = Math.hypot(pt.x - cx, pt.y - cy);
      if (r > maxR) maxR = r;
    };
    if (Array.isArray(world.land)) {
      for (const poly of world.land) for (const p of poly) consider(p);
    }
    if (world.geo && Array.isArray(world.geo.nineDash)) {
      for (const p of world.geo.nineDash) consider(p);
    }
    // Immobile installations (airfields/bases) must also be inside the initial
    // view, otherwise the player sees an airport floating in empty ocean while
    // the real coastline that it snapped to sits off-screen.
    if (Array.isArray(world.ships)) {
      for (const s of world.ships) {
        if (s.immobile) consider(s.pos);
      }
    }
  }

  // Half-extent to display: at least the playable half-box, plus a margin so
  // the coastline isn't jammed against the screen edge.
  const halfExtent = Math.max(WORLD_SIZE / 2, maxR) * (1 + margin);
  // Derived from scaleFor(): a vertex at `halfExtent` world units from center
  // must land within half the (smaller) viewport dimension.
  const fitZoom = WORLD_SIZE / (2 * halfExtent);
  cam.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fitZoom));
  cam.center.x = cx;
  cam.center.y = cy;
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

// Hit-test a waypoint handle of the currently selected aircraft. Returns
// { acId, index } for the nearest waypoint within the grab tolerance, or null.
export function waypointAtScreen(point, size, cam, world) {
  const acId = world.__selectedAircraft && world.__selectedAircraft[0];
  if (!acId) return null;
  const ac = world.aircraft.find((a) => a.id === acId && a.alive);
  if (!ac || !ac.order || ac.order.kind !== 'flyTo') return null;
  const scale = scaleFor(size, cam);
  const tol = Math.max(10 * scale, 12);
  for (let i = 0; i < ac.order.waypoints.length; i++) {
    const sp = worldToScreen(ac.order.waypoints[i], size, cam);
    if (Math.hypot(sp.x - point.x, sp.y - point.y) <= tol) return { acId: ac.id, index: i };
  }
  return null;
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

// Nearest enemy SHIP within `range` of a source unit (used by airborne
// aircraft to find targets for their ordnance). Returns the ship or null.
export function nearestEnemyShipInRange(src, world, range) {
  let best = null;
  let bd = Infinity;
  for (const s of world.ships) {
    if (!s.alive || s.side === src.side) continue;
    const d = distance(src.pos, s.pos);
    if (d <= range && d < bd) {
      best = s;
      bd = d;
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

  // No world-box clamp: the battle space is open (faithful to FC99, whose 2D
  // map is a scrollable viewport with no hard edge). Units roam freely; only
  // land collision below keeps them off terrain.

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
  // Real weapon speeds in knots -> world units per game-second (KNOTS_TO_UPS).
  // Relative class performance preserved vs ships: missiles ~18-22x a 30-kt
  // ship, gun shells ~55x, torpedoes ~1.5x (slower than flank but faster than
  // the target can sprint forever).
  const kts = {
    missile: 700,     // anti-ship missile ~ Harpoon/Exocet (510-570 kts)
    torpedo: 45,      // heavy torpedo ~ 34-50 kts
    gun: 1800,        // naval shell ~ Mach 2-3
    asroc: 600,       // ASROC ~ subsonic rocket
    depthCharge: 200, // dropped charge, short fall
  }[type];
  return (kts != null ? kts : 600) * KNOTS_TO_UPS;
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

// Aggregate the ship's magazine into loaded/total rounds for the status icon.
export function shipAmmo(ship) {
  let loaded = 0, total = 0;
  for (const w of ship.weapons || []) {
    loaded += w.count || 0;
    total += w.magMax || 0;
  }
  return { loaded, total };
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
            // Burn a magazine round so the ship's ammo icon reflects reality.
            if (w.count > 0) w.count -= 1;
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
    // Fuel burn (1 unit/sec). No automatic fuel bingo — Return to Base is an
    // explicit player command (faithful to FC99; the original ditches planes
    // that run dry rather than auto-returning). Zero fuel = lost.
    a.fuel -= dt;
    if (a.fuel <= 0) {
      a.fuel = 0;
      a.alive = false;
      a.state = 'lost';
      continue;
    }

    // Ammo-aware engagement: airborne aircraft fire at enemy ships in range and
    // spend ordnance. When ordnance is exhausted they auto-return to base (the
    // ammo bingo the user asked for) — this is independent of fuel.
    if (world.combatStarted && a.weapon && a.ordnance > 0 && a.state !== 'rtb' && a.state !== 'recovering') {
      a._acCd -= dt;
      if (a._acCd <= 0) {
        const tgt = nearestEnemyShipInRange(a, world, a.weapon.range);
        if (tgt) {
          spawnProjectile(world, a, tgt, a.weapon);
          a.ordnance -= 1;
          a._acCd = a.weapon.cooldown;
        }
      }
    }
    if (a.weapon && a.ordnance <= 0 && a.state !== 'rtb' && a.state !== 'recovering') {
      const home = world.ship(a.homeId);
      if (home) {
        a.state = 'rtb';
        a.mission = null;
        a._rtbReason = 'ammo';
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

    // No world-box clamp: the battle space is open (faithful to FC99). The
    // aircraft flies wherever its route takes it; the camera scrolls to follow.
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

// Ensure every unit spawns on the correct terrain: ships at sea, immobile
// installations (airfields/bases) on land.
function ensureSpawnPositions(world) {
  const seaRef = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  for (const s of world.ships) {
    if (s.immobile) {
      if (!isPointOnLand(s.pos.x, s.pos.y)) {
        const safe = snapToLand(s.pos);
        s.pos.x = safe.x;
        s.pos.y = safe.y;
      }
    } else if (isPointOnLand(s.pos.x, s.pos.y)) {
      const safe = snapToSea(s.pos, seaRef);
      s.pos.x = safe.x;
      s.pos.y = safe.y;
    }
  }
}

export function makeWorld(index) {
  let i = index;
  if (i < 0) i = 0;
  if (i > 2) i = 2;
  const name = SCENARIOS[i].name;
  const w = new World();
  w.scenarioName = name;

  // Real geography: each scenario resolves to a real lat/lon area of operations;
  // the bundled Natural Earth coastline is clipped to that AO and projected.
  const land = buildLandPolygons(name);
  w.geo = { lat: land.centerLat, lon: land.centerLon, label: land.label, nineDash: land.nineDash };
  w.land = land.polygons;
  setLand(land.polygons);

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
          for (let j = 0; j < cnt; j++) w.addParkedAircraft(ship, a.type);
        }
      }
    }
  } else if (i === 0) {
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

  ensureSpawnPositions(w);
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

  // Real geography for the chosen theater (falls back to North Pacific).
  const land = buildLandPolygons(
    theater === 'med' ? 'med' : theater === 'norwegian' ? 'norwegian' : 'Wyoming Deploys'
  );
  w.geo = { lat: land.centerLat, lon: land.centerLon, label: land.label, nineDash: land.nineDash };
  w.land = land.polygons;
  setLand(land.polygons);
  ensureSpawnPositions(w);
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
