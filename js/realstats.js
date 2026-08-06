// Real numeric stats reverse-engineered from the original 1999 Fleet Command
// binary databases (objects.odb / sensors.sdb / launcher.ldb).
//
// Confidence labels:
//   [KNOWN]    field semantics validated against real-world values
//   [INFERRED] plausible field semantics, not independently confirmed
//
// Field discovery:
//   objects.odb : 329 records x 284 bytes. offset +236 = weapon RANGE (meters).
//                 offset +112 ~ weapon SPEED (knots). offset +120 ~ depth.
//                 offset +248 = weapon RELOAD (float, MINUTES -> x60 = seconds).
//                 offset +252 = warhead mass (f252).  [RELOAD +248 decoded &
//                 verified against the original binary database.]
//   sensors.sdb : 41 records x 152 bytes. offset +88 / +92 = sensor DETECTION
//                 RANGE (meters), two values (typically nominal / max).
//   launcher.ldb: 832 records x 196 bytes. offset +124 = weapon reference ID
//                 (points back into objects.odb); carries no reload/stat values
//                 (reload lives in objects.odb at +248).
//
// IMPORTANT — spatial scale caveat:
//   The web game world is WORLD_SIZE = 4000 units. Real missions span
//   ~150–230 m per world unit after normalization. At ~200 m/unit a real
//   torpedo range of 22 km is only ~110 world units, while opposing fleets
//   in the real placements sit ~2500–3500 units apart. Directly substituting
//   these values would make weapons unable to reach the enemy and break
//   playability.
//
// Solution used here:
//   We apply a uniform GAMEPLAY SCALE to real ranges so that the RELATIVE
//   performance of weapon classes is preserved (heavy torpedoes out-range
//   light torpedoes; SM-2 out-ranges SM-1; Harpoon out-ranges Exocet) while
//   keeping engagement distances fun on a 4000-unit map. The scale is chosen
//   so that a ~22 km torpedo reaches ~330 units and a ~140 km anti-ship
//   missile reaches the map cap of 2000 units. Sensor ranges are scaled
//   separately because a 400 km AEW radar would otherwise cover the whole
//   world and remove fog-of-war.

// meters per world unit, derived from .scs placement normalization. [INFERRED]
export const REAL_SCALE_M_PER_UNIT = 200;

// ---------------------------------------------------------------------------
// Raw weapon data extracted from objects.odb offset +236 (range_m),
// offset +112 (speed_kts), offset +120 (depth_i). [KNOWN]
// ---------------------------------------------------------------------------
export const REAL_WEAPONS_RAW = {
  'Mk 46 Torpedo':     { type: 'torpedo',     range_m:  12000, speed_kts: 50,   depth_i: -500, f252: 100 },
  'DM 2A4 Torpedo':    { type: 'torpedo',     range_m:  22000, speed_kts: 34,   depth_i: -500, f252: 100 },
  '65 cm Torpedo':     { type: 'torpedo',     range_m:  70000, speed_kts: 50,   depth_i: -300, f252: 100 },
  'Harpoon':           { type: 'missile',     range_m: 140000, speed_kts: 510,  depth_i:    1, f252: 750 },
  'Exocet':            { type: 'missile',     range_m:  80000, speed_kts: 570,  depth_i:    1, f252: 700 },
  'ESSM':              { type: 'missile',     range_m:  16000, speed_kts: 2400, depth_i:    1, f252: 700 },
  'SM-1 MR':           { type: 'missile',     range_m:  50000, speed_kts: 1800, depth_i:    1, f252: 500 },
  'SM-2':              { type: 'missile',     range_m: 162000, speed_kts: 1800, depth_i:    1, f252: 400 },
  'SR Shell':          { type: 'gun',         range_m:  14000, speed_kts: 1800, depth_i:    0, f252:   0 },
  'MR Shell':          { type: 'gun',         range_m:  26000, speed_kts: 1591, depth_i:    0, f252:   0 },
  'LR Shell':          { type: 'gun',         range_m:  36000, speed_kts:  500, depth_i:    0, f252:   0 },
  'RBU Rocket':        { type: 'asroc',       range_m:   6000, speed_kts:  300, depth_i: -550, f252: 700 },
  'Depth Charge':      { type: 'depthCharge', range_m:   2000, speed_kts:  200, depth_i: -550, f252: 700 },
};

