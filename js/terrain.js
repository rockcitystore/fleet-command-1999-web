// Shared terrain data + collision helpers.
//
// Land is now REAL coastline geometry (see geo.js / ne_land.js): an array of
// polygons in WORLD units. The polygons are set per-scenario via setLand().
// Each polygon carries a precomputed bbox so collision tests stay cheap even
// with detailed coastlines.

let LAND_POLYGONS = []; // [{ pts: [{x,y}...], bbox: {xMin,xMax,yMin,yMax} }]
let _landVersion = 0;    // bumped on every setLand so the cached sea grid invalidates

// Mirror of engine.WORLD_SIZE (4000). Kept local on purpose: importing it from
// engine.js would create a circular dependency (engine -> terrain -> engine)
// that is fragile under the test harness. The value is a fixed project constant.
const WORLD_SIZE = 4000;

export function setLand(polygons) {
  _landVersion++;
  LAND_POLYGONS = (polygons || []).map((pts) => {
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const p of pts) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
    return { pts, bbox: { xMin, xMax, yMin, yMax } };
  });
  // Rebuild the elevation / contour field whenever the coastline changes.
  _buildDEM();
}

export function getLand() {
  return LAND_POLYGONS;
}

// ---------------------------------------------------------------------------
// Procedural elevation field (DEM) + contour lines.
//
// The original Fleet Command '99 had no terrain elevation — only a flat
// coastline. We synthesise a believable land relief offline (no network, no
// external tiles) so both the 2D tactical map and the 3D view can show
// terrain and contour lines in the game's own military-green palette:
//
//   elevation(x,y)  ~  distanceToCoast * SLOPE  +  fractal noise
//
// i.e. land rises inland from the shoreline and is roughened by value-noise
// fbm, the way a coastal range would. Sea cells carry a small negative value
// (shoal) so the 3D mesh can dip naturally below the waterline at the coast.
// This keeps the look consistent with the existing flat-green land fill and
// avoids pulling in OpenStreetMap raster tiles (which would need a live tile
// server and would override the CIC colour scheme with street-map imagery).
// ---------------------------------------------------------------------------

const TERRAIN_CELL = 24;          // world units per DEM cell (≈2.2 km)
const SLOPE_M_PER_UNIT = 1.0;     // metres of rise per world-unit inland
const NOISE_AMP_M = 75;           // fbm roughness amplitude (metres)
const MAX_ELEV_M = 850;           // cap on synthesised peak elevation
const TERRAIN_SEED = 1337;

let _dem = null;

// Deterministic hashed value-noise (no Math.random -> stable per scenario).
function _hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 1442695040)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 4294967296; // 0..1
}
function _valueNoise(x, y, seed) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const n00 = _hash2(x0, y0, seed), n10 = _hash2(x0 + 1, y0, seed);
  const n01 = _hash2(x0, y0 + 1, seed), n11 = _hash2(x0 + 1, y0 + 1, seed);
  const nx0 = n00 + (n10 - n00) * sx, nx1 = n01 + (n11 - n01) * sx;
  return nx0 + (nx1 - nx0) * sy; // 0..1
}
function _fbm(x, y, seed) {
  let f = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 4; o++) {
    f += amp * (_valueNoise(x * freq, y * freq, seed + o * 17) - 0.5);
    freq *= 2; amp *= 0.5;
  }
  return f; // ~ -1..1
}

