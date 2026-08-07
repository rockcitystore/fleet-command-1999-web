// ui.js — menu / scenario select / HUD DOM (imports engine.js)
// CONTRACT section 4. No game state mutation except via world methods + handlers.

import { SCENARIOS, SHIP_STATS, upsToKts } from './engine.js';
import { RENDER_OPTIONS } from './render.js';

const SPEED_BUTTONS = {
  1: 'btn-1x',
  10: 'btn-10x',
  25: 'btn-25x',
  50: 'btn-50x',
  100: 'btn-100x',
  200: 'btn-200x',
};

function el(id) {
  return document.getElementById(id);
}

// ---- Campaign progress (localStorage) ----
function getUnlocked() {
  try {
    const v = parseInt(localStorage.getItem('fc99_campaign_unlocked') || '0', 10);
    return Number.isNaN(v) ? 0 : v;
  } catch { return 0; }
}
export function unlockCampaign(idx) {
  try {
    const cur = getUnlocked();
    if (idx > cur) localStorage.setItem('fc99_campaign_unlocked', String(idx));
  } catch {}
}

// One-shot handler fired when a battle reaches a win/lose state.
let missionEndHandler = null;
export function registerMissionEndHandler(fn) { missionEndHandler = fn; }

// buildMenu installs the real implementation; main.js calls this once the
// original 39-mission library has finished loading.
let missionListRefresher = null;
export function refreshMissionList() {
  if (missionListRefresher) missionListRefresher();
}

