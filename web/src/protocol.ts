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

/** How strongly the engine plays its own moves. The engine owns what each level means. */
export type Level = 'novice' | 'casual' | 'club' | 'expert';

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
  settings: { mode: Mode; humanColor: Color; level?: Level; depth: number; moveTimeMs: number };
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
  /** The same wherever this fact holds, so it can be followed from one position to the next. */
  key?: string;
  kind: string;
  side: Color | null;
  squares: Square[];
  text: string;
  /** The fact's subject in a few words, e.g. "black knight c6". */
  label?: string;
  viz: Viz[];
  /** "explanation" or "mirrors_eval": what the engine actually uses this fact for. */
  use: string;
  /**
   * How far Prolog checked it: "geometric" (read from the lines of attack) or
   * "legal_moves" (a claim about moves that survived a check against the legal
   * moves Lisp supplied).
   */
  checked?: string;
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
  /** Ids of the facts of this position the motif rests on, as Prolog states them. */
  facts?: string[];
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
  /** What produced the claim: the id of an entry in the rule index. */
  rule?: string | null;
  /** What decided the status: the id of another entry in the rule index. */
  check?: string | null;
  /** That check as it applied here, with its numbers. */
  basis?: string | null;
  /** Ids of the facts of the position this sentence rests on. */
  facts?: string[];
}

/**
 * One entry of the rule index. Prolog's entries quote the rule from its own
 * source file; the engine's entries describe a measurement or a check.
 */
export interface Rule {
  /** "fact:pin", "motif:creates_fork", "plan:exploit_pin", "check:material_gain"... */
  id: string;
  layer: 'prolog' | 'search' | 'eval';
  group: 'fact' | 'motif' | 'plan' | 'measurement' | 'check';
  name: string;
  /** File and predicate or function. */
  where: string;
  summary: string;
  /** The rule as written, for Prolog's rules. */
  source: string | null;
}

/** Where Prolog and the search stand on one search, counted by the engine. */
export interface Agreement {
  confirmed: number;
  unconfirmed: number;
  overruled: number;
  /** Advice the search cannot test at its depth. */
  unchecked: number;
  /** Prolog's highest-ranked move, if it ranked any. */
  prologTop: string | null;
  searchMove: string | null;
  sameMove: boolean | null;
}

/**
 * One position along a line the engine expects: the board after `move`, and
 * what Prolog says about it. The first step of a line has no move.
 */
export interface LineStep {
  move: LegalMove | null;
  by: Color | null;
  fen: string;
  board: Record<Square, PieceCode>;
  turn: Color;
  check: Square | null;
  checkmate: boolean;
  /** False when Prolog was not asked (the game is over) or did not answer. */
  symbolic: boolean;
  facts: Fact[];
}

/** One position of an imported game: a line step, plus a short search's verdict on it. */
export interface ReviewStep extends LineStep {
  /** 0 is the starting position; N is the position after the Nth half-move. */
  ply: number;
  /** White's view. Null where the game has ended. */
  score: Score | null;
  depth: number;
  evalBreakdown: EvalBreakdown;
  /** What the move that led here changed. Null for the starting position. */
  change?: StepChange | null;
}

