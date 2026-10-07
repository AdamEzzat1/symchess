import { useEffect, useState } from 'react';
import type { ClientCommand, GameState, MessageOf } from '../protocol';
import { formatScore } from './SearchTrace';

const VERDICT: Record<string, { label: string; tone: string }> = {
  best: { label: 'engine’s choice', tone: 'confirmed' },
  as_good: { label: 'about as good', tone: 'confirmed' },
  inaccuracy: { label: 'inaccuracy', tone: 'unconfirmed' },
  missed_chance: { label: 'missed chance', tone: 'unconfirmed' },
  mistake: { label: 'mistake', tone: 'overruled' },
  blunder: { label: 'blunder', tone: 'overruled' },
};

interface Props {
  game: GameState;
  /** The engine's comparison, if it is about the position on screen. */
  result: MessageOf<'counterfactual'> | null;
  disabled: boolean;
  send: (command: ClientCommand) => void;
  onReplay: (searchId: number) => void;
  replayPending: boolean;
  /** Follow one of the answer's sentences back to its rule. */
  onTrace: (searchId: number, index: number) => void;
}

/**
 * "Why not this move?" The list of moves is the engine's legal moves; the
 * answer is the engine's comparison of two searches. Nothing is worked out here.
 */
export function Counterfactual({ game, result, disabled, send, onReplay, replayPending, onTrace }: Props) {
  const [uci, setUci] = useState('');
  const [asked, setAsked] = useState<string | null>(null);

  // A new position has new moves and no pending question.
  useEffect(() => {
    setUci('');
    setAsked(null);
  }, [game.positionId]);
  useEffect(() => {
    if (result && asked === result.move.uci) setAsked(null);
  }, [result, asked]);

  const moves = [...game.legalMoves].sort((a, b) => a.san.localeCompare(b.san));
  const verdict = result ? (VERDICT[result.verdict] ?? { label: result.verdict, tone: 'heuristic' }) : null;

  return (
    <section className="block" aria-label="Why not this move?">
      <h3>
        Why not another move? <span className="badge badge-search">Lisp</span>
      </h3>
      <form
        className="whynot-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!uci) return;
          setAsked(uci);
          send({ type: 'explain_move', uci, positionId: game.positionId });
        }}
      >
        <label className="field">
          <span>Move to compare with the engine’s choice</span>
          <select value={uci} onChange={(e) => setUci(e.target.value)} disabled={disabled || moves.length === 0}>
            <option value="">Choose a move…</option>
            {moves.map((m) => (
              <option key={m.uci} value={m.uci}>
                {m.san}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="btn btn-small" disabled={disabled || !uci || asked !== null}>
          {asked ? 'Searching both…' : 'Compare'}
        </button>
      </form>

      {result && verdict && (
        <div className="whynot">
          <p className="summary">
            <span className={`badge badge-${verdict.tone}`}>{verdict.label}</span> {result.summary}
          </p>
          <table className="whynot-table">
            <thead>
              <tr>
                <th scope="col" />
                <th scope="col">{result.move.san}</th>
                {!result.isBest && <th scope="col">{result.best.san} (engine)</th>}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Score, White’s view</th>
                <td>{formatScore(result.score)}</td>
                {!result.isBest && <td>{formatScore(result.bestScore)}</td>}
              </tr>
              <tr>
                <th scope="row">Expected line</th>
                <td className="pv">{result.line.join(' ')}</td>
                {!result.isBest && <td className="pv">{result.bestLine.join(' ')}</td>}
              </tr>
              <tr>
                <th scope="row">Facts it creates</th>
                <td>{result.factsAdded.length}</td>
                {!result.isBest && <td>{result.bestFactsAdded.length}</td>}
              </tr>
              <tr>
                <th scope="row">Facts it removes</th>
                <td>{result.factsRemoved.length}</td>
                {!result.isBest && <td>{result.bestFactsRemoved.length}</td>}
              </tr>
            </tbody>
          </table>
          <ul className="explain">
            {result.items.map((item, i) => (
              <li key={i} className={`explain-item status-${item.status}`}>
                <span className="explain-tags">
                  <span className={`badge badge-${item.source}`}>{item.source}</span>
                  <span className={`badge badge-${item.status}`}>{item.status}</span>
                </span>
                {item.text}
                {item.basis && <span className="basis">{item.basis}</span>}
                <button type="button" className="btn btn-small btn-trace" onClick={() => onTrace(result.searchId, i)}>
                  Trace
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn btn-small btn-replay" disabled={replayPending} onClick={() => onReplay(result.searchId)}>
            {replayPending ? 'Fetching the line…' : `Step through the line after ${result.move.san}`}
          </button>
          <p className="quiet">
            Both moves were searched to depth {result.depth}. At that depth the search is sometimes wrong about quiet
            moves; treat a small difference as no difference.
          </p>
        </div>
      )}
    </section>
  );
}
