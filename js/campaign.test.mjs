// campaign.test.mjs — campaign branch-tree logic (Node, mocked localStorage).
import { registerMissions, SCENARIOS } from './engine.js';
import {
  buildCampaignTree, loadProgress, recordResult, resetProgress,
  isUnlocked, statusOf, nextAfter, unlockedCount,
} from './campaign.js';

// --- minimal localStorage mock ---
const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};

let passed = 0, failed = 0;
function check(cond, msg) { if (cond) { passed++; } else { failed++; console.log('FAIL: ' + msg); } }
function section(t) { console.log('\n--- ' + t + ' ---'); }

// Load the library so SCENARIOS is populated.
const fs = await import('fs');
const lib = JSON.parse(fs.readFileSync('assets/data/missions.json', 'utf8'));
registerMissions(lib);
resetProgress();

section('tree construction');
const tree = buildCampaignTree();
check(tree.regions.length === 4, `4 campaign regions (${tree.regions.length})`);
check(tree.singles.length === 35, `35 single missions (${tree.singles.length})`);
const allBranches = Object.values(tree.branches).flat();
check(allBranches.length === 35, `every single assigned to a branch (${allBranches.length}/35)`);
check(new Set(allBranches).size === 35, 'no single appears in two branches');
const perRegion = Object.values(tree.branches).map((b) => b.length);
check(Math.min(...perRegion) >= 8, `branches distributed across regions (${perRegion.join(',')})`);

section('unlock gating');
const r0 = tree.regions[0].id, r1 = tree.regions[1].id;
const b0 = tree.branches[r0][0];
check(isUnlocked(tree, r0, loadProgress()), 'first region available from the start');
check(!isUnlocked(tree, r1, loadProgress()), 'second region locked initially');
check(!isUnlocked(tree, b0, loadProgress()), 'branch single locked initially');
check(statusOf(tree, r0, loadProgress()) === 'available', 'first region shows available');
check(statusOf(tree, r1, loadProgress()) === 'locked', 'second region shows locked');

recordResult(r0, true);
check(isUnlocked(tree, r1, loadProgress()), 'winning region 1 unlocks region 2');
check(isUnlocked(tree, b0, loadProgress()), 'winning region 1 opens its branch singles');
check(statusOf(tree, r0, loadProgress()) === 'victory', 'won region shows victory');
check(unlockedCount(tree, loadProgress()) === 1, 'unlocked count advanced to 1');

recordResult(b0, false);
check(statusOf(tree, b0, loadProgress()) === 'defeat', 'defeated branch shows defeat');
check(isUnlocked(tree, b0, loadProgress()), 'a defeated (but unlocked) single stays available');

section('progression / next');
const afterR0 = nextAfter(tree, r0, loadProgress());
check(afterR0 === tree.regions[1].index, 'nextAfter region1 -> region2 index');
// Win every region; the next step should fall through to a branch single or -1.
for (const r of tree.regions) recordResult(r.id, true);
const lastR = tree.regions[tree.regions.length - 1].id;
const afterLast = nextAfter(tree, lastR, loadProgress());
const stillAvailable = tree.singles.some((s) => statusOf(tree, s.id, loadProgress()) === 'available');
check(afterLast >= 0 ? stillAvailable : !stillAvailable, 'after final region: next is a branch single or campaign complete');

section('persistence');
resetProgress();
check(loadProgress().completed && Object.keys(loadProgress().completed).length === 0, 'resetProgress clears stored progress');
check(!isUnlocked(tree, r1, loadProgress()), 'reset re-locks later regions');

console.log(`\nChecks passed: ${passed}`);
if (failed) { console.log(`Checks FAILED: ${failed}`); process.exit(1); }
else console.log('ALL CAMPAIGN CHECKS PASSED');
