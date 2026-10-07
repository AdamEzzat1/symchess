import type { ReactNode } from 'react';
import type { ClientCommand, Color, GameState, Rule } from '../protocol';
import {
  disagreements,
  traceFact,
  traceItem,
  tracePlan,
  type FactTrace,
  type ItemTrace,
  type Origin,
  type PlanTrace,
  type Said,
} from '../provenance';
import { selectFocus, type Highlight } from '../selectViz';
import type { AppState } from '../state';
import { MiniBoard } from './MiniBoard';

/** One sentence of an explanation or comparison, named by where it sits. */
export interface ItemRef {
  origin: Origin;
  searchId: number;
  index: number;
}

interface Props {
  state: AppState;
  game: GameState;
  orientation: Color;
  selected: Highlight;
  onSelect: (h: Highlight) => void;
  item: ItemRef | null;
  onItem: (ref: ItemRef | null) => void;
  send: (command: ClientCommand) => void;
  /** A search is running, so another cannot be asked for yet. */
  busy: boolean;
}

const words = (kind: string) => kind.replaceAll('_', ' ');
const LAYER: Record<Rule['layer'], string> = { prolog: 'Prolog', search: 'Lisp search', eval: 'Lisp evaluator' };
const ORIGIN: Record<Origin, string> = { explanation: 'the engine’s own move', counterfactual: 'a move you asked about' };

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <li className="chain-step">
      <span className="chain-n" aria-hidden="true">
        {n}
      </span>
      <div className="chain-main">
        <h4>{title}</h4>
        {children}
      </div>
    </li>
  );
}

/** A rule as the engine's index describes it. Prolog's rules are quoted from their source. */
function RuleCard({ rule, id, indexReady }: { rule: Rule | null; id: string; indexReady: boolean }) {
  if (!rule) {
    return (
      <p className="quiet">
        {indexReady ? `The rule index has no entry for ${id}.` : 'The rule index has not arrived from the engine yet.'}
      </p>
    );
  }
  return (
    <div className="rule">
      <p className="rule-head">
        <span className={`badge badge-${rule.layer === 'prolog' ? 'prolog' : 'search'}`}>{LAYER[rule.layer]}</span>
        <code>{rule.where}</code>
      </p>
      <p>{rule.summary}</p>
      {rule.source && (
        <details>
          <summary>The rule as written</summary>
          <pre className="rule-source">{rule.source}</pre>
        </details>
      )}
    </div>
  );
}

function Sentence({ said, state, onItem }: { said: Said; state: AppState; onItem?: (ref: ItemRef) => void }) {
  const { item } = said;
  return (
    <li className={`explain-item status-${item.status}`}>
      <span className="explain-tags">
        <span className={`badge badge-${item.source}`}>{item.source}</span>
        <span className={`badge badge-${item.status}`}>{item.status}</span>
        <span className="quiet">
          search #{said.searchId}, about {said.move} ({ORIGIN[said.origin]})
        </span>
      </span>
      {item.text}
      {item.basis && <span className="basis">{item.basis}</span>}
      {said.check && (
        <span className="basis">
          The check, in general: {said.check.summary} <code>{said.check.where}</code>
        </span>
      )}
      {onItem && (
        <button
          type="button"
          className="btn btn-small btn-trace"
          onClick={() => onItem({ origin: said.origin, searchId: said.searchId, index: said.index })}
        >
          Trace this sentence
        </button>
      )}
      {!state.rules && <span className="basis">The rule index has not arrived from the engine yet.</span>}
    </li>
  );
}

function PositionStep({ game }: { game: GameState }) {
  return (
    <Step n={1} title="The position">
      <p>
        Position #{game.positionId}, {game.turn} to move. Lisp sent Prolog the pieces on the board; Prolog never
        generates moves.
      </p>
      <p className="mono">{game.fen}</p>
    </Step>
  );
}

