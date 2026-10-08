// Turns a raw .glb from a sculpting or image-to-3D tool into a piece the 3D
// board can use, and points the manifest at it.
//
//   npm run prepare-model -- <input.glb> <piece> [--triangles 20000] [--height 1.45] [--rotate 180]
//
//   <piece>      pawn, knight, bishop, rook, queen or king
//   --triangles  how many to keep (default: the budget for that piece)
//   --height     how tall it stands, in squares (default: the built-in piece's)
//   --rotate     degrees about the vertical written to the manifest. 180 for a
//                model that faces +Z, as most tools export (default 180)
//
// What it does: reads every mesh in the file, drops materials and textures
// (the board paints every piece in its side's glass), welds the vertices,
// reduces the triangle count, stands the model on the origin at the asked
// height, recomputes smooth normals, and writes
// web/public/models/chess/statues/<piece>.glb with one material named "glass".
//
// What it does not do: separate a weapon arm, or mark glowing parts. A model
// that comes as one lump has neither; it leans and lunges in a fight, as the
// rook does. See docs/SCULPTED_PIECE_PIPELINE.md.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MeshoptSimplifier } from 'meshoptimizer';
import { Matrix4, Quaternion, Vector3 } from 'three';

const OUT = fileURLToPath(new URL('../public/models/chess/statues/', import.meta.url));
const DEFAULTS = {
  pawn: { triangles: 5000, height: 0.9 },
  rook: { triangles: 10000, height: 0.95 },
  bishop: { triangles: 10000, height: 1.3 },
  knight: { triangles: 20000, height: 1.25 },
  queen: { triangles: 20000, height: 1.45 },
  king: { triangles: 20000, height: 1.35 },
};
/** A base has to fit on its square with room to spare. */
const MAX_RADIUS = 0.42;

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? Number(args[at + 1]) : fallback;
};
const [input, piece] = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] ?? '').startsWith('--'));
if (!input || !DEFAULTS[piece]) {
  console.error('usage: npm run prepare-model -- <input.glb> <pawn|knight|bishop|rook|queen|king> [--triangles N] [--height H] [--rotate DEG]');
  process.exit(1);
}
const target = option('triangles', DEFAULTS[piece].triangles);
const height = option('height', DEFAULTS[piece].height);
const rotate = option('rotate', 180);

// ---- read the .glb
const file = readFileSync(input);
if (file.readUInt32LE(0) !== 0x46546c67) throw new Error('not a binary glTF (.glb) file');
const jsonLength = file.readUInt32LE(12);
const gltf = JSON.parse(file.subarray(20, 20 + jsonLength).toString('utf8'));
const bin = file.subarray(20 + jsonLength + 8);
for (const required of gltf.extensionsRequired ?? []) {
  throw new Error(`the file needs the ${required} extension (compressed?), which this script does not read. Export it uncompressed.`);
}

