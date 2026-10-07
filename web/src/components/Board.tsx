import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { allSquares, BOARD, CELL, FILES, isLightSquare, squareAt, squareOrigin, type Point } from '../geometry';
import { activateSquare, resolveMove, targetsFrom } from '../moveInput';
import type { Color, GameState, LegalMove, PieceCode, Square, Viz } from '../protocol';
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
  /** Short glides and fades instead of strikes and effects. */
  minimal?: boolean;
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

interface Arrival {
  /** Where the piece came from, relative to where it now stands. */
  dx: number;
  dy: number;
  /** It took something: lunge at the end instead of gliding in. */
  strike: boolean;
  /** The pawn this piece was a moment ago, if the move promoted it. */
  pawn: PieceCode | null;
}

interface PieceProps {
  code: string;
  x: number;
  y: number;
  lifted?: boolean;
  arrive?: Arrival;
  /** The king that has been checkmated. */
  mated?: boolean;
}

function BoardPiece({ code, x, y, lifted, arrive, mated }: PieceProps) {
  return (
    <g
      className={`board-piece${lifted ? ' board-piece-lifted' : ''}${mated ? ' piece-mated' : ''}`}
      transform={`translate(${x + PIECE_INSET} ${y + PIECE_INSET - 2}) scale(${PIECE_SCALE})`}
      pointerEvents="none"
    >
      {arrive ? (
        <g
          className={arrive.strike ? 'piece-arrive piece-strike' : 'piece-arrive'}
          style={{ '--fx': `${arrive.dx}px`, '--fy': `${arrive.dy}px` } as CSSProperties}
        >
          {arrive.pawn ? (
            // Promotion: the pawn arrives, dissolves upward, and the new piece forms from the same light.
            <>
              <g className="piece-dissolve">
                <PieceShape code={arrive.pawn} />
              </g>
              <circle className="piece-form-light" cx={50} cy={52} r={34} />
              <g className="piece-form">
                <PieceShape code={code} />
              </g>
            </>
          ) : (
            <PieceShape code={code} />
          )}
        </g>
      ) : (
        <PieceShape code={code} />
      )}
    </g>
  );
}

const SHARDS = [0, 1, 2, 3, 4, 5, 6, 7, 8];

/** A taken piece, knocked away from its attacker and breaking up. Purely decorative. */
function TakenPiece({ code, origin, from }: { code: PieceCode; origin: Point; from: Point }) {
  const length = Math.hypot(origin.x - from.x, origin.y - from.y) || 1;
  const ux = (origin.x - from.x) / length;
  const uy = (origin.y - from.y) / length;
  return (
    <g className="piece-taken-layer" transform={`translate(${origin.x} ${origin.y - 2})`} pointerEvents="none" aria-hidden="true">
      <g
        className={`piece-taken ${code[0] === 'w' ? 'pc-white' : 'pc-black'}`}
        style={{ '--kx': `${ux * 26}px`, '--ky': `${uy * 26}px`, '--tilt': `${ux >= 0 ? 55 : -55}deg` } as CSSProperties}
      >
        <PieceShape code={code} />
      </g>
      {/* The blow itself: a bright cut across the square, at right angles to the attack. */}
      <path
        className="piece-slash"
        d={`M${50 - uy * 44 - ux * 12} ${52 + ux * 44 - uy * 12} Q${50 + ux * 16} ${52 + uy * 16} ${50 + uy * 44 - ux * 12} ${52 - ux * 44 - uy * 12}`}
        pathLength={1}
      />
      <circle className="piece-impact" cx={50} cy={52} r={30} />
      {SHARDS.map((i) => {
        const angle = (i / SHARDS.length) * Math.PI * 2 + 0.3;
        const reach = 44 + (i % 3) * 12;
        return (
          <line
            key={i}
            className={`piece-shard ${code[0] === 'w' ? 'piece-shard-white' : 'piece-shard-black'}`}
            x1={50}
            y1={55}
            x2={50 + Math.cos(angle) * 9}
            y2={55 + Math.sin(angle) * 9}
            style={{ '--sx': `${Math.cos(angle) * reach + ux * 20}px`, '--sy': `${Math.sin(angle) * reach + uy * 20}px` } as CSSProperties}
          />
        );
      })}
    </g>
  );
}

const RAYS = [0, 1, 2, 3, 4, 5, 6, 7];

/**
 * Checkmate: lines run in from the edges of the board to the king, which
 * frosts over. Drawn where the engine says the checked king stands.
 */
