import { describe, expect, it } from 'vitest';
import { cropWindow } from './components/MiniBoard';
import { activateSquare, resolveMove, targetsFrom } from './moveInput';
import type { GameState, LegalMove, MessageOf, ServerMessage } from './protocol';
import { layerCounts, selectFocus, selectViz, verdictFor, type LayerId } from './selectViz';
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

  it('a server refusal stays on screen until the server lets us in', () => {
    const full: ServerMessage = {
      type: 'error',
      seq: 1,
      code: 'server_full',
      message: 'All 8 seats are taken.',
      inReplyTo: null,
    };
    const refused = run([full]);
    expect(refused.refusal?.code).toBe('server_full');
    expect(refused.errors).toEqual([]); // shown as a screen, not as an error toast
    const closed = reducer(refused, { kind: 'connection', status: 'closed' });
    expect(closed.refusal?.code).toBe('server_full');
    const reopened = reducer(closed, { kind: 'connection', status: 'open' });
    expect(reopened.refusal?.code).toBe('server_full'); // no flicker while retrying
    const admitted = run(
      [{ type: 'hello', seq: 1, protocol: 1, engine: 'symchess', lisp: 'SBCL', prolog: null }],
      reopened,
    );
    expect(admitted.refusal).toBeNull();
  });

  it('isStale only judges position-tagged analysis messages', () => {
    const s = run([gameState(7, 1)]);
    expect(isStale(s, symbolic(6, 2))).toBe(true);
    expect(isStale(s, symbolic(7, 2))).toBe(false);
    expect(isStale(s, gameState(1, 2))).toBe(false);
  });
});

describe('reducer: search trace', () => {
  const started: ServerMessage = {
    type: 'search_started', seq: 2, positionId: 7, searchId: 1, purpose: 'analysis',
    maxDepth: 6, timeLimitMs: 1000, symbolicHints: true,
  };
  const update = (seq: number, depth: number, cp: number): ServerMessage => ({
    type: 'search_update', seq, positionId: 7, searchId: 1, depth,
    score: { cp, mate: null }, nodes: depth * 100, timeMs: depth, nps: 1000,
    bestMove: null, pv: [], pvUci: [],
  });

  it('records one tick per completed depth, in order', () => {
    const s = run([gameState(7, 1), started, update(3, 1, 8), update(4, 2, 14), update(5, 3, 20)]);
    expect(s.search?.trace).toEqual([
      { depth: 1, score: { cp: 8, mate: null }, nodes: 100, timeMs: 1 },
      { depth: 2, score: { cp: 14, mate: null }, nodes: 200, timeMs: 2 },
      { depth: 3, score: { cp: 20, mate: null }, nodes: 300, timeMs: 3 },
    ]);
    expect(s.search?.maxDepth).toBe(6);
  });

  it('search_complete does not duplicate the last depth, and records an early stop', () => {
    const complete: ServerMessage = {
      type: 'search_complete', seq: 5, positionId: 7, searchId: 1, purpose: 'analysis', stopped: true,
      evalBreakdown: { material: 0, placement: 0, pawnStructure: 0, bishopPair: 0, total: 0 },
      depth: 2, score: { cp: 14, mate: null }, nodes: 200, timeMs: 2, nps: 1000,
      bestMove: null, pv: [], pvUci: [],
    };
    const s = run([gameState(7, 1), started, update(3, 1, 8), update(4, 2, 14), complete]);
    expect(s.search?.trace.map((t) => t.depth)).toEqual([1, 2]);
    expect(s.search?.stopped).toBe(true);
    expect(s.search?.running).toBe(false);
  });

  it('a new search starts a fresh trace', () => {
    const again: ServerMessage = { ...started, seq: 5, searchId: 2 } as ServerMessage;
    const s = run([gameState(7, 1), started, update(3, 1, 8), again]);
    expect(s.search?.trace).toEqual([]);
  });
});

