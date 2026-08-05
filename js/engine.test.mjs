// Node tests for engine.js. Run: node js/engine.test.mjs  (from code/web/)
import * as E from './engine.js';

let passed = 0;
const failures = [];

function check(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failures.push(msg);
    console.error('FAIL: ' + msg);
  }
}

// ---------------------------------------------------------------------------
// 1. COORD ROUND-TRIP
// ---------------------------------------------------------------------------
{
  const cameras = [
    { zoom: 1.0, center: { x: 2000, y: 2000 } },
    { zoom: 3.0, center: { x: 1000, y: 1500 } },
    { zoom: 0.5, center: { x: 3500, y: 500 } },
  ];
  const points = [
    { x: 2000, y: 2000 },
    { x: 100, y: 3900 },
    { x: 1234, y: 567 },
  ];
  const size = { width: 900, height: 640 };
  for (const cam of cameras) {
    for (const p of points) {
      const s = E.worldToScreen(p, size, cam);
      const w = E.screenToWorld(s, size, cam);
      check(Math.abs(w.x - p.x) < 1e-6, `roundtrip x cam=${cam.zoom} p=${p.x},${p.y} got ${w.x}`);
      check(Math.abs(w.y - p.y) < 1e-6, `roundtrip y cam=${cam.zoom} p=${p.x},${p.y} got ${w.y}`);
    }
  }
  console.log('PASS: coord round-trip');
}

// ---------------------------------------------------------------------------
// 2. SHIP HIT-TEST
// ---------------------------------------------------------------------------
{
  const w = E.makeWorld(0);
  const size = { width: 900, height: 640 };
  const cam = w.camera;

  const ship = w.aliveShips('player')[0];
  const screenPos = E.worldToScreen(ship.pos, size, cam);
  const hit = E.shipAtScreen(screenPos, size, cam, w);
  check(hit && hit.id === ship.id, 'shipAtScreen returns the player ship at its screen pos');

  const corner = E.shipAtScreen({ x: 5, y: 5 }, size, cam, w);
  check(corner === undefined, 'shipAtScreen returns undefined at far corner (5,5)');

  const enemy = w.aliveShips('enemy')[0];
  const es = E.worldToScreen(enemy.pos, size, cam);
  const hitE = E.shipAtScreen(es, size, cam, w);
  check(hitE && hitE.id === enemy.id, 'shipAtScreen returns the enemy ship when clicking exactly on it');

  console.log('PASS: ship hit-test');
}

// ---------------------------------------------------------------------------
// 3. SCENARIO COUNTS  (driven by real .scs placements via REAL_PLACEMENTS)
// ---------------------------------------------------------------------------
{
  const RP = await import('./realdata.js');
  const place = RP.REAL_PLACEMENTS;
  for (let i = 0; i < 3; i++) {
    const w = E.makeWorld(i);
    const exp = place[i].length;
    check(w.ships.length === exp, `makeWorld(${i}) ships=${exp} got ${w.ships.length}`);
    const ep = place[i].filter((u) => u.side === 'player').length;
    const ee = place[i].filter((u) => u.side === 'enemy').length;
    check(w.aliveShips('player').length === ep, `makeWorld(${i}) players=${ep}`);
    check(w.aliveShips('enemy').length === ee, `makeWorld(${i}) enemies=${ee}`);
  }
  let lo, hi;
  try {
    lo = E.makeWorld(-5);
    hi = E.makeWorld(99);
  } catch (e) {
    check(false, 'makeWorld clamps out-of-range without throwing: ' + e);
  }
  check(lo && lo.ships.length === place[0].length, 'makeWorld(-5) clamps to scenario 0');
  check(hi && hi.ships.length === place[2].length, 'makeWorld(99) clamps to scenario 2');
  console.log('PASS: scenario counts');
}

// ---------------------------------------------------------------------------
// 4. SIMULATION ADVANCE (time-independent manual ticks)
// ---------------------------------------------------------------------------
{
  const w = E.makeWorld(0);
  w.resetSeed(12345);
  let threw = null;
  let inBounds = true;
  let phaseValid = true;
  try {
    for (let k = 0; k < 600; k++) {
      E.updateMovement(w, 1 / 60);
      E.updateDetection(w);
      E.updateWeapons(w, 1 / 60);
      E.updateProjectiles(w, 1 / 60);
      E.updateAI(w, 1 / 60);
      E.checkEnd(w);
    }
    for (const s of w.ships) {
      if (s.pos.x < 0 || s.pos.x > 4000 || s.pos.y < 0 || s.pos.y > 4000) inBounds = false;
    }
    if (!['playing', 'playerWon', 'enemyWon'].includes(w.phase)) phaseValid = false;
  } catch (e) {
    threw = e;
  }
  check(threw === null, '600 manual ticks ran without throwing' + (threw ? ': ' + threw : ''));
  check(inBounds, 'all ship positions stay within [0,4000]');
  check(phaseValid, `phase valid after sim (got ${w.phase})`);

  let randOk = true;
  for (let k = 0; k < 1000; k++) {
    const r = E.rand();
    if (!Number.isFinite(r) || r < 0 || r >= 1) randOk = false;
  }
  check(randOk, 'E.rand() always finite and in [0,1)');
  console.log('PASS: simulation advance');
}

