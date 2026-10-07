import { useEffect, useRef } from 'react';
import { provenanceLine, recordedTables } from '../results';

// Two kinds of table. The recorded ones are built from results/*.json, which
// the measuring scripts write: each carries the date, commit and command of
// its run. The earlier ones below were copied by hand from docs/NEXT_STAGE.md
// before runs were recorded; they are kept as history and labelled as such.

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

TABLES.push({
  title: 'Explanations before the rules were corrected',
  note: 'From milestone 5, before four faults in the tactical rules were fixed. The current figures are in the recorded table above.',
  head: ['Measure', 'First 39 positions', '11 held-out positions'],
  rows: [['Tactical facts reported that were really there', '41 of 46 (89.1%)', '17 of 18 (94.4%)']],
});

const LIMITS = [
  'This is a small classical engine. It is far weaker than Stockfish and is not trying to compete with it.',
  'The steps between the four levels are steep: Casual won every game against Novice and Club won 23 of 24 against Casual.',
  'On the free hosted site the search is capped at depth 7 and 3 seconds, on a tenth of a processor, so Expert plays much like Club there.',
  'Prolog’s rules read attacked squares, not legal moves, so a “trapped piece” or “pinned defender” is a strong hint, not a proof.',
  'The explanation benchmark is small: 66 positions, five of them crowded. Its scores will not hold across real middlegames.',
  'Most tactical rules read lines of attack, not legal moves. A pin to an equal piece is checked against the legal moves; “trapped” and “pinned defender” are not.',
  'A move rating is what a depth-5 or depth-6 search prefers, and is worded that way. In the sample game Morphy’s winning sacrifice 10.Nxb5 is rated lower than a quiet move whenever the search is cut a ply short.',
  'A game review gives each search a quarter of a second. On a few positions that stops it early, so two reviews of the same game can rate those moves differently. Each rating states its depth.',
  'Prolog’s own ranking of moves, made without searching, matches the search about half the time. Where they differed on the first 39 positions the search’s move was the labelled one 6 times of 6 and Prolog’s once.',
  'Strength was measured by self-play only. No outside engine was available to play against, so there is no outside reference for strength, and no large tactical puzzle suite.',
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
          What was measured, how, and what it showed, including what did not go the project’s way. The first five
          tables are read from files the measuring scripts wrote; under each is the run it came from and the command
          that repeats it.
        </p>
        {recordedTables().map((table) => (
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
            {table.details.length > 0 && (
              <ul className="sheet-list">
                {table.details.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
            <p className="sheet-run">
              {provenanceLine(table.run)}
              <br />
              <code>{table.run.command}</code>
            </p>
          </section>
        ))}
        <section className="sheet-section">
          <h3>Earlier runs</h3>
          <p className="quiet">
            The tables below were copied by hand from the project’s notes before runs were recorded to files. They
            used more games or longer time limits than the recorded matches above, and cannot be traced to a commit.
          </p>
        </section>
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
