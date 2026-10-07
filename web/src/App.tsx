import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Benchmarks } from './components/Benchmarks';
import { GameReview } from './components/GameReview';
import { PgnImport } from './components/PgnImport';
import { Board } from './components/Board';
import { Controls, DEFAULT_DISPLAY, DisplayRail, LayerRail, PlayerBar, type DisplayOptions } from './components/GamePanel';
import { PieceArtContext, SvgDefs } from './components/Pieces';
import { ReasoningPanel } from './components/ReasoningPanel';
import { ReplayPanel } from './components/ReplayPanel';
import { SearchTrace } from './components/SearchTrace';
import { Tour } from './components/Tour';
import { DEMO, type DemoStep, type PanelTab } from './demo';
import type { Color, Level, MessageOf, Mode } from './protocol';
import { replayView, reviewView, stepLabels } from './replay';
import { SAMPLE_PGN } from './samples';
import { DEFAULT_LAYERS, LAYERS, layerCounts, selectFocus, selectViz, type Highlight, type LayerId } from './selectViz';
import { useEngine } from './useEngine';

/**
 * Deep link to a position, for sharing and demos:
 *   ?fen=<FEN>            load this position in analysis mode
 *   &layers=all           switch every layer on
 *   &analyse=1            start a search straight away
 *   &select=f1            open the glass inspector on a fact or plan id
 *   &move=e2e4            play one move (the engine still decides if it is legal)
 *   &replay=1             with analyse=1: then step through the expected line
 *   ?tour=1               start the guided tour
 *   ?review=sample        import the sample game and open its review (&ply=N to jump)
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

/** How much the pieces act out. Presentation only. */
type Motion = 'expressive' | 'minimal';
const MOTIONS: { id: Motion; label: string; hint: string }[] = [
  { id: 'expressive', label: 'Expressive', hint: 'Pieces strike, shatter, and react to checkmate and promotion' },
  { id: 'minimal', label: 'Minimal', hint: 'Short glides and fades only' },
];
const MOTION_KEY = 'symchess.motion';

function initialMotion(): Motion {
  const known = (value: string | null): value is Motion => MOTIONS.some((m) => m.id === value);
  const linked = LINK.get('motion');
  if (known(linked)) return linked;
  try {
    const saved = window.localStorage.getItem(MOTION_KEY);
    if (known(saved)) return saved;
  } catch {
    // Storage can be blocked; the default is fine.
  }
  return 'expressive';
}

/**
 * A prepared position: load it, then optionally search, open a card, play a
 * move, or step through the line. Used by deep links and by the guided tour.
 */
interface Script {
  /** Changing the key runs the script again from the top. */
  key: string;
  fen: string;
  mode: Mode;
  humanColor?: Color;
  tab?: PanelTab;
  analyse: boolean;
  replay: boolean;
  select?: (analysis: MessageOf<'symbolic_analysis'>) => Highlight;
  move?: string;
}

function linkScript(): Script | null {
  const fen = LINK.get('fen');
  if (!fen) return null;
  const pick = LINK.get('select');
  return {
    key: 'link',
    fen,
    mode: 'analysis',
    analyse: LINK.get('analyse') === '1',
    replay: LINK.get('replay') === '1',
    select: pick ? () => ({ kind: pick.startsWith('p') ? 'plan' : 'fact', id: pick }) : undefined,
    move: LINK.get('move') ?? undefined,
  };
}

