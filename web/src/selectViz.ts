// Decides which engine-supplied drawing primitives are on the board right now.
// It only ever SELECTS from what the engine and Prolog sent. The one thing it
// constructs is the best-move arrow, and that is a direct copy of the search's
// own bestMove.

import type { Fact, MessageOf, Plan, Square, Viz } from './protocol';
import type { AppState } from './state';

export type LayerId = 'best' | 'pins' | 'threats' | 'defenses' | 'weak' | 'structure' | 'plans';

export interface Layer {
  id: LayerId;
  label: string;
  /** Overlay style used for the legend swatch. */
  swatch: string;
  /** Prolog fact kinds this layer shows. */
  kinds: readonly string[];
}

export const LAYERS: readonly Layer[] = [
  { id: 'best', label: 'Best line', swatch: 'pv', kinds: [] },
  { id: 'pins', label: 'Pins', swatch: 'pin', kinds: ['pin', 'skewer', 'pinned_defender'] },
  { id: 'threats', label: 'Threats', swatch: 'threat', kinds: ['check', 'fork', 'hanging', 'threatened', 'trapped', 'discovered_attack', 'battery'] },
  { id: 'defenses', label: 'Defenses', swatch: 'defend', kinds: ['overloaded'] },
  { id: 'weak', label: 'Weak squares', swatch: 'weak', kinds: ['weak_square', 'isolated_pawn', 'doubled_pawns', 'backward_pawn', 'king_shield', 'weak_back_rank'] },
  { id: 'plans', label: 'Plans', swatch: 'plan', kinds: [] },
  { id: 'structure', label: 'Files & pawns', swatch: 'open', kinds: ['open_file', 'semi_open_file', 'passed_pawn', 'unstoppable_pawn', 'pawn_majority', 'pawn_break', 'outpost_piece', 'rook_on_seventh'] },
];

export const DEFAULT_LAYERS: readonly LayerId[] = ['best', 'pins', 'threats'];

export type Highlight = { kind: 'fact'; id: string } | { kind: 'plan'; id: string } | null;

export interface VizOptions {
  analysisMode: boolean;
  layers: ReadonlySet<LayerId>;
  /** Draw attacker/defender arrows for a clicked square. Default on. */
  attackArrows?: boolean;
  /** Draw the secondary arrows a fact carries (support, defence, plan routes). Default on. */
  subtleArrows?: boolean;
}

const SUBTLE_ARROWS = new Set(['support', 'defend', 'plan']);

function current(state: AppState): { facts: Fact[]; plans: Plan[] } {
  const { game, symbolic } = state;
  const ok = game !== null && symbolic !== null && symbolic.positionId === game.positionId;
  return ok ? { facts: symbolic.facts, plans: symbolic.plans } : { facts: [], plans: [] };
}

function layerOf(kind: string): LayerId | null {
  return LAYERS.find((layer) => layer.kinds.includes(kind))?.id ?? null;
}

/** How many supplied items each layer would show: drives the toggle labels. */
export function layerCounts(state: AppState): Record<LayerId, number> {
  const counts: Record<LayerId, number> = { best: 0, pins: 0, threats: 0, defenses: 0, weak: 0, structure: 0, plans: 0 };
  const { facts, plans } = current(state);
  for (const fact of facts) {
    const layer = layerOf(fact.kind);
    if (layer) counts[layer] += 1;
  }
  counts.plans = plans.length;
  const { game, search } = state;
  counts.best = game && search?.info?.bestMove && search.positionId === game.positionId ? 1 : 0;
  return counts;
}

