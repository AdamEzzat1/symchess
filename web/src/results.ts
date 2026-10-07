// The results page's figures, read from the files the measuring scripts write
// (results/*.json at the top of the repository). Nothing here measures or
// judges anything: it lays recorded numbers out as tables. Percentages are
// arithmetic on two recorded counts and say so.

import credibilityFile from '../../results/credibility.json';
import ladderFile from '../../results/ladder.json';
import matchesFile from '../../results/matches.json';
import searchFile from '../../results/search.json';
import strengthFile from '../../results/strength.json';

/** What a reader needs to trace a figure to the run that produced it. */
export interface Run {
  date: string;
  command: string;
  engine: string;
  lisp: string;
  prolog: string | null;
  machine: string;
  processors?: number | null;
  /** Anything the person running it put on record about the conditions. */
  note?: string | null;
  /** Fingerprint of the engine and rule sources the run used. */
  sourceDigest: string;
  commit: string | null;
  /** True when the sources differed from that commit. */
  uncommittedChanges: boolean | null;
}

export interface Configuration {
  name: string;
  description: string;
  features: Record<string, boolean>;
  rootHints: boolean;
}

export interface SearchResults {
  run: Run;
  configurations: Configuration[];
  depth: {
    what: string;
    depth: number;
    positions: string[];
    rows: { configuration: string; nodes: number; searchMs: number; prologMs: number | null; moves: string[] }[];
  };
  moves: {
    what: string;
    depth: number;
    timeLimitMs: number;
    rows: { configuration: string; positions: number; right: number; missed: { position: string; played: string }[] }[];
  };
}

export interface MatchResults {
  run: Run;
  configurations: Configuration[];
  what: string;
  openings: string[];
  /** False if the run was stopped before every match was played. */
  complete: boolean;
  rows: {
    candidate: string;
    baseline: string;
    msPerMove: number;
    games: number;
    wins: number;
    draws: number;
    losses: number;
    points: number | null;
  }[];
}

interface Count {
  right: number;
  of: number;
}

export interface CredibilitySet {
  id: string;
  title: string;
  positions: number;
  prolog: boolean;
  motifs: { found: number; extra: number; missed: number; reportedButNotThere: string[]; thereButNotReported: string[] };
  moves: Count & { missed: string[] };
  statuses: Count;
  confirmedBacked: Count;
  whyNot: Count;
  warningsConfirmed: Count;
  traceable: Count;
  prologSentences: { confirmed: number; unconfirmed: number; overruled: number; unchecked: number };
  topMove: { same: number; of: number; differedWithLabel: number; searchRight: number; prologRight: number };
}

export interface CredibilityResults {
  run: Run;
  what: string;
  depth: number;
  timeLimitMs: number;
  sets: CredibilitySet[];
}

export interface RecordedTable {
  title: string;
  note: string;
  head: string[];
  rows: string[][];
  /** Lines under the table: the misses and exceptions the counts hide. */
  details: string[];
  run: Run;
}

const count = (n: number) => n.toLocaleString('en-US');
const of = (c: Count) => (c.of === 0 ? 'none arose' : `${c.right} of ${c.of}`);
const percent = (part: number, whole: number) => (whole === 0 ? 'n/a' : `${((100 * part) / whole).toFixed(1)}%`);

/** One line saying where a table's figures came from. */
export function provenanceLine(run: Run): string {
  const commit =
    run.commit === null
      ? 'no commit recorded'
      : `commit ${run.commit}${run.uncommittedChanges ? ' with uncommitted changes' : ''}`;
  const note = run.note ? ` · ${run.note}` : '';
  return `Recorded ${run.date} · ${commit} · sources ${run.sourceDigest.slice(0, 8)} · ${run.engine}, ${run.lisp} · ${run.machine}${note}`;
}

const describe = (configurations: Configuration[], name: string) =>
  configurations.find((c) => c.name === name)?.description ?? name;

export function depthTable(data: SearchResults): RecordedTable {
  const base = data.depth.rows.find((row) => row.configuration === 'old');
  return {
    title: 'Which changes reduce the work?',
    note: `${data.depth.what} Depth ${data.depth.depth}, ${data.depth.positions.length} positions. Time is from one run on one machine and is the least reliable column.`,
    head: ['Configuration', 'What it is', 'Positions searched', 'Against the first engine', 'Search time', 'Prolog time'],
    rows: data.depth.rows.map((row) => [
      row.configuration,
      describe(data.configurations, row.configuration),
      count(row.nodes),
      base && base.nodes > 0 ? percent(row.nodes, base.nodes) : 'n/a',
      `${(row.searchMs / 1000).toFixed(1)} s`,
      row.prologMs === null ? 'not asked' : `${(row.prologMs / 1000).toFixed(1)} s`,
    ]),
    details: [],
    run: data.run,
  };
}

export function movesTable(data: SearchResults): RecordedTable {
  return {
    title: 'Does each configuration find the labelled moves?',
    note: `${data.moves.what} Depth ${data.moves.depth} within ${data.moves.timeLimitMs} ms.`,
    head: ['Configuration', 'Right', 'Wrong on'],
    rows: data.moves.rows.map((row) => [
      row.configuration,
      `${row.right} of ${row.positions}`,
      row.missed.length === 0 ? 'none' : row.missed.map((m) => `${m.position} (played ${m.played})`).join('; '),
    ]),
    details: [],
    run: data.run,
  };
}

