// Headless integration test: fake DOM + fake Canvas, exercise the FULL pipeline
// (ui.js + render.js + input.js + engine.js) and simulate clicks. Proves the
// previously-broken "can't click" path works at the logic level.
//
// Run: node js/integration.test.mjs   (from code/web)

// ---- minimal fake DOM ----
const elCache = new Map();
function makeEl(id) {
  const e = {
    id, _l: {}, style: {}, textContent: '', innerHTML: '', tabIndex: 0, width: 0, height: 0, dataset: {},
    classList: {
      _s: new Set(),
      add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); },
      contains(c) { return this._s.has(c); },
      toggle(c, f) { if (f === undefined) { this._s.has(c) ? this._s.delete(c) : this._s.add(c); } else { f ? this._s.add(c) : this._s.delete(c); } },
    },
    setAttribute() {}, appendChild() {},
    addEventListener(ev, fn) { (this._l[ev] = this._l[ev] || []).push(fn); },
    removeEventListener(ev, fn) { if (this._l[ev]) this._l[ev] = this._l[ev].filter((f) => f !== fn); },
    getContext() { return fakeCtx; },
    setPointerCapture() {}, releasePointerCapture() {},
    get clientWidth() { return 900; }, get clientHeight() { return 640; },
    dispatch(ev, evt) { (this._l[ev] || []).forEach((f) => f(evt)); },
  };
  return e;
}
const fakeCtx = new Proxy({}, {
  get(t, p) {
    if (p === 'canvas') return { width: 900, height: 640 };
    if (typeof p === 'string') return (...a) => {};
    return undefined;
  },
  set() { return true; },
});
globalThis.document = {
  getElementById(id) { if (!elCache.has(id)) elCache.set(id, makeEl(id)); return elCache.get(id); },
  createElement() { return makeEl('dyn'); },
};
// Mock the main-menu nav buttons that buildMenu() queries by CSS selector.
const menuBtns = ['campaign', 'single', 'tutorials', 'editor', 'reference', 'options'].map((act) => {
  const b = makeEl('menu-btn-' + act);
  b.dataset = { act };
  return b;
});
globalThis.document.querySelectorAll = (sel) => (sel.includes('.menu-btn') ? menuBtns : []);
globalThis.document.querySelector = (sel) => (sel.includes('.menu-btn') ? (menuBtns[0] || null) : null);
globalThis.window = { devicePixelRatio: 1, innerWidth: 900, innerHeight: 640, addEventListener() {} };

// ---- imports (after globals are set) ----
const E = await import('./engine.js');
const { drawBattle, drawMinimap } = await import('./render.js');
const { attachInput } = await import('./input.js');
const { buildMenu, buildBattleHUD, updateHUD } = await import('./ui.js');

let failures = 0;
function check(name, cond) {
  if (cond) { console.log('PASS:', name); } else { console.log('FAIL:', name); failures++; }
}

// 1. Build menu + HUD without throwing.
let menuOk = true, hudOk = true, drawOk = true;
try { buildMenu(null, { onStart: () => {} }); } catch (e) { menuOk = false; console.log('menu threw', e.message); }
const world = E.makeWorld(0);
world.__selected = [];
try { buildBattleHUD(document.getElementById('controlbar'), world, { onControlChange() {}, onMenu() {} }); } catch (e) { hudOk = false; console.log('hud threw', e.message); }
try {
  drawBattle(fakeCtx, world, { width: 900, height: 640 });
  drawMinimap(fakeCtx, world, { width: 140, height: 140 }, { width: 900, height: 640 });
  updateHUD(world);
} catch (e) { drawOk = false; console.log('draw threw', e.message); }
check('buildMenu/buildBattleHUD/updateHUD/draw* run without throwing', menuOk && hudOk && drawOk);

// 2. Simulation step advances + stays in bounds (call pure fns directly, time-independent).
for (let i = 0; i < 300; i++) {
  E.updateMovement(world, 1 / 60); E.updateDetection(world); E.updateWeapons(world, 1 / 60);
  E.updateProjectiles(world, 1 / 60); E.updateAI(world, 1 / 60); E.checkEnd(world);
}
// The battle space is now open (no world-box clamp), so we no longer assert a
// hard [0,4000] bound — instead confirm positions stay finite (no NaN blow-up)
// and the sim phase is valid.
const finite = world.ships.every((s) => Number.isFinite(s.pos.x) && Number.isFinite(s.pos.y));
check('300-tick sim finite positions & valid phase', finite && ['playing', 'playerWon', 'enemyWon'].includes(world.phase));

// 3. CLICK-SELECT: tap exactly on a player ship's screen position → onSelectionChange([id])
const map = document.getElementById('map');
let selected = null, moveOrder = null, attackOrder = null;
const detach = attachInput(map, world, {
  onSelectionChange: (ids) => { selected = ids; },
  onMoveOrder: (pos, ids) => { moveOrder = { pos, ids }; },
  onAttackOrder: (t, ids) => { attackOrder = { t, ids }; },
});
const playerShip = world.aliveShips('player').find((s) => !s.immobile) || world.aliveShips('player')[0];
const sp = E.worldToScreen(playerShip.pos, { width: 900, height: 640 }, world.camera);
map.dispatch('pointerdown', { pointerId: 1, offsetX: sp.x, offsetY: sp.y });
map.dispatch('pointerup', { pointerId: 1, offsetX: sp.x, offsetY: sp.y });
check('tap on player ship selects it', Array.isArray(selected) && selected.length === 1 && selected[0] === playerShip.id);

// 4. CLICK-MOVE: with a selection, tap empty sea → onMoveOrder(worldPos, ids)
map.dispatch('pointerdown', { pointerId: 2, offsetX: 5, offsetY: 5 });
map.dispatch('pointerup', { pointerId: 2, offsetX: 5, offsetY: 5 });
check('tap on empty sea issues move order for selection', !!moveOrder && Array.isArray(moveOrder.ids) && moveOrder.ids.includes(playerShip.id) && typeof moveOrder.pos.x === 'number');

// 5. WHEEL zoom changes camera.zoom
const z0 = world.camera.zoom;
map.dispatch('wheel', { deltaY: -100, offsetX: 450, offsetY: 320, preventDefault() {} });
check('wheel zoom-in increases camera.zoom', world.camera.zoom > z0);

// 6. BOX SELECT: hold Shift and drag on empty sea to draw the selection box, NOT pan the camera.
const camBefore = { x: world.camera.center.x, y: world.camera.center.y };
selected = null;
map.dispatch('pointerdown', { pointerId: 7, offsetX: 100, offsetY: 100, shiftKey: true });
map.dispatch('pointermove', { pointerId: 7, offsetX: 170, offsetY: 170, shiftKey: true });
map.dispatch('pointerup', { pointerId: 7, offsetX: 170, offsetY: 170, shiftKey: true });
const camAfter = { x: world.camera.center.x, y: world.camera.center.y };
check('box selection on empty sea does not pan camera (Shift+drag)',
  Math.round(camBefore.x) === Math.round(camAfter.x) &&
  Math.round(camBefore.y) === Math.round(camAfter.y) &&
  Array.isArray(selected));

detach();
console.log(failures === 0 ? '\nALL INTEGRATION CHECKS PASSED' : `\n${failures} INTEGRATION CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
