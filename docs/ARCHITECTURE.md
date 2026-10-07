# SymChess — Architecture Draft

A classical, explainable chess AI in three layers.

```text
Lisp owns truth and search.
Prolog owns symbolic meaning.
React owns visualization and interaction.
```

This document is the output of the StackRole group (seven roles, four critique
rounds). It describes the system **as built** in this repository's MVP and marks
clearly what is deferred. Measured numbers come from `engine/tests/bench.lisp`
on the development machine.

| Layer | Technology (version used) | Location |
|---|---|---|
| Engine | Common Lisp, SBCL 2.6.9, no third-party libraries | `engine/` |
| Knowledge | SWI-Prolog 10.0.2 | `knowledge/` |
| UI | TypeScript 7.0.2, React 19.3.0, Vite 8.3.3 (Node 26) | `web/` |

---

## 1. Executive Summary

SymChess is a conventional alpha-beta chess engine with a rule-based reasoning
layer bolted on *beside* the search rather than inside it.

- The **Lisp engine** holds the one true game state. It generates moves,
  searches, evaluates, keeps the clocks and decides when the game is over. It
  never needs Prolog or the browser in order to play a legal, sensible game.
- The **Prolog knowledge base** is asked about a position at most once per move.
  It answers in chess vocabulary: this knight is pinned, that square is a hole,
  this move forks king and rook. It never generates or plays moves.
- The **React app** draws what the engine tells it and sends the user's
  intentions back. It contains no chess rules: legal moves, notation, clocks,
  arrows and highlights all arrive from the engine.

The goal is not maximum Elo. It is an engine whose explanation of a move is
built from the same search result and the same symbolic facts that were
actually used, with each sentence labelled by where it came from and how far
the search backs it up.

**Honest headline result.** Prolog's move-ordering hints currently change the
size of the search tree by about 0.1% and never change the score (section 11).
In this MVP the symbolic layer pays for itself through explanation and
visualization, not through playing strength. That is stated in the UI as well.

---

## 2. StackRole Conclusions

Each role's independent recommendation, before integration.

**1. Common Lisp Engine Architect.** Use a 0x88 mailbox board, not bitboards,
for the first version: it is a quarter of the code, trivially debuggable, and
fast enough (about 2.4 M perft leaves/s, 0.5 M search nodes/s). Encode moves as
fixnums, hash with 62-bit Zobrist keys so keys stay unboxed fixnums in SBCL,
and keep make/unmake allocation-free. Search on a *copy* of the position so the
authoritative game can never be corrupted by a search thread.

**2. Prolog Knowledge Architect.** Do not assert facts into the database.
Build one immutable context term per position (pieces, a lookup tree, and the
full attack list) and pass it to every rule. That makes rules pure relations,
lets the root position and thirty "after move M" positions coexist, and makes
every rule unit-testable from a FEN string. Compute the attack list once;
everything else is cheap joins over about 150 tuples.

**3. Chess Logic Expert.** Encode first what is both common and cheap to get
right: attacks/defences, absolute and relative pins, forks, skewers, undefended
pieces, pieces attacked by cheaper pieces, passed/isolated/doubled pawns, open
files, outposts, a missing pawn shield. Delay anything that needs lookahead to
be true (discovered attacks, trapped pieces, zugzwang, "good vs bad bishop").
Every rule needs a "must stay silent" test, because a wrong explanation is
worse than none.

**4. Lisp–Prolog Integration Engineer.** One long-lived `swipl` child process,
one request per line, one JSON reply per line. Regenerate facts each time — a
position is 32 small terms, incremental updates would add state and bugs for no
gain. Lisp ships the *resulting position* of every legal root move, so Prolog
never needs a move generator. Cache replies by Zobrist key. Any timeout or
malformed reply kills the child and the engine carries on search-only.

**5. TypeScript/React Visualization Architect.** Vite + React + TypeScript, one
SVG board, overlays as a second SVG layer with `pointer-events: none`. State is
a single `useReducer` fed by engine events; no Redux, no router, no chess
library. Play mode should look like any chess site; analysis mode adds a
reasoning column whose every row can be hovered to isolate its overlay.

**6. Frontend/Engine Protocol Engineer.** WebSocket with JSON messages. Every
state-bearing message carries a monotonically increasing `positionId`; every
message carries a `seq`. The client drops analysis whose `positionId` is not
the one on screen; the server refuses commands addressed to an old
`positionId`. `game_state` is always a complete snapshot, so reconnection is
just "throw local state away and wait for the next snapshot".

**7. Systems Engineering Reviewer.** The three biggest risks are (a) a second
source of chess truth appearing in Prolog or React, (b) explanations that sound
right but do not reflect the search, (c) stale overlays. Each needs a
structural defence, not a convention: no move generator outside Lisp, a
verification status on every explanation sentence, and a reducer that cannot
store analysis for a position it is not showing.

---

## 3. Final Integrated Architecture

### Module list and ownership

| Module | Owner | Responsibility |
|---|---|---|
| `engine/src/board.lisp` | Lisp | 0x88 position, Zobrist, make/unmake, FEN |
| `engine/src/movegen.lisp` | Lisp | Pseudo-legal generation, legality filter, perft |
| `engine/src/notation.lisp` | Lisp | UCI and SAN text (the UI never derives notation) |
| `engine/src/eval.lisp` | Lisp | Numeric evaluation and its itemised breakdown |
| `engine/src/search.lisp` | Lisp | Iterative deepening, PVS, quiescence, TT, ordering |
| `engine/src/prolog-bridge.lisp` | Lisp | Child process, serialisation, cache, failure policy |
| `engine/src/game.lisp` | Lisp | Authoritative game, clocks, commands, explanation |
| `engine/src/websocket.lisp`, `server.lisp` | Lisp | RFC 6455 server, threads, event log |
| `knowledge/board.pl` | Prolog | Context term, attack geometry |
| `knowledge/tactics.pl` | Prolog | check, pin, skewer, fork, hanging, threatened, overloaded |
| `knowledge/structure.pl` | Prolog | files, pawn structure, weak squares, king shield |
| `knowledge/moves.pl` | Prolog | Per-move motifs (root vs after-move comparison) |
| `knowledge/plans.pl` | Prolog | Candidate plans, each citing fact ids |
| `knowledge/render.pl` | Prolog | Text and visualization primitives for every fact |
| `knowledge/analysis.pl`, `server.pl` | Prolog | Query entry points, line protocol |
| `web/src/protocol.ts` | React | Message types and runtime validator |
| `web/src/state.ts` | React | Reducer: the only interpreter of engine events |
| `web/src/selectViz.ts` | React | Chooses which engine-supplied primitives to draw |
| `web/src/components/*` | React | Board, overlays, panels |

### Responsibility split

| Concern | Lisp | Prolog | React |
|---|---|---|---|
| Legal moves, make/unmake | **owns** | never | displays engine's list |
| Game result, clocks | **owns** | never | displays; interpolates clock between snapshots |
| Search and score | **owns** | never | displays |
| Numeric evaluation | **owns** | never | displays breakdown |
| "What is pinned / hanging / weak" | never | **owns** | displays |
| Explanation text | assembles, verifies against PV | supplies motif sentences | displays |
| Arrow/highlight geometry on screen | never | chooses *what* (squares, style) | chooses *how* (colour, shape) |
| Selection, drag, board flip, panel toggles | never | never | **owns** |

### Data flow

