// main.js — integration glue + real-time render loop.
// Wires engine <-> render <-> input <-> ui. Runs in the browser as an ES module.

import { makeWorld, makeCustomWorld, fitCameraToWorld, makeAircraftOrder } from './engine.js';
import { buildLandPolygons } from './geo.js';
import { drawBattle, drawMinimap, RENDER_OPTIONS } from './render.js';
import { attachInput, attachInput2DPanel } from './input.js';
import { Scene3D } from './render3d.js';
import { attachInput3D } from './input3d.js';
import { buildMenu, buildBattleHUD, updateHUD, buildReference, showCoach } from './ui.js';
import { AICommander } from './aiCommander.js';

// Local-LLM (Ollama / qwen3.5:4b) RED fleet commander. Created once and reused
// across battles; reset to BUILTIN at each battle start.
const aiCommander = new AICommander();


const MINIMAP_PX = 140;

const dom = {
  screenMenu: document.getElementById('screen-menu'),
  screenBattle: document.getElementById('screen-battle'),
  screenReference: document.getElementById('screen-reference'),
  map: document.getElementById('map'),
  map3d: document.getElementById('map3d'),
  map2d: document.getElementById('map2d'),
  minimap: document.getElementById('minimap'),
  controlbar: document.getElementById('controlbar'),
};

let referenceDataCache = null;
async function loadReferenceData() {
  if (referenceDataCache) return referenceDataCache;
  const res = await fetch('assets/data/reference.json');
  if (!res.ok) throw new Error('reference.json ' + res.status);
  referenceDataCache = await res.json();
  return referenceDataCache;
}

const game = {
  world: null,
  rafId: 0,
  detachInput: null,
  detachInput3d: null,
  scene3d: null,
  renderMode: '3d', // '3d' = WebGL perspective main view; '2d' = legacy flat map
  swapped: false,   // when true, main screen shows the 2D tactical map and the
                    // bottom-centre panel shows the primary (3D/2D) view.
  subView: false,   // when true, the 3D camera is dived below the surface.
  detachInput2dTac: null, // input for the big tactical map when swapped
  detachInput2dPanel: null, // input for the small bottom 2D tactical panel
  mapCtx: null,
  miniCtx: null,
  map2dCtx: null,
};

// --- Real music from the original 1999 Fleet Command (assets/audio/*.wav) ---
const MUSIC_TRACKS = [
  'assets/audio/AegMus6.wav', 'assets/audio/Aegmus1.wav', 'assets/audio/Aegmus2.wav',
  'assets/audio/Aegmus3.wav', 'assets/audio/Aegmus4.wav', 'assets/audio/Aegmus5.wav',
  'assets/audio/CMNDCNTR.wav', 'assets/audio/Credits.wav',
];
let musicIndex = 0;
let musicAudio = null;
function ensureMusicAudio() {
  if (musicAudio) return musicAudio;
  const a = new Audio();
  a.preload = 'auto';
  a.addEventListener('ended', () => {
    musicIndex = (musicIndex + 1) % MUSIC_TRACKS.length;
    a.src = MUSIC_TRACKS[musicIndex];
    a.play().catch(() => {});
  });
  musicAudio = a;
  return a;
}
function setMusic(on) {
  const a = ensureMusicAudio();
  if (on) {
    a.src = MUSIC_TRACKS[musicIndex];
    a.play().catch(() => {});
  } else {
    a.pause();
  }
}
function stopMusic() { if (musicAudio) musicAudio.pause(); }

// --- Canvas sizing with devicePixelRatio ---
function fitCanvas(canvas, ctx, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // draw in CSS-px coordinates
}

function resizeCanvases() {
  // The 3D renderer is sized from whichever canvas currently holds it
  // (#map3d), which is in the bottom panel when SWAP is active.
  const mw = dom.map3d.clientWidth || dom.map.clientWidth || window.innerWidth;
  const mh = dom.map3d.clientHeight || dom.map.clientHeight || window.innerHeight;
  if (game.mapCtx) fitCanvas(dom.map, game.mapCtx, dom.map.clientWidth || mw, dom.map.clientHeight || mh);
  if (game.scene3d) game.scene3d.resize(mw, mh);
  const miniW = dom.minimap.clientWidth || MINIMAP_PX;
  const miniH = dom.minimap.clientHeight || MINIMAP_PX;
  if (game.miniCtx) fitCanvas(dom.minimap, game.miniCtx, miniW, miniH);
  const twoW = dom.map2d.clientWidth || 320;
  const twoH = dom.map2d.clientHeight || 180;
  if (game.map2dCtx) fitCanvas(dom.map2d, game.map2dCtx, twoW, twoH);
}

