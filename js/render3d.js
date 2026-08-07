// render3d.js — real 3D (WebGL) battle view for Fleet Command '99.
//
// Replaces the flat 2D tactical map with a rotatable / pitchable perspective
// scene rendered by three.js (vendored locally at ./vendor/three.module.js,
// so the page stays zero-build and fully offline). The 2D engine in engine.js
// is untouched — this module only *reads* world state and draws it in 3D.
//
// Coordinate mapping: world (x, y)  ->  scene (x, 0, z), i.e. scene Z == world Y
// (so "north"/increasing world-Y points away from a default camera). Y is up.
//
// The module is deliberately defensive: if WebGL is unavailable the constructor
// throws and main.js falls back to the 2D renderer, so nothing else regresses.

import * as THREE from './vendor/three.module.js';
import { getLand } from './terrain.js';
import { ModelLibrary } from './modellib.js';
import { shipModelKey, aircraftModelKey } from './modelmap.js';

const PLAYER_COLOR = 0x4f8fce;
const ENEMY_COLOR = 0xc85a3c;
const NEUTRAL_COLOR = 0xb9b26a; // merchants / civil traffic: khaki, never a target
const SUB_COLOR = 0x35617f;
const HILITE = 0x39d0ff;

// BLUE / RED / NEUTRAL hull tint. The original scenarios are full of neutral
// shipping (alliance 8) that must be visually distinct so the player doesn't
// shoot it.
function sideColor(u) {
  if (u.side === 'neutral') return NEUTRAL_COLOR;
  return u.side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
}

// Real-world-ish visual length in world units. The gameplay collision radius is
// NOT a proxy for hull size — a frigate's selection bubble is ~1 km across,
// while the actual hull is ~130 m. We scale meshes by approximate real length
// so the 3D view reads at the correct geographic scale, with a small exaggeration
// so units stay identifiable without looking like giants.
function shipVisualLength(ship) {
  const name = (ship.name || '').toUpperCase();
  const cls = (ship.shipClass || '').toLowerCase();
  const hull = (ship.hull || '').toUpperCase();
  const code = hull || name;
  // 1 world unit ≈ 92.6 m (METERS_PER_UNIT). Readability exaggeration 1.4x.
  const toU = (m) => (m / 92.6) * 1.4;
  if (/CVN|CV\b/.test(code)) return toU(330);
  if (/LHD|LHA/.test(code)) return toU(260);
  if (/CGN|CG\b/.test(code)) return toU(185);
  if (/DDG|DD\b/.test(code)) return toU(160);
  if (/FFG|FF\b/.test(code)) return toU(135);
  if (/SSBN/.test(code)) return toU(175);
  if (/SSGN|SSN|SSK|SUB/.test(code) || cls === 'submarine') return toU(115);
  if (/MERCHANT|TANKER|TRAWLER|FERRY|CARGO/.test(name)) return toU(200);
  if (/AIRPORT|BASE|INSTALLATION/.test(name) || cls === 'installation') return toU(120);
  if (cls === 'carrier') return toU(330);
  if (cls === 'cruiser') return toU(185);
  if (cls === 'destroyer') return toU(160);
  if (cls === 'frigate') return toU(135);
  if (cls === 'submarine') return toU(115);
  return toU(150);
}

function aircraftVisualLength(ac) {
  const t = (ac.type || ac.name || '').toLowerCase();
  const cat = (ac.category || '').toLowerCase();
  // Aircraft are tiny next to ships; exaggerate a bit more so they remain
  // visible at strategic zoom without turning into giants.
  const toU = (m) => (m / 92.6) * 2.0;
  if (cat === 'helo' || /sh-60|hh-60|uh-60|seahawk|lynx|cobra|ah-1|helo|helicopter/.test(t)) return toU(20);
  if (/f-14|f14|tomcat/.test(t)) return toU(20);
  if (/f-18|fa-18|f18|hornet/.test(t)) return toU(18);
  if (/f-16|f16|f-15|f15/.test(t)) return toU(16);
  if (/e-2|e2|hawkeye/.test(t)) return toU(18);
  if (/e-3|e3|sentry/.test(t)) return toU(30);
  if (/p-3|p3|orion/.test(t)) return toU(36);
  if (/s-3|s3|viking/.test(t)) return toU(17);
  if (/mig|su-|tu-|bear/.test(t)) return toU(22);
  return toU(18);
}

// ---------------------------------------------------------------------------
export class Scene3D {
  constructor(canvas, world) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
      failIfMajorPerformanceCaveat: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    this.scene = new THREE.Scene();
    // Sky-coloured fallback; in the surface view a gradient sky dome covers it,
    // in SUB VIEW setUnderwater() swaps it for the dark deep-blue background.
    this.scene.background = new THREE.Color(0x9fc4e8);
    // Fog colour matches the sky-dome horizon haze so distant ships and the sea
    // surface dissolve into the horizon — that seam is what reads as "waterline".
    this.scene.fog = new THREE.Fog(0xcfe4f0, 3800, 17000);

    this.camera = new THREE.PerspectiveCamera(55, 1, 1, 60000);