export function matchTable(data: MatchResults, title = 'Does it win more games?', timed = true): RecordedTable {
  const ms = data.rows[0]?.msPerMove;
  return {
    title,
    note: `${data.what}${!timed || ms === undefined ? '' : ` ${ms} ms per move.`} A match here is ${data.openings.length * 2} games, which is few: a result within about twenty points of 50% shows nothing either way.`,
    head: ['Match', 'Games', 'Won', 'Drawn', 'Lost', 'Points'],
    rows: data.rows.map((row) => [
      `${row.candidate} against ${row.baseline}`,
      String(row.games),
      String(row.wins),
      String(row.draws),
      String(row.losses),
      row.points === null ? 'n/a' : `${row.points.toFixed(1)}%`,
    ]),
    details: data.complete ? [] : ['This run was stopped before every match had been played.'],
    run: data.run,
  };
}

/** The engine against an earlier version of itself, at each time per move that was played. */
export function strengthTable(data: MatchResults): RecordedTable {
  const games = data.rows[0]?.games ?? data.openings.length * 2;
  return {
    title: 'Is it stronger than it was?',
    note: `${data.what} With ${games} games a result has to be about fifteen points from 50% before it shows anything, and this is the engine against its own earlier self, not against anything else.`,
    head: ['Match', 'Time per move', 'Games', 'Won', 'Drawn', 'Lost', 'Points'],
    rows: data.rows.map((row) => [
      `${row.candidate} against ${row.baseline}`,
      `${row.msPerMove} ms`,
      String(row.games),
      String(row.wins),
      String(row.draws),
      String(row.losses),
      row.points === null ? 'n/a' : `${row.points.toFixed(1)}%`,
    ]),
    details: data.complete ? [] : ['This run was stopped before every match had been played.'],
    run: data.run,
  };
}

export function credibilityTable(data: CredibilityResults): RecordedTable {
  const measures: [string, (set: CredibilitySet) => string][] = [
    ['Positions', (s) => String(s.positions)],
    ['Tactical facts reported that were really there', (s) => `${s.motifs.found} of ${s.motifs.found + s.motifs.extra}`],
    ['Real tactical facts that were found', (s) => `${s.motifs.found} of ${s.motifs.found + s.motifs.missed}`],
    ['Right move played at Club level', (s) => of(s.moves)],
    ['Explanation gave the labelled status', (s) => of(s.statuses)],
    ['“Confirmed” sentences the search line really backs', (s) => of(s.confirmedBacked)],
    ['“Why not this move?” rating matches the label', (s) => of(s.whyNot)],
    ['Sentences that name their rule, their check and facts that exist', (s) => of(s.traceable)],
    ['Prolog’s top-ranked move was the move the search chose', (s) => `${s.topMove.same} of ${s.topMove.of}`],
    [
      'Where they differed: the search’s move was a labelled one / Prolog’s was',
      (s) => `${s.topMove.searchRight} / ${s.topMove.prologRight} of ${s.topMove.differedWithLabel}`,
    ],
  ];
  const details = data.sets.flatMap((set) => [
    ...set.motifs.reportedButNotThere.map((x) => `Reported but not really there (${set.id}): ${x}`),
    ...set.motifs.thereButNotReported.map((x) => `Really there but not reported (${set.id}): ${x}`),
    ...set.moves.missed.map((x) => `Wrong move (${set.id}): ${x}`),
  ]);
  return {
    title: 'Are the explanations right?',
    note: `${data.what} Depth ${data.depth} within ${data.timeLimitMs} ms. The rules were corrected against the development set, so the held-out sets are the fairer test.`,
    head: ['Measure', ...data.sets.map((s) => s.id)],
    rows: measures.map(([label, cell]) => [label, ...data.sets.map(cell)]),
    details,
    run: data.run,
  };
}

/** Enough to refuse a results file that would render nonsense. */
export function looksRecorded(value: unknown): value is { run: Run } {
  if (typeof value !== 'object' || value === null) return false;
  const run = (value as { run?: unknown }).run;
  if (typeof run !== 'object' || run === null) return false;
  const r = run as Record<string, unknown>;
  return (
    typeof r.date === 'string' &&
    typeof r.command === 'string' &&
    typeof r.sourceDigest === 'string' &&
    /^[0-9a-f]{32}$/.test(r.sourceDigest) &&
    (r.commit === null || typeof r.commit === 'string')
  );
}

export const RECORDED: {
  search: SearchResults;
  matches: MatchResults;
  ladder: MatchResults;
  strength: MatchResults;
  credibility: CredibilityResults;
} = {
  search: searchFile,
  matches: matchesFile,
  ladder: ladderFile,
  strength: strengthFile,
  credibility: credibilityFile,
};

export function recordedTables(data = RECORDED): RecordedTable[] {
  return [
    depthTable(data.search),
    movesTable(data.search),
    matchTable(data.matches),
    strengthTable(data.strength),
    matchTable(data.ladder, 'Are the difficulty levels really different?', false),
    credibilityTable(data.credibility),
  ];
}
