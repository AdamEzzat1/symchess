import type { ClientCommand, GameState, Score } from '../protocol';
import type { AppState } from '../state';
import { Icon } from './icons';

export function formatScore(score: Score): string {
  if (score.mate !== null) return `${score.mate > 0 ? '+' : '-'}M${Math.abs(score.mate)}`;
  const pawns = (score.cp ?? 0) / 100;
  return `${pawns >= 0 ? '+' : '-'}${Math.abs(pawns).toFixed(2)}`;
}

function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

interface Props {
  state: AppState;
  game: GameState;
  online: boolean;
  send: (command: ClientCommand) => void;
}

/**
 * The search, one card per completed depth, with the engine's own telemetry.
 * Every number here is one the Lisp search (or the Prolog bridge) reported.
 */
export function SearchTrace({ state, game, online, send }: Props) {
  const { search, symbolic } = state;
  const info = search?.info ?? null;
  const running = search?.running === true;
  const isCurrent = search !== null && search.positionId === game.positionId;
  const analysisMode = game.settings.mode === 'analysis';
  const canStart = online && analysisMode && game.status === 'active' && !game.engineThinking;
  // The four most recent depths, so the newest (highlighted) one is always in view.
  const ticks = search ? search.trace.slice(-4) : [];

  return (
    <div className="bottom">
      <section className="panel trace" aria-label="Search trace">
        <h2 className="panel-title">
          Search Trace
          {search && !isCurrent && !running && <span className="trace-note">previous position</span>}
          {search?.stopped && <span className="trace-note">stopped early</span>}
        </h2>
        <div className="trace-row">
          {running ? (
            <button
              type="button"
              className="play play-running"
              disabled={!online}
              aria-label={search?.purpose === 'play' ? 'Move now' : 'Stop search'}
              title={search?.purpose === 'play' ? 'Move now' : 'Stop search'}
              onClick={() => send({ type: 'stop_search' })}
            >
              <Icon name="stop" size={22} />
            </button>
          ) : (
            <button
              type="button"
              className="play"
              disabled={!canStart}
              aria-label="Analyse this position"
              title={analysisMode ? 'Analyse this position' : 'Switch to Analysis to run a search without moving'}
              onClick={() => send({ type: 'request_analysis', positionId: game.positionId })}
            >
              <Icon name="play" size={22} />
            </button>
          )}
          <ol className="ticks">
            {ticks.length === 0 ? (
              <li className="trace-empty">{running ? 'Searching…' : 'No search yet.'}</li>
            ) : (
              ticks.map((tick, i) => (
                <li key={tick.depth} className={i === ticks.length - 1 ? 'tick tick-last' : 'tick'}>
                  <span className="tick-top">
                    <span className="tick-depth">d{tick.depth}</span>
                    <span className="tick-score">{formatScore(tick.score)}</span>
                  </span>
                  <span className="tick-meta">{compact(tick.nodes)} nodes</span>
                  <span className="tick-meta">{tick.timeMs} ms</span>
                </li>
              ))
            )}
          </ol>
        </div>
      </section>

      <section className="panel status" aria-label="Search status">
        <h2 className="panel-title">Search Status</h2>
        <dl className="stats">
          <div>
            <dt>
              <Icon name="layers" size={16} /> Depth
            </dt>
            <dd>
              {info ? info.depth : '—'}
              {search && <span className="stat-of"> / {search.maxDepth}</span>}
            </dd>
          </div>
          <div>
            <dt>
              <Icon name="nodes" size={16} /> Nodes
            </dt>
            <dd>{info ? compact(info.nodes) : '—'}</dd>
          </div>
          <div>
            <dt>
              <Icon name="clock" size={16} /> Speed
            </dt>
            <dd>
              {info ? compact(info.nps) : '—'}
              {info && <span className="stat-of"> /s</span>}
            </dd>
          </div>
          <div>
            <dt>
              <Icon name="braces" size={16} /> Prolog
            </dt>
            <dd>
              {symbolic === null ? '—' : symbolic.status === 'ok' ? symbolic.elapsedMs : 'off'}
              {symbolic?.status === 'ok' && <span className="stat-of"> ms</span>}
            </dd>
          </div>
        </dl>
      </section>
    </div>
  );
}