```text
            make_move / new_game / inspect_square ...
   React  ───────────────────────────────────────────►  Lisp engine
  (browser) ◄───────────────────────────────────────────  (SBCL)
            game_state, search_update, symbolic_analysis,       │  ▲
            explanation, inspection, error                      │  │ one JSON
                                                   one term     ▼  │ line
                                                   per line   Prolog (swipl)
```

### Call flow for one engine move

1. Human move arrives (`make_move`, with the `positionId` it was made for).
2. Lisp validates it against its own legal-move list, plays it, bumps
   `positionId`, broadcasts `move_played` and a full `game_state`.
3. A worker thread takes a **copy** of the position and:
   1. asks Prolog for the root analysis (cache hit: 0 ms; miss: about 30–120 ms);
   2. broadcasts `symbolic_analysis`;
   3. converts per-move motif scores into a root ordering table;
   4. runs the search — **no Prolog calls inside** — broadcasting
      `search_update` after each completed depth;
   5. re-takes the state lock and checks its `positionId` is still current.
      If not, the result is discarded silently.
   6. broadcasts `search_complete` and `explanation`, plays the move,
      broadcasts `move_played` + `game_state`.
4. A new worker analyses the resulting position for the human to look at.

---

## 4. Common Lisp Design

**Board representation.** 0x88 mailbox: `(simple-array (signed-byte 8) (128))`,
square = `rank*16 + file`, off-board test `(logand sq #x88)`. Pieces are small
integers, white positive, black negative. King squares are tracked. Bitboards
are the documented upgrade path if speed ever becomes the bottleneck; nothing
outside `board.lisp`/`movegen.lisp` depends on the representation.

**Move representation.** One fixnum:
`from(7) | to(7) | promo(3) | capture | double-push | en-passant | castle`.
Captured piece, castling rights, en-passant square, half-move clock and hash
are saved on an undo stack indexed by ply; that stack doubles as the repetition
history.

**Move generator.** Pseudo-legal generation into a preallocated
`(simple-array fixnum (256))`; legality is decided by `make-move`, which plays
the move, tests whether the mover's king is attacked, and undoes it if so.
Castling checks the king's start and transit squares at generation time.
A captures-only mode feeds quiescence. Verified by perft against published
counts in five positions (section 11).

**Search.** Iterative deepening → principal-variation search (negamax
alpha-beta with null-window re-search) → quiescence on captures and promotions.
Check extension, null-move pruning (R=2, disabled in check, at PV nodes and
with no non-pawn material), draw by repetition and fifty-move rule inside the
tree. A triangular PV table yields the full expected line. Known
simplification: quiescence does not extend checks.

**Evaluation.** Centipawns, side-to-move view. Material; piece-square tables
with a middlegame→endgame taper for the king; doubled, isolated and passed
pawns; bishop pair. `eval-breakdown` returns exactly the terms `evaluate` sums,
so the UI's table is the search's real leaf evaluation, not a re-computation.

**Transposition table.** 2^20 entries, always-replace, three parallel unboxed
arrays (key, move, packed score/depth/bound). Mate scores are stored
node-relative. Cutoffs are taken only at non-PV nodes so the reported line
stays intact. Not locked: exactly one search runs at a time (a new worker joins
the previous one first).

**Move ordering.** Hash move → captures by MVV-LVA → promotions → two killer
moves per ply → history heuristic. **At the root only**, Prolog's hint score is
added (`×2000`, enough for a strong warning to sink a capture below quiet
moves). Hints can change the order in which moves are tried; they cannot change
any score.

**Time management.** Depth limit and per-move time limit, the latter tightened
to `remaining/30 + increment/2` when a clock is running. The node loop polls
the deadline and a stop flag every 2048 nodes; an aborted iteration is
discarded and the previous depth's result is used.

**Interface exposed to Prolog** (`prolog-bridge.lisp`):

| Function | Purpose |
|---|---|
| `(symbolic-analysis pos)` | Root facts, plans, per-move motifs; cached by hash |
| `(symbolic-hints pos analysis)` | `move → bonus` table for root ordering |
| `(prolog-inspect pos "e4")` | Attackers/defenders of one square |

**Interface exposed to the frontend**: the JSON protocol in section 9. The
frontend has no other access to engine internals.

---

## 5. Prolog Design

**Fact schema.** A position arrives as one term and becomes one context:

```prolog
% from Lisp
pos(white, [p(white,king,e1), p(white,bishop,b5), p(black,knight,c6), p(black,king,e8), ...])

% built once per position (board.pl)
ctx(Side, Pieces, Assoc, Attacks)
%   Pieces  = [p(Color, Type, File/Rank), ...]
%   Assoc   = File/Rank -> Color-Type
%   Attacks = [a(Color, Type, From, To), ...]   every square each piece hits
```

"Attack" is pure geometry: a piece attacks a square whether it is empty, holds
an enemy (threat) or a friend (defence).

**Example facts** (output terms, one per finding):

```prolog
pin(absolute, white, bishop, 2/5, knight, 3/6, king, 5/8)
fork(white, knight, 3/7, [rook-1/8, king-5/8])
hanging(black, knight, 5/5, [rook-5/2])
weak_square(black, 4/5, 5/4)            % d5 is a hole; White's e4 pawn controls it
open_file(4)
```

**Example rules.**

```prolog
% tactics.pl — a slider looks through exactly one enemy piece at a more valuable one
pin(Ctx, pin(Kind, PC, PT, PSq, T, Sq, BT, BSq)) :-
    piece(Ctx, PC, PT, PSq),
    slider_dir(PT, Dir),
    ctx_assoc(Ctx, Assoc),
    first_on_ray(Assoc, PSq, Dir, Sq, C-T),
    opponent(PC, C),
    T \== king,
    first_on_ray(Assoc, Sq, Dir, BSq, C-BT),
    pin_kind(Ctx, C, PT, PSq, T, Sq, BT, BSq, Kind).

% one piece attacks two or more enemy pieces that each matter,
% and cannot simply be taken for free itself
fork(Ctx, fork(C, T, From, Targets)) :-
    piece(Ctx, C, T, From), T \== king,
    opponent(C, O),
    findall(TT-TSq,
            ( attack(Ctx, C, T, From, TSq), at(Ctx, TSq, O, TT),
              fork_target(Ctx, T, O, TT, TSq) ),
            Targets),
    Targets = [_, _|_],
    safe_piece(Ctx, C, T, From).
```

**Tactical motif rules** (`tactics.pl`): `check`, `pin` (absolute/relative),
`skewer`, `fork`, `hanging`, `threatened` (attacked by a cheaper piece),
`overloaded` (sole defender of two attacked pieces).

**Strategic motif rules** (`structure.pl`): `open_file`, `semi_open_file`,
`passed_pawn`, `isolated_pawn`, `doubled_pawns`, `weak_square` (a central
square on the owner's 3rd/4th rank that no owner pawn can ever attack and an
enemy pawn already controls), `king_shield` (castled king missing pawns).

**Per-move motifs** (`moves.pl`) compare the root context with the after-move
context Lisp supplied:

```prolog
% a NEW pin only: Bb5-a4 against a knight already pinned on c6 creates nothing
motif(Root, After, C, _, To, motif(creates_pin, Score, [Sq], pin(Kind, T, Sq, BT, BSq))) :-
    once(pin(After, pin(Kind, C, _, To, T, Sq, BT, BSq))),
    \+ pin(Root, pin(_, C, _, _, T, Sq, _, _)),
    ( Kind == absolute -> Score = 250 ; Score = 180 ).
```

