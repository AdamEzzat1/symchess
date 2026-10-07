import { useState } from 'react';
import type { ClientCommand, Color, Fact, GameState, Plan } from '../protocol';
import { selectFocus, verdictFor, type Highlight } from '../selectViz';
import type { AppState } from '../state';
import { MoveStrip, StatusBanner } from './GamePanel';
import { Icon, type IconName } from './icons';
import { MiniBoard } from './MiniBoard';
import { TONE } from './Overlays';
import { formatScore } from './SearchTrace';

type Tab = 'reasoning' | 'plan' | 'variations' | 'facts';
const TABS: { id: Tab; label: string }[] = [
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'plan', label: 'Plan' },
  { id: 'variations', label: 'Variations' },
  { id: 'facts', label: 'Facts' },
];

/** How each kind of fact is presented. Purely cosmetic: icon, colour, heading. */
interface Look {
  title: string;
  icon: IconName;
  color: string;
}

const KIND: Record<string, Look> = {
  check: { title: 'Check', icon: 'target', color: TONE.threat },
  pin: { title: 'Pin', icon: 'link', color: TONE.pin },
  skewer: { title: 'Skewer', icon: 'link', color: TONE.pin },
  fork: { title: 'Fork', icon: 'target', color: TONE.threat },
  hanging: { title: 'Hanging piece', icon: 'target', color: TONE.threat },
  threatened: { title: 'Attacked piece', icon: 'target', color: TONE.threat },
  overloaded: { title: 'Overloaded defender', icon: 'shield', color: TONE.defend },
  weak_square: { title: 'Weak square', icon: 'grid', color: TONE.weak },
  isolated_pawn: { title: 'Isolated pawn', icon: 'grid', color: TONE.weak },
  doubled_pawns: { title: 'Doubled pawns', icon: 'grid', color: TONE.weak },
  king_shield: { title: 'King cover', icon: 'shield', color: TONE.weak },
  passed_pawn: { title: 'Passed pawn', icon: 'files', color: TONE.defend },
  open_file: { title: 'Open file', icon: 'files', color: TONE.pv },
  semi_open_file: { title: 'Semi-open file', icon: 'files', color: TONE.pv },
  battery: { title: 'Battery', icon: 'target', color: TONE.threat },
  discovered_attack: { title: 'Discovered attack', icon: 'target', color: TONE.threat },
  trapped: { title: 'Trapped piece', icon: 'target', color: TONE.threat },
  pinned_defender: { title: 'Pinned defender', icon: 'link', color: TONE.pin },
  weak_back_rank: { title: 'Weak back rank', icon: 'shield', color: TONE.weak },
  backward_pawn: { title: 'Backward pawn', icon: 'grid', color: TONE.weak },
  outpost_piece: { title: 'Outpost', icon: 'shield', color: TONE.defend },
  rook_on_seventh: { title: 'Rook on the seventh', icon: 'files', color: TONE.defend },
  pawn_majority: { title: 'Pawn majority', icon: 'files', color: TONE.defend },
  pawn_break: { title: 'Pawn break', icon: 'files', color: TONE.pv },
  unstoppable_pawn: { title: 'Unstoppable pawn', icon: 'files', color: TONE.defend },
};
const UNKNOWN_KIND: Look = { title: 'Fact', icon: 'grid', color: TONE.neutral };
const PLAN_LOOK: Look = { title: 'Candidate plan', icon: 'nodes', color: TONE.pv };

const USE_LABEL: Record<string, string> = {
  explanation: 'Explanation, plans',
  mirrors_eval: 'Explanation (the evaluator scores this separately)',
};

const STATUS_HELP: Record<string, string> = {
  measured: 'A number the search or evaluator actually produced.',
  confirmed: 'A Prolog motif that the search line acts on.',
  unconfirmed: 'A Prolog motif the search line does not act on.',
  overruled: 'Prolog advice the search decided against.',
  heuristic: 'Advice the search cannot verify at this depth.',
  static: 'A fact about the position as it stands. The search has not assessed it.',
};

