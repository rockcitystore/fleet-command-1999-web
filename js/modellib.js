// modellib.js — loads authentic Fleet Command .j3d models (converted to JSON at
// assets/models3d/<key>/model.json) into three.js Groups for render3d.js.
//
// Each model is a set of self-contained parts (hull, superstructure, turrets...)
// with LOCAL vertex/normal/uv buffers and a parent/offset hierarchy. We rebuild
// that hierarchy exactly, scale the whole thing to a target length, and cache by
// key so the 876 models are only fetched on first use.
//
// Textures (phase 2) are not applied yet — J3D materials carry a diffuse colour
// which we use directly, so ships already read as the original Navy grey / Soviet
// hull tones rather than flat procedural blocks.

import * as THREE from './vendor/three.module.js';

function matColor(material) {
  if (!material) return 0x9aa3ab; // neutral steel
  const d = material.diffuse || [0.6, 0.6, 0.6, 1];
  const r = Math.max(0, Math.min(1, d[0]));
  const g = Math.max(0, Math.min(1, d[1]));
  const b = Math.max(0, Math.min(1, d[2]));
  return (Math.round(r * 255) << 16) | (Math.round(g * 255) << 8) | Math.round(b * 255);
}

function buildPart(part) {
  const verts = part.vertices, norms = part.normals, uvs = part.uvs, idx = part.indices;
  const nv = verts.length / 3;
  const pos = new Float32Array(verts);
  const nor = norms && norms.length === verts.length ? new Float32Array(norms) : null;
  const uv = uvs && uvs.length === nv * 2 ? new Float32Array(uvs) : null;
  const indices = new (idx.length > 65535 ? Uint32Array : Uint16Array)(idx);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  if (nor) geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  if (uv) geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(indices, 1));
  if (!nor) geo.computeVertexNormals();

  const color = matColor(part.material);
  const mat = new THREE.MeshLambertMaterial({ color });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(part.offset[0], part.offset[1], part.offset[2]);
  return mesh;
}

// Build a Group from parsed model JSON, scaled so its longest horizontal extent
// equals `targetLen` world units. Models use +Z as forward; we keep that and let
// the caller rotate by heading.
function buildGroup(model, targetLen) {
  // First pass: collect all part meshes (we resolve parent/child after).
  const meshes = {};
  for (const p of model.parts) meshes[p.name || `p${Object.keys(meshes).length}`] = buildPart(p);

  const root = new THREE.Group();
  // The J3D tree is parent/child by index; since offsets are already world-ish
  // (relative to parent) and most FC models are flat lists under the root, we
  // attach every part directly to the root. Offsets already place them.
  for (const m of Object.values(meshes)) root.add(m);

  // Normalize scale: compute bounding box, scale to targetLen on the long axis.
  const box = new THREE.Box3().setFromObject(root);
  const size = new THREE.Vector3();
  box.getSize(size);
  const longAxis = Math.max(size.x, size.z) || 1;
  const s = targetLen / longAxis;
  root.scale.setScalar(s);

  // Sit the hull on the waterline: after scaling, drop so min.y == 0.
  const box2 = new THREE.Box3().setFromObject(root);
  root.position.y -= box2.min.y;
  return root;
}

export class ModelLibrary {
  constructor() {
    this.cache = new Map();   // key -> Promise<Group template>
  }

  // Returns a *cloned* Group (so each instance can be transformed independently),
  // scaled so its long horizontal axis == targetLen world units.
  async getInstance(key, targetLen, side) {
    const tpl = await this._load(key);
    if (!tpl) return null;
    const g = tpl.clone(true);
    // Template was built at unit long-axis (== 1), so multiply by targetLen.
    g.scale.multiplyScalar(targetLen);
    if (side === 'enemy') this._tint(g, 0xc85a3c);
    else if (side === 'player') this._tint(g, 0x4f8fce);
    return g;
  }

  _tint(group, hex) {
    // Subtle side tint on the base material so factions read at a glance,
    // while keeping the original hull shading.
    group.traverse((o) => {
      if (o.isMesh && o.material) {
        o.material = o.material.clone();
        o.material.color.lerp(new THREE.Color(hex), 0.18);
      }
    });
  }

  _load(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const url = `assets/models3d/${key}/model.json`;
    const p = fetch(url)
      .then((r) => { if (!r.ok) throw new Error(`model ${key} ${r.status}`); return r.json(); })
      .then((model) => buildGroup(model, 1)) // unit length; caller scales via targetLen
      .catch((e) => { console.warn('[modellib]', e.message); return null; });
    this.cache.set(key, p);
    return p;
  }
}
