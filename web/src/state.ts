// UI state derived from engine events. The reducer is the only place engine
// messages are interpreted, and its one job is to keep the screen faithful:
// anything tagged with a positionId that is not the current one is dropped.

import type {
  EvalBreakdown,
  Score,
  GameState,
  MessageOf,
  ReviewStep,
  SearchInfo,
  ServerMessage,
} from './protocol';

export type Connection = 'connecting' | 'open' | 'closed';

/** One completed search depth, for the search trace. */
export interface TraceTick {
  depth: number;
  score: Score;
  /** Cumulative nodes and elapsed time when this depth finished. */
  nodes: number;
  timeMs: number;
}

export interface SearchView {
  searchId: number;
  positionId: number;
  purpose: 'play' | 'analysis';
  running: boolean;
  symbolicHints: boolean;
  info: SearchInfo | null;
  evalBreakdown: EvalBreakdown | null;
  /** Every depth this search has completed so far, in order. */
  trace: TraceTick[];
  stopped: boolean;
  /** The depth limit this search was started with. */
  maxDepth: number;
}

export interface LogEntry {
  seq: number;
  type: string;
  positionId: number | null;
  dropped: boolean;
}

/** An imported game and what the engine has said about its positions so far. */
export interface Review {
  gameId: number;
  tags: Record<string, string>;
  moves: string[];
  result: string | null;
  error: { ply: number; text: string; message: string } | null;
  /** Indexed by ply. A position the engine has not reached yet is undefined. */
  steps: (ReviewStep | undefined)[];
  complete: boolean;
}

export interface AppState {
  connection: Connection;
  hello: MessageOf<'hello'> | null;
  game: GameState | null;
  /** performance.now() when `game` arrived; clocks count down from here. */
  gameReceivedAt: number;
  lastSeq: number;
  search: SearchView | null;
  symbolic: MessageOf<'symbolic_analysis'> | null;
  explanation: MessageOf<'explanation'> | null;
  inspection: MessageOf<'inspection'> | null;
  /** The line behind `explanation`, once asked for. Never outlives it. */
  line: MessageOf<'line_replay'> | null;
  review: Review | null;
  errors: { key: number; code: string; message: string }[];
  log: LogEntry[];
  /** Set when the server turned this client away rather than failing. */
  refusal: { code: 'server_full' | 'idle_timeout'; message: string } | null;
}

export const initialState: AppState = {
  connection: 'connecting',
  hello: null,
  game: null,
  gameReceivedAt: 0,
  lastSeq: 0,
  search: null,
  symbolic: null,
  explanation: null,
  inspection: null,
  line: null,
  review: null,
  errors: [],
  log: [],
  refusal: null,
};

export type Action =
  | { kind: 'connection'; status: Connection }
  | { kind: 'message'; message: ServerMessage; receivedAt: number }
  | { kind: 'dismiss_error'; key: number };

const LOG_LIMIT = 40;

function pick(m: ServerMessage): SearchInfo {
  const { depth, score, nodes, timeMs, nps, bestMove, pv, pvUci } = m as MessageOf<'search_update'>;
  return { depth, score, nodes, timeMs, nps, bestMove, pv, pvUci };
}

function addTick(
  trace: TraceTick[],
  m: { depth: number; score: Score; nodes: number; timeMs: number },
): TraceTick[] {
  // search_complete repeats the last depth; keep one tick per depth.
  const rest = trace.filter((t) => t.depth !== m.depth);
  return [...rest, { depth: m.depth, score: m.score, nodes: m.nodes, timeMs: m.timeMs }];
}

/** True when a position-tagged message no longer describes the board on screen. */
export function isStale(state: AppState, message: ServerMessage): boolean {
  switch (message.type) {
    case 'symbolic_analysis':
    case 'inspection':
      return state.game === null || message.positionId !== state.game.positionId;
    case 'search_update':
    case 'search_complete':
      return state.search === null || message.searchId !== state.search.searchId;
    case 'review_step':
    case 'review_complete':
    case 'review_closed':
      // Belongs to an imported game this client is no longer holding.
      return state.review === null || message.gameId !== state.review.gameId;
    case 'line_replay':
      // A line belongs to the explanation on screen and to nothing else.
      return state.explanation === null || message.searchId !== state.explanation.searchId;
    default:
      return false;
  }
}