// ---------------------------------------------------------------------------
// 5. DETERMINISM
// ---------------------------------------------------------------------------
{
  function runTicks(seed) {
    const w = E.makeWorld(1);
    w.resetSeed(seed);
    for (let k = 0; k < 300; k++) {
      E.updateMovement(w, 1 / 60);
      E.updateDetection(w);
      E.updateWeapons(w, 1 / 60);
      E.updateProjectiles(w, 1 / 60);
      E.updateAI(w, 1 / 60);
      E.checkEnd(w);
    }
    return w.aliveShips('player')[0].pos.x;
  }
  const a = runTicks(777);
  const b = runTicks(777);
  check(a === b, `determinism: first player ship pos.x bit-identical (${a} vs ${b})`);
  console.log('PASS: determinism');
}

// ---------------------------------------------------------------------------
// 6. MULTI-WAYPOINT ROUTE (ship transits a chain, arrives at the final node)
// ---------------------------------------------------------------------------
{
  const w = E.makeWorld(2);
  const ship = w.aliveShips('player')[0];
  ship.speed = 0;
  ship.pos.x = 500; ship.pos.y = 500;
  const route = [
    { x: 1200, y: 500 },
    { x: 1200, y: 1100 },
    { x: 1500, y: 1100 },
  ];
  w.issueOrder({ kind: 'moveTo', waypoints: route }, [ship.id]);

  // Legacy single-point form must still work (normalized to a 1-node chain).
  const wLegacy = E.makeWorld(2);
  const shL = wLegacy.aliveShips('player')[0];
  shL.pos.x = 500; shL.pos.y = 500; shL.speed = 0;
  wLegacy.issueOrder({ kind: 'moveTo', pos: { x: 1500, y: 500 } }, [shL.id]);
  E.updateMovement(wLegacy, 1 / 60);
  check(shL.order && shL.order.waypoints && shL.order.waypoints.length === 1,
    'legacy single-point moveTo is normalized to a 1-node waypoint chain');

  let passedWp1 = false, arrivedEnd = false, arrivalPos = null, decayTicks = 0;
  for (let k = 0; k < 12000; k++) {
    E.updateMovement(w, 1 / 60);
    if (!passedWp1 && ship.order && ship.order.wpIndex >= 1) passedWp1 = true;
    if (!ship.order) {
      if (!arrivedEnd) { arrivedEnd = true; arrivalPos = { x: ship.pos.x, y: ship.pos.y }; }
      // Let the ship coast to a stop at the final node before measuring speed.
      if (++decayTicks > 300) break;
    }
  }
  check(passedWp1, 'ship advanced past the first waypoint (wpIndex >= 1)');
  check(arrivedEnd, 'ship completed the multi-waypoint route (order cleared at final waypoint)');
  check(Math.abs(arrivalPos.x - 1500) < 60 && Math.abs(arrivalPos.y - 1100) < 60,
    `ship ended near final waypoint (got ${arrivalPos.x.toFixed(0)},${arrivalPos.y.toFixed(0)})`);
  check(Math.abs(ship.speed) < 1, `ship speed decays to ~0 after arrival (got ${ship.speed.toFixed(2)})`);

  // Patrol (loop) re-arms at the first waypoint instead of ending.
  const w2 = E.makeWorld(2);
  const sh2 = w2.aliveShips('player')[0];
  sh2.pos.x = 500; sh2.pos.y = 500; sh2.speed = 0;
  w2.issueOrder({ kind: 'moveTo', waypoints: [{ x: 800, y: 500 }, { x: 800, y: 800 }], loop: true }, [sh2.id]);
  let cycles = 0, prevIdx = 0;
  for (let k = 0; k < 6000; k++) {
    E.updateMovement(w2, 1 / 60);
    const idx = sh2.order ? (sh2.order.wpIndex || 0) : -1;
    if (idx === 0 && prevIdx > 0) cycles++;
    if (idx >= 0) prevIdx = idx;
  }
  check(cycles >= 2, `patrol loop re-armed at least twice (got ${cycles})`);
  console.log('PASS: multi-waypoint + patrol route');
}