const SIZE = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const READ = { 5121: 'readUInt8', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' };
const read = (index, width) => {
  const accessor = gltf.accessors[index];
  const view = gltf.bufferViews[accessor.bufferView];
  const stride = view.byteStride ?? SIZE[accessor.componentType] * width;
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const get = READ[accessor.componentType];
  const out = new (accessor.componentType === 5126 ? Float32Array : Uint32Array)(accessor.count * width);
  for (let i = 0; i < accessor.count; i++) {
    for (let k = 0; k < width; k++) out[i * width + k] = bin[get](start + i * stride + k * SIZE[accessor.componentType]);
  }
  return out;
};

const positions = [];
const indices = [];
const walk = (nodeIndex, parent) => {
  const node = gltf.nodes[nodeIndex];
  const local = node.matrix
    ? new Matrix4().fromArray(node.matrix)
    : new Matrix4().compose(
        new Vector3(...(node.translation ?? [0, 0, 0])),
        new Quaternion(...(node.rotation ?? [0, 0, 0, 1])),
        new Vector3(...(node.scale ?? [1, 1, 1])),
      );
  const world = parent.clone().multiply(local);
  if (node.mesh !== undefined) {
    for (const primitive of gltf.meshes[node.mesh].primitives) {
      if ((primitive.mode ?? 4) !== 4) continue; // triangles only
      const p = read(primitive.attributes.POSITION, 3);
      const base = positions.length / 3;
      const v = new Vector3();
      for (let i = 0; i < p.length; i += 3) {
        v.set(p[i], p[i + 1], p[i + 2]).applyMatrix4(world);
        positions.push(v.x, v.y, v.z);
      }
      const count = p.length / 3;
      if (primitive.indices === undefined) for (let i = 0; i < count; i++) indices.push(base + i);
      else for (const i of read(primitive.indices, 1)) indices.push(base + i);
    }
  }
  for (const child of node.children ?? []) walk(child, world);
};
for (const root of gltf.scenes[gltf.scene ?? 0].nodes) walk(root, new Matrix4());
if (indices.length === 0) throw new Error('the file has no triangles');
const before = indices.length / 3;

// ---- weld: tools split vertices along texture seams, which would tear when simplified
const seen = new Map();
const welded = [];
const remap = new Uint32Array(positions.length / 3);
for (let i = 0; i < remap.length; i++) {
  const key = `${Math.round(positions[i * 3] * 1e5)},${Math.round(positions[i * 3 + 1] * 1e5)},${Math.round(positions[i * 3 + 2] * 1e5)}`;
  let to = seen.get(key);
  if (to === undefined) {
    to = welded.length / 3;
    seen.set(key, to);
    welded.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
  }
  remap[i] = to;
}
let triangles = Uint32Array.from(indices, (i) => remap[i]);
let vertices = Float32Array.from(welded);

// ---- reduce
await MeshoptSimplifier.ready;
let error = 0;
if (triangles.length / 3 > target) {
  // Loosen the allowed error until the target is reached: a huge mesh needs a lot of room.
  for (const allowed of [0.01, 0.05, 0.2, 1]) {
    const [kept, reached] = MeshoptSimplifier.simplify(triangles, vertices, 3, target * 3, allowed);
    if (kept.length / 3 <= target * 1.1 || allowed === 1) {
      triangles = kept;
      error = reached;
      break;
    }
  }
}
// keep only the vertices still in use
const used = new Map();
const kept = [];
triangles = triangles.map((i) => {
  let to = used.get(i);
  if (to === undefined) {
    to = kept.length / 3;
    used.set(i, to);
    kept.push(vertices[i * 3], vertices[i * 3 + 1], vertices[i * 3 + 2]);
  }
  return to;
});
vertices = Float32Array.from(kept);

// ---- stand it on the origin, at the asked height
const min = [Infinity, Infinity, Infinity];
const max = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < vertices.length; i++) {
  min[i % 3] = Math.min(min[i % 3], vertices[i]);
  max[i % 3] = Math.max(max[i % 3], vertices[i]);
}
// Centre on the foot of the model (its lowest tenth), not on a raised arm or a staff.
const foot = { x: [Infinity, -Infinity], z: [Infinity, -Infinity] };
for (let i = 0; i < vertices.length; i += 3) {
  if (vertices[i + 1] > min[1] + (max[1] - min[1]) * 0.1) continue;
  foot.x = [Math.min(foot.x[0], vertices[i]), Math.max(foot.x[1], vertices[i])];
  foot.z = [Math.min(foot.z[0], vertices[i + 2]), Math.max(foot.z[1], vertices[i + 2])];
}
const cx = (foot.x[0] + foot.x[1]) / 2;
const cz = (foot.z[0] + foot.z[1]) / 2;
let scale = height / (max[1] - min[1]);
let radius = 0;
for (let i = 0; i < vertices.length; i += 3) radius = Math.max(radius, Math.hypot(vertices[i] - cx, vertices[i + 2] - cz) * scale);
let shrunk = false;
if (radius > MAX_RADIUS) {
  scale *= MAX_RADIUS / radius;
  shrunk = true;
}
for (let i = 0; i < vertices.length; i += 3) {
  vertices[i] = (vertices[i] - cx) * scale;
  vertices[i + 1] = (vertices[i + 1] - min[1]) * scale;
  vertices[i + 2] = (vertices[i + 2] - cz) * scale;
}

// ---- smooth normals, weighted by the area of each face
const normals = new Float32Array(vertices.length);
const a = new Vector3();
const b = new Vector3();
const c = new Vector3();
for (let i = 0; i < triangles.length; i += 3) {
  a.fromArray(vertices, triangles[i] * 3);
  b.fromArray(vertices, triangles[i + 1] * 3).sub(a);
  c.fromArray(vertices, triangles[i + 2] * 3).sub(a);
  b.cross(c);
  for (let k = 0; k < 3; k++) {
    normals[triangles[i + k] * 3] += b.x;
    normals[triangles[i + k] * 3 + 1] += b.y;
    normals[triangles[i + k] * 3 + 2] += b.z;
  }
}
for (let i = 0; i < normals.length; i += 3) {
  const length = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
  normals[i] /= length;
  normals[i + 1] /= length;
  normals[i + 2] /= length;
}

