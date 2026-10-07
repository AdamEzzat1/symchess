# SymChess workbench plan: milestones 6 to 9

From "a Lisp chess engine with Prolog explanations" to "a workbench where symbolic reasoning, evaluation and search can be inspected, compared, contradicted and measured".

This plan follows `NEXT_STAGE.md` (milestones 1 to 5, all built). It was written after reading the repository as it stands, and is a plan only: nothing in it is built yet.

The rule that does not move: **Lisp owns truth and search. Prolog owns symbolic meaning. React owns visualization and interaction.** No machine learning, no generated prose. Every sentence the program prints is assembled from numbers the search produced or facts a named rule derived.

## 1. Where the ten proposed features stand today

| # | Feature | State now | Left to do |
| --- | --- | --- | --- |
| 1 | "Why not this move?" | Not built. The engine can already search a chosen move (`search-line`) and replay a line with Prolog's facts per position | Milestone 7 |
| 2 | Provenance graph | Not built. Facts and plans have stable ids within a position; plans cite facts. Explanation sentences do not say which rule or check produced their status | Milestone 8 |
| 3 | SEE and discovered attacks | **Done** (milestones 1, 3, 5). SEE has 17 tests including board-unchanged. Discovered attack has positive and negative tests | Use SEE in two labels (see 4) |
| 4 | Symbolic and search disagreement | Partly. Sentences are already tagged confirmed, unconfirmed, overruled or heuristic, and "Prolog's top suggestion was X; the search preferred Y" is reported. It is not gathered in one place or counted | Milestone 8 |
| 5 | "Why did the evaluation change?" | Not built. The six-term evaluation breakdown exists for one position | Milestone 7, since it is the same before-and-after machinery |
| 6 | PGN import and game analysis | Not built. No SAN parser, but SAN can be read by matching against the engine's own SAN for each legal move, which needs no new chess logic | Milestone 6 |
| 7 | Puzzle benchmark | **Done in small** (milestone 5): 50 labelled positions in ten groups | Grow it in milestone 9 |
| 8 | Explanation precision and recall | **Done** (milestone 5) | Extend to each new kind of claim as it is added |
| 9 | Search experiment framework | Partly. `selfplay.lisp` and `bench.lisp` compare named configurations, with feature switches. Results are printed, not recorded | Milestone 9 |
| 10 | UCI | Not built. `parse-uci-move`, FEN reading and the search entry point are all there | Milestone 6 |

## 2. What each role argued

**Common Lisp engine architect.** The engine is in good order and should not be reorganised. Three additions belong in Lisp and nowhere else: reading SAN and PGN, the UCI loop, and the before-and-after comparison of two positions. UCI must be a second front door beside the WebSocket server, sharing the search and nothing else, so neither can break the other. One caution: several features want "search this move, then that one"; they must take the search lock in turn and respect the same time ceilings as everything else, or the free host will stall.

**Prolog symbolic reasoning architect.** Prolog needs one new capability, and it is a small one: given two analyses, say which facts appeared, which disappeared and which persisted. That needs facts to be comparable across positions, which their per-position ids (`f1`, `f2`) are not. A fact needs a second, stable identity made of its kind and its pieces. No new motif rules in this plan; milestone 5 showed that the existing ones needed correcting more than they needed company.

**Chess strength and analysis expert.** The most valuable thing for a chess-literate viewer is the counterfactual, done honestly: the refutation must be the line the search actually found, with the material count from that line, not a tidy story. The riskiest thing is the evaluation-change explanation: at depth 6, a swing of a third of a pawn is often noise. It should only speak when the swing is large, and should say "the search changed its mind at depth N" when that is the real reason.

**Lisp and Prolog integration engineer.** Every new message is tagged with `positionId`, and with `searchId` where a search produced it, and is dropped by the existing stale guard. Game analysis is the one long-running job in the plan: it must be cancellable, must not hold the state lock, and must report progress per move rather than one large reply. Cost budget: a 60-move game is 120 positions, about 3 seconds of Prolog at 25 ms each *(measured per query)*, plus whatever search depth is chosen. On the free host that means a shallow fixed depth for game analysis.

**Frontend and visualization engineer.** The interface should read as a debugger: pick a claim, see where it came from. The provenance "graph" should be a navigable chain of real records (position, fact, rule, plan, move, line, verdict), not a canvas of floating nodes. The flat board stays the place for all of this. No new 3D work.

