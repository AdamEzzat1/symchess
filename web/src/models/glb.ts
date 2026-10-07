// Writes a sculpture as a binary glTF (.glb) file, laid out the way the model
// loader expects a sculpted piece to be laid out (see docs/SCULPTED_PIECE_PIPELINE.md).
//
// Used by scripts/export-statues.mjs to export the built-in statues. Those
// files are blockouts: the right size, pose and pivot for each piece, to
// sculpt over in a modelling program. They also prove the import path works
// before any sculpted model exists.

import * as THREE from 'three';
import type { Sculpture } from '../components/statues';

const FLOAT = 5126;
const ARRAY_BUFFER = 34962;

/** Names the loader looks for. */
export const GLASS = 'glass';
export const GLOW = 'glow';
export const ARM = 'arm';

/**
 * `name` becomes the root node. The file follows the glTF convention: +Y up,
 * the piece facing +Z, its base centred on the origin. The built-in statues
 * face -Z, so they are turned half a circle on the way out.
 */
export function sculptureToGlb(name: string, sculpture: Sculpture): Uint8Array {
  const chunks: Float32Array[] = [];
  const bufferViews: object[] = [];
  const accessors: object[] = [];
  let offset = 0;
  const turn = new THREE.Matrix4().makeRotationY(Math.PI);

  const accessor = (data: Float32Array, bounds: boolean) => {
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.byteLength, target: ARRAY_BUFFER });
    chunks.push(data);
    offset += data.byteLength;
    const entry: Record<string, unknown> = { bufferView: bufferViews.length - 1, componentType: FLOAT, count: data.length / 3, type: 'VEC3' };
    if (bounds) {
      const min = [Infinity, Infinity, Infinity];
      const max = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < data.length; i++) {
        min[i % 3] = Math.min(min[i % 3]!, data[i]!);
        max[i % 3] = Math.max(max[i % 3]!, data[i]!);
      }
      entry.min = min;
      entry.max = max;
    }
    accessors.push(entry);
    return accessors.length - 1;
  };

  const primitive = (source: THREE.BufferGeometry | null, material: number) => {
    if (!source) return null;
    const geometry = source.clone().applyMatrix4(turn);
    // Faceted normals, so the file looks in a modelling program as it does on the board.
    geometry.computeVertexNormals();
    return {
      attributes: {
        POSITION: accessor(new Float32Array(geometry.attributes.position!.array), true),
        NORMAL: accessor(new Float32Array(geometry.attributes.normal!.array), false),
      },
      material,
    };
  };

  const meshes: object[] = [];
  const mesh = (meshName: string, glass: THREE.BufferGeometry | null, glow: THREE.BufferGeometry | null) => {
    const primitives = [primitive(glass, 0), primitive(glow, 1)].filter((p) => p !== null);
    if (primitives.length === 0) return null;
    meshes.push({ name: meshName, primitives });
    return meshes.length - 1;
  };

  const body = mesh('body', sculpture.body, sculpture.gems);
  const arm = mesh('weapon', sculpture.arm, sculpture.armGems);
  const shoulder = sculpture.shoulder.clone().applyMatrix4(turn);
  const nodes: object[] = [
    { name, children: [1, 2] },
    { name: 'body', ...(body === null ? {} : { mesh: body }) },
    // The hinge of the weapon arm: what is under this node swings in a fight.
    { name: ARM, translation: shoulder.toArray(), ...(arm === null ? {} : { mesh: arm }) },
  ];

  const json = {
    asset: { version: '2.0', generator: 'SymChess export-statues' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes,
    meshes,
    materials: [
      { name: GLASS, pbrMetallicRoughness: { baseColorFactor: [0.8, 0.92, 0.96, 1], metallicFactor: 0.05, roughnessFactor: 0.4 } },
      { name: GLOW, pbrMetallicRoughness: { baseColorFactor: [0.22, 0.84, 1, 1] }, emissiveFactor: [0.22, 0.84, 1] },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: offset }],
  };

  const pad = (length: number) => (4 - (length % 4)) % 4;
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = text.length + pad(text.length);
  const total = 12 + 8 + jsonLength + 8 + offset;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true); // "glTF"
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, 0x4e4f534a, true); // "JSON"
  out.set(text, 20);
  out.fill(0x20, 20 + text.length, 20 + jsonLength);
  view.setUint32(20 + jsonLength, offset, true);
  view.setUint32(24 + jsonLength, 0x004e4942, true); // "BIN"
  let at = 28 + jsonLength;
  for (const chunk of chunks) {
    out.set(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength), at);
    at += chunk.byteLength;
  }
  return out;
}
