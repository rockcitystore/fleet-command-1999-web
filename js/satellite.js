// ---------------------------------------------------------------------------
// satellite.js — optional real Mapbox satellite basemap + real elevation.
//
// This module pulls a REAL satellite image and REAL terrain elevation from
// Mapbox for the active theater and reprojects the Mercator satellite image
// into an equirectangular (world-aligned) canvas so it lines up with the
// game's vector coastline (which uses an equirectangular projection too).
//
// IMPORTANT — token safety:
//   The Mapbox access token is NEVER hard-coded in this repo. It is read from
//   the URL query string (?mapbox=PK....) so it never gets committed to a
//   public repository. Without a token the module returns null and the game
//   falls back to the offline procedural terrain.
//
//   If you run this yourself, pass your token in the URL, OR set a URL
//   restriction on the token in the Mapbox account to avoid abuse.
//
// OFFLINE PRE-CACHED TILES (preferred):
//   Run `tools/fetch_tiles.mjs` (with MAPBOX_TOKEN in the env) to download a
//   theater's satellite image + terrain-rgb tiles into assets/tiles/<key>/.
//   At runtime getTheaterData() loads those local files FIRST — no token and
//   no network needed, so the game launches instantly and works fully offline.
//   The ?mapbox= online path is only a live fallback when no local tiles exist.
// ---------------------------------------------------------------------------

const SAT_STYLE = 'mapbox/satellite-v9';
const WORLD_SIZE = 4000;
const DEFAULT_MPU = 92.6;

let _token = null;

export function configureMapbox(token) {
  _token = token || null;
}

// Read ?mapbox=PK... from the page URL (called once at boot).
export function readTokenFromURL() {
  try {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('mapbox');
    if (t) _token = t;
  } catch { /* no-op */ }
  return _token;
}

export function hasToken() {
  return !!_token;
}

// Stable directory key for a theater's pre-cached tiles under assets/tiles/.
// Format: "<lat 3dp>_<lon 3dp>" (e.g. "50.900_160.730").
export function tileKey(geo) {
  return `${geo.lat.toFixed(3)}_${geo.lon.toFixed(3)}`;
}

// --- projection helpers ----------------------------------------------------

// World (equirectangular, same convention as geo.js makeProjector) -> lat/lon.
function worldToLatLon(x, y, geo) {
  const cLat = geo.lat, cLon = geo.lon;
  const mpu = geo.metersPerUnit || DEFAULT_MPU;
  const mLat = 111000;
  const mLon = 111000 * Math.cos((cLat * Math.PI) / 180);
  const lat = cLat - ((y - WORLD_SIZE / 2) * mpu) / mLat;
  const lon = cLon + ((x - WORLD_SIZE / 2) * mpu) / mLon;
  return { lat, lon };
}

// Web-Mercator pixel coordinates at zoom z (matches Mapbox tile math).
function mercatorPixel(lon, lat, z) {
  const scale = 256 * Math.pow(2, z);
  const x = ((lon + 180) / 360) * scale;
  const s = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
  return { x, y };
}

// Pick a zoom so a 1280px image comfortably covers the visible world rect
// (the world 0..4000 maps to a small real-area box centered on geo).
function chooseZoom(lat) {
  const z = Math.floor(Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / 578));
  return Math.max(4, Math.min(8, z));
}
// Exported so the pre-fetch script picks the same zoom as the runtime.
export { chooseZoom };

// --- image loading ---------------------------------------------------------

function fetchImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // required so we can read pixels (reproject/elevation)
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image load failed'));
    img.src = url;
  });
}

// --- satellite image -------------------------------------------------------

async function fetchSatellite(geo) {
  if (!_token) return null;
  const z = chooseZoom(geo.lat);
  const size = 1280;
  const url =
    `https://api.mapbox.com/styles/v1/${SAT_STYLE}/static/${geo.lon},${geo.lat},${z}/${size}x${size}?access_token=${_token}`;
  try {
    return await fetchImage(url);
  } catch (e) {
    console.warn('[satellite] fetch failed:', e.message);
    return null;
  }
}

