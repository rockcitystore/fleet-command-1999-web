// ---------------------------------------------------------------------------
// fetch_tiles.mjs — pre-cache a theater's Mapbox satellite + terrain-rgb tiles
// into assets/tiles/<key>/ so the game can run fully offline (no token, no
// network at runtime).
//
// Usage:
//   MAPBOX_TOKEN=pk.xxxx node tools/fetch_tiles.mjs            # default theater
//   MAPBOX_TOKEN=pk.xxxx node tools/fetch_tiles.mjs --all      # every scenario
//   MAPBOX_TOKEN=pk.xxxx node tools/fetch_tiles.mjs 50.9,160.73 # explicit lat,lon
//
// The token is read from the MAPBOX_TOKEN env var ONLY (never written to disk,
// never committed). The downloaded PNGs + manifest.json are committed so other
// players get offline maps for free.
// ---------------------------------------------------------------------------

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { tileKey, chooseZoom, elevationTileRange } from '../js/satellite.js';
import { SCENARIO_GEO } from '../js/geo.js';

const TOKEN = process.env.MAPBOX_TOKEN;
if (!TOKEN) {
  console.error('ERROR: set MAPBOX_TOKEN env var (your Mapbox public token).');
  process.exit(1);
}

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // repo root
const SAT_SIZE = 1280;

async function loadMissionTargets() {
  try {
    const raw = await readFile(`${ROOT}assets/data/missions.json`, 'utf8');
    const payload = JSON.parse(raw);
    const missions = (payload.missions || []).filter((m) => m.lat != null && m.lon != null);
    const byKey = new Map();
    for (const m of missions) {
      const key = tileKey({ lat: m.lat, lon: m.lon });
      if (!byKey.has(key)) {
        byKey.set(key, { name: m.title || m.id, lat: m.lat, lon: m.lon });
      }
    }
    return Array.from(byKey.values());
  } catch (e) {
    console.warn('Could not read missions.json:', e.message);
    return [];
  }
}

async function resolveTargets() {
  const args = process.argv.slice(2);
  if (args.includes('--all')) {
    const missions = await loadMissionTargets();
    const geo = Object.entries(SCENARIO_GEO).map(([name, g]) => ({ name, lat: g.lat, lon: g.lon }));
    // Merge, deduplicating by tile key (missions take precedence).
    const byKey = new Map();
    for (const t of [...geo, ...missions]) byKey.set(tileKey({ lat: t.lat, lon: t.lon }), t);
    return Array.from(byKey.values());
  }
  const explicit = args
    .filter((a) => a.includes(','))
    .map((a) => {
      const [la, lo] = a.split(',').map(Number);
      return { name: `${la},${lo}`, lat: la, lon: lo };
    });
  // Default "our mission" = the Wyoming Deploys / North Pacific theater.
  const def = SCENARIO_GEO['Wyoming Deploys'];
  return [{ name: 'Wyoming Deploys (default)', lat: def.lat, lon: def.lon }, ...explicit];
}

async function fetchTheater(lat, lon, name) {
  const key = tileKey({ lat, lon });
  const dir = `${ROOT}assets/tiles/${key}`;
  await mkdir(`${dir}/elev`, { recursive: true });

  const z = chooseZoom(lat);

  // --- satellite (Static Images API) ---
  const satUrl =
    `https://api.mapbox.com/styles/v1/mapbox/satellite-v9/static/${lon},${lat},${z}/${SAT_SIZE}x${SAT_SIZE}?access_token=${TOKEN}`;
  let hasSatellite = false;
  try {
    const r = await fetch(satUrl);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    await writeFile(`${dir}/satellite.png`, buf);
    hasSatellite = true;
    console.log(`  satellite  z=${z}  ${(buf.length / 1024).toFixed(0)} KB`);
  } catch (e) {
    console.warn(`  satellite FAILED for ${name}: ${e.message}`);
  }

  // --- elevation (terrain-rgb tiles) ---
  const { tx0, tx1, ty0, ty1 } = elevationTileRange({ lat, lon });
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  let elev = null;
  if (cols * rows > 64) {
    console.warn(`  elevation SKIPPED for ${name}: ${cols}x${rows} tiles (>64)`);
  } else {
    let n = 0, bytes = 0;
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${tx}/${ty}.pngraw?access_token=${TOKEN}`;
        try {
          const r = await fetch(url);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          const buf = Buffer.from(await r.arrayBuffer());
          await mkdir(`${dir}/elev/${z}/${tx}`, { recursive: true });
          await writeFile(`${dir}/elev/${z}/${tx}/${ty}.png`, buf);
          n++; bytes += buf.length;
        } catch (e) {
          console.warn(`  tile ${z}/${tx}/${ty} FAILED: ${e.message}`);
        }
      }
    }
    if (n) {
      elev = { z, tx0, tx1, ty0, ty1 };
      console.log(`  elevation  ${n} tiles  ${(bytes / 1024).toFixed(0)} KB`);
    }
  }

  // --- manifest (runtime uses this to know what local files exist) ---
  const manifest = { lat, lon, zoom: z, hasSatellite, elev };
  await writeFile(`${dir}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`cached "${name}" -> assets/tiles/${key}/\n`);
}

async function main() {
  const targets = await resolveTargets();
  console.log(`Pre-caching ${targets.length} theater(s)...\n`);
  for (const t of targets) {
    console.log(`[${t.name}]  (${t.lat}, ${t.lon})`);
    await fetchTheater(t.lat, t.lon, t.name);
  }
  console.log('Done.');
}

main().catch((e) => { console.error(e); process.exit(1); });
