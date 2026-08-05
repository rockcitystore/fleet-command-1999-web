// render.js — Canvas drawing layer for Fleet Command '99 web port.
// Pure drawing only. Imports coordinates/constants from engine.js.
// Authoritative spec: CONTRACT.md section 2.

import { worldToScreen, screenToWorld, WORLD_SIZE, METERS_PER_UNIT, SHIP_STATS } from './engine.js';
import { LAND_POLYGONS_NORM } from './terrain.js';

// Colors: matched to the original Fleet Command '99 CIC screenshot.
const COLOR_OCEAN = '#04121f';
const COLOR_OCEAN_GRADIENT_TOP = '#082038';
const COLOR_OCEAN_GRADIENT_BOT = '#020a12';
const COLOR_GRID = 'rgba(30, 90, 130, 0.35)';
const COLOR_GRID_MAJOR = 'rgba(40, 120, 170, 0.55)';
const COLOR_BORDER = '#1d5478';
const COLOR_PLAYER = '#00ffff';
const COLOR_ENEMY = '#ff3333';
const COLOR_NEUTRAL = '#ffd84d';
const COLOR_SELECT = '#ffd84d';
const COLOR_TRACK_TEXT = 'rgba(255, 255, 255, 0.92)';

// Live render options, mutated by the OPTIONS menu. Safe module-level singleton.
export const RENDER_OPTIONS = {
  grid: true,          // show tactical grid
  symbolStyle: 'ntds', // 'ntds' | 'simple'
};
const COLOR_LAND = 'rgba(20, 60, 35, 0.55)';
const COLOR_LAND_COAST = 'rgba(60, 140, 80, 0.45)';

const FONT_TRACK = '11px SFMono-Regular, Consolas, monospace';

function makePoint(x, y) { return { x, y }; }

function drawOcean(ctx, size) {
  const g = ctx.createRadialGradient(
    size.width * 0.5, size.height * 0.4, 0,
    size.width * 0.5, size.height * 0.5, Math.max(size.width, size.height) * 0.8
  );
  // Guard against headless / fake canvas contexts that don't return a real gradient.
  if (g && typeof g.addColorStop === 'function') {
    g.addColorStop(0, COLOR_OCEAN_GRADIENT_TOP);
    g.addColorStop(1, COLOR_OCEAN_GRADIENT_BOT);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = COLOR_OCEAN;
  }
  ctx.fillRect(0, 0, size.width, size.height);
}

