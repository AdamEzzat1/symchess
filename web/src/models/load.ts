// Sculpted piece models: reads a set's manifest, loads each .glb, and turns it
// into the same Sculpture the built-in statues are, so the board, the
// materials and every animation treat a sculpted piece exactly as they treat
// a built-in one. A piece with no model, or whose model fails, keeps its
// built-in statue: the board is never left with a piece missing.
//
// Shape only. A model's own materials are not used; the board paints every
// piece in its side's glass. A model says which parts glow by naming their
// material "glow", and which parts swing by putting them under a node named
// "arm". See docs/SCULPTED_PIECE_PIPELINE.md.

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { sculpture as builtIn, type Sculpture } from '../components/statues';

export const PIECES = { pawn: 'P', knight: 'N', bishop: 'B', rook: 'R', queen: 'Q', king: 'K' } as const;
export type PieceName = keyof typeof PIECES;

export interface PieceSpec {
  /** The .glb file, relative to the manifest. */
  file: string;
  /** Multiplies the model. A model made to the documented size needs 1. */
  scale?: number;
  /** Raises the model, in squares, after scaling. */
  yOffset?: number;
  /** Turns the model about the vertical, in degrees. 180 for a model that faces +Z, as glTF models do. */
  rotationY?: number;
  /** "flat" shows every facet (carved); "smooth" uses the model's normals. Default smooth. */
  shading?: 'flat' | 'smooth';
  /** The node whose contents swing as the weapon arm. Default "arm". */
  arm?: string;
  /** Shoulder angles for the wind-up and the blow, and the lean before it. Default: the built-in piece's. */
  windup?: number;
  hit?: number;
  rear?: number;
}

export interface Manifest {
  name: string;
  /** Shown beside the switch: what this set is, honestly. */
  note?: string;
  pieces: Partial<Record<PieceName, PieceSpec>>;
}

export interface StatueSet {
  name: string;
  note: string;
  /** The sculpture for a piece letter: the model's if it loaded, else the built-in one. */
  lookup: (kind: string) => Sculpture;
  loaded: PieceName[];
  /** Pieces listed in the manifest whose model could not be used, and why. */
  failed: { piece: PieceName; reason: string }[];
  /** Pieces the manifest does not list. */
  missing: PieceName[];
  triangles: number;
}

/** Enough checking to refuse a manifest that would do something odd. */
export function readManifest(value: unknown): Manifest {
  if (typeof value !== 'object' || value === null) throw new Error('the manifest is not an object');
  const raw = value as Record<string, unknown>;
  if (typeof raw.pieces !== 'object' || raw.pieces === null) throw new Error('the manifest lists no pieces');
  const pieces: Manifest['pieces'] = {};
  for (const [key, entry] of Object.entries(raw.pieces as Record<string, unknown>)) {
    if (!(key in PIECES)) throw new Error(`"${key}" is not a chess piece`);
    const spec = entry as Record<string, unknown> | null;
    if (typeof spec !== 'object' || spec === null || typeof spec.file !== 'string') throw new Error(`${key} names no file`);
    // A file beside the manifest, not an address somewhere else.
    if (!/^[\w][\w./-]*\.glb$/.test(spec.file) || spec.file.includes('..')) throw new Error(`${key}: "${spec.file}" is not a .glb beside the manifest`);
    for (const field of ['scale', 'yOffset', 'rotationY', 'windup', 'hit', 'rear'] as const) {
      if (spec[field] !== undefined && !Number.isFinite(spec[field])) throw new Error(`${key}: ${field} is not a number`);
    }
    if (spec.scale !== undefined && (spec.scale as number) <= 0) throw new Error(`${key}: scale must be positive`);
    pieces[key as PieceName] = spec as unknown as PieceSpec;
  }
  return {
    name: typeof raw.name === 'string' ? raw.name : 'Models',
    note: typeof raw.note === 'string' ? raw.note : undefined,
    pieces,
  };
}

const isUnder = (object: THREE.Object3D, ancestor: THREE.Object3D | undefined) => {
  for (let at: THREE.Object3D | null = object; at; at = at.parent) if (at === ancestor) return true;
  return false;
};