describe('selectViz: nothing is drawn that the engine did not send', () => {
  const state = run([gameState(7, 1), symbolic(7, 2)]);
  const on = (...ids: LayerId[]) => ({ analysisMode: true, layers: new Set<LayerId>(ids) });

  it('draws nothing symbolic in play mode', () => {
    expect(selectViz(state, { ...on('pins', 'structure', 'plans'), analysisMode: false })).toEqual([]);
  });

  it('draws only the enabled layers', () => {
    const pins = selectViz(state, on('pins'));
    expect(pins).toHaveLength(2);
    expect(pins.every((v) => v.style === 'pin')).toBe(true);
    expect(selectViz(state, on('structure'))).toEqual([{ type: 'file', file: 'd', style: 'open' }]);
    expect(selectViz(state, on())).toEqual([]);
  });

  it('the plans layer draws only what plans supplied', () => {
    expect(selectViz(state, on('plans'))).toEqual([{ type: 'ring', square: 'c6', style: 'plan' }]);
  });

  it('every primitive is the very object a fact or plan supplied', () => {
    const supplied = new Set([
      ...state.symbolic!.facts.flatMap((f) => f.viz),
      ...state.symbolic!.plans.flatMap((p) => p.viz),
    ]);
    for (const v of selectViz(state, on('pins', 'threats', 'defenses', 'weak', 'structure', 'plans'))) {
      expect(supplied.has(v)).toBe(true);
    }
  });

  it('layer counts reflect what was supplied', () => {
    expect(layerCounts(state)).toMatchObject({ pins: 1, structure: 1, plans: 1, threats: 0, best: 0 });
  });

  it('inspection arrows follow the threat and defence layers; its ring always shows', () => {
    const inspection: ServerMessage = {
      type: 'inspection', seq: 3, positionId: 7, square: 'e5', piece: null, white: [], black: [],
      attacks: [], lines: [],
      viz: [
        { type: 'ring', square: 'e5', style: 'inspect' },
        { type: 'arrow', from: 'e2', to: 'e5', style: 'threat' },
        { type: 'arrow', from: 'd6', to: 'e5', style: 'defend' },
      ],
    };
    const inspected = run([inspection], state);
    expect(selectViz(inspected, on()).map((v) => v.style)).toEqual(['inspect']);
    expect(selectViz(inspected, on('threats')).map((v) => v.style)).toEqual(['inspect', 'threat']);
    expect(selectViz(inspected, on('threats', 'defenses')).map((v) => v.style)).toEqual(['inspect', 'threat', 'defend']);
  });

  it('display switches only remove arrows; they never add anything', () => {
    const inspection: ServerMessage = {
      type: 'inspection', seq: 3, positionId: 7, square: 'e5', piece: null, white: [], black: [],
      attacks: [], lines: [],
      viz: [
        { type: 'ring', square: 'e5', style: 'inspect' },
        { type: 'arrow', from: 'e2', to: 'e5', style: 'threat' },
      ],
    };
    const inspected = run([inspection], state);
    const all = on('pins', 'threats', 'plans');
    expect(selectViz(inspected, { ...all, attackArrows: false }).some((v) => v.style === 'threat')).toBe(false);
    const withSupport = symbolic(7, 2);
    withSupport.facts[0]!.viz.push({ type: 'arrow', from: 'e4', to: 'd5', style: 'support' });
    const s2 = run([gameState(7, 1), withSupport]);
    expect(selectViz(s2, all).some((v) => v.style === 'support')).toBe(true);
    expect(selectViz(s2, { ...all, subtleArrows: false }).some((v) => v.style === 'support')).toBe(false);
    expect(selectViz(s2, { ...all, subtleArrows: false }).filter((v) => v.style === 'pin')).toHaveLength(2);
  });

  it('draws the best-move arrow only while the search matches the board', () => {
    const complete = (positionId: number): ServerMessage[] => [
      { type: 'search_started', seq: 3, positionId, searchId: 1, purpose: 'analysis', maxDepth: 4, timeLimitMs: 1, symbolicHints: true },
      {
        type: 'search_update', seq: 4, positionId, searchId: 1, depth: 4,
        score: { cp: 30, mate: null }, nodes: 10, timeMs: 1, nps: 1,
        bestMove: { uci: 'g1f3', san: 'Nf3', from: 'g1', to: 'f3', promotion: null, capture: false },
        pv: ['Nf3'], pvUci: ['g1f3'],
      },
    ];
    expect(selectViz(run(complete(7), state), on('best'))).toEqual([
      { type: 'ring', square: 'g1', style: 'pv' },
      { type: 'arrow', from: 'g1', to: 'f3', style: 'pv' },
    ]);
    expect(selectViz(run(complete(6), state), on('best'))).toEqual([]);
  });
});

