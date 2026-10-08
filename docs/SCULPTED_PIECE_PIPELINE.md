# Sculpted piece pipeline

How a sculpted 3D chess piece gets from a modelling program onto the SymChess 3D board, and what state that path is in.

## Where this stands

- **Built:** the import path. The 3D board can load a `.glb` model for each piece type, paint it in the side's glass, and animate it exactly as it animates the built-in statues. A switch under Pieces chooses between **Built-in** and **Models**.
- **One sculpted model so far: the queen.** It was generated outside the project with an image-to-3D tool (Meshy) and prepared with `npm run prepare-model` (below): 983,426 triangles and 34 MB of textures became 19,994 triangles and 469 KB, painted in the board's own glass. It is one lump: it has no separate weapon arm and no glowing parts.
- **The other five are blockouts.** Their `.glb` files in `web/public/models/chess/statues/` are the built-in statues, exported by a script. They exist to prove the path works end to end and to give a modeller the right size, pose and pivot to sculpt over. They look the same as the built-in statues, and the line under the board says which pieces are which.
- **Models is the default** for the 3D board, so a piece with a sculpted model shows it.
- **The reference picture** (carved stone figures: foot soldier, mounted knight, robed bishop, tower, crowned queen, armoured king) is 2D concept art. It was used as art direction for the built-in statues. It has not been converted into 3D models, and nothing here does that. Getting from that picture to production models is modelling work, described under "Making the models".

## How it works

A loaded model is turned into the same structure the built-in statues are (a `Sculpture`: a body, a hinged weapon arm, and the small glowing parts of each). Everything downstream is shared: the board places it, the engine's position decides where it stands, and the fight, shatter, checkmate and promotion animations move it. React and Three.js still decide nothing about chess.

- `web/src/models/load.ts`: reads the manifest, loads each `.glb`, converts it, and falls back.
- `web/src/models/glb.ts` and `web/scripts/export-statues.mjs`: write the built-in statues out as `.glb` blockouts.
- `web/src/components/statues.ts`: the built-in statues, which remain the default and the fallback.

**Fallback.** A piece keeps its built-in statue if the manifest does not list it, its file is missing, or its file cannot be read as a model. If the manifest itself is missing or malformed, every piece stays built-in. The board is never left with a piece missing. The line under the 3D board reports what happened, for example "4 of 6 pieces from models · built-in statue kept for queen, king".

## Adding a model

**From a raw file out of a sculpting or image-to-3D tool,** which is usually far too heavy and carries textures the board does not use:

```bash
npm --prefix web run prepare-model -- path/to/raw.glb queen
```

This strips materials and textures, welds the vertices, cuts the triangle count to the piece's budget, stands the model on the origin at the piece's height (smaller if its base would not fit a square), recomputes smooth normals, writes `web/public/models/chess/statues/queen.glb` and points the manifest at it. Options: `--triangles N`, `--height H` (in squares), `--rotate DEG` (default 180, for a model that faces +Z). It does not separate a weapon arm or mark glowing parts; a model that comes as one lump has neither.

**From a model already made to the requirements below:**

1. Export the model as `web/public/models/chess/statues/<piece>.glb`, where `<piece>` is `pawn`, `knight`, `bishop`, `rook`, `queen` or `king`. One file per piece type: both sides use the same shape.
2. Point the manifest at it (`web/public/models/chess/statues/manifest.json`):

   ```json
   {
     "name": "Relic",
     "note": "Knight sculpted; the rest are blockouts.",
     "pieces": {
       "knight": { "file": "knight.glb", "scale": 1, "yOffset": 0, "rotationY": 180, "shading": "smooth" }
     }
   }
   ```

   Remove `"blockout": true` from an entry you have replaced. The export script rewrites only entries that still carry it, so it will not overwrite your model.
3. Start the app, choose **3D** and then **Models** under Pieces (or open `/?pieces=3d&statues=models`). To look at the pieces closely, add `&closeup=front` or `&closeup=back` and a position with the pieces on white's back rank.

Manifest fields, per piece:

| Field | Meaning | Default |
| --- | --- | --- |
| `file` | The `.glb`, beside the manifest. Addresses elsewhere are refused | required |
| `scale` | Multiplies the model | 1 |
| `yOffset` | Raises it, in squares, after scaling | 0 |
| `rotationY` | Turns it about the vertical, in degrees. 180 for a model that faces +Z, as glTF models do | 0 |
| `shading` | `smooth` uses the model's normals; `flat` shows every facet | `smooth` |
| `arm` | Name of the node that swings as the weapon arm | `arm` |
| `windup`, `hit`, `rear` | Shoulder angles (radians) for the wind-up and the blow, and how far the body leans back first | the built-in piece's |

## What a model has to be

**Size and placement.**

