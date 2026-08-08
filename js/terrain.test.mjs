// Tests for terrain sea-route path planning (planSeaRoute / nearestSea).
// The original Fleet Command '99 had no automatic land-avoidance; these verify
// our added planner re-routes blocked moves around a coastline.
import {
  setLand, isPointOnLand, distToLand, nearestSea, planSeaRoute,
  elevationAt, getContourSegments,
} from './terrain.js';

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error('  FAIL:', msg); }
}
function approx(a, b, eps = 1e-6) { return Math.abs(a - b) <= eps; }
function segClear(ax, ay, bx, by) {
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / 10));
  for (let s = 0; s <= steps; s++) {
    const t = s / steps;
    if (isPointOnLand(ax + (bx - ax) * t, ay + (by - ay) * t)) return false;
  }
  return true;
}

// A 400x400-unit square "island" centred in the world (x,y in [1800,2200]).
const ISLAND = [[
  { x: 1800, y: 1800 }, { x: 2200, y: 1800 },
  { x: 2200, y: 2200 }, { x: 1800, y: 2200 },
]];
setLand(ISLAND);

// --- 1) open-water move: clear line of sight -> single waypoint (goal) ------
{
  const route = planSeaRoute({ x: 500, y: 500 }, { x: 900, y: 500 }, { margin: 20 });
  ok(route.length === 1, `open-water should be a single waypoint, got ${route.length}`);
  ok(route[0] && approx(route[0].x, 900) && approx(route[0].y, 500),
     `open-water waypoint should equal goal, got ${JSON.stringify(route[0])}`);
}

// --- 2) blocked move: land between start and goal -> multi-waypoint, at sea --
{
  const start = { x: 1000, y: 2000 };
  const goal = { x: 3000, y: 2000 };
  const route = planSeaRoute(start, goal, { margin: 20 });
  ok(route.length >= 2, `blocked move should re-route (>=2 waypoints), got ${route.length}`);
  // Every waypoint is at sea.
  let allSea = true;
  for (const w of route) if (isPointOnLand(w.x, w.y)) allSea = false;
  ok(allSea, 'every routed waypoint must be at sea');
  // The whole polyline (start -> waypoints) stays clear of land.
  let path = [start, ...route];
  let clear = true;
  for (let i = 1; i < path.length; i++) {
    if (!segClear(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y)) clear = false;
  }
  ok(clear, 'routed polyline must not cross land');
  // Last waypoint is the (sea-snapped) goal.
  const last = route[route.length - 1];
  ok(approx(last.x, 3000, 1e-6) && approx(last.y, 2000, 1e-6),
     `last waypoint should be goal, got ${JSON.stringify(last)}`);
  // The straight shot really was blocked (sanity of the test setup).
  ok(!segClear(start.x, start.y, goal.x, goal.y), 'test setup: straight line must cross the island');
}

// --- 3) nearestSea snaps a land point to sea --------------------------------
{
  const onLand = { x: 2000, y: 2000 }; // island centre
  ok(isPointOnLand(onLand.x, onLand.y), 'precondition: centre is on land');
  const sea = nearestSea(onLand.x, onLand.y, 20);
  ok(!isPointOnLand(sea.x, sea.y), 'nearestSea result must be at sea');
  ok(distToLand(sea.x, sea.y) >= 20 - 1e-6, `nearestSea should honour margin (got ${distToLand(sea.x, sea.y).toFixed(1)})`);
}

// --- 4) clicking on land still yields a usable (sea) destination ------------
{
  const route = planSeaRoute({ x: 1000, y: 2000 }, { x: 2000, y: 2000 }, { margin: 20 });
  ok(route.length >= 1, 'land-click goal must still produce a route');
  const last = route[route.length - 1];
  ok(!isPointOnLand(last.x, last.y), 'land-click route must end at sea');
}

// --- 5) no land at all -> straight, single waypoint -------------------------
{
  setLand([]); // clears land
  const route = planSeaRoute({ x: 100, y: 100 }, { x: 900, y: 900 }, { margin: 20 });
  ok(route.length === 1, `empty world should be a single waypoint, got ${route.length}`);
  ok(approx(route[0].x, 900) && approx(route[0].y, 900), 'empty-world waypoint == goal');
}

// --- 6) procedural DEM + contour lines ------------------------------------
{
  setLand(ISLAND); // rebuild the elevation field on a known island
  const coastElev = elevationAt(1820, 2000); // ~20 units inside the 1800..2200 coast
  const midElev = elevationAt(2000, 2000);   // island centre
  ok(midElev > coastElev, `elevation should rise inland (centre ${midElev.toFixed(0)} > coast ${coastElev.toFixed(0)})`);
  ok(coastElev >= 0, 'coastal elevation must be non-negative');
  const segs = getContourSegments(100);
  ok(Array.isArray(segs) && segs.length > 0, `contour segments should be produced (got ${segs ? segs.length : 'null'})`);
  let inside = true;
  for (const s of segs) {
    if (s.x1 < 1800 || s.x1 > 2200 || s.y1 < 1800 || s.y1 > 2200) inside = false;
    if (s.x2 < 1800 || s.x2 > 2200 || s.y2 < 1800 || s.y2 > 2200) inside = false;
  }
  ok(inside, 'contour segment endpoints stay within the island bbox');
  ok(getContourSegments(100) === segs, 'getContourSegments should cache by interval');
}

console.log(`\nChecks passed: ${passed}` + (failed ? `  (${failed} FAILED)` : ''));
if (failed) process.exit(1);
console.log('ALL TERRAIN NAV CHECKS PASSED');