// Raw sensor data extracted from sensors.sdb offsets +88/+92 (nominal/max). [KNOWN]
export const REAL_SENSORS_RAW = {
  'HF Act Son':         { r88:   5000, r92:  10000 },
  'MF Act Son':         { r88:   8000, r92:  20000 },
  'HF Pas Son':         { r88:  10000, r92:  20000 },
  'LF Pas Son':         { r88:  20000, r92:  40000 },
  'Active Sonobuoy':    { r88:   3000, r92:   6000 },
  'Dipping Sonar':      { r88:   8000, r92:  20000 },
  'AEW Radar (LR)':     { r88: 400000, r92: 500000 },
  'A/C Radar (LR)':     { r88: 150000, r92: 200000 },
  'Ship Air Radar (LR)':{ r88: 200000, r92: 300000 },
  'Ship Air Radar (MR)':{ r88: 100000, r92: 150000 },
  'Ship Air Radar (SR)':{ r88:  20000, r92:  60000 },
  'Ship Surf Radar(MR)':{ r88:  40000, r92:  60000 },
  'Ship Surf Radar(SR)':{ r88:  20000, r92:  40000 },
  'Surf Search Radar':  { r88: 200000, r92: 220000 },
  'Surf ESM':           { r88:  22000, r92:  45000 },
  'Visual':             { r88:  15000, r92:  20000 },
};

// ---------------------------------------------------------------------------
// Gameplay scaling
// ---------------------------------------------------------------------------

// Uniform weapon-range scale. 0.015 means 22 km -> 330 world units and
// 140 km -> 2100 (capped). Preserves relative class performance.
export const WEAPON_RANGE_SCALE = 0.015;

// Sensors need a smaller effective scale so that fog-of-war remains meaningful
// on a 4000-unit map. A 300 km ship air radar would otherwise cover 3/4 of the
// world. Sonar uses the same scale as weapons because subs fight at close range.
export const RADAR_RANGE_SCALE = 0.008;
export const SONAR_RANGE_SCALE = 0.015;

// Hard cap so ultra-long weapons (TASM-class, AEW-class) do not trivially cover
// the entire map from spawn.
export const WEAPON_RANGE_CAP = 2000;
export const RADAR_RANGE_CAP = 2500;
export const SONAR_RANGE_CAP = 600;

export function mToUnits(m, scale = WEAPON_RANGE_SCALE, cap = WEAPON_RANGE_CAP) {
  return Math.min(cap, Math.round(m * scale));
}

export function sensorToUnits(sensor) {
  const m = Math.max(sensor.r88, sensor.r92);
  // Heuristic: if it's a sonar type, use sonar scale; otherwise radar scale.
  const isSonar = /son|buoy|mAD/i.test(sensor.name || Object.keys(REAL_SENSORS_RAW).find(k => REAL_SENSORS_RAW[k] === sensor));
  return mToUnits(m, isSonar ? SONAR_RANGE_SCALE : RADAR_RANGE_SCALE, isSonar ? SONAR_RANGE_CAP : RADAR_RANGE_CAP);
}

// ---------------------------------------------------------------------------
// Reference tables (rounded to world units)
// ---------------------------------------------------------------------------
export const REAL_WEAPON_RANGE_UNITS = Object.fromEntries(
  Object.entries(REAL_WEAPONS_RAW).map(([k, v]) => [
    k,
    mToUnits(v.range_m, WEAPON_RANGE_SCALE, WEAPON_RANGE_CAP),
  ])
);

export const REAL_SENSOR_RANGE_UNITS = Object.fromEntries(
  Object.entries(REAL_SENSORS_RAW).map(([k, v]) => [
    k,
    mToUnits(Math.max(v.r88, v.r92),
      /son|buoy|mAD/i.test(k) ? SONAR_RANGE_SCALE : RADAR_RANGE_SCALE,
      /son|buoy|mAD/i.test(k) ? SONAR_RANGE_CAP : RADAR_RANGE_CAP),
  ])
);