| Motif | Hint score | Meaning |
|---|---|---|
| `gives_check` | +300 | |
| `captures_hanging` | +150 × value | takes an undefended piece |
| `wins_exchange` | +100 × difference | cheaper piece takes dearer one |
| `creates_fork` / `creates_skewer` / `creates_pin` | +400 / +250 / +180–250 | |
| `rescues` | +80 × value | moves an attacked piece to safety |
| `occupies_outpost`, `rook_to_open_file`, `pushes_passed_pawn` | +120, +50–80, +30… | positional |
| `hangs_piece` | −120 × loss | moved piece can be taken for less |
| `leaves_hanging` | −100 × value | a defender walked away |

**Candidate plan rules** (`plans.pl`). Each plan cites the fact ids it rests on:

```prolog
plan(_, S, Facts, plan(exploit_pin, Text, [Id], [ring(Sq, plan)])) :-
    member(Id-pin(_, S, _, _, T, Sq, BT, _), Facts),
    sq_name(Sq, Name),
    format(atom(Text),
           'Pile up on the pinned ~w on ~w: it cannot move without exposing the ~w.',
           [T, Name, BT]).
```

**Explanation facts and visualization facts** (`render.pl`). Every fact term
has one `describe/6` clause giving its sentence and its drawing primitives —
`arrow(From,To,Style)`, `ring(Sq,Style)`, `square(Sq,Style)`, `file(F,Style)`.
A fact that cannot be described cannot be emitted, so there is no fact without
text and no overlay without a fact. The JSON for the pin above:

```json
{"id":"f1","kind":"pin","side":"white","squares":["b5","c6","e8"],"use":"explanation",
 "text":"The black knight on c6 is pinned to its king on e8 by the bishop on b5 and cannot legally move off that line.",
 "viz":[{"type":"arrow","from":"b5","to":"e8","style":"pin"},
        {"type":"ring","square":"c6","style":"pin"}]}
```

`use` is an honesty label: `explanation` (shown and used for plans, no effect
on search) or `mirrors_eval` (explanation only, but the Lisp evaluator scores
the same concept independently — passed, isolated and doubled pawns).

---

## 6. Chess Knowledge Layer

**Encoded first (in the MVP).** Attack/defence relations; checks; absolute and
relative pins; skewers; forks with a safety test; undefended pieces; pieces
attacked by cheaper pieces; overloaded defenders; open and semi-open files;
passed, isolated and doubled pawns; outposts; missing pawn shield; twelve
per-move motifs; nine plan templates.

**Delayed, and why.**

| Concept | Reason to wait |
|---|---|
| Discovered attacks / discovered check | Needs "what does moving X uncover", i.e. a per-piece ray recomputation; cheap but easy to get subtly wrong |
| Trapped pieces, mating nets | Only true under lookahead; a static rule misleads often |
| Static exchange evaluation in Prolog | Belongs in Lisp (hot path); Prolog's "hanging" is a first-order approximation |
| Good/bad bishop, space, initiative | Hard to define crisply; low explanation value per rule |
| Opening principles / endgame tablebase knowledge | Phase-specific; add once phase detection is shared with Lisp |
| Symbolic terms in the numeric evaluation | See section 8: do not let Prolog change scores until a measured gain justifies it |

**Phase differences.** The numeric king table is tapered by remaining
material. Symbolic rules are phase-aware only where it prevents nonsense: open
files are not reported once no rook or queen (or no pawn) remains.

**Where symbolic logic helps.** In
`r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b`, the search sees only
a score; Prolog says *why* `...Nxe4??` style ideas fail — the c6 knight is
pinned to the king. In `r3k3/8/8/1N6/8/8/8/4K3 w`, `Nc7+` is tagged
`creates_fork` + `gives_check`, and the explanation can check that the
principal variation really captures on a8.

**Known failure cases (rules that can mislead).**

1. *Pinned defenders still count as defenders.* Attack geometry ignores pins,
   so a piece "defended" only by an absolutely pinned piece is not reported as
   hanging.
2. *"Hanging" is not "can be won".* Counting attackers and defenders is not an
   exchange evaluation; a defended piece attacked three times is not flagged.
3. *X-rays and batteries are invisible.* A rook behind a queen on a file does
   not count as an attacker.
4. *Forks ignore the reply.* A fork is reported even if the opponent can answer
   with a stronger threat; this is why fork motifs are marked `confirmed` only
   when the search line actually captures a target.
5. *Outposts are structural only.* A hole is reported whether or not anyone can
   reach it.

Each of these is why Prolog output is advice to the search and to the reader,
never an input to a score.

**Concepts worth visualizing.** For users: last move, check, legal moves, pins,
forks, skewers, undefended pieces, weak squares, best move. On demand: open
files, pawn structure, king safety, overloaded defenders. For debugging only:
raw attack/defence arrows on a clicked square, the event log, hint scores.

---

## 7. TypeScript/React Visualization Layer

**Stack.** Vite 8, React 19, TypeScript 7 (strict, `noUncheckedIndexedAccess`),
Vitest. No Next.js (nothing to route or server-render), no Redux (one reducer
suffices), no canvas, no chess library, no component framework.

**Structure.**

```text
web/src/
  protocol.ts        message types + runtime validator (parseServerMessage)
  state.ts           AppState + reducer (stale-message guard lives here)
  useEngine.ts       WebSocket lifecycle, reconnect with backoff
  selectViz.ts       pure: which engine-supplied primitives are visible now
  geometry.ts        square <-> SVG coordinates, arrow shapes, clock format
  components/
    Board.tsx        SVG board, pieces, click + drag input, promotion picker
    Overlays.tsx     renders Viz primitives; style name -> colour
    GamePanel.tsx    PlayerBar (name, clock, captures), MoveList, Controls, StatusBanner
    AnalysisPanel.tsx search stats, explanation, facts, plans, hints, inspect, debug
  App.tsx            layout and presentational state
```

**Component hierarchy.**

```text
App
├─ topbar: mode switch (Play / Analysis), connection status
├─ PlayerBar (top)  ─┐
├─ Board            ─┤ board column
│   └─ Overlays      │
├─ PlayerBar (bottom)┘
├─ StatusBanner, MoveList, Controls        side column
└─ AnalysisPanel                           analysis mode only
```

**Board rendering.** One `<svg viewBox="0 0 800 800">`. Squares are `<rect>`s;
pieces are solid Unicode chess glyphs as `<text>` with a contrasting stroke, so
there are no image assets. Input is handled once, at the SVG level, with
pointer events (mouse, touch and pen): click-click and drag-drop share one code
path, and every destination is checked against the engine's `legalMoves`.

**SVG overlay strategy.** `Overlays` is a `<g pointer-events="none">` between
the squares and the pieces. It receives a flat `Viz[]` and draws files, square
fills, rings, then arrows. Styles are names chosen by Prolog (`pin`, `threat`,
`weak`…); the frontend maps a style to a colour and nothing else.

**UI state model.** Two kinds of state, kept apart:

- *Engine-derived* (`state.ts`): game, search, symbolic analysis, explanation,
  inspection. Changed only by engine messages.
- *Presentational* (`App.tsx`, `Board.tsx`): board flip, selected square, drag
  position, promotion picker, which fact kinds are shown, hovered fact, debug
  toggle. The engine does not know or care about any of it.

There is no optimistic update: a move is drawn when the engine's `game_state`
arrives (a millisecond or two on localhost), so the board cannot disagree with
the engine even briefly.

