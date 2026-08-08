// ---------------------------------------------------------------------------
// AICommander — a local-LLM (Ollama / qwen3.5:4b) replacement for the built-in
// fleet doctrine, usable for EITHER side. A RED commander (side='enemy')
// directly controls the enemy fleet; a BLUE commander (side='player') directly
// controls the player fleet. Both are off by default.
//
// Design notes
// ------------
// * Each commander, every ~6 s (BLUE 10 s), receives a compact snapshot of its
//   own ships and the opposing contacts, and returns a strict JSON array of
//   orders: attack / move / hold (plus optional depth for submarines). It then
//   applies those orders directly to its own ships — it is NOT an advisor.
// * The ENEMY commander NEVER opens fire before the player commits the war: an
//   attack order while `world.combatStarted === false` is silently downgraded
//   to a hold. The PLAYER commander MAY open the war (its attack order while
//   cold sets world.combatStarted), since it stands in for the human player.
// * Throttled + in-flight guarded so the async chat call never stacks up.
// * On any error (Ollama down, timeout, malformed JSON) it falls back to the
//   built-in doctrine (`runBuiltinDoctrine` for RED, `runBuiltinPlayerDoctrine`
//   for BLUE) for that tick so neither fleet ever freezes — and keeps the LLM
//   enabled so it retries next cycle.
// * `transport` is injectable so headless tests can drive deterministic canned
//   JSON without a real Ollama server.
// ---------------------------------------------------------------------------

import { ollamaChat, ollamaChatStream, OLLAMA_DEFAULT_BASE, OLLAMA_DEFAULT_MODEL } from './ollama.js';
import { runBuiltinDoctrine, runBuiltinPlayerDoctrine } from './engine.js';

const RED_SYSTEM_PROMPT = `You are the RED fleet commander in a real-time naval war game. You command the RED (enemy) ships listed under "enemies". The player's BLUE contacts are under "contacts".

Output ONLY a JSON array of orders, one per RED ship you want to control. No prose, no markdown, no code fences — just the array.

Each order uses these EXACT fields:
  "ship":   <integer> REQUIRED — the RED ship id from the enemies list (the ship you are ordering)
  "act":    "attack" | "move" | "hold"
  "target": <integer> a BLUE contact id from the contacts list (REQUIRED only for "attack")
  "pos":    {"x":int,"y":int}  (REQUIRED only for "move")
  "depth":  <integer, negative metres>  optional, submarines only (e.g. -15 to fire, -150 to lurk); surface ships ignore it

Rules:
- "ship" and "target" MUST be integers copied exactly from the snapshot. They are never objects.
- If "combatStarted" is false, the war has NOT started. DO NOT use "attack" — issue "move"/"hold" only.
- If "combatStarted" is true, engage: missile ships stand off and attack surface contacts; ASW ships close on submarines; subs fire at surface ships from periscope depth.

Example (war started, two RED ships):
[{"ship":7,"act":"attack","target":3},{"ship":8,"act":"move","pos":{"x":950,"y":1350},"depth":-60}]`;