describe('glass inspector (selectFocus)', () => {
  const state = run([gameState(7, 1), symbolic(7, 2)]);

  it('isolates exactly the primitives the fact supplied', () => {
    const focus = selectFocus(state, { kind: 'fact', id: 'f1' }, true)!;
    expect(focus.viz).toBe(state.symbolic!.facts[0]!.viz);
    expect([...focus.squares].sort()).toEqual(['b5', 'c6', 'e8']);
  });

  it('a plan shows its own primitives plus the facts it cites', () => {
    const focus = selectFocus(state, { kind: 'plan', id: 'p1' }, true)!;
    expect(focus.viz).toHaveLength(3);
    expect(focus.viz.at(-1)).toEqual({ type: 'ring', square: 'c6', style: 'plan' });
  });

  it('a whole file stays lit for a file fact', () => {
    const focus = selectFocus(state, { kind: 'fact', id: 'f2' }, true)!;
    expect(focus.squares).toHaveLength(8);
    expect(focus.squares.every((sq) => sq.startsWith('d'))).toBe(true);
  });

  it('invents nothing for a fact that has no primitives', () => {
    const bare = symbolic(7, 2);
    bare.facts[0]!.viz = [];
    bare.facts[0]!.squares = [];
    const focus = selectFocus(run([gameState(7, 1), bare]), { kind: 'fact', id: 'f1' }, true)!;
    expect(focus.viz).toEqual([]);
    expect(focus.squares).toEqual([]);
  });

  it('is off in play mode, and for ids from another position', () => {
    expect(selectFocus(state, { kind: 'fact', id: 'f1' }, false)).toBeNull();
    expect(selectFocus(state, { kind: 'fact', id: 'f99' }, true)).toBeNull();
    const moved = run([gameState(8, 3, ['e4'])], state);
    expect(selectFocus(moved, { kind: 'fact', id: 'f1' }, true)).toBeNull();
  });
});

describe('verdictFor: only repeats what the search said about that very fact', () => {
  const explanation = (positionId: number): MessageOf<'explanation'> => ({
    type: 'explanation', seq: 9, positionId, searchId: 1,
    move: { uci: 'e2e5', san: 'Rxe5', from: 'e2', to: 'e5', promotion: null, capture: true },
    summary: '',
    items: [
      { source: 'search', status: 'measured', text: 'depth 5', squares: [], motif: null, facts: [] },
      { source: 'prolog', status: 'confirmed', text: 'Gives check.', squares: ['e8'], motif: 'gives_check', facts: [] },
      // Prolog said this motif rests on fact f2; nothing here works that out.
      { source: 'prolog', status: 'confirmed', text: 'Captures an undefended knight.', squares: ['e5'], motif: 'captures_hanging', facts: ['f2'] },
    ],
  });

  it('carries the verdict to the fact the sentence cites', () => {
    expect(verdictFor({ id: 'f2' }, explanation(7), 7)).toBe('confirmed');
  });

  it('gives no verdict to a fact no sentence cites, whatever squares it shares', () => {
    expect(verdictFor({ id: 'f1' }, explanation(7), 7)).toBeNull();
  });

  it('does not take a sentence from the search as a verdict on a fact', () => {
    const withSearchCitation = explanation(7);
    withSearchCitation.items[0] = { ...withSearchCitation.items[0]!, facts: ['f9'] };
    expect(verdictFor({ id: 'f9' }, withSearchCitation, 7)).toBeNull();
  });

  it('ignores an explanation of a different position', () => {
    expect(verdictFor({ id: 'f2' }, explanation(6), 7)).toBeNull();
    expect(verdictFor({ id: 'f2' }, null, 7)).toBeNull();
  });

  it('gives no verdict from an older engine that sends no citations', () => {
    const old = explanation(7);
    old.items = old.items.map(({ facts: _facts, ...rest }) => rest);
    expect(verdictFor({ id: 'f2' }, old, 7)).toBeNull();
  });
});

