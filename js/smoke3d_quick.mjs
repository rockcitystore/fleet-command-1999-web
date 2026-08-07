// Quick headless smoke: confirm Scene3D builds + renders without JS errors.
// Kept deliberately short (the auto-start of the 61-ship Bay of Bengal mission
// under SwiftShader is memory-heavy, so we only let it render ~1.5s).
import puppeteer from '/Users/barbarossa/WorkBuddy-Profiles/acct2/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';
const PORT = process.env.PORT || 8137;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const errors = [];
let failures = 0;
const check = (c, m) => { if (c) console.log('PASS: ' + m); else { failures++; console.log('FAIL: ' + m); } };
const browser = await puppeteer.launch({
  executablePath: CHROME, headless: 'new', protocolTimeout: 60000,
  args: ['--no-sandbox', '--disable-gpu-sandbox', '--disable-dev-shm-usage',
    '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  await page.goto(`http://localhost:${PORT}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
  await new Promise((r) => setTimeout(r, 1500));
  const st = await page.evaluate(() => {
    const fc = window.__fc;
    return {
      hasScene: !!(fc && fc.scene3d),
      ships: fc && fc.world ? fc.world.ships.length : -1,
      effects: fc && fc.scene3d ? fc.scene3d._effects.length : -1,
      wakeTrails: fc && fc.scene3d ? fc.scene3d._wakeTrails.size : -1,
      envKey: fc && fc.scene3d ? fc.scene3d._envKey : null,
    };
  });
  check(st.hasScene, 'Scene3D constructed');
  check(st.ships > 0, `world built (${st.ships} ships)`);
  check(errors.length === 0, `no console/page errors (${errors.length})`);
  if (errors.length) errors.slice(0, 12).forEach((e) => console.log('   err: ' + e));
} finally {
  await browser.close().catch(() => {});
}
console.log(`\nQuick 3D smoke failures: ${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
