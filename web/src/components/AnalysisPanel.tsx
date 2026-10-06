import type { ClientCommand, Fact, Score } from '../protocol';
import type { Highlight } from '../selectViz';
import type { AppState } from '../state';
import { styleColor } from './Overlays';


/** Fact kinds whose overlays are on by default. The rest are one click away. */
export const DEFAULT_KINDS = ['check', 'pin', 'fork', 'skewer', 'hanging', 'threatened', 'weak_square'];

const KIND_LABEL: Record<string, string> = {
  check: 'Checks',
  pin: 'Pins',
  fork: 'Forks',
  skewer: 'Skewers',
  hanging: 'Undefended pieces',
  threatened: 'Attacked by cheaper piece',
  overloaded: 'Overloaded defenders',
  weak_square: 'Weak squares',
  passed_pawn: 'Passed pawns',
  king_shield: 'King safety',
  open_file: 'Open files',
  semi_open_file: 'Semi-open files',
  isolated_pawn: 'Isolated pawns',
  doubled_pawns: 'Doubled pawns',
};

/** The overlay style that best represents a fact kind, for legend swatches. */
const KIND_STYLE: Record<string, string> = {
  check: 'check',
  pin: 'pin',
  fork: 'fork',
  skewer: 'skewer',
  hanging: 'hanging',
  threatened: 'threat',
  overloaded: 'overloaded',
  weak_square: 'weak',
  passed_pawn: 'passed',
  king_shield: 'king_danger',
  open_file: 'open',
  semi_open_file: 'semi_open',
  isolated_pawn: 'weak_pawn',
  doubled_pawns: 'weak_pawn',
};

const STATUS_HELP: Record<string, string> = {
  measured: 'A number the search or evaluator actually produced.',
  confirmed: 'A Prolog motif that the search line acts on.',
  unconfirmed: 'A Prolog motif the search line does not act on.',
  overruled: 'Prolog advice the search decided against.',
  heuristic: 'Positional advice the search cannot verify at this depth.',
};

export function formatScore(score: Score): string {
  if (score.mate !== null) return `${score.mate > 0 ? '+' : '-'}M${Math.abs(score.mate)}`;
  const pawns = (score.cp ?? 0) / 100;
  return `${pawns >= 0 ? '+' : '-'}${Math.abs(pawns).toFixed(2)}`;
}

function signed(cp: number): string {
  return `${cp >= 0 ? '+' : '-'}${(Math.abs(cp) / 100).toFixed(2)}`;
}

interface Props {
  state: AppState;
  enabledKinds: Set<string>;
  onToggleKind: (kind: string) => void;
  showBestMove: boolean;
  onToggleBestMove: () => void;
  onHighlight: (h: Highlight) => void;
  send: (command: ClientCommand) => void;
  debug: boolean;
  onToggleDebug: () => void;
  engineUrl: string;
}

