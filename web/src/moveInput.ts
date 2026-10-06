// Turning "the user pointed at two squares" into a command. This is lookup in
// the engine's own legal-move list, not chess logic: if the engine did not
// list a move, it cannot be sent.

import type { LegalMove, Square } from './protocol';

export type MoveChoice =
  | { kind: 'none' }
  | { kind: 'move'; uci: string }
  /** Several legal moves share from/to: they differ only by promotion piece. */
  | { kind: 'promotion'; options: LegalMove[] };

export function resolveMove(legalMoves: readonly LegalMove[], from: Square, to: Square): MoveChoice {
  const candidates = legalMoves.filter((m) => m.from === from && m.to === to);
  if (candidates.length === 0) return { kind: 'none' };
  if (candidates.length === 1) return { kind: 'move', uci: candidates[0]!.uci };
  return { kind: 'promotion', options: candidates };
}

/** Squares the selected piece may go to, straight from the engine's list. */
export function targetsFrom(legalMoves: readonly LegalMove[], from: Square | null): LegalMove[] {
  return from === null ? [] : legalMoves.filter((m) => m.from === from);
}

/** What pressing Enter/Space (or clicking) on a square should do. */
export type Activation =
  | { kind: 'select'; square: Square }
  | { kind: 'deselect' }
  | MoveChoice;

export function activateSquare(
  legalMoves: readonly LegalMove[],
  selected: Square | null,
  square: Square,
): Activation {
  if (selected !== null && selected !== square) {
    const choice = resolveMove(legalMoves, selected, square);
    if (choice.kind !== 'none') return choice;
  }
  const movable = legalMoves.some((m) => m.from === square);
  return movable && selected !== square ? { kind: 'select', square } : { kind: 'deselect' };
}
