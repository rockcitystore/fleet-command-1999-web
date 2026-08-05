// ui.js — menu / scenario select / HUD DOM (imports engine.js)
// CONTRACT section 4. No game state mutation except via world methods + handlers.

import { SCENARIOS, SHIP_STATS } from './engine.js';
import { RENDER_OPTIONS } from './render.js';

const SPEED_BUTTONS = {
  1: 'btn-1x',
  2: 'btn-2x',
  4: 'btn-4x',
};

function el(id) {
  return document.getElementById(id);
}

/* ---------- Menu ---------- */
const PLACEHOLDERS = {
  campaign: {
    title: 'CAMPAIGN',
    body: 'Full campaign mode is not included in this prototype. ' +
      'Launch a Single Mission to engage the pre-loaded order of battle.',
  },
  tutorials: {
    title: 'TUTORIALS',
    body: 'Interactive tutorials are planned for a later build. ' +
      'For now, open a Single Mission and click any unit on the tactical ' +
      'map to inspect its weapons and sensors.',
  },
  editor: {
    title: 'MISSION EDITOR',
    body: 'Scenario authoring is not available in this build. ' +
      'The original 25 Fleet Command scenarios are pre-loaded and selectable ' +
      'under SINGLE MISSIONS.',
  },
  options: {
    title: 'OPTIONS',
    body: 'Music and time-compression controls are available in-mission ' +
      '(bottom control bar). This prototype focuses on authentic tactical ' +
      'gameplay and the Jane’s Reference Library.',
  },
};

export function buildMenu(rootEl, { onStart, onReference, onStartCustom, onTutorial, onMusic }) {
  const list = el('scenario-list');
  list.innerHTML = '';

  SCENARIOS.forEach((scenario, index) => {
    const card = document.createElement('div');
    card.className = 'scenario-card';
    card.tabIndex = 0;
    card.setAttribute('role', 'button');

    const name = document.createElement('div');
    name.className = 'sc-name';
    name.textContent = scenario.name;

    const brief = document.createElement('div');
    brief.className = 'sc-brief';
    brief.textContent = scenario.brief;

    card.appendChild(name);
    card.appendChild(brief);

    const activate = () => onStart(index);
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });

    list.appendChild(card);
  });

  // --- Navigation between menu sections ---
  const subWelcome = el('sub-welcome');
  const subSingle = el('sub-single');
  const subPlaceholder = el('sub-placeholder');
  const subTutorials = el('sub-tutorials');
  const subEditor = el('sub-editor');
  const subOptions = el('sub-options');
  const placeholderTitle = el('placeholder-title');
  const placeholderBody = el('placeholder-body');
  const menuButtons = Array.from(document.querySelectorAll('#main-menu .menu-btn'));

  function showOnly(active) {
    [subWelcome, subSingle, subPlaceholder, subTutorials, subEditor, subOptions].forEach((p) => p.classList.add('hidden'));
    if (active) active.classList.remove('hidden');
  }

  function setActiveMenu(act) {
    menuButtons.forEach((b) => b.classList.toggle('active', b.dataset.act === act));
  }

  menuButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const act = btn.dataset.act;
      setActiveMenu(act);
      if (act === 'single' || act === 'campaign') {
        // CAMPAIGN reuses the single-mission order of battle as a track.
        showOnly(subSingle);
      } else if (act === 'reference') {
        showOnly(subWelcome);
        if (onReference) onReference();
      } else if (act === 'tutorials') {
        showOnly(subTutorials);
      } else if (act === 'editor') {
        showOnly(subEditor);
      } else if (act === 'options') {
        showOnly(subOptions);
        syncOptionsUI();
      } else if (PLACEHOLDERS[act]) {
        placeholderTitle.textContent = PLACEHOLDERS[act].title;
        placeholderBody.textContent = PLACEHOLDERS[act].body;
        showOnly(subPlaceholder);
      } else {
        showOnly(subWelcome);
      }
    });
  });

  // --- TUTORIALS launcher ---
  const launchTut = el('btn-launch-tutorial');
  if (launchTut) {
    launchTut.addEventListener('click', () => { if (onTutorial) onTutorial(); });
  }

  // --- MISSION EDITOR form ---
  const edPlayer = el('ed-player');
  const edEnemy = el('ed-enemy');
  const edPlayerOut = el('ed-player-out');
  const edEnemyOut = el('ed-enemy-out');
  const edTheater = el('ed-theater');
  if (edPlayer && edPlayerOut) edPlayer.addEventListener('input', () => { edPlayerOut.textContent = edPlayer.value; });
  if (edEnemy && edEnemyOut) edEnemy.addEventListener('input', () => { edEnemyOut.textContent = edEnemy.value; });
  const launchEditor = el('btn-launch-editor');
  if (launchEditor) {
    launchEditor.addEventListener('click', () => {
      if (onStartCustom) onStartCustom({
        playerCount: edPlayer ? Number(edPlayer.value) : 3,
        enemyCount: edEnemy ? Number(edEnemy.value) : 2,
        theater: edTheater ? edTheater.value : 'norwegian',
      });
    });
  }

  // --- OPTIONS toggles ---
  const optGrid = el('opt-grid');
  const optSymbol = el('opt-symbol');
  const optMusic = el('opt-music');
  if (optGrid) optGrid.addEventListener('click', () => {
    RENDER_OPTIONS.grid = !RENDER_OPTIONS.grid;
    syncOptionsUI();
  });
  if (optSymbol) optSymbol.addEventListener('click', () => {
    RENDER_OPTIONS.symbolStyle = RENDER_OPTIONS.symbolStyle === 'ntds' ? 'simple' : 'ntds';
    syncOptionsUI();
  });
  if (optMusic) optMusic.addEventListener('click', () => {
    const on = optMusic.dataset.on !== '1';
    optMusic.dataset.on = on ? '1' : '0';
    optMusic.textContent = on ? 'ON' : 'OFF';
    if (onMusic) onMusic(on);
  });

  function syncOptionsUI() {
    if (optGrid) { optGrid.dataset.on = RENDER_OPTIONS.grid ? '1' : '0'; optGrid.textContent = RENDER_OPTIONS.grid ? 'ON' : 'OFF'; }
    if (optSymbol) { optSymbol.dataset.on = RENDER_OPTIONS.symbolStyle; optSymbol.textContent = RENDER_OPTIONS.symbolStyle === 'ntds' ? 'NTDS' : 'SIMPLE'; }
  }

  // Default view
  setActiveMenu(null);
  showOnly(subWelcome);
}