function tourScript(step: DemoStep, run: number): Script {
  const want = step.select;
  return {
    key: `tour-${step.id}-${run}`,
    fen: step.fen,
    mode: step.mode,
    humanColor: step.humanColor,
    tab: step.tab,
    analyse: step.analyse === true,
    replay: step.replay === true,
    select: want
      ? (analysis) => {
          const found =
            want.kind === 'fact'
              ? analysis.facts.find((f) => f.kind === want.of)
              : analysis.plans.find((p) => p.kind === want.of);
          return found ? { kind: want.kind, id: found.id } : null;
        }
      : undefined,
  };
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
  const [motion, setMotion] = useState<Motion>(initialMotion);
  const chooseMotion = (value: Motion) => {
    setMotion(value);
    try {
      window.localStorage.setItem(MOTION_KEY, value);
    } catch {
      // Not remembered, but it still applies now.
    }
  };
  const [hovered, setHovered] = useState<Highlight>(null);
  const [selected, setSelected] = useState<Highlight>(null);
  const [tab, setTab] = useState<PanelTab>('reasoning');
  const [showResults, setShowResults] = useState(LINK.get('results') === '1');

  const mode: Mode = game?.settings.mode ?? 'play';
  const analysisMode = mode === 'analysis';
  const positionId = game?.positionId ?? null;

  // "Why this move?": which search's line is being stepped through, and where.
  // The line itself lives in the engine-derived state and vanishes with its
  // explanation, which ends the replay.
  const [replayFor, setReplayFor] = useState<number | null>(null);
  const [replayAt, setReplayAt] = useState(0);
  const explainedSearch = state.explanation?.searchId ?? null;
  const startReplay = useCallback(
    (searchId: number) => {
      setReplayFor(searchId);
      setReplayAt(0);
      send({ type: 'request_line', searchId });
    },
    [send],
  );
  const endReplay = useCallback(() => setReplayFor(null), []);
  useEffect(() => {
    if (replayFor !== null && explainedSearch !== replayFor) setReplayFor(null);
  }, [replayFor, explainedSearch]);
  const replay = useMemo(
    () => (replayFor !== null && state.line?.searchId === replayFor ? replayView(state, replayAt) : null),
    [state, replayFor, replayAt],
  );
  const replayPending = replayFor !== null && replay === null;

  // An imported game being browsed. The board shows one of its positions,
  // under the same "cannot be played on" rules as a replayed line.
  const [showImport, setShowImport] = useState(false);
  const [reviewAt, setReviewAt] = useState<number | null>(null);
  const reviewId = state.review?.gameId ?? null;
  useEffect(() => {
    // A newly imported game opens at its start; a closed one ends the browsing.
    setReviewAt(reviewId === null ? null : Number(LINK.get('ply')) || 0);
    setReplayFor(null);
  }, [reviewId]);
  const reviewing = state.review !== null && reviewAt !== null;
  // The engine sends positions one at a time. Until the one asked for has
  // arrived, show the latest one before it, so the board and the panel always
  // describe the same position.
  const reviewShown = useMemo(() => {
    if (!state.review || reviewAt === null) return null;
    const { steps } = state.review;
    for (let i = Math.min(reviewAt, steps.length - 1); i >= 0; i--) if (steps[i]) return i;
    return null;
  }, [state.review, reviewAt]);
  const reviewed = useMemo(
    () => (reviewShown !== null ? reviewView(state, reviewShown) : null),
    [state, reviewShown],
  );
  const leaveReview = useCallback(() => setReviewAt(null), []);
  const sampleLoaded = useRef(false);
  useEffect(() => {
    if (connection !== 'open') sampleLoaded.current = false;
    else if (LINK.get('review') === 'sample' && positionId !== null && !sampleLoaded.current) {
      sampleLoaded.current = true;
      send({ type: 'load_pgn', pgn: SAMPLE_PGN });
    }
  }, [connection, positionId, send]);

  const browsing = reviewed ?? replay;
  const shownGame = browsing?.game ?? game;
  const shownState = browsing?.state ?? state;
  const shownId = shownGame?.positionId ?? null;

  // Fact and plan ids are only meaningful for the position they came with.
  useEffect(() => {
    setHovered(null);
    setSelected(null);
  }, [shownId]);

  // The guided tour and deep links both run a script: load a position, then
  // (when its analysis has arrived) optionally search, open a card, and replay.
  const [script, setScript] = useState<Script | null>(linkScript);
  const [tourAt, setTourAt] = useState<number | null>(LINK.get('tour') === '1' ? 0 : null);
  const tourRuns = useRef(0);
  const runTourStep = (index: number) => {
    const step = DEMO[index];
    if (!step) return;
    tourRuns.current += 1;
    setReplayFor(null);
    setTourAt(index);
    setScript(tourScript(step, tourRuns.current));
  };
  useEffect(() => {
    if (tourAt !== null && script === null) runTourStep(tourAt);
    // Only for a tour started by the link, once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const endTour = () => {
    setTourAt(null);
    setScript(null);
    setReplayFor(null);
    send({ type: 'set_level', level: 'club' });
    send({ type: 'new_game', mode: 'play', humanColor: 'white' });
  };
  const tourLevel = (level: Level) => {
    send({ type: 'set_level', level });
    if (tourAt !== null) runTourStep(tourAt);
  };

  const stage = useRef<{ key: string; step: 'loading' | 'searching' | 'done'; from: number } | null>(null);
  const symbolicReady = state.symbolic !== null && state.symbolic.positionId === positionId;
  const explainedHere = state.explanation !== null && state.explanation.positionId === positionId;
  useEffect(() => {
    if (connection !== 'open') {
      stage.current = null;
      return;
    }
    if (!script || positionId === null) return;
    const at = stage.current;
    if (!at || at.key !== script.key) {
      stage.current = { key: script.key, step: 'loading', from: positionId };
      if (script.tab) setTab(script.tab);
      send({ type: 'new_game', fen: script.fen, mode: script.mode, humanColor: script.humanColor });
      return;
    }
    // Wait for the position this script asked for, not the one it replaced.
    if (positionId === at.from || game?.fen !== script.fen) return;
    if (at.step === 'loading') {
      // In play mode the engine carries on by itself.
      if (script.mode === 'play') at.step = 'done';
      else if (symbolicReady && state.symbolic) {
        at.step = script.analyse && script.replay ? 'searching' : 'done';
        const pick = script.select?.(state.symbolic) ?? null;
        if (pick) setSelected(pick);
        if (script.analyse) send({ type: 'request_analysis', positionId });
        if (script.move) send({ type: 'make_move', uci: script.move, positionId });
      }
    } else if (at.step === 'searching' && explainedHere && state.explanation) {
      at.step = 'done';
      startReplay(state.explanation.searchId);
    }
  }, [connection, script, positionId, symbolicReady, explainedHere, game?.fen, state.symbolic, state.explanation, send, startReplay]);

  // The glass inspector shows what is hovered, otherwise what is selected.
  const active = hovered ?? selected;
  // While a line is replayed the overlays describe the replayed position.
  const overlayMode = analysisMode || browsing !== null;
  const viz = useMemo(
    () =>
      selectViz(shownState, {
        analysisMode: overlayMode,
        layers,
        attackArrows: display.attackArrows,
        subtleArrows: display.subtleArrows,
      }),
    [shownState, overlayMode, layers, display.attackArrows, display.subtleArrows],
  );
  const focus = useMemo(() => selectFocus(shownState, active, overlayMode), [shownState, active, overlayMode]);
  const counts = useMemo(() => layerCounts(shownState), [shownState]);
  // The search's own best move, for the 3D board, under the same switch as the flat board's arrow.
  const best = state.search?.info?.bestMove;
  const bestArrow =
    analysisMode && !browsing && !reviewing && layers.has('best') && best && state.search?.positionId === positionId
      ? { from: best.from, to: best.to }
      : null;

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
          {game && tourAt === null && (
            <button type="button" className="btn btn-tour" disabled={!online} onClick={() => runTourStep(0)}>
              Take the one-minute tour
            </button>
          )}
        </header>

        {game && (analysisMode || browsing) && <LayerRail enabled={layers} counts={counts} onToggle={toggleLayer} />}
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
            <div className="mode-switch" role="group" aria-label="Motion">
              {MOTIONS.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className={`btn-toggle${motion === m.id ? ' btn-toggle-on' : ''}`}
                  aria-pressed={motion === m.id}
                  title={m.hint}
                  onClick={() => chooseMotion(m.id)}
                >
                  {m.label}
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
        {game && (
          <section className="rail-section" aria-label="Game review">
            <h2 className="rail-title">Game review</h2>
            <button type="button" className="btn btn-small" disabled={!online} onClick={() => setShowImport(true)}>
              Analyse a game (PGN)
            </button>
            {state.review && !reviewing && (
              <button type="button" className="btn btn-small" onClick={() => setReviewAt(state.review!.moves.length)}>
                Reopen the review
              </button>
            )}
          </section>
        )}
        <button type="button" className="btn btn-quiet rail-link" onClick={() => setShowResults(true)}>
          Measured results
        </button>
      </aside>
      {showResults && <Benchmarks onClose={() => setShowResults(false)} />}
      {showImport && <PgnImport onLoad={(pgn) => send({ type: 'load_pgn', pgn })} onClose={() => setShowImport(false)} />}

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
      ) : !game || !shownGame ? (
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
            {tourAt !== null && (
              <Tour
                steps={DEMO}
                index={tourAt}
                level={game.settings.level}
                busy={!online || thinking}
                onGo={runTourStep}
                onLevel={tourLevel}
                onEnd={endTour}
              />
            )}
            <PlayerBar game={game} color={top} receivedAt={state.gameReceivedAt} />
            {reviewing ? (
              <p className="replay-chip" role="status">
                Reviewing the imported game · step with ← →
              </p>
            ) : (
              replay && (
                <p className="replay-chip" role="status">
                  Replaying the expected line · not the game position
                </p>
              )
            )}
            {pieceStyle === '3d' ? (
              <Suspense fallback={<div className="board-frame board-3d-loading">Loading the 3D board…</div>}>
                <Board3D
                  game={shownGame}
                  orientation={orientation}
                  interactive={!browsing && !reviewing && online && game.status === 'active' && !game.engineThinking}
                  thinking={thinking}
                  showHints={display.moveHints}
                  minimal={motion === 'minimal'}
                  bestMove={bestArrow}
                  onMove={(uci) => send({ type: 'make_move', uci, positionId: game.positionId })}
                  onSquareClick={
                    analysisMode && !browsing && !reviewing
                      ? (square) => send({ type: 'inspect_square', square, positionId: game.positionId })
                      : undefined
                  }
                />
              </Suspense>
            ) : (
            <Board
              game={shownGame}
              orientation={orientation}
              interactive={!browsing && !reviewing && online && game.status === 'active' && !game.engineThinking}
              viz={viz}
              focus={focus}
              thinking={thinking}
              showCoords={display.coordinates}
              showHints={display.moveHints}
              minimal={motion === 'minimal'}
              onMove={(uci) => send({ type: 'make_move', uci, positionId: game.positionId })}
              onSquareClick={
                analysisMode && !browsing && !reviewing
                  ? (square) => send({ type: 'inspect_square', square, positionId: game.positionId })
                  : undefined
              }
            />
            )}
            <PlayerBar game={game} color={orientation} receivedAt={state.gameReceivedAt} />
          </main>

          {reviewing && state.review && reviewAt !== null ? (
            <GameReview
              review={state.review}
              index={reviewShown ?? 0}
              view={reviewed}
              active={active}
              onHover={setHovered}
              onStep={setReviewAt}
              onClose={leaveReview}
            />
          ) : replay && state.line && state.explanation ? (
            <ReplayPanel
              view={replay}
              labels={stepLabels(state.line.steps, Number(state.line.steps[0]?.fen.split(' ')[5]) || 1)}
              moveSan={state.explanation.move.san}
              active={active}
              onHover={setHovered}
              onStep={setReplayAt}
              onClose={endReplay}
            />
          ) : (
            <ReasoningPanel
              state={state}
              game={game}
              orientation={orientation}
              analysisMode={analysisMode}
              active={active}
              selected={selected}
              onHover={setHovered}
              onSelect={setSelected}
              tab={tab}
              onTab={setTab}
              onReplay={startReplay}
              replayPending={replayPending}
              send={send}
              engineUrl={url}
            />
          )}

          <SearchTrace state={state} game={game} online={online} send={send} />
        </>
      )}
    </div>
    </PieceArtContext.Provider>
  );
}
