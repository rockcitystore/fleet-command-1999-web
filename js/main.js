// main.js — integration glue + real-time render loop.
// Wires engine <-> render <-> input <-> ui. Runs in the browser as an ES module.

import { makeWorld, makeCustomWorld, fitCameraToWorld, makeAircraftOrder } from './engine.js';
import { drawBattle, drawMinimap, RENDER_OPTIONS } from './render.js';
import { attachInput } from './input.js';
import { buildMenu, buildBattleHUD, updateHUD, buildReference, showCoach } from './ui.js';

const MINIMAP_PX = 140;

const dom = {
  screenMenu: document.getElementById('screen-menu'),
  screenBattle: document.getElementById('screen-battle'),
  screenReference: document.getElementById('screen-reference'),
  map: document.getElementById('map'),
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
  mapCtx: null,
  miniCtx: null,
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
  if (!game.mapCtx) return;
  const mw = dom.map.clientWidth || window.innerWidth;
  const mh = dom.map.clientHeight || window.innerHeight;
  fitCanvas(dom.map, game.mapCtx, mw, mh);
  const miniW = dom.minimap.clientWidth || MINIMAP_PX;
  const miniH = dom.minimap.clientHeight || MINIMAP_PX;
  fitCanvas(dom.minimap, game.miniCtx, miniW, miniH);
}

// --- Screen switching ---
function showMenu() {
  if (game.rafId) cancelAnimationFrame(game.rafId);
  game.rafId = 0;
  if (game.detachInput) { game.detachInput(); game.detachInput = null; }
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

  dom.screenMenu.classList.add('hidden');
  dom.screenBattle.classList.remove('hidden');

  game.mapCtx = dom.map.getContext('2d');
  game.miniCtx = dom.minimap.getContext('2d');
  resizeCanvases();
  fitCameraToWorld(world.camera, { width: dom.map.clientWidth, height: dom.map.clientHeight });

  buildBattleHUD(dom.controlbar, world, {
    onControlChange: () => updateHUD(world),
    onMenu: () => showMenu(),
    onMusic: (on) => setMusic(on),
  });

  const handlers = makeInputHandlers(world);
  world.__handlers = handlers;
  game.detachInput = attachInput(dom.map, world, handlers);

  game.world = world;
  if (!game.rafId) loop();
}

function startCustom(opts) {
  const world = makeCustomWorld(opts || {});
  world.__selected = [];
  dom.screenMenu.classList.add('hidden');
  dom.screenBattle.classList.remove('hidden');
  game.mapCtx = dom.map.getContext('2d');
  game.miniCtx = dom.minimap.getContext('2d');
  resizeCanvases();
  fitCameraToWorld(world.camera, { width: dom.map.clientWidth, height: dom.map.clientHeight });
  buildBattleHUD(dom.controlbar, world, {
    onControlChange: () => updateHUD(world),
    onMenu: () => showMenu(),
    onMusic: (on) => setMusic(on),
  });
  const handlers = makeInputHandlers(world);
  world.__handlers = handlers;
  game.detachInput = attachInput(dom.map, world, handlers);
  game.world = world;
  if (!game.rafId) loop();
}

function startTutorial() {
  startGame(0);
  // Coach marks appear once the battle is on screen.
  setTimeout(() => showCoach(dom.map), 500);
}

// --- Real-time loop (separate from drawing; no state mutation inside draw) ---
function loop() {
  game.rafId = requestAnimationFrame(loop);
  const world = game.world;
  if (!world) return;

  resizeCanvases();
  world.advanceRealtime();

  const msize = { width: dom.map.clientWidth || window.innerWidth, height: dom.map.clientHeight || window.innerHeight };
  drawBattle(game.mapCtx, world, msize);
  const minisize = { width: dom.minimap.clientWidth || MINIMAP_PX, height: dom.minimap.clientHeight || MINIMAP_PX };
  drawMinimap(game.miniCtx, world, minisize);
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
// Debug hook for automated verification (harmless in production).
window.__fc = game;
window.__fc.makeAircraftOrder = makeAircraftOrder;
window.__fc.RENDER_OPTIONS = RENDER_OPTIONS;