// Reproject the Mercator satellite image into an equirectangular, world-aligned
// canvas (outSize x outSize) so it matches the vector coastline.
function reproject(img, geo, outSize = 1280) {
  const src = document.createElement('canvas');
  src.width = img.width;
  src.height = img.height;
  const sctx = src.getContext('2d');
  sctx.drawImage(img, 0, 0);
  let srcData;
  try {
    srcData = sctx.getImageData(0, 0, src.width, src.height);
  } catch (e) {
    // Tainted canvas (CORS missing) — cannot reproject. Fall back to procedural.
    console.warn('[satellite] CORS tainted, cannot read pixels — falling back.', e.message);
    return null;
  }
  const sd = srcData.data;

  const z = chooseZoom(geo.lat);
  const cLon = geo.lon, cLat = geo.lat;
  const siny = Math.sin((cLat * Math.PI) / 180);
  const cx = ((cLon + 180) / 360) * 256 * Math.pow(2, z);
  const cy = (0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI)) * 256 * Math.pow(2, z);
  const iw = img.width, ih = img.height;

  const out = document.createElement('canvas');
  out.width = outSize;
  out.height = outSize;
  const octx = out.getContext('2d');
  const oImg = octx.createImageData(outSize, outSize);
  const od = oImg.data;

  for (let py = 0; py < outSize; py++) {
    const wy = (py / outSize) * WORLD_SIZE;
    for (let px = 0; px < outSize; px++) {
      const wx = (px / outSize) * WORLD_SIZE;
      const { lat, lon } = worldToLatLon(wx, wy, geo);
      const mp = mercatorPixel(lon, lat, z);
      const sx = Math.round(mp.x - cx + iw / 2);
      const sy = Math.round(mp.y - cy + ih / 2);
      const oi = (py * outSize + px) * 4;
      if (sx < 0 || sy < 0 || sx >= iw || sy >= ih) {
        od[oi] = 8; od[oi + 1] = 18; od[oi + 2] = 28; od[oi + 3] = 255;
        continue;
      }
      const si = (sy * iw + sx) * 4;
      od[oi] = sd[si]; od[oi + 1] = sd[si + 1]; od[oi + 2] = sd[si + 2]; od[oi + 3] = 255;
    }
  }
  octx.putImageData(oImg, 0, 0);
  return out;
}

// --- real elevation (terrain-rgb) -----------------------------------------

// Decode a Mapbox terrain-rgb PNG tile into metres.
function decodeElevationTile(img) {
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const ctx = c.getContext('2d');
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(0, 0, img.width, img.height).data;
  const n = img.width * img.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    out[i] = -10000 + (r * 256 * 256 + g * 256 + b) * 0.1;
  }
  return out;
}

// World-rect (world 0..4000) -> terrain-rgb tile range at the chosen zoom.
// Exported so the pre-fetch script downloads exactly the same tiles the
// runtime expects.
export function elevationTileRange(geo) {
  const z = chooseZoom(geo.lat);
  const corners = [
    worldToLatLon(0, 0, geo), worldToLatLon(WORLD_SIZE, 0, geo),
    worldToLatLon(0, WORLD_SIZE, geo), worldToLatLon(WORLD_SIZE, WORLD_SIZE, geo),
  ];
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (const c of corners) {
    const mp = mercatorPixel(c.lon, c.lat, z);
    minx = Math.min(minx, mp.x); maxx = Math.max(maxx, mp.x);
    miny = Math.min(miny, mp.y); maxy = Math.max(maxy, mp.y);
  }
  const tx0 = Math.floor(minx / 256), tx1 = Math.floor(maxx / 256);
  const ty0 = Math.floor(miny / 256), ty1 = Math.floor(maxy / 256);
  return { z, tx0, tx1, ty0, ty1 };
}

