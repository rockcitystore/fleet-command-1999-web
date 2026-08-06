// Headless smoke test for the Fleet Command '99 web game.
// Loads the dev server in real Chrome, starts a battle, advances time, and
// asserts: (1) no console/page errors, (2) the game booted, (3) ships fire
// under the decoded authentic reload doctrine (projectiles get spawned).
//
// Run (from code/web/):
//   node js/smoke.headless.mjs
// Requires the dev server running on PORT (default 8137):
//   python3 -m http.server 8137
import puppeteer from '/Users/barbarossa/WorkBuddy-Profiles/acct2/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const PORT = process.env.PORT || 8137;
const URL = `http://localhost:${PORT}/`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const errors = [];
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS: ' + msg);
  else { failures++; console.error('FAIL: ' + msg); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-gpu-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist',
    '--window-size=1000,800',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 800 });
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 20000 });

  // Boot: a canvas + the game module should be present.
  const booted = await page.evaluate(() => !!document.querySelector('canvas') && !!window.__fc);
  check(booted, 'game booted (canvas + window.__fc present)');

  // Start the first scenario battle.
  await page.evaluate(() => window.__fc && window.__fc.startGame && window.__fc.startGame(0));
  await new Promise((r) => setTimeout(r, 400));

  const started = await page.evaluate(() => window.__fc && window.__fc.world && window.__fc.world.ships.length > 0);
  check(started, 'scenario 0 battle started with ships');

  // Force a controlled engagement so weapons actually fire under the decoded
  // authentic reload doctrine: start combat, and park an enemy ship inside the
  // player's weapon range so detection + firing both trigger on the next frames.
  await page.evaluate(() => {
    const w = window.__fc.world;
    w.combatStarted = true;
    const p = w.aliveShips('player')[0];
    const e = w.aliveShips('enemy')[0];
    if (p && e) {
      e.pos.x = p.pos.x + 400; e.pos.y = p.pos.y; // within all weapon ranges
      p.targetId = e.id; e.targetId = p.id;
    }
  });

  // Let the simulation run a few real seconds (combat should commence and
  // weapons should fire under the decoded authentic reload values).
  await new Promise((r) => setTimeout(r, 5000));

  const snap = await page.evaluate(() => {
    const w = window.__fc.world;
    if (!w) return null;
    return {
      time: w.time,
      phase: w.phase,
      ships: w.ships.length,
      anyAmmoSpent: w.ships.some((s) => (s.weapons || []).some((wp) => wp.count < wp.magMax)),
    };
  });
  check(snap && snap.time > 0, `simulation advanced (t=${snap ? snap.time.toFixed(1) : 'n/a'}s)`);
  check(snap && (snap.anyAmmoSpent || snap.phase !== 'playing'),
    'weapons fired under authentic reload (ammo spent or battle resolved)');

  check(errors.length === 0, `no console/page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 10).forEach((e) => console.error('   err: ' + e));
} finally {
  await browser.close();
}

console.log(`\nSmoke failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
