import { useEffect } from 'react';
import type { ReplayView } from '../replay';
import type { Highlight } from '../selectViz';
import type { Review } from '../state';
import type { ReviewStep, Score } from '../protocol';
import { FactList } from './FactList';
import { formatScore } from './SearchTrace';

interface Props {
  review: Review;
  /** The ply on the board, and its view once the engine has sent that position. */
  index: number;
  view: ReplayView | null;
  active: Highlight;
  onHover: (h: Highlight) => void;
  onStep: (index: number) => void;
  onClose: () => void;
}

/** A score as a height: capped at five pawns either way, mate at the cap. */
const CAP = 500;
const height = (score: Score): number =>
  score.mate !== null ? (score.mate > 0 ? CAP : -CAP) : Math.max(-CAP, Math.min(CAP, score.cp ?? 0));

/** Moves the engine's rough comparison marks out. Presentation of its verdict, nothing more. */
const FLAG_TITLE: Record<string, string> = {
  missed_chance: 'The search rates this a missed chance',
  mistake: 'The search rates this a mistake',
  blunder: 'The search rates this a blunder',
};
const flag = (verdict: string | null | undefined) => (verdict && FLAG_TITLE[verdict] ? ` replay-step-${verdict}` : '');

const signed = (cp: number) => `${cp >= 0 ? '+' : '-'}${(Math.abs(cp) / 100).toFixed(2)}`;

/** The engine's evaluation across the game. It plots the scores it was sent and nothing else. */
function EvalGraph({ steps, plies, index, onStep }: { steps: Review['steps']; plies: number; index: number; onStep: (i: number) => void }) {
  const W = 320;
  const H = 84;
  const x = (ply: number) => (plies === 0 ? 0 : (ply / plies) * W);
  const y = (cp: number) => H / 2 - (cp / CAP) * (H / 2 - 4);
  const points = steps
    .map((step, ply) => (step?.score ? `${x(ply).toFixed(1)},${y(height(step.score)).toFixed(1)}` : null))
    .filter((p): p is string => p !== null);
  return (
    <svg className="eval-graph" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Evaluation through the game, White's view">
      <rect className="eval-graph-white" x={0} y={0} width={W} height={H / 2} />
      <line className="eval-graph-zero" x1={0} y1={H / 2} x2={W} y2={H / 2} />
      {points.length > 1 && <polyline className="eval-graph-line" points={points.join(' ')} />}
      <line className="eval-graph-now" x1={x(index)} y1={0} x2={x(index)} y2={H} />
      {steps.map((step, ply) =>
        step ? (
          <rect
            key={ply}
            className="eval-graph-hit"
            x={x(ply) - W / Math.max(1, plies) / 2}
            y={0}
            width={W / Math.max(1, plies)}
            height={H}
            onClick={() => onStep(ply)}
          >
            <title>{`${ply === 0 ? 'Start' : step.move?.san}${step.score ? ` ${formatScore(step.score)}` : ''}`}</title>
          </rect>
        ) : null,
      )}
    </svg>
  );
}

/**
 * An imported game, position by position: the engine's evaluation and
 * Prolog's facts for each. Shown in place of the reasoning panel so the facts
 * on the right always belong to the board on the left.
 */