/* ---------- Battle HUD ---------- */
export function buildBattleHUD(rootEl, world, handlers) {
  const onControlChange = handlers.onControlChange || (() => {});

  // Pause / Resume
  el('btn-pause').addEventListener('click', () => {
    world.togglePause();
    onControlChange();
    updateHUD(world);
  });

  // Speed
  [1, 2, 4].forEach((n) => {
    el(SPEED_BUTTONS[n]).addEventListener('click', () => {
      world.setSpeed(n);
      onControlChange();
      updateHUD(world);
    });
  });

  // Zoom
  el('btn-zoomout').addEventListener('click', () => {
    world.zoomBy(0.8);
    onControlChange();
    updateHUD(world);
  });
  el('btn-zoomin').addEventListener('click', () => {
    world.zoomBy(1.25);
    onControlChange();
    updateHUD(world);
  });

  // Reset view
  el('btn-reset').addEventListener('click', () => {
    const map = document.getElementById('map');
    world.resetCamera({ width: map.clientWidth, height: map.clientHeight });
    onControlChange();
    updateHUD(world);
  });

  // Aircraft actions (RECOVER / DRAW ROUTE), driven by world.__selectedAircraft.
  const recoverBtn = el('btn-ac-recover');
  if (recoverBtn) {
    recoverBtn.addEventListener('click', () => {
      const id = (world.__selectedAircraft || [])[0];
      if (id != null && world.__handlers) world.__handlers.onRecoverAircraft(id);
    });
  }
  const routeBtn = el('btn-ac-route');
  if (routeBtn) {
    routeBtn.addEventListener('click', () => {
      const id = (world.__selectedAircraft || [])[0];
      if (id == null || !world.__handlers) return;
      const drawing = world.__routeDraw === id;
      world.__handlers.onSetRouteDraw(id, !drawing);
    });
  }

  // Music toggle (real .wav tracks from the original game)
  const musicBtn = el('btn-music');
  if (musicBtn) {
    musicBtn.addEventListener('click', () => {
      const on = !musicBtn.classList.contains('active');
      musicBtn.classList.toggle('active', on);
      if (handlers.onMusic) handlers.onMusic(on);
    });
  }

  // End screen MENU button
  const menuBtn = el('btn-menu');
  if (menuBtn) {
    menuBtn.addEventListener('click', () => {
      if (handlers.onMenu) handlers.onMenu();
    });
  }

  // Control-bar MENU (exit to main menu at any time)
  const menuExit = el('btn-menu-exit');
  if (menuExit) {
    menuExit.addEventListener('click', () => {
      if (handlers.onMenu) handlers.onMenu();
    });
  }

  // Initial paint
  updateHUD(world);
}