- One unit is one square of the board. The base must fit inside a circle of radius 0.42 around the origin.
- The origin is the centre of the underside of the base. The model stands on the plane y = 0 (glTF's up axis; Blender's Z).
- It faces +Z in the file (Blender's -Y, the default front view), and the manifest turns it with `rotationY: 180`.
- Heights of the built-in set, as a guide: pawn 0.9, rook 0.95, knight 1.25, king 1.35, and bishop 1.45 and queen 1.6 to the tops of their staffs.

**Materials.** The board does not use a model's own materials or textures. Every piece is painted in the side's glass (ice for White, amethyst for Black), which is what keeps the set in the app's colours. A model communicates through names:

- A material whose name contains `glow`, `gem` or `emissive` marks the parts that glow in the side's accent colour: eyes, jewels, windows, a crown's cross.
- Every other material is glass.

**The weapon arm.** Parts placed under a node (in Blender, an empty or parent object) named `arm` swing as one piece in a fight, hinged at that node's origin. Put the origin at the shoulder. A model with no `arm` node still works: it leans back and lunges, as the rook does.

**Budget.**

| Piece | Triangles |
| --- | --- |
| Pawn | 2,000 to 5,000 |
| Bishop, rook | 5,000 to 10,000 |
| Knight, queen, king | 10,000 to 20,000 |

A full board is 16 pawns and 16 pieces, so the pawn matters most. Aim for under about 250,000 triangles on the board. For comparison the blockouts are 900 to 4,900 each and a full board of them is about 80,000. Each statue is drawn in at most four draw calls however detailed it is, because its parts are merged on load.

**Not supported yet.**

- Textures of any kind, including normal maps. Detail has to be in the geometry or come from the glass material. Supporting a normal map would mean keeping the model's UVs (they are kept) and adding the map to the glass material per piece type; it is a contained change that has not been made.
- Skeletal rigs and animation clips. Animation is done by moving the whole statue and its one arm. A rigged model loads, but only in its rest pose.
- Different models for the two sides.
- Compressed files (Draco or Meshopt). The loader is the plain glTF loader.

## Making the models

Three realistic ways to get from the reference picture to a model. All of them end in a modelling program.

**A. Sculpt by hand (best result, most work).** Set the reference up as a background image. Import the piece's blockout `.glb` for scale, pose and the `arm` pivot. Sculpt at high detail, retopologise down to the budget, and export. Without texture support, bake nothing: keep the forms large enough to read in the geometry.

**B. Image-to-3D draft, then clean up (fastest start, messy).** Crop one figure from the reference and run it through an image-to-3D tool. Expect a lumpy mesh with a fused base, no clean back, far too many triangles and baked-in stone colour. In Blender: scale it to the blockout, cut it free of its base and give it the plinth, decimate or retopologise to the budget, separate the weapon arm and parent it to an `arm` empty, delete the textures, assign `glass` and `glow` materials. The tool's output is a starting lump, not a finished piece.

**C. Low-poly stylised sculpt (recommended).** Model each piece directly at the budget, starting from the blockout: clear silhouettes, large facets, no fine surface detail. This suits the app, where a piece is about a hundred pixels tall and is drawn in translucent glass that hides small detail anyway. Use `"shading": "flat"` for a carved look or `"smooth"` for a polished one.

What matters at board size, in order: the silhouette from the front and from behind (a player sees the backs of their own pieces), the height differences between piece types, then the head and what it carries. Faces and cloth texture do not survive.

## Blender export settings

File, Export, glTF 2.0:

- Format: **glTF Binary (.glb)**.
- Include: Selected Objects, with the piece and its `arm` empty selected.
- Transform: **+Y Up** on.
- Mesh: Apply Modifiers on; UVs and Normals on; Vertex Colours off.
- Material: Export (the names are what is read); Images: None.
- Animation: off.
- Compression: off.

Before exporting: apply scale and rotation (Ctrl+A) on the meshes, name the materials, and check the origin is at the centre of the base.

## Checking a model

```bash
npm --prefix web test
```

runs the loader's tests, including a round trip of every built-in statue through a real `.glb` file. Then, with the engine and the dev server running:

- `/?pieces=3d&statues=models`: the line under the board says how many pieces came from models and the triangle count.
- Play a capture: the weapon arm should swing from the shoulder and the taken piece should break.
- `npm --prefix web run screenshots` writes `docs/screenshots/board-3d-models.png`.

To regenerate the blockouts after the built-in statues change:

```bash
npm --prefix web run export-statues
```

## Later

- **Compression.** `gltf-transform optimize` (Meshopt or Draco) cuts file size several times over. It needs the matching decoder registered on the loader in `load.ts`, which is a few lines and a small extra download.
- **Normal maps**, as described above, if a sculpt needs surface detail the geometry cannot afford.
- **Per-side models**, if the two armies should differ in more than colour.
- **Frame rate** has not been measured, on a desktop or a phone, for either the built-in statues or heavier models. Measure before raising the budget.