const BLUE_SYSTEM_PROMPT = `You are the BLUE fleet commander in a real-time naval war game. You DIRECTLY command the BLUE (player) ships listed under "friendlies". Hostile RED contacts are under "hostiles". Your orders are carried out immediately by the fleet — you are not an advisor.

OUTPUT FORMAT (strict JSON, no markdown, no code fences):
Return a single JSON object with exactly two keys:
{
  "report": "A concise Chinese tactical situation assessment / acknowledgement. Use formal military naval terminology. NO markdown, NO backticks (\`), NO emoji, NO ship ids, NO English command names like moveTo/attack/hold, NO coordinates. Refer to units by type and relative bearing, e.g. 旗舰向西北机动接敌, 反潜编队前出至中部海域建立反潜屏障, 驱逐舰向敌水面舰艇群开火.",
  "orders": [
    // one order object per BLUE ship you want to control this cycle (omit ships you leave as-is)
    {
      "ship":   <integer> — BLUE ship id (machine-use only; do NOT put this number in report)
      "act":    "attack" | "move" | "hold"
      "target": <integer> — RED hostile id (REQUIRED only for "attack")
      "pos":    {"x":int,"y":int}  (REQUIRED only for "move")
      "depth":  <integer, negative metres>  optional, submarines only (e.g. -15 to fire, -150 to lurk)
      "note":   <string> OPTIONAL — reason when overriding a human order
    },
    ...
  ]
}

CHAIN OF COMMAND (supreme rule — overrides all other instructions):
- The human player is the SUPREME COMMANDER (HQ). You are the SUBORDINATE theater commander. A friendly ship whose "orderSource" is "human" is under a DIRECT ORDER FROM HQ and is HIGHER authority than your own judgement.
- You MUST obey HQ orders. You MAY OPTIMIZE them — re-route around a fresh threat, pick the best weapon, adjust speed, add an escort — but you must NOT contradict the intent:
    * never turn a "hold" into a "move";
    * never redirect an "attack" onto a different target unless HQ's target is already destroyed;
    * never cancel a human order without cause.
- To leave a HQ order exactly as given, simply OMIT that ship from your reply — it keeps its current order. Only list a human-ordered ship if you are refining it or invoking field discretion (below).
- "将在外，君命有所不受" (a field commander may deviate from HQ when necessary): you MAY override a human order ONLY in a clear tactical emergency — the ordered target is already dead; the ship is under immediate lethal threat and must evade; or the order is physically impossible (e.g. move onto land). Deviate as little as possible, keep the ship in your reply, and set "note" to a brief reason.
- In all normal cases subordinates obey: comply with HQ.

HQ DIRECTIVE (supreme strategic intent, free-text from the human commander):
- The snapshot may include an "hqDirective" string: a natural-language order from the supreme commander (in Chinese or English), e.g. "集中火力攻击敌方航母", "全军向东南撤退", "所有驱逐舰前出护航".
- When "hqDirective" is present, TRANSLATE it into concrete ship orders that fulfill its intent. This is your TOP PRIORITY — above your own tactical preferences. You MAY still pick the best weapon, route, escort and speed per ship, but the resulting orders must serve the directive.
- You still obey the CHAIN OF COMMAND above for any ship with "orderSource":"human". If a specific per-ship HQ order and the directive conflict, honor the specific per-ship order and pursue the directive with the remaining ships.
- Continue to react tactically to fresh threats while pursuing the directive.
- When "hqDirective" is null/empty/absent, fall back to your own tactical judgement per the GENERAL RULES below.

GENERAL RULES:
- "ship" and "target" MUST be integers copied exactly from the snapshot. They are never objects.
- If "combatStarted" is false, the war has NOT started. DO NOT use "attack" — issue "move"/"hold" only, but you MAY open the war by attacking once you judge the moment is right (doing so starts the engagement).
- If "combatStarted" is true, engage: missile ships stand off and attack surface hostiles; ASW ships close on submarines; subs fire at surface ships from periscope depth.

Example (war started; #3 is under a human HOLD order you respect by omitting it, and you refine #4 to attack):
{"report":"旗舰率驱逐舰前出接敌，其余舰艇保持阵位。","orders":[{"ship":4,"act":"attack","target":7}]}`;

