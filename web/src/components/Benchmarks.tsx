import { useEffect, useRef } from 'react';

// The measured results, copied from docs/NEXT_STAGE.md. They are a record of
// runs that were made, not something this page computes. If a run is repeated
// the numbers there and here must be changed together.

interface Table {
  title: string;
  note: string;
  head: string[];
  rows: string[][];
}

const TABLES: Table[] = [
  {
    title: 'Does the stronger engine actually win more?',
    note: 'Self-play at 100 ms per move, 12 openings each played with both colours. With 96 games the margin of error is about five percentage points either way.',
    head: ['Match', 'Games', 'Won', 'Drawn', 'Lost', 'Points'],
    rows: [
      ['Current engine against the first engine', '96', '49', '21', '26', '62.0%'],
      ['Current against itself without the new evaluation terms', '72', '30', '26', '16', '59.7%'],
    ],
  },
  {
    title: 'Speed',
    note: 'Seven test positions. The newer engine reaches the same depth sooner by searching fewer positions, but looks at each one more slowly because its evaluation does more work.',
    head: ['Measure', 'First engine', 'Current engine'],
    rows: [
      ['Time to depth 7', '8.8 s', '2.7 s'],
      ['Positions per second', 'about 500,000', '150,000 to 200,000'],
    ],
  },
  {
    title: 'Are the difficulty levels really different?',
    note: 'Twelve openings with both colours. Expert was given 300 ms per move here, a tenth of its real allowance.',
    head: ['Match', 'Games', 'Won', 'Drawn', 'Lost', 'Points'],
    rows: [
      ['Club against Novice', '24', '24', '0', '0', '100%'],
      ['Expert against Novice', '24', '24', '0', '0', '100%'],
      ['Expert against Club', '48', '25', '16', '7', '68.8%'],
    ],
  },
  {
    title: 'Does Prolog make the search better?',
    note: 'No. Prolog’s ranking of the moves was tried as a way to order the search. It saved no work and, once the time Prolog takes was counted, play got weaker. So the search no longer uses it; Prolog explains, warns and plans instead.',
    head: ['Measure', 'Result'],
    rows: [
      ['Positions searched to depth 6 over 19 positions, with hints against without', '476,929 against 477,061 (0.0%)'],
      ['Same move chosen', '16 of 19 positions'],
      ['Full engine with hints against without, 300 ms per move', '19 won, 43 drawn, 34 lost: 42.2%'],
      ['One Prolog analysis of a position', 'about 22 ms'],
      ['Asking Prolog about every position two moves ahead', 'about 21 s per move, so it was not built'],
    ],
  },
];

const LIMITS = [
  'This is a small classical engine. It is far weaker than Stockfish and is not trying to compete with it.',
  'The step from Novice to Club is very large, and there is nothing in between.',
  'On the free hosted site the search is capped at depth 7 and 3 seconds, on a tenth of a processor, so Expert plays much like Club there.',
  'Prolog’s rules read attacked squares, not legal moves, so a “trapped piece” or “pinned defender” is a strong hint, not a proof.',
  'There is no dedicated tactical puzzle suite yet. Strength was measured by self-play only.',
  'All figures are from one desktop with other programs running.',
];

/** A page of measured results, including the ones that did not go the project's way. */
export function Benchmarks({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
  }, []);

  return (
    <dialog ref={ref} className="sheet" aria-labelledby="bench-title" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="sheet-body">
        <header className="sheet-head">
          <h2 id="bench-title">Measured results</h2>
          <button type="button" className="btn btn-small" onClick={onClose}>
            Close
          </button>
        </header>
        <p className="quiet">
          What was measured, how, and what it showed. Every figure here came from a run that is described in the
          project’s notes and can be repeated with the scripts in the repository.
        </p>
        {TABLES.map((table) => (
          <section key={table.title} className="sheet-section">
            <h3>{table.title}</h3>
            <p className="quiet">{table.note}</p>
            <div className="sheet-scroll">
              <table className="sheet-table">
                <thead>
                  <tr>
                    {table.head.map((h) => (
                      <th key={h} scope="col">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row) => (
                    <tr key={row[0]}>
                      {row.map((cell, i) => (i === 0 ? <th key={i} scope="row">{cell}</th> : <td key={i}>{cell}</td>))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ))}
        <section className="sheet-section">
          <h3>Known limits</h3>
          <ul className="sheet-list">
            {LIMITS.map((limit) => (
              <li key={limit}>{limit}</li>
            ))}
          </ul>
        </section>
      </div>
    </dialog>
  );
}