function MateFx({ origin }: { origin: Point }) {
  const cx = origin.x + CELL / 2;
  const cy = origin.y + CELL / 2;
  return (
    <g className="mate-fx" pointerEvents="none" aria-hidden="true">
      {RAYS.map((i) => {
        const angle = (i / RAYS.length) * Math.PI * 2 + Math.PI / 8;
        // Start well outside the board; the SVG clips it at the edge.
        const x = cx + Math.cos(angle) * BOARD * 1.5;
        const y = cy + Math.sin(angle) * BOARD * 1.5;
        return (
          <line
            key={i}
            className="mate-ray"
            x1={x}
            y1={y}
            x2={cx + Math.cos(angle) * CELL * 0.5}
            y2={cy + Math.sin(angle) * CELL * 0.5}
            pathLength={1}
          />
        );
      })}
      <circle className="mate-frost" cx={cx} cy={cy} r={CELL * 0.5} />
      <circle className="mate-ring" cx={cx} cy={cy} r={CELL * 0.5} />
    </g>
  );
}

interface PromotionProps {
  options: LegalMove[];
  turn: Color;
  onChoose: (uci: string) => void;
  onCancel: () => void;
}

/** The promotion choices are the engine's own moves; this only shows them. */
export function PromotionPicker({ options, turn, onChoose, onCancel }: PromotionProps) {
  return (
    <div className="promotion" role="dialog" aria-label="Choose promotion piece">
      <span className="promotion-title">Promote to</span>
      <div className="promotion-row">
        {options.map((m) => {
          const letter = (m.promotion ?? 'q').toUpperCase();
          return (
            <button
              key={m.uci}
              type="button"
              className="promotion-choice"
              aria-label={PIECE_NAME[letter]}
              onClick={() => onChoose(m.uci)}
            >
              <PieceIcon code={`${turn === 'white' ? 'w' : 'b'}${letter}`} size={54} />
            </button>
          );
        })}
      </div>
      <button type="button" className="btn btn-quiet" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}

/** What just happened on the board, for animation only. */
interface MoveFx {
  positionId: number;
  from: Square;
  to: Square;
  /** The piece that stood on `to` and was taken, if any. */
  taken: PieceCode | null;
  /** The pawn that moved, if a different piece now stands where it arrived. */
  pawn: PieceCode | null;
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
  minimal = false,
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

  // Remember the previous position so the last move can be animated: the
  // mover slides in from where it stood, and a taken piece is shown breaking.
  // This compares two boards the engine sent; it works out no chess.
  const previous = useRef<{ positionId: number; board: Record<Square, PieceCode> } | null>(null);
  const [fx, setFx] = useState<MoveFx | null>(null);
  useEffect(() => {
    const before = previous.current;
    // The same position sent again (a clock or status update) changes nothing.
    if (before && before.positionId === game.positionId) return;
    previous.current = { positionId: game.positionId, board: game.board };
    const move = game.lastMove;
    const mover = before && move ? before.board[move.from] : undefined;
    if (!before || !move || !mover || !game.board[move.to] || game.board[move.from]) {
      setFx(null);
      return;
    }
    const victim = before.board[move.to];
    setFx({
      positionId: game.positionId,
      from: move.from,
      to: move.to,
      taken: victim && victim[0] !== mover[0] ? victim : null,
      pawn: mover[1] === 'P' && game.board[move.to] !== mover ? mover : null,
    });
  }, [game.positionId, game.board, game.lastMove]);

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

  // The engine names the checked king's square and says when it is mate.
  const mate = game.status === 'checkmate' ? game.check : null;

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
    <div
      className={`board-frame${thinking ? ' board-thinking' : ''}${showCoords ? ' board-with-coords' : ''}${minimal ? ' board-minimal' : ''}`}
    >
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
          const mated = mate !== null && mate === square;
          if (fx && fx.positionId === game.positionId && fx.to === square) {
            const start = squareOrigin(fx.from, orientation);
            return (
              <BoardPiece
                key={`p-${square}-${fx.positionId}`}
                code={code}
                x={o.x}
                y={o.y}
                arrive={{ dx: start.x - o.x, dy: start.y - o.y, strike: fx.taken !== null, pawn: fx.pawn }}
                mated={mated}
              />
            );
          }
          return <BoardPiece key={`p-${square}`} code={code} x={o.x} y={o.y} mated={mated} />;
        })}

        {mate && <MateFx key={`mate-${game.positionId}`} origin={squareOrigin(mate, orientation)} />}

        {fx && fx.taken && fx.positionId === game.positionId && (
          <TakenPiece key={`x-${fx.positionId}`} code={fx.taken} origin={squareOrigin(fx.to, orientation)} from={squareOrigin(fx.from, orientation)} />
        )}

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
        <PromotionPicker
          options={promotion}
          turn={game.turn}
          onChoose={(uci) => {
            onMove(uci);
            setPromotion(null);
          }}
          onCancel={() => setPromotion(null)}
        />
      )}
    </div>
  );
}