    const hemi = new THREE.HemisphereLight(0x9fc4e8, 0x16242e, 1.05);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 0.85);
    sun.position.set(1200, 2400, 800);
    this.scene.add(sun);

    // Portable fill light used only in SUB VIEW to illuminate submarines from
    // the camera side (the sun/hemi are above water and do little from below).
    this._subLight = new THREE.PointLight(0x8fd6ff, 2.2, 2200, 0.9);
    this._subLight.visible = false;
    this.scene.add(this._subLight);

    // Camera controller state (spherical around `target`).
    this.target = new THREE.Vector3(2000, 0, 2000); // world centre
    this.azimuth = 0;          // 0 => camera behind target, looking toward -Z (north away)
    this.elevation = 0.62;     // radians above the horizon
    this.distance = 1300;

    this.shipGroup = new THREE.Group();
    this.acGroup = new THREE.Group();
    this.projGroup = new THREE.Group();
    this.scene.add(this.shipGroup, this.acGroup, this.projGroup);

    // When true, the camera dives below the surface and the sea becomes
    // translucent so submarines (drawn at their real negative depth) are
    // clearly visible — a "sub-surface" view the original FC99 never had.
    this.underwater = false;

    this.shipMeshes = new Map(); // id -> Group
    this.acMeshes = new Map();   // id -> Group
    this.projPool = [];          // reused projectile meshes
    this.projTrailPool = [];     // reused projectile-trail lines (parallel to projPool)

    // --- polish state ---
    this.wakeGroup = new THREE.Group();   // ship wake trails
    this.fxGroup = new THREE.Group();     // transient explosions / flashes
    this.scene.add(this.wakeGroup, this.fxGroup);
    this._wakeTrails = new Map();  // shipId -> { pts:[{x,z}], line }
    this._effects = [];            // active explosion / flash effects
    this._prevAlive = new Map();   // shipId -> last-known alive flag (death detection)
    this._envKey = null;           // de-dupe environment application
    this._lastT = 0;               // last render timestamp (effect dt)

    this._modelLib = new ModelLibrary(); // authentic .j3d models (lazy)
    this._geoCache = new Map();  // ship-class key -> shared geometries
    this._buildStatic(world);
    this._buildSky();
    this._buildDeep();

    this.raycaster = new THREE.Raycaster();
    this._ndc = new THREE.Vector2();
    this._seaPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

    const w = canvas.clientWidth || window.innerWidth || 900;
    const h = canvas.clientHeight || window.innerHeight || 640;
    this.resize(w, h);
  }

  // --- static world geometry: water, grid, coastline ---
  _buildStatic(world) {
    const water = new THREE.Mesh(
      new THREE.PlaneGeometry(60000, 60000),
      this._makeWaterMaterial()
    );
    water.rotation.x = -Math.PI / 2;
    water.position.y = 0;
    water.renderOrder = 1;
    this.water = water;
    this.surfaceWaterColor = 0x3d8ca8;
    this.scene.add(water);

    const grid = new THREE.GridHelper(8000, 32, 0x1d4a66, 0x0e2f44);
    grid.position.y = 0.5;
    grid.material.transparent = true;
    grid.material.opacity = 0.35;
    this.scene.add(grid);

    // Land polygons (world.land is an array of point-arrays [[{x,y}...]]).
    let polys = [];
    try { polys = getLand() || []; } catch (_) { polys = (world && world.land) || []; }
    const landMat = new THREE.MeshLambertMaterial({ color: 0x1f5a32, side: THREE.DoubleSide });
    const coastMat = new THREE.LineBasicMaterial({ color: 0x49a06a, transparent: true, opacity: 0.9 });
    for (const poly of polys) {
      const pts = Array.isArray(poly) ? poly : (poly && poly.pts) || [];
      if (!pts || pts.length < 3) continue;
      const shape = new THREE.Shape();
      shape.moveTo(pts[0].x, -pts[0].y);
      for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, -pts[i].y);
      shape.closePath();
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(-Math.PI / 2); // lay flat: shape (x, -y) -> scene (x, 0, y)
      const land = new THREE.Mesh(geo, landMat);
      land.position.y = 0.2;
      this.scene.add(land);

      // coastline outline
      const ringPts = pts.map((p) => new THREE.Vector3(p.x, 0.6, p.y));
      ringPts.push(ringPts[0].clone());
      const lgeo = new THREE.BufferGeometry().setFromPoints(ringPts);
      this.scene.add(new THREE.Line(lgeo, coastMat));
    }
  }

  // --- sky dome + sun: the "sky" half of the sky/water distinction ---
  //
  // A large inverted sphere follows the camera (set in _updateCamera) and is
  // shaded with a vertical gradient: deep blue overhead -> pale haze at the
  // horizon. Its bottom hemisphere sits below the sea plane and is hidden by
  // the water, so the visible seam between the pale horizon sky and the fogged
  // sea surface becomes the waterline — exactly the look the original FC99 3D
  // view had. A distant sun disc + halo gives an unmistakable "sky" focal cue.
  // (No fog on the dome/sun, so the gradient stays crisp; scene.fog is tuned to
  // the same horizon haze so everything else blends into that line.)
  _buildSky() {
    const geo = new THREE.SphereGeometry(30000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x5c9fd8) },
        horizonColor: { value: new THREE.Color(0xcfe4f0) },
        bottomColor: { value: new THREE.Color(0x1c5270) },
        topPow: { value: 0.75 },
        botPow: { value: 0.55 },
      },
      vertexShader: `
        varying vec3 vLocal;
        void main() {
          vLocal = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 horizonColor;
        uniform vec3 bottomColor;
        uniform float topPow;
        uniform float botPow;
        varying vec3 vLocal;
        void main() {
          float h = normalize(vLocal).y; // -1 (down) .. 1 (up)
          vec3 col;
          if (h > 0.0) {
            col = mix(horizonColor, topColor, pow(clamp(h, 0.0, 1.0), topPow));
          } else {
            col = mix(horizonColor, bottomColor, pow(clamp(-h, 0.0, 1.0), botPow));
          }
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const sky = new THREE.Mesh(geo, mat);
    sky.frustumCulled = false;
    this.sky = sky;
    this.scene.add(sky);

    // Distant sun, fixed in world space, in the same direction as the key light.
    const sunDir = new THREE.Vector3(1200, 2400, 800).normalize();
    const sunPos = sunDir.clone().multiplyScalar(26000);
    const sunCore = new THREE.Mesh(
      new THREE.SphereGeometry(700, 16, 16),
      new THREE.MeshBasicMaterial({ color: 0xfff3d0, fog: false })
    );
    sunCore.position.copy(sunPos);
    sunCore.frustumCulled = false;
    this.sun = sunCore;
    this.scene.add(sunCore);

    const halo = new THREE.Mesh(
      new THREE.SphereGeometry(1700, 16, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b0, transparent: true, opacity: 0.22,
        fog: false, blending: THREE.AdditiveBlending, depthWrite: false,
      })
    );
    halo.position.copy(sunPos);
    halo.frustumCulled = false;
    this.sunHalo = halo;
    this.scene.add(halo);
  }

  // --- sea-surface material (shared by surface + SUB VIEW) ---
  //
  // Animated ripple + a brighter hazy horizon + a sharp sun glitter in the
  // surface view so the water clearly reads as "sea" (not flat colour). In SUB
  // VIEW (uUnderwater=1) the very same plane becomes the bright, rippling
  // underside of the sea surface seen from below — the visual cue that you are
  // looking UP through the water. Fog is done manually (uFog*) so the look is
  // identical under SwiftShader and a real GPU.
  _makeWaterMaterial() {
    const sunDir = new THREE.Vector3(1200, 2400, 800).normalize();
    return new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      transparent: false,
      depthWrite: true,
      uniforms: {
        baseColor: { value: new THREE.Color(0x3d8ca8) },
        surfaceTint: { value: new THREE.Color(0x9fd8ea) },
        horizonColor: { value: new THREE.Color(0xcfe4f0) },
        sunColor: { value: new THREE.Color(0xfff3d0) },
        sunDir: { value: sunDir },
        time: { value: 0 },
        opacity: { value: 1.0 },
        uUnderwater: { value: 0.0 },
        uSeaState: { value: 2.0 },
        uFogColor: { value: new THREE.Color(0xcfe4f0) },
        uFogNear: { value: 3800 },
        uFogFar: { value: 17000 },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        varying float vFogDepth;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          vec4 mv = viewMatrix * wp;
          vFogDepth = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 baseColor;
        uniform vec3 surfaceTint;
        uniform vec3 horizonColor;
        uniform vec3 sunColor;
        uniform vec3 sunDir;
        uniform float time;
        uniform float opacity;
        uniform float uUnderwater;
        uniform float uSeaState;
        uniform vec3 uFogColor;
        uniform float uFogNear;
        uniform float uFogFar;
        varying vec3 vWorldPos;
        varying float vFogDepth;

        // Simple value noise + FBM. We use this to warp the wave coordinates so
        // sine-wave fronts meander, avoiding the straight-line / tablecloth look.
        float hash(vec2 p) {
          return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
        }
        float noise(vec2 p) {
          vec2 i = floor(p);
          vec2 f = fract(p);
          float a = hash(i);
          float b = hash(i + vec2(1.0, 0.0));
          float c = hash(i + vec2(0.0, 1.0));
          float d = hash(i + vec2(1.0, 1.0));
          vec2 u = f * f * (3.0 - 2.0 * f);
          return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
        }
        float fbm(vec2 p) {
          float v = 0.0;
          float a = 0.5;
          for (int i = 0; i < 4; i++) {
            v += a * noise(p);
            p *= 2.0;
            a *= 0.5;
          }
          return v;
        }

        void main() {
          vec3 viewDir = normalize(cameraPosition - vWorldPos);
          vec2 p = vWorldPos.xz;

          // Domain warp: curve the coordinate space so travelling wave fronts
          // meander instead of forming straight, tablecloth-like lines.
          float warp = fbm(p * 0.0025 + vec2(time * 0.015, time * 0.012));
          vec2 wp = p + vec2(sin(warp * 6.28318), cos(warp * 6.28318)) * 22.0;

          // Non-orthogonal travelling waves at a couple of scales. Sea state
          // (Beaufort 0-5) scales the swell height and chop so a calm sea is
          // glassy and a storm is heavily textured.
          float sea = clamp(uSeaState / 4.0, 0.0, 1.3);
          float amp = 0.5 + sea * 0.9;
          float w1 = sin(wp.x * 0.008 + wp.y * 0.003 + time * 0.40);
          float w2 = sin(wp.x * 0.005 - wp.y * 0.007 + time * 0.30);
          float w3 = sin(wp.x * 0.013 + wp.y * 0.010 - time * 0.65);
          float w4 = sin(wp.x * 0.022 - wp.y * 0.016 + time * 1.10);
          float sineWave = (w1 * 0.40 + w2 * 0.30 + w3 * 0.20 + w4 * 0.10) * amp * 0.5 + 0.5;

          // Small sparkle noise — bright glints on wave crests, not bands.
          // Choppier seas throw more glints.
          float spark = fbm(wp * 0.035 + vec2(time * 0.35, time * 0.28));
          spark = pow(spark, 5.0) * (0.6 + sea * 0.8);

          // Mix: sine waves give the swell, noise gives irregular sparkle.
          float wave = sineWave * 0.75 + spark * 0.25;

          // Fresnel-style grazing-angle sheen: the sea brightens toward the
          // horizon and where the view skims the surface, reading as a soft
          // reflection of the sky — the cue that this is reflective water.
          float fres = pow(1.0 - max(viewDir.y, 0.0), 3.0);

          vec3 col;
          if (uUnderwater < 0.5) {
            // SURFACE: brighter teal sea with stronger crest/trough contrast
            // plus sun sparkles, so it reads as water from any angle.
            vec3 crest = baseColor * 1.45;
            vec3 trough = baseColor * 0.62;
            vec3 wc = mix(trough, crest, wave);
            wc += vec3(0.92, 0.96, 1.0) * spark * 0.55;
            float horizonF = pow(1.0 - abs(viewDir.y), 2.8);
            float sun = pow(max(0.0, dot(viewDir, sunDir)), 75.0) * (0.4 + wave * 0.5);
            col = mix(wc, horizonColor, horizonF * 0.55);
            col += sunColor * sun;
            // Sky-reflection sheen on the surface (Fresnel rim).
            col += surfaceTint * fres * (0.18 + sea * 0.22);
          } else {
            // UNDERWATER: this plane is the sunlit surface seen from below,
            // a bright rippling "ceiling" so surface vs. deep is obvious.
            col = mix(surfaceTint * 0.50, surfaceTint, wave);
          }

          float fogF = smoothstep(uFogNear, uFogFar, vFogDepth);
          col = mix(col, uFogColor, fogF);
          gl_FragColor = vec4(col, opacity);
        }
      `,
    });
  }

  // --- deep-water dome: the "volume" of the sea in SUB VIEW ---
  //
  // A camera-following sphere whose colour is a *world-anchored* vertical
  // gradient: bright at the sea surface (world y=0) fading to near-black in the
  // deep. This is what makes SUB VIEW read as "under water" — above you is the
  // bright surface, everything below dissolves into darkness with depth. Hidden
  // in the surface view (the sky dome + water plane cover it there).
  _buildDeep() {
    const geo = new THREE.SphereGeometry(30000, 32, 16);
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        topColor: { value: new THREE.Color(0x7ecce8) },
        bottomColor: { value: new THREE.Color(0x0b1f33) },
      },
      vertexShader: `
        varying vec3 vWorldPos;
        void main() {
          vec4 wp = modelMatrix * vec4(position, 1.0);
          vWorldPos = wp.xyz;
          gl_Position = projectionMatrix * viewMatrix * wp;
        }
      `,
      fragmentShader: `
        uniform vec3 topColor;
        uniform vec3 bottomColor;
        varying vec3 vWorldPos;
        void main() {
          // World-anchored depth gradient. Real light attenuation in water is
          // roughly exponential: bright just under the surface, then smoothly
          // darkening with depth. We never reach pure black, just a very deep
          // blue, so the water column has visible volume instead of a hard cut.
          float depth = max(-vWorldPos.y, 0.0);
          float depthF = 1.0 - exp(-depth / 2200.0);
          vec3 col = mix(topColor, bottomColor, depthF);
          gl_FragColor = vec4(col, 1.0);
        }
      `,
    });
    const deep = new THREE.Mesh(geo, mat);
    deep.frustumCulled = false;
    deep.renderOrder = -1;
    deep.visible = false;
    this.deep = deep;
    this.scene.add(deep);
  }

  // --- environment linkage: sea state / weather / time-of-day ---
  //
  // The mission header carries a sea-state (Beaufort-ish 0-5), a weather index
  // (0 clear .. 3 storm) and an hour of day. We translate those into the sky
  // gradient, sun strength, water chop and fog so a night storm in the Barents
  // reads completely differently from a calm midday in the Bay of Bengal — the
  // same 3D engine, just a different palette and wave energy.
  applyEnvironment(env) {
    if (!env) return;
    this._lastEnv = env;
    const hour = typeof env.timeOfDay === 'number' ? env.timeOfDay : (parseInt(env.timeOfDay, 10) || 12);
    const wx = typeof env.weather === 'number' ? env.weather : (parseInt(env.weather, 10) || 0);
    const sea = typeof env.seaState === 'number' ? env.seaState : 2;
    if (this.underwater) return; // SUB VIEW owns its own palette

    // Base palette by time of day.
    let pal;
    if (hour < 6 || hour >= 20) {
      pal = { top: 0x0b1f3a, hor: 0x223a52, bot: 0x05101e, sun: 0xcdd9ff, sunI: 0.20, bg: 0x0b1f3a, fog: 0x223a52 };
    } else if (hour < 9 || hour >= 17) {
      pal = { top: 0x8f6fb0, hor: 0xf0b070, bot: 0x352a48, sun: 0xffd9a0, sunI: 0.55, bg: 0xc89a78, fog: 0xe0b088 };
    } else {
      pal = { top: 0x5c9fd8, hor: 0xcfe4f0, bot: 0x1c5270, sun: 0xfff3d0, sunI: 0.85, bg: 0x9fc4e8, fog: 0xcfe4f0 };
    }

    // Weather overrides (denser haze + weaker sun as it worsens).
    let fogNear = 3800, fogFar = 17000;
    if (wx === 1) {            // overcast
      pal.hor = 0xb9c4cc; pal.top = 0x7d93a3; pal.bot = 0x35424a;
      pal.sun = 0xdfe6ea; pal.sunI = 0.5; pal.bg = 0x9fb0b8; pal.fog = 0xb9c4cc;
      fogNear = 2600; fogFar = 14000;
    } else if (wx === 2) {     // rain
      pal.top = 0x53626c; pal.hor = 0x8a969e; pal.bot = 0x2a333a;
      pal.sunI = 0.3; pal.bg = 0x6b767e; pal.fog = 0x8a969e;
      fogNear = 1800; fogFar = 11000;
    } else if (wx === 3) {     // storm
      pal.top = 0x3a444c; pal.hor = 0x6b757c; pal.bot = 0x20272c;
      pal.sunI = 0.15; pal.bg = 0x55605c; pal.fog = 0x6b757c;
      fogNear = 1200; fogFar = 8000;
    }

    if (this.sky && this.sky.material.uniforms) {
      this.sky.material.uniforms.topColor.value.setHex(pal.top);
      this.sky.material.uniforms.horizonColor.value.setHex(pal.hor);
      this.sky.material.uniforms.bottomColor.value.setHex(pal.bot);
    }
    if (this.sun) {
      this.sun.material.color.setHex(pal.sun);
      this.sun.visible = pal.sunI > 0.2;
    }
    if (this.sunHalo) {
      this.sunHalo.material.opacity = 0.22 * Math.min(1, pal.sunI * 1.4);
      this.sunHalo.visible = this.sun ? this.sun.visible : false;
    }
    if (this.water && this.water.material.uniforms) {
      const u = this.water.material.uniforms;
      u.uSeaState.value = sea;
      u.uFogColor.value.setHex(pal.fog);
      u.uFogNear.value = fogNear;
      u.uFogFar.value = fogFar;
      u.horizonColor.value.setHex(pal.fog);
    }
    this.scene.background.setHex(pal.bg);
    this.scene.fog.color.setHex(pal.fog);
    this.scene.fog.near = fogNear;
    this.scene.fog.far = fogFar;
  }

  // --- procedural ship mesh sized by real visual length (fallback) ---
  _proceduralShip(ship) {
    const targetLen = shipVisualLength(ship);
    const r = targetLen / 2.6; // reuse old proportions, anchored to real length
    const len = targetLen, wid = r * 0.9, h = r * 0.7;
    const group = new THREE.Group();
    const color = ship.isSub ? SUB_COLOR : sideColor(ship);
    const mat = new THREE.MeshLambertMaterial({ color });
    group.userData.hullMat = mat;

    const hull = new THREE.Mesh(new THREE.BoxGeometry(wid, h * 0.6, len), mat);
    hull.position.y = h * 0.2;
    group.add(hull);

    // bow wedge (points toward +Z = forward)
    const bow = new THREE.Mesh(new THREE.ConeGeometry(wid * 0.5, len * 0.28, 4), mat);
    bow.rotation.x = Math.PI / 2;
    bow.position.set(0, h * 0.2, len * 0.5 + len * 0.14);
    bow.scale.set(1, 0.6, 1);
    group.add(bow);

    // superstructure
    const sup = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.55, h * 0.9, len * 0.26), mat);
    sup.position.set(0, h * 0.75, -len * 0.08);
    group.add(sup);

    // bridge tower
    const tower = new THREE.Mesh(new THREE.BoxGeometry(wid * 0.32, h * 0.7, len * 0.1), mat);
    tower.position.set(0, h * 1.25, -len * 0.05);
    group.add(tower);
    return group;
  }

  _proceduralAircraft(ac) {
    const targetLen = aircraftVisualLength(ac);
    const r = targetLen / 2.2; // body length = r*2.2 = targetLen
    const group = new THREE.Group();
    const mat = new THREE.MeshLambertMaterial({ color: sideColor(ac) });
    group.userData.hullMat = mat;

    const body = new THREE.Mesh(new THREE.BoxGeometry(r * 0.4, r * 0.4, r * 2.2), mat);
    group.add(body);
    const wing = new THREE.Mesh(new THREE.BoxGeometry(r * 2.4, r * 0.18, r * 0.5), mat);
    group.add(wing);
    const tail = new THREE.Mesh(new THREE.BoxGeometry(r * 0.9, r * 0.14, r * 0.4), mat);
    tail.position.z = -r * 0.9;
    group.add(tail);
    return group;
  }

  _makeRing(len, r) {
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(len * 0.62, Math.max(1, r * 0.12), 8, 32),
      new THREE.MeshBasicMaterial({ color: HILITE, transparent: true, opacity: 0.9 })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = 0.8;
    ring.visible = false;
    return ring;
  }

  // Build a container that shows a procedural mesh at once, then swaps in the
  // authentic .j3d model when it finishes loading (async). Keeps the ring and
  // userData.shipId so the per-frame sync code is unchanged.
  _buildShip(ship) {
    const container = new THREE.Group();
    container.userData.shipId = ship.id;

    const visualLen = shipVisualLength(ship);
    const proc = this._proceduralShip(ship);
    container.add(proc);
    container.userData.body = proc;
    container.userData.hullMat = proc.userData.hullMat;
    container.userData.isModel = false;

    const ring = this._makeRing(visualLen, visualLen / 2.6);
    container.add(ring);
    container.userData.ring = ring;

    // SUB VIEW: a bright, self-illuminated sonar-contact sphere that guarantees
    // submerged submarines remain visible even when the detailed 3D model is
    // back-lit by surface light or rendered by software WebGL.
    const contactColor = sideColor(ship);
    const contact = new THREE.Mesh(
      new THREE.SphereGeometry(visualLen * 0.7, 16, 12),
      new THREE.MeshBasicMaterial({ color: contactColor, transparent: true, opacity: 0.75 })
    );
    contact.visible = false;
    container.add(contact);
    container.userData.contact = contact;

    const key = shipModelKey(ship);
    if (key) {
      const len = visualLen;
      this._modelLib.getInstance(key, len, ship.side).then((model) => {
        if (!model || !container.parent) return; // disposed already
        container.remove(proc);
        container.add(model);
        container.userData.body = model;
        container.userData.hullMat = null;
        container.userData.isModel = true;
      }).catch(() => {});
    }
    return container;
  }

  _buildAircraft(ac) {
    const container = new THREE.Group();
    container.userData.shipId = ac.id;

    const visualLen = aircraftVisualLength(ac);
    const proc = this._proceduralAircraft(ac);
    container.add(proc);
    container.userData.body = proc;
    container.userData.hullMat = proc.userData.hullMat;
    container.userData.isModel = false;

    const ring = this._makeRing(visualLen, visualLen / 2.2);
    ring.position.y = -visualLen * 0.3;
    container.add(ring);
    container.userData.ring = ring;

    const key = aircraftModelKey(ac);
    if (key) {
      this._modelLib.getInstance(key, visualLen, ac.side).then((model) => {
        if (!model || !container.parent) return;
        container.remove(proc);
        container.add(model);
        container.userData.body = model;
        container.userData.hullMat = null;
        container.userData.isModel = true;
      }).catch(() => {});
    }
    return container;
  }

  // --- per-frame reconciliation of dynamic objects with world state ---
  sync(world) {
    const sel = (world.__selected && world.__selected) || [];

    // ships
    const seenS = new Set();
    for (const s of world.ships) {
      if (!s.alive) continue;
      seenS.add(s.id);
      let m = this.shipMeshes.get(s.id);
      if (!m) {
        m = this._buildShip(s);
        m.userData.shipId = s.id;
        this.shipGroup.add(m);
        this.shipMeshes.set(s.id, m);
      }
      // Surface units sit at y=2.0 (clearly above the opaque water plane).
      // In SUB VIEW, submarines drop to their real simulation depth (negative
      // y). In the normal surface view a detected sub is drawn mostly below
      // the waterline so only the sail/conning tower sticks out — a clear
      // periscope-depth contact rather than a surface ship.
      const y = s.isSub
        ? (this.underwater ? (s.depth || 0) : - (s.radius || 30) * 0.55)
        : 2.0;
      m.position.set(s.pos.x, y, s.pos.y);
      m.rotation.y = -s.heading;
      m.visible = s.side === 'player' || !!s.detected;
      this._applySelected(m, sel.includes(s.id), s.isSub);
      if (m.userData.ring) m.userData.ring.visible = sel.includes(s.id);
      if (m.userData.contact) {
        m.userData.contact.visible = this.underwater && s.isSub;
      }
      this._updateWake(s, m);
    }
    for (const [id, m] of this.shipMeshes) {
      if (!seenS.has(id)) {
        this.shipGroup.remove(m); this._disposeGroup(m); this.shipMeshes.delete(id);
        const wt = this._wakeTrails.get(id);
        if (wt) { this.wakeGroup.remove(wt.line); wt.line.geometry.dispose(); wt.line.material.dispose(); this._wakeTrails.delete(id); }
      }
    }

    // Death detection -> explosions. Compare the live set against last frame.
    for (const s of world.ships) {
      const was = this._prevAlive.get(s.id);
      if (was && was.alive && !s.alive) {
        const scale = shipVisualLength(s) * 0.35;
        this._spawnExplosion(was.x, was.z, s.side, s.isSub, scale);
      }
      this._prevAlive.set(s.id, { alive: s.alive, x: s.pos.x, z: s.pos.y });
    }

    // aircraft
    const seenA = new Set();
    for (const a of world.aircraft) {
      if (!a.alive) continue;
      seenA.add(a.id);
      let m = this.acMeshes.get(a.id);
      if (!m) {
        m = this._buildAircraft(a);
        m.userData.shipId = a.id;
        this.acGroup.add(m);
        this.acMeshes.set(a.id, m);
      }
      const y = Math.max(3, Math.min(500, a.alt || 60));
      m.position.set(a.pos.x, y, a.pos.y);
      m.rotation.y = -a.heading;
      m.visible = a.side === 'player' || !!a.detected;
      this._applySelected(m, sel.includes(a.id), false);
      if (m.userData.ring) m.userData.ring.visible = sel.includes(a.id);
    }
    for (const [id, m] of this.acMeshes) {
      if (!seenA.has(id)) { this.acGroup.remove(m); this._disposeGroup(m); this.acMeshes.delete(id); }
    }

      // projectiles (pooled): small glowing core + additive exhaust + fading trail.
      // Sizes are now in real-world scale (a few decimetres to metres), so at the
      // strategic camera they read as streaks/dots rather than kilometre-wide blobs.
    const live = (world.projectiles || []).filter((p) => !p.dead);
    for (let i = 0; i < live.length; i++) {
      const p = live[i];
      let m = this.projPool[i];
      if (!m) {
        m = new THREE.Group();
        const core = new THREE.Mesh(
          new THREE.SphereGeometry(0.15, 8, 8),
          new THREE.MeshBasicMaterial({ color: 0xffffff })
        );
        m.add(core);
        m.userData.core = core;
        // Exhaust glow trailing the projectile (additive, so it reads as a
        // hot motor plume regardless of what sits behind it).
        const ex = new THREE.Mesh(
          new THREE.SphereGeometry(0.28, 8, 8),
          new THREE.MeshBasicMaterial({
            color: 0xffd070, transparent: true, opacity: 0.45,
            blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
          })
        );
        ex.position.set(0, 0, -0.55);
        m.add(ex);
        m.userData.exhaust = ex;
        this.projGroup.add(m);
        this.projPool[i] = m;
        // Reusing a parallel pool slot for the trail line.
        const tgeo = new THREE.BufferGeometry();
        tgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
        tgeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(12 * 3), 3));
        const tmat = new THREE.LineBasicMaterial({
          vertexColors: true, transparent: true, opacity: 0.55,
          blending: THREE.AdditiveBlending, depthWrite: false, fog: false,
        });
        const tline = new THREE.Line(tgeo, tmat);
        tline.frustumCulled = false;
        this.projGroup.add(tline);
        this.projTrailPool[i] = tline;
      }
      const sideHex = p.side === 'player' ? 0x6fe0ff : 0xff8a5a;
      m.userData.core.material.color.setHex(sideHex);
      // Use p.alt set by spawnProjectile; keep a small floor so torpedoes stay
      // just at/under the surface and missiles/guns remain visible.
      let y = p.alt ?? 2.0;
      if (p.type === 'torpedo') y = Math.max(0.2, Math.min(2.0, y));
      else y = Math.max(0.8, Math.min(30, y));
      m.visible = true;
      m.position.set(p.pos.x, y, p.pos.y);
      // Point the exhaust back along travel using the recent trail history.
      if (p.trail && p.trail.length > 1) {
        const a = p.trail[p.trail.length - 1];
        const b = p.trail[p.trail.length - 2];
        m.rotation.y = -Math.atan2(b.x - a.x, b.y - a.y);
      }
      m.userData.exhaust.visible = p.type === 'missile';

      // Trail: fade from the projectile colour (head) to black (tail) under
      // additive blending, so it dissolves into the scene instead of a hard line.
      const tline = this.projTrailPool[i];
      const tr = p.trail || [];
      const n = Math.min(tr.length, 12);
      if (n > 1) {
        const pos = tline.geometry.attributes.position.array;
        const col = tline.geometry.attributes.color.array;
        const hc = new THREE.Color(sideHex);
        for (let k = 0; k < n; k++) {
          const pt = tr[tr.length - n + k];
          pos[k * 3] = pt.x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = pt.y;
          const f = (k + 1) / n;
          col[k * 3] = hc.r * f; col[k * 3 + 1] = hc.g * f; col[k * 3 + 2] = hc.b * f;
        }
        tline.geometry.setDrawRange(0, n);
        tline.geometry.attributes.position.needsUpdate = true;
        tline.geometry.attributes.color.needsUpdate = true;
        tline.visible = true;
      } else {
        tline.visible = false;
      }
    }
    for (let i = live.length; i < this.projPool.length; i++) {
      this.projPool[i].visible = false;
      if (this.projTrailPool[i]) this.projTrailPool[i].visible = false;
    }
  }

  _disposeGroup(g) {
    g.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) { if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose()); else o.material.dispose(); }
    });
  }

  // --- ship wake trail ----------------------------------------------------
  // A short fading line behind the stern of any surface ship that is actually
  // moving. Foam-white at the bow, dissolving into the water colour at the
  // tail so it reads as a V-wake rather than a solid stroke.
  _updateWake(ship, container) {
    const moving = !ship.isSub && (ship.speed || 0) > 1.5;
    let wt = this._wakeTrails.get(ship.id);
    if (!moving) { if (wt) wt.line.visible = false; return; }
    if (!wt) {
      const maxPts = 18;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(maxPts * 3), 3));
      geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(maxPts * 3), 3));
      const mat = new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, fog: true });
      const line = new THREE.Line(geo, mat);
      line.frustumCulled = false;
      this.wakeGroup.add(line);
      wt = { line, pts: [], maxPts };
      this._wakeTrails.set(ship.id, wt);
    }
    const r = shipVisualLength(ship) * 0.5;
    const bx = ship.pos.x - Math.sin(ship.heading) * r * 1.1;
    const bz = ship.pos.y - Math.cos(ship.heading) * r * 1.1;
    wt.pts.push({ x: bx, z: bz });
    if (wt.pts.length > wt.maxPts) wt.pts.shift();

    const n = wt.pts.length;
    const pos = wt.line.geometry.attributes.position.array;
    const col = wt.line.geometry.attributes.color.array;
    const head = new THREE.Color(0xffffff);
    const tail = new THREE.Color(0x3d8ca8); // deep-water base, blends into sea
    for (let i = 0; i < n; i++) {
      pos[i * 3] = wt.pts[i].x; pos[i * 3 + 1] = 1.2; pos[i * 3 + 2] = wt.pts[i].z;
      const f = i / (n - 1 || 1); // 0 = oldest tail, 1 = newest (stern)
      col[i * 3] = tail.r + (head.r - tail.r) * f;
      col[i * 3 + 1] = tail.g + (head.g - tail.g) * f;
      col[i * 3 + 2] = tail.b + (head.b - tail.b) * f;
    }
    wt.line.geometry.setDrawRange(0, n);
    wt.line.geometry.attributes.position.needsUpdate = true;
    wt.line.geometry.attributes.color.needsUpdate = true;
    wt.line.visible = true;
  }

  // --- explosions / battle damage FX --------------------------------------
  _spawnExplosion(x, z, side, isSub, scale = 1) {
    const sideHex = side === 'neutral' ? NEUTRAL_COLOR : side === 'player' ? PLAYER_COLOR : ENEMY_COLOR;
    const y = isSub ? -18 : 7;
    // Base sizes are tuned for the new real-scale hulls (a few world units long).
    // The optional scale lets big units produce slightly bigger blasts.
    const flashR = 2.5 * scale;
    const ballR = 1.8 * scale;
    const smokeR = 1.8 * scale;
    // Initial flash.
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(flashR, 12, 12),
      new THREE.MeshBasicMaterial({ color: 0xfff1c0, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    flash.position.set(x, y, z);
    this.fxGroup.add(flash);
    this._effects.push({ mesh: flash, age: 0, life: 0.35, grow: 100, kind: 'flash' });
    // Fireball (side-tinted) expanding outward.
    const ball = new THREE.Mesh(
      new THREE.SphereGeometry(ballR, 12, 12),
      new THREE.MeshBasicMaterial({ color: sideHex, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false, fog: false })
    );
    ball.position.set(x, y, z);
    this.fxGroup.add(ball);
    this._effects.push({ mesh: ball, age: 0, life: 1.1, grow: 80, kind: 'ball' });
    // Rising smoke column.
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(smokeR, 10, 10),
      new THREE.MeshBasicMaterial({ color: 0x4a4a4a, transparent: true, opacity: 0.5, depthWrite: false, fog: false })
    );
    smoke.position.set(x, y + 6 * scale, z);
    this.fxGroup.add(smoke);
    this._effects.push({ mesh: smoke, age: 0, life: 2.0, grow: 45, rise: 60, kind: 'smoke' });
  }

  _updateEffects(dt) {
    for (let i = this._effects.length - 1; i >= 0; i--) {
      const e = this._effects[i];
      e.age += dt;
      const t = Math.min(1, e.age / e.life);
      e.mesh.scale.setScalar(1 + e.grow * t);
      if (e.rise) e.mesh.position.y += e.rise * dt;
      const base = e.kind === 'smoke' ? 0.5 : 0.9;
      e.mesh.material.opacity = Math.max(0, (1 - t) * base);
      if (e.age >= e.life) {
        this.fxGroup.remove(e.mesh);
        e.mesh.geometry.dispose();
        e.mesh.material.dispose();
        this._effects.splice(i, 1);
      }
    }
  }

  // Toggle the selection glow on whatever body is currently active (procedural or
  // the loaded authentic model). When submerged in SUB VIEW, submarines also get
  // a faint base glow so they remain visible against the dark deep.
  _applySelected(container, on, isSub) {
    const baseHex = (this.underwater && isSub) ? 0x66aacc : 0x000000;
    const hex = on ? 0x123a2a : baseHex;
    const body = container.userData.body;
    if (!body) return;
    body.traverse((o) => {
      if (o.isMesh && o.material) {
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) if (m.emissive) m.emissive.setHex(hex);
      }
    });
  }

  // --- camera ---
  _updateCamera() {
    // SUB VIEW: orbit freely around the subs while staying below the surface.
    // The camera may rise to just under the water (looking down) or sink deep
    // (looking up) — right-drag up/down actually moves the view.
    if (this.underwater) {
      const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
      const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
      this.camera.position.set(
        this.target.x + this.distance * ce * sa,
        this.target.y + this.distance * se,
        this.target.z + this.distance * ce * ca
      );
      // Keep the camera beneath the surface regardless of orbit/zoom, but let
      // it travel vertically between the surface and the deep.
      this.camera.position.y = Math.min(this.camera.position.y, -3);
      // Keep the fill light with the camera so subs are lit from the viewer.
      this._subLight.position.copy(this.camera.position);
      if (this.sky) this.sky.position.copy(this.camera.position);
      if (this.deep) this.deep.position.copy(this.camera.position);
      this.camera.lookAt(this.target);
      return;
    }
    const ce = Math.cos(this.elevation), se = Math.sin(this.elevation);
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.camera.position.set(
      this.target.x + this.distance * ce * sa,
      this.target.y + this.distance * se,
      this.target.z + this.distance * ce * ca
    );
    // Keep the camera above the waterline so aggressive zoom/orbit cannot
    // duck beneath the ocean plane and reveal the underside of land meshes.
    this.camera.position.y = Math.max(this.target.y + 3, this.camera.position.y);
    if (this.sky) this.sky.position.copy(this.camera.position);
    if (this.deep) this.deep.position.copy(this.camera.position);
    this.camera.lookAt(this.target);
  }

  // Toggle the sub-surface (underwater) camera. When ON the sea becomes
  // translucent, the look-at target drops to periscope depth, and sync() draws
  // submarines at their real negative depth. When OFF everything is restored
  // to the surface view.
  setUnderwater(on) {
    this.underwater = !!on;
    const w = this.water;
    const u = w.material.uniforms;
    if (this.underwater) {
      // The sea becomes a translucent, rippling sunlit "ceiling" and a deep
      // gradient dome appears behind everything — you can now tell you are
      // looking UP through the surface into a darkening water column.
      u.uUnderwater.value = 1.0;
      u.opacity.value = 0.72;
      u.uFogColor.value.setHex(0x0c2b3d);
      u.uFogNear.value = 3000;
      u.uFogFar.value = 16000;
      w.material.transparent = true;
      w.material.depthWrite = false;
      // Sky dome + sun belong to the surface world; hide them underwater.
      if (this.sky) this.sky.visible = false;
      if (this.sun) this.sun.visible = false;
      if (this.sunHalo) this.sunHalo.visible = false;
      if (this.deep) this.deep.visible = true;
      // Dark background so the depth gradient reads; the fill light handles
      // close-up submarine shading from the viewer's side.
      this.scene.background.setHex(0x0c2b3d);
      this.scene.fog.color.setHex(0x0c2b3d);
      this._subLight.visible = true;
      // Drop the look-at point to the band where most subs live and zoom in so
      // submerged contacts fill the frame instead of being tiny silhouettes.
      this.target.y = -120;
      this.elevation = 0.28;
      this.distance = Math.max(260, Math.min(900, this.distance));
    } else {
      u.uUnderwater.value = 0.0;
      u.opacity.value = 1.0;
      u.baseColor.value.setHex(this.surfaceWaterColor);
      u.uFogColor.value.setHex(0xcfe4f0);
      u.uFogNear.value = 3800;
      u.uFogFar.value = 17000;
      w.material.transparent = false;
      w.material.depthWrite = true;
      if (this.sky) this.sky.visible = true;
      if (this.sunHalo) this.sunHalo.visible = true;
      if (this.deep) this.deep.visible = false;
      this._subLight.visible = false;
      this.target.y = 0;
      // Re-apply the mission environment palette (overrides the hardcoded
      // surface defaults so a night/storm mission keeps its look after SUB VIEW).
      if (this._lastEnv) this.applyEnvironment(this._lastEnv);
      else {
        this.scene.background.setHex(0x9fc4e8);
        this.scene.fog.color.setHex(0xcfe4f0);
        if (this.sun) this.sun.visible = true;
      }
    }
  }

  pan(dx, dy) {
    const scale = this.distance * 0.0016;
    const ca = Math.cos(this.azimuth), sa = Math.sin(this.azimuth);
    this.target.x -= (ca * dx + sa * dy) * scale;
    this.target.z -= (-sa * dx + ca * dy) * scale;
  }

  orbit(daz, del) {
    this.azimuth += daz * 0.005;
    // Underwater lets the view pitch from near-surface (looking down) to deep
    // (looking up), so the elevation range is wider than in the surface view.
    if (this.underwater) {
      this.elevation = Math.max(-1.2, Math.min(1.3, this.elevation - del * 0.005));
    } else {
      this.elevation = Math.max(0.08, Math.min(1.45, this.elevation - del * 0.005));
    }
  }

  zoom(factor) {
    this.distance = Math.max(80, Math.min(6000, this.distance * factor));
  }

  reset() {
    this.target.set(2000, this.underwater ? -120 : 0, 2000);
    this.azimuth = 0;
    this.elevation = this.underwater ? 0.28 : 0.62;
    this.distance = this.underwater ? 600 : 1300;
  }

  // Frame the camera on the current live ships so they are centred and fit in
  // view at battle start (the default target/distance can leave them off-screen
  // or tiny). Called once when a 3D view is created; does not fight user pan.
  // Immobile land installations (airfields) are excluded from the fit so a far
  // inland base does not zoom the whole fleet out to nothing.
  frameShips(world) {
    let cx = 0, cy = 0, n = 0, maxR = 0;
    const movers = world.ships.filter((s) => s.alive && !s.immobile);
    const list = movers.length ? movers : world.ships.filter((s) => s.alive);
    for (const s of list) { cx += s.pos.x; cy += s.pos.y; n++; }
    if (!n) return;
    cx /= n; cy /= n;
    for (const s of list) {
      maxR = Math.max(maxR, Math.hypot(s.pos.x - cx, s.pos.y - cy));
    }
    this.target.set(cx, 0, cy);
    this.azimuth = 0;
    this.elevation = 0.72;
    // Tight fit: zoom in enough that even small units (subs) are clearly seen.
    this.distance = Math.max(260, Math.min(2200, maxR * 1.7 + 320));
  }

  // --- picking / unprojection ---
  screenToWorld(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const pt = new THREE.Vector3();
    const hit = this.raycaster.ray.intersectPlane(this._seaPlane, pt);
    return hit ? { x: pt.x, y: pt.z } : null;
  }

  pick(clientX, clientY, world) {
    const rect = this.canvas.getBoundingClientRect();
    this._ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    this._ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    this.raycaster.setFromCamera(this._ndc, this.camera);
    const targets = [];
    for (const [, m] of this.shipMeshes) if (m.visible) targets.push(m);
    for (const [, m] of this.acMeshes) if (m.visible) targets.push(m);
    const hits = this.raycaster.intersectObjects(targets, true);
    if (hits.length) {
      let o = hits[0].object;
      while (o && o.userData.shipId === undefined) o = o.parent;
      if (o && o.userData.shipId !== undefined) return o.userData.shipId;
    }
    return null;
  }

  render(world) {
    const env = world && world.environment;
    if (env) {
      const key = (env.seaState || 0) + '|' + (env.weather != null ? env.weather : '') + '|' + (env.timeOfDay != null ? env.timeOfDay : '');
      if (key !== this._envKey) { this._envKey = key; this.applyEnvironment(env); }
    }
    this.sync(world);
    const now = performance.now();
    const dt = this._lastT ? Math.min(0.1, (now - this._lastT) / 1000) : 0.016;
    this._lastT = now;
    this._updateEffects(dt);
    if (this.water && this.water.material.uniforms) {
      this.water.material.uniforms.time.value = now * 0.0005;
    }
    this._updateCamera();
    this.renderer.render(this.scene, this.camera);
  }

  // 2D top-down zoom that matches the 3D view's vertical extent, so the
  // bottom-panel 2D map stays consistent with what the 3D camera sees.
  topDownZoom(viewportHeight) {
    const halfV = this.distance * Math.tan((this.camera.fov * Math.PI / 180) / 2);
    return (viewportHeight / 2) / halfV;
  }

  resize(w, h) {
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  dispose() {
    this._disposeGroup(this.shipGroup);
    this._disposeGroup(this.acGroup);
    this._disposeGroup(this.projGroup);
    this.shipMeshes.clear();
    this.acMeshes.clear();
    this.projPool.length = 0;
    this.renderer.dispose();
  }
}
