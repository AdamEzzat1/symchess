import { allSquares, BOARD, CELL, isLightSquare, squareOrigin } from '../geometry';
import type { Color, PieceCode, Square, Viz } from '../protocol';
import { Overlays } from './Overlays';
import { PieceShape } from './Pieces';

interface Props {
  /** The position on screen, straight from `game_state.board`. */
  board: Record<Square, PieceCode>;
  orientation: Color;
  /** Only the pieces on these squares are drawn: the ones the evidence names. */
  squares: readonly Square[];
  viz: Viz[];
  size: number;
}

/** Fewest squares across a thumbnail may show, so pieces stay recognisable. */
const MIN_SPAN = 4;

/**
 * The square window of the board that contains every named square, with a
 * one-square margin where there is room. Pure geometry.
 */
export function cropWindow(squares: readonly Square[], orientation: Color): { x: number; y: number; span: number } {
  if (squares.length === 0) return { x: 0, y: 0, span: 8 };
  const cols = squares.map((sq) => squareOrigin(sq, orientation).x / CELL);
  const rows = squares.map((sq) => squareOrigin(sq, orientation).y / CELL);
  const minCol = Math.min(...cols);
  const minRow = Math.min(...rows);
  const width = Math.max(...cols) - minCol + 1;
  const height = Math.max(...rows) - minRow + 1;
  const span = Math.min(8, Math.max(MIN_SPAN, width + 1, height + 1));
  // Centre the evidence in the window, then keep the window on the board.
  const place = (min: number, size: number) =>
    Math.min(8 - span, Math.max(0, Math.round(min - (span - size) / 2)));
  return { x: place(minCol, width), y: place(minRow, height), span };
}

/**
 * A thumbnail of one fact or plan: the part of the real board it concerns,
 * the pieces it names, and its own drawing primitives. Nothing else.
 */
export function MiniBoard({ board, orientation, squares, viz, size }: Props) {
  const named = new Set(squares);
  const view = cropWindow(squares, orientation);
  return (
    <svg
      className="mini-board"
      viewBox={`${view.x * CELL} ${view.y * CELL} ${view.span * CELL} ${view.span * CELL}`}
      width={size}
      height={size}
      aria-hidden="true"
      focusable="false"
    >
      <rect width={BOARD} height={BOARD} className="sq-dark" />
      {allSquares()
        .filter(isLightSquare)
        .map((square) => {
          const o = squareOrigin(square, orientation);
          return <rect key={square} className="sq-light" x={o.x} y={o.y} width={CELL} height={CELL} />;
        })}
      <Overlays viz={viz} orientation={orientation} tone="mini" />
      {allSquares().map((square) => {
        const code = board[square];
        if (!code || !named.has(square)) return null;
        const o = squareOrigin(square, orientation);
        return (
          <g key={square} transform={`translate(${o.x + 2} ${o.y}) scale(0.96)`}>
            <PieceShape code={code} />
          </g>
        );
      })}
    </svg>
  );
}
