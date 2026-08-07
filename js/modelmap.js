// modelmap.js — maps Fleet Command '99 game units to authentic .j3d model keys.
//
// The native models live at assets/models3d/<key>/model.json (converted from the
// original Graphics/3d archive via tools/convert_j3d.py). This module resolves a
// ship or aircraft to one of those keys so render3d.js can draw the real original
// geometry instead of a procedural placeholder.
//
// Resolution order for ships:
//   1. Hull-code found in the unit name (CG / DDG / CVN / SSN / SSBN / FFG ...) with
//      a nationality-aware model pick.
//   2. Fallback by generic shipClass.
//   3. null  -> caller keeps the procedural mesh.
//
// Every key below was verified present in assets/models3d/index.json.

// Per hull-code, candidate model keys ordered [US, Russia, China, UK, Other].
const HULL_MODELS = {
  CVN: ['nimitz2', 'kuznetsov_d', null, 'invincible_d', 'colossus_d'],
  CV:  ['nimitz2', 'kuznetsov_d', null, 'invincible_d', 'colossus_d'],
  LHD: ['wasp_d', null, null, null, null],
  LHA: ['wasp_d', null, null, null, null],
  CGN: ['tico52', 'kirov', null, null, null],
  CG:  ['tico52', 'slava', null, null, null],
  DDG: ['burke', 'sovremenny', 'luda', 'duke', null],
  DD:  ['spruance', 'udaloy', 'luda', 'duke', null],
  FFG: ['perry', null, 'jiangwei', 'duke', 'broadsword'],
  FF:  ['perry', null, 'jianghu', 'duke', 'broadsword'],
  SSBN: ['ohio', 'typhoon', 'xia', null, null],
  SSGN: ['ohio', 'oscar', null, null, null],
  SSN: ['688i', 'akula', 'han', 'trafalgar', 'collins'],
  SSK: ['688i', 'kilo', 'kilo', 'oberon', 'collins'],
};

// Generic fallback by shipClass (covers bases / unknown hulls).
const CLASS_FALLBACK = {
  carrier: 'nimitz2',
  cruiser: 'tico52',
  destroyer: 'burke',
  frigate: 'perry',
  submarine: '688i',
  installation: 'airport',
  battleship: 'iowa',
};

// Nationality hints parsed from the unit name.
const RU = /\b(rus|soviet|russia|kiev|slava|kirov|sovrem|udaloy|kashin|kilo|akula|oscar|typhoon|kara|moscow|admir|priaz|zapol|kuznet)\b/i;
const CN = /\b(chi|china|pla|luda|luhu|jiang|kun|huang|song|han|type\s*0|type\s*5)\b/i;
const UK = /\b(uk|royal|invincible|type\s*42|type\s*23|duke|broad|colossus|herc|almirante|espera|drummond)\b/i;

function nation(name) {
  if (RU.test(name)) return 1;
  if (CN.test(name)) return 2;
  if (UK.test(name)) return 3;
  return 0; // default US
}

const HULL_RE = /\b(CVN|CV|LHD|LHA|CGN|CG|DDG|DD|FFG|FF|SSBN|SSGN|SSN|SSK)\b/i;

export function shipModelKey(ship) {
  const name = ship.name || '';
  const cls = (ship.shipClass || '').toLowerCase();

  // Land bases / AGIs are not ships — render the airfield/installation model.
  if (/airport|base|agi|installation/i.test(name)) {
    return cls === 'installation' ? 'airport' : 'airport';
  }

  const m = name.match(HULL_RE);
  if (m) {
    const code = m[1].toUpperCase();
    const cand = HULL_MODELS[code];
    if (cand) {
      const n = nation(name);
      const key = cand[n] || cand[0];
      if (key) return key;
    }
  }
  return CLASS_FALLBACK[cls] || null;
}

// Aircraft type -> model key. Keys verified present in the converted set.
const AIRCRAFT_MODELS = {
  'f/a-18': 'f18a', 'f-18': 'f18a', 'fa-18': 'f18a', 'f18': 'f18a',
  'f-14': 'f14', 'f14': 'f14',
  'f-15': 'f15', 'f15': 'f15',
  'f-16': 'f16', 'f16': 'f16',
  'av-8': 'av8b', 'harrier': 'av8b',
  'a-4': 'a4', 'a4': 'a4',
  'a-5': 'a5', 'a5': 'a5',
  // A-6 Intruder: original FC99 ships no A6.J3D; EA-6B Prowler is the same
  // airframe (near-identical silhouette) -> best available proxy.
  'a-6': 'ea6b', 'a6': 'ea6b',
  'ea-6': 'ea6b', 'ea6': 'ea6b', 'prowler': 'ea6b',
  'e-2': 'e2c', 'e2': 'e2c', 'hawkeye': 'e2c',
  'e-3': 'e3', 'e3': 'e3', 'sentry': 'e3',
  's-3': 's3', 's3': 's3', 'viking': 's3',
  // ES-3 Shadow: no es3.J3D exists; S-3 Viking is the same airframe -> proxy.
  'es-3': 's3', 'es3': 's3',
  'sh-60': 'sh60', 'sh60': 'sh60', 'seahawk': 'sh60',
  'hh-60': 'sh60', 'uh-60': 'sh60',
  'ah-1': 'ah1w', 'ah1': 'ah1w', 'cobra': 'ah1w',
  'p-3': 'p3c', 'p3': 'p3c', 'orion': 'p3c',
  // C-130 / A-10 / Il-76 have no dedicated model in FC99's 3d.grp; fall back
  // to the game's own generic aircraft placeholder (3dplane.J3D) rather than 404.
  'c-130': '3dplane', 'c130': '3dplane', 'hercules': '3dplane',
  'a-10': '3dplane', 'a10': '3dplane', 'thunderbolt': '3dplane',
  'mig': 'mig31', 'su-': 'su27_d', 'su2': 'su24_d', 'su3': 'su33_d',
  // Tu-95 Bear -> bear-F.J3D (verified key).
  'tu-': 'bear-f', 'tu9': 'bear-f',
  'il-': '3dplane', 'il7': '3dplane', 'candid': '3dplane',
};

export function aircraftModelKey(ac) {
  const t = (ac.type || ac.name || '').toLowerCase();
  if (!t) return null;
  for (const [k, v] of Object.entries(AIRCRAFT_MODELS)) {
    if (t.includes(k)) return v;
  }
  return '3dplane'; // generic aircraft fallback
}