function degrees(rad) {
  let d = (rad * 180 / Math.PI) % 360;
  if (d < 0) d += 360;
  return Math.round(d);
}

function fmtOrder(s) {
  if (!s || !s.order) return 'STATION KEEPING';
  const o = s.order;
  if (o.kind === 'moveTo') {
    const n = o.waypoints ? o.waypoints.length : 1;
    if (n > 1) return o.loop ? `PATROL ROUTE (${n})` : `WAYPOINT ROUTE (${n})`;
    return 'MOVE TO GRID';
  }
  if (o.kind === 'attack') return `ENGAGE TRACK ${String(o.targetId || s.targetId || 0).padStart(4, '0')}`;
  if (o.kind === 'setDepth') return 'CHANGE DEPTH';
  return o.kind.toUpperCase();
}

function fmtWeapons(s) {
  if (!s.weapons || !s.weapons.length) return 'NONE';
  return s.weapons.map((w) => {
    const name = w.realName ? w.realName.replace(/ Torpedo| Rocket| Shell| Charge/, '') : w.type.toUpperCase();
    const count = typeof w.count === 'number' ? ` - ${w.count}` : '';
    return `${name}${count}`;
  }).join('\n');
}

function updateInfoPanel(world) {
  const selected = world.__selected || [];

  // Projectile identification (click a missile/torpedo trail to see its model).
  if (world.__selectedProjectile != null) {
    const p = world.projectiles.find((x) => x.id === world.__selectedProjectile);
    if (p) {
      el('info-name').textContent = (p.realName || p.type.toUpperCase());
      el('info-class').textContent = `${p.type.toUpperCase()} / IN FLIGHT`;
      el('info-track').textContent = String(p.id).padStart(4, '0');
      el('info-course').textContent = `${Math.round(p.speed)} KTS`;
      el('info-speed').textContent = `${p.range} RNG`;
      el('info-damage').textContent = `${Math.round(p.damage)}`;
      const target = world.ship(p.targetId);
      el('info-orders').textContent = target
        ? `TRACKING T-${String(p.targetId).padStart(4, '0')}`
        : 'TARGET LOST';
      const source = world.ship(p.sourceId);
      el('info-weapons').textContent = source
        ? `FIRED BY ${source.name || 'TRACK ' + String(source.id).padStart(4, '0')}`
        : 'UNKNOWN SOURCE';
      return;
    }
    // Projectile no longer exists; clear the selection.
    world.__selectedProjectile = null;
  }

  // Selected airborne aircraft (overrides the ship readout while present).
  const acList = world.__selectedAircraft || [];
  if (acList.length) {
    const ac = world.aircraft.find((a) => a.id === acList[0] && a.alive);
    if (ac) {
      const fuelPct = Math.round((ac.fuel / ac.maxFuel) * 100);
      el('info-name').textContent = ac.display || ac.type;
      el('info-class').textContent = `${ac.category.toUpperCase()} / TRK ${String(ac.id).padStart(4, '0')}`;
      el('info-track').textContent = String(ac.id).padStart(4, '0');
      el('info-course').textContent = `${degrees(ac.heading)}°`;
      el('info-speed').textContent = `${Math.round(ac.speed)} KTS`;
      el('info-damage').textContent = ac.state.toUpperCase();
      el('info-orders').textContent = ac.mission
        ? `${ac.mission}${ac.order && ac.order.loop ? ' (LOOP)' : ''}`
        : 'AIRBORNE';
      const wpN = ac.order && ac.order.waypoints ? ac.order.waypoints.length : 0;
      const wpI = ac.order && ac.order.wpIndex != null ? ac.order.wpIndex + 1 : 0;
      const ord = ac.weapon ? `  ORD ${ac.ordnance}/${ac.ordnanceMax}` : '';
      el('info-weapons').textContent = `FUEL ${fuelPct}%  ALT ${Math.round(ac.alt)}  WP ${wpI}/${wpN}${ord}`;
      const act = el('info-ac-actions');
      if (act) act.classList.remove('hidden');
      const rBtn = el('btn-ac-route');
      if (rBtn) rBtn.textContent = world.__routeDraw === ac.id ? 'FINISH ROUTE' : 'DRAW ROUTE';
      const recBtn = el('btn-ac-recover');
      if (recBtn) recBtn.classList.toggle('disabled', ac.state === 'rtb');
      return;
    }
    // selected aircraft no longer alive — drop the stale selection
    world.__selectedAircraft = [];
  }
  const actHide = el('info-ac-actions');
  if (actHide) actHide.classList.add('hidden');

  const s = selected.length > 0 ? world.ships.find((x) => x.id === selected[0]) : null;

  if (!s || !s.alive) {
    el('info-name').textContent = 'NO UNIT SELECTED';
    el('info-class').textContent = '—';
    el('info-track').textContent = '—';
    el('info-course').textContent = '—';
    el('info-speed').textContent = '—';
    el('info-damage').textContent = '—';
    el('info-orders').textContent = '—';
    el('info-weapons').textContent = '—';
    return;
  }

  const stats = SHIP_STATS[s.shipClass] || { label: 'UNK' };
  const damage = s.maxHp > 0 ? Math.round((1 - s.hp / s.maxHp) * 100) : 0;
  el('info-name').textContent = s.name || 'UNKNOWN';
  el('info-class').textContent = `${stats.label} / ${s.shipClass.toUpperCase()}`;
  el('info-track').textContent = String(s.id).padStart(4, '0');
  el('info-course').textContent = `${degrees(s.heading)}°`;
  el('info-speed').textContent = `${Math.round(s.speed)} KTS`;
  el('info-damage').textContent = `${damage}`;
  el('info-orders').textContent = fmtOrder(s);
  el('info-weapons').textContent = fmtWeapons(s);
}

