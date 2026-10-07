// "Why this move?": showing one position from the line the engine expects.
//
// The engine sends each position of the line ready-made, with Prolog's facts
// for it. This file only rearranges that into the shape the board and the
// overlay selectors already understand. It makes no move and judges nothing.

import type { GameState, LineStep, MessageOf } from './protocol';
import type { AppState } from './state';

/**
 * Replayed positions are not game positions, so they get ids no engine
 * position can have. Nothing with one of these ids is ever sent to the engine.
 */
export const replayPositionId = (index: number): number => -1 - index;

export interface ReplayView {
  index: number;
  step: LineStep;
  /** The step as a board to draw: no legal moves, so it cannot be played on. */
  game: GameState;
  /** The app state with that board and its facts swapped in, for the overlay selectors. */
  state: AppState;
}

/** Positions of an imported game being browsed get their own range of ids. */
export const reviewPositionId = (index: number): number => -100000 - index;

/** The view of step `index` of the line on hand, or null if there is no such step. */
export function replayView(state: AppState, index: number): ReplayView | null {
  const step = state.line?.steps[index];
  return step ? stepView(state, step, index, replayPositionId(index)) : null;
}

/** The view of position `index` of the imported game, or null if the engine has not sent it yet. */
export function reviewView(state: AppState, index: number): ReplayView | null {
  const step = state.review?.steps[index];
  return step ? stepView(state, step, index, reviewPositionId(index)) : null;
}

function stepView(state: AppState, step: LineStep, index: number, positionId: number): ReplayView | null {
  const { game } = state;
  if (!game) return null;
  const shown: GameState = {
    ...game,
    positionId,
    fen: step.fen,
    board: step.board,
    turn: step.turn,
    check: step.check,
    lastMove: step.move ? { from: step.move.from, to: step.move.to } : null,
    legalMoves: [],
    status: step.checkmate ? 'checkmate' : 'active',
    winner: step.checkmate ? step.by : null,
    engineThinking: false,
  };
  const symbolic: MessageOf<'symbolic_analysis'> = {
    type: 'symbolic_analysis',
    seq: state.lastSeq,
    positionId,
    status: step.symbolic ? 'ok' : 'unavailable',
    facts: step.facts,
    plans: [],
    moveHints: [],
    elapsedMs: 0,
  };
  return {
    index,
    step,
    game: shown,
    // The search and the clicked-square inspection are about the real position.
    state: { ...state, game: shown, symbolic, search: null, inspection: null },
  };
}

/** "3... Nf6" style labels for a line that starts at full move `moveNumber`. */
export function stepLabels(steps: readonly LineStep[], moveNumber: number): string[] {
  let number = moveNumber;
  return steps.map((step, i) => {
    if (!step.move) return 'Start';
    const white = step.by === 'white';
    const label = white ? `${number}. ${step.move.san}` : i === 1 ? `${number}… ${step.move.san}` : step.move.san;
    if (!white) number += 1;
    return label;
  });
}