// ---------------------------------------------------------------------------
// Build a game-ready SHIP_STATS object from real data.
// Keeps the original 6 web classes; assigns historically representative
// loadouts per class.
// ---------------------------------------------------------------------------
export function buildRealShipStats(WORLD_SIZE = 4000) {
  const R = (name) => REAL_WEAPONS_RAW[name];
  const rg = (name) => mToUnits(R(name).range_m);

  // FC99 firing doctrine.
  //   RELONE scalar decoded from objects.odb at offset +248 (float, MINUTES ->
  //   seconds x60). The original binary stores a SINGLE per-weapon reload time
  //   = the per-launch-tube replenishment period. That maps directly onto this
  //   model's inter-volley RELOAD (engine.js: for salvo>1 the post-salvo gap is
  //   RELOAD). SALVO = number of tubes dumped in one trigger-pull (the visible
  //   volley); RIPPLE = the quick sequential launch spacing INSIDE the salvo
  //   (FC99 launches a salvo's rounds within ~1 s of each other, so this is a
  //   small value). Total volley-to-volley cycle ~= (salvo-1)*ripple + reload,
  //   i.e. it tracks the authentic reload.
  //
  //   RELONE values [KNOWN] — decoded & verified against the original binary
  //   (objects.odb, 329 records x 284 bytes):
  //     Harpoon      idx=133  f62=0.100 -> 6.0s     Exocet     idx=100  f62=0.100 -> 6.0s
  //     SM-1 MR      idx=262  f62=0.030 -> 1.8s     SM-2       idx=263  f62=0.030 -> 1.8s
  //     ESSM         idx=98   f62=0.030 -> 1.8s     RBU Rocket idx=231  f62=0.030 -> 1.8s
  //     Depth Charge idx=80   f62=0.030 -> 1.8s
  //     DM 2A4 Torp  idx=81   f62=0.200 -> 12.0s    65 cm Torp idx=1    f62=0.200 -> 12.0s
  //     (other torpedoes — Mk46/48, 53cm, A244, Spearfish, Mk37/44/50 — all 0.2 -> 12.0s)
  //     Gun MOUNTS (30 records, e.g. idx=22 Almirante Brown) f62=0.300 -> 18.0s
  //       (mount magazine-reload cycle). Gun SHELL records have f62=0 because the
  //       ROF is governed at the mount, so guns are modelled as continuous fire
  //       (salvo=1, reload=0) — the 18 s is a known reference, not applied.
  //
  //   SALVO and RIPPLE remain [INFERRED] design choices (the original binary
  //   carries only the single reload scalar, not a salvo/ripple split). The
  //   prior [INFERRED] tuned reload values are now replaced by the [KNOWN]
  //   decoded ones above.
  const FIRE_DOCTRINE = {
    'Harpoon':        { salvo: 2, ripple: 0.6, reload: 6 },    // [KNOWN] 6.0s
    'Exocet':         { salvo: 2, ripple: 0.6, reload: 6 },    // [KNOWN] 6.0s
    'SM-1 MR':        { salvo: 2, ripple: 0.4, reload: 1.8 },  // [KNOWN] 1.8s
    'SM-2':           { salvo: 2, ripple: 0.4, reload: 1.8 },  // [KNOWN] 1.8s
    'ESSM':           { salvo: 2, ripple: 0.3, reload: 1.8 },  // [KNOWN] 1.8s
    'MR Shell':       { salvo: 1, ripple: 0.9, reload: 0 },    // [KNOWN] mount 18s; continuous
    'LR Shell':       { salvo: 1, ripple: 1.2, reload: 0 },    // [KNOWN] mount 18s; continuous
    'SR Shell':       { salvo: 1, ripple: 1.0, reload: 0 },    // [KNOWN] mount 18s; continuous
    'RBU Rocket':     { salvo: 2, ripple: 0.5, reload: 1.8 },  // [KNOWN] 1.8s
    'Depth Charge':   { salvo: 2, ripple: 0.5, reload: 1.8 },  // [KNOWN] 1.8s
    'DM 2A4 Torpedo': { salvo: 2, ripple: 0.6, reload: 12 },   // [KNOWN] 12.0s
    '65 cm Torpedo':  { salvo: 1, ripple: 12,  reload: 12 },   // [KNOWN] 12.0s (single heavy torpedo)
  };

  const w = (name, damage, cooldown, note) => {
    const raw = R(name);
    const isUnderwater = raw.type === 'torpedo' || raw.type === 'asroc' || raw.type === 'depthCharge';
    // FC99 firing doctrine: which target DOMAINS this weapon may engage.
    //   torpedo  -> surface + sub      missile -> surface only (anti-ship)
    //   gun      -> surface + air       asroc/depthCharge -> sub only
    const targetsByType = {
      torpedo: ['surface', 'sub'],
      missile: ['surface'],
      gun: ['surface', 'air'],
      asroc: ['sub'],
      depthCharge: ['sub'],
    };
    // Surface-to-air missiles act as the air-defence battery and can also
    // intercept incoming enemy aircraft and anti-ship missiles.
    const isSAM = raw.type === 'missile' && /SM-|ESSM|Sea Sparrow|Sparrow/i.test(name);
    const fd = FIRE_DOCTRINE[name] || { salvo: 1, ripple: cooldown, reload: 0 };
    return {
      type: raw.type,
      range: rg(name),
      damage,
      cooldown, // retained for UI/reporting; the salvo model below drives timing
      // FC99 salvo/ripple/reload firing doctrine (see FIRE_DOCTRINE above).
      salvo: fd.salvo,
      ripple: fd.ripple,
      reload: fd.reload,
      // per-instance fire state (mutated at runtime by updateWeapons)
      _salvoLeft: 0,
      _salvoNext: 0,
      _reloadLeft: 0,
      minDepth: isUnderwater ? Math.max(-800, raw.depth_i) : 0,
      maxDepth: isUnderwater ? 0 : 0,
      realName: name,
      note,
      targets: targetsByType[raw.type] || ['surface'],
      canIntercept: !!isSAM,
    };
  };

  const cap = (v, max) => Math.min(max ?? WORLD_SIZE / 2, Math.round(v));

  return {
    destroyer: {
      label: 'DDG',
      maxHp: 60,
      maxSpeedKts: 31, // Arleigh Burke-class flank speed [COMMON]
      radius: 14,
      sensorRange: cap(Math.max(
        REAL_SENSORS_RAW['Ship Surf Radar(MR)'].r92 * RADAR_RANGE_SCALE,
        REAL_SENSORS_RAW['MF Act Son'].r92 * SONAR_RANGE_SCALE
      )),
      isSub: false,
      defaultDepth: 0,
      weapons: [
        w('SM-1 MR', 30, 5, 'area air defence'),
        w('Harpoon', 55, 8, 'anti-ship missile'),
        w('MR Shell', 12, 0.9, '5"/76 mm gun'),
        w('RBU Rocket', 30, 7, 'ASW rocket'),
        w('Depth Charge', 22, 3, 'ASW depth charge'),
      ],
    },
    frigate: {
      label: 'FFG',
      maxHp: 45,
      maxSpeedKts: 29, // Oliver Hazard Perry-class flank speed [COMMON]
      radius: 13,
      sensorRange: cap(Math.max(
        REAL_SENSORS_RAW['Ship Surf Radar(SR)'].r92 * RADAR_RANGE_SCALE,
        REAL_SENSORS_RAW['HF Act Son'].r92 * SONAR_RANGE_SCALE
      )),
      isSub: false,
      defaultDepth: 0,
      weapons: [
        w('SM-1 MR', 26, 5.5, 'area air defence'),
        w('Exocet', 45, 7, 'anti-ship missile'),
        w('SR Shell', 8, 1.0, '76 mm gun'),
        w('RBU Rocket', 28, 7, 'ASW rocket'),
        w('Depth Charge', 22, 3, 'ASW depth charge'),
      ],
    },
    cruiser: {
      label: 'CG',
      maxHp: 110,
      maxSpeedKts: 30, // Ticonderoga-class flank speed [COMMON]
      radius: 17,
      sensorRange: cap(Math.max(
        REAL_SENSORS_RAW['Ship Air Radar (LR)'].r92 * RADAR_RANGE_SCALE,
        REAL_SENSORS_RAW['LF Pas Son'].r92 * SONAR_RANGE_SCALE
      )),
      isSub: false,
      defaultDepth: 0,
      weapons: [
        w('SM-2', 35, 6, 'long-range air defence'),
        w('Harpoon', 55, 8, 'anti-ship missile'),
        w('LR Shell', 18, 1.2, '5"/127 mm gun'),
        w('DM 2A4 Torpedo', 50, 6, 'ASW torpedo'),
      ],
    },
    battleship: {
      label: 'BB',
      maxHp: 220,
      maxSpeedKts: 33, // Iowa-class flank speed [COMMON]
      radius: 22,
      sensorRange: cap(REAL_SENSORS_RAW['Ship Air Radar (MR)'].r92 * RADAR_RANGE_SCALE),
      isSub: false,
      defaultDepth: 0,
      weapons: [
        w('SM-1 MR', 28, 5, 'area air defence'),
        w('Harpoon', 55, 8, 'anti-ship missile'),
        w('LR Shell', 26, 1.4, '16"/406 mm guns'),
      ],
    },
    carrier: {
      label: 'CV',
      maxHp: 260,
      maxSpeedKts: 32, // Nimitz-class flank speed (classified ~30+) [COMMON]
      radius: 26,
      sensorRange: cap(REAL_SENSORS_RAW['AEW Radar (LR)'].r92 * RADAR_RANGE_SCALE, RADAR_RANGE_CAP),
      isSub: false,
      defaultDepth: 0,
      weapons: [
        w('ESSM', 22, 3.5, 'point air defence'),
        w('SM-1 MR', 26, 5, 'area air defence'),
        w('SR Shell', 6, 1.5, 'CIWS / saluting gun'),
      ],
    },
    submarine: {
      label: 'SSN',
      maxHp: 80,
      maxSpeedKts: 25, // Los Angeles-class submerged flank speed [COMMON]
      radius: 12,
      sensorRange: cap(REAL_SENSORS_RAW['LF Pas Son'].r92 * SONAR_RANGE_SCALE, SONAR_RANGE_CAP),
      isSub: true,
      defaultDepth: -120,
      weapons: [
        w('65 cm Torpedo', 70, 8, 'heavy torpedo'),
        w('DM 2A4 Torpedo', 50, 6, 'standard torpedo'),
      ],
    },
    installation: {
      label: 'BASE',
      maxHp: 150,
      maxSpeedKts: 0,
      radius: 20,
      sensorRange: cap(REAL_SENSORS_RAW['Ship Air Radar (LR)'].r92 * RADAR_RANGE_SCALE, RADAR_RANGE_CAP),
      isSub: false,
      defaultDepth: 0,
      immobile: true,
      weapons: [
        w('SM-1 MR', 26, 5, 'point air defence'),
        w('SR Shell', 6, 1.5, 'coastal gun'),
      ],
    },
  };
}