/* ---------- Per-frame HUD update ---------- */
export function updateHUD(world) {
  const playerAlive = world.aliveShips('player').length;
  const enemyAlive = world.aliveShips('enemy').length;

  el('hud-player').textContent = String(playerAlive);
  el('hud-enemy').textContent = String(enemyAlive);

  const totalSec = Math.floor(world.time);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, '0');
  const ss = String(totalSec % 60).padStart(2, '0');
  el('hud-time').textContent = `T+${mm}:${ss}`;

  // Info-panel clock starts at 12:00 local scenario time.
  const clockSec = (43200 + totalSec) % 86400;
  const ch = String(Math.floor(clockSec / 3600)).padStart(2, '0');
  const cmin = String(Math.floor((clockSec % 3600) / 60)).padStart(2, '0');
  const infoTime = el('info-time');
  if (infoTime) infoTime.textContent = `${ch}:${cmin}`;
  const infoScale = el('info-scale');
  if (infoScale) infoScale.textContent = '50 NMI';

  el('hud-status').textContent = world.paused ? 'PAUSED' : `${world.speed}x`;
  el('hud-scenario').textContent = world.scenarioName || '—';

  // Pause label
  el('btn-pause').textContent = world.paused ? 'RESUME' : 'PAUSE';

  // Speed button active state
  Object.entries(SPEED_BUTTONS).forEach(([n, id]) => {
    el(id).classList.toggle('active', !world.paused && world.speed === Number(n));
  });
  // Pause also visually active when paused
  el('btn-pause').classList.toggle('active', world.paused);

  updateInfoPanel(world);

  // End screen
  const end = el('endscreen');
  const resultEl = el('end-result');
  if (world.phase && world.phase !== 'playing') {
    const victory = world.phase === 'playerWon';
    resultEl.textContent = victory ? 'VICTORY' : 'DEFEAT';
    resultEl.className = 'end-result ' + (victory ? 'victory' : 'defeat');
    el('end-detail').textContent = victory
      ? 'ALL HOSTILE FORCES NEUTRALIZED'
      : 'ALLIED TASK FORCE ELIMINATED';
    end.classList.remove('hidden');
  } else {
    end.classList.add('hidden');
  }
}

