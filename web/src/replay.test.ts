import { describe, expect, it } from 'vitest';
import { DEMO } from './demo';
import type { GameState, LineStep, MessageOf, ServerMessage } from './protocol';
import { parseServerMessage } from './protocol';
import { replayPositionId, replayView, stepLabels } from './replay';
import { selectFocus, selectViz } from './selectViz';
import { initialState, reducer, type AppState } from './state';

const game = (positionId: number, seq: number, history = 0): GameState => ({
  type: 'game_state',
  seq,
  positionId,
  fen: 'start',
  board: { e1: 'wK', e8: 'bK', b5: 'wN' },
  turn: 'white',
  moveNumber: 5,
  check: null,
  lastMove: null,
  history: Array.from({ length: history }, (_, i) => ({ ply: i + 1, san: 'x', uci: 'e2e4', by: 'human' as const })),
  legalMoves: [{ uci: 'b5c7', san: 'Nc7+', from: 'b5', to: 'c7', promotion: null, capture: false }],
  status: 'active',
  winner: null,
  clocks: { enabled: false, whiteMs: 0, blackMs: 0, incrementMs: 0, running: null },
  settings: { mode: 'analysis', humanColor: 'white', depth: 6, moveTimeMs: 2000 },
  captured: { white: [], black: [] },
  engineThinking: false,
});

const move = (san: string, from: string, to: string) => ({ uci: from + to, san, from, to, promotion: null, capture: false });

const steps: LineStep[] = [
  { move: null, by: null, fen: 'f0', board: { e1: 'wK', e8: 'bK', b5: 'wN' }, turn: 'white', check: null, checkmate: false, symbolic: true, facts: [] },
  {
    move: move('Nc7+', 'b5', 'c7'),
    by: 'white',
    fen: 'f1',
    board: { e1: 'wK', e8: 'bK', c7: 'wN' },
    turn: 'black',
    check: 'e8',
    checkmate: false,
    symbolic: true,
    facts: [
      {
        id: 'f1',
        kind: 'fork',
        side: 'white',
        squares: ['c7', 'e8'],
        text: 'fork',
        use: 'explanation',
        viz: [{ type: 'arrow', from: 'c7', to: 'e8', style: 'threat' }],
      },
    ],
  },
  { move: move('Kd8', 'e8', 'd8'), by: 'black', fen: 'f2', board: { e1: 'wK', d8: 'bK', c7: 'wN' }, turn: 'white', check: null, checkmate: false, symbolic: true, facts: [] },
];

const explanation = (positionId: number, searchId: number, seq: number): MessageOf<'explanation'> => ({
  type: 'explanation',
  seq,
  positionId,
  searchId,
  move: move('Nc7+', 'b5', 'c7'),
  summary: 's',
  items: [],
});
const line = (searchId: number, seq: number): MessageOf<'line_replay'> => ({ type: 'line_replay', seq, positionId: 3, searchId, steps });

const run = (messages: ServerMessage[]): AppState =>
  messages.reduce<AppState>((state, message) => reducer(state, { kind: 'message', message, receivedAt: 0 }), {
    ...initialState,
    connection: 'open',
  });

describe('a replayed line belongs to the explanation on screen', () => {
  it('is kept when it answers the current explanation', () => {
    const state = run([game(3, 1), explanation(3, 7, 2), line(7, 3)]);
    expect(state.line?.steps).toHaveLength(3);
  });

  it('is dropped when it answers an older search', () => {
    const state = run([game(3, 1), explanation(3, 8, 2), line(7, 3)]);
    expect(state.line).toBeNull();
    expect(state.log.at(-1)).toMatchObject({ type: 'line_replay', dropped: true });
  });

  it('is dropped when there is no explanation at all', () => {
    expect(run([game(3, 1), line(7, 2)]).line).toBeNull();
  });

  it('goes when a newer explanation replaces the one it came with', () => {
    const state = run([game(3, 1), explanation(3, 7, 2), line(7, 3), explanation(3, 8, 4)]);
    expect(state.line).toBeNull();
  });

  it('goes with its explanation when the position changes', () => {
    const state = run([game(3, 1, 1), explanation(3, 7, 2), line(7, 3), game(9, 4, 0)]);
    expect(state.explanation).toBeNull();
    expect(state.line).toBeNull();
  });
});

