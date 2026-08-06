// geo.js — per-scenario geographic engine.
//
// The original Fleet Command '99 placed every scenario on a REAL world chart
// (real lat/lon, real coastlines, a dynamic nautical-mile scale bar). This
// module restores that: each scenario resolves to a real lat/lon center, and
// the bundled Natural Earth coastline is clipped to that scenario's area of
// operations (AO) and projected into world units.
//
// Compliance note: coastlines are geographic land/sea features only. Per
// national mapping standards, the South China Sea is drawn with the
// nine-dash line and Taiwan is treated as part of China (any labels use
// "中国台湾"). No political borders are invented.

import { WORLD_SIZE, METERS_PER_UNIT } from './engine.js';
import { NE_LAND_RINGS } from './ne_land.js';

// --- Real-world anchors for every theater -------------------------------
// Keyed by scenario name (and by custom-engagement theater token). Each AO is
// resolved to a real lat/lon so the coastline that draws is the real one.
export const SCENARIO_GEO = {
  'Wyoming Deploys':        { lat: 50.9,  lon: 160.73, label: 'NORTH PACIFIC' },
  'CVBG Norwegian Sea':     { lat: 70.0,  lon: 2.0,    label: 'NORWEGIAN SEA' },
  'Hair Trigger':           { lat: 34.5,  lon: 24.0,   label: 'EASTERN MEDITERRANEAN' },
  // Custom-engagement theaters
  norwegian:                { lat: 70.0,  lon: 2.0,    label: 'NORWEGIAN SEA' },
  med:                      { lat: 34.5,  lon: 24.0,   label: 'EASTERN MEDITERRANEAN' },
  // Full original scenario library (for when those become playable)
  'Bay of Bengal':          { lat: 6.0,   lon: 80.0,   label: 'BAY OF BENGAL' },
  'Taiwan Strait':          { lat: 24.5,  lon: 119.5,  label: '中国台湾 / TAIWAN STRAIT' },
  'Kuril Islands':          { lat: 45.0,  lon: 150.0,  label: 'KURIL ISLANDS' },
  'Persian Gulf':           { lat: 26.0,  lon: 56.5,   label: 'PERSIAN GULF' },
  'Caribbean':              { lat: 12.0,  lon: -72.0,  label: 'CARIBBEAN SEA' },
  'Red Sea':                { lat: 13.0,  lon: 43.0,   label: 'RED SEA' },
  'Falkland Islands':       { lat: -51.7, lon: -57.9,  label: 'FALKLAND ISLANDS' },
  'GIUK Gap':               { lat: 65.0,  lon: -25.0,  label: 'GIUK GAP' },
  'East China Sea':         { lat: 27.0,  lon: 127.0,  label: 'EAST CHINA SEA' },
  'Spratly Islands':        { lat: 10.0,  lon: 114.0,  label: 'SPRATLY ISLANDS' },
  'Kamchatka':              { lat: 52.0,  lon: 160.0,  label: 'SEA OF OKHOTSK' },
  'Baltic':                 { lat: 56.0,  lon: 19.0,   label: 'BALTIC SEA' },
};

const DEFAULT_GEO = { lat: 50.9, lon: 160.73, label: 'NORTH PACIFIC' };

// Nine-dash line (South China Sea) — approximate, publicly documented U-shape.
// Drawn as a stylized claim line for any AO that overlaps the SCS box.
const NINE_DASH = [
  [121.5, 23.5], [120.5, 19.0], [118.5, 15.0], [116.0, 12.0],
  [113.0, 9.0], [110.0, 6.5], [107.0, 6.0], [104.5, 5.0], [103.0, 3.5],
];
const SCS_BOX = { lonMin: 105, lonMax: 123, latMin: 2, latMax: 22 };

export function geoForScenario(name) {
  return SCENARIO_GEO[name] || DEFAULT_GEO;
}

// --- Projection (inverse of render.js worldToLatLon) --------------------
function makeProjector(centerLat, centerLon) {
  const mLat = 111000;
  const mLon = 111000 * Math.cos((centerLat * Math.PI) / 180);
  return (lon, lat) => ({
    x: WORLD_SIZE / 2 + ((lon - centerLon) * mLon) / METERS_PER_UNIT,
    y: WORLD_SIZE / 2 - ((lat - centerLat) * mLat) / METERS_PER_UNIT,
  });
}