function drawGrid(ctx, world, size) {
  if (RENDER_OPTIONS.grid === false) return;
  ctx.save();
  ctx.lineWidth = 1;
  const major = 1000;
  const minor = 500;

  // Infinite tactical grid: cover the visible viewport plus one minor spacing.
  const margin = minor;
  const tl = screenToWorld(makePoint(-margin, -margin), size, world.camera);
  const br = screenToWorld(makePoint(size.width + margin, size.height + margin), size, world.camera);

  const x0 = Math.floor(tl.x / minor) * minor;
  const x1 = Math.ceil(br.x / minor) * minor;
  const y0 = Math.floor(tl.y / minor) * minor;
  const y1 = Math.ceil(br.y / minor) * minor;

  for (let x = x0; x <= x1; x += minor) {
    const isMajor = x % major === 0;
    ctx.strokeStyle = isMajor ? COLOR_GRID_MAJOR : COLOR_GRID;
    ctx.beginPath();
    const a = worldToScreen(makePoint(x, y0), size, world.camera);
    const b = worldToScreen(makePoint(x, y1), size, world.camera);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  for (let y = y0; y <= y1; y += minor) {
    const isMajor = y % major === 0;
    ctx.strokeStyle = isMajor ? COLOR_GRID_MAJOR : COLOR_GRID;
    ctx.beginPath();
    const a = worldToScreen(makePoint(x0, y), size, world.camera);
    const b = worldToScreen(makePoint(x1, y), size, world.camera);
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.restore();
}

// No hard world border — the tactical map is meant to feel unbounded.
function drawBorder(ctx, world, size) {}

// NTDS-style tactical symbols.
function drawTacticalSymbol(ctx, ship, r) {
  ctx.lineWidth = Math.max(1.2, r * 0.2);
  const baseColor = ship.side === 'player' ? COLOR_PLAYER : (ship.side === 'enemy' ? COLOR_ENEMY : COLOR_NEUTRAL);
  ctx.strokeStyle = baseColor;
  ctx.fillStyle = baseColor;

  const c = ship.shipClass;
  ctx.beginPath();
  if (c === 'carrier') {
    // CV: large filled circle with a horizontal flight-deck bar.
    ctx.globalAlpha = 0.25;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.55, 0);
    ctx.lineTo(r * 0.55, 0);
    ctx.stroke();
  } else if (c === 'cruiser') {
    // CG: filled circle with a vertical mast line.
    ctx.globalAlpha = 0.25;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.6);
    ctx.lineTo(0, r * 0.6);
    ctx.stroke();
  } else if (c === 'destroyer') {
    // DDG: filled circle with an X.
    ctx.globalAlpha = 0.25;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, -r * 0.5);
    ctx.lineTo(r * 0.5, r * 0.5);
    ctx.moveTo(r * 0.5, -r * 0.5);
    ctx.lineTo(-r * 0.5, r * 0.5);
    ctx.stroke();
  } else if (c === 'frigate') {
    // FFG: small solid square.
    ctx.globalAlpha = 0.35;
    ctx.fillRect(-r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
    ctx.globalAlpha = 1;
    ctx.strokeRect(-r * 0.55, -r * 0.55, r * 1.1, r * 1.1);
  } else if (c === 'submarine') {
    // SSN: filled half-oval "submerged" symbol.
    ctx.beginPath();
    ctx.ellipse(0, 0, r * 1.05, r * 0.6, 0, 0, Math.PI * 2);
    ctx.globalAlpha = 0.25;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.35, 0);
    ctx.lineTo(r * 0.35, 0);
    ctx.stroke();
  } else if (c === 'battleship') {
    // BB: filled square with a cross.
    ctx.globalAlpha = 0.25;
    ctx.fillRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8);
    ctx.globalAlpha = 1;
    ctx.strokeRect(-r * 0.9, -r * 0.9, r * 1.8, r * 1.8);
    ctx.beginPath();
    ctx.moveTo(0, -r * 0.9);
    ctx.lineTo(0, r * 0.9);
    ctx.moveTo(-r * 0.9, 0);
    ctx.lineTo(r * 0.9, 0);
    ctx.stroke();
  } else if (c === 'installation') {
    // Fixed base / airfield: hollow square with a diagonal runway cross.
    ctx.strokeRect(-r, -r, r * 2, r * 2);
    ctx.beginPath();
    ctx.moveTo(-r * 0.7, -r * 0.7);
    ctx.lineTo(r * 0.7, r * 0.7);
    ctx.moveTo(r * 0.7, -r * 0.7);
    ctx.lineTo(-r * 0.7, r * 0.7);
    ctx.stroke();
  } else {
    // fallback circle
    ctx.globalAlpha = 0.25;
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.stroke();
  }
}

function drawHeadingLine(ctx, ship, sp, r, scale) {
  // Heading line length proportional to speed (pixels, screen-space).
  const speedRatio = ship.maxSpeed > 0 ? ship.speed / ship.maxSpeed : 0;
  const len = r + 8 + speedRatio * 28;
  const x1 = sp.x;
  const y1 = sp.y;
  const x2 = sp.x + Math.cos(ship.heading) * len;
  const y2 = sp.y + Math.sin(ship.heading) * len;
  ctx.save();
  ctx.strokeStyle = ship.side === 'player' ? 'rgba(57,208,255,0.55)' : 'rgba(255,91,91,0.55)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  ctx.restore();
}

function drawTrackNumber(ctx, ship, sp, r) {
  const id = String(ship.id).padStart(4, '0');
  ctx.save();
  ctx.font = FONT_TRACK;
  ctx.fillStyle = COLOR_TRACK_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(id, sp.x, sp.y - r - 5);
  ctx.restore();
}

function drawSimpleSymbol(ctx, ship, r) {
  const col = ship.side === 'player' ? COLOR_PLAYER : (ship.side === 'enemy' ? COLOR_ENEMY : COLOR_NEUTRAL);
  ctx.save();
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.beginPath();
  ctx.arc(0, 0, r * 0.7, 0, Math.PI * 2);
  ctx.fill();
  // heading tick
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(0, -r);
  ctx.lineWidth = 2;
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.stroke();
  ctx.restore();
}

