// Frosted glass pieces (ice and amethyst), drawn here as SVG: no glyphs, no
// image assets.
// Each piece is designed in a 100 x 100 box and stands on the same turned
// base, as a Staunton set does. Shapes are original to this project.
//
// Material: every piece is painted several times from the same parts --
//   1. rim    : the parts with a fat stroke; only what falls outside their
//               union stays visible, giving one outline around the whole piece
//   2. body   : ice or amethyst glass, lit from the upper left
//   3. shade  : darkening toward the foot
//   4. frost  : a soft light across the upper left
//   5. detail : the few engraved lines (arrow-slit, flame cut, petals, mane)

import { createContext, useContext } from 'react';
import { FIGURE_ART, type Artwork } from './PieceFigures';

export type PieceLetter = 'K' | 'Q' | 'R' | 'B' | 'N' | 'P';

export const PIECE_NAME: Record<string, string> = {
  K: 'king',
  Q: 'queen',
  R: 'rook',
  B: 'bishop',
  N: 'knight',
  P: 'pawn',
};

/** The foot every piece shares: a low plinth under an ogee (S-curved) rise. */
const BASE = (
  <>
    <path className="pc-body" d="M27 85.5 C28 81 33 79.5 37 78 L63 78 C67 79.5 72 81 73 85.5 Z" />
    <rect className="pc-body" x="23" y="85" width="54" height="5.5" rx="2.4" />
  </>
);

const BASE_LINES = <path className="pc-line" d="M28.5 85.4 H71.5" />;

/** The set's signature: a slender trumpet stem, `half` wide at its top. */
const stem = (top: number, half: number) => {
  const mid = top + (78 - top) * 0.55;
  return `M${50 - half} ${top} C${50 - half} ${mid} 40 72 36 78 L64 78 C60 72 ${50 + half} ${mid} ${50 + half} ${top} Z`;
};

/** The bead where a head meets its stem. */
const bead = (y: number, half: number) => (
  <rect className="pc-body" x={50 - half} y={y} width={half * 2} height="4" rx="2" />
);

/** Which drawn set to use. `figures` is the statue set in PieceFigures. */
export type PieceArt = 'classic' | 'figures';
export const PieceArtContext = createContext<PieceArt>('classic');

