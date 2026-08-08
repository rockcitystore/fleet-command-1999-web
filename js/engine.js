// Fleet Command '99 — Web Port engine.js
// Game model + simulation + coordinate math. NO DOM. Node-importable.
// Conforms to CONTRACT.md.

import { REAL_PLACEMENTS } from './realdata.js';
import { REAL_SHIP_STATS } from './realstats.js';
import { isPointOnLand, snapToSea, snapToLand, setLand, planSeaRoute, nearestSea, distToLand } from './terrain.js';
import { buildLandPolygons } from './geo.js';
import { bindGoals, evaluateGoals, hudObjectives, goalVerdict, goalDebrief } from './goals.js';

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

// Non-combatant hull. The original scenarios are full of merchants, tankers,
// trawlers, ferries and AGIs (487 of the 494 merchant entities carry
// `alliance 8` = NEUTRAL). They are unarmed, slow, soft, and exist purely as
// traffic the player must identify before shooting — exactly the rules-of-
// engagement pressure FC99 is famous for. [INFERRED] stats: merchant hulls are
// not in objects.odb's combatant table.
if (!SHIP_STATS.merchant) {
  SHIP_STATS.merchant = {
    label: 'MV',
    maxHp: 30,
    maxSpeedKts: 16,
    radius: 12,
    sensorRange: 120,
    isSub: false,
    defaultDepth: 0,
    sensors: [{ kind: 'surfaceRadar', range: 120 }],
    weapons: [],
    civilian: true,
  };
}

