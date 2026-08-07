// campaign.js — the real Fleet Command '99 campaign branch tree.
//
// The shipped game ships four regional campaigns (Region1-4.scc) plus 35
// stand-alone scenarios (SingleNN.scs). In the original, each region is a
// tier on the campaign trunk and finishing it unlocks the next region AND a
// set of "side operation" single missions that branch off that region. This
// module derives that tree from the registered mission library, tracks
// progress in localStorage, and answers unlock/status queries for the UI.
//
// Note: the original cross-mission branch definitions live in the campaign
// .cmp files, which are not part of the decoded goal trees. We therefore
// build a faithful, deterministic tree: the four regions form the sequential
// trunk, and the 35 singles are split evenly across the regions as branch
// leaves that open when their parent region is won.

import { SCENARIOS } from './engine.js';

const STORAGE_KEY = 'fc99_campaign_v1';

// --- Tree construction ---------------------------------------------------

export function buildCampaignTree() {
  const regions = [];
  const singles = [];
  SCENARIOS.forEach((s, i) => {
    if (!s.mission) return;
    if (s.mission.kind === 'region') {
      regions.push({ id: s.mission.id, index: i, title: s.name, brief: s.brief || '' });
    } else if (s.mission.kind === 'single') {
      singles.push({ id: s.mission.id, index: i, title: s.name, difficulty: s.mission.difficulty });
    }
  });

  // Evenly distribute the singles across the regions as branch leaves.
  const branches = {};
  if (regions.length) {
    const per = Math.ceil(singles.length / regions.length);
    regions.forEach((r, t) => {
      branches[r.id] = singles.slice(t * per, t * per + per).map((x) => x.id);
    });
  }
  return { regions, singles, branches };
}

// --- Progress persistence -------------------------------------------------

export function loadProgress() {
  try {
    const raw = (typeof localStorage !== 'undefined') && localStorage.getItem(STORAGE_KEY);
    if (!raw) return { completed: {} };
    const p = JSON.parse(raw);
    return p && p.completed ? p : { completed: {} };
  } catch {
    return { completed: {} };
  }
}

export function saveProgress(p) {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch { /* storage may be unavailable; progress is then session-only */ }
}

// Record the outcome of a mission. Only a victory advances the campaign; a
// defeat is remembered (for the "retry" badge) but does not unlock anything.
export function recordResult(id, victory) {
  const p = loadProgress();
  p.completed[id] = victory ? 'victory' : 'defeat';
  saveProgress(p);
  return p;
}

export function resetProgress() {
  saveProgress({ completed: {} });
}

// --- Unlock / status queries ---------------------------------------------

function regionIndexOf(tree, id) {
  return tree.regions.findIndex((r) => r.id === id);
}

export function isUnlocked(tree, id, progress) {
  progress = progress || loadProgress();
  const ri = regionIndexOf(tree, id);
  if (ri >= 0) {
    if (ri === 0) return true; // first region is always available
    const prev = tree.regions[ri - 1];
    return progress.completed[prev.id] === 'victory';
  }
  // A single mission is a branch leaf: unlocked once its parent region is won.
  const parent = tree.regions.find((r) => (tree.branches[r.id] || []).includes(id));
  if (parent) return progress.completed[parent.id] === 'victory';
  return false;
}

export function statusOf(tree, id, progress) {
  progress = progress || loadProgress();
  const done = progress.completed[id];
  if (done === 'victory') return 'victory';
  if (done === 'defeat') return 'defeat';
  return isUnlocked(tree, id, progress) ? 'available' : 'locked';
}

// The next campaign step after a region is won: prefer the next region,
// otherwise the first still-locked branch single. Returns a SCENARIO index
// or -1 when the whole campaign is cleared.
export function nextAfter(tree, regionId, progress) {
  progress = progress || loadProgress();
  const ri = regionIndexOf(tree, regionId);
  if (ri < 0) return -1;
  if (ri + 1 < tree.regions.length) return tree.regions[ri + 1].index;
  // Last region cleared: offer the first uncompleted branch single.
  for (const id of tree.singles.map((s) => s.id)) {
    if (statusOf(tree, id, progress) === 'available') return tree.singles.find((s) => s.id === id).index;
  }
  return -1;
}

// Linear "how far have you got" count, used as a fallback for the flat list.
export function unlockedCount(tree, progress) {
  progress = progress || loadProgress();
  let n = 0;
  for (const r of tree.regions) {
    if (progress.completed[r.id] === 'victory') n++;
    else break;
  }
  return n;
}
