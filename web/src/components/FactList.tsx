import type { Fact } from '../protocol';
import type { Highlight } from '../selectViz';
import { Icon } from './icons';
import { KIND, UNKNOWN_KIND } from './ReasoningPanel';

interface Props {
  facts: Fact[];
  active: Highlight;
  onHover: (h: Highlight) => void;
}

/** Prolog's facts for one position, as plain cards. Hovering one lights it up on the board. */
export function FactList({ facts, active, onHover }: Props) {
  return (
    <ul className="cards">
      {facts.map((fact) => {
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
  );
}