function drawShip(ctx, ship, sp, r, selected) {
  // Heading line first so it appears behind the symbol.
  drawHeadingLine(ctx, ship, sp, r);

  // Tactical symbol, rotated with heading.
  ctx.save();
  ctx.translate(sp.x, sp.y);
  ctx.rotate(ship.heading);
  if (RENDER_OPTIONS.symbolStyle === 'simple') drawSimpleSymbol(ctx, ship, r);
  else drawTacticalSymbol(ctx, ship, r);
  ctx.restore();

  // Selection box (screen-aligned, not rotated).
  if (selected) {
    ctx.save();
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    const pad = r + 4;
    ctx.strokeRect(sp.x - pad, sp.y - pad, pad * 2, pad * 2);
    ctx.restore();
  }

  drawTrackNumber(ctx, ship, sp, r);
}

function drawAircraftRoute(ctx, ac, size, cam, selected) {
  if (!ac.order || !ac.order.waypoints || !ac.order.waypoints.length) return;
  const wps = ac.order.waypoints;
  const startIdx = ac.order.wpIndex || 0;
  ctx.save();
  ctx.lineWidth = selected ? 1.8 : 1.2;
  ctx.setLineDash([4, 3]);
  ctx.strokeStyle = ac.side === 'player' ? 'rgba(57,208,255,0.55)' : 'rgba(255,91,91,0.45)';
  ctx.beginPath();
  const start = worldToScreen(ac.pos, size, cam);
  ctx.moveTo(start.x, start.y);
  for (let i = startIdx; i < wps.length; i++) {
    const wp = worldToScreen({ x: wps[i].x, y: wps[i].y }, size, cam);
    ctx.lineTo(wp.x, wp.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  for (let i = startIdx; i < wps.length; i++) {
    const wp = worldToScreen({ x: wps[i].x, y: wps[i].y }, size, cam);
    ctx.beginPath();
    ctx.arc(wp.x, wp.y, 2.6, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function drawAircraftSymbol(ctx, ac, sp, r, selected) {
  const col = ac.side === 'player' ? COLOR_PLAYER : (ac.side === 'enemy' ? COLOR_ENEMY : COLOR_NEUTRAL);
  ctx.save();
  ctx.translate(sp.x, sp.y);
  ctx.rotate(ac.heading);
  ctx.fillStyle = col;
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.4;
  if (ac.category === 'helo') {
    // Rotor disc: filled circle + cross.
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.globalAlpha = 0.3; ctx.fill(); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0);
    ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5); ctx.stroke();
  } else {
    // Fixed-wing: arrowhead pointing along heading.
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(-r * 0.6, -r * 0.55);
    ctx.lineTo(-r * 0.3, 0);
    ctx.lineTo(-r * 0.6, r * 0.55);
    ctx.closePath();
    ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; ctx.stroke();
  }
  ctx.restore();

  if (selected) {
    ctx.save();
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.strokeRect(sp.x - r - 4, sp.y - r - 4, (r + 4) * 2, (r + 4) * 2);
    ctx.restore();
  }

  ctx.save();
  ctx.font = FONT_TRACK;
  ctx.fillStyle = COLOR_TRACK_TEXT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.fillText(String(ac.id).padStart(4, '0'), sp.x, sp.y - r - 4);
  ctx.textBaseline = 'top';
  ctx.fillStyle = ac.side === 'player' ? 'rgba(57,208,255,0.9)' : 'rgba(255,150,150,0.9)';
  ctx.fillText(`${Math.round(ac.alt)}`, sp.x, sp.y + r + 2);
  ctx.restore();
}

export function drawBattle(ctx, world, size) {
  drawOcean(ctx, size);

  const base = Math.min(size.width, size.height) / WORLD_SIZE;
  const scale = base * world.camera.zoom;

  drawLand(ctx, world, size);
  drawGrid(ctx, world, size);

  const selected = world.__selected || [];
  for (const ship of world.ships) {
    if (!ship.alive) continue;
    if (ship.side === 'enemy' && !ship.detected) continue;

    const sp = worldToScreen(ship.pos, size, world.camera);
    const stats = SHIP_STATS[ship.shipClass] || { radius: 14 };
    const r = Math.max(stats.radius * scale, 9);
    drawShip(ctx, ship, sp, r, selected.includes(ship.id));

    // Air-wing badge: how many parked airframes this platform carries.
    if (ship.aircraft && ship.aircraft.length) {
      ctx.save();
      ctx.font = '10px SFMono-Regular, Consolas, monospace';
      ctx.fillStyle = ship.side === 'player' ? 'rgba(57,208,255,0.9)' : 'rgba(255,150,150,0.85)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`✈${ship.aircraft.length}`, sp.x + r + 3, sp.y - r);
      ctx.restore();
    }
  }

  // Airborne aircraft: flight-plan routes (under), then trails, then symbols.
  const selectedAc = world.__selectedAircraft || [];
  for (const ac of world.aircraft) {
    if (!ac.alive) continue;
    if (ac.side === 'enemy' && !ac.detected) continue;
    drawAircraftRoute(ctx, ac, size, world.camera, selectedAc.includes(ac.id));
  }
  for (const ac of world.aircraft) {
    if (!ac.alive || !ac.trail || !ac.trail.length) continue;
    if (ac.side === 'enemy' && !ac.detected) continue;
    const col = ac.side === 'player' ? 'rgba(57,208,255,0.5)' : 'rgba(255,91,91,0.4)';
    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < ac.trail.length; i++) {
      const tp = worldToScreen(ac.trail[i], size, world.camera);
      if (i === 0) ctx.moveTo(tp.x, tp.y);
      else ctx.lineTo(tp.x, tp.y);
    }
    const sp = worldToScreen(ac.pos, size, world.camera);
    ctx.lineTo(sp.x, sp.y);
    ctx.strokeStyle = col;
    ctx.lineWidth = 1.4;
    ctx.stroke();
    ctx.restore();
  }
  for (const ac of world.aircraft) {
    if (!ac.alive) continue;
    if (ac.side === 'enemy' && !ac.detected) continue;
    const sp = worldToScreen(ac.pos, size, world.camera);
    drawAircraftSymbol(ctx, ac, sp, 7, selectedAc.includes(ac.id));
  }

  // Projectiles / missile & torpedo trails (drawn above ships).
  if (world.projectiles && world.projectiles.length) {
    ctx.save();
    for (const p of world.projectiles) {
      const sp = worldToScreen(p.pos, size, world.camera);
      // Trail
      ctx.beginPath();
      for (let i = 0; i < p.trail.length; i++) {
        const tp = worldToScreen(p.trail[i], size, world.camera);
        if (i === 0) ctx.moveTo(tp.x, tp.y);
        else ctx.lineTo(tp.x, tp.y);
      }
      ctx.lineTo(sp.x, sp.y);
      ctx.strokeStyle = p.color;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Head
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(sp.x, sp.y, p.type === 'missile' ? 2.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (world.__selectRect) {
    const rc = world.__selectRect;
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLOR_SELECT;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(rc.x, rc.y, rc.w, rc.h);
    ctx.restore();
  }

  drawGeoOverlay(ctx, world, size);
}

// ---------------------------------------------------------------------------
// Geo readout + scale bar (top-left, like the original FC99 CIC).
// ---------------------------------------------------------------------------
const CENTER_LAT = 50.9;
const CENTER_LON = 160.73;
const SCALE_BAR_NMI = 50;
const FT_PER_METER = 3.28084;

function pseudoNoise(x, y) {
  const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

function depthAt(x, y) {
  // deterministic pseudo-bathymetry, returns feet
  const n1 = pseudoNoise(x * 0.003, y * 0.003);
  const n2 = pseudoNoise(x * 0.01 + 100, y * 0.01 + 100);
  return Math.round(10000 + n1 * 9000 + n2 * 3000);
}

function degMin(decimal, posHemi, negHemi) {
  const hemi = decimal >= 0 ? posHemi : negHemi;
  const a = Math.abs(decimal);
  const deg = Math.floor(a);
  const min = Math.floor((a - deg) * 60);
  return `${deg}-${String(min).padStart(2, '0')} ${hemi}`;
}

function worldToLatLon(x, y) {
  const mLat = 111000;
  const mLon = 111000 * Math.cos(CENTER_LAT * Math.PI / 180);
  const lat = CENTER_LAT - ((y - WORLD_SIZE / 2) * METERS_PER_UNIT) / mLat;
  const lon = CENTER_LON + ((x - WORLD_SIZE / 2) * METERS_PER_UNIT) / mLon;
  return { lat, lon };
}

function drawScaleBar(ctx, x, y, zoom, size) {
  const base = Math.min(size.width, size.height) / WORLD_SIZE;
  const barWorld = (SCALE_BAR_NMI * 1852) / METERS_PER_UNIT;
  const barPx = Math.min(barWorld * base * zoom, size.width * 0.35);
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + barPx, y);
  ctx.moveTo(x, y - 4);
  ctx.lineTo(x, y + 4);
  ctx.moveTo(x + barPx, y - 4);
  ctx.lineTo(x + barPx, y + 4);
  ctx.stroke();
  ctx.font = '11px SFMono-Regular, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${SCALE_BAR_NMI} nmi`, x, y + 6);
  ctx.restore();
}

function drawGeoOverlay(ctx, world, size) {
  const { lat, lon } = worldToLatLon(world.camera.center.x, world.camera.center.y);
  const depth = depthAt(world.camera.center.x, world.camera.center.y);
  const x = 16;
  const y = 14;
  ctx.save();
  ctx.font = '13px SFMono-Regular, Consolas, monospace';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`${degMin(lat, 'N', 'S')} / ${degMin(lon, 'E', 'W')}`, x, y);
  ctx.fillText(`Depth: ${depth.toLocaleString()} ft`, x, y + 17);
  ctx.restore();

  drawScaleBar(ctx, x, y + 40, world.camera.zoom, size);
}

function normToWorld(p) {
  return { x: p.x * WORLD_SIZE, y: p.y * WORLD_SIZE };
}

function drawLand(ctx, world, size) {
  ctx.save();
  ctx.fillStyle = COLOR_LAND;
  ctx.strokeStyle = COLOR_LAND_COAST;
  ctx.lineWidth = 1;
  for (const poly of LAND_POLYGONS_NORM) {
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const sp = worldToScreen(normToWorld(poly[i]), size, world.camera);
      if (i === 0) ctx.moveTo(sp.x, sp.y);
      else ctx.lineTo(sp.x, sp.y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function drawLandOnMinimap(ctx, w, h) {
  ctx.save();
  ctx.fillStyle = COLOR_LAND;
  ctx.strokeStyle = COLOR_LAND_COAST;
  ctx.lineWidth = 1;
  for (const poly of LAND_POLYGONS_NORM) {
    ctx.beginPath();
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const x = p.x * w;
      const y = p.y * h;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

export function drawMinimap(ctx, world, size) {
  ctx.fillStyle = 'rgba(2, 11, 20, 0.95)';
  ctx.fillRect(0, 0, size.width, size.height);

  const w = size.width;
  const h = size.height;
  drawLandOnMinimap(ctx, w, h);

  for (const ship of world.ships) {
    if (!ship.alive) continue;
    if (ship.side === 'enemy' && !ship.detected) continue;
    const mx = ship.pos.x / WORLD_SIZE * w;
    const my = ship.pos.y / WORLD_SIZE * h;
    ctx.fillStyle = ship.side === 'player' ? COLOR_PLAYER : COLOR_ENEMY;
    ctx.fillRect(mx - 2, my - 2, 4, 4);
  }

  for (const ac of world.aircraft) {
    if (!ac.alive) continue;
    if (ac.side === 'enemy' && !ac.detected) continue;
    const mx = ac.pos.x / WORLD_SIZE * w;
    const my = ac.pos.y / WORLD_SIZE * h;
    ctx.fillStyle = ac.side === 'player' ? COLOR_PLAYER : COLOR_ENEMY;
    ctx.beginPath();
    ctx.arc(mx, my, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Viewport rectangle in magenta.
  const cam = world.camera;
  const baseW = w / WORLD_SIZE;
  const baseH = h / WORLD_SIZE;
  const sw = size.width / (baseW * cam.zoom);
  const sh = size.height / (baseH * cam.zoom);
  const rx = (cam.center.x - sw / 2) * baseW;
  const ry = (cam.center.y - sh / 2) * baseH;
  const rw = sw * baseW;
  const rh = sh * baseH;
  ctx.save();
  ctx.strokeStyle = '#ff00ff';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(rx, ry, rw, rh);
  ctx.restore();
}
