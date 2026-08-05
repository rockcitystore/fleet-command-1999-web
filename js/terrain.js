// Shared terrain data + collision helpers.
// Coordinates are normalized [0,1]; multiply by WORLD_SIZE to get world units.

export const LAND_POLYGONS_NORM = [
  // Main peninsula (left side, narrow coastal strip)
  [{ x: 0.00, y: 0.00 }, { x: 0.06, y: 0.00 }, { x: 0.07, y: 0.10 }, { x: 0.05, y: 0.25 },
   { x: 0.03, y: 0.40 }, { x: 0.035, y: 0.55 }, { x: 0.025, y: 0.70 }, { x: 0.015, y: 0.85 },
   { x: 0.00, y: 0.90 }],
  // Lower island arc
  [{ x: 0.05, y: 0.86 }, { x: 0.16, y: 0.84 }, { x: 0.24, y: 0.90 }, { x: 0.20, y: 0.96 }, { x: 0.08, y: 0.98 }],
  // Upper-right island cluster
  [{ x: 0.82, y: 0.06 }, { x: 0.94, y: 0.04 }, { x: 0.98, y: 0.14 }, { x: 0.90, y: 0.22 }],
  // Lower-right island
  [{ x: 0.78, y: 0.78 }, { x: 0.90, y: 0.76 }, { x: 0.96, y: 0.84 }, { x: 0.88, y: 0.92 }, { x: 0.76, y: 0.88 }],
];

function pointInPolygon(px, py, poly, worldSize) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x * worldSize;
    const yi = poly[i].y * worldSize;
    const xj = poly[j].x * worldSize;
    const yj = poly[j].y * worldSize;
    const intersect = ((yi > py) !== (yj > py)) &&
      (px < (xj - xi) * (py - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

export function isPointOnLand(x, y, worldSize = 4000) {
  return LAND_POLYGONS_NORM.some((poly) => pointInPolygon(x, y, poly, worldSize));
}

// Return a safe position near `pos` that is not inside land. If `pos` is already
// safe, return it unchanged. Otherwise walk back toward `from` in small steps.
export function snapToSea(pos, from, worldSize = 4000, steps = 8) {
  if (!isPointOnLand(pos.x, pos.y, worldSize)) return { x: pos.x, y: pos.y };
  const dx = pos.x - from.x;
  const dy = pos.y - from.y;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const cx = from.x + dx * (1 - t);
    const cy = from.y + dy * (1 - t);
    if (!isPointOnLand(cx, cy, worldSize)) return { x: cx, y: cy };
  }
  return { x: from.x, y: from.y };
}
