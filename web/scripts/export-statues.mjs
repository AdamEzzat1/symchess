// Writes the built-in 3D statues out as .glb files, with a manifest.
//
//   npm run export-statues            (from web/)
//
// Writes web/public/models/chess/statues/{pawn,knight,bishop,rook,queen,king}.glb
// and manifest.json. These are BLOCKOUTS, not sculpted models: the built-in
// shapes at the right size, pose and pivot, to open in a modelling program
// and sculpt over. They are also what the "Models" switch on the 3D board
// loads until real models replace them, which proves the import path.
//
// A piece's entry in an existing manifest is left alone unless its file is one
// this script wrote before, so a sculpted model dropped in is never overwritten.
// See docs/SCULPTED_PIECE_PIPELINE.md.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const OUT = fileURLToPath(new URL('../public/models/chess/statues/', import.meta.url));
const NOTE = 'Blockouts exported from the built-in statues, not sculpted models.';

// Vite loads the TypeScript sources; nothing is served.
const vite = await createServer({ server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { sculpture } = await vite.ssrLoadModule('/src/components/statues.ts');
  const { sculptureToGlb } = await vite.ssrLoadModule('/src/models/glb.ts');
  const { PIECES, triangleCount } = await vite.ssrLoadModule('/src/models/load.ts');

  mkdirSync(OUT, { recursive: true });
  const manifestPath = `${OUT}manifest.json`;
  const manifest = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { name: 'Blockout', note: NOTE, pieces: {} };

  for (const [piece, letter] of Object.entries(PIECES)) {
    const entry = manifest.pieces[piece];
    if (entry && !entry.blockout) {
      console.log(`  kept  ${piece}: the manifest points at ${entry.file}, which this script did not write`);
      continue;
    }
    const shape = sculpture(letter);
    const bytes = sculptureToGlb(piece, shape);
    writeFileSync(`${OUT}${piece}.glb`, bytes);
    // Faces +Z in the file, as glTF models do; the board's pieces face -Z.
    manifest.pieces[piece] = { file: `${piece}.glb`, scale: 1, yOffset: 0, rotationY: 180, shading: 'flat', blockout: true };
    console.log(`  wrote ${piece}.glb  ${triangleCount(shape).toLocaleString('en-US')} triangles, ${(bytes.length / 1024).toFixed(0)} KB`);
  }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`  wrote manifest.json`);
} finally {
  await vite.close();
}
