// main.js — integration glue + real-time render loop.
// Wires engine <-> render <-> input <-> ui. Runs in the browser as an ES module.

import { makeWorld, makeCustomWorld, fitCameraToWorld, makeAircraftOrder, SCENARIOS } from './engine.js';
import { buildLandPolygons } from './geo.js';
import { drawBattle, drawMinimap, RENDER_OPTIONS } from './render.js';
import { attachInput, attachInput2DPanel } from './input.js';
import { Scene3D } from './render3d.js';
import { attachInput3D } from './input3d.js';
import { buildMenu, buildBattleHUD, updateHUD, buildReference, showCoach, unlockCampaign, registerMissionEndHandler, refreshMissionList, refreshCampaignTree } from './ui.js';
import { AICommander } from './aiCommander.js';
import { loadMissions } from './missions.js';
import { readTokenFromURL, getTheaterData } from './satellite.js';
import { OLLAMA_DEFAULT_BASE, OLLAMA_DEFAULT_MODEL } from './ollama.js';

// System settings are persisted across sessions. The Ollama endpoint and model
// are global; RED/BLUE LLM toggles default to off so a fresh launch never
// surprises the player with autonomous units.
function readSetting(key, fallback) {
  try { const v = window.localStorage.getItem(`fc99.${key}`); return v != null ? v : fallback; }
  catch { return fallback; }
}
function writeSetting(key, value) {
  try { window.localStorage.setItem(`fc99.${key}`, value); } catch { /* ignore */ }
}

let ollamaBase = readSetting('ollamaBase', OLLAMA_DEFAULT_BASE);
let selectedModel = readSetting('ollamaModel', OLLAMA_DEFAULT_MODEL);
let desiredRedMode = readSetting('redAIMode', 'builtin');
let desiredBlueMode = readSetting('blueAIMode', 'off');

// Local-LLM (Ollama) commanders. Created once and reused across battles. RED is
// the enemy commander; BLUE is the player-side commander (it directly controls
// the BLUE fleet). Both are OFF by default. LLM internal streams are never
// dumped to the browser console; they are only shown in-game when ?llmdebug=1
// (or legacy ?debugAI=1) is set.
const aiCommander = new AICommander({ side: 'enemy', base: ollamaBase, model: selectedModel });
const blueCommander = new AICommander({ side: 'player', intervalMs: 10000, base: ollamaBase, model: selectedModel });

// LLM debug visibility: hidden by default so RED/BLUE reasoning stays off-screen
// and the console stays clean. Enable with ?llmdebug=1 or legacy ?debugAI=1,
// or set window.__fc.llmDebug = true in the console.
function detectLLMDebug() {
  try {
    const params = new URLSearchParams(window.location.search);
    return params.get('llmdebug') === '1' || params.get('llmdebug') === 'true' ||
           params.get('debugAI') === '1' || params.get('debugAI') === 'true';
  } catch { return false; }
}
let LLM_DEBUG = detectLLMDebug();
aiCommander.debug = LLM_DEBUG;
blueCommander.debug = LLM_DEBUG;

// ---------------------------------------------------------------------------
// System settings — Ollama auto-detection + model selection
// ---------------------------------------------------------------------------

// Probe an Ollama base URL and return the sorted model-name list, or null.
async function probeOllama(base) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3500);
  try {
    const res = await fetch(`${base}/api/tags`, {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name).sort();
    return models.length ? models : null;
  } catch (err) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let lastDetectedModels = [];

function populateOllamaModelSelect(models) {
  lastDetectedModels = models || [];
  const select = document.getElementById('sys-ollama-model');
  if (!select) return;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.textContent = '— select model —';
  placeholder.value = '';
  select.appendChild(placeholder);
  for (const name of lastDetectedModels) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    select.appendChild(opt);
  }
  // Restore the persisted/selected model if it is available; otherwise keep
  // the placeholder selected so the user must make an explicit choice.
  if (selectedModel && lastDetectedModels.includes(selectedModel)) {
    select.value = selectedModel;
  } else {
    select.value = '';
  }
  select.disabled = !lastDetectedModels.length;
}

function setOllamaStatus(text, ok, err) {
  const el = document.getElementById('sys-ollama-status');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('ok', 'err');
  if (ok) el.classList.add('ok');
  if (err) el.classList.add('err');
}