// Special one-shot prompt used at battle start when the human has issued no
// directive yet. The LLM produces a tactical situation report AND a short list
// of candidate orders the human can click to issue.
const BLUE_OPENING_PROMPT = `You are the BLUE fleet commander at the opening of an engagement. You have NOT yet received an HQ directive. Your task is to briefly assess the tactical situation and present a small set of concrete candidate orders for the human supreme commander to choose from.

OUTPUT FORMAT (strict JSON, no markdown, no code fences):
{
  "report": "A concise Chinese tactical situation assessment. Use formal military naval terminology. NO markdown, NO backticks, NO emoji, NO ship ids, NO English command names, NO coordinates. Describe force dispositions and the apparent enemy threat in plain professional prose, e.g. 我编队位于战区西南，敌水面舰艇群位于东北方向，防空与反舰态势对等；潜艇威胁尚不明朗。",
  "options": [
    // 3 to 4 candidate orders. Each option is a self-contained natural-language order.
    {"label": "全军进攻", "cmd": "全军向东北发起进攻，优先打击敌方主力舰"},
    {"label": "保持阵型", "cmd": "各舰保持当前阵位，按条令自主交战，反潜机前出侦察"},
    {"label": "前出侦察", "cmd": "驱逐舰前出至中部海域建立雷达哨，航母舰载机升空警戒"},
    {"label": "集中防空", "cmd": "全队转入区域防空阵型，优先保护旗舰与航母"}
  ]
}

Rules for options:
- "label" is a very short Chinese phrase (2-6 characters) shown on a button.
- "cmd" is the full natural-language order that will be sent to BLUE CIC if the human clicks it. It must be self-contained and unambiguous.
- Options must represent genuinely different courses of action; do NOT include a "cancel" or "do nothing" option.
- If the war has not started (combatStarted:false), do NOT issue attack orders — suggest aggressive movement/recon/posture instead. The first attack will open the war.
- Total JSON must be compact; keep the report under 120 Chinese characters and options under 4.`;

function buildSnapshot(world, side = 'enemy', opts = {}) {
  const round = (n) => Math.round(n);
  const ownSide = side === 'enemy' ? 'enemy' : 'player';
  const oppSide = side === 'enemy' ? 'player' : 'enemy';
  const ownLabel = side === 'enemy' ? 'enemies' : 'friendlies';
  const oppLabel = side === 'enemy' ? 'contacts' : 'hostiles';
  const own = world.aliveShips(ownSide).map((s) => ({
    id: s.id,
    type: s.shipClass || s.name || 'ship',
    x: round(s.pos.x),
    y: round(s.pos.y),
    isSub: !!s.isSub,
    depth: s.isSub ? round(s.depth) : undefined,
    speed: round(s.speed),
    weapons: (s.weapons || []).map((w) => w.type),
    order: s.order ? s.order.kind : 'none',
    orderSource: s.order ? (s.order.source || 'ai') : 'none',
  }));
  const contacts = world.aliveShips(oppSide).map((s) => ({
    id: s.id,
    type: s.shipClass || s.name || 'ship',
    x: round(s.pos.x),
    y: round(s.pos.y),
    isSub: !!s.isSub,
    speed: round(s.speed),
  }));
  const snap = {
    time: round(world.time),
    combatStarted: !!world.combatStarted,
    [ownLabel]: own,
    [oppLabel]: contacts,
  };
  // Surface the human HQ directive to the BLUE (player) commander only — it is
  // what the player LLM translates into orders. RED never sees it.
  if (ownSide === 'player' && opts && opts.hqDirective != null && opts.hqDirective !== '') {
    snap.hqDirective = opts.hqDirective;
  }
  return snap;
}

// Pull a JSON object/array out of a model reply. Supports two forms:
//   - { "report": "...", "orders": [...] }  (BLUE commander, human-readable
//     military report alongside machine orders)
//   - [...]  (RED commander, raw orders only)
// Returns { orders: [...], report: "" }. Markdown fences are tolerated.
function extractOrders(text) {
  const empty = { orders: [], report: '' };
  if (typeof text !== 'string') return empty;
  let t = text.trim();
  // Strip markdown code fences if present.
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    const parsed = JSON.parse(t);
    if (Array.isArray(parsed)) return { orders: parsed, report: '' };
    if (parsed && typeof parsed === 'object') {
      const orders = Array.isArray(parsed.orders) ? parsed.orders : [];
      const report = typeof parsed.report === 'string' ? parsed.report : '';
      return { orders, report };
    }
    return empty;
  } catch {
    // Fallback: try to grab an outermost JSON array from inside prose.
    const start = t.indexOf('[');
    const end = t.lastIndexOf(']');
    if (start !== -1 && end !== -1 && end >= start) {
      try {
        const arr = JSON.parse(t.slice(start, end + 1));
        return { orders: Array.isArray(arr) ? arr : [], report: '' };
      } catch { /* ignore */ }
    }
    return empty;
  }
}

