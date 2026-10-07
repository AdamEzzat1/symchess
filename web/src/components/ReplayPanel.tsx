import { useEffect } from 'react';
import type { Highlight } from '../selectViz';
import type { ReplayView } from '../replay';
import { Icon } from './icons';
import { KIND, UNKNOWN_KIND } from './ReasoningPanel';

interface Props {
  view: ReplayView;
  labels: string[];
  /** The move the line explains, e.g. "Nxf7". */
  moveSan: string;
  active: Highlight;
  onHover: (h: Highlight) => void;
  onStep: (index: number) => void;
  onClose: () => void;
}

/**
 * "Why this move?": the line the engine expects, one position at a time, with
 * what Prolog sees in each. Shown instead of the reasoning panel so the facts
 * on the right always belong to the board on the left.
 */
export function ReplayPanel({ view, labels, moveSan, active, onHover, onStep, onClose }: Props) {
  const { index, step } = view;
  const last = labels.length - 1;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
      if (event.key === 'ArrowRight' && index < last) onStep(index + 1);
      else if (event.key === 'ArrowLeft' && index > 0) onStep(index - 1);
      else if (event.key === 'Escape') onClose();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, last, onStep, onClose]);

  const where =
    index === 0
      ? 'The position the engine was looking at.'
      : `After ${labels[index]}${step.checkmate ? ': checkmate.' : step.check ? ': check.' : '.'}`;

  return (
    <aside className="reasoning replay" aria-label="Why this move">
      <header className="reasoning-head">
        <h2 className="reasoning-title">Why {moveSan}?</h2>
      </header>
      <p className="replay-note">
        This is the line the engine expects, not the game. The board shows step {index + 1} of {labels.length}.
      </p>

      <div className="replay-nav">
        <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => onStep(index - 1)} aria-label="Previous position">
          ←
        </button>
        <ol className="replay-steps" aria-label="Positions in the line">
          {labels.map((label, i) => (
            <li key={i}>
              <button
                type="button"
                className={`replay-step${i === index ? ' replay-step-on' : ''}`}
                aria-current={i === index ? 'step' : undefined}
                onClick={() => onStep(i)}
              >
                {label}
              </button>
            </li>
          ))}
        </ol>
        <button type="button" className="btn btn-small" disabled={index === last} onClick={() => onStep(index + 1)} aria-label="Next position">
          →
        </button>
      </div>

      <div className="reasoning-body">
        <section className="block">
          <h3>
            {where} <span className="badge badge-prolog">Prolog</span>
          </h3>
          {!step.symbolic && !step.checkmate && <p className="quiet">The knowledge layer did not answer for this position.</p>}
          {step.checkmate && <p className="quiet">The game ends here, so there is nothing more to read.</p>}
          {step.symbolic && step.facts.length === 0 && <p className="quiet">Prolog sees no tactical or structural facts here.</p>}
          <ul className="cards">
            {step.facts.map((fact) => {
              const look = KIND[fact.kind] ?? UNKNOWN_KIND;
              const item = { kind: 'fact' as const, id: fact.id };
              const on = active?.kind === 'fact' && active.id === fact.id;
              return (
                <li key={fact.id}>
                  <button
                    type="button"
                    className={`card${on ? ' card-active' : ''}`}
                    onMouseEnter={() => onHover(item)}
                    onMouseLeave={() => onHover(null)}
                    onFocus={() => onHover(item)}
                    onBlur={() => onHover(null)}
                  >
                    <span className="card-icon" style={{ color: look.color }}>
                      <Icon name={look.icon} size={22} />
                    </span>
                    <span className="card-main">
                      <span className="card-head">
                        <span className="card-title">{look.title}</span>
                      </span>
                      <span className="card-subject">{fact.label ?? fact.squares.join(' ')}</span>
                      <span className="card-text">{fact.text}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
          <p className="quiet">
            These are facts about a position the search expects to reach. If the opponent plays differently, it never
            arises.
          </p>
        </section>
      </div>

      <div className="replay-foot">
        <button type="button" className="btn btn-primary" onClick={onClose}>
          Back to the game
        </button>
        <span className="quiet">← → to step, Esc to leave</span>
      </div>
    </aside>
  );
}