export function GameReview({ review, index, view, active, onHover, onStep, onClose }: Props) {
  const plies = review.moves.length;
  const ready = review.steps.filter(Boolean).length;
  const step = (view?.step ?? null) as ReviewStep | null;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      if (event.key === 'ArrowRight' && index < plies) onStep(index + 1);
      else if (event.key === 'ArrowLeft' && index > 0) onStep(index - 1);
      else if (event.key === 'Home') onStep(0);
      else if (event.key === 'End') onStep(plies);
      else if (event.key === 'Escape') onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, plies, onStep, onClose]);

  const { White, Black, Event, Date: date } = review.tags;
  const title = White && Black ? `${White} – ${Black}` : 'Imported game';
  const sub = [Event, date, review.result].filter(Boolean).join(' · ');
  const startsWithBlack = review.steps[1]?.by === 'black';
  const startNumber = Number(review.steps[0]?.fen.split(' ')[5]) || 1;
  const terms = step?.evalBreakdown;
  const marked = review.steps.filter((s) => s?.change?.verdict && FLAG_TITLE[s.change.verdict]).length;

  return (
    <aside className="reasoning replay" aria-label="Game review">
      <header className="reasoning-head">
        <h2 className="reasoning-title review-title">{title}</h2>
      </header>
      {sub && <p className="replay-note">{sub}</p>}
      {review.error && (
        <p className="review-error" role="alert">
          Reading stopped at half-move {review.error.ply} (“{review.error.text}”): {review.error.message} The{' '}
          {plies} half-moves before it were kept.
        </p>
      )}

      <div className="review-graph">
        <EvalGraph steps={review.steps} plies={plies} index={index} onStep={onStep} />
        <p className="quiet">
          {review.complete &&
            marked > 0 &&
            `${marked} move${marked === 1 ? '' : 's'} marked: a depth-${review.steps[0]?.depth ?? 5} search preferred something else. It misjudges sacrifices that pay off later. `}
          {review.complete
            ? `Evaluation at depth ${review.steps[0]?.depth ?? '—'}, White’s view, capped at ±5. Click to jump.`
            : `Analysing… ${ready} of ${plies + 1} positions`}
        </p>
      </div>

      <div className="replay-nav">
        <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => onStep(index - 1)} aria-label="Previous position">
          ←
        </button>
        <ol className="review-moves" aria-label="Moves of the game">
          <li>
            <button type="button" className={`replay-step${index === 0 ? ' replay-step-on' : ''}`} onClick={() => onStep(0)}>
              Start
            </button>
          </li>
          {review.moves.map((san, i) => {
            const ply = i + 1;
            const whiteMove = startsWithBlack ? i % 2 === 1 : i % 2 === 0;
            const number = startNumber + Math.floor((i + (startsWithBlack ? 1 : 0)) / 2);
            return (
              <li key={ply}>
                {(whiteMove || i === 0) && <span className="review-number">{number}{whiteMove ? '.' : '…'}</span>}
                <button
                  type="button"
                  className={`replay-step${ply === index ? ' replay-step-on' : ''}${flag(review.steps[ply]?.change?.verdict)}`}
                  aria-current={ply === index ? 'step' : undefined}
                  title={FLAG_TITLE[review.steps[ply]?.change?.verdict ?? ''] }
                  disabled={!review.steps[ply]}
                  onClick={() => onStep(ply)}
                >
                  {san}
                </button>
              </li>
            );
          })}
        </ol>
        <button type="button" className="btn btn-small" disabled={index >= plies} onClick={() => onStep(index + 1)} aria-label="Next position">
          →
        </button>
      </div>

      <div className="reasoning-body">
        {!step ? (
          <p className="quiet pad">Waiting for the engine’s first position…</p>
        ) : (
          <>
            <section className="block">
              <h3>
                {index === 0 ? 'Starting position' : `After ${step.move?.san}`} <span className="badge badge-search">Lisp</span>
              </h3>
              <p className="eval-line">
                <span className="eval-score">{step.score ? formatScore(step.score) : step.checkmate ? 'Checkmate' : 'Game over'}</span>
                {step.score && <span className="quiet">White’s view · depth {step.depth}</span>}
              </p>
              {step.change && (
                <ul className="plain change-lines">
                  {step.change.lines.map((line, i) => (
                    <li key={i}>{line}</li>
                  ))}
                </ul>
              )}
              {terms && (
                <dl className="kv kv-terms">
                  <div><dt>Material</dt><dd>{signed(terms.material)}</dd></div>
                  <div><dt>Placement</dt><dd>{signed(terms.placement)}</dd></div>
                  <div><dt>Pawns</dt><dd>{signed(terms.pawnStructure)}</dd></div>
                  {terms.activity !== undefined && <div><dt>Activity</dt><dd>{signed(terms.activity)}</dd></div>}
                  {terms.kingSafety !== undefined && <div><dt>King safety</dt><dd>{signed(terms.kingSafety)}</dd></div>}
                </dl>
              )}
            </section>
            <section className="block">
              <h3>
                What Prolog sees <span className="badge badge-prolog">Prolog</span>
              </h3>
              {!step.symbolic && !step.checkmate && <p className="quiet">The knowledge layer did not answer for this position.</p>}
              {step.symbolic && step.facts.length === 0 && <p className="quiet">No tactical or structural facts here.</p>}
              <FactList facts={step.facts} active={active} onHover={onHover} />
            </section>
          </>
        )}
      </div>

      <div className="replay-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Back to the live board
        </button>
        <span className="quiet">← → to step, Home, End, Esc</span>
      </div>
    </aside>
  );
}
