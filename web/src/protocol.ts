// Wire protocol between the Lisp engine and this UI (protocol version 1).
//
// The engine is authoritative. These types describe what it sends; nothing in
// the frontend computes legality, notation, clocks or analysis on its own.
// docs/ARCHITECTURE.md section 9 is the prose version of this file.

export type Color = 'white' | 'black';
export type Square = string; // "a1".."h8"
export type PieceCode = string; // "wK", "bp"... colour letter + piece letter

export interface LegalMove {
  uci: string;
  san: string;
  from: Square;
  to: Square;
  promotion: string | null;
  capture: boolean;
}

export interface HistoryEntry {
  ply: number;
  san: string;
  uci: string;
  by: 'human' | 'engine';
}

export type GameStatus =
  | 'active'
  | 'checkmate'
  | 'stalemate'
  | 'draw_repetition'
  | 'draw_50'
  | 'draw_material'
  | 'timeout'
  | 'resigned';

export type Mode = 'play' | 'analysis';

export interface GameState {
  type: 'game_state';
  seq: number;
  positionId: number;
  fen: string;
  board: Record<Square, PieceCode>;
  turn: Color;
  moveNumber: number;
  check: Square | null;
  lastMove: { from: Square; to: Square } | null;
  history: HistoryEntry[];
  legalMoves: LegalMove[];
  status: GameStatus;
  winner: Color | null;
  clocks: {
    enabled: boolean;
    whiteMs: number;
    blackMs: number;
    incrementMs: number;
    running: Color | null;
  };
  settings: { mode: Mode; humanColor: Color; depth: number; moveTimeMs: number };
  captured: { white: string[]; black: string[] };
  engineThinking: boolean;
}

/** Scores are always from White's point of view. Exactly one field is non-null. */
export interface Score {
  cp: number | null;
  mate: number | null;
}

export interface SearchInfo {
  depth: number;
  score: Score;
  nodes: number;
  timeMs: number;
  nps: number;
  bestMove: LegalMove | null;
  pv: string[];
  pvUci: string[];
}

export interface EvalBreakdown {
  material: number;
  placement: number;
  pawnStructure: number;
  bishopPair: number;
  /** Mobility and rooks on open files. Absent from engines before 0.3. */
  activity?: number;
  /** Pawn cover in front of each king. Absent from engines before 0.3. */
  kingSafety?: number;
  total: number;
}

/** A drawing primitive. Every one belongs to a Prolog fact, plan or inspection. */
export type Viz =
  | { type: 'arrow'; from: Square; to: Square; style: string }
  | { type: 'ring'; square: Square; style: string }
  | { type: 'square'; square: Square; style: string }
  | { type: 'file'; file: string; style: string };

export interface Fact {
  id: string;
  kind: string;
  side: Color | null;
  squares: Square[];
  text: string;
  /** The fact's subject in a few words, e.g. "black knight c6". */
  label?: string;
  viz: Viz[];
  /** "explanation" or "mirrors_eval": what the engine actually uses this fact for. */
  use: string;
}

export interface Plan {
  id: string;
  kind: string;
  text: string;
  because: string[];
  viz: Viz[];
}

export interface Motif {
  kind: string;
  score: number;
  targets: Square[];
  text: string;
}

export interface MoveHint {
  uci: string;
  san?: string;
  score: number;
  motifs: Motif[];
}

export interface ExplanationItem {
  source: 'search' | 'eval' | 'prolog';
  status: 'measured' | 'confirmed' | 'unconfirmed' | 'overruled' | 'heuristic';
  text: string;
  squares: Square[];
  /** The Prolog move motif this sentence reports on, if any. */
  motif?: string | null;
}