// ---------------------------------------------------------------------------
// 7. AIRCRAFT: parked air wings, launch, transit, recover, fuel bingo
// ---------------------------------------------------------------------------
{
  const w = E.makeWorld(0);
  const airport = w.ships.find((s) => s.name === 'Airport' && s.side === 'player');
  check(!!airport, 'scenario 0 has a player Airport platform');
  check(airport.aircraft.length === 4 && airport.aircraft.every((a) => a.state === 'parked'),
    'Airport starts with 4 parked P-3 Orion airframes');
  check(w.aircraft.length === 0, 'no aircraft airborne at scenario start');

  const ac = w.launchAircraft(airport.id, airport.aircraft[0].id, 'ASW',
    [{ x: 800, y: 2184, alt: 600 }, { x: 800, y: 2600, alt: 600 }]);
  check(!!ac && ac.state === 'airborne' && ac.mission === 'ASW', 'launch creates an airborne ASW aircraft');
  check(ac.order.waypoints.length === 2, 'aircraft carries the 2-node flight plan');
  check(w.aircraft.length === 1 && airport.aircraft.length === 3,
    'launched frame moved from parked list to airborne list');

  // Transit: it should climb and advance along the route.
  let passed = false;
  for (let k = 0; k < 1200; k++) {
    E.updateAircraft(w, 1 / 60);
    E.updateDetection(w);
    if (ac.order && ac.order.wpIndex >= 1) { passed = true; break; }
  }
  check(passed, 'aircraft advanced past the first waypoint');
  check(ac.alt > 100, `aircraft climbed to altitude (got ${ac.alt.toFixed(0)})`);
  check(ac.pos.x > 300, `aircraft translated toward its route (x=${ac.pos.x.toFixed(0)})`);

  // Recover: command RTB, it should land and re-park.
  w.recoverAircraft(ac.id);
  let reParked = false;
  for (let k = 0; k < 2000; k++) {
    E.updateAircraft(w, 1 / 60);
    if (!w.aircraft.find((a) => a.id === ac.id) && airport.aircraft.find((a) => a.id === ac.id && a.state === 'parked')) {
      reParked = true; break;
    }
  }
  check(reParked, 'recovered aircraft re-parks on its home platform');

  // No automatic fuel bingo (faithful to FC99: RTB is an explicit command).
  // A low-fuel aircraft must stay airborne until the player orders RTB (or it
  // runs dry and is lost) — it must NOT silently abandon its flight plan.
  const ac2 = w.launchAircraft(airport.id, airport.aircraft[0].id, 'patrol', null);
  ac2.fuel = ac2.maxFuel * 0.1; // 10% — below the old 15% auto-bingo threshold
  for (let k = 0; k < 120; k++) E.updateAircraft(w, 1 / 60); // ~2s
  check(ac2.state !== 'rtb' && ac2.alive, 'low-fuel aircraft does NOT auto-RTB (explicit RTB only)');

  // Ammo bingo: an aircraft with empty ordnance auto-returns to base.
  const ac3 = w.launchAircraft(airport.id, airport.aircraft[0].id, 'ASW', null);
  check(ac3.ordnance > 0 && ac3.weapon, 'ASW aircraft carries ordnance + a weapon');
  ac3.ordnance = 0; // spent
  let ammoParked = false;
  for (let k = 0; k < 600; k++) {
    E.updateAircraft(w, 1 / 60);
    if (!w.aircraft.find((a) => a.id === ac3.id) && airport.aircraft.find((a) => a.id === ac3.id && a.state === 'parked')) {
      ammoParked = true; break;
    }
  }
  check(ammoParked, 'empty-ordnance aircraft auto-RTB (ammo bingo) and recovers');
  console.log('PASS: aircraft launch/transit/recover/fuel/ammo');
}

// ---------------------------------------------------------------------------
// 8. WAYPOINT DRAG: hit-test + coordinate update (engine primitives)
// ---------------------------------------------------------------------------
{
  const w = E.makeWorld(0);
  const airport = w.ships.find((s) => s.name === 'Airport' && s.side === 'player');
  const ac = w.launchAircraft(airport.id, airport.aircraft[0].id, 'patrol', null);
  w.__selectedAircraft = [ac.id];
  const cam = { zoom: 1, center: { x: 2000, y: 2000 } };
  const size = { width: 1000, height: 800 };
  const wp0 = ac.order.waypoints[0];
  const sp = E.worldToScreen(wp0, size, cam);
  const hit = E.waypointAtScreen(sp, size, cam, w);
  check(hit && hit.index === 0, 'waypointAtScreen finds the grabbed waypoint');

  // Simulate a drag: move it 200px to the right and write the world coord back.
  const moved = { x: sp.x + 200, y: sp.y };
  const wNew = E.screenToWorld(moved, size, cam);
  ac.order.waypoints[hit.index].x = wNew.x;
  ac.order.waypoints[hit.index].y = wNew.y;
  check(Math.abs(ac.order.waypoints[0].x - wNew.x) < 1e-6, 'dragging updates the waypoint world coord');
  console.log('PASS: waypoint drag hit-test + update');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nChecks passed: ${passed}`);
if (failures.length === 0) {
  console.log('ALL TESTS PASSED');
} else {
  console.error(`FAILURES (${failures.length}):`);
  for (const f of failures) console.error(' - ' + f);
  process.exit(1);
}
