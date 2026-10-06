import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { allSquares, BOARD, CELL, FILES, isLightSquare, squareAt, squareOrigin, type Point } from '../geometry';
import { activateSquare, resolveMove, targetsFrom } from '../moveInput';
import type { Color, GameState, LegalMove, Square, Viz } from '../protocol';
import type { Focus } from '../selectViz';
import { Overlays } from './Overlays';
import { PIECE_NAME, PieceIcon, PieceShape } from './Pieces';

interface Props {
  game: GameState;
  orientation: Color;
  /** False while the engine is thinking, the game is over, or we are offline. */
  interactive: boolean;
  /** Standing overlays chosen by the layer toggles. */
  viz: Viz[];
  /** The glass inspector's isolated fact or plan, if any. */
  focus: Focus | null;
  thinking: boolean;
  /** Presentation switches from the Display panel. */
  showCoords: boolean;
  showHints: boolean;
  onMove: (uci: string) => void;
  onSquareClick?: (square: Square) => void;
}

interface Drag {
  from: Square;
  point: Point;
  moved: boolean;
  wasSelected: boolean;
}

/** Pieces are drawn in a 100-unit box; this seats one inside a square. */
const PIECE_SCALE = 1;
const PIECE_INSET = (CELL * (1 - PIECE_SCALE)) / 2;

function BoardPiece({ code, x, y, lifted }: { code: string; x: number; y: number; lifted?: boolean }) {
  return (
    <g
      className={lifted ? 'board-piece board-piece-lifted' : 'board-piece'}
      transform={`translate(${x + PIECE_INSET} ${y + PIECE_INSET - 2}) scale(${PIECE_SCALE})`}
      pointerEvents="none"
    >
      <PieceShape code={code} />
    </g>
  );
}

export function Board({
  game,
  orientation,
  interactive,
  viz,
  focus,
  thinking,
  showCoords,
  showHints,
  onMove,
  onSquareClick,
}: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [promotion, setPromotion] = useState<LegalMove[] | null>(null);

  // A new position invalidates everything the user had half-done on the old one.
  useEffect(() => {
    setSelected(null);
    setDrag(null);
    setPromotion(null);
  }, [game.positionId]);

  // Legal moves come from the engine. Nothing here knows how a piece moves.
  const legal = useMemo(() => (interactive ? game.legalMoves : []), [game.legalMoves, interactive]);
  const movable = useMemo(() => new Set(legal.map((m) => m.from)), [legal]);
  const targets = targetsFrom(legal, selected);

  const tryMove = (from: Square, to: Square): boolean => {
    const choice = resolveMove(legal, from, to);
    if (choice.kind === 'none') return false;
    if (choice.kind === 'promotion') setPromotion(choice.options);
    else onMove(choice.uci);
    setSelected(null);
    return true;
  };

  const activate = (square: Square) => {
    onSquareClick?.(square);
    const action = activateSquare(legal, selected, square);
    switch (action.kind) {
      case 'move':
        onMove(action.uci);
        setSelected(null);
        break;
      case 'promotion':
        setPromotion(action.options);
        setSelected(null);
        break;
      case 'select':
        setSelected(action.square);
        break;
      default:
        setSelected(null);
    }
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
    if (movable.has(square)) {
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
  const files = orientation === 'white' ? [...FILES] : [...FILES].reverse();
  const ranks = orientation === 'white' ? [8, 7, 6, 5, 4, 3, 2, 1] : [1, 2, 3, 4, 5, 6, 7, 8];
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

  // Glass inspector: dim everything except the squares the evidence names.
  // If the item supplied nothing to draw, the board is left alone.
  const inspecting = focus !== null && focus.viz.length > 0;
  const dimPath = inspecting
    ? `M0 0H${BOARD}V${BOARD}H0Z` +
      focus.squares
        .map((sq) => {
          const o = squareOrigin(sq, orientation);
          return `M${o.x} ${o.y}h${CELL}v${CELL}h${-CELL}Z`;
        })
        .join('')
    : null;

  return (
    <div className={`board-frame${thinking ? ' board-thinking' : ''}${showCoords ? ' board-with-coords' : ''}`}>
      {showCoords && (
        <div className="board-ranks" aria-hidden="true">
          {ranks.map((r) => (
            <span key={r}>{r}</span>
          ))}
        </div>
      )}
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
              <rect className="sq-glass" x={o.x} y={o.y} width={CELL} height={CELL} fill="url(#sq-glass)" />
              {isLast && <rect className="sq-last" x={o.x} y={o.y} width={CELL} height={CELL} />}
              {square === selected && (
                <rect className="sq-selected" x={o.x + 2.5} y={o.y + 2.5} width={CELL - 5} height={CELL - 5} />
              )}
              {square === game.check && (
                <circle className="sq-check" cx={o.x + CELL / 2} cy={o.y + CELL / 2} r={CELL * 0.47} />
              )}
            </g>
          );
        })}

        <Overlays viz={viz} orientation={orientation} tone={inspecting ? 'dimmed' : 'standing'} />

        {squares.map((square) => {
          const code = game.board[square];
          if (!code || (drag?.moved && drag.from === square)) return null;
          const o = squareOrigin(square, orientation);
          return <BoardPiece key={`p-${square}`} code={code} x={o.x} y={o.y} />;
        })}

        {dimPath && <path className="board-dim" d={dimPath} fillRule="evenodd" pointerEvents="none" />}
        {inspecting && <Overlays viz={focus.viz} orientation={orientation} tone="focus" />}

        {/* legal-move hints for the selected piece (engine-supplied moves) */}
        <g pointerEvents="none" aria-hidden="true">
          {(showHints ? targets : []).map((m) => {
            const o = squareOrigin(m.to, orientation);
            return m.capture ? (
              <circle key={m.uci} className="hint-capture" cx={o.x + CELL / 2} cy={o.y + CELL / 2} r={CELL * 0.44} />
            ) : (
              <circle key={m.uci} className="hint-move" cx={o.x + CELL / 2} cy={o.y + CELL / 2} r={CELL * 0.13} />
            );
          })}
        </g>

        {drag?.moved && game.board[drag.from] && (
          <BoardPiece code={game.board[drag.from]!} x={drag.point.x - CELL / 2} y={drag.point.y - CELL / 2} lifted />
        )}
      </svg>
      {showCoords && (
        <div className="board-files" aria-hidden="true">
          {files.map((f) => (
            <span key={f}>{f}</span>
          ))}
        </div>
      )}

      {promotion && (
        <div className="promotion" role="dialog" aria-label="Choose promotion piece">
          <span className="promotion-title">Promote to</span>
          <div className="promotion-row">
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
                  <PieceIcon code={`${game.turn === 'white' ? 'w' : 'b'}${letter}`} size={54} />
                </button>
              );
            })}
          </div>
          <button type="button" className="btn btn-quiet" onClick={() => setPromotion(null)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
