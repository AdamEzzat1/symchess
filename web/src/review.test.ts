import { describe, expect, it } from 'vitest';
import type { GameState, MessageOf, ServerMessage } from './protocol';
import { parseServerMessage } from './protocol';
import { replayPositionId, reviewPositionId, reviewView } from './replay';
import { SAMPLE_PGN } from './samples';
import { initialState, reducer, type AppState } from './state';

const game = (positionId: number, seq: number): GameState => ({
  type: 'game_state',
  seq,
  positionId,
  fen: 'final',
  board: { e1: 'wK', e8: 'bK' },
  turn: 'white',
  moveNumber: 3,
  check: null,
  lastMove: null,
  history: [],
  legalMoves: [{ uci: 'e1e2', san: 'Ke2', from: 'e1', to: 'e2', promotion: null, capture: false }],
  status: 'active',
  winner: null,
  clocks: { enabled: false, whiteMs: 0, blackMs: 0, incrementMs: 0, running: null },
  settings: { mode: 'analysis', humanColor: 'white', depth: 6, moveTimeMs: 2000 },
  captured: { white: [], black: [] },
  engineThinking: false,
});

const loaded = (gameId: number, seq: number): MessageOf<'game_loaded'> => ({
  type: 'game_loaded',
  seq,
  gameId,
  tags: { White: 'A', Black: 'B' },
  moves: ['e4', 'e5'],
  result: '1-0',
  error: null,
});

const step = (gameId: number, ply: number, seq: number): MessageOf<'review_step'> => ({
  type: 'review_step',
  seq,
  gameId,
  ply,
  score: { cp: 20 * ply, mate: null },
  depth: 5,
  evalBreakdown: { material: 0, placement: 0, pawnStructure: 0, bishopPair: 0, total: 0 },
  move: ply === 0 ? null : { uci: 'e2e4', san: 'e4', from: 'e2', to: 'e4', promotion: null, capture: false },
  by: ply === 0 ? null : ply % 2 === 1 ? 'white' : 'black',
  fen: `fen-${ply}`,
  board: { e1: 'wK', e8: 'bK', e4: 'wP' },
  turn: ply % 2 === 0 ? 'white' : 'black',
  check: null,
  checkmate: false,
  symbolic: true,
  facts: [],
});

const run = (messages: ServerMessage[]): AppState =>
  messages.reduce<AppState>((state, message) => reducer(state, { kind: 'message', message, receivedAt: 0 }), {
    ...initialState,
    connection: 'open',
  });

describe('an imported game is held by its id', () => {
  it('collects positions as the engine sends them, in any order', () => {
    const state = run([game(5, 1), loaded(1, 2), step(1, 1, 3), step(1, 0, 4)]);
    expect(state.review?.steps.map((s) => s?.ply)).toEqual([0, 1]);
    expect(state.review?.complete).toBe(false);
  });

  it('drops positions that belong to an earlier import', () => {
    const state = run([game(5, 1), loaded(1, 2), loaded(2, 3), step(1, 0, 4)]);
    expect(state.review?.gameId).toBe(2);
    expect(state.review?.steps).toEqual([]);
    expect(state.log.at(-1)).toMatchObject({ type: 'review_step', dropped: true });
  });

  it('drops positions when no game is held', () => {
    expect(run([game(5, 1), step(1, 0, 2)]).review).toBeNull();
  });

  it('is marked complete, and forgotten when the engine closes it', () => {
    const done = run([game(5, 1), loaded(1, 2), step(1, 0, 3), { type: 'review_complete', seq: 4, gameId: 1, plies: 2 }]);
    expect(done.review?.complete).toBe(true);
    const closed = run([game(5, 1), loaded(1, 2), { type: 'review_closed', seq: 3, gameId: 1 }]);
    expect(closed.review).toBeNull();
  });

  it('ignores a close meant for an earlier import', () => {
    const state = run([game(5, 1), loaded(2, 2), { type: 'review_closed', seq: 3, gameId: 1 }]);
    expect(state.review?.gameId).toBe(2);
  });

  it('survives moves on the live board', () => {
    const state = run([game(5, 1), loaded(1, 2), step(1, 0, 3), game(6, 4)]);
    expect(state.review?.steps).toHaveLength(1);
  });
});

describe('a position of an imported game cannot be played on', () => {
  const state = run([game(5, 1), loaded(1, 2), step(1, 0, 3), step(1, 1, 4)]);

  it('shows that position’s board with no legal moves', () => {
    const view = reviewView(state, 1)!;
    expect(view.game.fen).toBe('fen-1');
    expect(view.game.legalMoves).toEqual([]);
    expect(view.game.lastMove).toEqual({ from: 'e2', to: 'e4' });
  });

  it('uses ids that no engine position and no replayed line can have', () => {
    expect(reviewView(state, 1)!.game.positionId).toBe(reviewPositionId(1));
    expect(reviewPositionId(0)).toBeLessThan(0);
    expect(reviewPositionId(0)).not.toBe(replayPositionId(0));
    expect(reviewPositionId(3)).not.toBe(replayPositionId(3));
  });

  it('has no view for a position the engine has not sent yet', () => {
    expect(reviewView(state, 2)).toBeNull();
  });

  it('leaves the live game as it was', () => {
    reviewView(state, 1);
    expect(state.game?.positionId).toBe(5);
    expect(state.game?.legalMoves).toHaveLength(1);
  });
});