/* ============ Jane's Reference Library ============ */
const REF_CATS = [
  { key: 'aircraft', label: 'AIRCRAFT', src: 'platforms', kind: 'aircraft' },
  { key: 'submarine', label: 'SUBMARINES', src: 'platforms', kind: 'submarine' },
  { key: 'surface', label: 'SURFACE', src: 'platforms', kind: 'surface' },
  { key: 'weapons', label: 'WEAPONS', src: 'weapons' },
  { key: 'sensors', label: 'SENSORS', src: 'sensors' },
];
const REF_COUNTRY_ORDER = ['USA', 'Russia/USSR', 'UK', 'France', 'China', 'Germany', 'Japan', 'India', 'Australia', 'Other'];

function fmtRange(m) {
  if (!m || m <= 0) return '—';
  if (m >= 1852) return `${(m / 1852).toFixed(m >= 18520 ? 0 : 1)} nmi`;
  return `${(m / 1000).toFixed(1)} km`;
}

function fmtSpeed(v) {
  if (!v || v <= 0) return '—';
  if (v > 1500) { // raw internal unit -> rough knots estimate
    const kts = v / 12910;
    if (kts > 40 && kts < 2500) return `≈${Math.round(kts)} kts (est.)`;
    return '—';
  }
  return `${Math.round(v)} kts`;
}

function fmtDepth(d) {
  if (d === undefined || d === null) return '—';
  if (d < 0) return `${Math.round(-d)} m`;
  return '0 m (surface)';
}

function prettyBehavior(b) {
  if (!b) return '—';
  return b.replace(/([a-z])([A-Z])/g, '$1 $2').toUpperCase();
}

