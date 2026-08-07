// contextmenu.js — shared right-click / long-press context menu for the battle
// view. Both the 2D input (input.js, flat map + tactical panel) and the 3D
// input (input3d.js, main perspective view) build their menu through
// buildContextMenuItems() and render it with showContextMenu(), so the exact
// same carrier/aircraft/ship actions are available from either view.
//
// `sel` is an adapter supplied by the host input module that owns the current
// selection. It must provide:
//   get()        -> current array of selected ship ids
//   set(ids)     -> replace selection (and notify handlers.onSelectionChange)
//   clear()      -> clear selection
//   mobileIds()  -> selected ids that are movable (non-immobile)
//   cancel()     -> cancel orders on the current selection

import {
  shipAtScreen,
  projectileAtScreen,
  aircraftAtScreen,
  waypointAtScreen,
  screenToWorld,
  AIRCRAFT_STATS,
} from './engine.js';
import { isPointOnLand, snapToSea } from './terrain.js';

// ---- rendering (DOM) --------------------------------------------------------
let ctxMenu = null;
export function hideContextMenu() {
  if (ctxMenu) {
    ctxMenu.remove();
    ctxMenu = null;
  }
}

export function showContextMenu(x, y, items) {
  hideContextMenu();
  if (!items || !items.length) return;
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

// ---- item building ----------------------------------------------------------
export function buildContextMenuItems(ctx) {
  const { world, handlers, screen, size, sel } = ctx;
  const projectile = projectileAtScreen(screen, size, world.camera, world);
  const ship = shipAtScreen(screen, size, world.camera, world);
  const mobileSel = sel.mobileIds();
  const items = [];

  if (projectile) {
    items.push({
      label: 'IDENTIFY WEAPON',
      action: () => {
        world.__selectedProjectile = projectile.id;
        sel.clear();
      },
    });
    items.push({ divider: true });
    items.push({ label: 'CLEAR SELECTION', action: () => sel.clear() });
    return items;
  }

  if (ship && ship.side === 'player') {
    items.push({
      label: `SELECT TRACK ${String(ship.id).padStart(4, '0')}`,
      action: () => {
        world.__selectedProjectile = null;
        sel.set([ship.id]);
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
        const mission = g.category === 'helo' ? 'ASW' : 'CAP';
        items.push({
          label: `LAUNCH ${g.display.toUpperCase()} ×${g.count}`,
          action: () => handlers.onLaunchAircraft(ship.id, g.ids[0], mission, null),
        });
        // Launch every airframe of this type in one tap.
        if (g.count > 1) {
          items.push({
            label: `LAUNCH ALL ${g.display.toUpperCase()} (×${g.count})`,
            action: () => handlers.onLaunchAircraftAll(ship.id, g.type, mission),
          });
        }
      }
    }
    if (!ship.immobile && sel.get().length > 1) {
      items.push({ label: 'CANCEL ORDERS', action: () => sel.cancel() });
    }
  }

  // Airborne aircraft (player or detected enemy).
  const aircraft = aircraftAtScreen(screen, size, world.camera, world);
  if (aircraft) {
    if (aircraft.side === 'player') {
      items.push({
        label: `SELECT TRACK ${String(aircraft.id).padStart(4, '0')}`,
        action: () => {
          world.__selectedAircraft = [aircraft.id];
          world.__selectedProjectile = null;
          sel.clear();
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
        items.push({ label: 'SELECT ENEMY', action: () => { world.__selectedProjectile = null; sel.clear(); } });
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
      items.push({ label: 'SELECT ENEMY', action: () => { world.__selectedProjectile = null; sel.clear(); } });
    }
  }

  // Waypoint handle (right-click): insert a new leg or delete the grabbed one.
  const wpHit = waypointAtScreen(screen, size, world.camera, world);
  if (wpHit) {
    const ac = world.aircraft.find((a) => a.id === wpHit.acId && a.alive);
    if (ac && ac.side === 'player' && ac.order && ac.order.waypoints.length > 0) {
      const wpItems = [];
      wpItems.push({
        label: `SELECT TRACK ${String(ac.id).padStart(4, '0')}`,
        action: () => { world.__selectedAircraft = [ac.id]; world.__selectedProjectile = null; sel.clear(); },
      });
      if (ac.order.waypoints.length > 2) {
        wpItems.push({ label: 'DELETE WAYPOINT', action: () => handlers.onDeleteWaypoint(ac.id, wpHit.index) });
      }
      wpItems.push({ label: 'INSERT WAYPOINT', action: () => handlers.onInsertWaypoint(ac.id, wpHit.index) });
      return wpItems;
    }
  }

  if (!ship && !aircraft && mobileSel.length > 0) {
    const wp = screenToWorld(screen, size, world.camera);
    const onLand = isPointOnLand(wp.x, wp.y);
    const target = onLand ? snapToSea(wp, world.camera.center) : wp;
    items.push({
      label: onLand ? 'MOVE TO NEAREST SEA' : 'MOVE TO GRID',
      action: () => handlers.onMoveOrder(target, mobileSel),
    });
  }

  if (sel.get().length > 0) {
    if (items.length > 0) items.push({ divider: true });
    items.push({ label: 'CANCEL ORDERS', action: () => sel.cancel() });
    items.push({ label: 'CLEAR SELECTION', action: () => sel.clear() });
  }

  if (items.length === 0) {
    items.push({ label: 'NO ACTIONS AVAILABLE', disabled: true });
  }
  return items;
}