// ---- write the .glb
const bounds = (data) => {
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < data.length; i++) {
    lo[i % 3] = Math.min(lo[i % 3], data[i]);
    hi[i % 3] = Math.max(hi[i % 3], data[i]);
  }
  return { min: lo, max: hi };
};
const parts = [vertices, normals, triangles];
let offset = 0;
const bufferViews = parts.map((part, i) => {
  const view = { buffer: 0, byteOffset: offset, byteLength: part.byteLength, target: i === 2 ? 34963 : 34962 };
  offset += part.byteLength;
  return view;
});
const json = {
  asset: { version: '2.0', generator: 'SymChess prepare-model' },
  scene: 0,
  scenes: [{ nodes: [0] }],
  nodes: [{ name: piece, mesh: 0 }],
  meshes: [{ name: 'body', primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
  materials: [{ name: 'glass', pbrMetallicRoughness: { baseColorFactor: [0.8, 0.92, 0.96, 1], metallicFactor: 0.05, roughnessFactor: 0.4 } }],
  accessors: [
    { bufferView: 0, componentType: 5126, count: vertices.length / 3, type: 'VEC3', ...bounds(vertices) },
    { bufferView: 1, componentType: 5126, count: normals.length / 3, type: 'VEC3' },
    { bufferView: 2, componentType: 5125, count: triangles.length, type: 'SCALAR' },
  ],
  bufferViews,
  buffers: [{ byteLength: offset }],
};
const text = Buffer.from(JSON.stringify(json));
const jsonPadded = text.length + ((4 - (text.length % 4)) % 4);
const out = Buffer.alloc(28 + jsonPadded + offset, 0x20);
out.writeUInt32LE(0x46546c67, 0);
out.writeUInt32LE(2, 4);
out.writeUInt32LE(out.length, 8);
out.writeUInt32LE(jsonPadded, 12);
out.writeUInt32LE(0x4e4f534a, 16);
text.copy(out, 20);
out.writeUInt32LE(offset, 20 + jsonPadded);
out.writeUInt32LE(0x004e4942, 24 + jsonPadded);
let at = 28 + jsonPadded;
for (const part of parts) {
  Buffer.from(part.buffer, part.byteOffset, part.byteLength).copy(out, at);
  at += part.byteLength;
}
writeFileSync(`${OUT}${piece}.glb`, out);

// ---- point the manifest at it
const manifestPath = `${OUT}manifest.json`;
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { name: 'Models', pieces: {} };
const previous = manifest.pieces[piece] ?? {};
manifest.pieces[piece] = {
  file: `${piece}.glb`,
  scale: 1,
  yOffset: 0,
  rotationY: rotate,
  shading: 'smooth',
  // One lump with no arm to swing: the whole figure turns into the blow. Keep any hand-tuned values.
  strike: previous.blockout ? 'sweep' : (previous.strike ?? 'sweep'),
  rear: previous.blockout ? 0.22 : (previous.rear ?? 0.22),
};
const sculpted = Object.entries(manifest.pieces).filter(([, entry]) => !entry.blockout).map(([name]) => name);
manifest.name = 'Sculpted';
manifest.note = `Sculpted: ${sculpted.join(', ')}. The rest are blockouts of the built-in statues.`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const final = bounds(vertices);
console.log(`  read   ${before.toLocaleString('en-US')} triangles, ${(file.length / 1048576).toFixed(1)} MB`);
console.log(`  wrote  ${piece}.glb: ${(triangles.length / 3).toLocaleString('en-US')} triangles, ${(out.length / 1024).toFixed(0)} KB (simplification error ${error.toFixed(4)})`);
console.log(`  stands ${final.max[1].toFixed(2)} tall, ${(final.max[0] - final.min[0]).toFixed(2)} wide, ${(final.max[2] - final.min[2]).toFixed(2)} deep${shrunk ? ' (made smaller than asked so its base fits on a square)' : ''}`);
console.log(`  manifest: ${piece} -> ${piece}.glb, rotationY ${rotate}`);