async function detectOllama() {
  setOllamaStatus('Detecting local Ollama…');
  const models = await probeOllama(ollamaBase);
  if (models) {
    populateOllamaModelSelect(models);
    setOllamaStatus(`Connected — ${models.length} model${models.length === 1 ? '' : 's'}`, true, false);
    // If no model is selected yet, pick the default/first available one.
    if (!selectedModel || !models.includes(selectedModel)) {
      const preferred = models.includes(OLLAMA_DEFAULT_MODEL) ? OLLAMA_DEFAULT_MODEL : models[0];
      selectOllamaModel(preferred);
    }
    return;
  }
  populateOllamaModelSelect([]);
  setOllamaStatus(`Not reachable at ${ollamaBase}`, false, true);
}

function selectOllamaModel(name) {
  if (!name) return;
  selectedModel = name;
  writeSetting('ollamaModel', name);
  aiCommander.model = name;
  blueCommander.model = name;
  const select = document.getElementById('sys-ollama-model');
  if (select && select.value !== name) select.value = name;
}

function applyOllamaBase(base) {
  base = (base || '').trim();
  if (!base) return;
  // Allow "localhost:11434" shorthand.
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  ollamaBase = base;
  writeSetting('ollamaBase', base);
  aiCommander.base = base;
  blueCommander.base = base;
  const input = document.getElementById('sys-ollama-url');
  if (input && input.value !== base) input.value = base;
}

