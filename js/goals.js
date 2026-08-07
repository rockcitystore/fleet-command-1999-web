// goals.js — authentic Fleet Command (1999) GOAL-tree evaluation.
//
// The original .scc/.scs mission files carry a tree of GOAL blocks:
//
//   GOALTYPE 0  reach an area
//   GOALTYPE 1  recover / return-to-base
//   GOALTYPE 2  destroy a target down to DAMAGE %
//   GOALTYPE 3  aggregate (parent of other goals)
//
// PARENTGOALID links children to parents, so a mission's victory condition is
// really a boolean tree. tools/parse_scenarios.py extracts that tree verbatim
// into assets/data/missions.json; this module resolves each node's targets
// against the live world and folds the tree into a win/lose verdict.
//
// This module is intentionally dependency-free (pure functions over `world`)
// so engine.js can import it without a cycle.

// ---------------------------------------------------------------------------
// Target matching
// ---------------------------------------------------------------------------
// A goal's TARGET block can name a unit six different ways. We match on the
// most specific key present, mirroring how the original engine bound goals to
// entities at scenario load time.
const MATCH_ORDER = ['unique', 'shipname', 'group', 'cls', 'tag', 'country'];

function norm(s) {
  return String(s == null ? '' : s).trim().toUpperCase();
}

function unitMatches(u, target) {
  if (!target) return false;
  for (const key of MATCH_ORDER) {
    const want = target[key];
    if (want == null || want === '') continue;
    switch (key) {
      case 'unique':
        return norm(u.uid) === norm(want);
      case 'shipname':
        return norm(u.name) === norm(want);
      case 'group':
        return u.group != null && Number(u.group) === Number(want);
      case 'cls':
        return norm(u.cls) === norm(want);
      case 'tag':
        // Tags are loose class families ("Ohio SSBN", "Kilo"), so substring.
        return norm(u.cls).includes(norm(want)) || norm(u.name).includes(norm(want));
      case 'country':
        return norm(u.country) === norm(want);
      default:
        break;
    }
  }
  return false;
}

// Damage fraction 0..1 for a unit (1 = destroyed).
function damageFrac(s) {
  if (!s) return 1;
  if (!s.alive) return 1;
  const max = s.maxHp || 1;
  return Math.max(0, Math.min(1, 1 - s.hp / max));
}

// ---------------------------------------------------------------------------
// Binding: attach live ship/aircraft references to each goal, once, at world
// construction time. Called by engine.makeWorld after all units are spawned.
// ---------------------------------------------------------------------------
export function bindGoals(world, goals) {
  const bound = (goals || []).map((g) => ({ ...g, _units: [], status: 'pending' }));
  const all = [].concat(world.ships || [], world.aircraft || []);

  for (const g of bound) {
    if (!g.target || !Object.keys(g.target).length) continue;
    g._units = all.filter((u) => unitMatches(u, g.target));
  }

  // Children index for the aggregate fold.
  const byId = new Map(bound.map((g) => [g.id, g]));
  for (const g of bound) {
    g._children = bound.filter((c) => c.parent === g.id);
    g._parentRef = byId.get(g.parent) || null;
  }

  // Ownership: whose objective is this? SIDE 0 = player, 1 = enemy. 406 of the
  // 653 original goals leave SIDE unresolved ("?"), so infer it from the units
  // the goal actually points at: "destroy the enemy" is a player objective;
  // "destroy the player" is an enemy objective.
  for (const g of bound) g._owner = inferOwner(g);
  // Aggregates with unresolved ownership adopt their children's.
  for (const g of bound) {
    if (g._owner) continue;
    const kid = g._children.find((c) => c._owner);
    if (kid) g._owner = kid._owner;
  }
  for (const g of bound) {
    if (!g._owner && g._parentRef && g._parentRef._owner) g._owner = g._parentRef._owner;
  }

  // Deadline: the original stores absolute clock seconds; the playable window
  // is END - START. Zero / negative means "no time limit".
  for (const g of bound) {
    const span = Number(g.end) - Number(g.start);
    g._deadline = Number.isFinite(span) && span > 0 ? span : null;
  }

  // Recover goals need a home to come back to.
  for (const g of bound) {
    if (g.type !== 'recover') continue;
    g._home = g._units.length ? { x: g._units[0].pos.x, y: g._units[0].pos.y } : null;
    g._reached = false;
  }

  return bound;
}

// An aggregate node with no children isn't really an aggregate: the original
// uses it as a labelled marker whose TARGET (plus optional area) carries the
// real condition. These degenerate aggregates are overwhelmingly "destroy this
// unit" objectives in the shipped data (there are ZERO genuinely-typed REACH
// leaves in the 653-node tree). We therefore treat them as DESTROY: that is
// safe at t=0 (a freshly spawned unit is at full health, so the goal is
// 'pending', never spuriously 'ok'), and it matches the kill-driven win/loss
// conditions FC99 actually uses. Real REACH/RECOVER leaves keep their own type.
function effectiveKind(g) {
  if (g.type !== 'aggregate') return g.type;
  if (g._children && g._children.length) return 'aggregate';
  return 'destroy';
}

