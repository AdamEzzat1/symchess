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