describe('move input is lookup in the engine list', () => {
  const m = (uci: string, promotion: string | null = null): LegalMove => ({
    uci, san: uci, from: uci.slice(0, 2), to: uci.slice(2, 4), promotion, capture: false,
  });
  const legal = [m('e2e4'), m('e2e3'), m('g1f3'), m('a7a8q', 'q'), m('a7a8r', 'r'), m('a7a8b', 'b'), m('a7a8n', 'n')];

  it('sends a move only if the engine listed it', () => {
    expect(resolveMove(legal, 'e2', 'e4')).toEqual({ kind: 'move', uci: 'e2e4' });
    expect(resolveMove(legal, 'e2', 'e5')).toEqual({ kind: 'none' });
    expect(resolveMove([], 'e2', 'e4')).toEqual({ kind: 'none' });
  });

  it('asks which piece when several listed moves share from and to', () => {
    const choice = resolveMove(legal, 'a7', 'a8');
    expect(choice.kind).toBe('promotion');
    expect(choice.kind === 'promotion' && choice.options.map((o) => o.promotion)).toEqual(['q', 'r', 'b', 'n']);
  });

  it('lists targets for the selected square only', () => {
    expect(targetsFrom(legal, 'e2').map((t) => t.to)).toEqual(['e4', 'e3']);
    expect(targetsFrom(legal, null)).toEqual([]);
  });

  it('keyboard/click activation: select, move, reselect, deselect', () => {
    expect(activateSquare(legal, null, 'e2')).toEqual({ kind: 'select', square: 'e2' });
    expect(activateSquare(legal, 'e2', 'e4')).toEqual({ kind: 'move', uci: 'e2e4' });
    expect(activateSquare(legal, 'e2', 'g1')).toEqual({ kind: 'select', square: 'g1' });
    expect(activateSquare(legal, 'e2', 'e2')).toEqual({ kind: 'deselect' });
    expect(activateSquare(legal, 'e2', 'h8')).toEqual({ kind: 'deselect' });
    expect(activateSquare(legal, null, 'h8')).toEqual({ kind: 'deselect' });
    expect(activateSquare(legal, 'a7', 'a8').kind).toBe('promotion');
  });
});

describe('thumbnail crop is plain geometry', () => {
  it('frames the named squares with a margin and stays on the board', () => {
    expect(cropWindow(['b5', 'c6', 'e8'], 'white')).toEqual({ x: 1, y: 0, span: 5 });
    expect(cropWindow(['h1'], 'white')).toEqual({ x: 4, y: 4, span: 4 });
    expect(cropWindow(['a1', 'h8'], 'white')).toEqual({ x: 0, y: 0, span: 8 });
    expect(cropWindow([], 'white')).toEqual({ x: 0, y: 0, span: 8 });
  });

  it('follows the board orientation', () => {
    expect(cropWindow(['h1'], 'black')).toEqual({ x: 0, y: 0, span: 4 });
  });
});