// ---------------------------------------------------------------------------
// Ammunition magazines.
// These are [INFERRED] placeholder values, NOT decoded from the original
// binary. The authentic per-platform loadouts live in platforms.sdb (a
// platform/loadout database that was NOT among the provided files); the
// provided mission.db's loadout section is an unparseable padded numeric
// layout, and launcher.ldb carries only launcher/mount definitions (no
// magazine counts). The ONLY verified anchor is the user's screenshot of the
// Wyoming SSBN742 submarine: 65 cm Torpedo = 12 and DM 2A4 Torpedo = 12, so
// torpedo magazines are set to 12. All other values are reasonable FC99-era
// magnitudes; they will be replaced by [KNOWN] decoded numbers once
// platforms.sdb is supplied. Keyed by weapon realName; swap for a
// per-ship-class table when decoding.
const INFERRED_MAGAZINE = {
  'Harpoon': 8, 'Exocet': 6,
  'SM-1 MR': 16, 'SM-2': 16, 'ESSM': 24,
  '65 cm Torpedo': 12, 'DM 2A4 Torpedo': 12,
  'RBU Rocket': 12, 'Depth Charge': 12,
  'MR Shell': 400, 'LR Shell': 600, 'SR Shell': 300,
};

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
    // Default time compression. The game opens at real-time ×1 so the player
    // sees honest pacing; they can crank the multiplier up via the HUD control
    // if they want the opening battle to play out faster.
    this.speed = 1;
    this.lastTick = undefined;
    // Combat stays "cold" until the player commits: no side may fire until the
    // player issues an explicit attack order. This prevents the AI from sinking
    // player ships in the opening seconds (e.g. enemy subs already in torpedo
    // range at spawn) and gives the player agency over when the war starts.
    this.combatStarted = false;
    // Enemy command source: 'builtin' (deterministic doctrine below) or 'llm'
    // (a local Ollama model drives the RED fleet via js/aiCommander.js). When
    // 'llm' the built-in doctrine loop is skipped (air-wing launches still run).
    this.aiMode = 'builtin';
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

  // Spawn an aircraft that is ALREADY AIRBORNE at scenario start. The original
  // .scs files place AIRENTITY records with a position, altitude, course and
  // speed — bombers inbound, patrol aircraft on station, airliners crossing the
  // box. Those units have no parent platform, so they can't go through
  // launchAircraft(); this builds the same airborne record directly.
  addAirborne(side, type, pos, opts = {}) {
    const st = AIRCRAFT_STATS[type] || AIRCRAFT_STATS.__default;
    const civilian = opts.civilian || side === 'neutral';
    const alt = opts.alt != null ? Math.min(opts.alt, st.maxAlt) : st.maxAlt * 0.6;
    const ac = {
      id: this.nextId++,
      kind: 'aircraft',
      side,
      type,
      // Keep the ORIGINAL airframe name even when it falls back to __default
      // stats (the scenarios name 80+ types; we model 10 performance classes).
      display: opts.display || (AIRCRAFT_STATS[type] ? st.display : type),
      category: st.category,
      homeId: opts.homeId != null ? opts.homeId : null,
      state: 'airborne',
      pos: { x: pos.x, y: pos.y },
      alt,
      maxAlt: st.maxAlt,
      targetAlt: alt,
      speed: opts.speed != null ? Math.min(ktsToUps(opts.speed), st.maxSpeed) : st.maxSpeed * 0.6,
      maxSpeed: st.maxSpeed,
      fuel: st.maxFuel,
      maxFuel: st.maxFuel,
      sensorRange: st.sensorRange,
      sensors:
        st.category === 'helo'
          ? [
              { kind: 'airRadar', range: Math.round(st.sensorRange * 0.7) },
              { kind: 'activeSonar', range: 160 },
              { kind: 'esm', range: Math.round(st.sensorRange * 0.5) },
            ]
          : [
              { kind: 'airRadar', range: st.sensorRange },
              { kind: 'esm', range: Math.round(st.sensorRange * 0.6) },
            ],
      // Civil traffic carries no ordnance at all.
      weapon: civilian ? null : st.weapon ? { ...st.weapon } : null,
      ordnance: civilian ? 0 : st.ordnance || 0,
      ordnanceMax: civilian ? 0 : st.ordnance || 0,
      civilian,
      _acCd: 0,
      _rtbReason: null,
      mission: opts.mission || null,
      order: null,
      heading: opts.course != null ? (opts.course * Math.PI) / 180 : 0,
      detected: false,
      alive: true,
      trail: [],
    };
    if (opts.waypoints && opts.waypoints.length) {
      ac.order = {
        kind: 'flyTo',
        waypoints: opts.waypoints.map((w) => ({
          x: w.x, y: w.y,
          alt: w.alt != null ? Math.min(w.alt, st.maxAlt) : ac.targetAlt,
          speed: w.speed != null ? Math.min(ktsToUps(w.speed), st.maxSpeed) : ac.maxSpeed,
        })),
        wpIndex: 0,
        loop: true,
      };
    }
    this.aircraft.push(ac);
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
      // Aircrew sensors: radar (sees air + low surface) + ESM; helos also dip
      // sonar to hunt subs — this is how CAP finds bandits and ASW finds boats.
      sensors:
        st.category === 'helo'
          ? [
              { kind: 'airRadar', range: Math.round(st.sensorRange * 0.7) },
              { kind: 'activeSonar', range: 160 },
              { kind: 'esm', range: Math.round(st.sensorRange * 0.5) },
            ]
          : [
              { kind: 'airRadar', range: st.sensorRange },
              { kind: 'esm', range: Math.round(st.sensorRange * 0.6) },
            ],
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

  // Ammunition magazines are assigned by INFERRED_MAGAZINE (module-level);
  // see its declaration for the [INFERRED] vs [KNOWN] provenance note.

  addShip(side, shipClass, pos, depth) {
    const stat = SHIP_STATS[shipClass];
    const d = depth !== undefined ? depth : stat.defaultDepth;
    const id = this.nextId++;

    // Deterministic, class-appropriate magazine sizes (see INFERRED_MAGAZINE
    // above). Replaces the old per-type RANDOM generation so ammo is stable
    // and matches FC99-era magnitudes instead of e.g. 400-5960 random shells.
    const weapons = stat.weapons.map((w) => {
      const count = INFERRED_MAGAZINE[w.realName] ?? 10;
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
      sensors: stat.sensors ? stat.sensors.map((x) => ({ ...x })) : [{ kind: 'surfaceRadar', range: stat.sensorRange }],
      detected: false,
      chaff: stat.isSub ? 0 : 6, // soft-kill decoys (subs carry none)
      _lastFireTime: -999,
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

  issueOrder(order, ids, source = 'human') {
    if (order && order.kind === 'attack') this.combatStarted = true;
    for (const id of ids) {
      const s = this.ships.find((x) => x.id === id);
      if (!s) continue;
      // Immobile installations cannot receive move orders.
      if (order && order.kind === 'moveTo' && s.immobile) continue;
      if (order && order.kind === 'moveTo') {
        // Normalize to a waypoint chain so multi-leg routes (and the legacy
        // single-point form) share one code path. `loop` makes the route patrol
        // (re-arm at the first node) instead of ending.
        //
        // Auto-routing: the original FC99 had no land-avoidance (the player
        // plotted waypoints by hand). For a single-point destination we now
        // plan a sea lane around any coastline between the ship and the goal;
        // clear-water moves collapse to one waypoint (unchanged behaviour).
        // For an explicit multi-waypoint route the player is deliberately
        // plotting, so we only snap any coastal-clicked node to the nearest
        // sea instead of re-routing the whole leg.
        const explicit = order.waypoints && order.waypoints.length > 1;
        let wps;
        if (explicit) {
          wps = order.waypoints.map((p) => {
            const node = { x: p.x, y: p.y, speed: p.speed };
            if (isPointOnLand(p.x, p.y)) {
              const snapped = nearestSea(p.x, p.y, (s.radius || 13) + 6);
              node.x = snapped.x; node.y = snapped.y;
            }
            return node;
          });
        } else {
          const goal = order.pos || (order.waypoints && order.waypoints[0]) || null;
          if (!goal) { s.order = null; continue; }
          const margin = (s.radius || 13) + 6;
          wps = planSeaRoute({ x: s.pos.x, y: s.pos.y }, { x: goal.x, y: goal.y }, { margin });
          wps = wps.map((p) => ({ x: p.x, y: p.y, speed: s.maxSpeed }));
        }
        if (wps.length) s.order = { kind: 'moveTo', waypoints: wps, wpIndex: 0, loop: !!order.loop };
        else s.order = null;
        if (s.order) s.order.source = source;
      } else {
        s.order = order;
        s.order.source = source;
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
    // Cap the wall-clock delta so a lag spike doesn't teleport units, but keep
    // the cap generous enough that the selected time multiplier is preserved
    // down to ~4 FPS (250ms/frame). Sub-stepping below still keeps physics/AI
    // stable at 50ms steps.
    if (raw > 0.25) raw = 0.25;
    let remaining = raw * this.speed; // real-time × speed
    // Sub-step so a high multiplier (e.g. ×200) integrates as many small steps
    // rather than one huge Euler jump — keeps movement/AI/firing stable.
    const MAX_STEP = 0.05;
    let guard = 0;
    while (remaining > 1e-6 && guard < 2048) {
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
    if (a.side !== 'player' && !a.detected) continue;
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
// Identification-friend-or-foe. FC99 fields three alliances: BLUE (player),
// RED (enemy) and NEUTRAL — the merchant traffic, civil airliners and third-
// party warships that fill the original order of battle. Neutrals are tracked
// and displayed like any other contact but are never valid targets for either
// combatant, so every "is this shootable?" test must go through here rather
// than a bare `side !== side` comparison.
export function isHostile(a, b) {
  if (!a || !b) return false;
  if (a.side === b.side) return false;
  if (a.side === 'neutral' || b.side === 'neutral') return false;
  return true;
}

export function nearestEnemy(ship, world) {
  let best = undefined;
  let bd = Infinity;
  for (const o of world.ships) {
    if (!o.alive || !isHostile(ship, o)) continue;
    const d = distance(ship.pos, o.pos);
    if (d < bd) {
      bd = d;
      best = o;
    }
  }
  return best;
}

function nearestFriendly(ship, world) {
  let best = undefined;
  let bd = Infinity;
  for (const o of world.ships) {
    if (!o.alive || o === ship || o.side !== ship.side) continue;
    const d = distance(ship.pos, o.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

function nearestCapital(ship, world) {
  let best = undefined;
  let bd = Infinity;
  for (const o of world.ships) {
    if (!o.alive || o.side !== ship.side) continue;
    const capital =
      o.shipClass === 'carrier' || o.shipClass === 'battleship' ||
      o.shipClass === 'cruiser' || o.immobile;
    if (!capital) continue;
    const d = distance(ship.pos, o.pos);
    if (d < bd) { bd = d; best = o; }
  }
  return best;
}

// Nearest enemy SHIP within `range` of a source unit (used by airborne
// aircraft to find targets for their ordnance). Returns the ship or null.
export function nearestEnemyShipInRange(src, world, range) {
  let best = null;
  let bd = Infinity;
  for (const s of world.ships) {
    if (!s.alive || !isHostile(src, s)) continue;
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
        // AI sets a role-appropriate stand-off (missileers far, ASW close);
        // fall back to 85% of max weapon range.
        const standoff = s._standoff != null ? s._standoff : Math.max(...s.weapons.map((w) => w.range)) * 0.85;
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
    } else if (order && order.kind === 'formation') {
      // Escort screens its capital ship instead of wandering or stacking.
      const guide = nearestCapital(s, world) || nearestFriendly(s, world);
      if (guide) {
        const ang = (s.id * 2.3999632) % (Math.PI * 2); // golden-angle ring
        const r = 260 + (s.id % 4) * 110;
        const gx = guide.pos.x + Math.cos(ang) * r;
        const gy = guide.pos.y + Math.sin(ang) * r;
        const gd = distance(s.pos, { x: gx, y: gy });
        if (gd > 14) { goal = { x: gx, y: gy }; desired = s.maxSpeed * 0.6; }
        else desired = 0;
      }
    }

    // Mission kill (FC99-style casualty): a crippled hull limps at 30% speed.
    if (s.hp <= 0.2 * s.maxHp) desired = Math.min(desired, s.maxSpeed * 0.3);

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

// ---------------------------------------------------------------------------
// Detection — FC99 first principle.
// A contact is detected only when an OPPOSING sensor of the matching KIND can
// physically reach it. Sensors are type- and depth-aware:
//   * airRadar     -> sees AIR contacts (long range)
//   * surfaceRadar -> sees SURFACE ships (and low-flying air, reduced)
//   * passiveSonar -> hears SUBS (and noisy surface screws at short range)
//   * activeSonar  -> pings SUBS + SURFACE (reveals the pinger's position)
//   * esm          -> passively hears RADAR EMITTERS (surface ships/aircraft);
//                     a silent submerged sub emits nothing, so ESM can't see it
//   * visual       -> all-round, very short
// A submerged platform has its masts down: radar/ESM/visual are blind, only
// sonar works. That is why subs are the fog-of-war in this sim.
// ---------------------------------------------------------------------------
export function contactDomain(c) {
  if (c.kind === 'aircraft') return 'air';
  if (c.alt != null && c.alt > 40) return 'air';
  if (c.depth != null && c.depth < -5) return 'sub';
  return 'surface';
}

function detectorBlindAtDepth(P) {
  return P.depth != null && P.depth < -5;
}

export function sensorCanSee(P, C) {
  const dom = contactDomain(C);
  const d = distance(P.pos, C.pos);
  const detectorSubmerged = detectorBlindAtDepth(P);
  for (const s of P.sensors || []) {
    // Masts down: no radar/ESM/visual while deep.
    if (detectorSubmerged && s.kind !== 'passiveSonar' && s.kind !== 'activeSonar') continue;
    if (s.kind === 'airRadar') {
      if (dom === 'air' && d <= s.range) return true;
    } else if (s.kind === 'surfaceRadar') {
      if (dom === 'surface' && d <= s.range) return true;
      if (dom === 'air' && C.alt != null && C.alt < 200 && d <= s.range * 0.5) return true;
    } else if (s.kind === 'passiveSonar') {
      if (dom === 'sub') {
        const r = C.depth != null && C.depth > -40 ? s.range : s.range * 0.6;
        if (d <= r) return true;
      } else if (dom === 'surface') {
        if (d <= s.range * 0.4) return true; // screw noise
      }
    } else if (s.kind === 'activeSonar') {
      if ((dom === 'sub' || dom === 'surface') && d <= s.range) return true; // pings
    } else if (s.kind === 'esm') {
      // Emitters only: surface ships (radar on) and aircraft. Quiet subs = silent.
      if ((dom === 'surface' || dom === 'air') && d <= s.range) return true;
    } else if (s.kind === 'visual') {
      if (d <= Math.min(s.range, 200)) return true;
    }
  }
  return false;
}

export function updateDetection(world) {
  const contacts = [];
  for (const s of world.ships) if (s.alive) contacts.push(s);
  for (const a of world.aircraft) if (a.alive) contacts.push(a);
  for (const c of contacts) {
    let byPlayer = false;
    let byEnemy = false;
    for (const o of contacts) {
      if (!o.alive) continue;
      if (o.side === 'player' && sensorCanSee(o, c)) byPlayer = true;
      if (o.side === 'enemy' && sensorCanSee(o, c)) byEnemy = true;
    }
    // `detected` keeps meaning "the PLAYER side can see this" (drives rendering
    // and the fog-of-war). `seenByEnemy` lets the AI only shoot at contacts its
    // own sensors have actually found — FC99 never fires blind.
    c.detected = byPlayer;
    c.seenByEnemy = byEnemy;
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
  // Visual altitude in world units (1 unit ≈ 92.6 m). Values are chosen to be
  // readable at the strategic camera while still reading as the correct domain:
  // missiles skim the sea, torpedoes run shallow, guns/shells arc above.
  const altByType = {
    missile: 2.0,
    torpedo: 0.3,
    gun: 5.0,
    asroc: 1.2,
    depthCharge: 0.4,
  };
  // Realistic max turn rate (rad/s). Guns/shells are ballistic and do not
  // manoeuvre; missiles track but cannot snap-turn like a UFO; torpedoes turn
  // slowly. This keeps engagements believable without making them miss often.
  const turnByType = {
    missile: 0.35,
    torpedo: 0.08,
    gun: 0,
    asroc: 0.15,
    depthCharge: 0,
  };
  const dx = target.pos.x - source.pos.x;
  const dy = target.pos.y - source.pos.y;
  world.projectiles.push({
    id: world.nextId++,
    type: weapon.type,
    side: source.side,
    sourceId: source.id,
    targetId: target.id,
    pos: { x: source.pos.x, y: source.pos.y },
    heading: Math.atan2(dy, dx),
    maxTurn: turnByType[weapon.type] ?? 0.2,
    speed,
    damage: weapon.damage,
    range: weapon.range,
    originDist,
    realName: weapon.realName,
    maxLifetime,
    lifetime: 0,
    color: projectileColor(weapon.type),
    alt: altByType[weapon.type] ?? 2.0,
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

// Pick the best target for a weapon given detection, domain and range gates.
// Mirrors the FC99 fire-control logic: only fire at contacts OUR side can see,
// only at domains this weapon can engage, and within its range. SAMs may also
// intercept incoming enemy rounds (which are, by definition, detected).
function chooseWeaponTarget(s, w, world) {
  const domains = w.targets || ['surface'];
  const sees = (e) => (s.side === 'player' ? e.detected : e.seenByEnemy);
  const candidates = [];

  // Enemy ships/subs of a domain this weapon can hit — only ones OUR side has
  // actually detected (no firing at ghosts).
  for (const e of world.ships) {
    if (!e.alive || !isHostile(s, e)) continue;
    if (!sees(e)) continue;
    if (domains.includes(contactDomain(e)) && distance(s.pos, e.pos) <= w.range) {
      candidates.push(e);
    }
  }
  // Enemy aircraft (guns/SAMs).
  if (domains.includes('air')) {
    for (const a of world.aircraft) {
      if (a.alive && isHostile(s, a) && sees(a) && distance(s.pos, a.pos) <= w.range) {
        candidates.push(a);
      }
    }
  }
  // Air-defence battery can also intercept INCOMING enemy missiles/torpedoes.
  // An inbound round is, by definition, detected (you watch it come), so it is
  // NOT subject to the sees() gate above.
  if (w.canIntercept) {
    for (const p of world.projectiles) {
      if (p.side !== s.side && (p.type === 'missile' || p.type === 'torpedo') && !p.dead) {
        if (distance(s.pos, p.pos) <= w.range) candidates.push(p);
      }
    }
  }
  if (!candidates.length) return null;
  // Nearest valid target; SAMs prefer the closest inbound threat.
  candidates.sort((a, b) => distance(s.pos, a.pos) - distance(s.pos, b.pos));
  return candidates[0];
}

// Launch a single round and bookkeeping (ammo, sub evade timer).
function fireOneRound(world, s, w, tgt) {
  spawnProjectile(world, s, tgt, w);
  if (w.count > 0) w.count -= 1;
  // Submarines mark their last torpedo launch so the AI can evade after.
  if (s.isSub && w.type === 'torpedo') s._lastFireTime = world.time;
}

export function updateWeapons(world, dt) {
  // Cold war until the player commits: no firing (either side) before the first
  // player attack order. Keeps positioning safe and playable.
  if (!world.combatStarted) return;

  // First frame of actual combat: stagger the fleet's opening shots so the
  // whole OOB doesn't fire on the same tick. Player crews react a bit faster
  // than the AI; both have random jitter so salvoes read as a ragged volley.
  if (!world._weaponsCombatStarted) {
    world._weaponsCombatStarted = true;
    // Reaction delay is expressed in GAME seconds, but it is decremented by the
    // (speed-scaled) frame dt. At high time compression that window collapses
    // to milliseconds of real time, so the fleet appears to fire at once. Scale
    // the assignment by the current speed so the delay reads as the same REAL
    // duration (0.6-2.8s) regardless of time compression — visible stagger at
    // any speed, identical feel at 1x.
    const spd = Math.max(0.1, world.speed || 1);
    for (const s of world.ships) {
      if (!s.alive) continue;
      for (const w of s.weapons) {
        const base = s.side === 'player' ? 0.25 : 0.6;
        const jitter = s.side === 'player' ? 0.9 : 2.2;
        w._reactionLeft = (base + world.rand() * jitter) * spd;
      }
    }
  }

  for (const s of world.ships) {
    if (!s.alive) continue;
    for (const w of s.weapons) {
      const salvo = w.salvo ?? 1;
      const ripple = w.ripple ?? (w.cooldown || 1);
      const reload = w.reload ?? (w.cooldown || 0);
      // After a salvo ends, a single-round launcher repeats on RIPPLE; a
      // multi-round launcher waits the long RELOAD before the next volley.
      const nextGap = salvo > 1 ? reload : ripple;

      // 1) OODA / command-and-control delay (only matters at combat onset).
      if (w._reactionLeft > 0) { w._reactionLeft -= dt; continue; }

      // 2) Launcher reloading after a salvo?
      if (w._reloadLeft > 0) { w._reloadLeft -= dt; continue; }

      // 3) Mid-salvo: fire the next round when its ripple timer elapses.
      if (w._salvoLeft > 0) {
        if (w._salvoNext > 0) { w._salvoNext -= dt; continue; }
        const tgt = chooseWeaponTarget(s, w, world);
        if (!tgt || w.count <= 0) {
          // Lost the target (or dry) mid-volley — stop the salvo.
          w._salvoLeft = 0;
          w._reloadLeft = w.count <= 0 ? 0 : reload;
          continue;
        }
        fireOneRound(world, s, w, tgt);
        w._salvoLeft -= 1;
        if (w._salvoLeft > 0) w._salvoNext = ripple;
        else w._reloadLeft = nextGap;
        continue;
      }

      // 4) Idle: if a valid target is in range and we have ammo, launch a salvo.
      const tgt = chooseWeaponTarget(s, w, world);
      if (tgt && w.count > 0) {
        const n = Math.min(salvo, w.count);
        fireOneRound(world, s, w, tgt);
        w._salvoLeft = n - 1;
        if (w._salvoLeft > 0) w._salvoNext = ripple;
        else w._reloadLeft = nextGap;
      }
    }
  }
}

export function updateProjectiles(world, dt) {
  const remaining = [];
  for (const p of world.projectiles) {
    if (p.dead) continue;
    p.lifetime += dt;
    if (p.lifetime > p.maxLifetime) continue;

    // Target may be a ship/aircraft OR an incoming projectile being intercepted.
    const tgtShip = world.ship(p.targetId);
    const tgtProj = tgtShip ? null : world.projectiles.find((q) => q.id === p.targetId && !q.dead);
    const target = tgtShip || tgtProj;
    if (!target) continue;

    const dx = target.pos.x - p.pos.x;
    const dy = target.pos.y - p.pos.y;
    const d = Math.hypot(dx, dy);
    const step = p.speed * dt;
    const hitR = (target.radius || 6) + (tgtProj ? 6 : 0);

    if (d <= step + hitR) {
      if (tgtProj) {
        // SAM/CIWS kill the incoming round. Both are destroyed.
        tgtProj.dead = true;
        p.dead = true;
        continue;
      }
      // Anti-ship missile vs a ship: chaff may decoy it (soft kill).
      if (p.type === 'missile' && target.chaff > 0 && world.rand() < 0.5) {
        target.chaff -= 1;
        p.dead = true;
        continue;
      }
      // Impact: accuracy falls with stand-off distance at launch.
      const accuracy = Math.max(0.3, 1 - (p.originDist / Math.max(p.range, 1)) * 0.6);
      if (world.rand() <= accuracy) {
        const dmg = p.damage * (0.8 + 0.4 * world.rand());
        target.hp -= dmg;
        if (target.hp <= 0) target.alive = false;
      }
      p.dead = true;
      continue;
    }

    // Move. Ballistic rounds (guns/depth charges) fly straight; guided
    // munitions track the target but are limited by their turn rate.
    if (p.maxTurn > 0 && d > 0) {
      const desired = Math.atan2(dy, dx);
      let heading = p.heading ?? desired;
      const delta = Math.atan2(Math.sin(desired - heading), Math.cos(desired - heading));
      heading += Math.max(-p.maxTurn * dt, Math.min(p.maxTurn * dt, delta));
      p.heading = heading;
      p.pos.x += Math.cos(heading) * step;
      p.pos.y += Math.sin(heading) * step;
    } else if (d > 0) {
      p.pos.x += (dx / d) * step;
      p.pos.y += (dy / d) * step;
    }
    p.trail.push({ x: p.pos.x, y: p.pos.y });
    if (p.trail.length > 12) p.trail.shift();
    remaining.push(p);
  }
  // Drop dead rounds (intercepted / decoyed / spent).
  world.projectiles = remaining.filter((p) => !p.dead);
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
  // This runs in BOTH builtin and LLM modes so the RED force always gets its
  // patrol air wing once combat starts; the LLM can reposition/recall them.
  if (world.combatStarted) {
    for (const s of world.ships) {
      if (!s.alive || s.side !== 'enemy' || !s.aircraft || !s.aircraft.length) continue;
      if (world.time - (s._lastLaunch != null ? s._lastLaunch : -999) < 4) continue;
      const parked = s.aircraft[0];
      const launched = world.launchAircraft(s.id, parked.id, 'patrol', null);
      if (launched) s._lastLaunch = world.time;
    }
  }

  // When a local LLM owns the RED fleet, it issues orders out-of-band
  // (throttled + async, see js/aiCommander.js). Skip the deterministic
  // doctrine so the two commanders don't fight over the same ships.
  if (world.aiMode === 'llm') return;

  runBuiltinDoctrine(world);
}

// Deterministic fleet doctrine (the classic Fleet Command AI), parameterized by
// the side it commands. Extracted from updateAI so the LLM commanders can fall
// back to it on error without re-entering the air-wing launch block. The RED
// commander uses ownSide='enemy'; the BLUE commander uses ownSide='player'.
export function runBuiltinDoctrine(world) { return _runBuiltinDoctrine(world, 'enemy'); }
export function runBuiltinPlayerDoctrine(world) { return _runBuiltinDoctrine(world, 'player'); }
function _runBuiltinDoctrine(world, ownSide) {
  for (const s of world.ships) {
    if (!s.alive || s.side !== ownSide) continue;

    const foes = world.ships.filter((e) => e.alive && isHostile(s, e));
    const enemySubs = foes.filter((e) => contactDomain(e) === 'sub');
    const enemySurf = foes.filter((e) => contactDomain(e) === 'surface');
    const enemyAir = world.aircraft.filter((a) => a.alive && isHostile(s, a));

    // ---- SUBMARINE doctrine -------------------------------------------------
    if (s.isSub) {
      const t = enemySurf[0] || foes[0];
      if (!t) { s.targetId = null; s.targetDepth = s.defaultDepth; s.order = null; continue; }
      s.targetId = t.id;
      const torp = s.weapons.find((w) => w.type === 'torpedo');
      const d = distance(s.pos, t.pos);
      const evading = s._lastFireTime != null && world.time - s._lastFireTime < 20;
      if (evading) {
        // Snake away from the last target after shooting.
        s.targetDepth = -200;
        const ax = s.pos.x + (s.pos.x - t.pos.x);
        const ay = s.pos.y + (s.pos.y - t.pos.y);
        s.order = { kind: 'moveTo', waypoints: [{ x: ax, y: ay, speed: s.maxSpeed }] };
      } else if (torp && d <= torp.range * 0.9) {
        s.targetDepth = -15; // rise to periscope depth to fire
        s.order = { kind: 'attack', targetId: t.id };
      } else {
        s.targetDepth = s.defaultDepth; // stay deep while stalking
        s.order = { kind: 'attack', targetId: t.id };
      }
      if (s.order) s.order.source = 'ai';
      continue;
    }

    // ---- SURFACE doctrine ---------------------------------------------------
    const missile = s.weapons.find((w) => w.type === 'missile');
    const asw = s.weapons.find((w) => w.type === 'torpedo' || w.type === 'asroc' || w.type === 'depthCharge');

    let target = null;
    let standoff = 300;
    if (asw && enemySubs.length) {
      // ASW hunter closes to put the sub inside torpedo/ASROC range.
      target = enemySubs[0];
      standoff = Math.min(asw.range * 0.85, 360);
    } else if (missile && enemySurf.length) {
      // Missile ship is a STAND-OFF shooter: lob from max range, never close.
      target = enemySurf[0];
      standoff = missile.range * 0.9;
    } else if (enemySurf.length) {
      target = enemySurf[0];
      standoff = 300; // gunner closes a little
    } else if (enemyAir.length && s.weapons.some((w) => w.canIntercept)) {
      // Nothing to shoot at but bandits overhead — the SAM battery just holds
      // station (it auto-fires via updateWeapons) and keeps formation.
      target = null;
    }

    if (target) {
      s.targetId = target.id;
      s._standoff = standoff;
      s.order = { kind: 'attack', targetId: target.id };
    } else {
      // Idle: hold formation station around the nearest friendly capital ship.
      s.targetId = null;
      s.order = { kind: 'formation' };
    }
    if (s.order) s.order.source = 'ai';
  }
}

// Evaluate each world objective and stamp its live status onto the descriptor
// so the HUD / end screen can render per-objective results.
// Objective kinds:
//   destroy-all-enemy — no hostile ships remain
//   destroy-class     — no hostile ship of `cls` remains
//   survive           — at least one friendly ship alive after `seconds`
//   protect           — at least `minAlive` friendly (optionally `tag`) ships alive
function evaluateObjectives(world) {
  const playerAlive = world.aliveShips('player');
  const enemyAlive = world.aliveShips('enemy');
  for (const o of world.objectives || []) {
    let ok = false;
    let failed = false;
    if (o.kind === 'destroy-all-enemy') {
      ok = enemyAlive.length === 0;
    } else if (o.kind === 'destroy-class') {
      ok = !enemyAlive.some((s) => s.shipClass === o.cls);
    } else if (o.kind === 'survive') {
      ok = world.time >= o.seconds && playerAlive.length > 0;
    } else if (o.kind === 'protect') {
      const relevant = o.tag
        ? playerAlive.filter((s) => s.shipClass === o.tag).length
        : playerAlive.length;
      const need = o.minAlive != null ? o.minAlive : 1;
      ok = relevant >= need;
      if (relevant < need) failed = true;
    }
    o.status = ok ? 'ok' : failed ? 'failed' : 'pending';
  }
  return world.objectives || [];
}

export function checkEnd(world) {
  if (world.phase && world.phase !== 'playing') return;
  const playerAlive = world.aliveShips('player').length;
  const enemyAlive = world.aliveShips('enemy').length;

  // Missions imported from the original .scc/.scs files carry the authentic
  // GOAL tree instead of the hand-written objective list. Fold that tree.
  if (world.goals && world.goals.length) {
    evaluateGoals(world);
    world.objectives = hudObjectives(world);
    if (playerAlive === 0) {
      world.phase = 'enemyWon';
      world.debrief = { ...world.debrief, lose: goalDebrief(world, false) || world.debrief.lose };
      return;
    }
    const verdict = goalVerdict(world);
    if (verdict === 'playerWon' || verdict === 'enemyWon') {
      world.phase = verdict;
      const won = verdict === 'playerWon';
      const text = goalDebrief(world, won);
      if (text) world.debrief = { ...world.debrief, [won ? 'win' : 'lose']: text };
      return;
    }
    if (verdict === null) {
      // No usable goals resolved (every target rolled off the spawn table) —
      // fall back to the classic annihilation rule so the mission can still end.
      if (enemyAlive === 0) world.phase = 'playerWon';
      else world.phase = 'playing';
      return;
    }
    world.phase = 'playing';
    return;
  }

  // Custom / editor worlds carry no objective set → classic annihilation rule.
  if (!world.objectives || world.objectives.length === 0) {
    if (playerAlive === 0) world.phase = 'enemyWon';
    else if (enemyAlive === 0) world.phase = 'playerWon';
    else world.phase = 'playing';
    return;
  }

  const objs = evaluateObjectives(world);
  if (playerAlive === 0) { world.phase = 'enemyWon'; return; }
  if (objs.some((o) => o.status === 'failed')) { world.phase = 'enemyWon'; return; }
  if (objs.length && objs.every((o) => o.status === 'ok')) { world.phase = 'playerWon'; return; }
  world.phase = 'playing';
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------
// Real mission titles/briefs from the original 1999 Fleet Command .scs files
// (Single07 / Single01 / Single08). The in-game fleets are a balanced
// recreation, not a 1:1 port of the original unit placements.
// Campaign track. Each entry carries the AUTHENTIC title / intel / orders text
// lifted verbatim from the original 1999 Fleet Command .scs mission files
// (Single07 / Single01 / Single08), plus objectives the engine evaluates.
export const SCENARIOS = [
  {
    name: 'Wyoming Deploys',
    brief: 'Help an SSBN start her ballistic missile deterrence patrol.',
    briefing: {
      title: 'WYOMING DEPLOYS',
      theater: 'Western Atlantic — off Kings Bay, Georgia',
      description: 'Help an SSBN start her ballistic missile deterrence patrol.',
      intel: 'The Russian submarines detected off the U.S. east coast in recent weeks are an Akula Class SSN and a Victor III Class SSN. Both boats are capable of carrying the 65 cm torpedo. Although the weapon has a reported range in excess of 25 nautical miles, operational firing ranges are expected to be limited by sensor performance and should be within 10 nautical miles.',
      task: 'The USS Wyoming (SSBN-742) has departed the submarine base at Kings Bay, Georgia and is headed for deep water. Once the Wyoming reaches the 300 fathom curve she will run silent and deep and commence her ballistic missile deterrence patrol. Russian submarines have been detected off the east coast and may be waiting to oppose the transit. Engage any detected Russian submarines and destroy them before they can attack the Wyoming.',
    },
    objectives: [
      { kind: 'destroy-class', cls: 'submarine', text: 'Destroy the hostile submarine before it can strike' },
      { kind: 'protect', minAlive: 2, text: 'Keep at least two escorts operational' },
    ],
    debrief: {
      win: 'Wyoming reaches deep water unopposed. Deterrence patrol commenced — mission accomplished.',
      lose: 'The Russian submarine broke through the screen. The patrol was compromised.',
    },
  },
  {
    name: 'CVBG Norwegian Sea',
    brief: 'Protect your Carrier from cruise missile attack.',
    briefing: {
      title: 'CVBG NORWEGIAN SEA',
      theater: 'Norwegian Sea — high north',
      description: 'Protect your Carrier from cruise missile attack.',
      intel: 'Expect attack by TU-22M Backfire bombers equipped with long range AS-4 Kitchen air-to-surface missiles. Kill all hostile aircraft. Targeting information may be provided by TU-142 Bear J AEW aircraft.',
      task: 'Protect the carrier from attack by bombers equipped with long range air-to-surface missiles. Kill all hostile aircraft.',
    },
    objectives: [
      { kind: 'protect', minAlive: 1, tag: 'carrier', text: 'Protect your aircraft carrier' },
      { kind: 'survive', seconds: 1200, text: 'Hold the battle group for 20 minutes' },
    ],
    debrief: {
      win: 'The carrier survives the bomber assault. The battle group remains operational.',
      lose: 'The carrier was struck and sunk. The battle group is broken.',
    },
  },
  {
    name: 'Hair Trigger',
    brief: 'Defend against cruise missile attacks and diesel submarine torpedoes in the Eastern Mediterranean.',
    briefing: {
      title: 'HAIR TRIGGER',
      theater: 'Eastern Mediterranean Sea',
      description: 'Defend yourself against long range cruise missile attacks and diesel submarine torpedoes. Your CVBG is deployed in the Eastern Mediterranean Sea.',
      intel: 'Various sources indicate that your carrier battle group is being targeted for elimination. Be alert for attacks.',
      task: "You have taken command of a United States carrier battle group. Your orders are to keep the force out of danger. Russian forces are determined to sink a United States aircraft carrier in the Mediterranean using long range bombers and a diesel submarine. Protect the CVBG for the next thirty minutes.",
    },
    objectives: [
      { kind: 'protect', minAlive: 1, tag: 'carrier', text: 'Protect the carrier battle group' },
      { kind: 'survive', seconds: 1800, text: 'Hold the CVBG for 30 minutes' },
      { kind: 'destroy-class', cls: 'submarine', text: 'Sink the diesel submarine' },
    ],
    debrief: {
      win: 'The CVBG holds through the thirty-minute watch. The threat is driven off — well done, Captain.',
      lose: 'The carrier battle group was overwhelmed. The Mediterranean watch is lost.',
    },
  },
];

export const SCENARIO_COUNT = SCENARIOS.length;
export function scenarioCount() { return SCENARIOS.length; }

// ---------------------------------------------------------------------------
// Original mission library (assets/data/missions.json)
// ---------------------------------------------------------------------------
// tools/parse_scenarios.py decodes all 39 shipped Fleet Command '99 scenario
// files (Region1-4.scc + Single01-35.scs) into a single JSON payload: authentic
// briefings, the complete order of battle, in-flight aircraft, spawn
// probabilities, waypoint routes and the 653-node GOAL tree. registerMissions()
// swaps that library in as the campaign track, replacing the three hand-written
// scenarios above. Until it is called (e.g. in the Node unit tests, which never
// fetch), SCENARIOS keeps its legacy contents so nothing else has to change.
export let MISSION_LIBRARY = null;

// Region files are the four campaign theatres; Single files are stand-alone
// missions. Present them in that order so the campaign track reads correctly.
function missionSortKey(m) {
  const kindRank = m.kind === 'region' ? 0 : 1;
  return kindRank * 1000 + (m.index || 0);
}

export function registerMissions(payload) {
  if (!payload || !payload.missions || !payload.missions.length) return SCENARIOS;
  MISSION_LIBRARY = payload;
  const list = payload.missions.slice().sort((a, b) => missionSortKey(a) - missionSortKey(b));

  const entries = list.map((m) => ({
    name: m.title || m.id,
    brief: (m.description || '').split(/(?<=\.)\s/)[0] || m.task || m.id,
    briefing: {
      title: (m.title || m.id).toUpperCase(),
      theater: theaterLabel(m),
      description: m.description || '',
      intel: m.intel || '',
      task: m.task || '',
    },
    // The playable objective list is derived from the GOAL tree at world build
    // time; this preview list is only what the briefing screen shows.
    objectives: previewObjectives(m),
    debrief: {
      win: 'All mission objectives complete.',
      lose: 'Mission objectives were not met.',
    },
    mission: m,
  }));

  SCENARIOS.length = 0;
  SCENARIOS.push(...entries);
  return SCENARIOS;
}

function theaterLabel(m) {
  const bits = [];
  if (m.lat != null && m.lon != null) {
    const ns = m.lat >= 0 ? 'N' : 'S';
    const ew = m.lon >= 0 ? 'E' : 'W';
    bits.push(`${Math.abs(m.lat).toFixed(1)}°${ns} ${Math.abs(m.lon).toFixed(1)}°${ew}`);
  }
  if (m.spanNm) bits.push(`${Math.round(m.spanNm)} NM box`);
  if (m.difficulty != null) bits.push(`difficulty ${m.difficulty}`);
  return bits.join('  ·  ');
}

// Top-level goal names, for the briefing screen (before the world exists and
// the tree can be bound to real units).
function previewObjectives(m) {
  const goals = m.goals || [];
  const roots = goals.filter((g) => g.parent === -1 && g.name);
  const src = roots.length ? roots : goals.filter((g) => g.name);
  const seen = new Set();
  const out = [];
  for (const g of src) {
    if (seen.has(g.name)) continue;
    seen.add(g.name);
    out.push({ kind: 'goal', text: g.name });
    if (out.length >= 6) break;
  }
  if (!out.length) out.push({ kind: 'goal', text: 'Destroy all hostile forces' });
  return out;
}

// --- Build a live World from one parsed mission ----------------------------
function buildMissionWorld(m, seed) {
  const w = new World(seed || 1);
  w.scenarioName = m.title || m.id;
  w.missionId = m.id;
  w.metersPerUnit = m.metersPerUnit || METERS_PER_UNIT;
  // Sea state / weather / time-of-day come straight from the mission header and
  // drive the 3D renderer's atmosphere.
  w.environment = {
    seaState: m.seaState != null ? m.seaState : 2,
    weather: m.weather != null ? m.weather : 0,
    timeOfDay: m.timeOfDay != null ? m.timeOfDay : 12,
    cloudHeight: m.cloudHeight != null ? m.cloudHeight : 3000,
    month: m.month != null ? m.month : 6,
  };

  // Real geography from the mission's own lat/lon header, projected at that
  // mission's scale so the coastline lines up with the parsed unit positions.
  const land = buildLandPolygons(
    { lat: m.lat, lon: m.lon, label: (m.title || m.id).toUpperCase() },
    w.metersPerUnit
  );
  w.geo = { lat: land.centerLat, lon: land.centerLon, label: land.label, nineDash: land.nineDash };
  w.land = land.polygons;
  setLand(land.polygons);

  // ---- Ships / submarines / shore installations ---------------------------
  const uidToShip = new Map();
  for (const u of m.units || []) {
    // NOTE: the original ships a per-entity spawn PROBABILITY ("prob"), but its
    // semantics are unverified (histogram shows anomalous 150/500 values) and
    // gating on it deletes most of the order of battle. We therefore spawn the
    // full parsed OOB every time for an authentic, deterministic force mix.
    const cls = SHIP_STATS[u.shipClass] ? u.shipClass : 'frigate';
    const ship = w.addShip(u.side, cls, { x: u.x, y: u.y }, u.depth);
    ship.uid = u.uid;
    ship.name = u.name || u.uid;
    ship.cls = u.cls || '';
    ship.hull = u.hull || '';
    ship.country = u.country || '';
    ship.group = u.group != null ? u.group : null;
    ship.civilian = cls === 'merchant' || u.side === 'neutral';
    ship.heading = ((u.course || 0) * Math.PI) / 180;
    if (u.speed) ship.speed = Math.min(ktsToUps(u.speed), ship.maxSpeed);
    uidToShip.set(u.uid, ship);

    // Parked air wing.
    if (u.aircraft && u.aircraft.length) {
      ship.aircraft = [];
      for (const a of u.aircraft) {
        const cnt = Math.min(a.count || 1, 24);
        for (let j = 0; j < cnt; j++) {
          const ac = w.addParkedAircraft(ship, a.type);
          // Keep the authentic airframe name even when it maps to generic stats.
          if (!AIRCRAFT_STATS[a.type]) ac.display = a.type;
        }
      }
    }

    // Pre-plotted route from the scenario file.
    if (u.waypoints && u.waypoints.length && !ship.immobile) {
      ship.order = {
        kind: 'moveTo',
        waypoints: u.waypoints.map((p) => ({
          x: p.x, y: p.y,
          speed: p.speed ? Math.min(ktsToUps(p.speed), ship.maxSpeed) : ship.maxSpeed * 0.6,
        })),
        wpIndex: 0,
        loop: u.side === 'neutral', // merchant traffic keeps plying its route
      };
    }
  }

  // ---- Aircraft already airborne at mission start -------------------------
  for (const a of m.air || []) {
    // Full parsed airborne set spawns (see prob note above for rationale).
    const ac = w.addAirborne(a.side, a.type, { x: a.x, y: a.y }, {
      alt: a.alt,
      speed: a.speed,
      course: a.course,
      display: a.display,
      civilian: a.role === 'CIVILIAN AIRCRAFT' || a.side === 'neutral',
      mission: airMissionFor(a.role),
      waypoints: a.waypoints,
    });
    ac.uid = a.uid;
    ac.country = a.country || '';
    ac.group = a.group != null ? a.group : null;
    ac.role = a.role || '';
  }

  ensureSpawnPositions(w);

  // ---- Goals --------------------------------------------------------------
  w.goals = bindGoals(w, m.goals || []);
  evaluateGoals(w);
  w.objectives = hudObjectives(w);
  w.debrief = {
    win: 'All mission objectives complete.',
    lose: 'Mission objectives were not met.',
  };
  return w;
}

function airMissionFor(role) {
  switch (role) {
    case 'Fighter/Attack': return 'CAP';
    case 'Maritime Patrol': return 'patrol';
    case 'ASW': return 'ASW';
    case 'Airborne Early Warning': return 'Recon';
    case 'Electronic Warfare':
    case 'Electronic Reconnaissance': return 'Recon';
    case 'Helicopter': return 'ASW';
    default: return 'patrol';
  }
}

// Ensure every unit spawns on the correct terrain: ships at sea, immobile
// installations (airfields/bases) on land.
function ensureSpawnPositions(world) {
  const seaRef = { x: WORLD_SIZE / 2, y: WORLD_SIZE / 2 };
  const M = 40; // keep everything inside the playable box
  const clamp = (v) => Math.max(M, Math.min(WORLD_SIZE - M, v));
  for (const s of world.ships) {
    if (s.immobile) {
      if (!isPointOnLand(s.pos.x, s.pos.y)) {
        const safe = snapToLand(s.pos);
        // The clipped coastline extends well beyond the playable box, so the
        // "nearest land" for an offshore base can be off-map. Only accept the
        // snap when the coast is actually nearby; otherwise leave the base put.
        const d = Math.hypot(safe.x - s.pos.x, safe.y - s.pos.y);
        if (d <= 600) {
          s.pos.x = safe.x;
          s.pos.y = safe.y;
        }
      }
    } else if (isPointOnLand(s.pos.x, s.pos.y)) {
      const safe = snapToSea(s.pos, seaRef);
      s.pos.x = safe.x;
      s.pos.y = safe.y;
    }
    s.pos.x = clamp(s.pos.x);
    s.pos.y = clamp(s.pos.y);
  }
  for (const a of world.aircraft) {
    a.pos.x = clamp(a.pos.x);
    a.pos.y = clamp(a.pos.y);
  }
}

export function makeWorld(index, opts = {}) {
  let i = index;
  if (i < 0) i = 0;
  if (i > SCENARIOS.length - 1) i = SCENARIOS.length - 1;

  // Missions imported from the original scenario files build themselves from
  // their own parsed data (order of battle, routes, goal tree, geography).
  if (SCENARIOS[i] && SCENARIOS[i].mission) {
    const w = buildMissionWorld(SCENARIOS[i].mission, opts.seed);
    w.__scenarioIndex = i;
    return w;
  }

  const name = SCENARIOS[i].name;
  const w = new World();
  w.scenarioName = name;
  w.briefing = SCENARIOS[i].briefing;
  w.debrief = SCENARIOS[i].debrief || {};
  w.objectives = (SCENARIOS[i].objectives || []).map((o) => ({ ...o, status: 'pending' }));

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
    // CVBG on station in the Eastern Med: carrier escorted by destroyers vs
    // two submerged diesel submarines.
    w.addShip('player', 'carrier', { x: 800, y: 2000 });
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