export type ServerMessage =
  | {
      type: 'hello';
      seq: number;
      protocol: number;
      engine: string;
      lisp: string;
      prolog: string | null;
      /** Seats in use / available on this server, and its per-player ceilings. */
      players?: number;
      maxPlayers?: number;
      maxDepth?: number;
      maxMoveTimeMs?: number;
    }
  | GameState
  | {
      type: 'move_played';
      seq: number;
      positionId: number;
      move: { san: string; uci: string; from: Square; to: Square; by: 'human' | 'engine'; ply: number };
    }
  | {
      type: 'search_started';
      seq: number;
      positionId: number;
      searchId: number;
      purpose: 'play' | 'analysis';
      maxDepth: number;
      timeLimitMs: number;
      symbolicHints: boolean;
    }
  | ({ type: 'search_update'; seq: number; positionId: number; searchId: number } & SearchInfo)
  | ({
      type: 'search_complete';
      seq: number;
      positionId: number;
      searchId: number;
      purpose: 'play' | 'analysis';
      evalBreakdown: EvalBreakdown;
      /** True when stop_search ended the search before its own limits did. */
      stopped?: boolean;
    } & SearchInfo)
  | {
      type: 'symbolic_analysis';
      seq: number;
      positionId: number;
      status: 'ok' | 'unavailable';
      facts: Fact[];
      plans: Plan[];
      moveHints: MoveHint[];
      elapsedMs: number;
    }
  | {
      type: 'explanation';
      seq: number;
      positionId: number;
      searchId: number;
      move: LegalMove;
      summary: string;
      items: ExplanationItem[];
    }
  | {
      type: 'inspection';
      seq: number;
      positionId: number;
      square: Square;
      piece: { color: Color; type: string } | null;
      white: { type: string; square: Square }[];
      black: { type: string; square: Square }[];
      attacks: Square[];
      lines: string[];
      viz: Viz[];
    }
  | { type: 'error'; seq: number; code: string; message: string; inReplyTo: number | null };

export type ServerMessageType = ServerMessage['type'];
export type MessageOf<T extends ServerMessageType> = Extract<ServerMessage, { type: T }>;

export type ClientCommand =
  | { type: 'sync' }
  | { type: 'new_game'; humanColor?: Color; mode?: Mode; fen?: string }
  | { type: 'make_move'; uci: string; positionId: number }
  | { type: 'undo_move' }
  | { type: 'request_analysis'; positionId: number }
  | { type: 'stop_search' }
  | { type: 'set_engine_depth'; depth?: number; moveTimeMs?: number }
  | { type: 'set_time_control'; baseMs: number | null; incrementMs?: number }
  | { type: 'set_mode'; mode: Mode; humanColor?: Color }
  | { type: 'inspect_square'; square: Square; positionId: number }
  | { type: 'resign' };

// ---------------------------------------------------------------- validation
// A deliberately small structural check: enough to reject a message that would
// crash the reducer or draw something the engine did not say. The same checks
// run in the contract test against messages captured from the real engine.

type Check = (v: unknown) => boolean;
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const str: Check = (v) => typeof v === 'string';
const num: Check = (v) => typeof v === 'number' && Number.isFinite(v);
const bool: Check = (v) => typeof v === 'boolean';
const arr =
  (item: Check): Check =>
  (v) =>
    Array.isArray(v) && v.every(item);
const nullable =
  (c: Check): Check =>
  (v) =>
    v === null || c(v);
const shape =
  (fields: Record<string, Check>): Check =>
  (v) =>
    isObj(v) && Object.entries(fields).every(([k, c]) => c(v[k]));
const oneOf =
  (...values: string[]): Check =>
  (v) =>
    typeof v === 'string' && values.includes(v);

const SQUARE = /^[a-h][1-8]$/;
const square: Check = (v) => typeof v === 'string' && SQUARE.test(v);
const color = oneOf('white', 'black');

const viz: Check = (v) => {
  if (!isObj(v) || !str(v.style)) return false;
  switch (v.type) {
    case 'arrow':
      return square(v.from) && square(v.to);
    case 'ring':
    case 'square':
      return square(v.square);
    case 'file':
      return typeof v.file === 'string' && /^[a-h]$/.test(v.file);
    default:
      return false;
  }
};

