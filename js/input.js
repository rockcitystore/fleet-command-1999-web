// input.js — unified pointer/touch interaction for the main map canvas.
// All coordinate math is delegated to engine.js helpers (never reimplemented).
import {
  shipAtScreen,
  projectileAtScreen,
  aircraftAtScreen,
  waypointAtScreen,
  screenToWorld,
  panCamera,
  zoomCamera,
  playerShipsInRect,
  AIRCRAFT_STATS,
} from './engine.js';
import { isPointOnLand, snapToSea } from './terrain.js';

const DRAG_THRESHOLD = 8; // px before a press is considered a drag, not a tap.

export function attachInput(canvas, world, handlers) {
  canvas.style.touchAction = 'none'; // stop the browser from stealing gestures.

  // ---- internal state ----
  let selected = [];              // array of selected ship ids.
  let mode = 'pending';           // 'pending' | 'pan' | 'box' (single pointer).
  let pointerStart = null;        // {x,y} where the active press began.
  let lastPan = null;             // {x,y} last move point, for incremental panning.
  let startPlayerShip = null;     // player ship under the press start, if any.
  let dragWaypoint = null;        // { acId, index } when dragging a flight-plan waypoint.
  let pinching = false;           // true while >= 2 pointers are down.
  let pinchPrevDist = 0;          // previous distance between the two pinch points.
  const activePointers = new Map(); // pointerId -> {x,y} (live positions).

  const size = () => ({ width: canvas.clientWidth, height: canvas.clientHeight });

  // ---- context menu ----
  let ctxMenu = null;
  function hideContextMenu() {
    if (ctxMenu) {
      ctxMenu.remove();
      ctxMenu = null;
    }
  }
  function showContextMenu(x, y, items) {
    hideContextMenu();
    const menu = document.createElement('div');
    menu.id = 'map-context-menu';
    for (const item of items) {
      if (item.divider) {
        const d = document.createElement('div');
        d.className = 'ctx-divider';
        menu.appendChild(d);
      } else {
        const row = document.createElement('div');
        row.className = 'ctx-item' + (item.disabled ? ' disabled' : '');
        row.textContent = item.label;
        if (!item.disabled) {
          row.addEventListener('pointerdown', (e) => { e.stopPropagation(); });
          row.addEventListener('click', (e) => {
            e.stopPropagation();
            item.action();
            hideContextMenu();
          });
        }
        menu.appendChild(row);
      }
    }
    document.body.appendChild(menu);
    // Keep inside viewport.
    const rect = menu.getBoundingClientRect();
    let left = x;
    let top = y;
    if (left + rect.width > window.innerWidth) left = window.innerWidth - rect.width - 8;
    if (top + rect.height > window.innerHeight) top = window.innerHeight - rect.height - 8;
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    ctxMenu = menu;
  }

  function selectedMobileIds() {
    return selected.filter((id) => {
      const s = world.ship(id);
      return s && !s.immobile;
    });
  }

  function clearSelection() {
    selected = [];
    world.__selectedProjectile = null;
    handlers.onSelectionChange([]);
  }

  function cancelOrders() {
    for (const id of selected) {
      const s = world.ship(id);
      if (s) { s.order = null; s.targetId = null; }
    }
    handlers.onSelectionChange(selected);
  }

  function buildMenuItems(e) {
    const up = { x: e.offsetX, y: e.offsetY };
    const s = size();
    const projectile = projectileAtScreen(up, s, world.camera, world);
    const ship = shipAtScreen(up, s, world.camera, world);
    const mobileSel = selectedMobileIds();
    const items = [];

    if (projectile) {
      items.push({
        label: 'IDENTIFY WEAPON',
        action: () => {
          world.__selectedProjectile = projectile.id;
          selected = [];
          handlers.onSelectionChange([]);
        },
      });
      items.push({ divider: true });
      items.push({ label: 'CLEAR SELECTION', action: clearSelection });
      return items;
    }

    if (ship && ship.side === 'player') {
      items.push({
        label: `SELECT TRACK ${String(ship.id).padStart(4, '0')}`,
        action: () => {
          world.__selectedProjectile = null;
          selected = [ship.id];
          handlers.onSelectionChange(selected);
        },
      });
      if (ship.immobile) {
        items.push({ label: 'BASE — CANNOT MOVE', disabled: true });
      }
      // Launch menu: group parked airframes by type.
      if (ship.aircraft && ship.aircraft.length) {
        const byType = new Map();
        for (const a of ship.aircraft) {
          if (!byType.has(a.type)) byType.set(a.type, { type: a.type, display: a.display, category: a.category, ids: [], count: 0 });
          const g = byType.get(a.type);
          g.count++;
          g.ids.push(a.id);
        }
        for (const g of byType.values()) {
          items.push({
            label: `LAUNCH ${g.display.toUpperCase()} ×${g.count}`,
            action: () => handlers.onLaunchAircraft(ship.id, g.ids[0], g.category === 'helo' ? 'ASW' : 'CAP', null),
          });
        }
      }
      if (!ship.immobile && selected.length > 1) {
        items.push({
          label: 'CANCEL ORDERS',
          action: cancelOrders,
        });
      }
    }

    // Airborne aircraft (player or detected enemy).
    const aircraft = aircraftAtScreen(up, s, world.camera, world);
    if (aircraft) {
      if (aircraft.side === 'player') {
        items.push({
          label: `SELECT TRACK ${String(aircraft.id).padStart(4, '0')}`,
          action: () => {
            world.__selectedAircraft = [aircraft.id];
            world.__selectedProjectile = null;
            selected = [];
            handlers.onSelectionChange([]);
          },
        });
        items.push({ label: `RECOVER AIRCRAFT`, action: () => handlers.onRecoverAircraft(aircraft.id) });
        items.push({ label: `DRAW ROUTE`, action: () => handlers.onSetRouteDraw(aircraft.id, true) });
        const st = AIRCRAFT_STATS[aircraft.type] || AIRCRAFT_STATS.__default;
        for (const m of st.missions) {
          items.push({ label: `SET MISSION ${m}`, action: () => handlers.onSetMission(aircraft.id, m) });
        }
        return items;
      } else if (aircraft.side === 'enemy' && aircraft.detected) {
        if (mobileSel.length > 0) {
          items.push({
            label: `ATTACK TRACK ${String(aircraft.id).padStart(4, '0')}`,
            action: () => handlers.onAttackOrder(aircraft, mobileSel),
          });
        } else {
          items.push({ label: 'SELECT ENEMY', action: () => { world.__selectedProjectile = null; selected = []; handlers.onSelectionChange([]); } });
        }
        return items;
      }
    }

    if (ship && ship.side === 'enemy' && ship.detected) {
      if (mobileSel.length > 0) {
        items.push({
          label: `ATTACK TRACK ${String(ship.id).padStart(4, '0')}`,
          action: () => handlers.onAttackOrder(ship, mobileSel),
        });
      } else {
        items.push({ label: 'SELECT ENEMY', action: () => { world.__selectedProjectile = null; selected = []; handlers.onSelectionChange([]); } });
      }
    }

    // Waypoint handle (right-click): insert a new leg or delete the grabbed one.
    const wpHit = waypointAtScreen(up, s, world.camera, world);
    if (wpHit) {
      const ac = world.aircraft.find((a) => a.id === wpHit.acId && a.alive);
      if (ac && ac.side === 'player' && ac.order && ac.order.waypoints.length > 0) {
        const wpItems = [];
        wpItems.push({
          label: `SELECT TRACK ${String(ac.id).padStart(4, '0')}`,
          action: () => { world.__selectedAircraft = [ac.id]; world.__selectedProjectile = null; selected = []; handlers.onSelectionChange([]); },
        });
        if (ac.order.waypoints.length > 2) {
          wpItems.push({ label: 'DELETE WAYPOINT', action: () => handlers.onDeleteWaypoint(ac.id, wpHit.index) });
        }
        wpItems.push({ label: 'INSERT WAYPOINT', action: () => handlers.onInsertWaypoint(ac.id, wpHit.index) });
        return wpItems;
      }
    }

    if (!ship && !aircraft && mobileSel.length > 0) {
      const wp = screenToWorld(up, s, world.camera);
      const onLand = isPointOnLand(wp.x, wp.y);
      const target = onLand ? snapToSea(wp, world.camera.center) : wp;
      items.push({
        label: onLand ? 'MOVE TO NEAREST SEA' : 'MOVE TO GRID',
        action: () => handlers.onMoveOrder(target, mobileSel),
      });
    }

    if (selected.length > 0) {
      if (items.length > 0) items.push({ divider: true });
      items.push({ label: 'CANCEL ORDERS', action: cancelOrders });
      items.push({ label: 'CLEAR SELECTION', action: clearSelection });
    }

    if (items.length === 0) {
      items.push({ label: 'NO ACTIONS AVAILABLE', disabled: true });
    }
    return items;
  }

  function onContextMenu(e) {
    e.preventDefault();
    hideContextMenu();
    const items = buildMenuItems(e);
    showContextMenu(e.clientX, e.clientY, items);
  }

  function onWheel(ev) {
    ev.preventDefault();
    const factor = ev.deltaY < 0 ? 1.1 : 1 / 1.1;
    zoomCamera(world.camera, factor, { x: ev.offsetX, y: ev.offsetY }, size());
  }

  function onPointerDown(e) {
    hideContextMenu();
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer may already be released */ }
    const s = size();
    activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

    if (activePointers.size === 1) {
      // Begin a single-pointer gesture.
      pointerStart = { x: e.offsetX, y: e.offsetY };
      lastPan = { x: e.offsetX, y: e.offsetY };
      const ship = shipAtScreen(pointerStart, s, world.camera, world);
      startPlayerShip = ship && ship.side === 'player' ? ship : null;
      // Grab a flight-plan waypoint of the selected aircraft, if the press
      // starts on one. This takes priority over pan/box for that gesture.
      const wpHit = waypointAtScreen(pointerStart, s, world.camera, world);
      if (wpHit) {
        dragWaypoint = wpHit;
        mode = 'dragWaypoint';
      } else {
        dragWaypoint = null;
        mode = 'pending';
      }
    } else if (activePointers.size === 2) {
      // A second finger landed: switch to pinch, abandon any box.
      if (mode === 'box') world.__selectRect = undefined;
      mode = 'pending';
      pinching = true;
      const pts = [...activePointers.values()];
      pinchPrevDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
  }

  function onPointerMove(e) {
    if (!activePointers.has(e.pointerId)) return;
    const s = size();
    activePointers.set(e.pointerId, { x: e.offsetX, y: e.offsetY });

    if (activePointers.size >= 2) {
      // Pinch zoom: ratio of current distance / previous distance, about midpoint.
      const pts = [...activePointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const mid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      if (pinchPrevDist > 0 && dist > 0) {
        zoomCamera(world.camera, dist / pinchPrevDist, mid, s);
      }
      pinchPrevDist = dist;
      return;
    }

    // Single pointer gesture.
    if (mode === 'dragWaypoint' && dragWaypoint) {
      // Live-reposition the grabbed waypoint in world space.
      const w = screenToWorld({ x: e.offsetX, y: e.offsetY }, s, world.camera);
      const ac = world.aircraft.find((a) => a.id === dragWaypoint.acId && a.alive);
      if (ac && ac.order && ac.order.waypoints[dragWaypoint.index]) {
        // No world-box clamp: waypoints may be placed anywhere in the open
        // battle space (faithful to FC99), so just write the world coord.
        ac.order.waypoints[dragWaypoint.index].x = w.x;
        ac.order.waypoints[dragWaypoint.index].y = w.y;
      }
      lastPan = { x: e.offsetX, y: e.offsetY };
      return;
    }

    if (mode === 'pending') {
      if (Math.hypot(e.offsetX - pointerStart.x, e.offsetY - pointerStart.y) > DRAG_THRESHOLD) {
        // Drag confirmed. Hold Shift/Ctrl to box-select; otherwise pan the map.
        mode = (e.shiftKey || e.ctrlKey || e.metaKey) ? 'box' : 'pan';
      } else {
        return; // not a drag yet — stay put, no pan.
      }
    }

    if (mode === 'box') {
      const x = Math.min(pointerStart.x, e.offsetX);
      const y = Math.min(pointerStart.y, e.offsetY);
      world.__selectRect = {
        x,
        y,
        w: Math.abs(e.offsetX - pointerStart.x),
        h: Math.abs(e.offsetY - pointerStart.y),
      };
    }

    // Pan only in pan mode; box selection must keep the camera steady.
    if (mode === 'pan') {
      const dx = e.offsetX - lastPan.x;
      const dy = e.offsetY - lastPan.y;
      if (dx !== 0 || dy !== 0) {
        panCamera(world.camera, { x: dx, y: dy }, s);
      }
      lastPan = { x: e.offsetX, y: e.offsetY };
    }
  }

  function onPointerUp(e) {
    activePointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }

    if (activePointers.size >= 2) {
      // Still pinching with other fingers.
      const pts = [...activePointers.values()];
      pinchPrevDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      return;
    }
    if (activePointers.size === 1) {
      // One finger remains (2 -> 1): reset pan anchor to avoid a camera jump.
      const remaining = [...activePointers.values()][0];
      lastPan = { x: remaining.x, y: remaining.y };
      pinching = false;
      if (mode === 'box') world.__selectRect = undefined;
      mode = 'pan';
      return;
    }

    // No pointers left: finalize this gesture.
    const up = { x: e.offsetX, y: e.offsetY };
    const moved = pointerStart
      ? Math.hypot(up.x - pointerStart.x, up.y - pointerStart.y)
      : 0;

    if (mode === 'dragWaypoint') {
      // Waypoint drag finished (coords already live-updated in pointermove).
      dragWaypoint = null;
      world.__selectRect = undefined;
      mode = 'pending';
      return;
    }

    if (moved < DRAG_THRESHOLD) {
      // TAP.
      const projectile = projectileAtScreen(up, size(), world.camera, world);
      const ship = shipAtScreen(up, size(), world.camera, world);
      const aircraft = aircraftAtScreen(up, size(), world.camera, world);

      if (projectile) {
        world.__selectedProjectile = projectile.id;
        world.__selectedAircraft = [];
        selected = [];
        handlers.onSelectionChange([]);
      } else if (aircraft && (aircraft.side === 'player' || aircraft.detected)) {
        world.__selectedAircraft = [aircraft.id];
        world.__selectedProjectile = null;
        selected = [];
        handlers.onSelectionChange([]);
      } else if (ship && ship.side === 'player') {
        world.__selectedProjectile = null;
        world.__selectedAircraft = [];
        selected = [ship.id];
        handlers.onSelectionChange(selected);
      } else if (ship && ship.side === 'enemy' && ship.detected && selectedMobileIds().length > 0) {
        world.__selectedProjectile = null;
        handlers.onAttackOrder(ship, selectedMobileIds());
      } else if (world.__routeDraw != null) {
        // Building a flight plan: map taps append waypoints (no ship move).
        world.__selectedProjectile = null;
        const wp = screenToWorld(up, size(), world.camera);
        handlers.onAddWaypoint(world.__routeDraw, wp);
      } else if (!ship && selectedMobileIds().length > 0) {
        world.__selectedProjectile = null;
        world.__selectedAircraft = [];
        const wp = screenToWorld(up, size(), world.camera);
        const target = isPointOnLand(wp.x, wp.y) ? snapToSea(wp, world.camera.center) : wp;
        handlers.onMoveOrder(target, selectedMobileIds());
      } else {
        world.__selectedProjectile = null;
        world.__selectedAircraft = [];
        selected = [];
        handlers.onSelectionChange([]);
      }
    } else if (mode === 'box' && world.__selectRect) {
      // DRAG (box): commit the selection from the rect.
      world.__selectedProjectile = null;
      selected = playerShipsInRect(world.__selectRect, size(), world.camera, world);
      handlers.onSelectionChange(selected);
    }
    // Always clear the selection rect when the gesture ends.
    world.__selectRect = undefined;
    mode = 'pending';
  }

  function onPointerCancel(e) {
    activePointers.delete(e.pointerId);
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    if (activePointers.size === 0) {
      world.__selectRect = undefined;
      mode = 'pending';
    } else if (activePointers.size === 1) {
      const remaining = [...activePointers.values()][0];
      lastPan = { x: remaining.x, y: remaining.y };
      pinching = false;
      if (mode === 'box') world.__selectRect = undefined;
      mode = 'pan';
    }
  }

  function onGlobalPointerDown(e) {
    if (ctxMenu && !ctxMenu.contains(e.target)) hideContextMenu();
  }

  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('contextmenu', onContextMenu);
  if (window.addEventListener) window.addEventListener('pointerdown', onGlobalPointerDown);

  function detach() {
    canvas.removeEventListener('wheel', onWheel, { passive: false });
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerCancel);
    canvas.removeEventListener('contextmenu', onContextMenu);
    if (window.removeEventListener) window.removeEventListener('pointerdown', onGlobalPointerDown);
    activePointers.clear();
    hideContextMenu();
    if (world.__selectRect) world.__selectRect = undefined;
  }

  return detach;
}