**Experimental methodology reviewer.** Each new kind of claim gets a labelled check before it ships, in the style of milestone 5: counterfactual verdicts against positions with a known blunder and a known best move; fact deltas against hand-written before-and-after pairs. The held-out discipline continues: positions added after a rule is frozen are reported separately. Results get written to a file with the configuration that produced them, so a number can be traced to a run.

**Portfolio product reviewer.** Four milestones is the limit. Each must end in something that can be shown in under a minute: paste a famous game and step through it; ask "why not this move?"; click a claim and follow it to its rule; open the results page and see a failed experiment reported. UCI is worth doing because "it plays in any chess GUI" is instantly understood, but it must stay small.

## 3. Decisions

1. **PGN and UCI both go in milestone 6, PGN first.** Both are low risk. PGN is the one visitors see; UCI is a separate small script.
2. **Evaluation-change analysis moves into milestone 7** with the counterfactual. Both are "compare two positions": the same Lisp comparison and the same Prolog fact delta serve both.
3. **Facts gain a stable key** (kind plus pieces and squares) in milestone 7, because counterfactuals, deltas and provenance all need to say "the same fact".
4. **No new motif rules** in milestones 6 to 9 unless the benchmark shows a gap worth closing. The one known gap (a pin against an undefended equal piece) is fixed in milestone 9, with a fresh held-out set.
5. **No symbolic evaluation inside the search.** It was costed in milestone 3 at about 21 seconds per move. Milestone 9 may try Prolog on the principal variation only, as a measured experiment.

## 4. Milestones

### Milestone 6: Interoperability and game analysis

**Goal.** SymChess can read a real game and can be driven by standard chess software.

**Scope.**
- *SAN and PGN reading in Lisp.* A move in SAN is found by comparing it with the engine's own SAN for each legal move, ignoring check marks and annotations. PGN reading handles tags, move numbers, comments in braces, variations in brackets (skipped), numeric annotation glyphs and the result. An unreadable or illegal move stops the import at that move with a message naming it; the moves before it are kept.
- *Game analysis.* A cancellable job that walks the game and, per position, sends the evaluation at a fixed shallow depth and Prolog's facts. One progress message per move.
- *Interface.* Paste a PGN, step through the game with the arrow keys, an evaluation graph across the game, and the existing reasoning panel for the position shown. Stepping uses the same "shown position" mechanism as the line replay, so a game position being browsed can never be played on by mistake.
- *UCI.* `engine/uci.lisp`: `uci`, `isready`, `ucinewgame`, `position`, `go depth` / `go movetime`, `stop`, `quit`, and `bestmove` with `info` lines. No pondering, no options, no time-control arithmetic beyond `movetime`.

**Files.** New `engine/src/pgn.lisp`, `engine/uci.lisp`. Changes to `notation.lisp`, `game.lisp`, `package.lisp`, `symchess.asd`. Frontend: `protocol.ts`, `state.ts`, a new `GamePanel`-side import form and `GameReview.tsx`.

**Protocol.** Commands `load_pgn {pgn}`, `stop_review`. Messages `game_loaded {gameId, tags, moves[], error?}`, `review_step {gameId, ply, fen, board, move, score, evalBreakdown, facts}`, `review_complete {gameId}`. A new game or a second import invalidates the `gameId`.

**Tests.** SAN round trip: for every legal move in a set of positions, reading the engine's SAN gives back the same move. PGN: a known game imports to the right final position; a game with a deliberately illegal move stops at it; comments and variations are skipped. UCI: a scripted session through standard input produces a legal `bestmove`. Frontend: stale `review_step` messages are dropped.

**Demo.** Paste a famous short game, step through it, watch the evaluation graph and the facts change.

**Stop when.** A full game imports, reviews and steps correctly, an illegal PGN fails politely, and the UCI script plays a game against itself from the command line. Annotated PGN export is left for later.

### Milestone 7: Counterfactual reasoning

**Goal.** The user can ask "why not this move?" and "what changed?", and get an answer made only of what the search found and what Prolog derived.

