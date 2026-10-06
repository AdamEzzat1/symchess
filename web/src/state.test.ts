import { describe, expect, it } from 'vitest';
import type { GameState, MessageOf, ServerMessage } from './protocol';
import { selectViz } from './selectViz';
import { initialState, isStale, reducer, type AppState } from './state';

function gameState(positionId: number, seq: number, history: string[] = []): GameState {
  return {
    type: 'game_state',
    seq,
    positionId,
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    board: { e1: 'wK', e8: 'bK' },
    turn: 'white',
    moveNumber: 1,
    check: null,
    lastMove: null,
    history: history.map((san, i) => ({ ply: i + 1, san, uci: 'e2e4', by: 'human' })),
    legalMoves: [],
    status: 'active',
    winner: null,
    clocks: { enabled: false, whiteMs: 0, blackMs: 0, incrementMs: 0, running: null },
    settings: { mode: 'analysis', humanColor: 'white', depth: 6, moveTimeMs: 3000 },
    captured: { white: [], black: [] },
    engineThinking: false,
  };
}

function symbolic(positionId: number, seq: number): MessageOf<'symbolic_analysis'> {
  return {
    type: 'symbolic_analysis',
    seq,
    positionId,
    status: 'ok',
    elapsedMs: 5,
    facts: [
      {
        id: 'f1',
        kind: 'pin',
        side: 'white',
        squares: ['b5', 'c6', 'e8'],
        text: 'pin',
        use: 'explanation',
        viz: [
          { type: 'arrow', from: 'b5', to: 'e8', style: 'pin' },
          { type: 'ring', square: 'c6', style: 'pin' },
        ],
      },
      {
        id: 'f2',
        kind: 'open_file',
        side: null,
        squares: [],
        text: 'open d-file',
        use: 'explanation',
        viz: [{ type: 'file', file: 'd', style: 'open' }],
      },
    ],
    plans: [{ id: 'p1', kind: 'exploit_pin', text: 'pile up', because: ['f1'], viz: [{ type: 'ring', square: 'c6', style: 'plan' }] }],
    moveHints: [],
  };
}

function run(messages: ServerMessage[], from: AppState = { ...initialState, connection: 'open' }): AppState {
  return messages.reduce((s, message) => reducer(s, { kind: 'message', message, receivedAt: 0 }), from);
}

describe('reducer: faithfulness to engine state', () => {
  it('shows symbolic analysis for the current position', () => {
    const s = run([gameState(7, 1), symbolic(7, 2)]);
    expect(s.symbolic?.positionId).toBe(7);
  });

  it('drops symbolic analysis that arrives for an older position', () => {
    const s = run([gameState(8, 1), symbolic(7, 2)]);
    expect(s.symbolic).toBeNull();
    expect(s.log.at(-1)).toMatchObject({ type: 'symbolic_analysis', dropped: true });
  });

  it('clears symbolic analysis and inspection as soon as the position changes', () => {
    const inspection: MessageOf<'inspection'> = {
      type: 'inspection',
      seq: 3,
      positionId: 7,
      square: 'e4',
      piece: null,
      white: [],
      black: [],
      attacks: [],
      lines: [],
      viz: [{ type: 'ring', square: 'e4', style: 'inspect' }],
    };
    const before = run([gameState(7, 1), symbolic(7, 2), inspection]);
    expect(before.inspection).not.toBeNull();
    const after = run([gameState(8, 4, ['e4'])], before);
    expect(after.symbolic).toBeNull();
    expect(after.inspection).toBeNull();
  });

  it('ignores search updates that belong to a superseded search', () => {
    const started = (searchId: number, seq: number): ServerMessage => ({
      type: 'search_started',
      seq,
      positionId: 7,
      searchId,
      purpose: 'analysis',
      maxDepth: 6,
      timeLimitMs: 1000,
      symbolicHints: true,
    });
    const update = (searchId: number, seq: number, depth: number): ServerMessage => ({
      type: 'search_update',
      seq,
      positionId: 7,
      searchId,
      depth,
      score: { cp: 10, mate: null },
      nodes: 1,
      timeMs: 1,
      nps: 1,
      bestMove: null,
      pv: [],
      pvUci: [],
    });
    const s = run([gameState(7, 1), started(1, 2), started(2, 3), update(1, 4, 9), update(2, 5, 3)]);
    expect(s.search?.searchId).toBe(2);
    expect(s.search?.info?.depth).toBe(3);
  });

  it('ignores duplicated or reordered sequence numbers', () => {
    const s = run([gameState(7, 5), gameState(3, 4)]);
    expect(s.game?.positionId).toBe(7);
  });

  it('forgets everything on reconnect and waits for a fresh snapshot', () => {
    const before = run([gameState(7, 50), symbolic(7, 51)]);
    const after = reducer(before, { kind: 'connection', status: 'open' });
    expect(after.game).toBeNull();
    expect(after.symbolic).toBeNull();
    expect(after.lastSeq).toBe(0);
    // the new stream restarts from whatever seq the engine is at and is accepted
    expect(run([gameState(9, 1)], after).game?.positionId).toBe(9);
  });

  it('drops the explanation when the game goes backwards (undo / new game)', () => {
    const explanation: ServerMessage = {
      type: 'explanation',
      seq: 2,
      positionId: 7,
      searchId: 1,
      move: { uci: 'e7e5', san: 'e5', from: 'e7', to: 'e5', promotion: null, capture: false },
      summary: 'Black plays e5',
      items: [],
    };
    const before = run([gameState(7, 1, ['e4', 'e5']), explanation]);
    expect(before.explanation).not.toBeNull();
    expect(run([gameState(8, 3, [])], before).explanation).toBeNull();
  });

  it('keeps an explanation for the move just played, drops it one move later', () => {
    const explanation: ServerMessage = {
      type: 'explanation',
      seq: 2,
      positionId: 7,
      searchId: 1,
      move: { uci: 'e7e5', san: 'e5', from: 'e7', to: 'e5', promotion: null, capture: false },
      summary: 'Black plays e5',
      items: [],
    };
    const explained = run([gameState(7, 1, ['e4']), explanation]);
    const played = run([gameState(8, 3, ['e4', 'e5'])], explained);
    expect(played.explanation).not.toBeNull();
    const next = run([gameState(9, 4, ['e4', 'e5', 'Nf3'])], played);
    expect(next.explanation).toBeNull();
  });

  it('isStale only judges position-tagged analysis messages', () => {
    const s = run([gameState(7, 1)]);
    expect(isStale(s, symbolic(6, 2))).toBe(true);
    expect(isStale(s, symbolic(7, 2))).toBe(false);
    expect(isStale(s, gameState(1, 2))).toBe(false);
  });
});

