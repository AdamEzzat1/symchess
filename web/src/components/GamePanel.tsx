import { useEffect, useState } from 'react';
import { formatClock } from '../geometry';
import type { ClientCommand, Color, GameState, Level } from '../protocol';
import { LAYERS, type LayerId } from '../selectViz';
import { styleSpec } from './Overlays';
import { Icon, type IconName } from './icons';
import { PieceIcon } from './Pieces';

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

/** Names for the engine's levels. What a level does is decided by the engine. */
export const LEVELS: { id: Level; label: string; blurb: string }[] = [
  { id: 'novice', label: 'Novice', blurb: 'Looks a short way ahead and does not always find the best move. Never gives a piece away for nothing.' },
  { id: 'casual', label: 'Casual', blurb: 'Judges positions properly but looks only a few moves ahead, and sometimes settles for a move that is nearly as good.' },
  { id: 'club', label: 'Club', blurb: 'A steady opponent: punishes loose pieces, can miss long plans.' },
  { id: 'expert', label: 'Expert', blurb: 'Plays to win: searches as deep as its time allows.' },
];

export function PlayerBar({ game, color, receivedAt }: PlayerBarProps) {
  const { clocks, settings } = game;
  const running = clocks.running === color;
  const now = useNow(running);
  // The engine's snapshot is the truth; between snapshots we only subtract
  // locally elapsed time so the display keeps moving.
  const snapshot = color === 'white' ? clocks.whiteMs : clocks.blackMs;
  const shown = running ? snapshot - (now - receivedAt) : snapshot;

  const isEngine = settings.mode === 'play' && settings.humanColor !== color;
  const side = color === 'white' ? 'White' : 'Black';
  const level = LEVELS.find((l) => l.id === settings.level);
  const name =
    settings.mode === 'analysis' ? side : isEngine ? `SymChess${level ? ` · ${level.label}` : ''}` : 'You';
  const captured = [...game.captured[color]].sort(
    (a, b) => CAPTURE_ORDER.indexOf(a) - CAPTURE_ORDER.indexOf(b),
  );
  // Captured pieces belong to the other side, so draw them in its colour.
  const theirs = color === 'white' ? 'b' : 'w';
  const toMove = game.status === 'active' && game.turn === color;

  return (
    <div className={`player${toMove ? ' player-to-move' : ''}`}>
      <span className={`player-mark player-mark-${color}`} aria-hidden="true" />
      <span className="player-name">{name}</span>
      {settings.mode === 'play' && <span className="player-side">{side}</span>}
      {isEngine && game.engineThinking && <span className="thinking">thinking</span>}
      <span className="captured" aria-label={`Pieces captured by ${color}: ${captured.length}`}>
        {captured.map((p, i) => (
          <PieceIcon key={i} code={`${theirs}${p.toUpperCase()}`} size={17} />
        ))}
      </span>
      {clocks.enabled && (
        <span className={`clock${running ? ' clock-running' : ''}${shown < 20000 ? ' clock-low' : ''}`}>
          {formatClock(shown)}
        </span>
      )}
    </div>
  );
}

/** Move history as running text: present, but not the centre of attention. */
export function MoveStrip({ game }: { game: GameState }) {
  if (game.history.length === 0) return <p className="moves moves-empty">No moves yet.</p>;
  return (
    <p className="moves" aria-label="Move history">
      {game.history.map((entry, index) => (
        <span key={entry.ply} className={index === game.history.length - 1 ? 'move move-last' : 'move'}>
          {index % 2 === 0 && <span className="move-number">{Math.floor(index / 2) + 1}.</span>}
          {entry.san}{' '}
        </span>
      ))}
    </p>
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
    <p className="banner" role="status">
      <strong>{STATUS_TEXT[game.status] ?? game.status}</strong>
      {winner && <span> · {winner}</span>}
    </p>
  );
}

const LAYER_ICON: Record<LayerId, IconName> = {
  best: 'arrow',
  pins: 'link',
  threats: 'target',
  defenses: 'shield',
  weak: 'grid',
  plans: 'plan',
  structure: 'files',
};