**Scope.**
- *Stable fact keys* from Prolog: kind plus the pieces and squares involved.
- *Fact delta* in Prolog: given two analyses, the facts added, removed and kept. Positive and negative tests.
- *Counterfactual in Lisp.* Search the best move and the chosen alternative to the same depth. Report both scores, the difference, both expected lines, the material count along each, a verdict from fixed thresholds owned by the engine (as good, inaccuracy, mistake, blunder), the fact delta between the two resulting positions, which plans' supporting facts survive, and Prolog's warnings about the alternative, each marked confirmed only if the alternative's line really loses the material the warning names.
- *Evaluation change.* For two consecutive positions: the six evaluation terms before and after, the largest changes named, and the fact delta. It stays silent below a threshold and says so.
- *Interface.* Choose a move from a list of the legal moves; a two-column comparison (the engine's move and yours); "step through that line" using the existing replay.

**Files.** `knowledge/analysis.pl`, `render.pl`, new `knowledge/delta.pl`; `engine/src/game.lisp`, `search.lisp`, `prolog-bridge.lisp`; frontend `protocol.ts`, `state.ts`, new `Counterfactual.tsx`.

**Protocol.** Command `explain_move {uci, positionId}`. Message `counterfactual {positionId, searchId, move, best, score, bestScore, lossCp, verdict, line, bestLine, factsAdded, factsRemoved, items[]}`. Facts gain a `key` field. `search_complete` or a new `eval_delta` message carries the before-and-after terms.

**Tests.** Labelled counterfactuals added to the credibility benchmark: for each "losing capture" position the avoided move must be called a mistake or blunder and its line must show the material loss; for each "best move" position the best move must be called best. Fact delta against hand-written pairs. A counterfactual for a position that has since changed is dropped.

**Demo.** In the tour's fork position, ask "why not Bxf7+?" and see the line, the score difference and which facts the two moves create.

**Stop when.** Verdicts match the labels, no warning is marked confirmed without the line showing it, and the comparison view works on the flat board. Natural-sounding prose that joins the pieces into one sentence is not attempted: a list of tagged statements is more honest than a fluent paragraph the program cannot stand behind.

### Milestone 8: Reasoning debugger

**Goal.** Any claim on screen can be followed back to the rule and the evidence that produced it, and every disagreement between Prolog and the search is visible in one place.

**Scope.**
- *Provenance on every sentence.* Each explanation and counterfactual statement carries: the rule that produced it (a Prolog predicate name, or "search", or "evaluator"), the fact keys it rests on, the check that set its status ("the line captures on f7 and ends 4.8 pawns ahead"), and the search it came from.
- *Rule index.* Prolog reports, for each kind of fact, the rule's name and its one-line description taken from the source, so the interface shows the actual rule and not a paraphrase kept in TypeScript.
- *The chain view.* Select a fact and see: the position it holds in, the rule that fired and the pieces that satisfied it, the plans that cite it, the candidate moves whose motifs involve it, and what the search said about each.
- *Disagreement panel.* A single list per search of every place the two layers differ: Prolog's top move against the search's, warnings overruled, motifs unconfirmed. Counted, and the counts added to the benchmark.

**Files.** `knowledge/render.pl`, `analysis.pl`; `engine/src/game.lisp`; frontend `ReasoningPanel.tsx`, new `Provenance.tsx`, `selectViz.ts`.

**Protocol.** Explanation items gain `rule`, `facts[]`, `basis`. `hello` or a new `rules` message carries the rule index.

**Tests.** Every sentence with a status other than "measured" has a rule and a basis. Every fact key an item cites exists in the analysis of that position. The benchmark gains a disagreement count per position and checks the labelled ones.

**Demo.** Click "Knight on c6 is pinned" and walk from the fact to the rule, to the plan built on it, to the search's verdict.

**Stop when.** The chain is complete for facts, plans and move motifs on the flat board. A free-form node-and-edge canvas is deliberately not built.

### Milestone 9: Experimental workbench

**Goal.** Claims about what helps are settled by recorded runs, and the runs are reproducible.

**Scope.**
- *One runner* that takes named configurations (first engine, each feature alone, full engine, full engine with root hints, full engine with Prolog on the principal variation) and one or more measures (nodes and time to depth, best-move agreement, the labelled benchmark, self-play), and writes a results file with the configuration, the date and the machine noted.
- *A larger labelled set*, about 100 positions, adding sacrifices, king-safety positions and endgames, and crowded middlegames, which milestone 5's set lacks. New positions are held out from any rule change.
- *The pin gap* found in milestone 5 fixed, and measured on the new held-out set.
- *UCI matches* against one outside engine at a fixed weak setting, if one can be run locally, to give a rough outside reference for strength. Reported as a rough reference only.
- *Results page* reads the recorded results file instead of numbers typed into the source.

**Files.** New `engine/tests/experiment.lisp`, growth of `credibility-positions.lisp`, `results/*.json`, frontend `Benchmarks.tsx`.

**Tests.** The runner's output for a tiny fixed configuration is checked against known values. The results page renders a recorded file.

**Demo.** The results page shows each experiment with its configuration, including the ones that did not help.

**Stop when.** Every figure on the results page traces to a recorded run.

## 5. Order and size

| Milestone | Depends on | Rough size | Shows off |
| --- | --- | --- | --- |
| 6 Interoperability and game analysis | Nothing new | Medium | Real games; plays in a chess GUI |
| 7 Counterfactual reasoning | Fact keys (built here) | Large | The signature question |
| 8 Reasoning debugger | Fact keys, counterfactual items | Medium | The architecture made visible |
| 9 Experimental workbench | UCI from 6, labels from 7 and 8 | Medium | Honesty with numbers |

Sizes are *(estimates)*.

## 6. Risks

- **The free host.** A tenth of a processor, depth capped at 7. Game analysis and counterfactuals double or multiply searches. Both need fixed shallow depths there and must be cancellable. If game analysis of a long game is too slow on the host, it is limited to a number of moves and says so.
- **Fluent but unsupported explanations.** The more the program compares, the stronger the pull toward a neat sentence. The guard is the same as before: tagged statements, each with its basis, and a benchmark check for every new status.
- **Evaluation noise.** Small score differences at shallow depth mean little. Verdict thresholds must be wide, and "about the same" must be an allowed answer.
- **Label reliability.** Milestone 5 found that hand labels were wrong about as often as the rules. Every label keeps being checked by a deeper search, and corrections keep being reported.
- **Scope.** Annotated PGN export, opening books, endgame tables, time management in UCI and any 3D work are out.

## 7. Recommendation

Build milestone 6 next, PGN before UCI. It is the least risky of the four, it gives the later milestones real games to be tried on, and UCI gives milestone 9 a way to measure strength from outside the project.

## 8. Milestone 6: results

**Built.**

| Piece | What it does |
| --- | --- |
| Reading standard notation (`parse-san-move`) | A move is read as a description and matched against the generator's legal moves. Zero or two matches: refused |
| Reading PGN (`read-pgn-game`) | Tags, comments, nested variations, annotation glyphs, results, a FEN starting position, castling written with zeros. First game only |
| `load_pgn` and the review | The game becomes the session's game; a cancellable background thread sends each position with a depth-5 search, the evaluation terms and Prolog's facts |
| Review in the interface | Paste dialog with a sample game, an evaluation graph across the game, a move list, arrow-key stepping, facts and overlays for the position shown |
| UCI (`engine/uci.lisp`) | `uci`, `isready`, `ucinewgame`, `position`, `go depth/movetime/infinite`, `stop`, `quit` |

**Measured.**

- Every legal move in six test positions, written in the engine's notation and read back, gives the same move.
- The sample game (33 half-moves, 34 positions) is reviewed in about 2.4 seconds on a desktop, so roughly 70 ms a position including Prolog. The free host will be several times slower; not yet measured there.
- Through real pipes, the UCI script played a 60-half-move game against itself at depth 4, including castling and a promotion, and exited cleanly.

**Checked.** Engine tests 137 (29 new: notation, PGN, UCI), Prolog 78, frontend 81 (14 new), end-to-end with ten new checks for import and review. An illegal move in a PGN stops the import at that move with the earlier moves kept; text with no moves is refused; positions from an earlier import are dropped by the reducer.

**A fault found while checking.** While a review was still arriving, asking for a position the engine had not reached left the board on the live game while the panel described the review. The board now shows the latest position that has arrived, so board and panel always agree.

**Not done.** Annotated PGN export. More than one game per PGN. A review is not resumed after a reconnect. The review does not flag blunders or name the turning point: that needs the before-and-after comparison planned for milestone 7. No measurement on the hosted site.