export function buildReference(referenceData, { onBack }) {
  const data = referenceData || { platforms: [], weapons: [], sensors: [] };
  const state = { cat: 'aircraft', country: 'ALL' };

  const catEl = el('ref-cat');
  const countryEl = el('ref-country');
  const gridEl = el('ref-grid');
  const footEl = el('ref-foot');
  const backBtn = el('btn-ref-back');

  const countries = ['ALL'].concat(
    REF_COUNTRY_ORDER.filter((c) => (data.platforms || []).some((p) => p.country === c))
  );

  function itemsFor() {
    const cat = REF_CATS.find((c) => c.key === state.cat);
    let items;
    if (cat.src === 'platforms') {
      items = (data.platforms || []).filter((p) => p.kind === cat.kind);
      if (state.country !== 'ALL') items = items.filter((p) => p.country === state.country);
    } else if (cat.src === 'weapons') {
      items = data.weapons || [];
    } else {
      items = data.sensors || [];
    }
    return items;
  }

  function cardFor(item, catKey) {
    const card = document.createElement('div');
    card.className = 'ref-card';

    const name = document.createElement('div');
    name.className = 'rc-name';
    name.textContent = item.name || 'UNKNOWN';

    const sub = document.createElement('div');
    sub.className = 'rc-sub';

    const rows = document.createElement('div');

    const addRow = (k, v) => {
      const row = document.createElement('div');
      row.className = 'rc-row';
      const key = document.createElement('span');
      key.className = 'rc-key';
      key.textContent = k;
      const val = document.createElement('span');
      val.textContent = v;
      row.appendChild(key);
      row.appendChild(val);
      rows.appendChild(row);
    };

    if (catKey === 'weapons') {
      sub.textContent = (item.type || 'WEAPON').toUpperCase();
      addRow('RANGE', fmtRange(item.range_m));
      addRow('SPEED', fmtSpeed(item.speed));
      addRow('DEPTH', fmtDepth(item.depth));
    } else if (catKey === 'sensors') {
      sub.textContent = 'SENSOR';
      addRow('R88 DET', fmtRange(item.r88));
      addRow('R92 DET', fmtRange(item.r92));
    } else {
      sub.textContent = `${(item.kind || 'PLATFORM').toUpperCase()} · ${item.country || '?'}`;
      addRow('RANGE', fmtRange(item.range_m));
      addRow('SPEED', fmtSpeed(item.speed));
      addRow('DEPTH', fmtDepth(item.depth));
      addRow('ROLE', prettyBehavior(item.behavior));
    }

    card.appendChild(name);
    card.appendChild(sub);
    card.appendChild(rows);
    return card;
  }

  function renderGrid() {
    const items = itemsFor();
    gridEl.innerHTML = '';
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'rc-sub';
      empty.textContent = 'NO ENTRIES FOR THIS FILTER.';
      gridEl.appendChild(empty);
    } else {
      const frag = document.createDocumentFragment();
      items.forEach((it) => frag.appendChild(cardFor(it, state.cat)));
      gridEl.appendChild(frag);
    }
    const cat = REF_CATS.find((c) => c.key === state.cat);
    footEl.textContent = `${cat.label}: ${items.length} ENTRIE${items.length === 1 ? '' : 'S'}` +
      (state.country !== 'ALL' ? ` · ${state.country}` : '');
  }

  function renderTabs() {
    catEl.innerHTML = '';
    REF_CATS.forEach((c) => {
      const b = document.createElement('button');
      b.className = 'ref-tab' + (c.key === state.cat ? ' active' : '');
      b.type = 'button';
      b.textContent = c.label;
      b.addEventListener('click', () => {
        state.cat = c.key;
        if (c.src !== 'platforms') state.country = 'ALL';
        renderTabs();
        renderCountries();
        renderGrid();
      });
      catEl.appendChild(b);
    });
  }

  function renderCountries() {
    const cat = REF_CATS.find((c) => c.key === state.cat);
    const isPlatform = cat.src === 'platforms';
    countryEl.innerHTML = '';
    countries.forEach((c) => {
      const b = document.createElement('button');
      const disabled = !isPlatform && c !== 'ALL';
      b.className = 'ref-ctry' + (c === state.country ? ' active' : '') + (disabled ? ' disabled' : '');
      b.type = 'button';
      b.textContent = c === 'ALL' ? 'ALL COUNTRIES' : c;
      if (!disabled) {
        b.addEventListener('click', () => {
          state.country = c;
          renderCountries();
          renderGrid();
        });
      }
      countryEl.appendChild(b);
    });
  }

  if (backBtn) backBtn.addEventListener('click', () => { if (onBack) onBack(); });

  renderTabs();
  renderCountries();
  renderGrid();
}

/* ---------- Tutorial coach marks ---------- */
const COACH_STEPS = [
  'DRAG on the map to PAN. Hold Shift and drag on empty sea to BOX-SELECT your units.',
  'SCROLL the wheel to ZOOM in and out.',
  'CLICK a unit to inspect its weapons and sensors in the panel below.',
  'CLICK empty sea to ORDER a move; CLICK a detected hostile to ATTACK. You can also RIGHT-CLICK for the command menu. Good hunting.',
];

export function showCoach(mapEl) {
  const coach = el('coach');
  const stepEl = el('coach-step');
  const textEl = el('coach-text');
  const nextBtn = el('coach-next');
  const skipBtn = el('coach-skip');
  if (!coach || !textEl) return;

  let idx = 0;
  let dismissed = false;

  function renderStep() {
    stepEl.textContent = (idx + 1) + ' / ' + COACH_STEPS.length;
    textEl.textContent = COACH_STEPS[idx];
    nextBtn.textContent = idx === COACH_STEPS.length - 1 ? 'DONE ✓' : 'NEXT ›';
  }
  function hide() {
    if (dismissed) return;
    dismissed = true;
    coach.classList.add('hidden');
    if (mapEl) mapEl.removeEventListener('pointerdown', onMap, true);
    nextBtn.removeEventListener('click', onNext);
    skipBtn.removeEventListener('click', hide);
  }
  function onNext() {
    if (idx < COACH_STEPS.length - 1) { idx++; renderStep(); }
    else hide();
  }
  function onMap() { hide(); }

  coach.classList.remove('hidden');
  renderStep();
  nextBtn.addEventListener('click', onNext);
  skipBtn.addEventListener('click', hide);
  if (mapEl) mapEl.addEventListener('pointerdown', onMap, true);
}