// Toggle canvas visibility to match the active render mode, and label the
// 2D/3D control-bar button. The 2D tactical map is always shown when SWAP is
// active (it becomes the main view); otherwise only in 3D mode.
function applyRenderModeVisibility() {
  const is3d = game.renderMode === '3d';
  if (dom.map) dom.map.classList.toggle('hidden', is3d);
  if (dom.map3d) dom.map3d.classList.toggle('hidden', !is3d);
  if (dom.map2d) dom.map2d.classList.toggle('hidden', !(is3d || game.swapped));
  const vb = document.getElementById('btn-viewmode');
  if (vb) vb.textContent = is3d ? '3D' : '2D';
}

// Reparent the battle canvases so the main screen and the bottom-centre
// TACTICAL MAP panel swap contents. Driven by game.swapped.
function applySwapLayout() {
  const main = dom.screenBattle;
  const panel = document.getElementById('panel-3d');
  if (!panel) return;
  const move = (el, parent, slot) => {
    if (!el) return;
    if (el.parentElement !== parent) parent.appendChild(el);
    el.classList.toggle('main-slot', slot === 'main');
    el.classList.toggle('panel3-slot', slot === 'panel');
  };
  if (game.swapped) {
    move(dom.map2d, main, 'main');    // tactical map -> main screen
    move(dom.map3d, panel, 'panel');  // 3D -> bottom-centre panel
    move(dom.map, panel, 'panel');    // flat 2D -> bottom-centre panel
  } else {
    move(dom.map3d, main, 'main');    // 3D -> main screen
    move(dom.map, main, 'main');      // flat 2D -> main screen
    move(dom.map2d, panel, 'panel');  // tactical map -> bottom-centre panel
  }
}

// When SWAP is active in 3D mode, the big 2D tactical map becomes the
// authoritative camera and the small 3D view follows it. Attach the unified
// 2D input (with its right-click context menu) to that canvas.
function refreshViewInput() {
  if (game.detachInput2dTac) { game.detachInput2dTac(); game.detachInput2dTac = null; }
  if (game.detachInput2dPanel) { game.detachInput2dPanel(); game.detachInput2dPanel = null; }
  const wantTacInput = game.swapped && game.renderMode === '3d' && game.world && game.map2dCtx;
  if (wantTacInput) {
    game.detachInput2dTac = attachInput(dom.map2d, game.world, game.world.__handlers);
  }
  // Attach lightweight pan/zoom input to the small bottom 2D tactical panel
  // whenever it is visible but not swapped into the main view.
  const wantPanelInput = !game.swapped && game.renderMode === '3d' && game.world && game.map2dCtx && game.scene3d;
  if (wantPanelInput) {
    game.detachInput2dPanel = attachInput2DPanel(dom.map2d, game.world, game.scene3d);
  }
}

function setSwapped(on) {
  if (game.swapped === !!on) return;
  game.swapped = !!on;
  applySwapLayout();
  applyRenderModeVisibility();
  refreshViewInput();
  if (!game.swapped && game.map2dCtx && game.scene3d) {
    game.detachInput2dPanel = attachInput2DPanel(dom.map2d, world, game.scene3d);
  }
  resizeCanvases();
}

// --- Screen switching ---
function showMenu() {
  if (game.rafId) cancelAnimationFrame(game.rafId);
  game.rafId = 0;
  if (game.detachInput) { game.detachInput(); game.detachInput = null; }
  if (game.detachInput3d) { game.detachInput3d(); game.detachInput3d = null; }
  if (game.detachInput2dTac) { game.detachInput2dTac(); game.detachInput2dTac = null; }
  if (game.detachInput2dPanel) { game.detachInput2dPanel(); game.detachInput2dPanel = null; }
  if (game.scene3d) { game.scene3d.dispose(); game.scene3d = null; }
  stopMusic();
  game.world = null;
  dom.screenBattle.classList.add('hidden');
  dom.screenReference.classList.add('hidden');
  dom.screenMenu.classList.remove('hidden');
}