interface SwitchRowProps {
  icon: IconName;
  color?: string;
  label: string;
  hint?: string;
  count?: number;
  checked: boolean;
  onChange: () => void;
  tile?: boolean;
}

/** One labelled on/off switch. A real checkbox underneath, so it is keyboard- and screen-reader-operable. */
function SwitchRow({ icon, color, label, hint, count, checked, onChange, tile }: SwitchRowProps) {
  return (
    <label className={`switch-row${count === 0 ? ' switch-row-empty' : ''}`} title={hint}>
      <span className={tile ? 'switch-icon switch-icon-tile' : 'switch-icon'} style={color ? { color } : undefined}>
        <Icon name={icon} size={tile ? 19 : 17} />
      </span>
      <span className="switch-label">{label}</span>
      {count !== undefined && count > 0 && <span className="switch-count">{count}</span>}
      <input type="checkbox" className="switch-input" checked={checked} onChange={onChange} />
      <span className="switch" aria-hidden="true" />
    </label>
  );
}

interface LayerRailProps {
  enabled: ReadonlySet<LayerId>;
  counts: Record<LayerId, number>;
  onToggle: (id: LayerId) => void;
}

/** Which engine-supplied evidence is drawn on the board. Selects; never invents. */
export function LayerRail({ enabled, counts, onToggle }: LayerRailProps) {
  return (
    <section className="rail-section" aria-label="Analysis layers">
      <h2 className="rail-title">Analysis layers</h2>
      {LAYERS.map((layer) => (
        <SwitchRow
          key={layer.id}
          tile
          icon={LAYER_ICON[layer.id]}
          color={styleSpec(layer.swatch).color}
          label={layer.label}
          count={counts[layer.id]}
          checked={enabled.has(layer.id)}
          onChange={() => onToggle(layer.id)}
        />
      ))}
    </section>
  );
}

export interface DisplayOptions {
  coordinates: boolean;
  moveHints: boolean;
  attackArrows: boolean;
  subtleArrows: boolean;
}

export const DEFAULT_DISPLAY: DisplayOptions = {
  coordinates: true,
  moveHints: true,
  attackArrows: true,
  subtleArrows: true,
};

const DISPLAY_ROWS: { key: keyof DisplayOptions; label: string; icon: IconName; color?: string; hint: string }[] = [
  { key: 'coordinates', label: 'Coordinates', icon: 'coords', hint: 'File letters and rank numbers around the board' },
  { key: 'moveHints', label: 'Move hints', icon: 'bulb', hint: 'Dots on the squares the selected piece may move to' },
  {
    key: 'attackArrows',
    label: 'Attack arrows',
    icon: 'attack',
    color: '#ff6b5f',
    hint: 'When you click a square: arrows from the pieces attacking and defending it',
  },
  {
    key: 'subtleArrows',
    label: 'Subtle arrows',
    icon: 'subtle',
    color: '#4aa8ff',
    hint: 'Secondary arrows a fact carries: supporting pawns, defenders, plan routes',
  },
];

interface DisplayRailProps {
  options: DisplayOptions;
  onToggle: (key: keyof DisplayOptions) => void;
}

/** How things are drawn. None of these change what the engine reports. */
export function DisplayRail({ options, onToggle }: DisplayRailProps) {
  return (
    <section className="rail-section" aria-label="Display">
      <h2 className="rail-title">Display</h2>
      {DISPLAY_ROWS.map((row) => (
        <SwitchRow
          key={row.key}
          icon={row.icon}
          color={row.color}
          label={row.label}
          hint={row.hint}
          checked={options[row.key]}
          onChange={() => onToggle(row.key)}
        />
      ))}
    </section>
  );
}

const TIME_CONTROLS: { label: string; baseMs: number | null; incrementMs: number }[] = [
  { label: 'No clock', baseMs: null, incrementMs: 0 },
  { label: '1 min', baseMs: 60_000, incrementMs: 0 },
  { label: '3 | 2', baseMs: 180_000, incrementMs: 2000 },
  { label: '5 min', baseMs: 300_000, incrementMs: 0 },
  { label: '10 | 5', baseMs: 600_000, incrementMs: 5000 },
];

