// The "Figures" set: each piece as a small glass statue of a person (or, for
// the knight, a war horse) on the same foot as the classic set. Drawn in the
// same 100 x 100 box and painted with the same glass material classes.
// Shapes are original to this project.

import type { ReactNode } from 'react';

export interface Artwork {
  body: ReactNode;
  detail?: ReactNode;
}

const FOOT = (
  <>
    <path className="pc-body" d="M27 85.5 C28 81.5 32 80 35 78.5 L65 78.5 C68 80 72 81.5 73 85.5 Z" />
    <rect className="pc-body" x="23" y="85" width="54" height="5.5" rx="2.4" />
  </>
);

const FOOT_LINES = <path className="pc-line" d="M28.5 85.4 H71.5" />;

export const FIGURE_ART: Record<'K' | 'Q' | 'R' | 'B' | 'N' | 'P', Artwork> = {
  // A foot soldier: domed helmet, round shield, spear.
  P: {
    body: (
      <>
        <rect className="pc-body" x="41" y="60" width="7.6" height="20" rx="2.2" />
        <rect className="pc-body" x="51.4" y="60" width="7.6" height="20" rx="2.2" />
        <path className="pc-body" d="M42 37 C38 38 37 42 37.5 47 L39.5 63 H60.5 L62.5 47 C63 42 62 38 58 37 Z" />
        <path className="pc-body" d="M57 38.5 L66.5 46.5 L63.5 50 L55 44 Z" />
        <circle className="pc-body" cx="50" cy="29.5" r="7.6" />
        <path className="pc-body" d="M41.2 28.5 C41.2 21 45 18 50 18 C55 18 58.8 21 58.8 28.5 Z" />
        <circle className="pc-body" cx="50" cy="16.8" r="1.9" />
        <rect className="pc-body" x="64.2" y="13" width="2.2" height="67" rx="1" />
        <path className="pc-body" d="M65.3 5.5 L68.5 14.5 H62.1 Z" />
        <circle className="pc-body" cx="39.5" cy="52" r="10.5" />
        {FOOT}
      </>
    ),
    detail: (
      <>
        {FOOT_LINES}
        <path className="pc-line" d="M41.5 28.8 H58.5" />
        <circle className="pc-line" cx="39.5" cy="52" r="6.8" />
        <circle className="pc-dot" cx="39.5" cy="52" r="1.8" />
      </>
    ),
  },
  // A tower that has stood up: battlement head, heavy shoulders, two fists.
  R: {
    body: (
      <>
        <path className="pc-body" d="M34 40 L35.5 79 H64.5 L66 40 Z" />
        <path className="pc-body" d="M32 41 C26 43 22.5 48.5 23 55 H29.5 C29.5 50.5 31 47.5 34.5 46 Z" />
        <path className="pc-body" d="M68 41 C74 43 77.5 48.5 77 55 H70.5 C70.5 50.5 69 47.5 65.5 46 Z" />
        <circle className="pc-body" cx="26" cy="58" r="6.2" />
        <circle className="pc-body" cx="74" cy="58" r="6.2" />
        <path className="pc-body" d="M30 20 H38.5 V26.5 H45.5 V20 H54.5 V26.5 H61.5 V20 H70 V41 H30 Z" />
        {FOOT}
      </>
    ),
    detail: (
      <>
        {FOOT_LINES}
        <path className="pc-mark" d="M41.5 33.5 H58.5" />
        <path className="pc-line" d="M35 52 H65 M35.5 64 H64.5 M50 41 V52 M43 52 V64 M57 52 V64 M50 64 V78" />
      </>
    ),
  },
  // The war horse, in barding.
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
          <path className="pc-line" d="M33 62 C44 60 56 62 70 66" />
          <path className="pc-line" d="M27 43 L38 46.5 M36 28 L43 33" />
          <circle className="pc-dot" cx="33.5" cy="35.5" r="2.2" />
          <circle className="pc-dot" cx="19.5" cy="51.5" r="1.2" />
        </g>
        <path className="pc-line" d="M29.5 85.4 H73" />
      </>
    ),
  },
  // A robed cleric: tall mitre, crozier.
  B: {
    body: (
      <>
        <path className="pc-body" d="M42 36 C37.5 37 36 41.5 36.5 47 L34 79 H66 L63.5 47 C64 41.5 62.5 37 58 36 Z" />
        <path className="pc-body" d="M57 38 L69.5 45 L67.5 49 L55.5 43 Z" />
        <circle className="pc-body" cx="50" cy="29" r="6.8" />
        <path className="pc-body" d="M50 6 C55.5 12 58 18 57 24 H43 C42 18 44.5 12 50 6 Z" />
        <rect className="pc-body" x="68.5" y="22" width="2.2" height="58" rx="1" />
        <path
          className="pc-body"
          d="M68.5 24 C68.5 13.5 80 13.5 80 21.5 C80 26 75.5 27.5 73.5 25 L75.2 23.5 C76.2 24.5 77.8 23.5 77.8 21.5 C77.8 16.5 70.7 16.5 70.7 24 Z"
        />
        {FOOT}
      </>
    ),
    detail: (
      <>
        {FOOT_LINES}
        <path className="pc-mark" d="M50 10.5 V21" />
        <path className="pc-line" d="M43 24.3 H57" />
        <path className="pc-line" d="M50 40 V78" />
        <path className="pc-line" d="M37 52 H63" />
      </>
    ),
  },
  // A queen: tined crown, fitted gown, sceptre.
  Q: {
    body: (
      <>
        <path
          className="pc-body"
          d="M43.5 36 C40.5 37 39.5 41 40.5 45 C42 49 44.5 51 45 54 L33.5 79 H66.5 L55 54 C55.5 51 58 49 59.5 45 C60.5 41 59.5 37 56.5 36 Z"
        />
        <path className="pc-body" d="M57 38.5 L71 46 L69.2 49.8 L55.5 43.5 Z" />
        <circle className="pc-body" cx="50" cy="29" r="6.5" />
        <path className="pc-body" d="M43 24 L41 11.5 L46 17.5 L50 8 L54 17.5 L59 11.5 L57 24 Z" />
        <circle className="pc-body" cx="41" cy="10" r="1.8" />
        <circle className="pc-body" cx="50" cy="6.5" r="2" />
        <circle className="pc-body" cx="59" cy="10" r="1.8" />
        <rect className="pc-body" x="70.2" y="30" width="2" height="50" rx="1" />
        <circle className="pc-body" cx="71.2" cy="27" r="3.8" />
        {FOOT}
      </>
    ),
    detail: (
      <>
        {FOOT_LINES}
        <path className="pc-line" d="M43.2 24.3 H56.8" />
        <path className="pc-line" d="M44.8 53.5 H55.2" />
        <path className="pc-line" d="M47 56 L41 78 M53 56 L59 78" />
        <circle className="pc-dot" cx="71.2" cy="27" r="1.4" />
      </>
    ),
  },
  // A king: crown and cross, broad cloak, sword held point-down.
  K: {
    body: (
      <>
        <path className="pc-body" d="M39.5 36 C34 37 32.5 42 33 48 L31.5 79 H68.5 L67 48 C67.5 42 66 37 60.5 36 Z" />
        <circle className="pc-body" cx="50" cy="28.5" r="7" />
        <path className="pc-body" d="M42.5 23.5 V14.5 L46.5 18 L50 14 L53.5 18 L57.5 14.5 V23.5 Z" />
        <path className="pc-body" d="M48.9 3.5 h2.2 v3.2 h3.2 v2.2 h-3.2 v6 h-2.2 v-6 h-3.2 v-2.2 h3.2 Z" />
        {FOOT}
      </>
    ),
    detail: (
      <>
        {FOOT_LINES}
        <path className="pc-line" d="M42.7 23.8 H57.3" />
        <path className="pc-line" d="M39.5 40 C37.5 52 37 66 36.5 78 M60.5 40 C62.5 52 63 66 63.5 78" />
        <path className="pc-mark" d="M50 44 V75 M44.5 49.5 H55.5" />
        <circle className="pc-dot" cx="50" cy="42.5" r="1.9" />
      </>
    ),
  },
};