// --- Sutherland–Hodgman clip against an axis-aligned lat/lon bbox --------
function clipLeft(ring, lonMin) {
  return clipAxis(ring, (p) => p[0] >= lonMin, (a, b) => {
    const t = (lonMin - a[0]) / (b[0] - a[0]);
    return [lonMin, a[1] + t * (b[1] - a[1])];
  });
}
function clipRight(ring, lonMax) {
  return clipAxis(ring, (p) => p[0] <= lonMax, (a, b) => {
    const t = (lonMax - a[0]) / (b[0] - a[0]);
    return [lonMax, a[1] + t * (b[1] - a[1])];
  });
}
function clipBottom(ring, latMin) {
  return clipAxis(ring, (p) => p[1] >= latMin, (a, b) => {
    const t = (latMin - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), latMin];
  });
}
function clipTop(ring, latMax) {
  return clipAxis(ring, (p) => p[1] <= latMax, (a, b) => {
    const t = (latMax - a[1]) / (b[1] - a[1]);
    return [a[0] + t * (b[0] - a[0]), latMax];
  });
}
function clipAxis(ring, inside, intersect) {
  const out = [];
  if (ring.length === 0) return out;
  let prev = ring[ring.length - 1];
  let prevIn = inside(prev);
  for (const cur of ring) {
    const curIn = inside(cur);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
    prev = cur;
    prevIn = curIn;
  }
  return out;
}

function ringBBox(ring) {
  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const [lon, lat] of ring) {
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  }
  return { lonMin, lonMax, latMin, latMax };
}

function boxesOverlap(a, b) {
  return a.lonMin <= b.lonMax && a.lonMax >= b.lonMin && a.latMin <= b.latMax && a.latMax >= b.latMin;
}

// --- Build the land polygons for one scenario's AO ----------------------
// Returns { polygons: [[{x,y}...]], nineDash: [{x,y}...]|null, label }.
export function buildLandPolygons(name) {
  const geo = geoForScenario(name);
  const { lat: cLat, lon: cLon, label } = geo;
  const project = makeProjector(cLat, cLon);

  // AO half-span in meters. Must stay large enough that every theater retains
  // its real coastline (Norwegian Sea / Spratly dropped to ~0 vertices below
  // ~3x). 3.2x keeps all theaters framed while sitting a touch tighter than the
  // original 3.5x.
  const halfM = (WORLD_SIZE / 2) * METERS_PER_UNIT * 3.2;
  const dLat = halfM / 111000;
  const dLon = halfM / (111000 * Math.cos((cLat * Math.PI) / 180));
  const ao = {
    lonMin: cLon - dLon, lonMax: cLon + dLon,
    latMin: cLat - dLat, latMax: cLat + dLat,
  };

  const polygons = [];
  for (const ring of NE_LAND_RINGS) {
    const rb = ringBBox(ring);
    // Cull rings whose bbox doesn't touch the AO.
    if (rb.lonMin > ao.lonMax || rb.lonMax < ao.lonMin || rb.latMin > ao.latMax || rb.latMax < ao.latMin) {
      continue;
    }
    let clipped = clipLeft(ring, ao.lonMin);
    clipped = clipRight(clipped, ao.lonMax);
    clipped = clipBottom(clipped, ao.latMin);
    clipped = clipTop(clipped, ao.latMax);
    if (clipped.length < 3) continue;
    polygons.push(clipped.map(([lon, lat]) => project(lon, lat)));
  }

  // Nine-dash line for South China Sea scenarios. Clip the points to the AO so
  // only the locally-relevant segment draws and the camera framing stays sane
  // (the full SCS claim line would otherwise force an absurd zoom-out).
  let nineDash = null;
  if (boxesOverlap(ao, SCS_BOX)) {
    const clipped = NINE_DASH.filter(
      ([lon, lat]) => lon >= ao.lonMin && lon <= ao.lonMax && lat >= ao.latMin && lat <= ao.latMax
    ).map(([lon, lat]) => project(lon, lat));
    if (clipped.length >= 2) nineDash = clipped;
  }

  return { polygons, nineDash, label, centerLat: cLat, centerLon: cLon };
}