// Pre-built for the default 4000-unit world.
export const REAL_SHIP_STATS = buildRealShipStats(4000);

// ---------------------------------------------------------------------------
// Sensor suites (FC99 first principle: detection is TYPE- and DEPTH-aware).
// Each platform carries a set of sensors; a contact is detected only when an
// opposing sensor of the matching KIND can reach it. A submerged platform has
// its masts down, so radar/ESM/visual go blind — only sonar works.
// ---------------------------------------------------------------------------
function sensorKindFromName(name) {
  if (/Son|buoy/i.test(name)) return /Pas/i.test(name) ? 'passiveSonar' : 'activeSonar';
  if (/ESM/i.test(name)) return 'esm';
  if (/AEW|A\/C Radar|Air Radar/i.test(name)) return 'airRadar';
  if (/Surf|Surface/i.test(name)) return 'surfaceRadar';
  return 'surfaceRadar';
}

// Real sensor names (from sensors.sdb) assigned to each web class.
const SHIP_SENSOR_KINDS = {
  destroyer:   ['Ship Surf Radar(MR)', 'Ship Air Radar (MR)', 'HF Pas Son', 'MF Act Son', 'Surf ESM'],
  frigate:     ['Ship Surf Radar(SR)', 'Ship Air Radar (SR)', 'HF Pas Son', 'HF Act Son', 'Surf ESM'],
  cruiser:     ['Ship Surf Radar(MR)', 'Ship Air Radar (LR)', 'LF Pas Son', 'MF Act Son', 'Surf ESM'],
  battleship:  ['Ship Surf Radar(MR)', 'Ship Air Radar (MR)', 'HF Pas Son', 'Surf ESM'],
  carrier:     ['AEW Radar (LR)', 'Ship Surf Radar(MR)', 'LF Pas Son', 'Surf ESM'],
  installation:['Ship Air Radar (LR)', 'Ship Surf Radar(MR)', 'Surf ESM'],
  submarine:   ['LF Pas Son', 'MF Act Son'], // no radar/ESM — submerged blind to surface
};