async function showReference() {
  dom.screenMenu.classList.add('hidden');
  dom.screenBattle.classList.add('hidden');
  dom.screenReference.classList.remove('hidden');
  try {
    const data = await loadReferenceData();
    buildReference(data, { onBack: () => showMenu() });
  } catch (err) {
    const grid = document.getElementById('ref-grid');
    if (grid) grid.innerHTML = '<div class="rc-sub">UNABLE TO LOAD REFERENCE DATA.</div>';
    console.error('Reference load failed:', err);
  }
}

// Shared input handlers (ships + aircraft). Built per-world so closures capture
// the right `world` reference; used by both scenario and custom battles.
function makeInputHandlers(world) {
  return {
    onSelectionChange: (ids) => { world.__selected = ids; },
    onMoveOrder: (pos, ids) => { world.issueOrder({ kind: 'moveTo', pos }, ids); },
    onAttackOrder: (target, ids) => { world.issueOrder({ kind: 'attack', targetId: target.id }, ids); },

    // ---- Aircraft ----
    onLaunchAircraft: (platformId, aircraftId, mission, waypoints) => {
      const ac = world.launchAircraft(platformId, aircraftId, mission, waypoints);
      if (ac) {
        world.__selectedAircraft = [ac.id];
        world.__selected = [];
        updateHUD(world);
      }
    },
    onRecoverAircraft: (aircraftId) => {
      world.recoverAircraft(aircraftId);
      if (world.__selectedAircraft && world.__selectedAircraft[0] === aircraftId) world.__selectedAircraft = [];
      updateHUD(world);
    },
    onSetRouteDraw: (aircraftId, on) => {
      world.__routeDraw = on ? aircraftId : null;
      if (on && aircraftId != null) {
        const ac = world.aircraft.find((a) => a.id === aircraftId && a.alive);
        if (ac) {
          ac.order = {
            kind: 'flyTo',
            waypoints: [{ x: ac.pos.x, y: ac.pos.y, alt: ac.targetAlt, speed: ac.maxSpeed }],
            wpIndex: 0,
            loop: ac.mission === 'patrol' || ac.mission === 'CAP',
          };
        }
      }
      updateHUD(world);
    },
    onAddWaypoint: (aircraftId, wp) => {
      const ac = world.aircraft.find((a) => a.id === aircraftId && a.alive);
      if (!ac) return;
      if (!ac.order || ac.order.kind !== 'flyTo') {
        ac.order = {
          kind: 'flyTo',
          waypoints: [{ x: ac.pos.x, y: ac.pos.y, alt: ac.targetAlt, speed: ac.maxSpeed }],
          wpIndex: 0,
          loop: ac.mission === 'patrol' || ac.mission === 'CAP',
        };
      }
      ac.order.waypoints.push({ x: wp.x, y: wp.y, alt: ac.targetAlt, speed: ac.maxSpeed });
    },
    onSetMission: (aircraftId, mission) => {
      const ac = world.aircraft.find((a) => a.id === aircraftId && a.alive);
      if (!ac) return;
      ac.mission = mission;
      if (ac.order && ac.order.kind === 'flyTo') {
        ac.order.loop = (mission === 'patrol' || mission === 'CAP');
      } else {
        ac.order = makeAircraftOrder(ac, mission);
      }
      updateHUD(world);
    },
    onDeleteWaypoint: (aircraftId, index) => {
      const ac = world.aircraft.find((a) => a.id === aircraftId && a.alive);
      if (!ac || !ac.order || ac.order.waypoints.length <= 2) return;
      ac.order.waypoints.splice(index, 1);
      if (ac.order.wpIndex > index) ac.order.wpIndex--;
      updateHUD(world);
    },
    onInsertWaypoint: (aircraftId, index) => {
      const ac = world.aircraft.find((a) => a.id === aircraftId && a.alive);
      if (!ac || !ac.order || ac.order.kind !== 'flyTo') return;
      const wps = ac.order.waypoints;
      const a = wps[index];
      const b = wps[index + 1] || a;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, alt: ac.targetAlt, speed: ac.maxSpeed };
      wps.splice(index + 1, 0, mid);
      updateHUD(world);
    },
  };
}