describe('review messages', () => {
  it('are accepted when well formed', () => {
    expect(parseServerMessage(JSON.stringify(loaded(1, 2)))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify(step(1, 0, 3)))).not.toBeNull();
  });

  it('accept a position with no score, where the game has ended', () => {
    expect(parseServerMessage(JSON.stringify({ ...step(1, 2, 3), score: null }))).not.toBeNull();
  });

  it('are rejected without a board or with a malformed error', () => {
    expect(parseServerMessage(JSON.stringify({ ...step(1, 0, 3), board: undefined }))).toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...loaded(1, 2), error: { ply: 'x' } }))).toBeNull();
  });
});

describe('the sample game is only text', () => {
  it('is a PGN with tags and a result, left for the engine to read', () => {
    expect(SAMPLE_PGN).toContain('[White "');
    expect(SAMPLE_PGN.trim().endsWith('1-0')).toBe(true);
  });
});

const asked = (positionId: number, searchId: number, seq: number): MessageOf<'counterfactual'> => ({
  type: 'counterfactual',
  seq,
  positionId,
  searchId,
  move: { uci: 'e1e2', san: 'Ke2', from: 'e1', to: 'e2', promotion: null, capture: false },
  best: { uci: 'e1d2', san: 'Kd2', from: 'e1', to: 'd2', promotion: null, capture: false },
  isBest: false,
  score: { cp: -40, mate: null },
  bestScore: { cp: 30, mate: null },
  lossCp: 70,
  verdict: 'mistake',
  depth: 6,
  line: ['Ke2', 'Kd7'],
  bestLine: ['Kd2'],
  factsAdded: [],
  factsRemoved: [],
  bestFactsAdded: [],
  bestFactsRemoved: [],
  summary: 'The search rates Ke2 a mistake.',
  items: [{ source: 'search', status: 'measured', text: 't', squares: [], basis: 'b' }],
  viz: [{ type: 'arrow', from: 'e1', to: 'e2', style: 'asked' }],
});

describe('why not this move? is about one position', () => {
  it('is kept for the position it was asked about', () => {
    expect(run([game(5, 1), asked(5, 9, 2)]).counterfactual?.verdict).toBe('mistake');
  });

  it('is dropped if the board has moved on before it arrives', () => {
    const state = run([game(5, 1), game(6, 2), asked(5, 9, 3)]);
    expect(state.counterfactual).toBeNull();
    expect(state.log.at(-1)).toMatchObject({ type: 'counterfactual', dropped: true });
  });

  it('is forgotten when the position changes', () => {
    expect(run([game(5, 1), asked(5, 9, 2), game(6, 3)]).counterfactual).toBeNull();
  });

  it('lets its own line be replayed, and takes the line with it when it goes', () => {
    const line: MessageOf<'line_replay'> = { type: 'line_replay', seq: 3, positionId: 5, searchId: 9, steps: [] };
    expect(run([game(5, 1), asked(5, 9, 2), line]).line?.searchId).toBe(9);
    expect(run([game(5, 1), asked(5, 9, 2), line, game(6, 4)]).line).toBeNull();
  });

  it('still refuses a line that belongs to neither the explanation nor the comparison', () => {
    const line: MessageOf<'line_replay'> = { type: 'line_replay', seq: 3, positionId: 5, searchId: 4, steps: [] };
    expect(run([game(5, 1), asked(5, 9, 2), line]).line).toBeNull();
  });

  it('is rejected when malformed', () => {
    expect(parseServerMessage(JSON.stringify(asked(5, 9, 2)))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...asked(5, 9, 2), verdict: 7 }))).toBeNull();
    const badViz = [{ type: 'arrow', from: 'z9', to: 'e2', style: 'asked' }];
    expect(parseServerMessage(JSON.stringify({ ...asked(5, 9, 2), viz: badViz }))).toBeNull();
  });
});

describe('what a move changed, in a review', () => {
  const terms = { material: -300 };
  it('accepts a step with a change and one without', () => {
    const change = { before: { cp: 10, mate: null }, after: { cp: -300, mate: null }, lossCp: 310, verdict: 'blunder', terms, factsAdded: [], factsRemoved: [], lines: ['x'] };
    expect(parseServerMessage(JSON.stringify({ ...step(1, 1, 3), change }))).not.toBeNull();
    expect(parseServerMessage(JSON.stringify({ ...step(1, 0, 3), change: null }))).not.toBeNull();
  });

  it('rejects a change whose terms are not numbers', () => {
    const change = { before: null, after: null, lossCp: null, verdict: null, terms: { material: 'lots' }, factsAdded: [], factsRemoved: [], lines: [] };
    expect(parseServerMessage(JSON.stringify({ ...step(1, 1, 3), change }))).toBeNull();
  });
});
