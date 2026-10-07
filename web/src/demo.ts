// The guided tour: five prepared positions, each showing one idea.
//
// A step is a script of ordinary commands (load this position, start a search,
// open this card). Everything the visitor then sees is whatever the engine and
// Prolog actually answer; nothing here states a fact about a position.

import type { Color, Mode } from './protocol';

export type PanelTab = 'reasoning' | 'plan' | 'variations' | 'facts';

export interface DemoStep {
  id: string;
  title: string;
  /** Says what to look at and which program produced it. */
  caption: string;
  fen: string;
  mode: Mode;
  /** In play mode: the side the visitor has. The engine moves for the other. */
  humanColor?: Color;
  tab?: PanelTab;
  /** Open the first fact or plan of this kind in the inspector. */
  select?: { kind: 'fact' | 'plan'; of: string };
  /** Start a search as soon as the position has loaded. */
  analyse?: boolean;
  /** Then step through the line the search expects. */
  replay?: boolean;
  /** Offer the three difficulty levels on this position. */
  levels?: boolean;
}

const FORK = 'r1bqk2r/pppp1ppp/2n2n2/2b1p1N1/2B1P3/8/PPPP1PPP/RNBQK2R w KQkq - 6 5';

export const DEMO: DemoStep[] = [
  {
    id: 'pin',
    title: 'Prolog reads the board',
    caption:
      'No search has run yet. Prolog, a logic language, looked at the position and reported a pin: the knight on c6 cannot move without exposing its king. The purple line on the board is that fact, drawn.',
    fen: 'r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4',
    mode: 'analysis',
    tab: 'reasoning',
    select: { kind: 'fact', of: 'pin' },
  },
  {
    id: 'fork',
    title: 'The search checks Prolog’s ideas',
    caption:
      'Now the Lisp engine searches. On the right, each sentence is tagged: “confirmed” where the search’s line cashes in an idea Prolog found (the knight fork), “overruled” where the search disagreed with Prolog’s first choice.',
    fen: FORK,
    mode: 'analysis',
    tab: 'variations',
    analyse: true,
  },
  {
    id: 'line',
    title: 'Why this move?',
    caption:
      'The same position, played forward. Step through the line the engine expects with the arrows on the right: each position shows what Prolog sees in it, so you can watch the fork appear and pay off.',
    fen: FORK,
    mode: 'analysis',
    tab: 'variations',
    analyse: true,
    replay: true,
  },
  {
    id: 'plan',
    title: 'From a fact to a plan',
    caption:
      'Prolog noticed the black king has no escape square, and turned that into advice: look for a check on the back rank. That is a suggestion, not a proof. Prove it yourself: move the rook from d1 to d8.',
    fen: '6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1',
    mode: 'analysis',
    tab: 'plan',
    select: { kind: 'plan', of: 'back_rank' },
  },
  {
    id: 'levels',
    title: 'Three strengths, honestly different',
    caption:
      'The engine plays White here. Pick a level and it moves: Novice looks three half-moves ahead with a simple evaluation and may choose a slightly worse move; Club and Expert look deeper. The panel says exactly what each one did.',
    fen: 'r2qkb1r/ppp2ppp/2n1bn2/3pp3/4P3/1B3N2/PPPP1PPP/RNBQ1RK1 w kq - 0 6',
    mode: 'play',
    humanColor: 'black',
    levels: true,
  },
];
