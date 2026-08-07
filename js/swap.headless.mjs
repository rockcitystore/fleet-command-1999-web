// Headless test for the SWAP feature: exchanging the main screen and the
// bottom-centre TACTICAL MAP panel. Verifies canvas reparenting, the 2D->3D
// camera mirror when swapped, the right-click input being attached to the big
// tactical map, and that toggling back restores the default layout.
//
// Run (from code/web/):  node js/swap.headless.mjs
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

  await page.evaluate(() => window.__fc && window.__fc.startGame && window.__fc.startGame(0));
  await new Promise((r) => setTimeout(r, 900));

  // --- Default layout: 3D main, 2D tactical map in bottom-centre panel ---
  const def = await page.evaluate(() => {
    const main = document.getElementById('screen-battle');
    const panel = document.getElementById('panel-3d');
    const m3 = document.getElementById('map3d');
    const m2 = document.getElementById('map2d');
    return {
      scene3d: !!(window.__fc && window.__fc.scene3d),
      map3dInMain: m3 && m3.parentElement === main,
      map2dInPanel: m2 && m2.parentElement === panel,
      map2dHasPanelSlot: m2 && m2.classList.contains('panel3-slot'),
      tacInputOff: !window.__fc.detachInput2dTac,
    };
  });
  check(def.scene3d, 'default: Scene3D active');
  check(def.map3dInMain, 'default: #map3d is in the main screen');
  check(def.map2dInPanel, 'default: #map2d is in the bottom-centre panel');
  check(def.map2dHasPanelSlot, 'default: #map2d carries .panel3-slot');
  check(def.tacInputOff, 'default: no tactical 2D input attached (main is 3D)');

  // --- Click SWAP ---
  await page.evaluate(() => document.getElementById('btn-swap').click());
  await new Promise((r) => setTimeout(r, 600));

  const swapped = await page.evaluate(() => {
    const main = document.getElementById('screen-battle');
    const panel = document.getElementById('panel-3d');
    const m3 = document.getElementById('map3d');
    const m2 = document.getElementById('map2d');
    return {
      flag: window.__fc.swapped === true,
      map2dInMain: m2 && m2.parentElement === main,
      map3dInPanel: m3 && m3.parentElement === panel,
      map2dHasMainSlot: m2 && m2.classList.contains('main-slot'),
      map3dHasPanelSlot: m3 && m3.classList.contains('panel3-slot'),
      tacInputOn: !!window.__fc.detachInput2dTac,
      map2dVisible: m2 && !m2.classList.contains('hidden'),
    };
  });
  check(swapped.flag, 'swap: game.swapped flag set');
  check(swapped.map2dInMain, 'swap: #map2d moved to the main screen');
  check(swapped.map3dInPanel, 'swap: #map3d moved to the bottom-centre panel');
  check(swapped.map2dHasMainSlot, 'swap: #map2d carries .main-slot');
  check(swapped.map3dHasPanelSlot, 'swap: #map3d carries .panel3-slot');
  check(swapped.tacInputOn, 'swap: right-click 2D tactical input attached to big map');
  check(swapped.map2dVisible, 'swap: big 2D tactical map is visible');

  // --- 2D -> 3D camera mirror: move world.camera, the small 3D must follow ---
  const sync = await page.evaluate(async () => {
    const s = window.__fc.scene3d;
    const w = window.__fc.world;
    const cx = w.camera.center.x + 5000;
    const cy = w.camera.center.y - 3000;
    w.camera.center.x = cx;
    w.camera.center.y = cy;
    w.camera.zoom = 0.012;
    await new Promise((r) => setTimeout(r, 120)); // let the loop run
    return {
      tx: s.target.x, tz: s.target.z,
      okX: Math.abs(s.target.x - cx) < 1,
      okZ: Math.abs(s.target.z - cy) < 1,
    };
  });
  check(sync.okX, `swap: 3D target.x mirrors 2D camera (${sync.tx.toFixed(1)})`);
  check(sync.okZ, `swap: 3D target.z mirrors 2D camera (${sync.tz.toFixed(1)})`);

  // --- The small 3D panel must still render (not blank) ---
  const small3d = await page.evaluate(() => {
    const src = document.getElementById('map3d');
    if (!src) return { ok: false };
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let nonbg = 0; const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 6) > 14 || Math.abs(d[i + 1] - 18) > 14 || Math.abs(d[i + 2] - 31) > 14) nonbg++;
    }
    return { ok: true, frac: nonbg / total };
  });
  check(small3d.ok && small3d.frac > 0.2, `swap: small 3D panel rendered (frac=${small3d.frac.toFixed(2)})`);

  // --- Toggle SWAP off: layout restored, input detached ---
  await page.evaluate(() => document.getElementById('btn-swap').click());
  await new Promise((r) => setTimeout(r, 500));
  const restored = await page.evaluate(() => {
    const main = document.getElementById('screen-battle');
    const panel = document.getElementById('panel-3d');
    const m3 = document.getElementById('map3d');
    const m2 = document.getElementById('map2d');
    return {
      flag: window.__fc.swapped === false,
      map3dInMain: m3 && m3.parentElement === main,
      map2dInPanel: m2 && m2.parentElement === panel,
      tacInputOff: !window.__fc.detachInput2dTac,
    };
  });
  check(restored.flag, 'restore: game.swapped flag cleared');
  check(restored.map3dInMain, 'restore: #map3d back in main screen');
  check(restored.map2dInPanel, 'restore: #map2d back in bottom panel');
  check(restored.tacInputOff, 'restore: tactical 2D input detached');

  // --- Survives a 3D<->2D view toggle: re-enter 3D, swap should still apply ---
  await page.evaluate(() => document.getElementById('btn-swap').click()); // swap on
  await page.evaluate(() => document.getElementById('btn-viewmode').click()); // 2D
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.getElementById('btn-viewmode').click()); // 3D
  await new Promise((r) => setTimeout(r, 400));
  const afterToggle = await page.evaluate(() => {
    const main = document.getElementById('screen-battle');
    const panel = document.getElementById('panel-3d');
    const m3 = document.getElementById('map3d');
    const m2 = document.getElementById('map2d');
    return {
      swapped: window.__fc.swapped === true,
      map2dInMain: m2 && m2.parentElement === main,
      map3dInPanel: m3 && m3.parentElement === panel,
      scene3d: !!window.__fc.scene3d,
      tacInputOn: !!window.__fc.detachInput2dTac,
    };
  });
  check(afterToggle.swapped, 'view-toggle: swap state preserved');
  check(afterToggle.map2dInMain, 'view-toggle: #map2d still in main after 2D->3D');
  check(afterToggle.map3dInPanel, 'view-toggle: #map3d still in panel after 2D->3D');
  check(afterToggle.scene3d, 'view-toggle: Scene3D re-initialised');
  check(afterToggle.tacInputOn, 'view-toggle: tactical input re-attached while swapped');

  check(errors.length === 0, `no console/page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 10).forEach((e) => console.log('   err: ' + e));
} finally {
  await browser.close();
}

console.log(`\nSWAP test failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
