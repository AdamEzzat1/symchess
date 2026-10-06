import { useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { allSquares, BOARD, CELL, isLightSquare, squareAt, squareOrigin, type Point } from '../geometry';
import type { Color, GameState, LegalMove, Square, Viz } from '../protocol';
import { Overlays } from './Overlays';

// Solid chess glyphs for both colours; the fill colour distinguishes the side.
// U+FE0E asks for the text (not emoji) presentation.
const GLYPH: Record<string, string> = {
  K: '♚︎',
  Q: '♛︎',
  R: '♜︎',
  B: '♝︎',
  N: '♞︎',
  P: '♟︎',
};
const PIECE_NAME: Record<string, string> = {
  K: 'king',
  Q: 'queen',
  R: 'rook',
  B: 'bishop',
  N: 'knight',
  P: 'pawn',
};

interface Props {
  game: GameState;
  orientation: Color;
  /** False while the engine is thinking, the game is over, or we are offline. */
  interactive: boolean;
  viz: Viz[];
  onMove: (uci: string) => void;
  onSquareClick?: (square: Square) => void;
}

interface Drag {
  from: Square;
  point: Point;
  moved: boolean;
  wasSelected: boolean;
}

function Piece({ code, x, y, lifted }: { code: string; x: number; y: number; lifted?: boolean }) {
  const white = code[0] === 'w';
  return (
    <text
      className={`piece ${white ? 'piece-white' : 'piece-black'}${lifted ? ' piece-lifted' : ''}`}
      x={x + CELL / 2}
      y={y + CELL / 2}
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={CELL * 0.78}
      pointerEvents="none"
    >
      {GLYPH[code[1] ?? '']}
    </text>
  );
}

export function Board({ game, orientation, interactive, viz, onMove, onSquareClick }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [promotion, setPromotion] = useState<LegalMove[] | null>(null);
  const [positionId, setPositionId] = useState(game.positionId);

  // Any change of position invalidates local selection state.
  if (positionId !== game.positionId) {
    setPositionId(game.positionId);
    setSelected(null);
    setDrag(null);
    setPromotion(null);
  }

  // Legal moves come from the engine; this only indexes them by origin square.
  const movesFrom = useMemo(() => {
    const map = new Map<Square, LegalMove[]>();
    if (interactive) {
      for (const m of game.legalMoves) {
        const list = map.get(m.from);
        if (list) list.push(m);
        else map.set(m.from, [m]);
      }
    }
    return map;
  }, [game.legalMoves, interactive]);

  const targets = selected ? (movesFrom.get(selected) ?? []) : [];

  const tryMove = (from: Square, to: Square): boolean => {
    const candidates = (movesFrom.get(from) ?? []).filter((m) => m.to === to);
    if (candidates.length === 0) return false;
    if (candidates.length > 1) {
      setPromotion(candidates); // several legal moves share from/to: promotions
    } else {
      onMove(candidates[0]!.uci);
    }
    setSelected(null);
    return true;
  };

  const activate = (square: Square) => {
    onSquareClick?.(square);
    if (selected && selected !== square && tryMove(selected, square)) return;
    setSelected(movesFrom.has(square) && selected !== square ? square : null);
  };

  const toPoint = (event: PointerEvent): Point => {
    const rect = svgRef.current!.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * BOARD,
      y: ((event.clientY - rect.top) / rect.height) * BOARD,
    };
  };

  const onPointerDown = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0 || promotion) return;
    const point = toPoint(event);
    const square = squareAt(point, orientation);
    if (!square) return;
    onSquareClick?.(square);
    if (selected && selected !== square && tryMove(selected, square)) return;
    if (movesFrom.has(square)) {
      event.currentTarget.setPointerCapture(event.pointerId);
      setDrag({ from: square, point, moved: false, wasSelected: selected === square });
      setSelected(square);
    } else {
      setSelected(null);
    }
  };

  const onPointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const point = toPoint(event);
    const moved = drag.moved || Math.hypot(point.x - drag.point.x, point.y - drag.point.y) > 6;
    setDrag({ ...drag, point, moved });
  };

  const onPointerUp = (event: PointerEvent<SVGSVGElement>) => {
    if (!drag) return;
    const square = squareAt(toPoint(event), orientation);
    if (square && square !== drag.from) {
      if (!tryMove(drag.from, square) && drag.moved) setSelected(null);
    } else if (drag.wasSelected && !drag.moved) {
      setSelected(null); // second click on the same piece deselects it
    }
    setDrag(null);
  };

  const onKeyDown = (event: KeyboardEvent, square: Square) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      activate(square);
    } else if (event.key === 'Escape') {
      setSelected(null);
      setPromotion(null);
    }
  };

  const squares = allSquares();
  const labelFor = (square: Square): string => {
    const code = game.board[square];
    const piece = code ? `${code[0] === 'w' ? 'white' : 'black'} ${PIECE_NAME[code[1] ?? '']}` : 'empty';
    const flags = [
      square === selected ? 'selected' : '',
      targets.some((m) => m.to === square) ? 'legal destination' : '',
    ]
      .filter(Boolean)
      .join(', ');
    return `${square}, ${piece}${flags ? `, ${flags}` : ''}`;
  };

  return (
    <div className="board-wrap">
      <svg
        ref={svgRef}
        className={`board${interactive ? '' : ' board-locked'}`}
        viewBox={`0 0 ${BOARD} ${BOARD}`}
        role="grid"
        aria-label={`Chess board, ${game.turn} to move`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
      >
        {squares.map((square) => {
          const o = squareOrigin(square, orientation);
          const light = isLightSquare(square);
          const isLast = game.lastMove?.from === square || game.lastMove?.to === square;
          return (
            <g key={square}>
              <rect
                className={`sq ${light ? 'sq-light' : 'sq-dark'}`}
                x={o.x}
                y={o.y}
                width={CELL}
                height={CELL}
                role="gridcell"
                tabIndex={0}
                aria-label={labelFor(square)}
                onKeyDown={(e) => onKeyDown(e, square)}
              />
              {isLast && <rect className="sq-last" x={o.x} y={o.y} width={CELL} height={CELL} />}
              {square === selected && (
                <rect className="sq-selected" x={o.x} y={o.y} width={CELL} height={CELL} />
              )}
              {square === game.check && (
                <circle className="sq-check" cx={o.x + CELL / 2} cy={o.y + CELL / 2} r={CELL * 0.48} />
              )}
            </g>
          );
        })}

        {/* coordinates along the left and bottom edges */}
        {squares.map((square) => {
          const o = squareOrigin(square, orientation);
          const light = isLightSquare(square);
          const cls = `coord ${light ? 'coord-on-light' : 'coord-on-dark'}`;
          return (
            <g key={`c-${square}`} pointerEvents="none" aria-hidden="true">
              {o.x === 0 && (
                <text className={cls} x={o.x + 5} y={o.y + 18}>
                  {square[1]}
                </text>
              )}
              {o.y === BOARD - CELL && (
                <text className={cls} x={o.x + CELL - 15} y={o.y + CELL - 7}>
                  {square[0]}
                </text>
              )}
            </g>
          );
        })}

        <Overlays viz={viz} orientation={orientation} />

        {squares.map((square) => {
          const code = game.board[square];
          if (!code || (drag?.moved && drag.from === square)) return null;
          const o = squareOrigin(square, orientation);
          return <Piece key={`p-${square}`} code={code} x={o.x} y={o.y} />;
        })}

        {/* legal-move hints for the selected piece (engine-supplied moves) */}
        <g pointerEvents="none" aria-hidden="true">
          {targets.map((m) => {
            const o = squareOrigin(m.to, orientation);
            return m.capture ? (
              <circle
                key={m.uci}
                className="hint-capture"
                cx={o.x + CELL / 2}
                cy={o.y + CELL / 2}
                r={CELL * 0.44}
              />
            ) : (
              <circle key={m.uci} className="hint-move" cx={o.x + CELL / 2} cy={o.y + CELL / 2} r={CELL * 0.15} />
            );
          })}
        </g>

        {drag?.moved && game.board[drag.from] && (
          <Piece code={game.board[drag.from]!} x={drag.point.x - CELL / 2} y={drag.point.y - CELL / 2} lifted />
        )}
      </svg>

      {promotion && (
        <div className="promotion" role="dialog" aria-label="Choose promotion piece">
          <span>Promote to</span>
          {promotion.map((m) => {
            const letter = (m.promotion ?? 'q').toUpperCase();
            return (
              <button
                key={m.uci}
                type="button"
                className="promotion-choice"
                aria-label={PIECE_NAME[letter]}
                onClick={() => {
                  onMove(m.uci);
                  setPromotion(null);
                }}
              >
                {GLYPH[letter]}
              </button>
            );
          })}
          <button type="button" className="btn btn-quiet" onClick={() => setPromotion(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