function _buildDEM() {
  const cell = TERRAIN_CELL;
  const cols = Math.ceil(WORLD_SIZE / cell) + 1;
  const rows = Math.ceil(WORLD_SIZE / cell) + 1;
  const onLand = new Uint8Array(cols * rows);
  const dist = new Float32Array(cols * rows); // world-unit distance to sea
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = c * cell, y = r * cell;
      if (isPointOnLand(x, y)) { onLand[r * cols + c] = 1; dist[r * cols + c] = Infinity; }
      else dist[r * cols + c] = 0; // sea is the distance seed (0)
    }
  }
  // Two-pass 8-connected chamfer distance transform (cheap, good enough).
  const D1 = 1, D2 = Math.SQRT2;
  for (let pass = 0; pass < 2; pass++) {
    const r0 = pass === 0 ? 0 : rows - 1, r1 = pass === 0 ? rows : -1, dr = pass === 0 ? 1 : -1;
    for (let r = r0; r !== r1; r += dr) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (dist[i] === 0) continue;
        let m = dist[i];
        if (r > 0) {
          if (c > 0) m = Math.min(m, dist[(r - 1) * cols + c - 1] + D2);
          m = Math.min(m, dist[(r - 1) * cols + c] + D1);
          if (c < cols - 1) m = Math.min(m, dist[(r - 1) * cols + c + 1] + D2);
        }
        if (c > 0) m = Math.min(m, dist[r * cols + c - 1] + D1);
        if (c < cols - 1) m = Math.min(m, dist[r * cols + c + 1] + D1);
        if (r < rows - 1) {
          if (c > 0) m = Math.min(m, dist[(r + 1) * cols + c - 1] + D2);
          m = Math.min(m, dist[(r + 1) * cols + c] + D1);
          if (c < cols - 1) m = Math.min(m, dist[(r + 1) * cols + c + 1] + D2);
        }
        dist[i] = m;
      }
    }
  }
  const h = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      if (!onLand[i]) { h[i] = -3; continue; } // shoal below waterline
      const x = c * cell, y = r * cell;
      let e = dist[i] * cell * SLOPE_M_PER_UNIT + _fbm(x / 240, y / 240, TERRAIN_SEED) * NOISE_AMP_M;
      if (e < 0) e = 0;
      if (e > MAX_ELEV_M) e = MAX_ELEV_M;
      h[i] = e;
    }
  }
  _dem = { cell, cols, rows, h, onLand, maxH: MAX_ELEV_M };
}

// Bilinear sample of the elevation field, in metres (negative = sea/shoal).
export function elevationAt(x, y) {
  if (!_dem) _buildDEM();
  const { cell, cols, rows, h } = _dem;
  const fx = x / cell, fy = y / cell;
  let c0 = Math.floor(fx), r0 = Math.floor(fy);
  c0 = Math.max(0, Math.min(cols - 1, c0));
  r0 = Math.max(0, Math.min(rows - 1, r0));
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const tx = fx - c0, ty = fy - r0;
  const h00 = h[r0 * cols + c0], h10 = h[r0 * cols + c1];
  const h01 = h[r1 * cols + c0], h11 = h[r1 * cols + c1];
  const a = h00 + (h10 - h00) * tx, b = h01 + (h11 - h01) * tx;
  return a + (b - a) * ty;
}

// Marching-squares contour lines at `interval` metres, returned as world-space
// segments {x1,y1,x2,y2,level}. Cached per (land version, interval).
let _contourCache = { key: null, segs: null };
export function getContourSegments(interval = 100) {
  if (!_dem) _buildDEM();
  const key = _landVersion + '|' + interval;
  if (_contourCache.key === key && _contourCache.segs) return _contourCache.segs;
  const { cell, cols, rows, h, onLand, maxH } = _dem;
  const segs = [];
  const lerp = (ax, ay, av, bx, by, bv, L) => {
    const t = (L - av) / (bv - av || 1e-6);
    return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t };
  };
  for (let r = 0; r < rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const i = r * cols + c;
      if (!onLand[i] && !onLand[i + 1] && !onLand[i + cols] && !onLand[i + cols + 1]) continue;
      const x0 = c * cell, y0 = r * cell, x1 = x0 + cell, y1 = y0 + cell;
      const v00 = h[i], v10 = h[i + 1], v01 = h[i + cols], v11 = h[i + cols + 1];
      for (let L = interval; L <= maxH; L += interval) {
        const xs = [];
        if ((v00 > L) !== (v10 > L)) xs.push(lerp(x0, y0, v00, x1, y0, v10, L));
        if ((v10 > L) !== (v11 > L)) xs.push(lerp(x1, y0, v10, x1, y1, v11, L));
        if ((v11 > L) !== (v01 > L)) xs.push(lerp(x1, y1, v11, x0, y1, v01, L));
        if ((v01 > L) !== (v00 > L)) xs.push(lerp(x0, y1, v01, x0, y0, v00, L));
        if (xs.length === 2) segs.push({ x1: xs[0].x, y1: xs[0].y, x2: xs[1].x, y2: xs[1].y, level: L });
        else if (xs.length === 4) {
          segs.push({ x1: xs[0].x, y1: xs[0].y, x2: xs[1].x, y2: xs[1].y, level: L });
          segs.push({ x1: xs[2].x, y1: xs[2].y, x2: xs[3].x, y2: xs[3].y, level: L });
        }
      }
    }
  }
  _contourCache = { key, segs };
  return segs;
}