function FactChain({ trace, props }: { trace: FactTrace; props: Props }) {
  const { state, game, orientation, onSelect, onItem, send, busy } = props;
  const { fact } = trace;
  const focus = selectFocus(state, { kind: 'fact', id: fact.id }, true);
  const indexReady = state.rules !== null;
  const searched = state.explanation?.positionId === game.positionId || state.counterfactual?.positionId === game.positionId;
  return (
    <ol className="chain" aria-label={`Where ${fact.id.toUpperCase()} comes from`}>
      <PositionStep game={game} />
      <Step n={2} title={`The rule that fired: ${words(fact.kind)}`}>
        <RuleCard rule={trace.rule} id={`fact:${fact.kind}`} indexReady={indexReady} />
      </Step>
      <Step n={3} title={`The fact: ${fact.id.toUpperCase()}`}>
        <div className="chain-fact">
          {focus && focus.viz.length > 0 && (
            <MiniBoard board={game.board} orientation={orientation} squares={focus.squares} viz={focus.viz} size={120} />
          )}
          <div>
            <p>{fact.text}</p>
            <p className="quiet">
              Squares that satisfied the rule: {fact.squares.length > 0 ? fact.squares.join(', ') : 'none named'}.
              {fact.key && (
                <>
                  {' '}
                  Key <code>{fact.key}</code>.
                </>
              )}
            </p>
          </div>
        </div>
      </Step>
      <Step n={4} title="Plans built on it">
        {trace.plans.length === 0 && <p className="quiet">No plan cites this fact.</p>}
        {trace.plans.map(({ plan, rule }) => (
          <div key={plan.id} className="chain-sub">
            <p>
              <button type="button" className="chain-link" onClick={() => onSelect({ kind: 'plan', id: plan.id })}>
                {plan.id.toUpperCase()}
              </button>{' '}
              {plan.text} <span className="badge badge-heuristic">heuristic</span>
            </p>
            <RuleCard rule={rule} id={`plan:${plan.kind}`} indexReady={indexReady} />
          </div>
        ))}
      </Step>
      <Step n={5} title="Candidate moves that use it">
        {trace.moves.length === 0 && (
          <p className="quiet">Prolog says no candidate move’s motif rests on this fact.</p>
        )}
        {trace.moves.map(({ hint, motif, rule }) => (
          <div key={`${hint.uci}-${motif.kind}`} className="chain-sub">
            <p>
              <strong>{hint.san ?? hint.uci}</strong>: {motif.text}{' '}
              <span className="quiet">
                ({words(motif.kind)}, hint {motif.score > 0 ? '+' : ''}
                {motif.score})
              </span>
            </p>
            <RuleCard rule={rule} id={`motif:${motif.kind}`} indexReady={indexReady} />
            <button
              type="button"
              className="btn btn-small"
              disabled={busy || game.status !== 'active'}
              onClick={() => send({ type: 'explain_move', uci: hint.uci, positionId: game.positionId })}
            >
              Ask the search about {hint.san ?? hint.uci}
            </button>
          </div>
        ))}
      </Step>
      <Step n={6} title="What the search said">
        {trace.said.length === 0 && (
          <p className="quiet">
            {searched
              ? 'No sentence from a search of this position cites this fact. It stands as Prolog’s reading of the board, not assessed by the search.'
              : 'This position has not been searched yet. Run the search, or ask about one of the moves above.'}
          </p>
        )}
        <ul className="explain">
          {trace.said.map((said) => (
            <Sentence key={`${said.origin}-${said.index}`} said={said} state={state} onItem={onItem} />
          ))}
        </ul>
      </Step>
    </ol>
  );
}

function PlanChain({ trace, props }: { trace: PlanTrace; props: Props }) {
  const { state, game, onSelect, onItem } = props;
  const { plan } = trace;
  const indexReady = state.rules !== null;
  return (
    <ol className="chain" aria-label={`Where ${plan.id.toUpperCase()} comes from`}>
      <PositionStep game={game} />
      <Step n={2} title="The facts it rests on">
        {trace.facts.length === 0 && <p className="quiet">This plan cites no fact.</p>}
        {trace.facts.map(({ fact, rule }) => (
          <div key={fact.id} className="chain-sub">
            <p>
              <button type="button" className="chain-link" onClick={() => onSelect({ kind: 'fact', id: fact.id })}>
                {fact.id.toUpperCase()}
              </button>{' '}
              {fact.text}
            </p>
            <RuleCard rule={rule} id={`fact:${fact.kind}`} indexReady={indexReady} />
          </div>
        ))}
      </Step>
      <Step n={3} title={`The rule that turned them into a plan: ${words(plan.kind)}`}>
        <RuleCard rule={trace.rule} id={`plan:${plan.kind}`} indexReady={indexReady} />
      </Step>
      <Step n={4} title={`The plan: ${plan.id.toUpperCase()}`}>
        <p>
          {plan.text} <span className="badge badge-heuristic">heuristic</span>
        </p>
      </Step>
      <Step n={5} title="What the search said">
        {trace.said.length === 0 && (
          <p className="quiet">
            Nothing. A plan is advice drawn from facts; the search does not test plans. Ask “why not” about a move to
            see whether it keeps this plan’s facts.
          </p>
        )}
        <ul className="explain">
          {trace.said.map((said) => (
            <Sentence key={`${said.origin}-${said.index}`} said={said} state={state} onItem={onItem} />
          ))}
        </ul>
      </Step>
    </ol>
  );
}

