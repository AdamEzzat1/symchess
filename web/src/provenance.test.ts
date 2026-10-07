import { describe, expect, it } from 'vitest';
import type { ExplanationItem, GameState, MessageOf, Rule, ServerMessage } from './protocol';
import { parseServerMessage } from './protocol';
import { disagreements, ruleById, sentences, traceFact, traceItem, tracePlan } from './provenance';
import { initialState, reducer, type AppState } from './state';

const game = (positionId: number, seq: number): GameState => ({
  type: 'game_state',
  seq,
  positionId,
  fen: 'fen',
  board: { e1: 'wK', e8: 'bK', e2: 'wR', e5: 'bN' },
  turn: 'white',
  moveNumber: 1,
  check: null,
  lastMove: null,
  history: [],
  legalMoves: [{ uci: 'e2e5', san: 'Rxe5', from: 'e2', to: 'e5', promotion: null, capture: true }],
  status: 'active',
  winner: null,
  clocks: { enabled: false, whiteMs: 0, blackMs: 0, incrementMs: 0, running: null },
  settings: { mode: 'analysis', humanColor: 'white', depth: 6, moveTimeMs: 2000 },
  captured: { white: [], black: [] },
  engineThinking: false,
});

const rule = (id: string, group: Rule['group'], source: string | null = null): Rule => ({
  id,
  layer: source ? 'prolog' : 'search',
  group,
  name: id.slice(id.indexOf(':') + 1),
  where: 'somewhere',
  summary: `about ${id}`,
  source,
});

const rules = (seq: number): MessageOf<'rules'> => ({
  type: 'rules',
  seq,
  status: 'ok',
  rules: [
    rule('fact:hanging', 'fact', 'hanging(Ctx, F) :- true'),
    rule('fact:pin', 'fact', 'pin(Ctx, F) :- true'),
    rule('motif:captures_hanging', 'motif', 'motif(...) :- true'),
    rule('plan:win_material', 'plan', 'plan(...) :- true'),
    rule('check:material_gain', 'check'),
  ],
});

const symbolic = (positionId: number, seq: number): MessageOf<'symbolic_analysis'> => ({
  type: 'symbolic_analysis',
  seq,
  positionId,
  status: 'ok',
  facts: [
    { id: 'f1', kind: 'pin', side: 'white', squares: ['e2', 'e5', 'e8'], text: 'pinned', viz: [], use: 'explanation' },
    { id: 'f2', kind: 'hanging', side: 'white', squares: ['e5', 'e2'], text: 'undefended', viz: [], use: 'explanation' },
  ],
  plans: [{ id: 'p1', kind: 'win_material', text: 'Win material', because: ['f2'], viz: [] }],
  moveHints: [
    {
      uci: 'e2e5',
      san: 'Rxe5',
      score: 450,
      motifs: [{ kind: 'captures_hanging', score: 450, targets: ['e5'], text: 'Captures.', facts: ['f2'] }],
    },
    { uci: 'e1d1', san: 'Kd1', score: 0, motifs: [] },
  ],
  elapsedMs: 1,
});

const item = (over: Partial<ExplanationItem>): ExplanationItem => ({
  source: 'prolog',
  status: 'confirmed',
  text: 'Captures.',
  squares: ['e5'],
  motif: null,
  rule: null,
  check: null,
  basis: null,
  facts: [],
  ...over,
});

const explanation = (positionId: number, seq: number): MessageOf<'explanation'> => ({
  type: 'explanation',
  seq,
  positionId,
  searchId: 4,
  move: { uci: 'e2e5', san: 'Rxe5', from: 'e2', to: 'e5', promotion: null, capture: true },
  summary: '',
  items: [
    item({ source: 'search', status: 'measured', text: 'depth 6', rule: 'search:score' }),
    item({ motif: 'captures_hanging', rule: 'motif:captures_hanging', check: 'check:material_gain', basis: 'ends 3.0 up', facts: ['f2'] }),
    item({ status: 'overruled', text: 'Top was Kd1', rule: 'prolog:ranking', check: 'check:top_move', basis: 'chose Rxe5' }),
  ],
  agreement: { confirmed: 1, unconfirmed: 0, overruled: 1, unchecked: 0, prologTop: 'Kd1', searchMove: 'Rxe5', sameMove: false },
});

const run = (messages: ServerMessage[]): AppState =>
  messages.reduce<AppState>((state, message) => reducer(state, { kind: 'message', message, receivedAt: 0 }), {
    ...initialState,
    connection: 'open',
  });

const full = run([rules(1), game(5, 2), symbolic(5, 3), explanation(5, 4)]);

