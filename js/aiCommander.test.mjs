// aiCommander.test.mjs — verify each side's LLM commander DIRECTLY controls its
// own ships, and that only the player (BLUE) commander may open the war.
import { World } from './engine.js';
import { AICommander } from './aiCommander.js';

let pass = 0, fail = 0;
function check(cond, msg) {
  if (cond) { pass++; console.log('PASS:', msg); }
  else { fail++; console.error('FAIL:', msg); }
}

function makeWorld() {
  const w = new World();
  const p = w.addShip('player', 'destroyer', { x: 800, y: 2000 });
  const e = w.addShip('enemy', 'destroyer', { x: 3200, y: 2000 });
  return { w, p, e };
}

// A transport that ignores the prompt and returns a fixed JSON array of orders.
function fixedTransport(orders) {
  return async (_messages, _opts) => JSON.stringify(orders);
}

async function testRedCannotOpenWar() {
  const { w, p, e } = makeWorld();
  w.combatStarted = false;
  const c = new AICommander({ side: 'enemy', streaming: false, transport: fixedTransport([
    { ship: e.id, act: 'attack', target: p.id },
  ]) });
  c.setEnabled(true);
  await c.tick(w, { force: true });
  // RED attack pre-combat must be downgraded to a hold; war must NOT start.
  check(w.combatStarted === false, 'RED cannot open the war (combatStarted stays false)');
  check(e.order == null || e.order.kind !== 'attack', 'RED attack order downgraded to hold pre-combat');
  check(p.targetId == null, 'BLUE ship not attacked by RED pre-combat');
}

async function testRedControlsEnemyPostCombat() {
  const { w, p, e } = makeWorld();
  w.combatStarted = true;
  const c = new AICommander({ side: 'enemy', streaming: false, transport: fixedTransport([
    { ship: e.id, act: 'attack', target: p.id },
  ]) });
  c.setEnabled(true);
  await c.tick(w, { force: true });
  check(e.order && e.order.kind === 'attack' && e.targetId === p.id, 'RED commander applies attack to its own enemy ship');
  // RED must ignore an order that names a player ship as the ship-to-control.
  const c2 = new AICommander({ side: 'enemy', streaming: false, transport: fixedTransport([
    { ship: p.id, act: 'attack', target: e.id },
  ]) });
  c2.setEnabled(true); await c2.tick(w, { force: true });
  check(p.order == null || p.order.kind !== 'attack', 'RED commander ignores orders naming a player ship');
}

async function testBlueDirectlyControlsAndOpensWar() {
  const { w, p, e } = makeWorld();
  w.combatStarted = false;
  const c = new AICommander({ side: 'player', streaming: false, transport: fixedTransport([
    { ship: p.id, act: 'attack', target: e.id },
  ]) });
  c.setEnabled(true);
  await c.tick(w, { force: true });
  // BLUE (player) commander MAY open the war.
  check(w.combatStarted === true, 'BLUE commander may open the war (combatStarted set true)');
  check(p.order && p.order.kind === 'attack' && p.targetId === e.id, 'BLUE commander applies attack to its own player ship');
  check(e.targetId == null, 'enemy ship not told to attack itself');
}

async function testBlueMoveOrder() {
  const { w, p } = makeWorld();
  w.combatStarted = true;
  const c = new AICommander({ side: 'player', streaming: false, transport: fixedTransport([
    { ship: p.id, act: 'move', pos: { x: 1200, y: 2400 } },
  ]) });
  c.setEnabled(true);
  await c.tick(w, { force: true });
  check(p.order && p.order.kind === 'moveTo' && p.order.waypoints.length === 1, 'BLUE commander issues a moveTo order');
  check(p.order.waypoints[0].x === 1200 && p.order.waypoints[0].y === 2400, 'BLUE move order uses the commanded position');
}

async function testBlueFallbackDoctrine() {
  const { w, p, e } = makeWorld();
  w.combatStarted = true;
  // Empty orders -> fall back to built-in player doctrine, must not throw and
  // must leave the player ship with some order (not crash).
  const c = new AICommander({ side: 'player', streaming: false, transport: fixedTransport([]) });
  c.setEnabled(true);
  await c.tick(w, { force: true });
  check(c.lastBrief.includes('built-in'), 'BLUE commander falls back to built-in doctrine on empty orders');
}

await testRedCannotOpenWar();
await testRedControlsEnemyPostCombat();
await testBlueDirectlyControlsAndOpensWar();
await testBlueMoveOrder();
await testBlueFallbackDoctrine();

console.log(`\nChecks passed: ${pass}` + (fail ? `  FAILED: ${fail}` : ''));
process.exit(fail ? 1 : 0);