function ItemChain({ trace, props }: { trace: ItemTrace; props: Props }) {
  const { state, game, onSelect } = props;
  const { said } = trace;
  const { item } = said;
  const indexReady = state.rules !== null;
  return (
    <ol className="chain" aria-label="Where this sentence comes from">
      <Step n={1} title="The sentence">
        <p>
          <span className={`badge badge-${item.source}`}>{item.source}</span>{' '}
          <span className={`badge badge-${item.status}`}>{item.status}</span> {item.text}
        </p>
        <p className="quiet">
          From search #{said.searchId} of position #{game.positionId}, about {said.move} ({ORIGIN[said.origin]}).
        </p>
      </Step>
      <Step n={2} title="What produced the claim">
        {item.rule ? (
          <RuleCard rule={trace.rule} id={item.rule} indexReady={indexReady} />
        ) : (
          <p className="quiet">The engine named no rule for this sentence.</p>
        )}
      </Step>
      <Step n={3} title="The facts it rests on">
        {trace.facts.length === 0 && (
          <p className="quiet">It cites no fact of this position.</p>
        )}
        {trace.facts.map((fact) => (
          <p key={fact.id}>
            <button type="button" className="chain-link" onClick={() => onSelect({ kind: 'fact', id: fact.id })}>
              {fact.id.toUpperCase()}
            </button>{' '}
            {fact.text}
          </p>
        ))}
      </Step>
      <Step n={4} title={`Why it is marked “${item.status}”`}>
        {item.basis ? <p>{item.basis}</p> : <p className="quiet">A measurement: there is no status to decide.</p>}
        {item.check && <RuleCard rule={said.check} id={item.check} indexReady={indexReady} />}
      </Step>
    </ol>
  );
}