/** The standing overlays: everything the enabled layers select. */
export function selectViz(state: AppState, options: VizOptions): Viz[] {
  const { game, search, inspection } = state;
  // Normal play shows no reasoning overlays at all.
  if (!options.analysisMode || game === null) return [];

  const { facts, plans } = current(state);
  const subtle = options.subtleArrows ?? true;
  const keep = (v: Viz) => subtle || v.type !== 'arrow' || !SUBTLE_ARROWS.has(v.style);

  const out: Viz[] = facts
    .filter((fact) => {
      const layer = layerOf(fact.kind);
      return layer !== null && options.layers.has(layer);
    })
    .flatMap((fact) => fact.viz)
    .filter(keep);

  if (options.layers.has('plans')) out.push(...plans.flatMap((plan) => plan.viz).filter(keep));

  // A clicked square is an explicit question, so its ring and plain control
  // arrows always show; attacker/defender arrows follow their layers.
  if (inspection && inspection.positionId === game.positionId) {
    for (const v of inspection.viz) {
      if (v.type === 'arrow' && options.attackArrows === false) continue;
      if (v.style === 'threat' && !options.layers.has('threats')) continue;
      if (v.style === 'defend' && !options.layers.has('defenses')) continue;
      out.push(v);
    }
  }

  // "Why not this move?": the asked move, the engine's move, and the reply.
  const asked = state.counterfactual;
  if (asked && asked.positionId === game.positionId) out.push(...asked.viz);

  const best = search?.info?.bestMove;
  if (options.layers.has('best') && best && search.positionId === game.positionId) {
    // Both primitives restate the search's own best move: where it starts, where it goes.
    out.push({ type: 'ring', square: best.from, style: 'pv' });
    out.push({ type: 'arrow', from: best.from, to: best.to, style: 'pv' });
  }
  return out;
}

export interface Focus {
  kind: 'fact' | 'plan';
  id: string;
  /** Only the primitives the fact or plan itself supplied. */
  viz: Viz[];
  /** Squares that stay bright while the rest of the board dims. */
  squares: Square[];
}

function vizSquares(viz: readonly Viz[]): Square[] {
  const out: Square[] = [];
  for (const v of viz) {
    if (v.type === 'arrow') out.push(v.from, v.to);
    else if (v.type === 'file') for (let rank = 1; rank <= 8; rank++) out.push(`${v.file}${rank}`);
    else out.push(v.square);
  }
  return out;
}

/**
 * The glass inspector: isolate one fact or plan. Returns exactly the evidence
 * that item carries. A fact with no primitives yields an empty `viz` and the
 * board simply does not dim: nothing is invented to fill the gap.
 */
export function selectFocus(state: AppState, highlight: Highlight, analysisMode: boolean): Focus | null {
  if (!analysisMode || highlight === null || state.game === null) return null;
  const { facts, plans } = current(state);

  if (highlight.kind === 'fact') {
    const fact = facts.find((f) => f.id === highlight.id);
    if (!fact) return null;
    return {
      kind: 'fact',
      id: fact.id,
      viz: fact.viz,
      squares: [...new Set([...fact.squares, ...vizSquares(fact.viz)])],
    };
  }

  const plan = plans.find((p) => p.id === highlight.id);
  if (!plan) return null;
  const cited = facts.filter((f) => plan.because.includes(f.id));
  const viz = [...cited.flatMap((f) => f.viz), ...plan.viz];
  return {
    kind: 'plan',
    id: plan.id,
    viz,
    squares: [...new Set([...cited.flatMap((f) => f.squares), ...vizSquares(viz)])],
  };
}

export type Verdict = 'confirmed' | 'unconfirmed' | 'overruled' | 'heuristic' | 'measured';

/**
 * What the search said about this fact, in the explanation OF THE POSITION ON
 * SCREEN. A sentence is about a fact only if it cites that fact's id, and the
 * citation comes from Prolog (a motif states which facts it rests on). Nothing
 * is matched up by kind or by squares here. Null means the search has not
 * assessed the fact, and the UI says so.
 */
export function verdictFor(
  fact: Pick<Fact, 'id'>,
  explanation: MessageOf<'explanation'> | null,
  positionId: number | null,
): Verdict | null {
  if (!explanation || explanation.positionId !== positionId) return null;
  const item = explanation.items.find((i) => i.source === 'prolog' && (i.facts ?? []).includes(fact.id));
  return item ? item.status : null;
}
