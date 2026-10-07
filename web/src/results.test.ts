import { describe, expect, it } from 'vitest';
import {
  credibilityTable,
  depthTable,
  looksRecorded,
  matchTable,
  movesTable,
  provenanceLine,
  RECORDED,
  recordedTables,
  type MatchResults,
  type Run,
  type SearchResults,
} from './results';

const run: Run = {
  date: '2026-01-02 03:04 UTC',
  command: 'sbcl --script x.lisp',
  engine: 'symchess 9',
  lisp: 'SBCL 1',
  prolog: null,
  machine: 'a machine',
  sourceDigest: '0123456789abcdef0123456789abcdef',
  commit: 'abc1234',
  uncommittedChanges: false,
};

const search: SearchResults = {
  run,
  configurations: [
    { name: 'old', description: 'The first engine.', features: { lmr: false }, rootHints: false },
    { name: 'new', description: 'Everything on.', features: { lmr: true }, rootHints: false },
  ],
  depth: {
    what: 'Work.',
    depth: 6,
    positions: ['a', 'b'],
    rows: [
      { configuration: 'old', nodes: 2000, searchMs: 1500, prologMs: null, moves: ['e2e4', 'd2d4'] },
      { configuration: 'new', nodes: 500, searchMs: 400, prologMs: 120, moves: ['e2e4', 'd2d4'] },
    ],
  },
  moves: {
    what: 'Moves.',
    depth: 6,
    timeLimitMs: 2000,
    rows: [
      { configuration: 'old', positions: 3, right: 2, missed: [{ position: 'p1', played: 'a2a3' }] },
      { configuration: 'new', positions: 3, right: 3, missed: [] },
    ],
  },
};

const matches: MatchResults = {
  run,
  configurations: search.configurations,
  what: 'Self-play.',
  openings: ['One', 'Two'],
  complete: false,
  rows: [{ candidate: 'new', baseline: 'old', msPerMove: 100, games: 4, wins: 2, draws: 1, losses: 1, points: 62.5 }],
};

describe('tables are the recorded numbers and nothing else', () => {
  it('shows work as recorded, and as a share of the first engine’s', () => {
    const table = depthTable(search);
    expect(table.rows[0]).toEqual(['old', 'The first engine.', '2,000', '100.0%', '1.5 s', 'not asked']);
    expect(table.rows[1]).toEqual(['new', 'Everything on.', '500', '25.0%', '0.4 s', '0.1 s']);
  });

  it('names the positions a configuration got wrong', () => {
    expect(movesTable(search).rows).toEqual([
      ['old', '2 of 3', 'p1 (played a2a3)'],
      ['new', '3 of 3', 'none'],
    ]);
  });

  it('shows a match as played, says how few games it is, and says when a run was cut short', () => {
    const table = matchTable(matches);
    expect(table.rows).toEqual([['new against old', '4', '2', '1', '1', '62.5%']]);
    expect(table.note).toContain('4 games');
    expect(table.details).toEqual(['This run was stopped before every match had been played.']);
    expect(matchTable({ ...matches, complete: true }).details).toEqual([]);
  });

  it('carries its run with it', () => {
    expect(depthTable(search).run).toBe(run);
  });
});

describe('where a figure came from', () => {
  it('is stated in one line: date, commit, sources, engine, machine', () => {
    expect(provenanceLine(run)).toBe(
      'Recorded 2026-01-02 03:04 UTC · commit abc1234 · sources 01234567 · symchess 9, SBCL 1 · a machine',
    );
  });

  it('says when the sources were not the committed ones, or no commit is known', () => {
    expect(provenanceLine({ ...run, uncommittedChanges: true })).toContain('commit abc1234 with uncommitted changes');
    expect(provenanceLine({ ...run, commit: null })).toContain('no commit recorded');
  });

  it('refuses a file with no run, or a fingerprint that is not one', () => {
    expect(looksRecorded(search)).toBe(true);
    expect(looksRecorded({})).toBe(false);
    expect(looksRecorded({ run: { ...run, sourceDigest: 'not a digest' } })).toBe(false);
    expect(looksRecorded({ run: { ...run, date: 5 } })).toBe(false);
  });
});

describe('the files in results/', () => {
  it('are all recorded runs', () => {
    expect(looksRecorded(RECORDED.search)).toBe(true);
    expect(looksRecorded(RECORDED.matches)).toBe(true);
    expect(looksRecorded(RECORDED.credibility)).toBe(true);
  });

  it('render as four tables with a row for every configuration, match and measure', () => {
    const tables = recordedTables();
    expect(tables).toHaveLength(4);
    expect(tables[0]!.rows).toHaveLength(RECORDED.search.configurations.length);
    expect(tables[1]!.rows).toHaveLength(RECORDED.search.configurations.length);
    expect(tables[2]!.rows).toHaveLength(RECORDED.matches.rows.length);
    expect(tables.every((t) => t.rows.every((row) => row.length === t.head.length))).toBe(true);
  });

  it('have one column per labelled set, and name every miss under the table', () => {
    const table = credibilityTable(RECORDED.credibility);
    expect(table.head).toHaveLength(1 + RECORDED.credibility.sets.length);
    const misses = RECORDED.credibility.sets.reduce(
      (n, s) => n + s.motifs.reportedButNotThere.length + s.motifs.thereButNotReported.length + s.moves.missed.length,
      0,
    );
    expect(table.details).toHaveLength(misses);
  });

  it('were all produced by the same sources', () => {
    const digests = new Set([RECORDED.search, RECORDED.matches, RECORDED.credibility].map((f) => f.run.sourceDigest));
    expect(digests.size).toBe(1);
  });
});