const ART: Record<PieceLetter, Artwork> = {
  // A pearl on a stem.
  P: {
    body: (
      <>
        <path className="pc-body" d={stem(45, 4.2)} />
        {bead(42.2, 8)}
        <circle className="pc-body" cx="50" cy="32.6" r="10.2" />
        {BASE}
      </>
    ),
    detail: BASE_LINES,
  },
  // A tower that flares at the crown, with one arrow-slit.
  R: {
    body: (
      <>
        <path className="pc-body" d="M40 38 C40.5 52 39.5 66 36 78 L64 78 C60.5 66 59.5 52 60 38 Z" />
        {bead(35, 14.5)}
        <path
          className="pc-body"
          d="M33 16.5 H39.8 L40.6 22.5 H46.4 L46.8 16.5 H53.2 L53.6 22.5 H59.4 L60.2 16.5 H67 L64.2 33 C63.9 35 62.2 36.4 60 36.4 H40 C37.8 36.4 36.1 35 35.8 33 Z"
        />
        {BASE}
      </>
    ),
    detail: (
      <>
        {BASE_LINES}
        <path className="pc-line" d="M36 28.6 H64" />
        <path className="pc-mark" d="M50 47 V57" />
      </>
    ),
  },
  N: {
    body: (
      <>
        <g transform="translate(1.5 5)">
          <path
            className="pc-body"
            d="M29 73.5 C27.5 64 32 59 37 54.5 C33.5 57 29.5 59.5 25 59.5 C19.5 59.5 15.5 56 16 51 C16.4 47.5 20 44 24.5 39.5 C29 35 33 30 36 24.5 L41 13.5 L47.5 21 C60 23 71.5 35 73 51 C74 60 72 67.5 69.5 73.5 Z"
          />
        </g>
        <path className="pc-body" d="M27.5 85.5 C28.5 82 30 80 31.5 78 L71 78 C72.5 80 74 82 75 85.5 Z" />
        <rect className="pc-body" x="24" y="85" width="54.5" height="5.5" rx="2.4" />
      </>
    ),
    detail: (
      <>
        <g transform="translate(1.5 5)">
          <path className="pc-line" d="M37 54.5 C42.5 50 43 43 38.5 39" />
          <path className="pc-line" d="M55 27.5 C63 35.5 67 47.5 66 61" />
          <path className="pc-line" d="M50 31.5 C56 38 59 47 58.5 57" />
          <path className="pc-line" d="M17.5 56 L24.5 54.5" />
          <circle className="pc-dot" cx="33.5" cy="35.5" r="2.2" />
          <circle className="pc-dot" cx="19.5" cy="51.5" r="1.2" />
        </g>
        <path className="pc-line" d="M29.5 85.4 H73" />
      </>
    ),
  },
  // A flame, with a single curved cut.
  B: {
    body: (
      <>
        <path className="pc-body" d={stem(52, 4.6)} />
        {bead(49, 9.5)}
        <path
          className="pc-body"
          d="M50 10 C52 17 62.5 26 62.5 37.5 C62.5 45.2 57 50.5 50 50.5 C43 50.5 37.5 45.2 37.5 37.5 C37.5 26 48 17 50 10 Z"
        />
        {BASE}
      </>
    ),
    detail: (
      <>
        {BASE_LINES}
        <path className="pc-mark" d="M56 25.5 C53 31.5 49 35.5 44.5 38" />
      </>
    ),
  },
  // A tiara of slim tines, each tipped with a pearl.
  Q: {
    body: (
      <>
        <path className="pc-body" d={stem(54.5, 4.8)} />
        {bead(51, 10)}
        <path
          className="pc-body"
          d="M43.5 52.5 C42 44 34 38.5 27.5 33.5 L25.5 22 C29 29 30.5 32 32 32 C33.5 32 36 25 38 15.5 C40 25 42 31 44 31 C46 31 48.5 22 50 11.5 C51.5 22 54 31 56 31 C58 31 60 25 62 15.5 C64 25 66.5 32 68 32 C69.5 32 71 29 74.5 22 L72.5 33.5 C66 38.5 58 44 56.5 52.5 Z"
        />
        <circle className="pc-body" cx="25" cy="20" r="2.7" />
        <circle className="pc-body" cx="38" cy="13.5" r="2.7" />
        <circle className="pc-body" cx="50" cy="9.3" r="2.9" />
        <circle className="pc-body" cx="62" cy="13.5" r="2.7" />
        <circle className="pc-body" cx="75" cy="20" r="2.7" />
        {BASE}
      </>
    ),
    detail: (
      <>
        {BASE_LINES}
        <path className="pc-line" d="M32.5 37.5 Q50 44.5 67.5 37.5" />
      </>
    ),
  },
  // A tulip bud under a slim cross.
  K: {
    body: (
      <>
        <path className="pc-body" d={stem(54.5, 4.8)} />
        {bead(51, 10)}
        <path className="pc-body" d="M48.5 5.5 h3 v5.2 h5 v3 h-5 v19.5 h-3 v-19.5 h-5 v-3 h5 Z" />
        <path
          className="pc-body"
          d="M43 52.5 C34 47 28.5 38 31 30 C32.5 25.3 36.8 22.8 41 24 C45.2 25.2 48.5 28.5 50 33 C51.5 28.5 54.8 25.2 59 24 C63.2 22.8 67.5 25.3 69 30 C71.5 38 66 47 57 52.5 Z"
        />
        {BASE}
      </>
    ),
    detail: (
      <>
        {BASE_LINES}
        <path className="pc-line" d="M50 33.5 C49 40 49 46 50 51.5" />
        <path className="pc-line" d="M38 27.5 C35.8 35 38 43.5 44.5 50.5" />
        <path className="pc-line" d="M62 27.5 C64.2 35 62 43.5 55.5 50.5" />
      </>
    ),
  },
};

/**
 * Gradients and the per-square glass sheen. Rendered once, in a zero-size SVG
 * at the app root, and referenced by id from the board and from piece icons.
 */
