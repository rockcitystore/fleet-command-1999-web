// input3d.js — pointer/gesture handling for the 3D battle view.
//
// Interaction model (mouse / touch):
//   • Left-drag        -> pan the camera target across the sea
//   • Right/Middle-drag-> orbit (rotate azimuth + pitch elevation)
//   • Wheel            -> zoom (dolly the camera distance)
//   • Tap a unit       -> select it (Shift+tap toggles membership in selection)
//   • Tap a detected hostile -> issue ATTACK with the current selection
//   • Tap empty sea    -> issue MOVE for the current selection
//   • Right-click (no drag) -> context menu (launch aircraft, orders, etc.)
//
// Reuses the same handler contract as the 2D input (onSelectionChange /
// onMoveOrder / onAttackOrder), so the engine never knows which view is active.

import { buildContextMenuItems, showContextMenu, hideContextMenu } from './contextmenu.js';

export function attachInput3D(canvas, world, handlers, scene) {
  let dragging = false, moved = false, btn = 0, sx = 0, sy = 0;

  const onDown = (e) => {
    try { canvas.setPointerCapture(e.pointerId); } catch (_) {}
    dragging = true; moved = false; btn = e.button; sx = e.clientX; sy = e.clientY;
  };

  const onMove = (e) => {
    if (!dragging) return;
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    if (moved) {
      if (btn === 2 || btn === 1) scene.orbit(dx, dy);
      else scene.pan(dx, dy);
      sx = e.clientX; sy = e.clientY;
    }
  };

  const onUp = (e) => {
    if (!dragging) return;
    dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch (_) {}
    if (moved) return; // it was a drag, not a tap
    // Right-click without dragging opens the context menu (left-tap below).
    if (btn === 2) {
      openContextMenu(e);
      return;
    }
    const cur = (world.__selected && world.__selected.slice()) || [];
    const hitId = scene.pick(e.clientX, e.clientY, world);
    if (hitId != null) {
      const s = world.ships.find((sh) => sh.id === hitId) ||
                world.aircraft.find((a) => a.id === hitId);
      if (s && s.side === 'enemy' && s.detected) {
        handlers.onAttackOrder(s, cur.length ? cur : [s.id]);
      } else if (s) {
        if (e.shiftKey) {
          const set = new Set(cur);
          if (set.has(hitId)) set.delete(hitId); else set.add(hitId);
          handlers.onSelectionChange([...set]);
        } else {
          handlers.onSelectionChange([hitId]);
        }
      }
    } else {
      const wpos = scene.screenToWorld(e.clientX, e.clientY);
      if (wpos && cur.length) handlers.onMoveOrder(wpos, cur);
    }
  };

  // Build + show the shared context menu for the 3D view. Selection state lives
  // in world.__selected (set via handlers.onSelectionChange), so adapt to `sel`.
  function openContextMenu(e) {
    const rect = canvas.getBoundingClientRect();
    const sel = {
      get: () => world.__selected || [],
      set: (ids) => handlers.onSelectionChange(ids),
      clear: () => handlers.onSelectionChange([]),
      mobileIds: () => (world.__selected || []).filter((id) => {
        const s = world.ship(id);
        return s && !s.immobile;
      }),
      cancel: () => {
        for (const id of (world.__selected || [])) {
          const s = world.ship(id);
          if (s) { s.order = null; s.targetId = null; }
        }
        handlers.onSelectionChange(world.__selected || []);
      },
    };
    const items = buildContextMenuItems({
      world,
      handlers,
      screen: { x: e.clientX - rect.left, y: e.clientY - rect.top },
      size: { width: canvas.clientWidth, height: canvas.clientHeight },
      sel,
    });
    showContextMenu(e.clientX, e.clientY, items);
  }

  function onGlobalPointerDown(e) {
    // Dismiss the context menu when the user clicks elsewhere. The menu panel
    // swallows its own clicks (stopPropagation on rows), so an outside press here
    // always means "close it".
    hideContextMenu();
  }

  const onWheel = (e) => { e.preventDefault(); scene.zoom(e.deltaY > 0 ? 1.1 : 0.9); };
  const onCtx = (e) => { e.preventDefault(); };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('contextmenu', onCtx);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('pointerdown', onGlobalPointerDown);

  return () => {
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('contextmenu', onCtx);
    window.removeEventListener('wheel', onWheel);
    window.removeEventListener('pointerdown', onGlobalPointerDown);
    hideContextMenu();
  };
}