// Optional Mapbox satellite basemap + real elevation. The token is read from
// ?mapbox=PK... in the URL (never hard-coded, so it never leaks into the public
// repo). Without a token the game uses the offline procedural terrain + DEM.
let MAPBOX_TOKEN = readTokenFromURL();
// Resolved { satellite, elevation } so a view-mode switch can re-apply the
// imagery to a freshly created 3D scene.
let _theaterData = null;
function applyTheaterToScene(scene) {
  if (_theaterData && scene) scene.setSatellite(_theaterData.satellite, _theaterData.elevation);
}


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
    // Scramble every parked airframe of a given type from a platform at once.
    onLaunchAircraftAll: (platformId, type, mission) => {
      const platform = world.ship(platformId);
      if (!platform || !platform.aircraft) return;
      const ids = platform.aircraft.filter((a) => a.type === type).map((a) => a.id);
      const launched = [];
      for (const id of ids) {
        const ac = world.launchAircraft(platformId, id, mission, null);
        if (ac) launched.push(ac.id);
      }
      if (launched.length) {
        world.__selectedAircraft = launched;
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
  world.__scenarioIndex = index;
  world.__endHandled = false;
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
    onStartMission: (i) => startGame(i),
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

  // Real satellite basemap + real elevation. satellite.js is LOCAL-FIRST: it
  // loads pre-cached tiles from assets/tiles/<key>/ with no network needed, and
  // only falls back to the live Mapbox API (requires ?mapbox= token) when no
  // cached data exists. Fetched async so it never blocks the battle start; when
  // it arrives it is pushed into the 3D scene (if in 3D) and exposed for the
  // 2D renderer.
  getTheaterData(world.geo).then((data) => {
    if (!data) return;
    _theaterData = data;
    window.__fc.satelliteCanvas = data.satellite;
    if (game.scene3d) applyTheaterToScene(game.scene3d);
  }).catch(() => {});

  // Apply the AI modes chosen in System Settings. Defaults keep RED on
  // built-in doctrine and BLUE under human control so a fresh launch never
  // surprises the player.
  world.aiMode = desiredRedMode === 'llm' ? 'llm' : 'builtin';
  aiCommander.setEnabled(world.aiMode === 'llm');
  aiCommander.lastError = null;
  world.blueMode = desiredBlueMode === 'llm' ? 'llm' : 'off';
  blueCommander.setEnabled(world.blueMode === 'llm');
  blueCommander.lastError = null;
  // Kick off an immediate first decision when either commander is LLM-enabled.
  if (world.aiMode === 'llm') aiCommander.tick(world, { force: true }).catch(() => {});
  if (world.blueMode === 'llm') blueCommander.tick(world, { force: true }).catch(() => {});
  // Reset any HQ directive + chat from a previous battle.
  blueCommander.humanDirective = null;
  if (hqChat) {
    hqChat.clear();
    hqChat.setDirective(null);
    hqChat.add('system', 'BLUE CIC 在线。用自然语言下达指令，或点击上方快捷指令。');
  }
  syncAIModeUI();

  // Auto-request an opening situation assessment + candidate orders when no
  // human directive exists yet. This runs once per battle and does NOT apply
  // any orders — it only presents clickable suggestions to the player.
  if (world && hqChat) {
    blueCommander.requestOpeningAssessment(world).then((result) => {
      if (result && result.report) {
        hqChat.add('assistant', 'BLUE CIC：' + result.report);
        hqChat.setSuggestions(result.options || []);
      }
    }).catch(() => {});
  }

  if (!game.rafId) loop();
}

// Toggle the RED fleet between the built-in doctrine and the local LLM.
function setAIMode(mode) {
  desiredRedMode = mode === 'llm' ? 'llm' : 'builtin';
  writeSetting('redAIMode', desiredRedMode);
  const world = game.world;
  if (world) {
    if (desiredRedMode === 'llm') {
      world.aiMode = 'llm';
      aiCommander.setEnabled(true);
      aiCommander.tick(world, { force: true }).catch(() => {});
    } else {
      world.aiMode = 'builtin';
      aiCommander.setEnabled(false);
    }
  }
  syncAIModeUI();
}

// Toggle the BLUE (player) LLM commander. When 'llm' it DIRECTLY controls the
// player fleet (issues attack/move/hold orders each cycle); when 'off' the human
// player commands BLUE as normal. A BLUE attack order may open the war.
function setBlueAIMode(mode) {
  desiredBlueMode = mode === 'llm' ? 'llm' : 'off';
  writeSetting('blueAIMode', desiredBlueMode);
  const world = game.world;
  if (world) {
    if (desiredBlueMode === 'llm') {
      world.blueMode = 'llm';
      blueCommander.setEnabled(true);
      blueCommander.tick(world, { force: true }).catch(() => {});
    } else {
      world.blueMode = 'off';
      blueCommander.setEnabled(false);
    }
  }
  syncAIModeUI();
}

// Reflect the current RED/BLUE AI mode in the control-bar status readout and in
// the System Settings panel.
function syncAIModeUI() {
  const world = game.world;
  const llm = world ? world.aiMode === 'llm' : desiredRedMode === 'llm';
  const blueLlm = world ? world.blueMode === 'llm' : desiredBlueMode === 'llm';

  // --- RED (enemy) commander UI ---
  const sysRedBtn = document.getElementById('sys-red-ai');
  const status = document.getElementById('ai-status');
  const live = document.getElementById('ai-live');
  if (sysRedBtn) {
    sysRedBtn.textContent = llm ? 'LLM' : 'BUILTIN';
    sysRedBtn.dataset.mode = llm ? 'llm' : 'builtin';
    sysRedBtn.classList.toggle('active', !!llm);
  }
  if (status) {
    status.textContent = aiCommander.statusText();
    status.classList.toggle('ai-llm', !!llm && !aiCommander.lastError);
    status.classList.toggle('ai-error', !!aiCommander.lastError);
    status.title = aiCommander.lastBrief || '';
  }
  if (live) {
    live.classList.add('hidden');
    live.textContent = '';
  }

  // --- BLUE (player commander) UI ---
  const sysBlueBtn = document.getElementById('sys-blue-ai');
  const blueStatus = document.getElementById('blue-ai-status');
  const blueLive = document.getElementById('blue-ai-live');
  if (sysBlueBtn) {
    sysBlueBtn.textContent = blueLlm ? 'LLM' : 'HUMAN';
    sysBlueBtn.dataset.mode = blueLlm ? 'llm' : 'off';
    sysBlueBtn.classList.toggle('active', !!blueLlm);
  }
  if (blueStatus) {
    blueStatus.textContent = blueCommander.statusText();
    blueStatus.classList.toggle('ai-blue', !!blueLlm && !blueCommander.lastError);
    blueStatus.classList.toggle('ai-error', !!blueCommander.lastError);
    blueStatus.title = blueCommander.lastBrief || '';
  }
  if (blueLive) {
    blueLive.classList.add('hidden');
    blueLive.textContent = '';
  }

  // --- Unified LLM debug panel (only when explicitly enabled via URL param) ---
  updateLLMDebugPanel();
}

function formatLLMDebugText(cmd) {
  const phase = cmd.phase || 'idle';
  let out = `[${phase.toUpperCase()}]`;
  if (cmd.lastError) out += `  ERR: ${cmd.lastError}`;
  out += '\n---\n';
  if (cmd.liveText && cmd.liveText !== '') {
    out += cmd.liveText;
  } else if (cmd.lastRaw && cmd.lastRaw !== '') {
    out += cmd.lastRaw;
  } else if (cmd.lastBrief && cmd.lastBrief !== '') {
    out += cmd.lastBrief;
  } else {
    out += '(no output)';
  }
  return out;
}

function updateLLMDebugPanel() {
  const panel = document.getElementById('llm-debug-panel');
  if (!panel) return;
  if (!LLM_DEBUG) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const redText = document.getElementById('llm-debug-red-text');
  const blueText = document.getElementById('llm-debug-blue-text');
  if (redText) redText.textContent = formatLLMDebugText(aiCommander);
  if (blueText) blueText.textContent = formatLLMDebugText(blueCommander);
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
    // Re-apply the real satellite texture if it was already fetched.
    if (_theaterData) applyTheaterToScene(game.scene3d);
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

  // Local-LLM commanders: throttled + async, fire-and-forget. RED runs the
  // enemy; BLUE commands the player fleet. They never block the render loop.
  if (world.aiMode === 'llm') aiCommander.tick(world).catch(() => {});
  if (world.blueMode === 'llm') blueCommander.tick(world).catch(() => {});
  syncAIModeUI();

  const msize = { width: dom.map.clientWidth || window.innerWidth, height: dom.map.clientHeight || window.innerHeight };

  if (game.renderMode === '3d' && game.scene3d) {
    if (game.swapped) {
      // SWAP: the big 2D tactical map (now main) is authoritative — its own
      // input drives world.camera, and the small 3D view in the bottom-centre
      // panel mirrors it. The panel is physically short, so pin the preview to a
      // sensible theater distance (don't let a tiny panel pull the camera to the
      // surface) and use a more top-down default angle so the wide strip stays
      // useful.
      const threeH = dom.map3d.clientHeight || msize.height;
      const fov = (game.scene3d.camera.fov * Math.PI) / 180;
      game.scene3d.target.x = world.camera.center.x;
      game.scene3d.target.z = world.camera.center.y;
      const rawDist = (threeH / 2) / (world.camera.zoom || 1) / Math.tan(fov / 2);
      game.scene3d.distance = Math.max(600, rawDist);
      game.scene3d.elevation = Math.max(game.scene3d.elevation, 0.85);
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

// On a decisive result, record it into the campaign branch tree (victory
// advances the trunk + opens branch leaves) and refresh the tree if it is
// currently on screen.
function handleMissionEnd(world) {
  const victory = world.phase === 'playerWon';
  if (world.missionId) unlockCampaign(world.missionId, victory);
  refreshCampaignTree();
}

// --- Boot ---
buildMenu(null, {
  onStart: (i) => startGame(i),
  onReference: () => showReference(),
  onStartCustom: (opts) => startCustom(opts),
  onTutorial: () => startTutorial(),
  onMusic: (on) => setMusic(on),
  onSystem: () => { detectOllama(); syncAIModeUI(); },
});
registerMissionEndHandler((world) => handleMissionEnd(world));

// Swap the three hand-written scenarios for the full 39-mission library decoded
// from the original .scc/.scs files, then re-render the mission list. The menu
// is already usable before this resolves, so a slow/failed fetch just leaves
// the fallback scenarios in place.
loadMissions()
  .then((data) => {
    console.log(`[missions] loaded ${data.missions.length} original Fleet Command scenarios`);
    refreshMissionList();
  })
  .catch((err) => {
    console.warn('[missions] falling back to built-in scenarios:', err && err.message);
  });

window.addEventListener('resize', resizeCanvases);
const viewBtn = document.getElementById('btn-viewmode');
if (viewBtn) viewBtn.addEventListener('click', () => toggleViewMode());
const swapBtn = document.getElementById('btn-swap');
if (swapBtn) swapBtn.addEventListener('click', () => setSwapped(!game.swapped));

// --- SYSTEM SETTINGS (Ollama + AI toggles) ---------------------------------
const sysUrl = document.getElementById('sys-ollama-url');
const sysDetect = document.getElementById('sys-ollama-detect');
const sysModel = document.getElementById('sys-ollama-model');
const sysRed = document.getElementById('sys-red-ai');
const sysBlue = document.getElementById('sys-blue-ai');
if (sysUrl) {
  sysUrl.value = ollamaBase;
  sysUrl.addEventListener('change', () => { applyOllamaBase(sysUrl.value); detectOllama(); });
}
if (sysDetect) sysDetect.addEventListener('click', () => { applyOllamaBase(sysUrl ? sysUrl.value : ollamaBase); detectOllama(); });
if (sysModel) {
  sysModel.addEventListener('change', () => { if (sysModel.value) selectOllamaModel(sysModel.value); });
}
if (sysRed) {
  sysRed.addEventListener('click', () => {
    setAIMode(sysRed.dataset.mode === 'llm' ? 'builtin' : 'llm');
  });
}
if (sysBlue) {
  sysBlue.addEventListener('click', () => {
    setBlueAIMode(sysBlue.dataset.mode === 'llm' ? 'off' : 'llm');
  });
}

// --- LLM DEBUG PANEL --------------------------------------------------------
const llmDebugPanel = document.getElementById('llm-debug-panel');
const llmDebugHead = document.getElementById('llm-debug-head');
const llmDebugClose = document.getElementById('llm-debug-close');
function toggleLLMDebugPanel() { if (llmDebugPanel) llmDebugPanel.classList.toggle('collapsed'); }
if (llmDebugHead) llmDebugHead.addEventListener('click', toggleLLMDebugPanel);
if (llmDebugClose) llmDebugClose.addEventListener('click', (e) => { e.stopPropagation(); toggleLLMDebugPanel(); });

// --- HQ COMMAND CHAT -------------------------------------------------------
// The human issues natural-language orders here. Each message becomes the
// supreme HQ directive fed to the BLUE (player) LLM, which translates it into
// concrete fleet orders. Directing the BLUE LLM auto-enables its LLM mode.
const HQ_CLEAR_PATTERNS = [
  /(自由|取消|撤消|撤销|解除|stand[\s_-]?down|standby|free\s*operation|clear\s*directive|自由行动)/i,
];
const hqChat = (() => {
  const root = document.getElementById('hq-chat');
  const log = document.getElementById('hq-chat-log');
  const input = document.getElementById('hq-chat-input');
  const sendBtn = document.getElementById('hq-chat-send');
  const clearBtn = document.getElementById('hq-chat-clear');
  const toggleBtn = document.getElementById('hq-chat-toggle');
  const directiveOut = document.getElementById('hq-directive-readout');
  const chips = Array.from(document.querySelectorAll('.hq-chip'));
  const suggestionsEl = document.getElementById('hq-suggestions');

  const scroll = () => { if (log) log.scrollTop = log.scrollHeight; };
  function add(role, text) {
    if (!log) return null;
    const el = document.createElement('div');
    el.className = 'hq-msg hq-msg-' + role;
    el.textContent = text;
    log.appendChild(el);
    scroll();
    return el;
  }
  function remove(el) { if (el && el.parentNode) el.parentNode.removeChild(el); }
  function setDirective(d) {
    blueCommander.humanDirective = d;
    if (directiveOut) {
      directiveOut.textContent = d ? ('HQ ▸ ' + d) : 'HQ ▸ (无指令 / 自由行动)';
    }
  }
  function ensureVisible() {
    if (root) {
      root.classList.remove('hidden', 'collapsed');
      if (cmdBtn) cmdBtn.classList.add('active');
    }
  }
  function clearSuggestions() {
    if (!suggestionsEl) return;
    suggestionsEl.innerHTML = '';
    suggestionsEl.classList.add('hidden');
  }
  function setSuggestions(options) {
    clearSuggestions();
    if (!suggestionsEl || !Array.isArray(options) || !options.length) return;
    const title = document.createElement('div');
    title.className = 'hq-suggestions-title';
    title.textContent = '建议指令';
    suggestionsEl.appendChild(title);
    const row = document.createElement('div');
    row.className = 'hq-suggestions-row';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'hq-suggestion';
      btn.type = 'button';
      btn.textContent = opt.label || opt.cmd;
      btn.title = opt.cmd;
      btn.addEventListener('click', () => send(opt.cmd));
      row.appendChild(btn);
    });
    suggestionsEl.appendChild(row);
    suggestionsEl.classList.remove('hidden');
  }
  function send(raw) {
    const text = (raw != null ? raw : (input ? input.value : '')).trim();
    if (!text) return;
    add('human', text);
    if (input) input.value = '';
    ensureVisible();
    clearSuggestions();
    const world = game.world;
    if (!world) { add('system', '（尚未进入战斗）'); return; }
    if (HQ_CLEAR_PATTERNS.some((re) => re.test(text))) {
      setDirective(null);
      add('assistant', 'BLUE CIC: 收到，解除指令，恢复自主战术。');
      return;
    }
    setDirective(text);
    // Directing the BLUE LLM requires its LLM mode on; enable it (without the
    // built-in first tick — we drive our own directive-aware tick below).
    if (world.blueMode !== 'llm') {
      world.blueMode = 'llm';
      blueCommander.setEnabled(true);
      syncAIModeUI();
    }
    const placeholder = add('assistant', 'BLUE CIC: 收到指令，正在规划…');
    blueCommander.tick(world, { force: true }).then(() => {
      remove(placeholder);
      if (blueCommander.lastError) {
        add('assistant', 'BLUE CIC: LLM 暂时离线，已记录指令（内置条令接管，恢复后执行）。');
      } else {
        // Display the LLM's Chinese military report; fall back to the brief
        // summary if the model returned no report field.
        const full = blueCommander.lastReport || blueCommander.lastBrief || '已下达。';
        add('assistant', 'BLUE CIC：' + full);
      }
      ensureVisible();
    }).catch(() => {
      remove(placeholder);
      add('assistant', 'BLUE CIC: 指令已记录。');
      ensureVisible();
    });
  }
  if (sendBtn) sendBtn.addEventListener('click', () => send());
  if (input) input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  if (clearBtn) clearBtn.addEventListener('click', () => send('取消指令'));
  if (toggleBtn && root) toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root) root.classList.toggle('collapsed');
  });
  if (root) root.addEventListener('click', (e) => {
    // Click on the header (but not its buttons) collapses the panel.
    if (e.target === root.querySelector('#hq-chat-head')) root.classList.toggle('collapsed');
  });
  chips.forEach((c) => c.addEventListener('click', () => send(c.dataset.cmd || c.textContent)));
  return {
    add,
    send,
    setDirective,
    setSuggestions,
    clear: () => { if (log) log.innerHTML = ''; clearSuggestions(); },
  };
})();

