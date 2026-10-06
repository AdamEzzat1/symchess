// UI state derived from engine events. The reducer is the only place engine
// messages are interpreted, and its one job is to keep the screen faithful:
// anything tagged with a positionId that is not the current one is dropped.

import type {
  EvalBreakdown,
  GameState,
  MessageOf,
  SearchInfo,
  ServerMessage,
} from './protocol';

export type Connection = 'connecting' | 'open' | 'closed';

export interface SearchView {
  searchId: number;
  positionId: number;
  purpose: 'play' | 'analysis';
  running: boolean;
  symbolicHints: boolean;
  info: SearchInfo | null;
  evalBreakdown: EvalBreakdown | null;
}

export interface LogEntry {
  seq: number;
  type: string;
  positionId: number | null;
  dropped: boolean;
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
  errors: { key: number; code: string; message: string }[];
  log: LogEntry[];
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
  errors: [],
  log: [],
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

/** True when a position-tagged message no longer describes the board on screen. */
export function isStale(state: AppState, message: ServerMessage): boolean {
  switch (message.type) {
    case 'symbolic_analysis':
    case 'inspection':
      return state.game === null || message.positionId !== state.game.positionId;
    case 'search_update':
    case 'search_complete':
      return state.search === null || message.searchId !== state.search.searchId;
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
      return action.status === 'open'
        ? { ...initialState, connection: 'open' }
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
          return { ...base, hello: m };

        case 'game_state': {
          const moved = state.game === null || state.game.positionId !== m.positionId;
          const wentBack = state.game !== null && m.history.length < state.game.history.length;
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
            explanation: keepExplanation(state, m, moved, wentBack) ? state.explanation : null,
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
            },
          };

        case 'search_update':
          return { ...base, search: { ...state.search!, info: pick(m) } };

        case 'search_complete':
          return {
            ...base,
            search: { ...state.search!, running: false, info: pick(m), evalBreakdown: m.evalBreakdown },
          };

        case 'symbolic_analysis':
          return { ...base, symbolic: m };

        case 'explanation':
          return { ...base, explanation: m };

        case 'inspection':
          return { ...base, inspection: m };

        case 'error':
          return {
            ...base,
            errors: [...state.errors.slice(-3), { key: m.seq, code: m.code, message: m.message }],
          };
      }
    }
  }
}
