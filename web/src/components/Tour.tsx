import type { DemoStep } from '../demo';
import type { Level } from '../protocol';

const LEVELS: { id: Level; label: string }[] = [
  { id: 'novice', label: 'Novice' },
  { id: 'club', label: 'Club' },
  { id: 'expert', label: 'Expert' },
];

interface Props {
  steps: readonly DemoStep[];
  index: number;
  /** The level the engine says it is playing at, for the levels step. */
  level: Level | undefined;
  busy: boolean;
  onGo: (index: number) => void;
  onLevel: (level: Level) => void;
  onEnd: () => void;
}

/** The guided tour's caption bar. It only says what to look at and moves between steps. */
export function Tour({ steps, index, level, busy, onGo, onLevel, onEnd }: Props) {
  const step = steps[index]!;
  const last = index === steps.length - 1;
  return (
    <section className="tour" aria-label="Guided tour">
      <header className="tour-head">
        <span className="tour-count">
          Tour · {index + 1} of {steps.length}
        </span>
        <h2 className="tour-title">{step.title}</h2>
        <button type="button" className="btn btn-quiet" onClick={onEnd}>
          End tour
        </button>
      </header>
      <p className="tour-text" aria-live="polite">
        {step.caption}
      </p>
      <div className="tour-actions">
        {step.levels && (
          <div className="tour-levels" role="group" aria-label="Let the engine move at this level">
            {LEVELS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={`btn btn-small${level === l.id ? ' btn-on' : ''}`}
                disabled={busy}
                onClick={() => onLevel(l.id)}
              >
                {l.label}
              </button>
            ))}
          </div>
        )}
        <span className="tour-spacer" />
        <button type="button" className="btn btn-small" disabled={index === 0} onClick={() => onGo(index - 1)}>
          Back
        </button>
        {last ? (
          <button type="button" className="btn btn-small btn-primary" onClick={onEnd}>
            Finish and play
          </button>
        ) : (
          <button type="button" className="btn btn-small btn-primary" onClick={() => onGo(index + 1)}>
            Next
          </button>
        )}
      </div>
    </section>
  );
}
