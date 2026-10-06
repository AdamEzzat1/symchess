import { useCallback, useEffect, useReducer, useRef } from 'react';
import { parseServerMessage, type ClientCommand } from './protocol';
import { initialState, reducer, type AppState } from './state';

/**
 * Where the engine lives. In development the Vite page and the engine are two
 * processes, so the engine's own port is used. In a production build the
 * engine serves this page itself, so the socket is simply "this host".
 */
function defaultEngineUrl(): string {
  if (import.meta.env.DEV) return 'ws://127.0.0.1:8765';
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}/ws`;
}

const ENGINE_URL: string = import.meta.env.VITE_ENGINE_URL ?? defaultEngineUrl();

const RETRY_WHEN_FULL_MS = 10_000;

export interface Engine {
  state: AppState;
  send: (command: ClientCommand) => void;
  dismissError: (key: number) => void;
  /** Connect again after the server dropped us for inactivity. */
  reconnect: () => void;
  url: string;
}

/**
 * Owns the WebSocket. On every (re)connect the reducer is reset and the engine
 * pushes a fresh `hello` + `game_state`, so the UI can never keep showing a
 * position from a previous connection.
 */
export function useEngine(): Engine {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const connectRef = useRef<() => void>(() => {});
  const nextId = useRef(1);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;
    // Why the server last turned us away, if it did. Decides how we retry.
    let refusal: 'server_full' | 'idle_timeout' | null = null;

    const connect = () => {
      if (closed) return;
      if (retry) clearTimeout(retry);
      refusal = null;
      dispatch({ kind: 'connection', status: 'connecting' });
      const socket = new WebSocket(ENGINE_URL);
      socketRef.current = socket;

      socket.onopen = () => {
        delay = 500;
        dispatch({ kind: 'connection', status: 'open' });
      };
      socket.onmessage = (event) => {
        const message = typeof event.data === 'string' ? parseServerMessage(event.data) : null;
        if (message) {
          if (message.type === 'error' && (message.code === 'server_full' || message.code === 'idle_timeout')) {
            refusal = message.code;
          }
          dispatch({ kind: 'message', message, receivedAt: performance.now() });
        } else {
          console.warn('Dropped malformed engine message', event.data);
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        dispatch({ kind: 'connection', status: 'closed' });
        // Dropped for being idle: do not quietly take a seat again. The user
        // reconnects when they come back.
        if (refusal === 'idle_timeout') return;
        const wait = refusal === 'server_full' ? RETRY_WHEN_FULL_MS : delay;
        retry = setTimeout(connect, wait);
        delay = Math.min(delay * 2, 5000);
      };
    };

    connectRef.current = connect;
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      socketRef.current?.close();
    };
  }, []);

  const send = useCallback((command: ClientCommand) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ ...command, id: nextId.current++ }));
    }
  }, []);

  const dismissError = useCallback((key: number) => dispatch({ kind: 'dismiss_error', key }), []);
  const reconnect = useCallback(() => connectRef.current(), []);

  return { state, send, dismissError, reconnect, url: ENGINE_URL };
}