// CMD toggle in the control bar shows/hides the HQ command chat panel.
const cmdBtn = document.getElementById('btn-cmd');
function toggleCmdPanel() {
  const el = document.getElementById('hq-chat');
  if (el) {
    el.classList.toggle('hidden');
    cmdBtn.classList.toggle('active', !el.classList.contains('hidden'));
  }
}
if (cmdBtn) {
  cmdBtn.addEventListener('click', toggleCmdPanel);
  const el = document.getElementById('hq-chat');
  if (el) cmdBtn.classList.toggle('active', !el.classList.contains('hidden'));
}
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
window.__fc.setBlueAIMode = setBlueAIMode;
window.__fc.aiCommander = aiCommander;
window.__fc.blueCommander = blueCommander;
window.__fc.hqChat = hqChat;
window.__fc.sendHQ = (t) => hqChat && hqChat.send(t);
window.__fc.startCustom = startCustom;
window.__fc.buildLandPolygons = buildLandPolygons;
window.__fc.SCENARIOS = SCENARIOS;
// Optional real Mapbox satellite basemap token (from ?mapbox=PK...; never
// hard-coded). Exposed for debugging; window.__fc.satelliteCanvas is set once
// the imagery loads, and window.__fc.applyTheater() re-applies it to a scene.
window.__fc.mapboxToken = MAPBOX_TOKEN;
window.__fc.applyTheater = applyTheaterToScene;
// Toggle in-game LLM debug panel. Use ?llmdebug=1 URL param (legacy ?debugAI=1
// still works), or run in console: window.__fc.llmDebug = true
Object.defineProperty(window.__fc, 'llmDebug', {
  get: () => LLM_DEBUG,
  set: (v) => {
    LLM_DEBUG = !!v;
    aiCommander.debug = LLM_DEBUG;
    blueCommander.debug = LLM_DEBUG;
    syncAIModeUI();
  },
});
// Keep the legacy debugAI alias for existing bookmarks/tests.
Object.defineProperty(window.__fc, 'debugAI', {
  get: () => window.__fc.llmDebug,
  set: (v) => { window.__fc.llmDebug = v; },
});

// Auto-detect the local Ollama daemon on startup and reflect persisted AI
// toggle states in the System Settings panel.
detectOllama();
syncAIModeUI();
