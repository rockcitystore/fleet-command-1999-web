# Fleet Command '99 — Web Port CONTRACT

This contract is the single source of truth for ALL JS modules in `code/web/`.
Every subagent MUST conform to it. Do NOT redefine types or change exported
signatures. Modules are browser ES modules AND node-importable (project has
`package.json` with `"type":"module"`). Use `export`/`import`.

## File layout
```
code/web/
  index.html
  styles.css
  package.json            # { "type": "module" }
  js/
    engine.js             # game model + simulation + coords (NO DOM)
    render.js             # Canvas drawing (imports engine.js)
    input.js              # pointer/touch interaction (imports engine.js)
    ui.js                 # menu / scenario select / HUD DOM (imports engine.js)
    main.js               # integration glue + rAF loop (written by lead)
    engine.test.mjs       # node tests for engine.js
```

## 1. engine.js  (CONTRACT — must match exactly)

### Constants
- `export const WORLD_SIZE = 4000;`
- `export const MIN_ZOOM = 0.5;`
- `export const MAX_ZOOM = 8.0;`

### Vec2
- `export class Vec2 { constructor(x, y){...} }` with `.x`, `.y`.
- `export function distance(a, b)` → Euclidean distance between two `{x,y}`-like.
- `vec2(x,y)` factory helper optional.

### Enums (use plain strings)
- `Side`: `'player'` | `'enemy'`
- `ShipClass`: `'destroyer' | 'frigate' | 'cruiser' | 'battleship' | 'carrier' | 'submarine'`
- `WeaponType`: `'gun' | 'torpedo' | 'missile' | 'asroc' | 'depthCharge'`

### SHIP_STATS
- `export const SHIP_STATS = { destroyer: {...}, frigate: {...}, cruiser: {...}, battleship: {...}, carrier: {...}, submarine: {...} }`
- Each entry: `{ label, maxHp, maxSpeed, radius, sensorRange, isSub, defaultDepth, weapons:[{type,range,damage,cooldown,minDepth,maxDepth}] }`
- Exact values (world units):
  - destroyer: label 'DD', maxHp 60, maxSpeed 180, radius 14, sensorRange 900, isSub false, defaultDepth 0; weapons: gun(320,7,1.0,0,0), torpedo(280,45,6,-400,0), asroc(650,30,8,-500,0), depthCharge(70,22,3,-250,0)
  - frigate: 'FFG', 45, 170, 13, 1000, false, 0; gun(280,5,1.2,0,0), asroc(700,34,7,-500,0), depthCharge(80,26,2.5,-250,0)
  - cruiser: 'CG', 110, 160, 17, 1100, false, 0; gun(420,12,0.9,0,0), missile(900,28,5,0,0), torpedo(300,40,7,-400,0)
  - battleship: 'BB', 220, 110, 22, 1000, false, 0; gun(560,26,1.4,0,0), missile(1000,40,6,0,0)
  - carrier: 'CV', 260, 90, 26, 1400, false, 0; gun(240,4,1.5,0,0), missile(1100,22,5,0,0)
  - submarine: 'SSN', 80, 140, 12, 700, true, -120; torpedo(360,60,5,-500,0)

### Order (discriminated objects, NOT Swift enum)
- `{ kind: 'moveTo', pos: Vec2 }`
- `{ kind: 'attack', targetId: number }`
- `{ kind: 'setDepth', depth: number }`

### Ship (plain object created by World.addShip)
`{ id, side, shipClass, pos:{x,y}, heading, speed, maxSpeed, hp, maxHp, depth, targetDepth, sensorRange, detected, weapons:[...], cooldowns:{}, targetId:null, order:null, alive:true }`

### Camera
- `export function makeCamera()` → `{ zoom:1.0, center:{x:WORLD_SIZE/2, y:WORLD_SIZE/2} }`
- `zoom` multiplier (1.0 = whole world fits, centered). `center` world point at screen center.

### class World
State fields: `ships[]`, `time`, `phase` ('playing'|'playerWon'|'enemyWon'), `nextId`, `scenarioName`, `seed`, `camera`, `paused` (bool), `speed` (number).
Methods (port behavior EXACTLY from Types.swift):
- `rand()` xorshift64 → [0,1)
- `resetSeed(s)`
- `ship(id)` → alive ship with id or undefined
- `addShip(side, shipClass, pos, depth?)` → pushes Ship, returns it; uses SHIP_STATS; depth defaults to stat.defaultDepth
- `issueOrder(order, ids[])` → sets `.order`; for attack sets `.targetId`; for setDepth sets `.targetDepth`
- `aliveShips(side)` → array
- `togglePause()`, `setSpeed(s)` (clamp 0.25..8), `cycleSpeed()` (1→2→4→1), `zoomBy(f)` (clamp MIN..MAX), `resetCamera()`
- `advanceRealtime()` → uses `Date.now()` delta (clamp rawDt 0..0.05, default 1/60 if no last); if paused return; dt = rawDt*speed; time+=dt; then `updateMovement(this,dt); updateDetection(this); updateWeapons(this,dt); updateAI(this,dt); checkEnd(this)`. Store `lastTick` (ms number) instead of Date.