export function SvgDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true" focusable="false">
      <defs>
        {/* Ice: cyan-tinted frosted glass, lit from the upper left. */}
        <linearGradient id="pc-ice" gradientUnits="userSpaceOnUse" x1="18" y1="20" x2="82" y2="90">
          <stop offset="0" stopColor="#f0fbff" />
          <stop offset="0.45" stopColor="#c4e4f2" />
          <stop offset="1" stopColor="#84b6cc" />
        </linearGradient>
        {/* Amethyst: deep violet glass. */}
        <linearGradient id="pc-amethyst" gradientUnits="userSpaceOnUse" x1="18" y1="20" x2="82" y2="90">
          <stop offset="0" stopColor="#5a4690" />
          <stop offset="0.45" stopColor="#2a2050" />
          <stop offset="1" stopColor="#110c24" />
        </linearGradient>
        {/* The frost: a soft bloom of light across the upper-left of a piece. */}
        <radialGradient id="pc-frost" gradientUnits="userSpaceOnUse" cx="40" cy="30" r="36">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.42" />
          <stop offset="0.5" stopColor="#ffffff" stopOpacity="0.1" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </radialGradient>
        {/* Shade gathered toward the foot, so the piece sits on the board. */}
        <linearGradient id="pc-shade" gradientUnits="userSpaceOnUse" x1="0" y1="40" x2="0" y2="92">
          <stop offset="0" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.2" />
        </linearGradient>
        <linearGradient id="sq-glass" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.13" />
          <stop offset="0.4" stopColor="#ffffff" stopOpacity="0" />
          <stop offset="0.6" stopColor="#000000" stopOpacity="0" />
          <stop offset="1" stopColor="#000000" stopOpacity="0.26" />
        </linearGradient>
      </defs>
    </svg>
  );
}

interface ShapeProps {
  /** Engine piece code: colour letter + piece letter, e.g. "wK". */
  code: string;
}

/** The piece artwork in its own 100 x 100 coordinate space. */
export function PieceShape({ code }: ShapeProps) {
  const letter = (code[1] ?? 'P') as PieceLetter;
  const table = useContext(PieceArtContext) === 'figures' ? FIGURE_ART : ART;
  const art = table[letter] ?? table.P;
  return (
    <g className={code[0] === 'w' ? 'pc pc-white' : 'pc pc-black'}>
      <ellipse className="pc-shadow" cx="52" cy="90.5" rx="31" ry="4.6" />
      <g className="pc-layer-rim">{art.body}</g>
      <g className="pc-layer-body">{art.body}</g>
      <g className="pc-layer-shade">{art.body}</g>
      <g className="pc-layer-frost">{art.body}</g>
      {art.detail && <g className="pc-layer-detail">{art.detail}</g>}
    </g>
  );
}

/** A piece as a standalone inline icon (captured pieces, promotion picker). */
export function PieceIcon({ code, size = 22 }: ShapeProps & { size?: number }) {
  return (
    <svg className="piece-icon" viewBox="0 0 100 100" width={size} height={size} aria-hidden="true" focusable="false">
      <PieceShape code={code} />
    </svg>
  );
}

/** Development aid: every piece, large, on both square colours (open /#pieces). */
export function PieceSheet() {
  const letters: PieceLetter[] = ['K', 'Q', 'R', 'B', 'N', 'P'];
  return (
    <div className="piece-sheet">
      <SvgDefs />
      {(['classic', 'figures'] as const).map((art) => (
        <PieceArtContext.Provider key={art} value={art}>
          {(['w', 'b'] as const).map((side) => (
            <div key={side} className="piece-sheet-row">
              {letters.map((letter, i) => (
                <svg key={letter} viewBox="0 0 100 100" className="piece-sheet-cell">
                  <rect width="100" height="100" className={(i + (side === 'w' ? 0 : 1)) % 2 ? 'sq-dark' : 'sq-light'} />
                  <rect width="100" height="100" fill="url(#sq-glass)" />
                  <g transform="translate(5 3) scale(0.9)">
                    <PieceShape code={`${side}${letter}`} />
                  </g>
                </svg>
              ))}
            </div>
          ))}
        </PieceArtContext.Provider>
      ))}
    </div>
  );
}