function inferOwner(g) {
  if (g.side === 0) return 'player';
  if (g.side === 1) return 'enemy';
  if (!g._units || !g._units.length) return null;
  const sides = new Set(g._units.map((u) => u.side));
  const kind = effectiveKind(g);
  if (kind === 'destroy') {
    // Destroying RED is a BLUE objective and vice versa.
    if (sides.has('enemy') && !sides.has('player')) return 'player';
    if (sides.has('player') && !sides.has('enemy')) return 'enemy';
    return null;
  }
  // reach / recover: the goal belongs to whoever owns the units that must move.
  if (sides.has('player')) return 'player';
  if (sides.has('enemy')) return 'enemy';
  return null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------
// Status vocabulary:
//   'ok'      — satisfied
//   'failed'  — permanently unachievable (deadline blown, escortee sunk)
//   'pending' — still in play
//   'na'      — the goal's targets never spawned (the original rolls a spawn
//               PROBABILITY per entity), so it can't count either way
function evalGoal(g, world) {
  const t = world.time || 0;

  if (g.type === 'aggregate' && g._children.length) {
    const kids = g._children.map((c) => evalGoal(c, world));
    if (kids.some((s) => s === 'failed')) return 'failed';
    const live = kids.filter((s) => s !== 'na');
    if (!live.length) return 'na';
    return live.every((s) => s === 'ok') ? 'ok' : 'pending';
  }

  const kind = effectiveKind(g);
  if (!g._units.length) return 'na';

  let ok = false;
  if (kind === 'destroy') {
    const need = (g.damage != null ? g.damage : 95) / 100;
    ok = g._units.every((u) => damageFrac(u) >= need);
  } else if (kind === 'reach') {
    const r = g.radius || 200;
    ok = g._units.some(
      (u) => u.alive && Math.hypot(u.pos.x - g.x, u.pos.y - g.y) <= r
    );
    // The escortee dying is an outright failure, not a stall.
    if (!ok && g._units.every((u) => !u.alive)) return 'failed';
  } else if (kind === 'recover') {
    const r = g.radius || 200;
    const at = g._units.some(
      (u) => u.alive && Math.hypot(u.pos.x - g.x, u.pos.y - g.y) <= r
    );
    if (at) g._reached = true;
    if (g._reached && g.returnToBase && g._home) {
      ok = g._units.some(
        (u) => u.alive && Math.hypot(u.pos.x - g._home.x, u.pos.y - g._home.y) <= r
      );
    } else {
      ok = g._reached;
    }
    if (!ok && g._units.every((u) => !u.alive)) return 'failed';
  }

  if (ok) return 'ok';
  if (g._deadline != null && t > g._deadline) return 'failed';
  return 'pending';
}

// Evaluate the whole tree and stamp `status` on every node.
export function evaluateGoals(world) {
  const goals = world.goals || [];
  for (const g of goals) g.status = evalGoal(g, world);
  return goals;
}

// The HUD only wants the top of the tree: root nodes owned by the player, or —
// if a root has children — the children, since those carry the readable text.
export function hudObjectives(world) {
  const goals = world.goals || [];
  const mine = goals.filter((g) => g._owner === 'player');
  const roots = mine.filter((g) => !g._parentRef || g._parentRef._owner !== 'player');
  const out = [];
  for (const r of roots) {
    if (r.status === 'na') continue;
    if (r._children && r._children.length > 1) {
      // Show the parent as the headline, children as the detail rows.
      out.push({ text: r.name, status: r.status });
      for (const c of r._children) {
        if (c.status === 'na') continue;
        out.push({ text: '   ' + c.name, status: c.status });
      }
    } else {
      out.push({ text: r.name, status: r.status });
    }
  }
  return out;
}

// Fold the tree into a verdict: 'playerWon' | 'enemyWon' | 'playing' | null
// (null = this mission has no usable goals, caller should fall back to the
// classic annihilation rule).
export function goalVerdict(world) {
  const goals = world.goals || [];
  if (!goals.length) return null;

  const mine = goals.filter((g) => g._owner === 'player' && g.status !== 'na');
  const theirs = goals.filter((g) => g._owner === 'enemy' && g.status !== 'na');

  // An enemy objective completing means we failed to stop them.
  if (theirs.some((g) => g.status === 'ok')) return 'enemyWon';

  if (!mine.length) return null;

  // Only the roots of the player's own sub-trees decide the mission; children
  // are already folded into their parents.
  const roots = mine.filter((g) => !g._parentRef || g._parentRef._owner !== 'player');
  if (!roots.length) return null;
  if (roots.some((g) => g.status === 'failed')) return 'enemyWon';
  if (roots.every((g) => g.status === 'ok')) return 'playerWon';
  return 'playing';
}

// Debrief text: the original mission files ship a SUCCESS / FAILURE line per
// goal. Pick the most relevant one for the end screen.
export function goalDebrief(world, victory) {
  const goals = world.goals || [];
  const mine = goals.filter((g) => g._owner === 'player');
  if (victory) {
    const done = mine.filter((g) => g.status === 'ok' && g.success);
    if (done.length) return done[0].success;
  } else {
    const bad = mine.filter((g) => g.status !== 'ok' && g.failure);
    if (bad.length) return bad[0].failure;
  }
  return null;
}
