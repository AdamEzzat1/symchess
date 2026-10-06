// Decides which engine-supplied drawing primitives are on the board right now.
// It only ever SELECTS from what the engine and Prolog sent; the single thing
// it constructs is the best-move arrow, and that is a direct copy of the
// search's own bestMove.

import type { Viz } from './protocol';
import type { AppState } from './state';

export type Highlight = { kind: 'fact'; id: string } | { kind: 'plan'; id: string } | null;

export interface VizOptions {
  analysisMode: boolean;
  enabledKinds: ReadonlySet<string>;
  showBestMove: boolean;
  highlight: Highlight;
}

export function selectViz(state: AppState, options: VizOptions): Viz[] {
  const { game, symbolic, search, inspection } = state;
  // Normal play shows no reasoning overlays at all.
  if (!options.analysisMode || game === null) return [];

  const facts = symbolic && symbolic.positionId === game.positionId ? symbolic.facts : [];
  const plans = symbolic && symbolic.positionId === game.positionId ? symbolic.plans : [];

  // Hovering a fact or plan isolates it (a plan also shows the facts it cites).
  if (options.highlight?.kind === 'fact') {
    const id = options.highlight.id;
    return facts.filter((f) => f.id === id).flatMap((f) => f.viz);
  }
  if (options.highlight?.kind === 'plan') {
    const plan = plans.find((p) => p.id === options.highlight!.id);
    if (!plan) return [];
    return [...facts.filter((f) => plan.because.includes(f.id)).flatMap((f) => f.viz), ...plan.viz];
  }

  const out: Viz[] = facts.filter((f) => options.enabledKinds.has(f.kind)).flatMap((f) => f.viz);

  if (inspection && inspection.positionId === game.positionId) out.push(...inspection.viz);

  const best = search?.info?.bestMove;
  if (options.showBestMove && best && search.positionId === game.positionId) {
    out.push({ type: 'arrow', from: best.from, to: best.to, style: 'pv' });
  }
  return out;
}