// Assemble a bilinear elevation sampler from decoded terrain-rgb tiles.
// `tileUrlFor(tx, ty)` returns the URL/path of each tile (Mapbox or local).
// Returns null if no tiles could be loaded.
async function assembleElevation(geo, z, tx0, tx1, ty0, ty1, tileUrlFor) {
  const cols = tx1 - tx0 + 1, rows = ty1 - ty0 + 1;
  const W = cols * 256, H = rows * 256;
  const grid = new Float32Array(W * H).fill(NaN);
  let loaded = 0;
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      try {
        const img = await fetchImage(tileUrlFor(tx, ty));
        const elev = decodeElevationTile(img);
        const gx0 = (tx - tx0) * 256, gy0 = (ty - ty0) * 256;
        for (let y = 0; y < 256; y++) {
          for (let x = 0; x < 256; x++) {
            grid[(gy0 + y) * W + (gx0 + x)] = elev[y * 256 + x];
          }
        }
        loaded++;
      } catch { /* skip missing tile */ }
    }
  }
  if (!loaded) return null;
  const bilinear = (gx, gy) => {
    const x0 = Math.floor(gx), y0 = Math.floor(gy);
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const tx = gx - x0, ty = gy - y0;
    const v00 = grid[y0 * W + x0], v10 = grid[y0 * W + x1];
    const v01 = grid[y1 * W + x0], v11 = grid[y1 * W + x1];
    const vals = [v00, v10, v01, v11].filter((v) => !isNaN(v));
    if (!vals.length) return 0;
    const a = v00 + (v10 - v00) * tx, b = v01 + (v11 - v01) * tx;
    const v = a + (b - a) * ty;
    return isNaN(v) ? 0 : v;
  };
  return {
    sample(worldX, worldY) {
      const { lat, lon } = worldToLatLon(worldX, worldY, geo);
      const mp = mercatorPixel(lon, lat, z);
      const gx = mp.x - tx0 * 256, gy = mp.y - ty0 * 256;
      return bilinear(gx, gy);
    },
  };
}

// Online elevation fetch from Mapbox (requires a token).
async function fetchElevation(geo) {
  if (!_token) return null;
  const { z, tx0, tx1, ty0, ty1 } = elevationTileRange(geo);
  if ((tx1 - tx0 + 1) * (ty1 - ty0 + 1) > 64) return null; // too many tiles
  return assembleElevation(geo, z, tx0, tx1, ty0, ty1,
    (tx, ty) => `https://api.mapbox.com/v4/mapbox.terrain-rgb/${z}/${tx}/${ty}.pngraw?access_token=${_token}`);
}

// --- public API -------------------------------------------------------------

let _cache = { key: null, promise: null };

// Load a theater from pre-cached local tiles under assets/tiles/<key>/.
// Returns { satellite, elevation } or null if no manifest/tiles are present.
// This is the OFFLINE path: no Mapbox token is required at runtime.
async function tryLoadLocal(geo) {
  const key = tileKey(geo);
  const base = `assets/tiles/${key}`;
  let manifest;
  try {
    const r = await fetch(`${base}/manifest.json`, { cache: 'no-store' });
    if (!r.ok) return null;
    manifest = await r.json();
  } catch { return null; }

  let satImg = null;
  if (manifest.hasSatellite) {
    try { satImg = await fetchImage(`${base}/satellite.png`); } catch { /* no satellite */ }
  }
  let elevation = null;
  if (manifest.elev) {
    const { z, tx0, tx1, ty0, ty1 } = manifest.elev;
    try {
      elevation = await assembleElevation(geo, z, tx0, tx1, ty0, ty1,
        (tx, ty) => `${base}/elev/${z}/${tx}/${ty}.png`);
    } catch { /* no elevation */ }
  }
  if (!satImg && !elevation) return null;
  const satellite = satImg ? reproject(satImg, geo) : null;
  return { satellite, elevation };
}

// Returns { satellite: canvas|null, elevation: field|null }.
// Priority: (1) pre-cached local tiles (offline, no token), (2) Mapbox online
// if a token is present, (3) null -> procedural terrain fallback.
export async function getTheaterData(geo) {
  if (!geo) return null;
  const key = `${geo.lat.toFixed(3)},${geo.lon.toFixed(3)}`;
  if (_cache.key === key && _cache.promise) return _cache.promise;
  const promise = (async () => {
    const local = await tryLoadLocal(geo);
    if (local) return local;
    if (_token) {
      const [satImg, elevation] = await Promise.all([fetchSatellite(geo), fetchElevation(geo)]);
      const satellite = satImg ? reproject(satImg, geo) : null;
      return { satellite, elevation };
    }
    return null;
  })();
  _cache = { key, promise };
  return promise;
}

export function clearCache() { _cache = { key: null, promise: null }; }