describe('selectViz: nothing is drawn that the engine did not send', () => {
  const options = {
    analysisMode: true,
    enabledKinds: new Set(['pin']),
    showBestMove: true,
    highlight: null,
  } as const;
  const state = run([gameState(7, 1), symbolic(7, 2)]);

  it('draws nothing symbolic in play mode', () => {
    expect(selectViz(state, { ...options, analysisMode: false })).toEqual([]);
  });

  it('draws only the enabled fact kinds', () => {
    const viz = selectViz(state, options);
    expect(viz).toHaveLength(2);
    expect(viz.every((v) => v.style === 'pin')).toBe(true);
  });

  it('every primitive is the very object a fact supplied', () => {
    const supplied = new Set(state.symbolic!.facts.flatMap((f) => f.viz));
    for (const v of selectViz(state, { ...options, enabledKinds: new Set(['pin', 'open_file']) })) {
      expect(supplied.has(v)).toBe(true);
    }
  });

  it('hovering a fact isolates it; hovering a plan shows the facts it cites', () => {
    expect(selectViz(state, { ...options, highlight: { kind: 'fact', id: 'f2' } })).toEqual([
      { type: 'file', file: 'd', style: 'open' },
    ]);
    const plan = selectViz(state, { ...options, highlight: { kind: 'plan', id: 'p1' } });
    expect(plan).toHaveLength(3);
    expect(plan.at(-1)).toEqual({ type: 'ring', square: 'c6', style: 'plan' });
  });

  it('draws the best-move arrow only while the search matches the board', () => {
    const complete = (positionId: number): ServerMessage[] => [
      { type: 'search_started', seq: 3, positionId, searchId: 1, purpose: 'analysis', maxDepth: 4, timeLimitMs: 1, symbolicHints: true },
      {
        type: 'search_update',
        seq: 4,
        positionId,
        searchId: 1,
        depth: 4,
        score: { cp: 30, mate: null },
        nodes: 10,
        timeMs: 1,
        nps: 1,
        bestMove: { uci: 'g1f3', san: 'Nf3', from: 'g1', to: 'f3', promotion: null, capture: false },
        pv: ['Nf3'],
        pvUci: ['g1f3'],
      },
    ];
    const current = run(complete(7), state);
    expect(selectViz(current, { ...options, enabledKinds: new Set() })).toEqual([
      { type: 'arrow', from: 'g1', to: 'f3', style: 'pv' },
    ]);
    const old = run(complete(6), state);
    expect(selectViz(old, { ...options, enabledKinds: new Set() })).toEqual([]);
  });
});