function pointInPolygon(px, py, poly) {
  const pts = poly.pts;
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i].x, yi = pts[i].y;
    const xj = pts[j].x, yj = pts[j].y;
    const intersect = (yi > py) !== (yj > py) &&
      px < ((xj - xi) * (py - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointOnLand(x, y) {
  for (const poly of LAND_POLYGONS) {
    const b = poly.bbox;
    if (x < b.xMin || x > b.xMax || y < b.yMin || y > b.yMax) continue;
    if (pointInPolygon(x, y, poly)) return true;
  }
  return false;
}

// Return a safe position near `pos` that is not inside land. If `pos` is
// already safe, return it unchanged. Otherwise walk back toward `from`.
export function snapToSea(pos, from, steps = 12) {
  if (!isPointOnLand(pos.x, pos.y)) return { x: pos.x, y: pos.y };
  const dx = pos.x - from.x;
  const dy = pos.y - from.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = from.x + dx * (1 - t);
    const cy = from.y + dy * (1 - t);
    if (!isPointOnLand(cx, cy)) return { x: cx, y: cy };
  }
  return { x: from.x, y: from.y };
}

function closestPointOnSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const denom = abx * abx + aby * aby;
  if (denom === 0) return { x: ax, y: ay };
  let t = ((px - ax) * abx + (py - ay) * aby) / denom;
  t = Math.max(0, Math.min(1, t));
  return { x: ax + abx * t, y: ay + aby * t };
}

// Move a position onto the nearest land coastline and nudge it slightly inward
// so immobile bases (airfields/installations) end up unambiguously on solid
// ground, not hovering on the coastline edge.
export function snapToLand(pos) {
  let best = null;
  let bestDist = Infinity;
  for (const poly of LAND_POLYGONS) {
    const pts = poly.pts;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[j], b = pts[i];
      const cp = closestPointOnSegment(pos.x, pos.y, a.x, a.y, b.x, b.y);
      const dx = cp.x - pos.x, dy = cp.y - pos.y;
      const d = dx * dx + dy * dy;
      if (d < bestDist) {
        bestDist = d;
        best = cp;
      }
    }
  }
  if (!best) return { x: pos.x, y: pos.y };
  const dx = best.x - pos.x, dy = best.y - pos.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return best;
  // Nudge ~2 world units (≈185 m) inland, along the vector from sea to coast.
  const nudge = 2.0;
  return { x: best.x + (dx / len) * nudge, y: best.y + (dy / len) * nudge };
}

// ---------------------------------------------------------------------------
// Sea-route path planning (auto-avoid coastline).
//
// The original Fleet Command '99 had NO automatic land-avoidance: the player
// plotted waypoints by hand and ships sailed straight segments; routing around
// coastlines was the player's job. We add a lightweight planner so a move order
// whose straight line is blocked by land is re-routed along the nearest sea
// lane. Approach: a coarse grid A* over sea cells (with a safety margin so
// hulls don't clip the coast), then string-pulling (line-of-sight) collapses
// the grid path into a handful of natural waypoints. Open-water moves with a
// clear line of sight return a single waypoint — unchanged behaviour.
// ---------------------------------------------------------------------------

// Minimum distance from (x,y) to any land polygon edge (0 if inside land).
export function distToLand(x, y) {
  if (isPointOnLand(x, y)) return 0;
  let best = Infinity;
  for (const poly of LAND_POLYGONS) {
    const pts = poly.pts, n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const cp = closestPointOnSegment(x, y, pts[j].x, pts[j].y, pts[i].x, pts[i].y);
      const d = Math.hypot(cp.x - x, cp.y - y);
      if (d < best) best = d;
    }
  }
  return best;
}

// Nearest point that is at least `margin` from land (ring search outward).
export function nearestSea(x, y, margin = 0) {
  if (distToLand(x, y) >= margin) return { x, y };
  for (let r = margin + 5; r < WORLD_SIZE; r += 12) {
    for (let a = 0; a < 360; a += 15) {
      const rad = (a * Math.PI) / 180;
      const px = x + Math.cos(rad) * r;
      const py = y + Math.sin(rad) * r;
      if (distToLand(px, py) >= margin) return { x: px, y: py };
    }
  }
  return { x, y };
}