// Parse the opening-assessment reply: { report, options: [{label, cmd}, ...] }.
function extractOpeningAssessment(text) {
  const empty = { report: '', options: [] };
  if (typeof text !== 'string') return empty;
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  try {
    const parsed = JSON.parse(t);
    if (!parsed || typeof parsed !== 'object') return empty;
    const report = typeof parsed.report === 'string' ? parsed.report : '';
    const rawOpts = Array.isArray(parsed.options) ? parsed.options : [];
    const options = rawOpts
      .filter((o) => o && typeof o === 'object')
      .map((o) => ({
        label: typeof o.label === 'string' ? o.label : '',
        cmd: typeof o.cmd === 'string' ? o.cmd : '',
      }))
      .filter((o) => o.label && o.cmd);
    return { report, options };
  } catch {
    return empty;
  }
}

export class AICommander {
  constructor(opts = {}) {
    this.base = opts.base || OLLAMA_DEFAULT_BASE;
    this.model = opts.model || OLLAMA_DEFAULT_MODEL;
    this.intervalMs = opts.intervalMs || 6000; // decision cadence
    this.side = opts.side || 'enemy';          // 'enemy' (RED) or 'player' (BLUE)
    this.debug = opts.debug || false;          // when true, HUD shows live stream
    this.enabled = false;
    this.inFlight = false;
    this.lastCallTs = 0;
    this.callCount = 0;       // how many times transport was invoked
    this.lastRaw = '';        // raw assistant content of the last successful call
    this.lastReport = '';     // human-readable Chinese military report from the reply
    this.lastOrders = [];     // parsed orders of the last successful call
    this.lastBrief = '';      // short human-readable summary for the HUD
    this.lastError = null;    // last failure message (cleared on success)
    this._lastMessages = null; // last messages sent (for tests/debug)
    // --- streaming / live readout ---
    this.streaming = opts.streaming !== false; // default ON
    this.liveText = '';       // text streamed so far (building JSON) this cycle
    this.phase = 'idle';      // 'thinking' | 'streaming' | 'done' | 'error'
    // Injectable transports (for tests / custom backends).
    this.transport = opts.transport || ((messages, o) => ollamaChat(messages, o));
    this.streamTransport = opts.streamTransport || ((messages, o) => ollamaChatStream(messages, o));
    this._streamChunks = [];  // captured streaming deltas (tests/debug)
    // Natural-language HQ directive from the human player (set via the HQ
    // command chat). The BLUE commander translates this free-text strategic
    // intent into concrete ship orders each cycle. Null = no directive
    // (BLUE acts on its own tactical judgement).
    this.humanDirective = null;
  }

  setEnabled(on) {
    this.enabled = !!on;
    if (!this.enabled) { this.inFlight = false; this.phase = 'idle'; this.liveText = ''; }
  }

  // One-shot opening assessment: describe the situation and suggest candidate
  // orders. Unlike tick(), this does NOT apply any orders; it only returns
  // { report, options }. It bypasses the normal throttle and does not mutate
  // the commander's ongoing decision state (except for in-flight guarding).
  async requestOpeningAssessment(world, opts = {}) {
    if (this.inFlight) return { report: '', options: [] };
    this.inFlight = true;
    this.lastError = null;
    this.phase = 'thinking';
    const logPrefix = `[${this.cicLabel()} opening]`;
    try {
      const snapshot = buildSnapshot(world, this.side, {
        hqDirective: this.side === 'player' ? null : null,
      });
      const messages = [
        { role: 'system', content: BLUE_OPENING_PROMPT },
        { role: 'user', content: 'Battle opening snapshot:\n' + JSON.stringify(snapshot, null, 0) },
      ];
      this._lastMessages = messages;
      this.callCount++;
      const content = await this.transport(messages, {
        base: this.base,
        model: this.model,
        temperature: 0.2,
        num_ctx: 4096,
      });
      this.lastRaw = content || '';
      const result = extractOpeningAssessment(content);
      this.phase = 'done';
      return result;
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      this.phase = 'error';
      console.warn(`${logPrefix} failed:`, this.lastError);
      return { report: '', options: [] };
    } finally {
      this.inFlight = false;
    }
  }