describe('a replay step is drawn from what the engine sent, and cannot be played on', () => {
  const state = run([game(3, 1), explanation(3, 7, 2), line(7, 3)]);

  it('shows the step’s own board, check and last move', () => {
    const view = replayView(state, 1)!;
    expect(view.game.board).toBe(steps[1]!.board);
    expect(view.game.check).toBe('e8');
    expect(view.game.lastMove).toEqual({ from: 'b5', to: 'c7' });
    expect(view.game.turn).toBe('black');
  });

  it('offers no legal moves and uses an id no engine position has', () => {
    const view = replayView(state, 1)!;
    expect(view.game.legalMoves).toEqual([]);
    expect(view.game.positionId).toBe(replayPositionId(1));
    expect(view.game.positionId).toBeLessThan(0);
    expect(replayPositionId(0)).not.toBe(replayPositionId(1));
  });

  it('draws the step’s facts, not the real position’s search or inspection', () => {
    const view = replayView(state, 1)!;
    const viz = selectViz(view.state, { analysisMode: true, layers: new Set(['threats', 'best'] as const) });
    expect(viz).toEqual([{ type: 'arrow', from: 'c7', to: 'e8', style: 'threat' }]);
    expect(selectFocus(view.state, { kind: 'fact', id: 'f1' }, true)?.squares).toEqual(['c7', 'e8']);
    expect(view.state.search).toBeNull();
  });

  it('marks a mating step as checkmate for the side that moved', () => {
    const mated = run([game(3, 1), explanation(3, 7, 2), { ...line(7, 3), steps: [steps[0]!, { ...steps[1]!, checkmate: true }] }]);
    const view = replayView(mated, 1)!;
    expect(view.game.status).toBe('checkmate');
    expect(view.game.winner).toBe('white');
  });

  it('has no view for a step that does not exist, or with no line', () => {
    expect(replayView(state, 9)).toBeNull();
    expect(replayView(run([game(3, 1)]), 0)).toBeNull();
  });

  it('leaves the real game untouched', () => {
    replayView(state, 1);
    expect(state.game?.positionId).toBe(3);
    expect(state.game?.legalMoves).toHaveLength(1);
  });
});

describe('step labels', () => {
  it('numbers moves from the position’s move number', () => {
    expect(stepLabels(steps, 5)).toEqual(['Start', '5. Nc7+', 'Kd8']);
  });

  it('marks a line that Black starts', () => {
    const black = [steps[0]!, steps[2]!, { ...steps[1]!, by: 'white' as const }];
    expect(stepLabels(black, 5)).toEqual(['Start', '5… Kd8', '6. Nc7+']);
  });
});

describe('the line_replay message', () => {
  it('is accepted when well formed', () => {
    expect(parseServerMessage(JSON.stringify(line(7, 3)))).not.toBeNull();
  });

  it('is rejected when a step has no board', () => {
    const bad = { ...line(7, 3), steps: [{ ...steps[0], board: undefined }] };
    expect(parseServerMessage(JSON.stringify(bad))).toBeNull();
  });
});

describe('the guided tour is only a script of commands', () => {
  it('has a handful of steps with unique ids and something to say', () => {
    expect(DEMO.length).toBeGreaterThanOrEqual(4);
    expect(new Set(DEMO.map((s) => s.id)).size).toBe(DEMO.length);
    for (const step of DEMO) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.caption.length).toBeGreaterThan(40);
      expect(step.fen.split(' ')).toHaveLength(6);
    }
  });

  it('gives the visitor the side that is not to move when the engine should play', () => {
    for (const step of DEMO.filter((s) => s.mode === 'play')) {
      const toMove = step.fen.split(' ')[1] === 'w' ? 'white' : 'black';
      expect(step.humanColor).not.toBe(toMove);
    }
  });

  it('only replays a line it has asked the engine to search', () => {
    for (const step of DEMO.filter((s) => s.replay)) expect(step.analyse).toBe(true);
  });
});
