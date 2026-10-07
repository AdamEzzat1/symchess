// Following a claim back to where it came from.
//
// Everything here is lookup among records the engine sent: a fact's rule is
// the index entry named after its kind, a plan's facts are the ids it cites,
// a sentence's facts are the ids it cites. Nothing is inferred from squares,
// wording or chess knowledge; where the engine sent no link, there is none.

import type { ExplanationItem, Fact, MessageOf, MoveHint, Motif, Plan, Rule } from './protocol';
import type { AppState } from './state';

/** Which search a sentence came from. */
export type Origin = 'explanation' | 'counterfactual';

export interface Said {
  origin: Origin;
  /** Position in that message's list of sentences. */
  index: number;
  searchId: number;
  /** The move the sentence is about, in the engine's notation. */
  move: string;
  item: ExplanationItem;
  /** What decided its status. */
  check: Rule | null;
}

export interface MoveUse {
  hint: MoveHint;
  motif: Motif;
  rule: Rule | null;
}

export interface FactTrace {
  kind: 'fact';
  fact: Fact;
  rule: Rule | null;
  /** Plans that cite this fact. */
  plans: { plan: Plan; rule: Rule | null }[];
  /** Candidate moves with a motif that Prolog says rests on this fact. */
  moves: MoveUse[];
  /** What a search said, in sentences that cite this fact. */
  said: Said[];
}

export interface PlanTrace {
  kind: 'plan';
  plan: Plan;
  rule: Rule | null;
  /** The facts it cites, each with its own rule. */
  facts: { fact: Fact; rule: Rule | null }[];
  said: Said[];
}

export interface ItemTrace {
  kind: 'item';
  said: Said;
  rule: Rule | null;
  /** The facts of the position the sentence cites. */
  facts: Fact[];
}

export type Trace = FactTrace | PlanTrace | ItemTrace;

export function ruleById(state: AppState, id: string | null | undefined): Rule | null {
  if (!id || !state.rules) return null;
  return state.rules.rules.find((rule) => rule.id === id) ?? null;
}

/** The symbolic analysis, if it is about the position on screen. */
function currentAnalysis(state: AppState): MessageOf<'symbolic_analysis'> | null {
  const { game, symbolic } = state;
  return game !== null && symbolic !== null && symbolic.positionId === game.positionId ? symbolic : null;
}

/** Every sentence a search has said about the position on screen. */
export function sentences(state: AppState): Said[] {
  const positionId = state.game?.positionId;
  const out: Said[] = [];
  const add = (origin: Origin, message: MessageOf<'explanation'> | MessageOf<'counterfactual'> | null) => {
    if (!message || message.positionId !== positionId) return;
    message.items.forEach((item, index) =>
      out.push({
        origin,
        index,
        searchId: message.searchId,
        move: message.move.san,
        item,
        check: ruleById(state, item.check),
      }),
    );
  };
  add('explanation', state.explanation);
  add('counterfactual', state.counterfactual);
  return out;
}

export function traceFact(state: AppState, id: string): FactTrace | null {
  const analysis = currentAnalysis(state);
  const fact = analysis?.facts.find((f) => f.id === id);
  if (!analysis || !fact) return null;
  return {
    kind: 'fact',
    fact,
    rule: ruleById(state, `fact:${fact.kind}`),
    plans: analysis.plans
      .filter((plan) => plan.because.includes(id))
      .map((plan) => ({ plan, rule: ruleById(state, `plan:${plan.kind}`) })),
    moves: analysis.moveHints.flatMap((hint) =>
      hint.motifs
        .filter((motif) => (motif.facts ?? []).includes(id))
        .map((motif) => ({ hint, motif, rule: ruleById(state, `motif:${motif.kind}`) })),
    ),
    said: sentences(state).filter((s) => (s.item.facts ?? []).includes(id)),
  };
}

export function tracePlan(state: AppState, id: string): PlanTrace | null {
  const analysis = currentAnalysis(state);
  const plan = analysis?.plans.find((p) => p.id === id);
  if (!analysis || !plan) return null;
  const rule = ruleById(state, `plan:${plan.kind}`);
  return {
    kind: 'plan',
    plan,
    rule,
    facts: analysis.facts
      .filter((fact) => plan.because.includes(fact.id))
      .map((fact) => ({ fact, rule: ruleById(state, `fact:${fact.kind}`) })),
    // A sentence is about this plan if it names the plan's rule and cites the same facts.
    said: sentences(state).filter(
      (s) =>
        s.item.rule === `plan:${plan.kind}` &&
        plan.because.every((factId) => (s.item.facts ?? []).includes(factId)),
    ),
  };
}

export function traceItem(state: AppState, origin: Origin, searchId: number, index: number): ItemTrace | null {
  const said = sentences(state).find((s) => s.origin === origin && s.searchId === searchId && s.index === index);
  if (!said) return null;
  const analysis = currentAnalysis(state);
  const cited = said.item.facts ?? [];
  return {
    kind: 'item',
    said,
    rule: ruleById(state, said.item.rule),
    facts: analysis ? analysis.facts.filter((fact) => cited.includes(fact.id)) : [],
  };
}

/**
 * The places where Prolog and a search differ, for the position on screen:
 * Prolog's sentences that the search overruled or left unconfirmed. The
 * statuses are the engine's; this only picks them out.
 */
export function disagreements(state: AppState): Said[] {
  return sentences(state).filter(
    (s) => s.item.source === 'prolog' && (s.item.status === 'overruled' || s.item.status === 'unconfirmed'),
  );
}
