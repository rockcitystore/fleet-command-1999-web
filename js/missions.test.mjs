// missions.test.mjs — every original Fleet Command '99 scenario must build a
// playable world with a resolvable GOAL tree.
//
// Run: node js/missions.test.mjs

import { readFileSync } from 'node:fs';
import * as E from './engine.js';
import { bindGoals, evaluateGoals, hudObjectives, goalVerdict } from './goals.js';

let pass = 0;
let fail = 0;
function check(cond, label) {
  if (cond) { pass++; } else { fail++; console.error('FAIL: ' + label); }
}
function section(t) { console.log('\n--- ' + t + ' ---'); }

const payload = JSON.parse(readFileSync(new URL('../assets/data/missions.json', import.meta.url), 'utf8'));

section('library');
check(payload.missions.length === 39, `39 missions parsed (got ${payload.missions.length})`);
check(payload.missions.every((m) => m.title && m.title.length), 'every mission has a title');
check(payload.missions.filter((m) => m.kind === 'region').length === 4, '4 region theatres');
check(payload.missions.filter((m) => m.kind === 'single').length === 35, '35 single missions');

const before = E.SCENARIOS.length;
E.registerMissions(payload);
check(E.SCENARIOS.length === 39, `registerMissions swaps the campaign track (${before} -> ${E.SCENARIOS.length})`);
check(E.SCENARIOS[0].mission && E.SCENARIOS[0].mission.kind === 'region', 'regions sort first');
check(E.SCENARIOS.every((s) => s.briefing && s.briefing.title), 'every scenario carries a briefing');
check(E.SCENARIOS.every((s) => (s.objectives || []).length > 0), 'every scenario shows objectives on the briefing screen');

section('world construction');
let totalShips = 0;
let totalAir = 0;
let neutralTotal = 0;
let goalsBound = 0;
let missionsWithVerdict = 0;
const problems = [];

for (let i = 0; i < E.SCENARIOS.length; i++) {
  const m = E.SCENARIOS[i].mission;
  let w;
  try {
    w = E.makeWorld(i, { seed: 7 });
  } catch (err) {
    problems.push(`${m.id}: makeWorld threw ${err && err.message}`);
    continue;
  }
  if (!w.ships.length) problems.push(`${m.id}: no ships spawned`);
  totalShips += w.ships.length;
  totalAir += w.aircraft.length;
  neutralTotal += w.ships.filter((s) => s.side === 'neutral').length;

  // Positions must be finite and inside the world box.
  for (const s of w.ships) {
    if (!Number.isFinite(s.pos.x) || !Number.isFinite(s.pos.y)) {
      problems.push(`${m.id}: ${s.name} has non-finite position`);
      break;
    }
    if (s.pos.x < -500 || s.pos.x > E.WORLD_SIZE + 500 || s.pos.y < -500 || s.pos.y > E.WORLD_SIZE + 500) {
      problems.push(`${m.id}: ${s.name} spawned far outside the world box (${s.pos.x},${s.pos.y})`);
      break;
    }
  }
  if (!w.geo || !Number.isFinite(w.geo.lat)) problems.push(`${m.id}: no geography`);
  if (w.goals && w.goals.length) goalsBound++;

  // Nothing should be decided before the first tick.
  E.checkEnd(w);
  if (w.phase !== 'playing') problems.push(`${m.id}: mission already over at t=0 (${w.phase})`);
  if (goalVerdict(w) !== null) missionsWithVerdict++;
}

check(problems.length === 0, 'all 39 missions build cleanly:\n    ' + problems.slice(0, 12).join('\n    '));
check(totalShips > 900, `spawned a large order of battle (${totalShips} hulls across 39 missions)`);
check(totalAir > 100, `spawned in-flight aircraft (${totalAir})`);
check(neutralTotal > 100, `neutral traffic present (${neutralTotal} merchants/civilians)`);
check(goalsBound >= 39, `every mission bound its goal tree (${goalsBound}/39)`);
check(missionsWithVerdict >= 30, `most missions resolve a real goal verdict (${missionsWithVerdict}/39)`);