const legalMove = shape({
  uci: str,
  san: str,
  from: square,
  to: square,
  promotion: nullable(str),
  capture: bool,
});
const score = shape({ cp: nullable(num), mate: nullable(num) });
const searchInfo = {
  depth: num,
  score,
  nodes: num,
  timeMs: num,
  nps: num,
  bestMove: nullable(legalMove),
  pv: arr(str),
  pvUci: arr(str),
};

const validators: Record<ServerMessageType, Check> = {
  hello: shape({ protocol: num, engine: str, lisp: str, prolog: nullable(str) }),
  game_state: shape({
    positionId: num,
    fen: str,
    board: (v) => isObj(v) && Object.entries(v).every(([k, p]) => square(k) && str(p)),
    turn: color,
    moveNumber: num,
    check: nullable(square),
    lastMove: nullable(shape({ from: square, to: square })),
    history: arr(shape({ ply: num, san: str, uci: str, by: oneOf('human', 'engine') })),
    legalMoves: arr(legalMove),
    status: str,
    winner: nullable(color),
    clocks: shape({
      enabled: bool,
      whiteMs: num,
      blackMs: num,
      incrementMs: num,
      running: nullable(color),
    }),
    settings: shape({ mode: oneOf('play', 'analysis'), humanColor: color, depth: num, moveTimeMs: num }),
    captured: shape({ white: arr(str), black: arr(str) }),
    engineThinking: bool,
  }),
  move_played: shape({
    positionId: num,
    move: shape({ san: str, uci: str, from: square, to: square, by: oneOf('human', 'engine'), ply: num }),
  }),
  search_started: shape({
    positionId: num,
    searchId: num,
    purpose: oneOf('play', 'analysis'),
    maxDepth: num,
    timeLimitMs: num,
    symbolicHints: bool,
  }),
  search_update: shape({ positionId: num, searchId: num, ...searchInfo }),
  search_complete: shape({
    positionId: num,
    searchId: num,
    purpose: oneOf('play', 'analysis'),
    evalBreakdown: shape({ material: num, placement: num, pawnStructure: num, bishopPair: num, total: num }),
    ...searchInfo,
  }),
  symbolic_analysis: shape({
    positionId: num,
    status: oneOf('ok', 'unavailable'),
    facts: arr(
      shape({ id: str, kind: str, side: nullable(color), squares: arr(square), text: str, viz: arr(viz), use: str }),
    ),
    plans: arr(shape({ id: str, kind: str, text: str, because: arr(str), viz: arr(viz) })),
    moveHints: arr(
      shape({
        uci: str,
        score: num,
        motifs: arr(shape({ kind: str, score: num, targets: arr(square), text: str })),
      }),
    ),
    elapsedMs: num,
  }),
  explanation: shape({
    positionId: num,
    searchId: num,
    move: legalMove,
    summary: str,
    items: arr(
      shape({
        source: oneOf('search', 'eval', 'prolog'),
        status: oneOf('measured', 'confirmed', 'unconfirmed', 'overruled', 'heuristic'),
        text: str,
        squares: arr(square),
      }),
    ),
  }),
  inspection: shape({
    positionId: num,
    square,
    piece: nullable(shape({ color, type: str })),
    white: arr(shape({ type: str, square })),
    black: arr(shape({ type: str, square })),
    attacks: arr(square),
    lines: arr(str),
    viz: arr(viz),
  }),
  error: shape({ code: str, message: str, inReplyTo: nullable(num) }),
};

/** Parse and validate one engine message. Returns null for anything malformed. */
export function parseServerMessage(raw: string): ServerMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(value) || typeof value.type !== 'string' || !num(value.seq)) return null;
  const validate = validators[value.type as ServerMessageType];
  if (!validate || !validate(value)) return null;
  return value as unknown as ServerMessage;
}