function startGame(index) {
  const world = makeWorld(index);
  world.__selected = [];
  mountBattle(world);
}

function startCustom(opts) {
  const world = makeCustomWorld(opts || {});
  world.__selected = [];
  mountBattle(world);
}

// Build the HUD + wire the correct view (3D or 2D) + input for a live world.
function mountBattle(world) {
  dom.screenMenu.classList.add('hidden');
  dom.screenBattle.classList.remove('hidden');

  // Tear down any previous view first.
  if (game.detachInput) { game.detachInput(); game.detachInput = null; }
  if (game.detachInput3d) { game.detachInput3d(); game.detachInput3d = null; }
  if (game.detachInput2dTac) { game.detachInput2dTac(); game.detachInput2dTac = null; }
  if (game.detachInput2dPanel) { game.detachInput2dPanel(); game.detachInput2dPanel = null; }
  if (game.scene3d) { game.scene3d.dispose(); game.scene3d = null; }
  game.mapCtx = null;

  buildBattleHUD(dom.controlbar, world, {
    onControlChange: () => updateHUD(world),
    onMenu: () => showMenu(),
    onMusic: (on) => setMusic(on),
  });

  const handlers = makeInputHandlers(world);
  world.__handlers = handlers;
  applyRenderModeVisibility();

  if (game.renderMode === '3d') {
    try {
      game.scene3d = new Scene3D(dom.map3d, world);
    } catch (err) {
      // WebGL unavailable (e.g. blocked GPU): degrade gracefully to 2D.
      console.warn('[3D] WebGL init failed, falling back to 2D view:', err && err.message);
      game.renderMode = '2d';
      applyRenderModeVisibility();
    }
  }

  if (game.renderMode === '3d' && game.scene3d) {
    game.scene3d.frameShips(world);
    if (game.subView) game.scene3d.setUnderwater(true);
    game.miniCtx = dom.minimap.getContext('2d');
    game.map2dCtx = dom.map2d.getContext('2d');
    game.detachInput3d = attachInput3D(dom.map3d, world, handlers, game.scene3d);
  } else {
    game.mapCtx = dom.map.getContext('2d');
    game.miniCtx = dom.minimap.getContext('2d');
    game.map2dCtx = null;
    fitCameraToWorld(world.camera, { width: dom.map.clientWidth, height: dom.map.clientHeight }, world);
    game.detachInput = attachInput(dom.map, world, handlers);
  }

  applySwapLayout();
  applyRenderModeVisibility();
  refreshViewInput();
  if (!game.swapped && game.map2dCtx && game.scene3d) {
    game.detachInput2dPanel = attachInput2DPanel(dom.map2d, world, game.scene3d);
  }
  resizeCanvases();
  game.world = world;

  // Enemy command source starts as the built-in deterministic doctrine.
  world.aiMode = 'builtin';
  aiCommander.setEnabled(false);
  aiCommander.lastError = null;
  syncAIModeUI();

  if (!game.rafId) loop();
}

// Toggle the RED fleet between the built-in doctrine and the local LLM.
function setAIMode(mode) {
  const world = game.world;
  if (!world) return;
  if (mode === 'llm') {
    world.aiMode = 'llm';
    aiCommander.setEnabled(true);
    // Kick off an immediate first decision (don't wait a full throttle window).
    aiCommander.tick(world, { force: true }).catch(() => {});
  } else {
    world.aiMode = 'builtin';
    aiCommander.setEnabled(false);
  }
  syncAIModeUI();
}

