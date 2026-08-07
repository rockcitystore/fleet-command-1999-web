// Headless 3D smoke test for the Fleet Command '99 WebGL view.
// Forces software WebGL (SwiftShader) so it runs without a GPU, starts a
// battle, and asserts the Scene3D actually rendered something (not a blank
// canvas), that ship meshes were built, and that there were no console errors.
//
// Run (from code/web/):  node js/smoke3d.headless.mjs
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

  // Track failed model/texture fetches so a bad key surfaces as a failure.
  const modelFails = [];
  const texFails = [];
  page.on('response', (res) => {
    const u = res.url();
    if (u.includes('/models3d/') && u.endsWith('.json') && !res.ok()) {
      modelFails.push(u.split('/').pop() + ' ' + res.status());
    }
    if (u.includes('/textures/') && u.endsWith('.bmp') && !res.ok()) {
      texFails.push(u.split('/').pop() + ' ' + res.status());
    }
  });

  await page.goto(URL, { waitUntil: 'networkidle2', timeout: 20000 });

  const webgl = await page.evaluate(() => {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  });
  check(webgl, 'WebGL is available (software/SwiftShader)');

  await page.evaluate(() => window.__fc && window.__fc.startGame && window.__fc.startGame(0));
  await new Promise((r) => setTimeout(r, 900)); // let the rAF loop render frames

  const active = await page.evaluate(() => !!(window.__fc && window.__fc.scene3d));
  check(active, 'Scene3D initialised (3D view active)');

  const meshCount = await page.evaluate(() =>
    window.__fc && window.__fc.scene3d ? window.__fc.scene3d.shipMeshes.size : -1);
  check(meshCount > 0, `ship meshes built (${meshCount})`);

  // Camera controls + unprojection + picking must work without throwing and
  // must actually change state.
  const cam = await page.evaluate(() => {
    const s = window.__fc.scene3d; const w = window.__fc.world;
    const t0 = { x: s.target.x, z: s.target.z };
    const d0 = s.distance, az0 = s.azimuth;
    s.pan(120, 60); s.orbit(40, 25); s.zoom(0.85);
    const wp = s.screenToWorld(500, 400);
    const picked = s.pick(500, 400, w);
    return {
      panned: (s.target.x !== t0.x || s.target.z !== t0.z),
      zoomed: s.distance !== d0,
      orbited: s.azimuth !== az0,
      worldFinite: !!wp && Number.isFinite(wp.x) && Number.isFinite(wp.y),
      pickedIsNum: (picked === null) || typeof picked === 'number',
    };
  });
  check(cam.panned, 'camera pan moves target');
  check(cam.zoomed, 'camera zoom changes distance');
  check(cam.orbited, 'camera orbit changes azimuth');
  check(cam.worldFinite, 'screenToWorld returns finite world coords');
  check(cam.pickedIsNum, 'pick returns a ship id or null');

  // Draw the WebGL canvas onto a 2D canvas and count pixels that differ from
  // the dark background — proves geometry (water/grid/land/ships) was drawn.
  const stats = await page.evaluate(() => {
    const src = document.getElementById('map3d');
    if (!src) return { ok: false };
    const tmp = document.createElement('canvas');
    tmp.width = src.width; tmp.height = src.height;
    const ctx = tmp.getContext('2d');
    ctx.drawImage(src, 0, 0);
    const d = ctx.getImageData(0, 0, tmp.width, tmp.height).data;
    let nonbg = 0; const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      const r = d[i], g = d[i + 1], b = d[i + 2];
      if (Math.abs(r - 6) > 14 || Math.abs(g - 18) > 14 || Math.abs(b - 31) > 14) nonbg++;
    }
    return { ok: true, w: tmp.width, h: tmp.height, frac: nonbg / total };
  });
  check(stats.ok && stats.frac > 0.5,
    `3D scene rendered non-blank (frac=${stats.ok ? stats.frac.toFixed(2) : 'n/a'}, ${stats.w || 0}x${stats.h || 0})`);

  // The bottom TACTICAL MAP (2D) panel should also be drawing.
  const two = await page.evaluate(() => {
    const c = document.getElementById('map2d');
    if (!c) return { ok: false };
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let nonbg = 0; const total = d.length / 4;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - 4) > 14 || Math.abs(d[i + 1] - 18) > 14 || Math.abs(d[i + 2] - 31) > 14) nonbg++;
    }
    return { ok: true, frac: nonbg / total };
  });
  check(two.ok && two.frac > 0.01, `2D tactical map panel drawing (frac=${two.ok ? two.frac.toFixed(2) : 'n/a'})`);

  // Authentic .j3d models load asynchronously; wait for the swap-in and verify
  // at least one ship + one aircraft became an original-geometry model, and
  // that no model fetch 404'd.
  await new Promise((r) => setTimeout(r, 2800));
  const modelStats = await page.evaluate(() => {
    const s = window.__fc.scene3d;
    let ships = 0, shipModels = 0, acs = 0, acModels = 0;
    for (const m of s.shipMeshes.values()) { ships++; if (m.userData.isModel) shipModels++; }
    for (const m of s.acMeshes.values()) { acs++; if (m.userData.isModel) acModels++; }
    return { ships, shipModels, acs, acModels };
  });
  check(modelStats.shipModels > 0,
    `authentic ship models swapped in (${modelStats.shipModels}/${modelStats.ships})`);
  check(modelFails.length === 0, `no model fetches failed (${modelFails.length})`);
  if (modelFails.length) modelFails.slice(0, 10).forEach((e) => console.log('   modelfail: ' + e));

  // Verify original BMP textures actually loaded onto the authentic models.
  const texStats = await page.evaluate(() => {
    const s = window.__fc.scene3d;
    let total = 0, mapped = 0;
    for (const m of s.shipMeshes.values()) {
      m.traverse((o) => {
        if (o.isMesh) {
          total++;
          if (o.material && o.material.map) mapped++;
        }
      });
    }
    return { total, mapped };
  });
  check(texStats.mapped > 0,
    `original BMP textures applied (${texStats.mapped}/${texStats.total} ship parts)`);
  check(texFails.length === 0, `no texture fetches failed (${texFails.length})`);
  if (texFails.length) texFails.slice(0, 10).forEach((e) => console.log('   texfail: ' + e));

  // The test scenario starts with no airborne aircraft, so launch one CAP
  // sortie from a carrier to exercise the authentic-aircraft render path
  // end-to-end (same getInstance + async swap as ships).
  const launched = await page.evaluate(() => {
    const w = window.__fc.world;
    for (const s of w.ships) {
      if (s.aircraft && s.aircraft.length) {
        const ac = s.aircraft[0];
        const id = w.launchAircraft(s.id, ac.id, 'patrol', null);
        return id != null ? { id, type: ac.type } : null;
      }
    }
    return null;
  });
  await new Promise((r) => setTimeout(r, 1600));
  const acStats = await page.evaluate(() => {
    const s = window.__fc.scene3d;
    let acs = 0, acModels = 0;
    for (const m of s.acMeshes.values()) { acs++; if (m.userData.isModel) acModels++; }
    return { acs, acModels };
  });
  check(launched !== null, `launched a carrier aircraft (${launched ? launched.type : 'none'})`);
  check(acStats.acs > 0, `aircraft mesh built (${acStats.acs})`);
  check(acStats.acModels > 0,
    `authentic aircraft model swapped in (${acStats.acModels}/${acStats.acs})`);

  check(errors.length === 0, `no console/page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 10).forEach((e) => console.log('   err: ' + e));
} finally {
  await browser.close();
}

console.log(`\n3D smoke failures: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