/**
 * Presets the server allows, plus the engine's actual value, so the control
 * neither offers something the server will clamp nor misreports the setting.
 */
function withCurrent(presets: number[], current: number, max: number): number[] {
  const allowed = presets.filter((p) => p <= max);
  return allowed.includes(current) ? allowed : [...allowed, current].sort((a, b) => a - b);
}

interface ControlsProps {
  game: GameState;
  disabled: boolean;
  onFlip: () => void;
  send: (command: ClientCommand) => void;
  maxDepth: number;
  maxMoveTimeMs: number;
}

type OpponentProps = Pick<ControlsProps, 'game' | 'disabled' | 'send' | 'maxDepth' | 'maxMoveTimeMs'>;

/** Who you are playing: the engine's level, in plain sight. It takes effect from the engine's next move. */
export function OpponentRail({ game, disabled, send, maxDepth, maxMoveTimeMs }: OpponentProps) {
  const { settings } = game;
  const current = settings.level ?? 'club';
  return (
    <section className="rail-section" aria-label="Opponent">
      <h2 className="rail-title">Opponent</h2>
      <div className="mode-switch mode-switch-4" role="group" aria-label="Opponent level">
        {LEVELS.map((l) => (
          <button
            key={l.id}
            type="button"
            className={`btn-toggle${current === l.id ? ' btn-toggle-on' : ''}`}
            aria-pressed={current === l.id}
            title={l.blurb}
            disabled={disabled}
            onClick={() => send({ type: 'set_level', level: l.id })}
          >
            {l.label}
          </button>
        ))}
      </div>
      <p className="field-hint">{LEVELS.find((l) => l.id === current)?.blurb}</p>
      {/* What the level comes to on this server, in the engine's own numbers. */}
      <p className="field-hint">
        Here it searches to depth {settings.depth} or for {(settings.moveTimeMs / 1000).toFixed(1)} s a move, whichever
        comes first.
        {maxDepth < 30 && ` This server stops every level at depth ${maxDepth} and ${(maxMoveTimeMs / 1000).toFixed(0)} s, so Expert plays much like Club here.`}
      </p>
    </section>
  );
}

export function Controls({ game, disabled, onFlip, send, maxDepth, maxMoveTimeMs }: ControlsProps) {
  const { settings, clocks } = game;
  const [side, setSide] = useState<Color>(settings.humanColor);
  const [timeIndex, setTimeIndex] = useState(() =>
    Math.max(
      0,
      TIME_CONTROLS.findIndex((t) =>
        clocks.enabled ? t.baseMs !== null && t.incrementMs === clocks.incrementMs : t.baseMs === null,
      ),
    ),
  );

  const newGame = () => {
    const tc = TIME_CONTROLS[timeIndex]!;
    send({ type: 'set_time_control', baseMs: tc.baseMs, incrementMs: tc.incrementMs });
    send({ type: 'new_game', humanColor: side, mode: settings.mode });
  };

  return (
    <details className="rail-section game-controls">
      <summary className="rail-title">Game</summary>
      <div className="controls">
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
      <label className="field">
        <span>Depth</span>
        <select
          value={settings.depth}
          onChange={(e) => send({ type: 'set_engine_depth', depth: Number(e.target.value) })}
          disabled={disabled}
        >
          {withCurrent([2, 3, 4, 5, 6, 7, 8, 10, 12], settings.depth, maxDepth).map((d) => (
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
          {withCurrent([500, 1000, 3000, 5000, 10000], settings.moveTimeMs, maxMoveTimeMs).map((ms) => (
            <option key={ms} value={ms}>
              {ms / 1000} s
            </option>
          ))}
        </select>
      </label>
      <div className="control-actions">
        <button
          type="button"
          className="btn"
          onClick={() => send({ type: 'undo_move' })}
          disabled={disabled || game.history.length === 0}
        >
          Take back
        </button>
        <button type="button" className="btn" onClick={onFlip}>
          Flip
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
      </div>
    </details>
  );
}