// Reflect the current AI mode in the control-bar button + status readout.
function syncAIModeUI() {
  const btn = document.getElementById('btn-ai');
  const status = document.getElementById('ai-status');
  const live = document.getElementById('ai-live');
  const panel = document.getElementById('ai-cic-panel');
  const panelText = document.getElementById('ai-cic-text');
  const llm = game.world && game.world.aiMode === 'llm';
  if (btn) {
    btn.textContent = llm ? 'AI: LLM' : 'AI: BUILTIN';
    btn.classList.toggle('active', !!llm);
  }
  if (status) {
    status.textContent = aiCommander.statusText();
    status.classList.toggle('ai-llm', !!llm && !aiCommander.lastError);
    status.classList.toggle('ai-error', !!aiCommander.lastError);
    status.title = aiCommander.lastBrief || '';
  }
  if (live) {
    const streaming = aiCommander.phase === 'thinking' || aiCommander.phase === 'streaming';
    live.textContent = aiCommander.livePreview();
    live.classList.toggle('live', !!streaming);
    live.title = streaming ? aiCommander.liveText : (aiCommander.lastBrief || '');
  }
  if (panel && panelText) {
    const show = !!llm || !!aiCommander.lastError || (aiCommander.liveText && aiCommander.liveText !== '');
    panel.classList.toggle('hidden', !show);
    panelText.textContent = aiCommander.livePreview();
    panel.classList.toggle('thinking', aiCommander.phase === 'thinking');
    panel.classList.toggle('streaming', aiCommander.phase === 'streaming');
    panel.classList.toggle('done', aiCommander.phase === 'done');
    panel.classList.toggle('error', !!aiCommander.lastError);
  }
}

function startTutorial() {
  startGame(0);
  // Coach marks appear once the battle is on screen.
  setTimeout(() => showCoach(dom.screenBattle), 500);
}

// Switch between the 3D perspective main view and the legacy 2D flat map for
// the currently-loaded battle. Re-uses the existing world + handlers.
function toggleViewMode() {
  const world = game.world;
  if (!world) return;
  game.renderMode = game.renderMode === '3d' ? '2d' : '3d';
  if (game.detachInput) { game.detachInput(); game.detachInput = null; }
  if (game.detachInput3d) { game.detachInput3d(); game.detachInput3d = null; }
  if (game.detachInput2dTac) { game.detachInput2dTac(); game.detachInput2dTac = null; }
  if (game.detachInput2dPanel) { game.detachInput2dPanel(); game.detachInput2dPanel = null; }
  if (game.scene3d) { game.scene3d.dispose(); game.scene3d = null; }
  game.mapCtx = null;

  const handlers = world.__handlers || makeInputHandlers(world);
  applyRenderModeVisibility();

  if (game.renderMode === '3d') {
    try {
      game.scene3d = new Scene3D(dom.map3d, world);
    } catch (err) {
      console.warn('[3D] WebGL init failed, falling back to 2D view:', err && err.message);
      game.renderMode = '2d';
      applyRenderModeVisibility();
    }
  }

  if (game.renderMode === '3d' && game.scene3d) {
    game.scene3d.frameShips(world);
    if (game.subView) game.scene3d.setUnderwater(true);
    game.miniCtx = dom.minimap.getContext('2d');
    game.map2dCtx = dom.map2d.getContext('2d');
    game.detachInput3d = attachInput3D(dom.map3d, world, handlers, game.scene3d);
  } else {
    game.mapCtx = dom.map.getContext('2d');
    game.miniCtx = dom.minimap.getContext('2d');
    game.map2dCtx = null;
    fitCameraToWorld(world.camera, { width: dom.map.clientWidth, height: dom.map.clientHeight }, world);
    game.detachInput = attachInput(dom.map, world, handlers);
  }
  applySwapLayout();
  applyRenderModeVisibility();
  refreshViewInput();
  if (!game.swapped && game.map2dCtx && game.scene3d) {
    game.detachInput2dPanel = attachInput2DPanel(dom.map2d, world, game.scene3d);
  }
  resizeCanvases();
}

