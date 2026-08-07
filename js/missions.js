// missions.js — loader for the decoded original Fleet Command '99 mission set.
//
// assets/data/missions.json is produced offline by tools/parse_scenarios.py from
// the 39 scenario files that shipped with the 1999 game:
//
//   Region1.scc  Bay of Bengal          Region3.scc  Taiwan Strait
//   Region2.scc  Strait of Malacca      Region4.scc  Kuril Island
//   Single01..Single35.scs              (35 stand-alone missions)
//
// Each mission carries the verbatim briefing text, the full order of battle
// (1500 units in total), in-flight aircraft, spawn probabilities, plotted
// waypoint routes and the authentic 653-node GOAL tree.

import { registerMissions } from './engine.js';

let CACHE = null;
let INFLIGHT = null;

export function missionLibrary() { return CACHE; }

export async function loadMissions(url = 'assets/data/missions.json') {
  if (CACHE) return CACHE;
  if (INFLIGHT) return INFLIGHT;
  INFLIGHT = (async () => {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`missions.json HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !Array.isArray(data.missions) || !data.missions.length) {
      throw new Error('missions.json is empty or malformed');
    }
    CACHE = data;
    registerMissions(data);
    return data;
  })();
  try {
    return await INFLIGHT;
  } finally {
    INFLIGHT = null;
  }
}

// Convenience lookups used by the campaign map.
export function missionById(id) {
  if (!CACHE) return null;
  return CACHE.missions.find((m) => m.id === id) || null;
}

export function regionMissions() {
  if (!CACHE) return [];
  return CACHE.missions.filter((m) => m.kind === 'region');
}

export function singleMissions() {
  if (!CACHE) return [];
  return CACHE.missions.filter((m) => m.kind === 'single');
}