describe('the rule index', () => {
  it('is kept when the position changes: it describes the engine, not a game', () => {
    expect(run([rules(1), game(5, 2), game(6, 3)]).rules?.rules).toHaveLength(5);
  });

  it('is forgotten with the connection it came over', () => {
    const state = reducer(full, { kind: 'connection', status: 'open' });
    expect(state.rules).toBeNull();
  });

  it('is looked up by id and nothing else', () => {
    expect(ruleById(full, 'fact:pin')?.source).toContain('pin(');
    expect(ruleById(full, 'fact:fork')).toBeNull();
    expect(ruleById(full, null)).toBeNull();
  });

  it('is rejected when an entry is malformed', () => {
    expect(parseServerMessage(JSON.stringify(rules(1)))).not.toBeNull();
    const bad = { ...rules(1), rules: [{ ...rules(1).rules[0], group: 'opinion' }] };
    expect(parseServerMessage(JSON.stringify(bad))).toBeNull();
  });
});

describe('tracing a fact', () => {
  const trace = traceFact(full, 'f2')!;
  const first = () => trace.said[0]!;

  it('finds the rule named after the kind of fact', () => {
    expect(trace.rule?.id).toBe('fact:hanging');
  });

  it('lists the plans that cite it, each with its rule', () => {
    expect(trace.plans.map((p) => [p.plan.id, p.rule?.id])).toEqual([['p1', 'plan:win_material']]);
  });

  it('lists the moves whose motifs Prolog says rest on it', () => {
    expect(trace.moves.map((m) => [m.hint.san, m.motif.kind, m.rule?.id])).toEqual([
      ['Rxe5', 'captures_hanging', 'motif:captures_hanging'],
    ]);
  });

  it('lists what the search said, from sentences that cite it, with the check behind the status', () => {
    expect(trace.said).toHaveLength(1);
    expect(first().item.status).toBe('confirmed');
    expect(first().check?.id).toBe('check:material_gain');
    expect(first().searchId).toBe(4);
  });

  it('links nothing to a fact that nothing cites, even one that shares squares', () => {
    const pin = traceFact(full, 'f1')!;
    expect(pin.plans).toEqual([]);
    expect(pin.moves).toEqual([]);
    expect(pin.said).toEqual([]);
  });

  it('has no trace for a fact of another position', () => {
    expect(traceFact(run([rules(1), game(5, 2), symbolic(5, 3), game(6, 4)]), 'f2')).toBeNull();
  });

  it('still traces without the rule index, with the rule left empty', () => {
    const state = run([game(5, 2), symbolic(5, 3)]);
    expect(traceFact(state, 'f2')?.rule).toBeNull();
    expect(traceFact(state, 'f2')?.plans[0]?.plan.id).toBe('p1');
  });
});

describe('tracing a plan and a sentence', () => {
  it('a plan leads back to the facts it cites', () => {
    const trace = tracePlan(full, 'p1')!;
    expect(trace.rule?.id).toBe('plan:win_material');
    expect(trace.facts.map((f) => [f.fact.id, f.rule?.id])).toEqual([['f2', 'fact:hanging']]);
  });

  it('a sentence leads to its rule, its facts and its check', () => {
    const trace = traceItem(full, 'explanation', 4, 1)!;
    expect(trace.rule?.id).toBe('motif:captures_hanging');
    expect(trace.facts.map((f) => f.id)).toEqual(['f2']);
    expect(trace.said.check?.id).toBe('check:material_gain');
  });

  it('a sentence of a search that is no longer on screen cannot be traced', () => {
    expect(traceItem(full, 'explanation', 3, 1)).toBeNull();
    expect(traceItem(full, 'counterfactual', 4, 1)).toBeNull();
  });
});

describe('where Prolog and the search differ', () => {
  it('is every sentence from Prolog that the engine marked overruled or unconfirmed', () => {
    expect(disagreements(full).map((s) => s.item.text)).toEqual(['Top was Kd1']);
  });

  it('is empty once the position has moved on', () => {
    expect(sentences(run([rules(1), game(5, 2), explanation(5, 3), game(6, 4)]))).toEqual([]);
  });

  it('carries the engine\u2019s own counts', () => {
    expect(full.explanation?.agreement).toMatchObject({ confirmed: 1, overruled: 1, sameMove: false });
  });

  it('rejects an explanation whose counts are malformed', () => {
    const bad = { ...explanation(5, 4), agreement: { confirmed: 'many' } };
    expect(parseServerMessage(JSON.stringify(bad))).toBeNull();
    expect(parseServerMessage(JSON.stringify(explanation(5, 4)))).not.toBeNull();
  });
});