// Briefing overlay state (persists across opens so listeners wire only once).
let briefingIndex = -1;
let briefingOnStart = null;
function openBriefing(index, onStart) {
  const sc = SCENARIOS[index];
  if (!sc) return;
  briefingIndex = index;
  briefingOnStart = onStart;
  const b = sc.briefing || { title: sc.name, description: sc.brief };
  el('brief-title').textContent = b.title || sc.name;
  el('brief-theater').textContent = b.theater || '';
  el('brief-desc').textContent = b.description || '';
  el('brief-intel').textContent = b.intel || '';
  el('brief-task').textContent = b.task || '';
  const ob = el('brief-objectives');
  if (ob) ob.innerHTML = (sc.objectives || []).map((o) => `<div class="brief-obj">▸ ${o.text}</div>`).join('');
  const overlay = el('briefing');
  if (overlay) overlay.classList.remove('hidden');
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

  let currentMode = 'single';

  // Build one mission card. `locked` cards are inert and explain themselves.
  function missionCard(scenario, index, locked) {
    const m = scenario.mission;
    const card = document.createElement('div');
    card.className = 'scenario-card' + (locked ? ' locked' : '');
    if (m) card.classList.add(m.kind === 'region' ? 'sc-region' : 'sc-single');
    if (!locked) {
      card.tabIndex = 0;
      card.setAttribute('role', 'button');
    }

    const name = document.createElement('div');
    name.className = 'sc-name';
    name.textContent = scenario.name + (locked ? '  🔒' : '');
    card.appendChild(name);

    const brief = document.createElement('div');
    brief.className = 'sc-brief';
    brief.textContent = locked
      ? 'Locked — clear the previous mission to unlock.'
      : scenario.brief;
    card.appendChild(brief);

    // Order-of-battle summary straight from the original scenario file.
    if (m && !locked) {
      const meta = document.createElement('div');
      meta.className = 'sc-meta';
      const c = m.counts || {};
      const bits = [
        `<span class="sc-blue">BLUE ${c.player || 0}</span>`,
        `<span class="sc-red">RED ${c.enemy || 0}</span>`,
      ];
      if (c.neutral) bits.push(`<span class="sc-neu">NEU ${c.neutral}</span>`);
      const air = (c.airPlayer || 0) + (c.airEnemy || 0);
      if (air) bits.push(`<span class="sc-air">AIR ${air}</span>`);
      if (m.difficulty != null) bits.push(`<span class="sc-diff">DIFF ${m.difficulty}</span>`);
      if (m.spanNm) bits.push(`<span class="sc-span">${Math.round(m.spanNm)} NM</span>`);
      meta.innerHTML = bits.join('');
      card.appendChild(meta);
    }

    if (!locked) {
      const activate = () => openBriefing(index, onStart);
      card.addEventListener('click', activate);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          activate();
        }
      });
    }
    return card;
  }

  function sectionHeader(text, sub) {
    const h = document.createElement('div');
    h.className = 'sc-section';
    h.innerHTML = `<span class="sc-section-t">${text}</span>` +
      (sub ? `<span class="sc-section-s">${sub}</span>` : '');
    return h;
  }

  function renderMissionCards() {
    const unlocked = getUnlocked();
    list.innerHTML = '';

    // With the original library loaded the list splits into the four campaign
    // theatres (Region1-4.scc) and the 35 stand-alone missions (SingleNN.scs).
    const hasLibrary = SCENARIOS.some((s) => s.mission);
    if (!hasLibrary) {
      SCENARIOS.forEach((scenario, index) => {
        list.appendChild(missionCard(scenario, index, currentMode === 'campaign' && index > unlocked));
      });
      return;
    }

    const regions = [];
    const singles = [];
    SCENARIOS.forEach((s, i) => {
      (s.mission && s.mission.kind === 'region' ? regions : singles).push([s, i]);
    });

    if (regions.length) {
      list.appendChild(sectionHeader('CAMPAIGN THEATRES', `${regions.length} regional operations`));
      for (const [s, i] of regions) {
        list.appendChild(missionCard(s, i, currentMode === 'campaign' && i > unlocked));
      }
    }
    if (singles.length) {
      list.appendChild(sectionHeader('SINGLE MISSIONS', `${singles.length} scenarios`));
      for (const [s, i] of singles) {
        list.appendChild(missionCard(s, i, currentMode === 'campaign' && i > unlocked));
      }
    }
  }

  // Exposed so main.js can redraw the list once missions.json resolves.
  missionListRefresher = renderMissionCards;

  // Briefing overlay controls (wired once; persist across opens).
  const bStart = el('btn-brief-start');
  if (bStart) bStart.addEventListener('click', () => {
    el('briefing').classList.add('hidden');
    if (briefingOnStart) briefingOnStart(briefingIndex);
  });
  const bBack = el('btn-brief-back');
  if (bBack) bBack.addEventListener('click', () => {
    el('briefing').classList.add('hidden');
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
        // CAMPAIGN reuses the single-mission order of battle as a track,
        // gating later missions behind completed ones.
        currentMode = act;
        renderMissionCards();
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
  const optStatus = el('opt-status');
  if (optGrid) optGrid.addEventListener('click', () => {
    RENDER_OPTIONS.grid = !RENDER_OPTIONS.grid;
    syncOptionsUI();
  });
  if (optSymbol) optSymbol.addEventListener('click', () => {
    RENDER_OPTIONS.symbolStyle = RENDER_OPTIONS.symbolStyle === 'ntds' ? 'simple' : 'ntds';
    syncOptionsUI();
  });
  if (optStatus) optStatus.addEventListener('click', () => {
    RENDER_OPTIONS.statusIcons = !RENDER_OPTIONS.statusIcons;
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
    if (optStatus) { optStatus.dataset.on = RENDER_OPTIONS.statusIcons ? '1' : '0'; optStatus.textContent = RENDER_OPTIONS.statusIcons ? 'ON' : 'OFF'; }
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
  [1, 10, 25, 50, 100, 200].forEach((n) => {
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

  // End screen NEXT MISSION / RETRY buttons
  const nextBtn = el('btn-next-mission');
  if (nextBtn) {
    nextBtn.addEventListener('click', () => {
      const i = parseInt(nextBtn.dataset.next, 10);
      if (!isNaN(i) && handlers.onStartMission) handlers.onStartMission(i);
    });
  }
  const retryBtn = el('btn-retry');
  if (retryBtn) {
    retryBtn.addEventListener('click', () => {
      const i = parseInt(retryBtn.dataset.index, 10);
      if (!isNaN(i) && handlers.onStartMission) handlers.onStartMission(i);
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
      el('info-course').textContent = fmtSpeed(p.speed);
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
      el('info-speed').textContent = fmtSpeed(ac.speed);
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
  el('info-speed').textContent = fmtSpeed(s.speed);
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

  // Live objective tracker
  const objLive = el('objectives');
  if (objLive) {
    if (world.objectives && world.objectives.length) {
      objLive.classList.remove('hidden');
      objLive.innerHTML = '<div class="obj-title">OBJECTIVES</div>' + world.objectives.map((o) => {
        const cls = o.status === 'ok' ? 'ok' : o.status === 'failed' ? 'fail' : 'pend';
        const m = o.status === 'ok' ? '✓' : o.status === 'failed' ? '✗' : '•';
        return `<div class="obj-row ${cls}"><span class="obj-mark">${m}</span><span class="obj-text">${o.text}</span></div>`;
      }).join('');
    } else {
      objLive.classList.add('hidden');
    }
  }

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
    const detailEl = el('end-detail');
    if (detailEl) detailEl.textContent = victory
      ? (world.debrief && world.debrief.win ? world.debrief.win : 'ALL OBJECTIVES COMPLETE')
      : (world.debrief && world.debrief.lose ? world.debrief.lose : 'OBJECTIVE FAILED');

    const objBox = el('end-objectives');
    if (objBox) {
      if (world.objectives && world.objectives.length) {
        objBox.innerHTML = '<div class="eo-title">MISSION OBJECTIVES</div>' + world.objectives.map((o) => {
          const cls = o.status === 'ok' ? 'ok' : o.status === 'failed' ? 'fail' : 'pend';
          const m = o.status === 'ok' ? '✓' : o.status === 'failed' ? '✗' : '•';
          return `<div class="eo-row ${cls}"><span class="eo-mark">${m}</span><span class="eo-text">${o.text}</span></div>`;
        }).join('');
        objBox.classList.remove('hidden');
      } else {
        objBox.classList.add('hidden');
      }
    }

    const nextBtn = el('btn-next-mission');
    const retryBtn = el('btn-retry');
    if (nextBtn && retryBtn) {
      if (victory) {
        const ni = (world.__scenarioIndex || 0) + 1;
        const total = SCENARIOS.length;
        if (ni < total) {
          nextBtn.textContent = (ni === total - 1) ? 'FINAL MISSION ▸' : 'NEXT MISSION ▸';
          nextBtn.dataset.next = String(ni);
          nextBtn.classList.remove('hidden');
        } else {
          nextBtn.textContent = 'CAMPAIGN COMPLETE';
          nextBtn.dataset.next = '';
          nextBtn.classList.remove('hidden');
        }
        retryBtn.classList.add('hidden');
      } else {
        retryBtn.dataset.index = String(world.__scenarioIndex || 0);
        retryBtn.classList.remove('hidden');
        nextBtn.classList.add('hidden');
      }
    }

    if (!world.__endHandled) {
      world.__endHandled = true;
      if (missionEndHandler) missionEndHandler(world);
    }
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
  // `v` is world units per game-second; convert back to knots for display so
  // the readout matches reality (e.g. a 31-kt destroyer shows "31 kts").
  return `${Math.round(upsToKts(v))} kts`;
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
