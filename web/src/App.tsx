import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { Board } from './components/Board';
import { Controls, DEFAULT_DISPLAY, DisplayRail, LayerRail, PlayerBar, type DisplayOptions } from './components/GamePanel';
import { PieceArtContext, SvgDefs } from './components/Pieces';
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
 *   &move=e2e4            play one move (the engine still decides if it is legal)
 * It only sends ordinary commands the UI could send by hand.
 */
const LINK = new URLSearchParams(window.location.search);

// Three.js is only fetched if someone chooses the 3D board.
const Board3D = lazy(() => import('./components/Board3D'));

/** How the pieces are drawn. Presentation only: the engine never hears of it. */
type PieceStyle = 'classic' | 'figures' | '3d';
const PIECE_STYLES: { id: PieceStyle; label: string; hint: string }[] = [
  { id: 'classic', label: 'Classic', hint: 'Glass chess pieces on a flat board' },
  { id: 'figures', label: 'Figures', hint: 'Glass statues of soldiers, clerics and royals on a flat board' },
  { id: '3d', label: '3D', hint: 'A 3D board whose statues fight when one takes another' },
];
const STYLE_KEY = 'symchess.pieces';

function initialPieceStyle(): PieceStyle {
  const known = (value: string | null): value is PieceStyle => PIECE_STYLES.some((s) => s.id === value);
  const linked = LINK.get('pieces');
  if (known(linked)) return linked;
  try {
    const saved = window.localStorage.getItem(STYLE_KEY);
    if (known(saved)) return saved;
  } catch {
    // Storage can be blocked; the default is fine.
  }
  return 'classic';
}

export function App() {
  const { state, send, dismissError, reconnect, url } = useEngine();
  const { game, connection } = state;

  // Purely presentational state: none of it is known to, or needed by, the engine.
  const [flipped, setFlipped] = useState(false);
  const [layers, setLayers] = useState<Set<LayerId>>(
    () => new Set(LINK.get('layers') === 'all' ? LAYERS.map((l) => l.id) : DEFAULT_LAYERS),
  );
  const [display, setDisplay] = useState<DisplayOptions>(DEFAULT_DISPLAY);
  const [pieceStyle, setPieceStyle] = useState<PieceStyle>(initialPieceStyle);
  const choosePieceStyle = (style: PieceStyle) => {
    setPieceStyle(style);
    try {
      window.localStorage.setItem(STYLE_KEY, style);
    } catch {
      // Not remembered, but it still applies now.
    }
  };
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
      const move = LINK.get('move');
      if (move) send({ type: 'make_move', uci: move, positionId });
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
    <PieceArtContext.Provider value={pieceStyle === 'figures' ? 'figures' : 'classic'}>
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
          <section className="rail-section" aria-label="Piece style">
            <h2 className="rail-title">Pieces</h2>
            <div className="mode-switch mode-switch-3" role="group" aria-label="Piece style">
              {PIECE_STYLES.map((style) => (
                <button
                  key={style.id}
                  type="button"
                  className={`btn-toggle${pieceStyle === style.id ? ' btn-toggle-on' : ''}`}
                  aria-pressed={pieceStyle === style.id}
                  title={style.hint}
                  onClick={() => choosePieceStyle(style.id)}
                >
                  {style.label}
                </button>
              ))}
            </div>
          </section>
        )}
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
            {pieceStyle === '3d' ? (
              <Suspense fallback={<div className="board-frame board-3d-loading">Loading the 3D board…</div>}>
                <Board3D
                  game={game}
                  orientation={orientation}
                  interactive={online && game.status === 'active' && !game.engineThinking}
                  thinking={thinking}
                  showHints={display.moveHints}
                  onMove={(uci) => send({ type: 'make_move', uci, positionId: game.positionId })}
                  onSquareClick={
                    analysisMode
                      ? (square) => send({ type: 'inspect_square', square, positionId: game.positionId })
                      : undefined
                  }
                />
              </Suspense>
            ) : (
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
            )}
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
    </PieceArtContext.Provider>
  );
}