function _ccw(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

// True if segment AB properly crosses segment CD.
function _segSeg(ax, ay, bx, by, cx, cy, dx, dy) {
  const o1 = _ccw(ax, ay, bx, by, cx, cy);
  const o2 = _ccw(ax, ay, bx, by, dx, dy);
  const o3 = _ccw(cx, cy, dx, dy, ax, ay);
  const o4 = _ccw(cx, cy, dx, dy, bx, by);
  return ((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) &&
         ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0));
}

// True if the segment from (ax,ay) to (bx,by) is blocked by land: an endpoint
// inside land, or it crosses a coastline edge, or any fine sample lands on land.
function _segIntersectLand(ax, ay, bx, by) {
  if (isPointOnLand(ax, ay) || isPointOnLand(bx, by)) return true;
  const minx = Math.min(ax, bx), maxx = Math.max(ax, bx);
  const miny = Math.min(ay, by), maxy = Math.max(ay, by);
  for (const poly of LAND_POLYGONS) {
    const b = poly.bbox;
    if (maxx < b.xMin || minx > b.xMax || maxy < b.yMin || miny > b.yMax) continue;
    const pts = poly.pts, n = pts.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      if (_segSeg(ax, ay, bx, by, pts[j].x, pts[j].y, pts[i].x, pts[i].y)) return true;
    }
  }
  // Fine sampling catches grazing coastline touches the edge test can miss.
  const len = Math.hypot(bx - ax, by - ay);
  const steps = Math.max(1, Math.ceil(len / 12));
  for (let s = 1; s < steps; s++) {
    const t = s / steps;
    if (isPointOnLand(ax + (bx - ax) * t, ay + (by - ay) * t)) return true;
  }
  return false;
}

// --- coarse sea grid (cached, invalidated by setLand) ----------------------

let _gridCache = { key: null, grid: null };

function _buildSeaGrid(cell, margin) {
  const cols = Math.ceil(WORLD_SIZE / cell);
  const rows = Math.ceil(WORLD_SIZE / cell);
  const blocked = new Uint8Array(cols * rows);
  const landCells = [];
  for (const poly of LAND_POLYGONS) {
    const b = poly.bbox;
    const c0 = Math.max(0, Math.floor(b.xMin / cell));
    const c1 = Math.min(cols - 1, Math.floor(b.xMax / cell));
    const r0 = Math.max(0, Math.floor(b.yMin / cell));
    const r1 = Math.min(rows - 1, Math.floor(b.yMax / cell));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const x = c * cell + cell / 2;
        const y = r * cell + cell / 2;
        if (isPointOnLand(x, y)) {
          blocked[r * cols + c] = 1;
          landCells.push([r, c]);
        }
      }
    }
  }
  // Dilate by `margin` so hulls keep clear of the coast.
  const m = Math.max(0, Math.ceil(margin / cell));
  if (m > 0) {
    for (const [r, c] of landCells) {
      for (let dr = -m; dr <= m; dr++) {
        for (let dc = -m; dc <= m; dc++) {
          const rr = r + dr, cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) blocked[rr * cols + cc] = 1;
        }
      }
    }
  }
  return { cols, rows, cell, blocked };
}

function _getGrid(cell, margin) {
  const key = _landVersion + '|' + cell + '|' + margin;
  if (_gridCache.key !== key || !_gridCache.grid) {
    _gridCache.grid = _buildSeaGrid(cell, margin);
    _gridCache.key = key;
  }
  return _gridCache.grid;
}

// Minimal binary min-heap keyed by `.f`.
class _MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(node) {
    const a = this.a; a.push(node); let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      const t = a[p]; a[p] = a[i]; a[i] = t; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0; const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = 2 * i + 2, s = i;
        if (l < n && a[l].f < a[s].f) s = l;
        if (r < n && a[r].f < a[s].f) s = r;
        if (s === i) break;
        const t = a[s]; a[s] = a[i]; a[i] = t; i = s;
      }
    }
    return top;
  }
}

