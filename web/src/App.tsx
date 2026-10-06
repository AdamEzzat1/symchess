import { useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './components/Board';
import { Controls, DEFAULT_DISPLAY, DisplayRail, LayerRail, PlayerBar, type DisplayOptions } from './components/GamePanel';
import { SvgDefs } from './components/Pieces';
import { ReasoningPanel } from './components/ReasoningPanel';
import { SearchTrace } from './components/SearchTrace';
import type { Color, Mode } from './protocol';
import { DEFAULT_LAYERS, LAYERS, layerCounts, selectFocus, selectViz, type Highlight, type LayerId } from './selectViz';
import { useEngine } from './useEngine';

/**
 * Deep link to a position, for sharing and demos:
 *   ?fen=<FEN>            load this position in analysis mode
 *   &layers=all           switch every layer on
 *   &analyse=1            start a search straight away
 *   &select=f1            open the glass inspector on a fact or plan id
 * It only sends ordinary commands the UI could send by hand.
 */
const LINK = new URLSearchParams(window.location.search);

export function App() {
  const { state, send, dismissError, reconnect, url } = useEngine();
  const { game, connection } = state;

  // Purely presentational state: none of it is known to, or needed by, the engine.
  const [flipped, setFlipped] = useState(false);
  const [layers, setLayers] = useState<Set<LayerId>>(
    () => new Set(LINK.get('layers') === 'all' ? LAYERS.map((l) => l.id) : DEFAULT_LAYERS),
  );
  const [display, setDisplay] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [hovered, setHovered] = useState<Highlight>(null);
  const [selected, setSelected] = useState<Highlight>(null);

  const mode: Mode = game?.settings.mode ?? 'play';
  const analysisMode = mode === 'analysis';
  const positionId = game?.positionId ?? null;

  // Fact and plan ids are only meaningful for the position they came with.
  useEffect(() => {
    setHovered(null);
    setSelected(null);
  }, [positionId]);

  // Apply a deep link once per connection: load the position, then (when its
  // analysis has arrived) optionally start a search and select an item.
  const linkStep = useRef<'load' | 'loaded' | 'done'>('load');
  const linkFen = LINK.get('fen');
  const symbolicReady = state.symbolic !== null && state.symbolic.positionId === positionId;
  useEffect(() => {
    if (connection !== 'open') {
      linkStep.current = 'load';
      return;
    }
    if (!linkFen || positionId === null) return;
    if (linkStep.current === 'load') {
      linkStep.current = 'loaded';
      send({ type: 'new_game', fen: linkFen, mode: 'analysis' });
    } else if (linkStep.current === 'loaded' && symbolicReady && game?.fen === linkFen) {
      linkStep.current = 'done';
      if (LINK.get('analyse') === '1') send({ type: 'request_analysis', positionId });
      const pick = LINK.get('select');
      if (pick) setSelected({ kind: pick.startsWith('p') ? 'plan' : 'fact', id: pick });
    }
  }, [connection, linkFen, positionId, symbolicReady, game?.fen, send]);

  // The glass inspector shows what is hovered, otherwise what is selected.
  const active = hovered ?? selected;
  const viz = useMemo(
    () =>
      selectViz(state, {
        analysisMode,
        layers,
        attackArrows: display.attackArrows,
        subtleArrows: display.subtleArrows,
      }),
    [state, analysisMode, layers, display.attackArrows, display.subtleArrows],
  );
  const focus = useMemo(() => selectFocus(state, active, analysisMode), [state, active, analysisMode]);
  const counts = useMemo(() => layerCounts(state), [state]);

  const toggleLayer = (id: LayerId) =>
    setLayers((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const online = connection === 'open';
  const base: Color = game?.settings.humanColor ?? 'white';
  const orientation: Color = flipped ? (base === 'white' ? 'black' : 'white') : base;
  const top: Color = orientation === 'white' ? 'black' : 'white';
  const thinking = (game?.engineThinking ?? false) || state.search?.running === true;

  const connectionText =
    connection === 'open'
      ? 'Engine connected'
      : state.refusal?.code === 'server_full'
        ? 'Server full · waiting for a seat'
        : state.refusal?.code === 'idle_timeout'
          ? 'Disconnected'
          : connection === 'connecting'
            ? 'Connecting…'
            : 'Engine offline · retrying';

  return (
    <div className="app">
      <SvgDefs />

      <aside className="panel rail" aria-label="Layers, display and game controls">
        <header className="brand">
          <h1>SymChess</h1>
          <p className="brand-sub">Classical symbolic chess AI</p>
          <div className="brand-rule" aria-hidden="true">
            <span>φ</span>
          </div>
          <div className="mode-switch" role="group" aria-label="Mode">
            {(['play', 'analysis'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`btn-toggle${mode === m ? ' btn-toggle-on' : ''}`}
                aria-pressed={mode === m}
                disabled={!online || !game}
                onClick={() => send({ type: 'set_mode', mode: m })}
              >
                {m === 'play' ? 'Play' : 'Analysis'}
              </button>
            ))}
          </div>
          <p className={`conn conn-${connection}`} role="status">
            {connectionText}
          </p>
        </header>

        {game && analysisMode && <LayerRail enabled={layers} counts={counts} onToggle={toggleLayer} />}
        {game && (
          <DisplayRail
            options={display}
            onToggle={(key) => setDisplay((current) => ({ ...current, [key]: !current[key] }))}
          />
        )}
        {game && (
          <Controls
            game={game}
            disabled={!online}
            onFlip={() => setFlipped((f) => !f)}
            send={send}
            maxDepth={state.hello?.maxDepth ?? 30}
            maxMoveTimeMs={state.hello?.maxMoveTimeMs ?? 120_000}
          />
        )}
      </aside>

      {state.refusal ? (
        <main className="waiting" role="status">
          {state.refusal.code === 'server_full' ? (
            <>
              <h2>Every seat is taken right now</h2>
              <p>
                This is a small free server, so only a few people can play at once. You do not need to do
                anything: this page checks again every few seconds and lets you in as soon as someone leaves.
              </p>
            </>
          ) : (
            <>
              <h2>You were disconnected for inactivity</h2>
              <p>Your seat was given back so someone else could play. Your game was not saved.</p>
              <button type="button" className="btn btn-primary" onClick={reconnect}>
                Play again
              </button>
            </>
          )}
        </main>
      ) : !game ? (
        <main className="waiting">
          <h2>{online ? 'Waiting for the engine’s first position…' : 'The engine is not running'}</h2>
          {!online && (
            <p>
              Start it with <code>sbcl --script engine/run.lisp</code>. This page reconnects to{' '}
              <code>{url}</code> automatically.
            </p>
          )}
        </main>
      ) : (
        <>
          <main className="stage">
            {state.errors.length > 0 && (
              <div className="errors" role="alert">
                {state.errors.map((error) => (
                  <div key={error.key} className="error">
                    <span>
                      {error.message} <span className="quiet">({error.code})</span>
                    </span>
                    <button type="button" className="btn btn-quiet" onClick={() => dismissError(error.key)}>
                      Dismiss
                    </button>
                  </div>
                ))}
              </div>
            )}
            <PlayerBar game={game} color={top} receivedAt={state.gameReceivedAt} />
            <Board
              game={game}
              orientation={orientation}
              interactive={online && game.status === 'active' && !game.engineThinking}
              viz={viz}
              focus={focus}
              thinking={thinking}
              showCoords={display.coordinates}
              showHints={display.moveHints}
              onMove={(uci) => send({ type: 'make_move', uci, positionId: game.positionId })}
              onSquareClick={
                analysisMode
                  ? (square) => send({ type: 'inspect_square', square, positionId: game.positionId })
                  : undefined
              }
            />
            <PlayerBar game={game} color={orientation} receivedAt={state.gameReceivedAt} />
          </main>

          <ReasoningPanel
            state={state}
            game={game}
            orientation={orientation}
            analysisMode={analysisMode}
            active={active}
            selected={selected}
            onHover={setHovered}
            onSelect={setSelected}
            send={send}
            engineUrl={url}
          />

          <SearchTrace state={state} game={game} online={online} send={send} />
        </>
      )}
    </div>
  );
}
