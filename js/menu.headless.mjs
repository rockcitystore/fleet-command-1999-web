// Focused headless smoke for the 39-mission campaign menu wiring.
// Loads the served game (which auto-starts mission 0 and renders its 3D view),
// waits for the mission library to register, asserts the menu renders >=39
// cards with no console errors, then reads the already-running world + 3D
// scene. We deliberately do NOT call startGame() again: spinning up a second
// WebGL world under software rendering blows the sandbox memory budget.
import puppeteer from '/Users/barbarossa/WorkBuddy-Profiles/acct2/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const PORT = process.env.PORT || 8137;
const URL = `http://localhost:${PORT}/`;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const errors = [];
let failures = 0;
function check(cond, msg) {
  if (cond) console.log('PASS: ' + msg);
  else { failures++; console.log('FAIL: ' + msg); }
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('requestfailed', (r) => { if (!r.url().includes('favicon')) errors.push('reqfail: ' + r.url()); });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Wait for the mission library to register (>=39 scenario cards).
  let cards = 0;
  try {
    await page.waitForFunction(() => document.querySelectorAll('.scenario-card').length >= 39, { timeout: 10000 });
    cards = await page.evaluate(() => document.querySelectorAll('.scenario-card').length);
  } catch { cards = await page.evaluate(() => document.querySelectorAll('.scenario-card').length); }
  check(cards >= 39, `mission menu rendered ${cards} cards (need >=39)`);

  const kinds = await page.evaluate(() => ({
    region: document.querySelectorAll('.sc-region').length,
    single: document.querySelectorAll('.sc-single').length,
  }));
  check(kinds.region >= 4 && kinds.single >= 30, `cards classified region=${kinds.region} single=${kinds.single}`);

  // The boot path auto-started mission 0; read that world (no second startGame).
  const started = await page.evaluate(() => {
    const w = window.__fc && window.__fc.world;
    return {
      ok: !!w,
      ships: w ? w.ships.length : 0,
      goals: w ? (w.goals || []).length : 0,
      phase: w ? w.phase : null,
      scenarios: window.__fc && window.__fc.SCENARIOS ? window.__fc.SCENARIOS.length : 0,
    };
  });
  check(started.scenarios >= 39, `campaign track registered ${started.scenarios} missions`);
  check(started.ok, 'auto-started mission world present');
  check(started.ships > 0, `mission world spawned ships (${started.ships})`);
  check(started.goals > 0, `mission world bound goal tree (${started.goals})`);
  check(started.phase === 'playing', `mission starts in playing phase (${started.phase})`);

  const scene = await page.evaluate(() => !!(window.__fc && window.__fc.scene3d));
  check(scene, '3D scene active after starting mission');

  check(errors.length === 0, `no console/page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 12).forEach((e) => console.log('   err: ' + e));
} finally {
  await browser.close().catch(() => {});
}
console.log(`\nMenu smoke failures: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