**Engine event handling.** `parseServerMessage` validates shape (including
that every overlay names a real square) and drops anything malformed. The
reducer then drops duplicates (`seq`), analysis for a position that is not on
screen (`positionId`), and updates from superseded searches (`searchId`).

**Analysis / debug mode.** Analysis mode adds: score, depth, nodes, speed,
principal variation, evaluation breakdown; the explanation with source and
verification tags; facts grouped by kind with per-kind toggles and hover-to-
isolate; plans with their supporting fact ids; ordering hints; click-to-inspect.
A collapsed Debug card shows versions, `positionId`, Prolog latency, FEN and the
last forty engine events with stale drops marked.

**Accessibility and responsiveness.** Every square is a focusable
`role="gridcell"` with a spoken label ("e4, white pawn, legal destination");
Enter/Space selects and moves, Escape cancels. Facts and plans are focusable
and highlight on focus as well as hover. Colour is never the only signal in
the panels (text tags accompany every colour). The layout is a CSS grid that
drops from three columns to two to one; the board scales with the viewport.
Light and dark themes follow the system preference; motion respects
`prefers-reduced-motion`.

---

## 8. Lisp–Prolog–React Integration Plan

**Communication method.** Lisp ↔ Prolog: stdin/stdout pipes to a child
`swipl`, one request term per line, one JSON object per line. Lisp ↔ React:
WebSocket on `127.0.0.1:8765`, JSON text frames. The WebSocket server is
written directly on `sb-bsd-sockets` (handshake, framing, SHA-1, Base64: about
200 lines), so the engine has no library dependencies and no bridge process.

**Fact export format.**

```prolog
analyze(17, pos(white,[p(white,king,e1),p(white,rook,e2),p(black,king,e8),p(black,knight,e5)]),
            [m('e2e5', pos(black,[p(white,king,e1),p(white,rook,e5),p(black,king,e8)])), ...]).
```

Regenerated on every request; never incrementally updated.

**Query types.**

| Query | Reply |
|---|---|
| `version(Id)` | Prolog version (liveness check at start-up) |
| `analyze(Id, Pos, Moves)` | `facts`, `plans`, `moves` (per-move motifs and hint score) |
| `inspect(Id, Pos, Square)` | piece, white/black controllers, attacked squares, text, viz |

**Caching.** `symbolic-analysis` results are cached in Lisp by Zobrist key
(512 entries, cleared when full). A cache hit costs 0 ms; the UI re-requesting
the same position never reaches Prolog.

**Frequency of Prolog calls.** At most one `analyze` per position that actually
occurs in the game, plus one `inspect` per user click. **Zero calls inside the
search tree.** Measured cost: 20–125 ms per uncached position (mean 85 ms
including the one-off 250 ms process start).

**How results affect move ordering.** Per-move hint totals become a
`move → bonus` hash table consulted only when ordering root moves.

**How results affect evaluation.** They do not, by design, in this version.
The mapping that *would* be used is recorded so it can be tested later: a
symbolic fact may contribute a bounded term (for example +15 cp for an
occupied outpost) only at the root or at PV leaves, only after the benchmark
shows a move-quality gain, and the term must appear in `eval-breakdown` so the
UI shows it. Until then the numeric evaluation is pure Lisp and the facts
marked `mirrors_eval` say so.

**How results affect explanations.** `build-explanation` in `game.lisp`
assembles sentences from three sources and tags each with a status:

| Status | Meaning | Example source |
|---|---|---|
| `measured` | a number the search/evaluator produced | depth, score, PV, material swing along the PV, eval terms |
| `confirmed` | a Prolog motif the PV acts on | fork whose target is captured later in the PV; check verified by the engine |
| `unconfirmed` | a Prolog motif the PV does not act on | fork with no capture on a target square in the PV |
| `overruled` | Prolog advice the search went against | a `hangs_piece` warning on the chosen move; Prolog's top suggestion when it differs |
| `heuristic` | positional advice the search cannot verify | outpost, open file, ordering rank |

**How Lisp sends symbolic analysis to React.** The Prolog reply is forwarded as
a `symbolic_analysis` message tagged with `positionId`, with SAN added to each
move hint by Lisp (Prolog has no notation).

**How React requests analysis data.** It mostly does not need to: analysis for
the current position is pushed automatically. Explicit requests are
`request_analysis` (run a search without moving) and `inspect_square`.

**How React shows a line it cannot play out itself.** `request_line` names a
search by `searchId`; if that is still the engine's newest explained search,
Lisp replies with `line_replay`: the starting position and the position after
each move of the expected line (at most eight), each with its board, check
square and Prolog's facts. React draws those boards; it never makes a move to
get them. A step is shown with an empty legal-move list and a negative
`positionId`, so it can be neither played on nor mistaken for a game position,
and the reducer drops a line whose `searchId` is not the explanation on screen.

