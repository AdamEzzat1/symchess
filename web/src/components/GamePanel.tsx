import { useEffect, useRef, useState } from 'react';
import { formatClock } from '../geometry';
import type { ClientCommand, Color, GameState } from '../protocol';

const PIECE_GLYPH: Record<string, string> = {
  p: '♟︎',
  n: '♞︎',
  b: '♝︎',
  r: '♜︎',
  q: '♛︎',
};
const CAPTURE_ORDER = ['q', 'r', 'b', 'n', 'p'];

/** Re-render on an interval while a clock is running. Display only. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [active]);
  return active ? now : performance.now();
}

interface PlayerBarProps {
  game: GameState;
  color: Color;
  receivedAt: number;
}

export function PlayerBar({ game, color, receivedAt }: PlayerBarProps) {
  const { clocks, settings } = game;
  const running = clocks.running === color;
  const now = useNow(running);
  // The engine's snapshot is the truth; between snapshots we only subtract
  // locally elapsed time so the display keeps moving.
  const snapshot = color === 'white' ? clocks.whiteMs : clocks.blackMs;
  const shown = running ? snapshot - (now - receivedAt) : snapshot;

  const isEngine = settings.mode === 'play' && settings.humanColor !== color;
  const name = settings.mode === 'analysis' ? (color === 'white' ? 'White' : 'Black') : isEngine ? 'SymChess engine' : 'You';
  const captured = [...game.captured[color]].sort(
    (a, b) => CAPTURE_ORDER.indexOf(a) - CAPTURE_ORDER.indexOf(b),
  );
  const toMove = game.status === 'active' && game.turn === color;

  return (
    <div className={`player${toMove ? ' player-to-move' : ''}`}>
      <span className={`player-dot player-dot-${color}`} aria-hidden="true" />
      <div className="player-main">
        <span className="player-name">
          {name}
          {isEngine && game.engineThinking && <span className="thinking"> thinking…</span>}
        </span>
        <span className={`captured captured-by-${color}`} aria-label={`Pieces captured by ${color}`}>
          {captured.map((p, i) => (
            <span key={i}>{PIECE_GLYPH[p]}</span>
          ))}
        </span>
      </div>
      {clocks.enabled && (
        <span className={`clock${running ? ' clock-running' : ''}${shown < 20000 ? ' clock-low' : ''}`}>
          {formatClock(shown)}
        </span>
      )}
    </div>
  );
}

export function MoveList({ game }: { game: GameState }) {
  const endRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [game.history.length]);

  const rows: { number: number; white?: string; black?: string }[] = [];
  game.history.forEach((entry, index) => {
    const row = Math.floor(index / 2);
    rows[row] ??= { number: row + 1 };
    if (index % 2 === 0) rows[row]!.white = entry.san;
    else rows[row]!.black = entry.san;
  });

  return (
    <ol className="moves" aria-label="Move history">
      {rows.length === 0 && <li className="moves-empty">No moves yet.</li>}
      {rows.map((row, i) => (
        <li key={row.number} ref={i === rows.length - 1 ? endRef : undefined} className="moves-row">
          <span className="moves-number">{row.number}.</span>
          <span className="moves-san">{row.white ?? ''}</span>
          <span className="moves-san">{row.black ?? ''}</span>
        </li>
      ))}
    </ol>
  );
}

const STATUS_TEXT: Record<string, string> = {
  checkmate: 'Checkmate',
  stalemate: 'Draw by stalemate',
  draw_repetition: 'Draw by threefold repetition',
  draw_50: 'Draw by the fifty-move rule',
  draw_material: 'Draw: insufficient material',
  timeout: 'Out of time',
  resigned: 'Resignation',
};

export function StatusBanner({ game }: { game: GameState }) {
  if (game.status === 'active') return null;
  const winner = game.winner ? `${game.winner === 'white' ? 'White' : 'Black'} wins` : null;
  return (
    <div className="banner" role="status">
      <strong>{STATUS_TEXT[game.status] ?? game.status}</strong>
      {winner && <span> · {winner}</span>}
    </div>
  );
}

const TIME_CONTROLS: { label: string; baseMs: number | null; incrementMs: number }[] = [
  { label: 'No clock', baseMs: null, incrementMs: 0 },
  { label: '1 min', baseMs: 60_000, incrementMs: 0 },
  { label: '3 | 2', baseMs: 180_000, incrementMs: 2000 },
  { label: '5 min', baseMs: 300_000, incrementMs: 0 },
  { label: '10 | 5', baseMs: 600_000, incrementMs: 5000 },
];

/** Preset options plus the engine's actual value, so the control never lies. */
function withCurrent(presets: number[], current: number): number[] {
  return presets.includes(current) ? presets : [...presets, current].sort((a, b) => a - b);
}

interface ControlsProps {
  game: GameState;
  disabled: boolean;
  onFlip: () => void;
  send: (command: ClientCommand) => void;
}

export function Controls({ game, disabled, onFlip, send }: ControlsProps) {
  const { settings, clocks } = game;
  const [side, setSide] = useState<Color>(settings.humanColor);
  const [timeIndex, setTimeIndex] = useState(() =>
    Math.max(
      0,
      TIME_CONTROLS.findIndex((t) => (clocks.enabled ? t.baseMs !== null && t.incrementMs === clocks.incrementMs : t.baseMs === null)),
    ),
  );

  const newGame = () => {
    const tc = TIME_CONTROLS[timeIndex]!;
    send({ type: 'set_time_control', baseMs: tc.baseMs, incrementMs: tc.incrementMs });
    send({ type: 'new_game', humanColor: side, mode: settings.mode });
  };

  return (
    <div className="controls">
      <div className="control-row">
        <button type="button" className="btn btn-primary" onClick={newGame} disabled={disabled}>
          New game
        </button>
        <label className="field">
          <span>Play as</span>
          <select value={side} onChange={(e) => setSide(e.target.value as Color)} disabled={disabled}>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </label>
        <label className="field">
          <span>Clock</span>
          <select value={timeIndex} onChange={(e) => setTimeIndex(Number(e.target.value))} disabled={disabled}>
            {TIME_CONTROLS.map((t, i) => (
              <option key={t.label} value={i}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="control-row">
        <button
          type="button"
          className="btn"
          onClick={() => send({ type: 'undo_move' })}
          disabled={disabled || game.history.length === 0}
        >
          Take back
        </button>
        <button type="button" className="btn" onClick={onFlip}>
          Flip board
        </button>
        <button
          type="button"
          className="btn"
          onClick={() => send({ type: 'resign' })}
          disabled={disabled || game.status !== 'active' || settings.mode !== 'play'}
        >
          Resign
        </button>
      </div>
      <div className="control-row">
        <label className="field">
          <span>Search depth</span>
          <select
            value={settings.depth}
            onChange={(e) => send({ type: 'set_engine_depth', depth: Number(e.target.value) })}
            disabled={disabled}
          >
            {withCurrent([2, 3, 4, 5, 6, 7, 8, 10, 12], settings.depth).map((d) => (
              <option key={d} value={d}>
                {d} plies
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>Time per move</span>
          <select
            value={settings.moveTimeMs}
            onChange={(e) => send({ type: 'set_engine_depth', moveTimeMs: Number(e.target.value) })}
            disabled={disabled}
          >
            {withCurrent([500, 1000, 3000, 5000, 10000], settings.moveTimeMs).map((ms) => (
              <option key={ms} value={ms}>
                {ms / 1000} s
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
