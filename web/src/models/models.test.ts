import { describe, expect, it } from 'vitest';
import { sculpture } from '../components/statues';
import { sculptureToGlb } from './glb';
import { buildStatueSet, PIECES, readManifest, sculptureFromGlb, triangleCount, type Manifest } from './load';

const bytesOf = (kind: string, name: string) => {
  const glb = sculptureToGlb(name, sculpture(kind));
  return glb.buffer.slice(glb.byteOffset, glb.byteOffset + glb.byteLength) as ArrayBuffer;
};
/** The entry the exporter writes: a model that faces +Z, turned to face the board's way. */
const exported = (file: string) => ({ file, rotationY: 180, shading: 'flat' as const });

describe('a statue written as .glb and read back', () => {
  it('is a binary glTF file of the stated length', () => {
    const glb = sculptureToGlb('rook', sculpture('R'));
    const view = new DataView(glb.buffer, glb.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x46546c67);
    expect(view.getUint32(4, true)).toBe(2);
    expect(view.getUint32(8, true)).toBe(glb.byteLength);
  });

  it('has the same triangles, in the same four parts', async () => {
    for (const kind of Object.values(PIECES)) {
      const built = sculpture(kind);
      const read = await sculptureFromGlb(bytesOf(kind, 'piece'), exported('piece.glb'), built);
      expect(triangleCount(read)).toBe(triangleCount(built));
      expect(read.gems === null).toBe(built.gems === null);
      expect(read.arm === null).toBe(built.arm === null);
      expect(read.armGems === null).toBe(built.armGems === null);
    }
  });

  it('keeps its size, and its shoulder where the arm hinges', async () => {
    const built = sculpture('K');
    const read = await sculptureFromGlb(bytesOf('K', 'king'), exported('king.glb'), built);
    expect(read.shoulder.distanceTo(built.shoulder)).toBeLessThan(1e-5);
    built.body.computeBoundingBox();
    read.body.computeBoundingBox();
    expect(read.body.boundingBox!.max.y).toBeCloseTo(built.body.boundingBox!.max.y, 4);
    expect(read.body.boundingBox!.min.z).toBeCloseTo(built.body.boundingBox!.min.z, 4);
  });

  it('is scaled, raised and turned as its manifest entry says', async () => {
    const built = sculpture('P');
    built.body.computeBoundingBox();
    const read = await sculptureFromGlb(bytesOf('P', 'pawn'), { file: 'pawn.glb', scale: 2, yOffset: 0.5, rotationY: 180 }, built);
    read.body.computeBoundingBox();
    expect(read.body.boundingBox!.max.y).toBeCloseTo(built.body.boundingBox!.max.y * 2 + 0.5, 4);
    expect(read.shoulder.y).toBeCloseTo(built.shoulder.y * 2 + 0.5, 4);
    expect(read.smooth).toBe(true); // the default for a sculpted model
  });

  it('takes its fight from the built-in piece unless the manifest says otherwise', async () => {
    const built = sculpture('B');
    const plain = await sculptureFromGlb(bytesOf('B', 'bishop'), exported('bishop.glb'), built);
    expect([plain.windup, plain.hit, plain.rear]).toEqual([built.windup, built.hit, built.rear]);
    const tuned = await sculptureFromGlb(bytesOf('B', 'bishop'), { ...exported('bishop.glb'), windup: 1, hit: -1, rear: 0 }, built);
    expect([tuned.windup, tuned.hit, tuned.rear]).toEqual([1, -1, 0]);
  });
});

describe('a model set', () => {
  const manifest: Manifest = {
    name: 'Test',
    pieces: { rook: exported('rook.glb'), queen: exported('queen.glb'), king: exported('king.glb') },
  };
  const files: Record<string, () => ArrayBuffer> = {
    'rook.glb': () => bytesOf('R', 'rook'),
    'queen.glb': () => new TextEncoder().encode('this is not a model').buffer as ArrayBuffer,
  };
  const fetchFile = async (file: string) => {
    const make = files[file];
    if (!make) throw new Error(`${file}: 404`);
    return make();
  };

  it('uses a model where one loads and the built-in statue everywhere else', async () => {
    const set = await buildStatueSet(manifest, fetchFile);
    expect(set.loaded).toEqual(['rook']);
    expect(set.failed.map((f) => f.piece).sort()).toEqual(['king', 'queen']);
    expect(set.missing.sort()).toEqual(['bishop', 'knight', 'pawn']);
    // A broken file and an absent one both leave the built-in statue in place.
    expect(set.lookup('Q')).toBe(sculpture('Q'));
    expect(set.lookup('K')).toBe(sculpture('K'));
    expect(set.lookup('P')).toBe(sculpture('P'));
    expect(set.lookup('R')).not.toBe(sculpture('R'));
    expect(set.triangles).toBe(triangleCount(sculpture('R')));
  });

  it('says why a model was not used', async () => {
    const set = await buildStatueSet(manifest, fetchFile);
    expect(set.failed.find((f) => f.piece === 'king')!.reason).toContain('404');
    expect(set.failed.find((f) => f.piece === 'queen')!.reason.length).toBeGreaterThan(0);
  });

  it('with an empty manifest is simply the built-in statues', async () => {
    const set = await buildStatueSet({ name: 'Empty', pieces: {} }, fetchFile);
    expect(set.loaded).toEqual([]);
    expect(set.missing).toHaveLength(6);
    for (const kind of Object.values(PIECES)) expect(set.lookup(kind)).toBe(sculpture(kind));
  });
});

describe('a manifest', () => {
  it('is read with its pieces', () => {
    const manifest = readManifest({ name: 'Relic', note: 'first pass', pieces: { pawn: { file: 'pawn.glb', scale: 1.1 } } });
    expect(manifest.name).toBe('Relic');
    expect(manifest.pieces.pawn!.scale).toBe(1.1);
  });

  it('is refused if it names something that is not a piece, or a file that is not a .glb beside it', () => {
    expect(() => readManifest(null)).toThrow();
    expect(() => readManifest({ name: 'x' })).toThrow();
    expect(() => readManifest({ pieces: { dragon: { file: 'dragon.glb' } } })).toThrow(/not a chess piece/);
    expect(() => readManifest({ pieces: { pawn: {} } })).toThrow(/names no file/);
    expect(() => readManifest({ pieces: { pawn: { file: 'https://example.com/pawn.glb' } } })).toThrow(/beside the manifest/);
    expect(() => readManifest({ pieces: { pawn: { file: '../pawn.glb' } } })).toThrow(/beside the manifest/);
    expect(() => readManifest({ pieces: { pawn: { file: 'pawn.glb', scale: 0 } } })).toThrow(/scale/);
    expect(() => readManifest({ pieces: { pawn: { file: 'pawn.glb', rotationY: 'half' } } })).toThrow(/rotationY/);
  });
});
