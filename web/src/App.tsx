import { useMemo, useState } from 'react';
import { AnalysisPanel, DEFAULT_KINDS } from './components/AnalysisPanel';
import { Board } from './components/Board';
import { Controls, MoveList, PlayerBar, StatusBanner } from './components/GamePanel';
import type { Color, Mode } from './protocol';
import { selectViz, type Highlight } from './selectViz';
import { useEngine } from './useEngine';

export function App() {
  const { state, send, dismissError, url } = useEngine();
  const { game, connection } = state;

  // Purely presentational state: none of it is known to, or needed by, the engine.
  const [flipped, setFlipped] = useState(false);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(DEFAULT_KINDS));
  const [showBestMove, setShowBestMove] = useState(true);
  const [highlight, setHighlight] = useState<Highlight>(null);
  const [debug, setDebug] = useState(false);

  const mode: Mode = game?.settings.mode ?? 'play';
  const analysisMode = mode === 'analysis';

  const viz = useMemo(
    () => selectViz(state, { analysisMode, enabledKinds, showBestMove, highlight }),
    [state, analysisMode, enabledKinds, showBestMove, highlight],
  );

  const toggleKind = (kind: string) =>
    setEnabledKinds((current) => {
      const next = new Set(current);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });

  const online = connection === 'open';
  const base: Color = game?.settings.humanColor ?? 'white';
  const orientation: Color = flipped ? (base === 'white' ? 'black' : 'white') : base;
  const top: Color = orientation === 'white' ? 'black' : 'white';

  return (
    <div className={`app${analysisMode ? ' app-analysis' : ''}`}>
      <header className="topbar">
        <h1>SymChess</h1>
        <div className="mode-switch" role="group" aria-label="Mode">
          {(['play', 'analysis'] as const).map((m) => (
            <button
              key={m}
              type="button"
              className={`btn btn-toggle${mode === m ? ' btn-toggle-on' : ''}`}
              aria-pressed={mode === m}
              disabled={!online || !game}
              onClick={() => send({ type: 'set_mode', mode: m })}
            >
              {m === 'play' ? 'Play' : 'Analysis'}
            </button>
          ))}
        </div>
        <span className={`conn conn-${connection}`} role="status">
          {connection === 'open' ? 'Engine connected' : connection === 'connecting' ? 'Connecting…' : 'Engine offline · retrying'}
        </span>
      </header>

      {state.errors.length > 0 && (
        <div className="errors" role="alert">
          {state.errors.map((error) => (
            <div key={error.key} className="error">
              <span>
                {error.message} <span className="muted">({error.code})</span>
              </span>
              <button type="button" className="btn btn-quiet" onClick={() => dismissError(error.key)}>
                Dismiss
              </button>
            </div>
          ))}
        </div>
      )}

      {!game ? (
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
        <main className="layout">
          <section className="board-column">
            <PlayerBar game={game} color={top} receivedAt={state.gameReceivedAt} />
            <Board
              game={game}
              orientation={orientation}
              interactive={online && game.status === 'active' && !game.engineThinking}
              viz={viz}
              onMove={(uci) => send({ type: 'make_move', uci, positionId: game.positionId })}
              onSquareClick={
                analysisMode
                  ? (square) => send({ type: 'inspect_square', square, positionId: game.positionId })
                  : undefined
              }
            />
            <PlayerBar game={game} color={orientation} receivedAt={state.gameReceivedAt} />
          </section>

          <section className="side-column">
            <StatusBanner game={game} />
            <MoveList game={game} />
            {!analysisMode && state.explanation && (
              <p className="last-reason">
                <strong>{state.explanation.summary}</strong> Switch to Analysis to see why.
              </p>
            )}
            <Controls game={game} disabled={!online} onFlip={() => setFlipped((f) => !f)} send={send} />
          </section>

          {analysisMode && (
            <AnalysisPanel
              state={state}
              enabledKinds={enabledKinds}
              onToggleKind={toggleKind}
              showBestMove={showBestMove}
              onToggleBestMove={() => setShowBestMove((v) => !v)}
              onHighlight={setHighlight}
              send={send}
              debug={debug}
              onToggleDebug={() => setDebug((v) => !v)}
              engineUrl={url}
            />
          )}
        </main>
      )}
    </div>
  );
}
