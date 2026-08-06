// Shared terrain data + collision helpers.
//
// Land is now REAL coastline geometry (see geo.js / ne_land.js): an array of
// polygons in WORLD units. The polygons are set per-scenario via setLand().
// Each polygon carries a precomputed bbox so collision tests stay cheap even
// with detailed coastlines.

let LAND_POLYGONS = []; // [{ pts: [{x,y}...], bbox: {xMin,xMax,yMin,yMax} }]

export function setLand(polygons) {
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
}

export function getLand() {
  return LAND_POLYGONS;
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