/** Where Prolog and the search stand on the searches of this position. */
function Disagreements({ props }: { props: Props }) {
  const { state, game, onItem } = props;
  const messages = [state.explanation, state.counterfactual].filter(
    (m): m is NonNullable<typeof m> => m !== null && m.positionId === game.positionId && m.agreement !== undefined,
  );
  if (messages.length === 0) return null;
  const differing = disagreements(state);
  const top = state.explanation?.positionId === game.positionId ? state.explanation.agreement : undefined;
  return (
    <section className="block" aria-label="Where Prolog and the search differ">
      <h3>Where Prolog and the search differ</h3>
      {top && top.prologTop && top.searchMove && (
        <p>
          Prolog’s top-ranked move: <strong>{top.prologTop}</strong>. The search chose: <strong>{top.searchMove}</strong>.{' '}
          <span className={`badge badge-${top.sameMove ? 'confirmed' : 'overruled'}`}>
            {top.sameMove ? 'same move' : 'different moves'}
          </span>
        </p>
      )}
      <table className="tally">
        <thead>
          <tr>
            <th scope="col">Search</th>
            <th scope="col">Confirmed</th>
            <th scope="col">Unconfirmed</th>
            <th scope="col">Overruled</th>
            <th scope="col">Not checkable</th>
          </tr>
        </thead>
        <tbody>
          {messages.map((m) => (
            <tr key={m.searchId}>
              <th scope="row">
                #{m.searchId}, {m.move.san}
              </th>
              <td>{m.agreement!.confirmed}</td>
              <td>{m.agreement!.unconfirmed}</td>
              <td>{m.agreement!.overruled}</td>
              <td>{m.agreement!.unchecked}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {differing.length === 0 ? (
        <p className="quiet">The search overruled nothing Prolog said here, and left nothing unconfirmed.</p>
      ) : (
        <ul className="explain">
          {differing.map((said) => (
            <Sentence key={`${said.origin}-${said.index}`} said={said} state={state} onItem={onItem} />
          ))}
        </ul>
      )}
      <p className="quiet">Counts are of Prolog’s sentences about the move each search was about. The engine sets every status.</p>
    </section>
  );
}

const GROUPS: { id: Rule['group']; label: string }[] = [
  { id: 'fact', label: 'Facts about a position (Prolog)' },
  { id: 'motif', label: 'What a move does (Prolog)' },
  { id: 'plan', label: 'Plans drawn from facts (Prolog)' },
  { id: 'measurement', label: 'Measurements (Lisp)' },
  { id: 'check', label: 'Checks that set a status (Lisp)' },
];

function RuleIndex({ state }: { state: AppState }) {
  const index = state.rules;
  if (!index) return null;
  return (
    <details className="block rule-index">
      <summary>
        All {index.rules.length} rules{index.status === 'unavailable' && ' (Prolog’s part is missing: it could not be reached)'}
      </summary>
      {GROUPS.map((group) => {
        const rules = index.rules.filter((rule) => rule.group === group.id);
        if (rules.length === 0) return null;
        return (
          <section key={group.id}>
            <h4>
              {group.label} · {rules.length}
            </h4>
            {rules.map((rule) => (
              <details key={rule.id} className="rule-entry">
                <summary>
                  <code>{rule.id}</code>
                </summary>
                <RuleCard rule={rule} id={rule.id} indexReady />
              </details>
            ))}
          </section>
        );
      })}
    </details>
  );
}

/**
 * The reasoning debugger: pick a fact, a plan or a sentence and follow it back
 * to the rule and the evidence. Every link shown is one the engine sent.
 */
export function Provenance(props: Props) {
  const { state, game, selected, onSelect, item, onItem } = props;
  const analysis = state.symbolic?.positionId === game.positionId ? state.symbolic : null;

  const itemTrace = item ? traceItem(state, item.origin, item.searchId, item.index) : null;
  const trace =
    itemTrace ??
    (selected?.kind === 'fact' ? traceFact(state, selected.id) : selected?.kind === 'plan' ? tracePlan(state, selected.id) : null);

  return (
    <>
      {trace ? (
        <section className="block">
          <h3>
            {trace.kind === 'fact' && `Tracing fact ${trace.fact.id.toUpperCase()}`}
            {trace.kind === 'plan' && `Tracing plan ${trace.plan.id.toUpperCase()}`}
            {trace.kind === 'item' && 'Tracing a sentence'}
            <button
              type="button"
              className="btn btn-small chain-clear"
              onClick={() => {
                onItem(null);
                onSelect(null);
              }}
            >
              Clear
            </button>
          </h3>
          {trace.kind === 'fact' && <FactChain trace={trace} props={props} />}
          {trace.kind === 'plan' && <PlanChain trace={trace} props={props} />}
          {trace.kind === 'item' && <ItemChain trace={trace} props={props} />}
        </section>
      ) : (
        <section className="block">
          <h3>Follow a claim back</h3>
          <p className="quiet">
            Pick a fact or a plan to see the rule that produced it, what was built on it, and what the search said.
          </p>
          {analysis === null && <p className="quiet">Waiting for the knowledge layer…</p>}
          {analysis && analysis.facts.length + analysis.plans.length === 0 && (
            <p className="quiet">Prolog reports no facts in this position.</p>
          )}
          <ul className="chain-picker">
            {analysis?.facts.map((fact) => (
              <li key={fact.id}>
                <button type="button" className="btn btn-small" onClick={() => onSelect({ kind: 'fact', id: fact.id })}>
                  {fact.id.toUpperCase()} · {words(fact.kind)} · {fact.label ?? fact.squares.join(' ')}
                </button>
              </li>
            ))}
            {analysis?.plans.map((plan) => (
              <li key={plan.id}>
                <button type="button" className="btn btn-small" onClick={() => onSelect({ kind: 'plan', id: plan.id })}>
                  {plan.id.toUpperCase()} · plan · {words(plan.kind)}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Disagreements props={props} />
      <RuleIndex state={state} />
    </>
  );
}