**How a pasted game gets in.** `load_pgn` carries the text as typed. Lisp
(`engine/src/pgn.lisp`) reads it: a move in standard notation is treated as a
description (piece, destination, hints) and matched against the legal moves the
generator produces; no match, or two, and the move is refused. The reply is
`game_loaded` with the engine's own notation for the moves it accepted and, if
reading stopped early, which half-move stopped it. The game becomes the
session's game. A background thread then sends one `review_step` per position
(board, score from a short search, evaluation terms, Prolog's facts) and a
`review_complete`. All carry a `gameId`; the reducer drops any that are not for
the game it holds, and `review_closed` tells it when the engine has let go. A
browsed position is shown exactly like a replayed line step: no legal moves, a
negative id.

**How "why not this move?" is answered.** `explain_move {uci, positionId}`
starts a worker that searches the position for its best move, then searches
the asked move to the same depth (`search-line`), under the search lock. Lisp
then asks Prolog for the two resulting positions and compares facts by their
`key`: an identity Prolog gives each fact from its kind and subject, the same
wherever the fact holds (the per-position ids `f1`, `f2` are not). The reply,
`counterfactual`, is tagged with `positionId` and `searchId`; the reducer drops
it if the board has moved on, and the line behind it can be replayed with
`request_line` like any other. Ratings come from fixed bands on the score
difference, owned by the engine. Each sentence carries a `basis`: the rule
that decided its status, in words.

A game review uses the same comparison per move (`review_step.change`): the
search's own choice in the position before, the game move searched to the same
depth, the change in each evaluation term, and the fact delta.

**The second front door.** `engine/uci.lisp` runs `uci-loop`, which speaks the
Universal Chess Interface on standard input and output. It shares the board,
the move generator and the search with the WebSocket server and nothing else:
no sessions, no clocks, no Prolog.

**How visualization elements map to Prolog facts.** One-to-one and by
construction: a `Viz` object reaches the board only as a member of some fact's,
plan's or inspection's `viz` array. The single exception is the best-move
arrow, which `selectViz` builds from the search's own `bestMove` and styles
`pv`. A unit test asserts that every drawn primitive is identical (object
identity) to one a fact supplied.

---

## 9. Frontend Protocol Schema

Common fields: every engine message has `type` and `seq`; state-bearing ones
have `positionId`; search messages have `searchId`. Every client command may
carry an `id`, echoed as `inReplyTo` in an `error`.

### Engine → frontend

```jsonc
{"type":"hello","seq":1,"protocol":1,"engine":"symchess 0.1.0",
 "lisp":"SBCL 2.6.9","prolog":"SWI-Prolog 10.0.2"}

// Complete snapshot. Sent after every change and on every (re)connect.
{"type":"game_state","seq":12,"positionId":3,
 "fen":"rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq e3 0 1",
 "board":{"a1":"wR","b1":"wN","e4":"wP","e8":"bK"},
 "turn":"black","moveNumber":1,"check":null,
 "lastMove":{"from":"e2","to":"e4"},
 "history":[{"ply":1,"san":"e4","uci":"e2e4","by":"human"}],
 "legalMoves":[{"uci":"g8f6","san":"Nf6","from":"g8","to":"f6","promotion":null,"capture":false}],
 "status":"active","winner":null,
 "clocks":{"enabled":true,"whiteMs":298400,"blackMs":300000,"incrementMs":0,"running":"black"},
 "settings":{"mode":"play","humanColor":"white","depth":6,"moveTimeMs":3000},
 "captured":{"white":[],"black":[]},
 "engineThinking":true}

{"type":"move_played","seq":11,"positionId":3,
 "move":{"san":"e4","uci":"e2e4","from":"e2","to":"e4","by":"human","ply":1}}

{"type":"search_started","seq":14,"positionId":3,"searchId":2,"purpose":"play",
 "maxDepth":6,"timeLimitMs":3000,"symbolicHints":true}

{"type":"search_update","seq":17,"positionId":3,"searchId":2,"depth":3,
 "score":{"cp":-20,"mate":null},"nodes":1432,"timeMs":4,"nps":358000,
 "bestMove":{"uci":"b8c6","san":"Nc6","from":"b8","to":"c6","promotion":null,"capture":false},
 "pv":["Nc6","Nc3","Nf6"],"pvUci":["b8c6","b1c3","g8f6"]}

{"type":"search_complete","seq":20,"positionId":3,"searchId":2,"purpose":"play",
 "evalBreakdown":{"material":0,"placement":40,"pawnStructure":0,"bishopPair":0,"total":40},
 "depth":5,"score":{"cp":0,"mate":null},"nodes":15552,"timeMs":98,"nps":158693,
 "bestMove":{"uci":"b8c6","san":"Nc6","from":"b8","to":"c6","promotion":null,"capture":false},
 "pv":["Nc6","Nc3","Nf6","Nf3","d5"],"pvUci":["b8c6","b1c3","g8f6","g1f3","d7d5"]}

{"type":"symbolic_analysis","seq":13,"positionId":3,"status":"ok","elapsedMs":41,
 "facts":[ /* section 5 */ ],
 "plans":[{"id":"p1","kind":"exploit_pin","because":["f1"],
           "text":"Pile up on the pinned knight on c6: it cannot move without exposing the king.",
           "viz":[{"type":"ring","square":"c6","style":"plan"}]}],
 "moveHints":[{"uci":"b5c6","san":"Bxc6+","score":300,
               "motifs":[{"kind":"gives_check","score":300,"targets":["e8"],"text":"Gives check."}]}]}

{"type":"explanation","seq":21,"positionId":3,"searchId":2,
 "move":{"uci":"b8c6","san":"Nc6","from":"b8","to":"c6","promotion":null,"capture":false},
 "summary":"Black plays Nc6 (+0.00).",
 "items":[
  {"source":"search","status":"measured","squares":[],
   "text":"Searched 5 plies deep (15,552 positions, 0.1 s). Nc6 scores +0.00 (White's view)."},
  {"source":"search","status":"measured","squares":[],
   "text":"Expected continuation: Nc6 Nc3 Nf6 Nf3 d5."},
  {"source":"eval","status":"measured","squares":[],
   "text":"Static evaluation before the move, White's view: material +0, piece placement +40, pawn structure +0, bishop pair +0 (centipawns)."},
  {"source":"prolog","status":"heuristic","squares":[],
   "text":"Prolog found no tactical or positional motif for Nc6, so this choice rests on the search alone."}]}

{"type":"inspection","seq":30,"positionId":4,"square":"e4",
 "piece":{"color":"white","type":"pawn"},"white":[],"black":[],"attacks":["d5","f5"],
 "lines":["white pawn on e4.","Attacked by (0): none.","Defended by (0): none.","It controls: d5 f5."],
 "viz":[{"type":"ring","square":"e4","style":"inspect"}]}

{"type":"error","seq":9,"code":"stale_position",
 "message":"Command was for position 1 but the game is at 2.","inReplyTo":3}
```

Error codes: `bad_request`, `unknown_command`, `bad_fen`, `illegal_move`,
`stale_position`, `not_your_turn`, `game_over`, `engine_busy`,
`nothing_to_undo`, `symbolic_unavailable`, `worker_failed`, `internal_error`.

### Frontend → engine

```jsonc
{"type":"new_game","id":1,"humanColor":"white","mode":"play"}          // optional "fen"
{"type":"make_move","id":2,"uci":"e2e4","positionId":2}
{"type":"undo_move","id":3}
{"type":"request_analysis","id":4,"positionId":4}
{"type":"stop_search","id":5}
{"type":"set_engine_depth","id":6,"depth":6,"moveTimeMs":3000}
{"type":"set_time_control","id":7,"baseMs":300000,"incrementMs":2000}   // baseMs null = no clock
{"type":"set_mode","id":8,"mode":"analysis"}
{"type":"inspect_square","id":9,"square":"e4","positionId":4}
{"type":"resign","id":10}
{"type":"sync","id":11}                                                 // resend the snapshot
```

### Two deliberate departures from the brief

- **`legal_moves` is folded into `game_state`.** A separate message would allow
  the client to hold a board from one position and a move list from another.
  One atomic snapshot makes that state unrepresentable.
- **`flip_board` and `inspect_piece` are not messages.** Flipping is pure
  presentation and stays in the browser. Inspecting a piece *is* inspecting its
  square, so one `inspect_square` covers both.

### Reconnection and replay

On connect the engine creates a fresh game for that connection and sends
`hello`, then `game_state`, then analysis for the position. (A game does not
survive its connection; reconnecting starts a new one.) The client resets its reducer on every socket open,
so nothing from the old connection survives. Every inbound command and
outbound event is appended to `logs/session-<timestamp>.jsonl` with its `seq`
and a millisecond timestamp. Hashing uses a fixed seed and a depth-limited
search is deterministic (tested), so the log is designed to be replayable:
feeding the inbound lines to a fresh engine should reproduce the outbound
stream whenever no search was cut short by its time limit. **A replay tool is
not written yet**, so this property is designed-for, not verified; searches
that hit the time limit are inherently not reproducible.

---

## 10. Visualization Concepts

| Concept | Source of truth | Display | Mode |
|---|---|---|---|
| Legal moves | `game_state.legalMoves` | dot on empty targets, ring on captures, for the selected piece | play + analysis |
| Last move | `game_state.lastMove` | yellow tint on both squares | play + analysis |
| Check | `game_state.check` | red disc under the king | play + analysis |
| Pins | fact `pin` | purple arrow pinner → piece behind, ring on the pinned piece | analysis, on by default |
| Forks | fact `fork` | orange ring on the forker, arrows to each target | analysis, on by default |
| Skewers | fact `skewer` | magenta arrow through both pieces, ring on the front one | analysis, on by default |
| Attacked, undefended pieces | fact `hanging` | red ring, red arrows from attackers | analysis, on by default |
| Attacked by cheaper piece | fact `threatened` | red ring + arrow | analysis, on by default |
| Weak squares | fact `weak_square` | yellow square fill, teal arrow from the supporting pawn | analysis, on by default |
| Overloaded defenders | fact `overloaded` | amber ring, green arrows to the pieces it guards | analysis, off by default |
| Open / semi-open files | facts `open_file`, `semi_open_file` | blue tint down the file | analysis, off by default |
| Pawn structure | `passed_pawn`, `isolated_pawn`, `doubled_pawns` | green / orange square fills | analysis, off by default |
| King safety | fact `king_shield` | red ring on the king | analysis, off by default |
| Defended / attacked square | `inspection` | green arrows from defenders, red from attackers | analysis, on click (**debugging aid**) |
| Candidate plans | `plans` | dashed blue ring/arrow, plus the cited facts, on hover | analysis |
| Principal variation | `search_*` `pv` | SAN text; first move as a blue arrow | analysis |
| Numeric evaluation | `search_*` `score` | large signed number, White's view | analysis |
| Evaluation terms | `search_complete.evalBreakdown` | four-row table + total | analysis |
| Symbolic "terms" | `moveHints` | per-move hint score with its motifs; labelled *ordering only* | analysis (**debugging aid**) |

**Play mode** is deliberately ordinary: large board, player bars with names,
clocks and captured pieces, move list, drag or click to move, promotion picker,
flip, take back, resign, new game with colour and clock choice. No reasoning
overlays appear in play mode; a single line under the move list reports the
engine's last move and points to Analysis for the reasons.

**Analysis mode** is the distinctive part: the reasoning column, the overlay
layer, click-to-inspect, and explanation sentences that are each traceable to
the search or to a named Prolog rule.

---

## 11. Verification Loop

| Area | What exists | Where |
|---|---|---|
| Lisp move generation | perft at depths 1–4 in five standard positions against published counts | `engine/tests/run-tests.lisp` |
| Make/unmake, hashing | incremental hash = recomputed hash at every node to depth 3; position restored after perft | same |
| Notation, rules | SAN disambiguation, castling, en passant, promotion, mate suffix; stalemate, insufficient material, repetition | same |
| Search | mate in 1 and 2, wins hanging queen, finds knight fork, avoids stalemate; determinism; caller's position untouched; stop honoured; PV is a legal line | same |
| Evaluation | colour symmetry; breakdown total = `evaluate` | same |
| WebSocket primitives | RFC 6455 sample accept key; SHA-1 of empty input; JSON round trip | same |
| Prolog rules | 37 tests: each rule fires on a fixture and stays silent on a near-miss | `knowledge/tests/test_knowledge.pl` |
| Integration | scripted session over the real WebSocket: rejections, human move → engine reply, analysis mode, inspect, FEN set-up, undo, clock and flag-fall | `web/scripts/e2e.mjs` |
| Explanation faithfulness | e2e asserts the explained move is the searched move is the played move; each sentence carries source + status | `e2e.mjs`, `game.lisp` |
| Protocol schema | runtime validator unit tests; **contract test** validating messages captured from the real engine and requiring every message type to be covered | `web/src/protocol.test.ts` |
| Stale-state handling | reducer tests: stale symbolic analysis dropped, analysis cleared on position change, superseded search ignored, reconnect resets | `web/src/state.test.ts` |
| Visual overlay faithfulness | `selectViz` tests: nothing in play mode; only enabled kinds; drawn primitives are the objects facts supplied; best-move arrow only for the current position | same |
| Performance and feature value | perft speed, search speed, Prolog latency, plain vs hinted search per position | `engine/tests/bench.lisp` |

**Current measurements** (`bench.lisp`, depth 6, seven positions):

| Metric | Result |
|---|---|
| perft(5) from the start position | 4,865,609 leaves, about 2.4 M leaves/s |
| Search speed | about 0.5 M nodes/s |
| Prolog root analysis, uncached | 22–123 ms (first call 292 ms including process start); cached 0 ms |
| Nodes, plain vs Prolog root hints | 999,808 vs 1,000,685 (**+0.1%**) |
| Best move changed by hints | 0 of 7 positions |
| Score changed by hints | 0 of 7 (must always be 0) |

**Not yet covered by automated tests** (stated so the gaps are visible):
rendering of React components (tests cover the reducer, the validator, overlay
selection, move-input decisions and geometry, not the DOM); the pointer and
keyboard event wiring in `Board.tsx` and the promotion picker (their decision
logic is unit-tested in `moveInput.ts`, and both were exercised by hand in a
browser, but a DOM test harness was judged not worth its weight yet); Prolog
dying mid-game (Prolog failing to start *is* tested); log replay; any measure
of playing strength beyond the handful of tactical positions.

**The iterative loop, applied once already.**

- A. Smallest slice: legal moves + search + one Prolog fact + one overlay.
- B. Correctness: perft, rule tests.
- C. Added one symbolic feature: per-move motifs as root ordering hints.
- D. Speed impact: +85 ms once per move, outside the search.
- E. Move quality: unchanged in all seven positions; tree size unchanged.
- F. Explanation faithfulness: found that `Ba4` was tagged `creates_pin` while
  merely keeping an existing pin. Rule revised to require a *new* pin; two
  regression tests added.
- G. Visualization faithfulness: open files were reported on all eight files
  of a pawnless board. Rule revised (needs at least one pawn and one heavy
  piece).
- H. Decision: **keep** root hints (free, score-neutral, and they feed the
  explanation), but label them "ordering only" in the UI and record that they
  do not yet improve search. Next experiment: apply hints at PV nodes of the
  previous iteration, where the hash move is weakest.
- I. Repeat with the next feature.

---

## 12. Minimum Viable Prototype

Built in this repository:

| Required | Status |
|---|---|
| Legal move generation | done; perft-verified |
| Alpha-beta search | done; iterative deepening PVS + quiescence + TT |
| Basic evaluation | done; material, piece-square, pawns, bishop pair |
| Prolog facts for attacks/defences/pins/forks | done, plus skewers, hanging, threatened, overloaded, structure |
| Root-level Prolog analysis | done; once per position, cached |
| Prolog-informed move ordering | done at the root; measured: no search benefit yet |
| Explanation for the selected move | done; source and verification status per sentence |
| Vite + React + TypeScript frontend | done |
| Interactive chessboard | done; click, drag, keyboard, promotion, flip |
| Move history | done |
| Engine best move display | done; PV text and arrow |
| SVG overlays for pins, attacks, weak squares | done, driven only by Prolog facts |
| Symbolic reasoning panel | done; facts, plans, hints, inspect |

Not in the MVP: opening book, pondering, multi-PV, endgame tablebases, PGN
import/export, navigating back through the move list, symbolic terms in the
evaluation. (Several simultaneous visitors, each with a private game, were
added afterwards for hosting: see section 15.)

---

## 13. Risks and Mitigations

| Risk | Mitigation in place | Residual |
|---|---|---|
| **Lisp engine performance** — mailbox + legality-by-make is slow by modern standards | Adequate for depth 6–8 in seconds; representation isolated in two files; bench script tracks nodes/s | Bitboards and a proper SEE are future work |
| **Prolog inference cost** — rules are joins over lists | Attack list built once per context; no backtracking into search; 3 s time limit per request | Cost grows with rule count; `bench.lisp` reports ms per position |
| **Lisp–Prolog integration** — child process hangs, crashes or answers late | Request id checked on every reply; timeout kills and restarts the child; engine continues search-only and says so | First request after a restart pays process start-up |
| **Prolog quietly becoming a second engine** | Prolog receives after-move positions from Lisp and has no move generator; rule tests take FEN, production never does | A future rule author could add one; code review rule: no `legal_move/…` in `knowledge/` |
| **Engine–frontend protocol drift** | Runtime validator; contract test against captured real messages; protocol version in `hello` | Validator is hand-written, not generated from a schema |
| **Stale frontend state** | `positionId` on all state; client drops stale analysis; server rejects stale commands and resends the snapshot; no optimistic updates; reducer reset on reconnect | Clock display is interpolated locally between snapshots (display only; the engine decides flag-fall) |
| **Misleading visualizations** | Overlays exist only as members of a fact's `viz`; play mode draws none; validator rejects overlays on non-existent squares | Rule limitations in section 6 (pinned defenders, x-rays) can still produce a technically true but unhelpful fact |
| **Explanation faithfulness** | Every sentence tagged source + status; motif claims checked against the PV; disagreements between Prolog and search are reported, not hidden | "Confirmed" means "the PV captures a target", not a proof |
| **Frontend complexity** | One reducer, pure `selectViz`, no state library, no chess logic, about 2,000 lines of TypeScript | The analysis panel will need splitting as features are added |
| **Local server exposure** | By default binds to 127.0.0.1 only and the WebSocket handshake rejects non-local `Origin` | Any local process can connect; acceptable for a single-user tool. Hosted mode deliberately relaxes both (section 15) |
| **Concurrency** | One search at a time across all sessions (`*search-lock*`); search runs on a copy; results applied under that session's lock only if `positionId` still matches | The TT is unlocked, which is safe only because of that global lock; searches from different visitors queue |
| **Overload when hosted** | Seat limit, idle timeout, depth and time ceilings, connection ceiling, 64 KB message limit, handshake timeout (section 15) | No per-visitor rate limit on commands; a seated visitor can still keep the single search slot busy |

---

## 14. Final Recommendation

**The architecture is sound** for its stated goal. The three-layer rule held up
under implementation: the engine plays correctly with Prolog switched off, the
frontend has no chess logic to get wrong, and each explanation sentence can be
traced to a search number or a named rule.

**Build first** (done): move generation proven by perft; a search that finds
simple tactics; the Prolog context and a handful of high-precision rules; the
protocol with `positionId` discipline; the board and one overlay type. Each of
those is useful alone and each has tests.

**Build next**, in this order: (1) discovered attacks and a Lisp static
exchange evaluation, so "hanging" stops being a first-order guess; (2) move-list
navigation in the UI, reusing `positionId`; (3) the PV-node hint experiment
from section 11; (4) only if that shows a gain, one bounded symbolic evaluation
term, visible in the breakdown.

**Avoid early:** calling Prolog inside the search; letting symbolic facts
change scores before a benchmark justifies it; bitboards; an opening book;
adding rules faster than "must stay silent" tests for them; any frontend
convenience that requires the UI to know a chess rule.

---

## 15. Hosted Mode (added after the MVP)

The MVP assumed one user on their own machine. To let a few non-technical
testers play from a link, the engine gained a hosted configuration. The
three-layer rule is unchanged; what changed is how many games exist and who
may connect.

**One container, one port.** The Lisp process answers plain HTTP GETs from an
in-memory copy of the built frontend and upgrades `/ws` (any path, in fact) to
a WebSocket. Files are looked up by exact key in a table filled at start-up,
so a request path never reaches the file system. There is no separate web
server and no cross-origin request: the page and the socket share an origin.

**Sessions.** Every WebSocket connection owns a private `game`. `*game*` is
bound per thread to the session that thread serves; each game has its own
lock, its own `seq` counter and its own client. Nothing is shared between
visitors except the search slot, the Prolog child process and its cache.

**Capacity, so a small free machine degrades politely instead of falling over.**

| Guard | Default when hosted | Behaviour at the limit |
|---|---|---|
| Seats (`SYMCHESS_MAX_SESSIONS`) | 8 | The next visitor gets `error` `server_full` and close code 1013; the page shows "every seat is taken" and retries every 10 s |
| Idle timeout (`SYMCHESS_IDLE_SECONDS`) | 900 | `error` `idle_timeout`, then disconnect; the page does **not** auto-reconnect, so an abandoned tab cannot hold a seat |
| Search depth / time ceilings | 7 plies / 3 s | Requests above the ceiling are clamped; `game_state` reports the real value and the UI only offers allowed presets |
| One search at a time | always | Other visitors' searches queue; the time limit starts when a search begins |
| Open sockets | 64 + 4 × seats | Further connections are closed on accept |
| Handshake timeout | 15 s | Sockets that never finish a request are shut down |
| Message size | 64 KB | Oversized frames end the session |

**Origin policy.** Locally the default stays "local pages only", which
protects a developer's machine from being driven by a web page they happen to
visit. Hosted, `SYMCHESS_ALLOWED_ORIGINS=*` accepts any origin: visitors are
anonymous, there are no cookies or credentials, and each connection can only
ever affect its own game, so cross-site connections have nothing to steal.
The seat limit bounds what they can consume.

**Honest limits of this design.** A waiting search is charged against the
engine's own clock in a timed game. With eight seats and up to 3 s per move,
a visitor can in the worst case wait about 20 s for the engine to start
thinking. There is no account system, so "a certain number of people" means
a number of simultaneous connections, not a list of named people: anyone with
the link can take a free seat. Games are not saved across a disconnect.

Verified by `web/scripts/sessions.mjs`, which starts an engine with two seats
and a three-second idle limit and checks private games, the seat limit,
freed seats, the idle timeout, clamping, and static file serving.

---

## 16. Workbench Redesign and Credibility Fixes (second pass)

Sections 7 and 10 describe the first UI. This pass replaced its look and
tightened three things; the data flow and the three-layer rule are unchanged.

### Fixes

- **`stop_search` was inverted.** It only acted when no engine move was being
  searched, so it could not stop the search that mattered. It now sets the
  worker's flag to `:finish`, distinct from cancel (`t`): the search stops at
  its next node check and its best result so far is **kept**. An analysis
  search reports that result (`search_complete` carries `stopped: true`); a
  search for the engine's own move plays it, so stopping can never leave the
  game waiting for a move. With nothing running it is a no-op. Covered by the
  end-to-end script: stops within a second, still explains the move, does not
  move a piece in analysis, makes the engine move at once on its own turn, and
  the engine answers commands afterwards.
- **`Board.tsx` reset state during render.** Selection, drag and promotion
  state are now cleared in an effect keyed on `positionId`.
- **A verdict leak found while building the inspector.** A first version tied
  a fact to a search verdict by shared squares, which labelled a pin
  "confirmed" because an unrelated "Gives check" sentence named the same king
  square. Explanation items now carry the `motif` they report on, and a
  verdict is carried to a fact only where the two are provably the same
  subject (an undefended piece and the move that captures it). Everything else
  reads "static fact · not assessed by search".
- **Prolog-unavailable path is now tested** in the Lisp suite: analysis is
  `NIL`, no hints are invented, the search still returns a legal move, and the
  explanation says it is search-only.

### Visual identity: Glass Slate (third pass, built to the owner's mockup)

The first redesign was rejected on review: flat outlined pieces, thick arrows
and circles, a plain list for reasoning. It was rebuilt against a reference
mockup, checking full-size captures against it after each change.

| Element | Treatment |
|---|---|
| Palette | Blue-black background with a soft vignette, graphite panels, slate board; CSS variables throughout |
| Type | Libre Baskerville, bundled with the app (`@fontsource`), so no font CDN is contacted |
| Left panel | Wordmark, Play / Analysis switch, **Analysis layers** (icon tile, label, count, toggle switch) and **Display** switches (coordinates, move hints, attack arrows, subtle arrows) |
| Board | Lit blue frame that pulses slowly while a search runs; coordinates outside the squares; a faint diagonal sheen on every square |
| Pieces | Original Staunton-style SVG shapes (`Pieces.tsx`) painted in three passes from one outline: ivory or obsidian body, a shade gathered to the right, and a frost bloom from the upper left. No glyphs, no image files. `/#pieces` shows the set large for inspection (development only) |
| Reasoning panel | Tabs (Reasoning, Plan, Variations, Facts); one card per fact or plan with icon, id, kind, source and status badges, sentence, and a **thumbnail** cropped to the squares the item names; a detail card pinned to the foot of the list |
| Bottom | Search Trace: play / stop button and one card per completed depth (score, nodes, ms). Search Status: depth of limit, nodes, speed, Prolog ms |

### Overlay language

Overlays are lines and frames of light (an SVG glow per primitive).

| Meaning | Style names (chosen by Prolog/search) | Drawn as |
|---|---|---|
| Best line | `pv` | blue arrow, with a blue frame on the square it starts from |
| Pins, skewers | `pin`, `skewer` | violet beam through the line, violet frame on the pinned piece |
| Threats | `threat`, `check`, `fork`, `hanging` | thin red-orange arrow, red frame |
| Defences | `defend`, `support` | thin teal arrow |
| Weak squares | `weak`, `weak_pawn` | amber frame with a light fill |
| Plans | `plan` | dashed blue frame or arrow |

### Layers and display switches

Seven layer toggles select which **supplied** evidence is on the board: Best
line, Pins, Threats, Defenses, Weak squares, Plans, Files & pawns. Each shows
how many items the engine actually sent. Display switches only ever remove
things: "Attack arrows" governs the attacker/defender arrows of a clicked
square, "Subtle arrows" the secondary arrows a fact carries (supporting pawn,
defenders, plan routes). A unit test asserts they never add a primitive.

### Glass inspector

Hovering or selecting a card isolates it: standing overlays drop to low
opacity, a mask dims the board with holes cut at exactly the squares the item
names, and the item's own primitives are redrawn on top, brighter. If an item
supplied no primitives the board is not dimmed and the card says so.

### What the mockup shows that was deliberately not built

- **"Confidence: High".** The engine produces no confidence value, so the
  detail card has Source, Used in and Status only.
- **"confirmed" on every fact.** Status is whatever the search actually said:
  most root facts read `static` (a fact about the position, not assessed by
  search); plans read `heuristic`; `confirmed` appears only where the search
  line acts on that very fact.
- **Settings and filter icons** in the panel header: there is nothing for them
  to open yet, and a control that does nothing is worse than none.

### Deep links

`?fen=<FEN>&layers=all&analyse=1&select=f2` loads a position in analysis mode,
switches layers on, starts a search and opens the inspector on an item. It
only sends commands the UI could send by hand, and it is how the full-size
verification captures are taken (headless Chrome, 1672 x 941).

Further parameters: `&move=e2e4` plays one move, `&replay=1` (with
`analyse=1`) opens the line replay, `&pieces=classic|figures|3d` and
`&motion=expressive|minimal` choose the presentation, `?tour=1` starts the
guided tour and `?results=1` opens the measured results. The guided tour is the
same mechanism: each step is a script of ordinary commands (`web/src/demo.ts`).

### Protocol additions (all optional, backward compatible)

`fact.label` (the subject in a few words), `explanation.items[].motif`,
`search_complete.stopped`, and a FEN field in the UI that uses the existing
`new_game { fen }` command.

---

## Appendix — Internal Critique Loop

### Round 1: strongest and weakest part, per role

| Role | Strongest | Weakest |
|---|---|---|
| Lisp Engine Architect | Search on a copy + `positionId` check makes threading boring | Quiescence ignores checks; no SEE |
| Prolog Knowledge Architect | Immutable context: rules are pure and testable | List-based attack joins will not scale to hundreds of rules |
| Chess Logic Expert | Every rule has a silence test | Pinned pieces still count as defenders |
| Integration Engineer | Prolog has no move generator; failures degrade to search-only | Root-only hints barely touch the search |
| Visualization Architect | Overlays are data, not code | Unicode glyph pieces depend on the system font |
| Protocol Engineer | Atomic `game_state`; stale commands rejected server-side | Validator is hand-maintained alongside the types |
| Systems Reviewer | No second source of chess truth anywhere | Unlocked TT relies on a one-search invariant enforced only by convention and a `join` |

### Round 2: likely failure modes

*Integration Engineer.* (1) A slow Prolog reply delays the first
`search_update`; (2) a reply from a timed-out request is read as the answer to
the next one; (3) the cache serves analysis for a position that differs only in
castling rights or en passant.

*Protocol Engineer.* (4) The user moves while analysis for the previous
position is in flight and the overlay appears on the new board; (5) two rapid
commands race a search result; (6) a reconnecting client keeps old arrows;
(7) a browser page on another origin drives the local engine.

*Systems Reviewer.* (8) An explanation claims a fork "wins material" when the
search never takes it; (9) a motif fires for something that was already true
before the move; (10) a structural fact is technically true and useless
(eight open files); (11) a worker thread crashes and the UI waits forever on
"thinking…".

### Round 3: revisions made

| # | Revision |
|---|---|
| 1 | Prolog runs before the search in the worker thread, never under the state lock; cached per position; 4 s hard timeout |
| 2 | Request ids on every reply; mismatch or timeout kills the child process, so a late line can never be read |
| 3 | Cache key is the full Zobrist hash (side, castling and en passant included) |
| 4, 6 | `positionId` on all analysis; reducer drops mismatches and clears analysis on any position change; full reset on socket open |
| 5 | All commands run under one state lock; workers re-check `positionId` under that lock before applying anything |
| 7 | Listener bound to loopback; handshake rejects non-local `Origin` |
| 8 | Verification status on every explanation item; fork/pin/skewer claims confirmed only if the PV captures a target |
| 9 | `creates_pin` / `creates_skewer` require the motif to be absent in the root position |
| 10 | Open files require a pawn and a heavy piece on the board; one open-file plan at most |
| 11 | Worker errors are caught, clear `engineThinking`, and are broadcast as `worker_failed` |

### Round 4: build order and milestones

| Milestone | Deliverable | Exit test | State |
|---|---|---|---|
| M1 | Board, move generation, FEN, SAN | perft suite passes | done |
| M2 | Evaluation + search | tactical checks pass; search deterministic | done |
| M3 | Prolog context, tactics, structure | rule tests pass | done |
| M4 | Bridge, cache, failure policy | analysis round trip under 150 ms; search still returns a move with Prolog unavailable (checked by hand, not yet an automated test) | done |
| M5 | Protocol + WebSocket server + event log | scripted game over the socket | done |
| M6 | React board and play mode | moves by click and by drag verified in the browser against the live engine; keyboard path implemented but not yet manually exercised | done |
| M7 | Analysis mode: overlays, panels, inspect | overlay faithfulness tests | done |
| M8 | Explanation with verification statuses | e2e: explained move = played move | done |
| M9 | Benchmark and first keep/revise/remove decision | section 11 table | done |
| M10 | Discovered attacks, SEE in Lisp | "hanging" false-positive rate drops on a puzzle set | next |
| M11 | PV-node hints experiment | node count falls by a meaningful margin at equal depth, or the feature is cut | next |
| M12 | Move-list navigation, PGN | — | later |
