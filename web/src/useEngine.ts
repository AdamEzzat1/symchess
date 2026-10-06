import { useCallback, useEffect, useReducer, useRef } from 'react';
import { parseServerMessage, type ClientCommand } from './protocol';
import { initialState, reducer, type AppState } from './state';

const ENGINE_URL: string = import.meta.env.VITE_ENGINE_URL ?? 'ws://127.0.0.1:8765';

export interface Engine {
  state: AppState;
  send: (command: ClientCommand) => void;
  dismissError: (key: number) => void;
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
  const nextId = useRef(1);

  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let delay = 500;

    const connect = () => {
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
          dispatch({ kind: 'message', message, receivedAt: performance.now() });
        } else {
          console.warn('Dropped malformed engine message', event.data);
        }
      };
      socket.onclose = () => {
        if (socketRef.current === socket) socketRef.current = null;
        if (closed) return;
        dispatch({ kind: 'connection', status: 'closed' });
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 5000);
      };
    };

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

  return { state, send, dismissError, url: ENGINE_URL };
}