const words = (kind: string) => kind.replaceAll('_', ' ');
const signed = (cp: number) => `${cp >= 0 ? '+' : '-'}${(Math.abs(cp) / 100).toFixed(2)}`;
const same = (a: Highlight, b: Highlight) => a !== null && b !== null && a.kind === b.kind && a.id === b.id;

function Badge({ kind, children }: { kind: string; children: string }) {
  return (
    <span className={`badge badge-${kind}`} title={STATUS_HELP[kind]}>
      {children}
    </span>
  );
}

interface Props {
  state: AppState;
  game: GameState;
  orientation: Color;
  analysisMode: boolean;
  /** What the glass inspector is showing: the hovered item, else the selected one. */
  active: Highlight;
  selected: Highlight;
  onHover: (h: Highlight) => void;
  onSelect: (h: Highlight) => void;
  send: (command: ClientCommand) => void;
  engineUrl: string;
}

export function ReasoningPanel({
  state,
  game,
  orientation,
  analysisMode,
  active,
  selected,
  onHover,
  onSelect,
  send,
  engineUrl,
}: Props) {
  const { symbolic, explanation, inspection, search } = state;
  const [tab, setTab] = useState<Tab>('reasoning');
  const [fen, setFen] = useState('');

  const current = analysisMode && symbolic?.positionId === game.positionId;
  const facts: Fact[] = current ? symbolic.facts : [];
  const plans: Plan[] = current ? symbolic.plans : [];
  const hints = (symbolic?.moveHints ?? []).filter((h) => h.score !== 0).slice(0, 8);

  const statusOf = (fact: Fact) => verdictFor(fact, explanation, game.positionId) ?? 'static';

  const card = (item: Highlight & object, look: Look, subject: string, text: string, status: string) => {
    const focus = selectFocus(state, item, true);
    return (
      <li key={`${item.kind}-${item.id}`}>
        <button
          type="button"
          className={`card${same(active, item) ? ' card-active' : ''}${same(selected, item) ? ' card-selected' : ''}`}
          aria-pressed={same(selected, item)}
          onMouseEnter={() => onHover(item)}
          onMouseLeave={() => onHover(null)}
          onFocus={() => onHover(item)}
          onBlur={() => onHover(null)}
          onClick={() => onSelect(same(selected, item) ? null : item)}
        >
          <span className="card-icon" style={{ color: look.color }}>
            <Icon name={look.icon} size={22} />
          </span>
          <span className="card-main">
            <span className="card-head">
              <span className="card-id">{item.id.toUpperCase()}</span>
              <span className="card-title">{look.title}</span>
              <Badge kind="prolog">Prolog</Badge>
              <Badge kind={status}>{status}</Badge>
            </span>
            <span className="card-subject">{subject}</span>
            <span className="card-text">{text}</span>
          </span>
          {focus && focus.viz.length > 0 && (
            <MiniBoard board={game.board} orientation={orientation} squares={focus.squares} viz={focus.viz} size={86} />
          )}
          <span className="card-chevron">
            <Icon name="chevron" size={16} />
          </span>
        </button>
      </li>
    );
  };

  const factCards = facts.map((f) =>
    card({ kind: 'fact', id: f.id }, KIND[f.kind] ?? UNKNOWN_KIND, f.label ?? f.squares.join(' '), f.text, statusOf(f)),
  );
  const planCards = plans.map((p) => card({ kind: 'plan', id: p.id }, PLAN_LOOK, words(p.kind), p.text, 'heuristic'));

  const activeFact = active?.kind === 'fact' ? facts.find((f) => f.id === active.id) : undefined;
  const activePlan = active?.kind === 'plan' ? plans.find((p) => p.id === active.id) : undefined;
  const activeItem = activeFact ?? activePlan;
  const activeFocus = activeItem ? selectFocus(state, active, true) : null;
  const activeLook = activeFact ? (KIND[activeFact.kind] ?? UNKNOWN_KIND) : PLAN_LOOK;
  const activeStatus = activeFact ? statusOf(activeFact) : 'heuristic';

  const detail = activeItem && (
    <section className="detail" role="status">
      <header className="card-head">
        <span className="card-icon" style={{ color: activeLook.color }}>
          <Icon name={activeLook.icon} size={20} />
        </span>
        <span className="card-id">{activeItem.id.toUpperCase()}</span>
        <span className="card-title">{activeLook.title}</span>
        <Badge kind="prolog">Prolog</Badge>
        <Badge kind={activeStatus}>{activeStatus}</Badge>
      </header>
      <div className="detail-body">
        {activeFocus && activeFocus.viz.length > 0 ? (
          <MiniBoard
            board={game.board}
            orientation={orientation}
            squares={activeFocus.squares}
            viz={activeFocus.viz}
            size={148}
          />
        ) : (
          <p className="quiet detail-empty">Nothing to draw for this item.</p>
        )}
        <dl className="kv">
          <div>
            <dt>Source</dt>
            <dd>Prolog</dd>
          </div>
          <div>
            <dt>Used in</dt>
            <dd>
              {activeFact
                ? (USE_LABEL[activeFact.use] ?? activeFact.use)
                : `Advice only · rests on ${activePlan!.because.map((b) => b.toUpperCase()).join(', ')}`}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{STATUS_HELP[activeStatus]}</dd>
          </div>
        </dl>
      </div>
      <p className="detail-text">{activeItem.text}</p>
    </section>
  );

  const empty = (text: string) => <p className="quiet pad">{text}</p>;
  const symbolicNote =
    symbolic === null
      ? empty('Waiting for the knowledge layer…')
      : symbolic.status === 'unavailable'
        ? empty('Knowledge layer unavailable. The engine is running on search alone.')
        : null;

  return (
    <aside className="reasoning" aria-label="Reasoning">
      <header className="reasoning-head">
        <h2 className="reasoning-title">{analysisMode ? 'Reasoning' : 'Game'}</h2>
      </header>
      <StatusBanner game={game} />

      {analysisMode ? (
        <>
          <div className="tabs" role="tablist" aria-label="Reasoning views">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                className={`tab${tab === t.id ? ' tab-on' : ''}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>

          <div className="reasoning-body">
            {tab === 'reasoning' && (
              <>
                {symbolicNote}
                {symbolic?.status === 'ok' && facts.length + plans.length === 0 &&
                  empty('No tactical or structural facts in this position.')}
                <ul className="cards">
                  {factCards}
                  {planCards}
                </ul>
                {detail}
              </>
            )}

            {tab === 'plan' && (
              <>
                {symbolicNote}
                {symbolic?.status === 'ok' && plans.length === 0 && empty('No candidate plans for this position.')}
                {plans.length > 0 && empty('Heuristic advice derived from the facts. Not checked by the search.')}
                <ul className="cards">{planCards}</ul>
                {detail}
              </>
            )}

            {tab === 'facts' && (
              <>
                {symbolicNote}
                {symbolic?.status === 'ok' && facts.length === 0 && empty('No facts in this position.')}
                <ul className="cards">{factCards}</ul>
                {inspection && (
                  <section className="block">
                    <h3>
                      Square {inspection.square} <Badge kind="prolog">Prolog</Badge>
                    </h3>
                    <ul className="plain">
                      {inspection.lines.map((line, i) => (
                        <li key={i}>{line}</li>
                      ))}
                    </ul>
                  </section>
                )}
                {detail}
              </>
            )}

            {tab === 'variations' && (
              <>
                {search?.info ? (
                  <section className="block">
                    <h3>
                      Best line <Badge kind="search">Lisp</Badge>
                      {search.positionId !== game.positionId && <span className="quiet"> · previous position</span>}
                    </h3>
                    <p className="eval-line">
                      <span className="eval-score">{formatScore(search.info.score)}</span>
                      <span className="quiet">White’s view · depth {search.info.depth}</span>
                    </p>
                    <p className="pv">{search.info.pv.join(' ') || '—'}</p>
                    {search.evalBreakdown && (
                      <dl className="kv kv-terms">
                        <div>
                          <dt>Material</dt>
                          <dd>{signed(search.evalBreakdown.material)}</dd>
                        </div>
                        <div>
                          <dt>Placement</dt>
                          <dd>{signed(search.evalBreakdown.placement)}</dd>
                        </div>
                        <div>
                          <dt>Pawns</dt>
                          <dd>{signed(search.evalBreakdown.pawnStructure)}</dd>
                        </div>
                        <div>
                          <dt>Bishop pair</dt>
                          <dd>{signed(search.evalBreakdown.bishopPair)}</dd>
                        </div>
                        {search.evalBreakdown.activity !== undefined && (
                          <div>
                            <dt>Activity</dt>
                            <dd>{signed(search.evalBreakdown.activity)}</dd>
                          </div>
                        )}
                        {search.evalBreakdown.kingSafety !== undefined && (
                          <div>
                            <dt>King safety</dt>
                            <dd>{signed(search.evalBreakdown.kingSafety)}</dd>
                          </div>
                        )}
                        <div>
                          <dt>Static total</dt>
                          <dd>{signed(search.evalBreakdown.total)}</dd>
                        </div>
                      </dl>
                    )}
                  </section>
                ) : (
                  empty('No search yet. Press play in the search trace.')
                )}

                {explanation && (
                  <section className="block">
                    <h3>
                      Why {explanation.move.san}
                      {explanation.positionId !== game.positionId && <span className="quiet"> · last move</span>}
                    </h3>
                    <ul className="explain">
                      {explanation.items.map((item, i) => (
                        <li key={i} className={`explain-item status-${item.status}`}>
                          <span className="explain-tags">
                            <Badge kind={item.source}>{item.source}</Badge>
                            <Badge kind={item.status}>{item.status}</Badge>
                          </span>
                          {item.text}
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {hints.length > 0 && (
                  <section className="block">
                    <h3>
                      Prolog’s move ranking <Badge kind="heuristic">not used by the search</Badge>
                    </h3>
                    <ul className="hints">
                      {hints.map((hint) => (
                        <li key={hint.uci}>
                          <span className="hint-name">{hint.san ?? hint.uci}</span>
                          <span className={hint.score > 0 ? 'hint-up' : 'hint-down'}>
                            {hint.score > 0 ? '+' : ''}
                            {hint.score}
                          </span>
                          <span className="quiet">{hint.motifs.map((m) => words(m.kind)).join(', ')}</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                <section className="block">
                  <h3>Game moves</h3>
                  <MoveStrip game={game} />
                </section>
              </>
            )}
          </div>
        </>
      ) : (
        <div className="reasoning-body">
          {explanation && (
            <section className="block">
              <h3>Last engine move</h3>
              <p className="summary">{explanation.summary}</p>
              <p className="quiet">Switch to Analysis for the reasoning.</p>
            </section>
          )}
          <section className="block">
            <h3>Moves</h3>
            <MoveStrip game={game} />
          </section>
        </div>
      )}

      <details className="block debug">
        <summary>Position &amp; debug</summary>
        <form
          className="fen-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (fen.trim()) send({ type: 'new_game', fen: fen.trim(), mode: 'analysis' });
          }}
        >
          <label className="field">
            <span>Load position (FEN)</span>
            <input value={fen} onChange={(e) => setFen(e.target.value)} spellCheck={false} placeholder={game.fen} />
          </label>
          <button type="submit" className="btn btn-small" disabled={!fen.trim()}>
            Load
          </button>
        </form>
        <dl className="kv">
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
            <dt>Position</dt>
            <dd>#{game.positionId}</dd>
          </div>
        </dl>
        <p className="mono">{game.fen}</p>
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
      </details>
    </aside>
  );
}