  // Short status string for the HUD.
  statusText() {
    if (!this.enabled) return this.side === 'enemy' ? 'BUILTIN' : 'OFF';
    if (this.phase === 'thinking') return 'LLM ▸ think';
    if (this.phase === 'streaming') return 'LLM ▸ …';
    if (this.inFlight) return 'LLM ▸ …';
    if (this.lastError) return 'LLM! fb';
    return 'LLM';
  }

  cicLabel() {
    return this.side === 'enemy' ? 'RED CIC' : 'BLUE CIC';
  }

  // Live, human-facing text: the building JSON while streaming, the last brief
  // summary once the cycle is done. Optionally truncated to maxLen.
  livePreview(maxLen = 180) {
    const live = this.phase === 'thinking' || this.phase === 'streaming' ? this.liveText : '';
    const t = live || this.lastBrief || '';
    if (!t) return '';
    return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
  }

  // Drive one decision cycle. Self-throttles unless `opts.force` is set.
  // Fire-and-forget friendly: it returns a promise but callers in the render
  // loop don't need to await it. `opts.force` bypasses the throttle (for tests
  // and for an immediate first decision when the player enables LLM).
  async tick(world, opts = {}) {
    if (!this.enabled) return;
    if (this.inFlight) return;
    if (!opts.force && Date.now() - this.lastCallTs < this.intervalMs) return;

    this.inFlight = true;
    this.lastCallTs = Date.now();
    this.lastError = null;
    this.liveText = '';
    this.phase = 'thinking';
    this._streamChunks = [];
    const logPrefix = `[${this.cicLabel()}]`;
    try {
      const snapshot = buildSnapshot(world, this.side, {
        hqDirective: this.side === 'player' ? this.humanDirective : null,
      });
      const systemPrompt = this.side === 'enemy' ? RED_SYSTEM_PROMPT : BLUE_SYSTEM_PROMPT;
      const messages = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Current battle snapshot:\n' + JSON.stringify(snapshot, null, 0) },
      ];
      this._lastMessages = messages;
      this.callCount++;
      let content;
      if (this.streaming && this.streamTransport) {
        // Stream the reply; onToken updates liveText/phase in real time so the
        // HUD can show the commander "thinking -> ordering" as it happens.
        content = await this.streamTransport(messages, {
          base: this.base,
          model: this.model,
          temperature: 0.2,
          num_ctx: 4096,
          onToken: (delta, full) => {
            this._streamChunks.push(delta);
            this.liveText = full;
            this.phase = 'streaming';
            // Intentionally no console output: streaming tokens are shown
            // in the in-game LLM debug panel only when explicitly enabled.
          },
        });
      } else {
        content = await this.transport(messages, {
          base: this.base,
          model: this.model,
          temperature: 0.2,
          num_ctx: 4096,
        });
        this.liveText = content || '';
      }

      this.lastRaw = content || '';
      const { orders, report } = extractOrders(content);
      this.lastOrders = orders;
      this.lastReport = report;
      this.phase = 'done';
      if (!orders.length) {
        // Model returned nothing usable. Keep the force active with the
        // built-in doctrine for this commander's side rather than freezing.
        this._fallbackDoctrine(world);
        this.lastBrief = '(built-in: LLM returned no orders)';
      } else {
        this.applyOrders(world, orders);
        this.lastBrief = this.summarize(orders, world);
      }
    } catch (err) {
      this.lastError = err && err.message ? err.message : String(err);
      this.phase = 'error';
      // Keep the force acting with the built-in doctrine for this side.
      this._fallbackDoctrine(world);
      this.lastBrief = `(fallback: ${this.lastError})`;
      console.warn(`${logPrefix} LLM failed:`, this.lastError);
    } finally {
      this.inFlight = false;
    }
  }

  // Built-in deterministic doctrine for THIS commander's side (used when the LLM
  // returns nothing or errors), so neither fleet ever freezes.
  _fallbackDoctrine(world) {
    try {
      if (this.side === 'enemy') runBuiltinDoctrine(world);
      else runBuiltinPlayerDoctrine(world);
    } catch { /* nothing else we can do */ }
  }

  // Apply parsed orders to THIS commander's own ships. The ENEMY commander may
  // not open the war (an attack order while combatStarted === false is silently
  // downgraded to a hold). The PLAYER commander MAY open the war — a BLUE attack
  // order while cold sets world.combatStarted (mirroring a manual player attack
  // via world.issueOrder), so the LLM can genuinely direct the player fleet.
  applyOrders(world, orders) {
    if (!Array.isArray(orders)) return;
    const ownSide = this.side;
    const oppSide = this.side === 'enemy' ? 'player' : 'enemy';
    for (const o of orders) {
      if (!o) continue;
      // Accept either `ship` (preferred, disambiguated in the prompt) or the
      // legacy `id` field. The model sometimes nests the target as {id:N};
      // normalize that to a bare integer.
      const sidRaw = o.ship != null ? o.ship : o.id;
      const sid = Number(sidRaw);
      if (!Number.isFinite(sid)) continue;
      const s = world.ships.find((x) => x.id === sid && x.alive && x.side === ownSide);
      if (!s) continue;
      const act = o.act;

      if (act === 'attack') {
        if (!world.combatStarted) {
          if (ownSide === 'enemy') { s.order = null; s.targetId = null; continue; }
          // Player commander opens the war.
          world.combatStarted = true;
        }
        const tRaw = o.target;
        const tid = Number(tRaw && typeof tRaw === 'object' ? tRaw.id : tRaw);
        if (!Number.isFinite(tid)) continue;
        const t = world.ships.find((x) => x.id === tid && x.alive && x.side === oppSide);
        if (!t) continue;
        s.order = { kind: 'attack', targetId: t.id };
        s.targetId = t.id;
        if (s.isSub && typeof o.depth === 'number') s.targetDepth = o.depth;
      } else if (act === 'move') {
        if (!o.pos || typeof o.pos.x !== 'number' || typeof o.pos.y !== 'number') {
          s.order = null; s.targetId = null; continue;
        }
        s.targetId = null;
        s.order = { kind: 'moveTo', waypoints: [{ x: o.pos.x, y: o.pos.y, speed: s.maxSpeed }] };
        if (s.isSub && typeof o.depth === 'number') s.targetDepth = o.depth;
      } else {
        // hold (and any unknown act) — stop the ship, optionally set depth.
        s.order = null;
        s.targetId = null;
        if (s.isSub && typeof o.depth === 'number') s.targetDepth = o.depth;
      }
      if (s.order) s.order.source = 'llm';
    }
  }

  summarize(orders, world) {
    if (!Array.isArray(orders) || !orders.length) return 'holding position';
    let attacks = 0, moves = 0, holds = 0;
    for (const o of orders) {
      if (o.act === 'attack') attacks++;
      else if (o.act === 'move') moves++;
      else holds++;
    }
    const parts = [];
    if (attacks) parts.push(`${attacks} engaging`);
    if (moves) parts.push(`${moves} repositioning`);
    if (holds) parts.push(`${holds} holding`);
    const prefix = world.combatStarted ? '' : 'cold — ';
    return prefix + (parts.join(', ') || 'holding position');
  }
}