export function AnalysisPanel({
  state,
  enabledKinds,
  onToggleKind,
  showBestMove,
  onToggleBestMove,
  onHighlight,
  send,
  debug,
  onToggleDebug,
  engineUrl,
}: Props) {
  const { game, search, symbolic, explanation, inspection } = state;
  if (!game) return null;

  const facts = symbolic?.facts ?? [];
  const grouped = new Map<string, Fact[]>();
  for (const fact of facts) {
    const list = grouped.get(fact.kind);
    if (list) list.push(fact);
    else grouped.set(fact.kind, [fact]);
  }
  const hints = (symbolic?.moveHints ?? []).filter((h) => h.score !== 0).slice(0, 8);
  const searchIsCurrent = search !== null && search.positionId === game.positionId;
  const info = search?.info ?? null;

  return (
    <aside className="analysis" aria-label="Engine analysis">
      {/* ------------------------------------------------ numeric search */}
      <section className="card">
        <header className="card-head">
          <h2>Search</h2>
          <span className="tag tag-lisp">Lisp</span>
          <button
            type="button"
            className="btn btn-small"
            disabled={game.status !== 'active' || game.engineThinking || search?.running === true}
            onClick={() => send({ type: 'request_analysis', positionId: game.positionId })}
          >
            {search?.running ? 'Searching…' : 'Analyse position'}
          </button>
        </header>
        {info ? (
          <>
            {!searchIsCurrent && (
              <p className="note">These numbers are for the position before the last move.</p>
            )}
            <div className="score-line">
              <span className="score">{formatScore(info.score)}</span>
              <span className="muted">White's view · depth {info.depth}</span>
            </div>
            <dl className="stats">
              <div>
                <dt>Positions</dt>
                <dd>{info.nodes.toLocaleString()}</dd>
              </div>
              <div>
                <dt>Speed</dt>
                <dd>{info.nps.toLocaleString()}/s</dd>
              </div>
              <div>
                <dt>Time</dt>
                <dd>{(info.timeMs / 1000).toFixed(2)} s</dd>
              </div>
            </dl>
            <p className="pv">
              <span className="muted">Best line </span>
              {info.pv.join(' ') || '—'}
            </p>
            <label className="check">
              <input type="checkbox" checked={showBestMove} onChange={onToggleBestMove} />
              Show best move on board
            </label>
            {search?.evalBreakdown && (
              <table className="breakdown">
                <caption>Static evaluation of the root position (pawns, White's view)</caption>
                <tbody>
                  <tr>
                    <th scope="row">Material</th>
                    <td>{signed(search.evalBreakdown.material)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Piece placement</th>
                    <td>{signed(search.evalBreakdown.placement)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Pawn structure</th>
                    <td>{signed(search.evalBreakdown.pawnStructure)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Bishop pair</th>
                    <td>{signed(search.evalBreakdown.bishopPair)}</td>
                  </tr>
                  <tr className="breakdown-total">
                    <th scope="row">Total</th>
                    <td>{signed(search.evalBreakdown.total)}</td>
                  </tr>
                </tbody>
              </table>
            )}
          </>
        ) : (
          <p className="muted">No search yet for this game. Press “Analyse position”.</p>
        )}
      </section>

      {/* ---------------------------------------------------- explanation */}
      {explanation && (
        <section className="card">
          <header className="card-head">
            <h2>Why {explanation.move.san}?</h2>
          </header>
          <p className="summary">{explanation.summary}</p>
          <ul className="explain">
            {explanation.items.map((item, i) => (
              <li key={i} className={`explain-item status-${item.status}`}>
                <span className={`tag tag-${item.source}`}>{item.source}</span>
                <span className="tag tag-status" title={STATUS_HELP[item.status]}>
                  {item.status}
                </span>
                <span>{item.text}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ----------------------------------------------- symbolic reasoning */}
      <section className="card">
        <header className="card-head">
          <h2>Symbolic reasoning</h2>
          <span className="tag tag-prolog">Prolog</span>
        </header>
        {symbolic === null && <p className="muted">Waiting for the knowledge layer…</p>}
        {symbolic?.status === 'unavailable' && (
          <p className="note">
            The Prolog knowledge layer is unavailable. The engine is playing on search alone and nothing
            symbolic is drawn.
          </p>
        )}
        {symbolic?.status === 'ok' && facts.length === 0 && (
          <p className="muted">No tactical or structural facts in this position.</p>
        )}
        {[...grouped.entries()].map(([kind, list]) => (
          <div key={kind} className="fact-group">
            <label className="check fact-kind">
              <input type="checkbox" checked={enabledKinds.has(kind)} onChange={() => onToggleKind(kind)} />
              <span className="swatch" style={{ background: styleColor(KIND_STYLE[kind] ?? '') }} />
              {KIND_LABEL[kind] ?? kind} <span className="muted">({list.length})</span>
              {list[0]?.use === 'mirrors_eval' && (
                <span className="tag tag-quiet" title="Explanation only. The Lisp evaluator scores this concept separately.">
                  also in eval
                </span>
              )}
            </label>
            <ul className="facts">
              {list.map((fact) => (
                <li
                  key={fact.id}
                  className="fact"
                  tabIndex={0}
                  onMouseEnter={() => onHighlight({ kind: 'fact', id: fact.id })}
                  onMouseLeave={() => onHighlight(null)}
                  onFocus={() => onHighlight({ kind: 'fact', id: fact.id })}
                  onBlur={() => onHighlight(null)}
                >
                  <span className="fact-id">{fact.id}</span>
                  {fact.text}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {symbolic?.status === 'ok' && symbolic.plans.length > 0 && (
        <section className="card">
          <header className="card-head">
            <h2>Candidate plans for {game.turn === 'white' ? 'White' : 'Black'}</h2>
            <span className="tag tag-prolog">Prolog</span>
          </header>
          <p className="note">Heuristic advice derived from the facts above. Not checked by the search.</p>
          <ul className="facts">
            {symbolic.plans.map((plan) => (
              <li
                key={plan.id}
                className="fact"
                tabIndex={0}
                onMouseEnter={() => onHighlight({ kind: 'plan', id: plan.id })}
                onMouseLeave={() => onHighlight(null)}
                onFocus={() => onHighlight({ kind: 'plan', id: plan.id })}
                onBlur={() => onHighlight(null)}
              >
                {plan.text} <span className="muted">because {plan.because.join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {hints.length > 0 && (
        <section className="card">
          <header className="card-head">
            <h2>Move-ordering hints</h2>
            <span className="tag tag-prolog">Prolog</span>
          </header>
          <p className="note">
            Used only to decide which root moves the search tries first. They never change a score.
          </p>
          <ul className="hints">
            {hints.map((hint) => (
              <li key={hint.uci}>
                <span className="hint-move-name">{hint.san ?? hint.uci}</span>
                <span className={hint.score > 0 ? 'hint-up' : 'hint-down'}>
                  {hint.score > 0 ? '+' : ''}
                  {hint.score}
                </span>
                <span className="muted">{hint.motifs.map((m) => m.kind.replaceAll('_', ' ')).join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ------------------------------------------------------ inspection */}
      <section className="card">
        <header className="card-head">
          <h2>Inspect</h2>
          <span className="tag tag-prolog">Prolog</span>
        </header>
        {inspection ? (
          <ul className="facts">
            {inspection.lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        ) : (
          <p className="muted">Click any square or piece to see what attacks and defends it.</p>
        )}
      </section>

      {/* ----------------------------------------------------------- debug */}
      <section className="card">
        <header className="card-head">
          <h2>Debug</h2>
          <label className="check">
            <input type="checkbox" checked={debug} onChange={onToggleDebug} /> show
          </label>
        </header>
        {debug && (
          <>
            <p className="note">For development. Not part of normal play.</p>
            <dl className="stats stats-wide">
              <div>
                <dt>Engine</dt>
                <dd>{state.hello?.engine ?? '—'}</dd>
              </div>
              <div>
                <dt>Lisp</dt>
                <dd>{state.hello?.lisp ?? '—'}</dd>
              </div>
              <div>
                <dt>Prolog</dt>
                <dd>{state.hello?.prolog ?? 'unavailable'}</dd>
              </div>
              <div>
                <dt>Socket</dt>
                <dd>{engineUrl}</dd>
              </div>
              <div>
                <dt>Position id</dt>
                <dd>{game.positionId}</dd>
              </div>
              <div>
                <dt>Prolog time</dt>
                <dd>{symbolic ? `${symbolic.elapsedMs} ms` : '—'}</dd>
              </div>
            </dl>
            <p className="fen">{game.fen}</p>
            <ol className="eventlog" aria-label="Recent engine events">
              {state.log
                .slice()
                .reverse()
                .map((entry) => (
                  <li key={entry.seq} className={entry.dropped ? 'event-dropped' : ''}>
                    #{entry.seq} {entry.type}
                    {entry.positionId !== null && ` @${entry.positionId}`}
                    {entry.dropped && ' (stale, dropped)'}
                  </li>
                ))}
            </ol>
          </>
        )}
      </section>
    </aside>
  );
}