// --- Real-time loop (separate from drawing; no state mutation inside draw) ---
function loop() {
  game.rafId = requestAnimationFrame(loop);
  const world = game.world;
  if (!world) return;

  resizeCanvases();
  world.advanceRealtime();

  // Local-LLM RED fleet commander: throttled + async, fire-and-forget. It is a
  // no-op unless the player has switched AI mode to LLM. Keeps the enemy acting
  // without ever blocking the render loop.
  if (world.aiMode === 'llm') aiCommander.tick(world).catch(() => {});
  syncAIModeUI();

  const msize = { width: dom.map.clientWidth || window.innerWidth, height: dom.map.clientHeight || window.innerHeight };

  if (game.renderMode === '3d' && game.scene3d) {
    if (game.swapped) {
      // SWAP: the big 2D tactical map (now main) is authoritative — its own
      // input drives world.camera, and the small 3D view in the bottom-centre
      // panel mirrors it.
      const threeH = dom.map3d.clientHeight || msize.height;
      const fov = (game.scene3d.camera.fov * Math.PI) / 180;
      game.scene3d.target.x = world.camera.center.x;
      game.scene3d.target.z = world.camera.center.y;
      game.scene3d.distance = Math.max(80, (threeH / 2) / (world.camera.zoom || 1) / Math.tan(fov / 2));
      game.scene3d.render(world);
    } else {
      // Default: 3D (main) drives the bottom 2D top-down + minimap camera.
      world.camera.center.x = game.scene3d.target.x;
      world.camera.center.y = game.scene3d.target.z;
      world.camera.zoom = game.scene3d.topDownZoom(msize.height);
      game.scene3d.render(world);
    }
    if (game.map2dCtx) {
      const two = { width: dom.map2d.clientWidth || 320, height: dom.map2d.clientHeight || 180 };
      drawBattle(game.map2dCtx, world, two);
    }
    const minisize = { width: dom.minimap.clientWidth || MINIMAP_PX, height: dom.minimap.clientHeight || MINIMAP_PX };
    drawMinimap(game.miniCtx, world, minisize, msize);
  } else {
    drawBattle(game.mapCtx, world, msize);
    const minisize = { width: dom.minimap.clientWidth || MINIMAP_PX, height: dom.minimap.clientHeight || MINIMAP_PX };
    drawMinimap(game.miniCtx, world, minisize, msize);
  }
  updateHUD(world);
}

// --- Boot ---
buildMenu(null, {
  onStart: (i) => startGame(i),
  onReference: () => showReference(),
  onStartCustom: (opts) => startCustom(opts),
  onTutorial: () => startTutorial(),
  onMusic: (on) => setMusic(on),
});
window.addEventListener('resize', resizeCanvases);
const viewBtn = document.getElementById('btn-viewmode');
if (viewBtn) viewBtn.addEventListener('click', () => toggleViewMode());
const swapBtn = document.getElementById('btn-swap');
if (swapBtn) swapBtn.addEventListener('click', () => setSwapped(!game.swapped));
const aiBtn = document.getElementById('btn-ai');
if (aiBtn) aiBtn.addEventListener('click', () => {
  setAIMode(game.world && game.world.aiMode === 'llm' ? 'builtin' : 'llm');
});
const aiPanel = document.getElementById('ai-cic-panel');
if (aiPanel) aiPanel.addEventListener('click', () => aiPanel.classList.toggle('expanded'));
// SUB VIEW: dive the 3D camera below the surface so submarines (drawn at real
// depth through the now-translucent sea) become visible.
const subBtn = document.getElementById('btn-subview');
function toggleSubView() {
  if (!game.scene3d) return;
  game.subView = !game.subView;
  game.scene3d.setUnderwater(game.subView);
  if (subBtn) subBtn.classList.toggle('active', !!game.subView);
}
if (subBtn) subBtn.addEventListener('click', toggleSubView);
// Convenience key: 'U' toggles the sub-surface view (ignored while typing).
window.addEventListener('keydown', (e) => {
  if ((e.key === 'u' || e.key === 'U') && !/input|textarea/i.test(e.target.tagName)) toggleSubView();
});
// Debug hook for automated verification (harmless in production).
window.__fc = game;
window.__fc.makeAircraftOrder = makeAircraftOrder;
window.__fc.RENDER_OPTIONS = RENDER_OPTIONS;
window.__fc.startGame = startGame;
window.__fc.setAIMode = setAIMode;
window.__fc.aiCommander = aiCommander;
window.__fc.startCustom = startCustom;
window.__fc.buildLandPolygons = buildLandPolygons;
