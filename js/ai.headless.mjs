// Headless test for the local-LLM (Ollama) RED fleet commander.
//
// Verifies:
//   1. The #btn-ai toggle + #ai-status readout exist.
//   2. Enabling AI: LLM calls the commander's transport (the /api/chat
//      equivalent) and the RED fleet receives orders.
//   3. While the war is cold (combatStarted === false) the commander does NOT
//      open fire — attack orders are downgraded to a hold.
//   4. Once combat has started, the commander's attack orders are applied.
//   5. Toggling back to BUILTIN restores the built-in doctrine and disables
//      the LLM.
//   6. No console / page errors throughout.
//
// The Ollama server is NOT required: we inject a deterministic mock transport
// so the test is fast and hermetic.
//
// Run (from code/web/):  node js/ai.headless.mjs
import puppeteer from '/Users/barbarossa/WorkBuddy-Profiles/acct2/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js';

const PORT = process.env.PORT || 8000;
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

  // Start a battle.
  await page.evaluate(() => window.__fc && window.__fc.startGame && window.__fc.startGame(0));
  await new Promise((r) => setTimeout(r, 700));

  // --- UI present ----------------------------------------------------------
  const ui = await page.evaluate(() => ({
    btn: !!document.getElementById('btn-ai'),
    status: !!document.getElementById('ai-status'),
    btnLabel: document.getElementById('btn-ai') && document.getElementById('btn-ai').textContent,
    enemyCount: window.__fc.world ? window.__fc.world.aliveShips('enemy').length : -1,
    playerCount: window.__fc.world ? window.__fc.world.aliveShips('player').length : -1,
    combatStarted: window.__fc.world ? window.__fc.world.combatStarted : null,
  }));
  check(ui.btn, 'AI toggle button (#btn-ai) exists');
  check(ui.status, 'AI status readout (#ai-status) exists');
  check(await page.evaluate(() => !!document.getElementById('ai-live')),
    'RED CIC live readout (#ai-live) exists');
  check(ui.btnLabel === 'AI: BUILTIN', 'AI button defaults to BUILTIN');
  check(ui.enemyCount > 0, `scenario has RED ships (${ui.enemyCount})`);
  check(ui.playerCount > 0, `scenario has BLUE ships (${ui.playerCount})`);
  check(ui.combatStarted === false, 'war starts cold (combatStarted === false)');

  // --- Inject a deterministic mock transport ------------------------------
  // Returns an ATTACK order on the first RED ship against the first BLUE ship.
  // streamTransport simulates token-by-token delivery via opts.onToken so the
  // streaming live-readout path is exercised.
  await page.evaluate(() => {
    const w = window.__fc.world;
    const e = w.aliveShips('enemy')[0];
    const p = w.aliveShips('player')[0];
    const orders = [{ ship: e.id, act: 'attack', target: p.id }];
    const full = JSON.stringify(orders);
    window.__mock = { calls: 0, lastMessages: null, chunks: 0 };
    const c = window.__fc.aiCommander;
    c.transport = (messages, opts) => {
      window.__mock.calls++;
      window.__mock.lastMessages = messages;
      return full;
    };
    c.streamTransport = (messages, opts) => {
      window.__mock.calls++;
      window.__mock.lastMessages = messages;
      const onToken = opts && opts.onToken;
      let acc = '';
      for (const ch of full) { acc += ch; if (onToken) onToken(ch, acc); }
      window.__mock.chunks = acc.length;
      return full;
    };
  });

  // --- Enable LLM mode (uses the mock transport) --------------------------
  await page.evaluate(() => window.__fc.setAIMode('llm'));
  await page.waitForFunction(
    () => window.__fc.aiCommander.callCount > 0 && !window.__fc.aiCommander.inFlight,
    { timeout: 8000 }
  );

  const llmOn = await page.evaluate(() => ({
    mode: window.__fc.world.aiMode,
    enabled: window.__fc.aiCommander.enabled,
    calls: window.__fc.aiCommander.callCount,
    mockCalls: window.__mock.calls,
    brief: window.__fc.aiCommander.lastBrief,
    btnLabel: document.getElementById('btn-ai').textContent,
    // Cold war: attack must NOT be applied yet.
    enemyOrder: (() => {
      const e = window.__fc.world.aliveShips('enemy')[0];
      return e && e.order ? e.order.kind : null;
    })(),
  }));
  check(llmOn.mode === 'llm', 'AI mode switches to llm');
  check(llmOn.enabled === true, 'commander enabled in llm mode');
  check(llmOn.calls > 0, 'commander transport was invoked (>/api/chat/ equivalent)');
  check(llmOn.mockCalls > 0, 'mock transport recorded a call');
  check(typeof llmOn.brief === 'string' && llmOn.brief.length > 0, 'lastBrief is populated');

  // --- Streaming live-readout checks --------------------------------------
  const stream = await page.evaluate(() => {
    const c = window.__fc.aiCommander;
    return {
      chunks: window.__mock.chunks,
      liveText: c.liveText,
      lastRaw: c.lastRaw,
      phase: c.phase,
      statusText: c.statusText(),
      domLive: (document.getElementById('ai-live') || {}).textContent || '',
    };
  });
  check(stream.chunks > 1, 'streaming delivered multiple token chunks');
  check(stream.phase === 'done', 'streaming cycle reached phase=done');
  check(stream.liveText.length > 0 && stream.liveText === stream.lastRaw,
    'liveText accumulated the full streamed reply');
  check(stream.domLive.length > 0 && stream.domLive !== '—', 'RED CIC HUD shows the live readout');

  check(llmOn.btnLabel === 'AI: LLM', 'AI button reflects LLM mode');
  check(llmOn.enemyOrder === null || llmOn.enemyOrder !== 'attack',
    'cold war: RED does NOT open fire (attack downgraded to hold)');

  // --- Start the war, then force a fresh decision -------------------------
  await page.evaluate(() => { window.__fc.world.combatStarted = true; });
  await page.evaluate(async () => {
    await window.__fc.aiCommander.tick(window.__fc.world, { force: true });
  });

  const hot = await page.evaluate(() => {
    const e = window.__fc.world.aliveShips('enemy')[0];
    const p = window.__fc.world.aliveShips('player')[0];
    return {
      enemyOrder: e && e.order ? e.order.kind : null,
      enemyTarget: e ? e.targetId : null,
      playerId: p ? p.id : null,
    };
  });
  check(hot.enemyOrder === 'attack', 'hot war: RED engages (attack order applied)');
  check(hot.enemyTarget === hot.playerId, 'hot war: RED attack targets a BLUE ship');

  // --- Toggle back to BUILTIN ---------------------------------------------
  await page.evaluate(() => window.__fc.setAIMode('builtin'));
  const back = await page.evaluate(() => ({
    mode: window.__fc.world.aiMode,
    enabled: window.__fc.aiCommander.enabled,
    btnLabel: document.getElementById('btn-ai').textContent,
  }));
  check(back.mode === 'builtin', 'AI mode switches back to builtin');
  check(back.enabled === false, 'commander disabled in builtin mode');
  check(back.btnLabel === 'AI: BUILTIN', 'AI button reflects BUILTIN mode');

  check(errors.length === 0, 'no console/page errors (' + errors.length + ')');
  if (errors.length) errors.slice(0, 10).forEach((e) => console.log('  ERR: ' + e));
} finally {
  await browser.close();
}

console.log('\n' + (failures === 0 ? 'ALL AI TESTS PASSED' : `${failures} AI TEST(S) FAILED`));
process.exit(failures === 0 ? 0 : 1);