function _astar(grid, start, goal) {
  const { cols, rows, cell, blocked } = grid;
  const idx = (c, r) => r * cols + c;
  const sc = Math.min(cols - 1, Math.max(0, Math.floor(start.x / cell)));
  const sr = Math.min(rows - 1, Math.max(0, Math.floor(start.y / cell)));
  const gc = Math.min(cols - 1, Math.max(0, Math.floor(goal.x / cell)));
  const gr = Math.min(rows - 1, Math.max(0, Math.floor(goal.y / cell)));
  const sIdx = idx(sc, sr), gIdx = idx(gc, gr);
  if (blocked[sIdx] || blocked[gIdx]) return null;

  const N = cols * rows;
  const g = new Float64Array(N).fill(Infinity);
  const came = new Int32Array(N).fill(-1);
  const closed = new Uint8Array(N);
  const SQ2 = Math.SQRT2;
  const h = (i, j) => {
    const ax = i % cols, ay = (i / cols) | 0;
    const bx = j % cols, by = (j / cols) | 0;
    const dx = Math.abs(ax - bx), dy = Math.abs(ay - by);
    return (dx + dy) + (SQ2 - 2) * Math.min(dx, dy);
  };
  const heap = new _MinHeap();
  g[sIdx] = 0;
  heap.push({ i: sIdx, f: h(sIdx, gIdx) });
  let found = false, expansions = 0;
  while (heap.size) {
    const cur = heap.pop();
    if (closed[cur.i]) continue;
    closed[cur.i] = 1;
    if (cur.i === gIdx) { found = true; break; }
    if (++expansions > N * 2) break;
    const cc = cur.i % cols, cr = (cur.i / cols) | 0;
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        if (!dr && !dc) continue;
        const nr = cr + dr, nc = cc + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        const ni = idx(nc, nr);
        if (blocked[ni] || closed[ni]) continue;
        if (dr && dc && (blocked[idx(nc, cr)] || blocked[idx(cc, nr)])) continue; // no corner cut
        const step = (dr && dc) ? SQ2 : 1;
        const ng = g[cur.i] + step;
        if (ng < g[ni]) {
          g[ni] = ng; came[ni] = cur.i;
          heap.push({ i: ni, f: ng + h(ni, gIdx) });
        }
      }
    }
  }
  if (!found) return null;
  const path = [];
  let ci = gIdx;
  while (ci !== -1) {
    path.push({ x: (ci % cols) * cell + cell / 2, y: ((ci / cols) | 0) * cell + cell / 2 });
    ci = came[ci];
  }
  path.reverse();
  return path;
}

// Collapse a grid-cell path into natural waypoints: keep a point only when the
// straight segment from the last anchor to it clears land.
function _stringPull(cells) {
  if (cells.length <= 2) return cells.slice();
  const out = [cells[0]];
  let anchor = 0;
  for (let i = 2; i < cells.length; i++) {
    const a = cells[anchor], b = cells[i];
    if (_segIntersectLand(a.x, a.y, b.x, b.y)) {
      out.push(cells[i - 1]);
      anchor = i - 1;
    }
  }
  out.push(cells[cells.length - 1]);
  return out;
}

// Plan a sea route from `start` to `goal`. Returns an array of waypoints
// (NOT including `start`, ending at the (sea-snapped) goal). Open-water moves
// with a clear line of sight collapse to a single waypoint; blocked moves are
// re-routed around land. `opts.margin` keeps the lane clear of the coast.
export function planSeaRoute(start, goal, opts = {}) {
  const cell = opts.cell || 30;
  const margin = opts.margin != null ? opts.margin : 20;
  const g2 = nearestSea(goal.x, goal.y, margin);
  const s2 = isPointOnLand(start.x, start.y)
    ? nearestSea(start.x, start.y, margin)
    : { x: start.x, y: start.y };
  // Clear shot: keep the original straight-line behaviour.
  if (!_segIntersectLand(s2.x, s2.y, g2.x, g2.y)) {
    return [{ x: g2.x, y: g2.y }];
  }
  const grid = _getGrid(cell, margin);
  const cells = _astar(grid, s2, g2);
  if (!cells || cells.length < 2) return [{ x: g2.x, y: g2.y }]; // fallback
  const pulled = _stringPull(cells);
  const wps = pulled.slice(1).map((p) => ({ x: p.x, y: p.y }));
  if (!wps.length) wps.push({ x: g2.x, y: g2.y });
  // End exactly on the (sea-snapped) goal rather than the quantized grid cell.
  wps[wps.length - 1] = { x: g2.x, y: g2.y };
  return wps;
}