function keepExplanation(state: AppState, next: GameState, moved: boolean, wentBack: boolean): boolean {
  const explanation = state.explanation;
  if (!explanation || wentBack || next.history.length === 0) return false;
  if (!moved) return true;
  // A recommendation from an analysis search is about one position only.
  const fromAnalysis = state.search?.searchId === explanation.searchId && state.search.purpose === 'analysis';
  if (fromAnalysis) return false;
  // An explanation of the engine's own move stays while that move is the last one.
  return explanation.positionId >= next.positionId - 1;
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.kind) {
    case 'connection':
      // A new socket starts a new event stream: forget everything that was
      // derived from the old one and wait for the engine's fresh snapshot.
      // A refusal outlives the socket (that is when it is on screen) and is
      // only cleared once the server actually lets us in with a `hello`, so
      // the "server full" screen does not flicker on every retry.
      return action.status === 'open'
        ? { ...initialState, connection: 'open', refusal: state.refusal }
        : { ...state, connection: action.status };

    case 'dismiss_error':
      return { ...state, errors: state.errors.filter((e) => e.key !== action.key) };

    case 'message': {
      const m = action.message;
      if (m.seq <= state.lastSeq) return state; // duplicate or out of order
      const dropped = isStale(state, m);
      const log = [
        ...state.log.slice(-(LOG_LIMIT - 1)),
        { seq: m.seq, type: m.type, positionId: 'positionId' in m ? m.positionId : null, dropped },
      ];
      const base = { ...state, lastSeq: m.seq, log };
      if (dropped) return base;

      switch (m.type) {
        case 'hello':
          return { ...base, hello: m, refusal: null };

        case 'game_state': {
          const moved = state.game === null || state.game.positionId !== m.positionId;
          const wentBack = state.game !== null && m.history.length < state.game.history.length;
          const keep = keepExplanation(state, m, moved, wentBack);
          return {
            ...base,
            game: m,
            gameReceivedAt: action.receivedAt,
            symbolic: moved ? null : state.symbolic,
            inspection: moved ? null : state.inspection,
            // An analysis of a position that is gone must not linger on screen.
            search:
              moved && state.search && (state.search.purpose === 'analysis' || wentBack)
                ? null
                : state.search,
            // Keep an explanation only for the current position or for the move
            // that was just played from it; anything older would describe a
            // board that is no longer on screen.
            explanation: keep ? state.explanation : null,
            line: keep ? state.line : null,
          };
        }

        case 'move_played':
          return base;

        case 'search_started':
          return {
            ...base,
            search: {
              searchId: m.searchId,
              positionId: m.positionId,
              purpose: m.purpose,
              running: true,
              symbolicHints: m.symbolicHints,
              info: null,
              evalBreakdown: null,
              trace: [],
              stopped: false,
              maxDepth: m.maxDepth,
            },
          };

        case 'search_update':
          return { ...base, search: { ...state.search!, info: pick(m), trace: addTick(state.search!.trace, m) } };

        case 'search_complete':
          return {
            ...base,
            search: {
              ...state.search!,
              running: false,
              info: pick(m),
              evalBreakdown: m.evalBreakdown,
              trace: addTick(state.search!.trace, m),
              stopped: m.stopped === true,
            },
          };

        case 'symbolic_analysis':
          return { ...base, symbolic: m };

        case 'explanation':
          return { ...base, explanation: m, line: state.line?.searchId === m.searchId ? state.line : null };

        case 'line_replay':
          return { ...base, line: m };

        case 'game_loaded':
          return {
            ...base,
            review: { gameId: m.gameId, tags: m.tags, moves: m.moves, result: m.result, error: m.error, steps: [], complete: false },
          };

        case 'review_step': {
          const { type: _type, seq: _seq, gameId: _gameId, ...step } = m;
          const steps = state.review!.steps.slice();
          steps[m.ply] = step;
          return { ...base, review: { ...state.review!, steps } };
        }

        case 'review_complete':
          return { ...base, review: { ...state.review!, complete: true } };

        case 'review_closed':
          return { ...base, review: null };

        case 'inspection':
          return { ...base, inspection: m };

        case 'error':
          if (m.code === 'server_full' || m.code === 'idle_timeout') {
            return { ...base, refusal: { code: m.code, message: m.message } };
          }
          return {
            ...base,
            errors: [...state.errors.slice(-3), { key: m.seq, code: m.code, message: m.message }],
          };
      }
    }
  }
}