### Pure simulation functions (exported, take (world, dt))
- `updateMovement(world, dt)`
- `updateDetection(world)`
- `updateWeapons(world, dt)`
- `nearestEnemy(ship, world)` → Ship|undefined
- `updateAI(world, dt)`
- `checkEnd(world)`

Port the exact math from BattleSim.swift:
- movement: goal from order; attack standoff = maxWeaponRange*0.85; depth approach rate 30/s dive, 20/s surface; speed accel 1.5*max, decel 2*max; arrival when moveTo dist<8; clamp to [radius, WORLD_SIZE-radius]; separation pass (mutate pos, push apart 0.5*overlap).
- detection: ship detected if any alive opposite-side ship within `opp.sensorRange * (depth<0 ? max(0.3, 1+depth/300) : 1)`.
- weapons: decrement cooldowns by dt; if cd<=0 and target in range and target depth within [minDepth-5, maxDepth+5]: accuracy = max(0.3, 1 - (d/range)*0.6); if rand()<=accuracy apply dmg = damage*(0.8+0.4*rand()); set alive=false if hp<=0. Reset cd=cooldown each weapon each tick.
- AI: enemy ships acquire nearest player target if none valid; subs with no target setDepth(-160).
- checkEnd: if no player alive → enemyWon; else if no enemy alive → playerWon.

### Coordinate / hit-testing (exported)
- `worldToScreen(p, size, cam)` → `{x,y}` screen point. `size` = `{width,height}` (canvas CSS px). Formula: base = min(w,h)/WORLD_SIZE; scale = base*cam.zoom; cx = w/2 - cam.center.x*scale; cy = h/2 - cam.center.y*scale; return {x: cx + p.x*scale, y: cy + p.y*scale}.
- `screenToWorld(p, size, cam)` → inverse: {x:(p.x-cx)/scale, y:(p.y-cy)/scale}.
- `panCamera(cam, delta, size)` → mutate cam.center by -delta/scale, clamp center to [0, WORLD_SIZE].
- `zoomCamera(cam, factor, point, size)` → keep world point under `point` fixed (same math as Swift).
- `shipAtScreen(point, size, cam, world)` → nearest alive ship whose screen distance <= max(worldRadius*scale, 16). Returns Ship|undefined.
- `playerShipsInRect(rect, size, cam, world)` → rect `{x,y,w,h}` (screen px); returns array of player ship ids inside.

### Scenarios
- `export const SCENARIOS = [ {name, brief}, ... ]` (3 scenarios, copy text from Scenarios.swift).
- `export function makeWorld(index)` → World with ships placed per Scenarios.swift (player left ~x700-1000, enemy right ~x3100-3400). Clamp index 0..2.