/** Position, normal and uv only, unindexed: what the merged statue geometry holds. */
function plain(source: THREE.BufferGeometry): THREE.BufferGeometry {
  const geometry = source.index ? source.toNonIndexed() : source.clone();
  const count = geometry.attributes.position!.count;
  for (const name of Object.keys(geometry.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') geometry.deleteAttribute(name);
  }
  geometry.morphAttributes = {};
  if (!geometry.attributes.normal) geometry.computeVertexNormals();
  if (!geometry.attributes.uv) geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
  return geometry;
}

/**
 * A loaded model as a Sculpture. `fallback` is the built-in piece, which
 * supplies whatever the model and its manifest entry leave unsaid.
 */
export function sculptureFromModel(root: THREE.Object3D, spec: PieceSpec, fallback: Sculpture): Sculpture {
  root.updateMatrixWorld(true);
  const scale = spec.scale ?? 1;
  const place = new THREE.Matrix4().compose(
    new THREE.Vector3(0, spec.yOffset ?? 0, 0),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(spec.rotationY ?? 0)),
    new THREE.Vector3(scale, scale, scale),
  );
  const armNode = root.getObjectByName(spec.arm ?? 'arm');
  const shoulder = armNode
    ? armNode.getWorldPosition(new THREE.Vector3()).applyMatrix4(place)
    : fallback.shoulder.clone();

  const bins = { body: [], gems: [], arm: [], armGems: [] } as Record<'body' | 'gems' | 'arm' | 'armGems', THREE.BufferGeometry[]>;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = plain(mesh.geometry).applyMatrix4(mesh.matrixWorld).applyMatrix4(place);
    const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
    const glows = /glow|gem|emissive/i.test(material?.name ?? '');
    if (isUnder(mesh, armNode)) {
      geometry.translate(-shoulder.x, -shoulder.y, -shoulder.z);
      bins[glows ? 'armGems' : 'arm'].push(geometry);
    } else {
      bins[glows ? 'gems' : 'body'].push(geometry);
    }
  });
  if (bins.body.length === 0) throw new Error('the model has no mesh outside its arm');
  const merged = (list: THREE.BufferGeometry[]) => (list.length === 0 ? null : mergeGeometries(list));
  return {
    body: merged(bins.body)!,
    gems: merged(bins.gems),
    arm: merged(bins.arm),
    armGems: merged(bins.armGems),
    shoulder,
    windup: spec.windup ?? fallback.windup,
    hit: spec.hit ?? fallback.hit,
    rear: spec.rear ?? fallback.rear,
    smooth: (spec.shading ?? 'smooth') === 'smooth',
  };
}

export function triangleCount(s: Sculpture): number {
  return [s.body, s.gems, s.arm, s.armGems].reduce((n, g) => n + (g ? g.attributes.position!.count / 3 : 0), 0);
}

/** Parse the bytes of one .glb into a Sculpture. */
export async function sculptureFromGlb(bytes: ArrayBuffer, spec: PieceSpec, fallback: Sculpture): Promise<Sculpture> {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  return sculptureFromModel(gltf.scene, spec, fallback);
}

/**
 * Build a set from a manifest and a way to fetch its files. Every piece gets
 * a sculpture whatever happens: its model's, or the built-in one.
 */
export async function buildStatueSet(manifest: Manifest, fetchFile: (file: string) => Promise<ArrayBuffer>): Promise<StatueSet> {
  const shapes = new Map<string, Sculpture>();
  const loaded: PieceName[] = [];
  const failed: StatueSet['failed'] = [];
  const missing: PieceName[] = [];
  let triangles = 0;
  await Promise.all(
    (Object.keys(PIECES) as PieceName[]).map(async (piece) => {
      const spec = manifest.pieces[piece];
      if (!spec) {
        missing.push(piece);
        return;
      }
      try {
        const shape = await sculptureFromGlb(await fetchFile(spec.file), spec, builtIn(PIECES[piece]));
        shapes.set(PIECES[piece], shape);
        triangles += triangleCount(shape);
        loaded.push(piece);
      } catch (error) {
        failed.push({ piece, reason: error instanceof Error ? error.message : String(error) });
      }
    }),
  );
  const order = Object.keys(PIECES);
  loaded.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return {
    name: manifest.name,
    note: manifest.note ?? '',
    lookup: (kind) => shapes.get(kind) ?? builtIn(kind),
    loaded,
    failed,
    missing,
    triangles,
  };
}

const sets = new Map<string, Promise<StatueSet>>();

/** The set whose manifest is at `manifestUrl`. Loaded once, then shared. */
export function loadStatueSet(manifestUrl: string): Promise<StatueSet> {
  let set = sets.get(manifestUrl);
  if (!set) {
    const base = manifestUrl.slice(0, manifestUrl.lastIndexOf('/') + 1);
    const get = async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response;
    };
    set = get(manifestUrl)
      .then((response) => response.json())
      .then((json) => buildStatueSet(readManifest(json), async (file) => (await get(base + file)).arrayBuffer()));
    // A failed load is not remembered: the next attempt tries again.
    set.catch(() => sets.delete(manifestUrl));
    sets.set(manifestUrl, set);
  }
  return set;
}