/** The engine's comparison of a position with the one before it. */
export interface StepChange {
  before: Score | null;
  after: Score | null;
  /** The move the search preferred in the position before, in the engine's notation. */
  best?: string | null;
  /** What the mover gave up against that move, both searched to the same depth. */
  lossCp: number | null;
  verdict: string | null;
  /** Change in each evaluation term, White's view. */
  terms: Record<string, number>;
  factsAdded: Fact[];
  factsRemoved: Fact[];
  /** The comparison in sentences, each built from the numbers and facts above. */
  lines: string[];
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
      /** What each level's depth and time come to on this server. */
      levels?: { id: Level; depth: number; moveTimeMs: number }[];
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
      agreement?: Agreement;
    }
  | {
      /** The rules behind every claim. Sent once per connection; not about a position. */
      type: 'rules';
      seq: number;
      /** "unavailable": Prolog could not be asked, so only the engine's entries are listed. */
      status: 'ok' | 'unavailable';
      rules: Rule[];
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
  | {
      /** The line behind an explanation, position by position. Sent on request. */
      type: 'line_replay';
      seq: number;
      /** The position the line starts from. */
      positionId: number;
      searchId: number;
      steps: LineStep[];
    }
  | {
      /** "Why not this move?": the asked move compared with the engine's own choice. */
      type: 'counterfactual';
      seq: number;
      positionId: number;
      searchId: number;
      move: LegalMove;
      best: LegalMove;
      isBest: boolean;
      score: Score;
      bestScore: Score;
      lossCp: number | null;
      verdict: string;
      depth: number;
      line: string[];
      bestLine: string[];
      factsAdded: Fact[];
      factsRemoved: Fact[];
      bestFactsAdded: Fact[];
      bestFactsRemoved: Fact[];
      summary: string;
      /** What the rating can and cannot be taken to mean. Null where it says nothing against the move. */
      caution?: string | null;
      items: ExplanationItem[];
      agreement?: Agreement;
      viz: Viz[];
    }
  | {
      /** A PGN was read. Every move in `moves` was checked by the engine. */
      type: 'game_loaded';
      seq: number;
      gameId: number;
      tags: Record<string, string>;
      /** The engine's own notation for the moves it accepted. */
      moves: string[];
      result: string | null;
      /** The half-move that stopped the reading, if one did. */
      error: { ply: number; text: string; message: string } | null;
    }
  | ({ type: 'review_step'; seq: number; gameId: number } & ReviewStep)
  | { type: 'review_complete'; seq: number; gameId: number; plies: number }
  | { type: 'review_closed'; seq: number; gameId: number }
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
  | { type: 'set_level'; level: Level }
  | { type: 'set_time_control'; baseMs: number | null; incrementMs?: number }
  | { type: 'set_mode'; mode: Mode; humanColor?: Color }
  | { type: 'inspect_square'; square: Square; positionId: number }
  | { type: 'request_line'; searchId: number }
  | { type: 'load_pgn'; pgn: string }
  | { type: 'explain_move'; uci: string; positionId: number }
  | { type: 'stop_review' }
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
/** A field older engines do not send. If it is there, it must be well formed. */
const optional =
  (c: Check): Check =>
  (v) =>
    v === undefined || c(v);
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

const board: Check = (v) => isObj(v) && Object.entries(v).every(([k, p]) => square(k) && str(p));
const fact = shape({ id: str, kind: str, side: nullable(color), squares: arr(square), text: str, viz: arr(viz), use: str });

const lineStep = {
  move: nullable(legalMove),
  by: nullable(color),
  fen: str,
  board,
  turn: color,
  check: nullable(square),
  checkmate: bool,
  symbolic: bool,
  facts: arr(fact),
};
const explanationItem = shape({
  source: oneOf('search', 'eval', 'prolog'),
  status: oneOf('measured', 'confirmed', 'unconfirmed', 'overruled', 'heuristic'),
  text: str,
  squares: arr(square),
  rule: optional(nullable(str)),
  check: optional(nullable(str)),
  basis: optional(nullable(str)),
  facts: optional(arr(str)),
});
const agreement = optional(
  shape({
    confirmed: num,
    unconfirmed: num,
    overruled: num,
    unchecked: num,
    prologTop: nullable(str),
    searchMove: nullable(str),
    sameMove: nullable(bool),
  }),
);
const rule = shape({
  id: str,
  layer: oneOf('prolog', 'search', 'eval'),
  group: oneOf('fact', 'motif', 'plan', 'measurement', 'check'),
  name: str,
  where: str,
  summary: str,
  source: nullable(str),
});
const stepChange = shape({
  before: nullable(score),
  after: nullable(score),
  lossCp: nullable(num),
  verdict: nullable(str),
  terms: (v) => isObj(v) && Object.values(v).every(num),
  factsAdded: arr(fact),
  factsRemoved: arr(fact),
  lines: arr(str),
});
const evalBreakdown = shape({ material: num, placement: num, pawnStructure: num, bishopPair: num, total: num });

const validators: Record<ServerMessageType, Check> = {
  hello: shape({ protocol: num, engine: str, lisp: str, prolog: nullable(str) }),
  game_state: shape({
    positionId: num,
    fen: str,
    board,
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
    evalBreakdown,
    ...searchInfo,
  }),
  symbolic_analysis: shape({
    positionId: num,
    status: oneOf('ok', 'unavailable'),
    facts: arr(fact),
    plans: arr(shape({ id: str, kind: str, text: str, because: arr(str), viz: arr(viz) })),
    moveHints: arr(
      shape({
        uci: str,
        score: num,
        motifs: arr(shape({ kind: str, score: num, targets: arr(square), text: str, facts: optional(arr(str)) })),
      }),
    ),
    elapsedMs: num,
  }),
  explanation: shape({
    positionId: num,
    searchId: num,
    move: legalMove,
    summary: str,
    items: arr(explanationItem),
    agreement,
  }),
  rules: shape({ status: oneOf('ok', 'unavailable'), rules: arr(rule) }),
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
  line_replay: shape({
    positionId: num,
    searchId: num,
    steps: arr(shape(lineStep)),
  }),
  counterfactual: shape({
    positionId: num,
    searchId: num,
    move: legalMove,
    best: legalMove,
    isBest: bool,
    score,
    bestScore: score,
    lossCp: nullable(num),
    verdict: str,
    depth: num,
    line: arr(str),
    bestLine: arr(str),
    factsAdded: arr(fact),
    factsRemoved: arr(fact),
    bestFactsAdded: arr(fact),
    bestFactsRemoved: arr(fact),
    summary: str,
    caution: optional(nullable(str)),
    items: arr(explanationItem),
    agreement,
    viz: arr(viz),
  }),
  game_loaded: shape({
    gameId: num,
    tags: (v) => isObj(v) && Object.values(v).every(str),
    moves: arr(str),
    result: nullable(str),
    error: nullable(shape({ ply: num, text: str, message: str })),
  }),
  review_step: shape({
    gameId: num,
    ply: num,
    score: nullable(score),
    depth: num,
    evalBreakdown,
    change: (v) => v === undefined || v === null || stepChange(v),
    ...lineStep,
  }),
  review_complete: shape({ gameId: num, plies: num }),
  review_closed: shape({ gameId: num }),
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