for (const [cls, stat] of Object.entries(REAL_SHIP_STATS)) {
  const kinds = SHIP_SENSOR_KINDS[cls] || ['Ship Surf Radar(MR)'];
  stat.sensors = kinds.map((name) => ({
    kind: sensorKindFromName(name),
    range: sensorToUnits(REAL_SENSORS_RAW[name]),
  }));
  // Visual (short, all-round) layered on top of the emission/reflection suites.
  stat.sensors.push({ kind: 'visual', range: 180 });
}

// Backward-compatible alias for consumers that expect a scalar list.
export const REAL_WEAPON_RANGE_M = {
  torpedo: REAL_WEAPONS_RAW['DM 2A4 Torpedo'].range_m,
  missile: REAL_WEAPONS_RAW['Harpoon'].range_m,
  gun: REAL_WEAPONS_RAW['MR Shell'].range_m,
  depthCharge: REAL_WEAPONS_RAW['Depth Charge'].range_m,
  asroc: REAL_WEAPONS_RAW['RBU Rocket'].range_m,
};

export const REAL_SENSOR_RANGE_M = {
  'HF Act Son': [5000, 10000],
  'MF Act Son': [8000, 20000],
  'HF Pas Son': [10000, 20000],
  'LF Pas Son': [20000, 40000],
  'AEW Radar (LR)': [400000, 500000],
  'A/C Radar (LR)': [150000, 200000],
  'Ship Air Radar (LR)': [200000, 300000],
};