section('neutral rules of engagement');
{
  const idx = E.SCENARIOS.findIndex((s) => s.mission && s.mission.counts.neutral > 0);
  const w = E.makeWorld(idx, { seed: 3 });
  const neutral = w.ships.find((s) => s.side === 'neutral');
  const player = w.ships.find((s) => s.side === 'player');
  const enemy = w.ships.find((s) => s.side === 'enemy');
  check(!!neutral, 'mission contains a neutral contact');
  check(E.isHostile(player, enemy) === true, 'BLUE and RED are mutually hostile');
  check(E.isHostile(player, neutral) === false, 'BLUE never treats NEUTRAL as hostile');
  check(E.isHostile(enemy, neutral) === false, 'RED never treats NEUTRAL as hostile');

  // Park the neutral right on top of a red shooter and run the AI: it must not
  // be picked as a target.
  if (neutral && enemy) {
    neutral.pos.x = enemy.pos.x + 5;
    neutral.pos.y = enemy.pos.y + 5;
    neutral.detected = true;
    neutral.seenByEnemy = true;
    w.combatStarted = true;
    E.runBuiltinDoctrine(w);
    const targeted = w.ships.some((s) => s.side === 'enemy' && s.targetId === neutral.id);
    check(!targeted, 'RED doctrine never targets a neutral merchant');
  }
}

section('goal tree evaluation — Wyoming Deploys');
{
  const idx = E.SCENARIOS.findIndex((s) => s.mission && s.mission.id === 'Single07');
  check(idx >= 0, 'Single07 is in the library');
  const w = E.makeWorld(idx, { seed: 1 });
  const destroyGoals = w.goals.filter((g) => g.type === 'destroy');
  check(destroyGoals.length === 2, `two destroy goals (Victor III + Akula), got ${destroyGoals.length}`);
  check(destroyGoals.every((g) => g._units.length === 1), 'both destroy goals bound to exactly one hull');
  check(destroyGoals.every((g) => g._units[0].side === 'enemy'), 'destroy targets are RED hulls');
  check(destroyGoals.every((g) => g._owner === 'player'), 'unresolved SIDE inferred as a player objective');

  const objs = hudObjectives(w);
  check(objs.length > 0, `HUD shows objectives (${objs.map((o) => o.text.trim()).join(' | ')})`);
  check(objs.every((o) => o.status === 'pending'), 'nothing is complete at t=0');

  // Sink both Russian boats -> the aggregate parent must flip to ok.
  for (const g of destroyGoals) for (const u of g._units) { u.alive = false; u.hp = 0; }
  evaluateGoals(w);
  check(destroyGoals.every((g) => g.status === 'ok'), 'both destroy goals satisfied once the boats are sunk');
  const parent = w.goals.find((g) => g.name === 'Russ_subs Destroyed');
  check(parent && parent.status === 'ok', 'aggregate parent folds its children');
}

section('goal tree evaluation — deadline failure');
{
  const idx = E.SCENARIOS.findIndex((s) => s.mission && s.mission.id === 'Single07');
  const w = E.makeWorld(idx, { seed: 1 });
  const g = w.goals.find((x) => x.type === 'destroy');
  check(g && g._deadline > 0, `destroy goal carries a time limit (${g && g._deadline}s)`);
  w.time = (g._deadline || 0) + 1;
  evaluateGoals(w);
  check(g.status === 'failed', 'a blown deadline fails the goal');
  E.checkEnd(w);
  check(w.phase === 'enemyWon', 'a failed player objective loses the mission');
}

section('victory path');
{
  const idx = E.SCENARIOS.findIndex((s) => s.mission && s.mission.id === 'Single07');
  const w = E.makeWorld(idx, { seed: 1 });
  // Satisfy every player objective the tree exposes. Degenerate aggregates
  // (no children) are evaluated as DESTROY by the engine, so kill their units.
  for (const g of w.goals) {
    if (g._owner !== 'player') continue;
    if (g.type === 'destroy' || (g.type === 'aggregate' && !g._children.length)) {
      for (const u of g._units) { u.alive = false; u.hp = 0; }
    } else if (g.radius && g._units.length) {
      for (const u of g._units) { u.pos.x = g.x; u.pos.y = g.y; }
    }
  }
  evaluateGoals(w);
  E.checkEnd(w);
  check(w.phase === 'playerWon', `all objectives met -> victory (got ${w.phase})`);
  check(!!w.debrief.win, 'victory pulls the authentic SUCCESS text from the mission file');
}

section('spawn probability determinism');
{
  const idx = E.SCENARIOS.findIndex((s) => s.mission && s.mission.id === 'Single15');
  const a = E.makeWorld(idx, { seed: 42 });
  const b = E.makeWorld(idx, { seed: 42 });
  check(a.ships.length === b.ships.length, 'same seed -> same order of battle');
  const c = E.makeWorld(idx, { seed: 43 });
  check(Number.isFinite(c.ships.length), 'a different seed still builds');
}

console.log(`\nChecks passed: ${pass}`);
if (fail) {
  console.error(`Checks FAILED: ${fail}`);
  process.exit(1);
}
console.log('ALL MISSION CHECKS PASSED');