## 2. render.js  (imports engine.js)
- `export function drawBattle(ctx, world, size)` — `ctx` is CanvasRenderingContext2D of the main map canvas; `size` = {width,height} in CSS px (match canvas client size; caller handles devicePixelRatio scaling). Draw order:
  1. Clear with deep-navy ocean background (#04121f or similar).
  2. Draw faint grid lines every 500 world units (transform via worldToScreen).
  3. Draw world border rectangle.
  4. For each alive ship: compute screen pos via worldToScreen. **Player ships: always visible, cyan (#39d0ff). Enemy ships: only drawn if `ship.detected` is true (fog of war); color red (#ff5b5b). Undetected enemies: skip.** Draw ship as a small triangle/chevron rotated to heading, with a minimum on-screen size (radius = max(worldRadius*scale, 6) px). Draw a selection ring (yellow #ffd84d) around ships whose id ∈ `world.__selected` (lead will set `world.__selected` as an array of ids, default []). Draw a small health bar above each visible ship.
  5. Draw selection box if `world.__selectRect` is set ({x,y,w,h} screen px) — dashed yellow.
- `export function drawMinimap(ctx, world, size)` — minimap canvas (≈140x140). Scale WORLD_SIZE→size. Draw player ships cyan 4px, detected enemies red 4px, undetected skipped. Background semi-transparent panel.
- Use `world.camera` for transforms. Import `worldToScreen`, `WORLD_SIZE`, `SHIP_STATS`, `MIN_ZOOM`, etc. from engine.js.

## 3. input.js  (imports engine.js)
- `export function attachInput(canvas, world, handlers)` — `canvas` is the main map `<canvas>`; `world` the World; `handlers` = `{ onSelectionChange(ids), onMoveOrder(worldPos, ids), onAttackOrder(targetShip, ids) }`.
- Maintain internal state: selected ids (array), drag start, gestureMode ('pan'|'box'|'maybeTap').
- Pointer events (use Pointer Events API for unified mouse/touch; support multi-touch via `canvas.getPointerCapture` and tracking active pointers):
  - **Wheel**: zoom toward cursor via `zoomCamera(world.camera, factor, point, size)` (factor = deltaY<0 ? 1.1 : 1/1.1).
  - **Single pointer drag on empty sea** → pan: `panCamera(world.camera, delta, size)` where delta is incremental screen movement. Also detect box-select: if drag started on empty area AND moved > ~8px, draw selection rect (`world.__selectRect`) and on release call `playerShipsInRect` → `handlers.onSelectionChange(ids)`.
  - **Single pointer drag starting on a player ship** → treat as pan too (do NOT box-select), OR if negligible movement → tap select that ship/group. Keep simple: tapping a player ship selects it (onSelectionChange([id])); tapping empty sea with negligible movement clears selection.
  - **Tap on enemy ship (detected)** with a non-empty selection → `handlers.onAttackOrder(enemyShip, selectedIds)`.
  - **Tap on empty sea** with a non-empty selection → `handlers.onMoveOrder(worldPos, selectedIds)`.
  - **Two pointers** → pinch zoom: compute distance ratio between pointer moves, call `zoomCamera` about midpoint.
- All hit-testing uses `shipAtScreen(screenPoint, size, world.camera, world)` from engine.js (16px tolerance).
- `size` = `{width: canvas.clientWidth, height: canvas.clientHeight}`.
- Do NOT mutate ship orders directly; only call handlers. Lead wires handlers to `world.issueOrder`.
- Return a `detach()` function (optional).

## 4. ui.js  (imports engine.js)
- `export function buildMenu(rootEl, { onStart })` — renders title + a list of scenarios from `SCENARIOS`; clicking a scenario calls `onStart(index)`.
- `export function buildBattleHUD(rootEl, world, handlers)` — builds the top status bar (player/enemy counts, scenario name, time, pause/speed text) and the control bar with buttons: Pause/Resume, 1x/2x/4x speed, Zoom − / Zoom +, RESET VIEW. Buttons call `world.togglePause()`, `world.setSpeed(1|2|4)`, `world.zoomBy(0.8|1.25)`, `world.resetCamera()`, then `handlers.onControlChange()` so lead can refresh HUD text.
- `export function updateHUD(world)` — refresh the dynamic text (counts/time/pause/speed) each frame; lead calls this in the loop.
- Keep DOM ids stable so lead can query them.

## 5. index.html + styles.css
- Two screens: `#screen-menu` and `#screen-battle` (toggle visibility via a class).
- `#screen-battle` contains: `<canvas id="map">`, `<canvas id="minimap">`, `<div id="topbar">`, `<div id="controlbar">`.
- CIC aesthetic: dark navy background (#06121f), monospace font (e.g. `'SFMono-Regular', Consolas, monospace`), cyan accents (#39d0ff), red enemy (#ff5b5b), yellow highlight (#ffd84d). Panels with subtle border + slight transparency, rounded 6px.
- Map canvas should fill available space; minimap fixed top-right ~140x140; control bar fixed bottom; top bar fixed top.
- MUST include `<script type="module" src="js/main.js"></script>` at end of body.

## Coordinate note for lead (main.js)
- Handle devicePixelRatio: set `canvas.width = clientWidth*dpr; canvas.height = clientHeight*dpr; ctx.scale(dpr,dpr)` once per resize; pass CSS-px `size` to drawBattle/render funcs.
- Main loop: `requestAnimationFrame` → `world.advanceRealtime()` → `drawBattle(ctx, world, size)` → `drawMinimap(...)` → `updateHUD(world)`. Rendering loop is SEPARATE from simulation; simulation advances inside rAF (real-time). No mutation inside draw.
- Wire input handlers: onMoveOrder(pos,ids) → `world.issueOrder({kind:'moveTo',pos}, ids)`; onAttackOrder(target,ids) → `world.issueOrder({kind:'attack',targetId:target.id}, ids)`; onSelectionChange(ids) → `world.__selected = ids`.
- selection rect lives on `world.__selectRect` (set/unset by input.js); render reads it.

## Determinism / testing
- engine.js must run under node (`node js/engine.test.mjs`). Tests cover:
  - worldToScreen/screenToWorld round-trip.
  - shipAtScreen returns a ship when clicking within 16px of its screen pos, and undefined far away.
  - makeWorld(0/1/2) produces expected ship counts & sides.
  - Running advanceRealtime() N times with fixed seed reduces enemy hp when in range / produces deterministic results.
