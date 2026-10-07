# Limitations register

Every limit recorded across milestones 1 to 9, with where it stands now. This is the one place to look; the per-milestone notes in `NEXT_STAGE.md` and `WORKBENCH_PLAN.md` are history.

Status words: **closed** (fixed and tested), **improved** (better, still a limit), **open** (known, not addressed), **accepted** (a boundary of the project, not a defect), **deferred** (worth doing, not done here, with the reason).

Figures are from `results/*.json` (sources `6fdb40c9`, recorded 2026-10-07) unless a row says it is from an earlier recording. `sbcl --script engine/tests/experiment.lisp verify` checks that those files were made by the sources in the repository.

## The pass after: 3D reasoning, rule correctness, search (engine 0.8.0)

Three things were worked on together. Each is listed with what was measured and what was not.

### Search

Three standard changes, each behind a switch so the engine as it was at 0.7.0 can still be run (`v07` in the experiment scripts):

- **Reverse futility pruning.** A few plies from the horizon, a node that already stands well above what is needed is not searched further.
- **Checks answered in the quiescence search.** A side in check used to be allowed to "stand pat" on its static score, even when it was mated. Now every reply is tried, and none is mate.
- **A deeper null-move reduction** at depth 6 and beyond.

| Measure | Result |
| --- | --- |
| Positions searched to reach depth 6 over 19 positions: 0.7.0, now | 477,061, 415,187 (87.0%) |
| The same without reverse futility pruning | 513,931 |
| The same without checks in quiescence | 383,249 (answering checks costs positions; it is there for correctness) |
| The same without the deeper null-move reduction | 415,187 (no difference at depth 6: it only acts below a depth-6 node, so it matters in deeper searches only) |
| Labelled moves played right at depth 6: 0.7.0, now | 35 of 36, 35 of 36 |

| Match | Time per move | Games | Won | Drawn | Lost | Points |
| --- | --- | --- | --- | --- | --- | --- |
| new against v07 | 100 ms | 48 | 23 | 10 | 15 | 58.3% |
| new against v07 | 300 ms | 48 | 25 | 13 | 10 | 65.6% |

Together that is 59.5 points from 96 games (62.0%). **What this supports:** the new search does less work for the same depth, plays the labelled moves as well as before, and probably beats its earlier self: 62.0% over 96 games is about two and a half standard errors above an even score. **What it does not support:** how much stronger, or stronger against anything else. Each half alone is 48 games, where a result has to be about fifteen points from 50% to show anything; the opponent is the engine's own earlier self; and the runs shared the machine with two other measuring runs. No Elo figure is claimed.

The standard 24-game matches were re-recorded in the same session and show how little 24 games settle: the full engine against the first engine scored 56.2% this time and 66.7% last time, and the hints scored 8.3% with three runs competing for the processor (Prolog's time is counted against the side that asks it).

Not done: evaluation tuning, an opening book, tablebases, an outside-engine match, a sequential test. The evaluation was read and left alone; a change to it needs many more games than were played here to justify.

### Symbolic rules

| Change | Tests |
| --- | --- |
| A piece pinned to its king does not threaten what it cannot take, and does not defend what it cannot recapture on. So "threatened" no longer fires for a pinned attacker, and a piece whose only defender is pinned is reported as hanging | Five Prolog tests, positive and negative |
| "Trapped", for the side to move, is dropped if a legal move Lisp supplied takes the piece somewhere safe (for instance a square a friend guards once the piece has stepped off its line) | Three tests |
| A discovered attack by the side to move is dropped if no legal move of the masking piece opens the line (it is pinned, or has no move) | Three tests |
| Every fact carries how it was checked: `geometric` (read from the lines of attack) or `legal_moves` (a claim about moves that survived the check). The fact panel shows it | One test; seen in the browser |

Benchmark after the change: development set 42 of 42 reported were there, 42 of 42 there were found; held-out 18 of 18 reported were there, 18 of 18 there were found; second held-out 14 of 14 reported were there, 14 of 14 there were found. One label was corrected: in `hanging-defender-is-pinned` the knight on d5 really is hanging (taking it is the labelled best move), and the label had left it out because the old rule did.

Still approximate, and said so on each fact:

- Only the side to move is checked against moves, because those are the only moves Lisp sends. A trapped piece or discovered attack of the other side is geometric.
- "Trapped" is only ever removed by the check. A piece that looks free by the lines but has no legal move (it is pinned) is still not reported.
- Overloaded pieces, forks and skewers are geometric throughout.
- The Lisp exchange counter (SEE) still counts a pinned defender as a defender. Prolog's "hanging" and "threatened" no longer do, so the two can disagree; the search, not the counter, has the last word.
- The checks that remove a fact have no entry in the rule index, which lists rules that produce one.

### The 3D board

It is now a second view of the reasoning, not only a showcase, within stated limits.

- Hovering or selecting a fact or plan in the panel shows that item's own drawing primitives on the 3D board: arrows, rings, squares and files, in the same colours as the flat board, and the pieces they name light up. A pin or skewer is also drawn as a line at the height of the pieces. It is the same shared selection the flat board uses, and nothing is worked out in the frontend.
- The best-move arrow, the check marker and the checkmate effect were already there.
- File letters and rank numbers are on the rim, under the same Coordinates switch.
- Three camera presets: Play (angled), Analyze (from high up), Focus (close on the selected fact). They glide unless motion is reduced or set to Minimal.
- The pieces are carved figures (see `docs/screenshots/statues.png`).

Not there, by decision: the standing analysis layers (all pins, all threats at once), the square inspector's arrows, keyboard play and drag. The flat boards are the precise workbench and the only accessible way to play; the 3D board is the cinematic view of one idea at a time.

Not measured: frame rate, and behaviour on a phone. Each statue is now a handful of draw calls where it was about twenty-five, so it should be lighter, but that is reasoning.

### What not to overclaim

- Not "much stronger" and no rating: "does less work for the same depth, and scored 62.0% over 96 games against its earlier self".
- Not "Prolog checks legality": Prolog checks three claims against moves Lisp generated, for the side to move.
- Not "3D analysis board": one selected fact at a time, plus the best move.

## Triage (from the limitations pass after milestone 9)

How each limit was judged before anything was changed. Severity is about whether the project says something false or unverifiable; portfolio impact is about what a reviewer would notice.

| Limitation | Severity | Portfolio impact | Decision | Owner | Risk of the fix | Verified by |
| --- | --- | --- | --- | --- | --- | --- |
| Recorded results did not match the current sources | High | High | Fix | Lisp, tests | Low | `experiment.lisp verify`; a frontend test |
| "Mistake" and "blunder" said of a depth-5 search's opinion | High | High | Fix | Lisp wording, React labels | Low | Engine tests, end-to-end, screenshot |
| No test for the "why not?" bug with Prolog running | High | Medium | Fix | End-to-end | Low | New end-to-end checks |
| A pin reported where the piece can step aside and guard | Medium | Medium | Fix | Prolog, with moves from Lisp | Medium | Five Prolog tests; benchmark |
| No tactical regression suite | Medium | Medium | Fix | Lisp tests | Low | Runs inside the engine tests |
| A dead-drawn ending scored as a piece up | Medium | Low | Fix | Lisp search | Low | Engine tests; node counts unchanged |
| Nothing between Novice and Club | Medium | Medium | Fix | Lisp levels | Low | Engine tests; recorded ladder |
| Hosted limits not stated where the level is chosen | Medium | Medium | Fix | React, from engine numbers | Low | Browser |
| No screenshot of the comparison panel; no screenshots kept | Medium | High | Fix | Script | Low | `npm run screenshots` fails if a view is empty |
| "Ask the search" button never clicked | Low | Low | Fix | Browser check | None | Done in the browser |
| 3D board draws continuously | Low | Low | Fix | React | Medium | Type-check; by eye |
| UCI clock handling was a thirtieth of the clock | Low | Medium | Fix | Lisp | Low | Engine tests |
| Review speed never measured on the host | Low | Low | Measure | None | None | Measured |
| Two hand-copied results tables had recorded equivalents | Low | Medium | Fix | React | Low | Frontend tests |
| Table ageing | None | Low | Close as not applicable | None | None | Reasoning in `RESEARCH_NOTES.md` |
| 66 labelled positions, five crowded | Medium | Medium | Defer | Benchmark | High (labels) | See below |
| No outside-engine match | Medium | Medium | Defer | None | None | See below |
| 24-game matches | Medium | Medium | Accept, claims kept modest | Docs | None | Wording on the results page |
| Prolog does not help the search | None | Positive | Accept | Docs | None | Three recorded measurements |
| 3D board lacks analysis overlays | Low | Low | Accept (later improved, see above) | Docs | None | Stated |

## Milestone 1: engine strength

| Limit | Status | Now |
| --- | --- | --- |
| Gain over the first engine is modest | accepted | 62.0% over 96 games (earlier, by hand); 66.7% over 24 in the previous recording and 56.2% over 24 in this one, which shows how little 24 games settle. No Elo figure is claimed |
| Slower per position because the evaluation does more | accepted | It reaches depth 6 in a fifth of the positions; that is the trade |
| Single features cannot be ranked | open | 24 games each, recorded. The only way to rank them is a sequential test over thousands of games (see `RESEARCH_NOTES.md`, section 1) |
| No dedicated tactical suite | closed | The 36 labelled-move positions run inside the engine tests; the full engine at depth 6 must solve all but one named miss. It guards against regressions and supports no strength claim |
| No table ageing | closed, not applicable | The table is always-replace, so stale entries are overwritten by the first new position on their slot |
| No draw awareness for trivial endings | closed | The search scores bare kings and king and one minor piece against king as a draw. Node counts on the 19 benchmark positions did not change |
| One busy desktop | improved | Results files record the processor, the core count and a note about load. It is still one machine |

## Milestone 2: difficulty levels

| Limit | Status | Now |
| --- | --- | --- |
| Nothing between Novice and Club | improved | Casual was added: the full evaluation, depth 4, and a quarter-pawn margin. It is engine-owned and tested. It sits between the two but the steps are still steep (table below) |
| Hosted Expert plays like Club | accepted | The level picker now states, from the engine's own numbers, what depth and time the level gets on this server and that Expert plays much like Club there |
| Expert tested at a tenth of its allowance | improved | Now at a third (1 second a move). A full-allowance match is about three hours and was not run |

| Match | Games | Won | Drawn | Lost | Points |
| --- | --- | --- | --- | --- | --- |
| casual against novice | 24 | 24 | 0 | 0 | 100.0% |
| club against casual | 24 | 23 | 1 | 0 | 97.9% |
| club against novice | 24 | 24 | 0 | 0 | 100.0% |
| expert against club | 24 | 23 | 1 | 0 | 97.9% |

Casual beats Novice every game and loses to Club almost every game. So the ladder has four rungs and no gentle step. Narrowing the gaps would mean tuning depth and margin against measured matches, which is a small project of its own.

## Milestone 3: Prolog reasoning

| Limit | Status | Now |
| --- | --- | --- |
| Rules read attacked squares, not legal moves | improved | One conclusion that is really about moves is now checked against them: a pin to a piece of equal value is dropped if a legal move Lisp supplied lets the front piece step aside and guard its partner. Prolog still generates no moves |
| "Trapped" and "pinned defender" ignore pins and opened lines | improved | For the side to move, "trapped" and "discovered attack" are now checked against the legal moves Lisp supplies, and a pinned piece no longer counts as an attacker or a defender. The other side's are still geometric, and each fact says which it is |
| Missing motifs (mating nets, minority attack, opposition, and others) | deferred | Two milestones running found faults in existing rules. More rules before more labelled positions adds claims faster than the means to check them |
| Facts not filtered by difficulty level | deferred | Useful for a teaching mode; nothing in the project's claims depends on it |
| Prolog's ranking does not help the search | accepted | Measured again: 31.2% against the engine without it at 100 ms a move in the recorded file, and 25.7% over the three recordings made in this pass. It stays switched off |
| Prolog inside the search | accepted | About 21 seconds a move by arithmetic. Not built |

## Milestone 4: showcase

| Limit | Status | Now |
| --- | --- | --- |
| Animations checked only by their end states | open | Still so |
| 3D board draws continuously | closed | It draws while something is moving and for a second and a half after any change, then stops until woken |
| 3D board lacks overlays, coordinates, keyboard play | improved | It now shows the selected fact, has coordinates and three camera presets. It still has no standing layers and no keyboard play: the flat board is where analysis happens |
| No linked "search beside reasoning" view; no puzzle mode | deferred | The Trace tab covers the first in another form |
| Results page tables copied by hand | improved | Five tables are built from recorded files. Three remain as labelled history: the 96-game matches, the 300 ms hint match, and precision before the rules were corrected. They cannot be regenerated because the code they measured no longer exists in that form |
| No screenshots | closed | `npm --prefix web run screenshots` writes ten to `docs/screenshots/` and fails if a view comes up empty |

## Milestone 5: analysis credibility

| Limit | Status | Now |
| --- | --- | --- |
| Small, sparse benchmark | open | 66 positions, five crowded. See "Deferred, and why" |
| Ten of my own labels were wrong | accepted, recorded | Kept in `ANALYSIS_CREDIBILITY.md` as method. The second held-out set needed no corrections |
| The exchange counter treats a pinned defender as a defender | open | Standard for an engine of this size and fixed in a test. Prolog's "hanging" and "threatened" rules now leave out a piece pinned to its king, both as attacker and as defender |
| One real pin unreported | closed | Milestone 9, with a positive and two negative tests |

## Milestone 6: PGN, review, UCI

| Limit | Status | Now |
| --- | --- | --- |
| No annotated PGN export; one game per PGN | deferred | Neither unlocks testing or changes what the project can show |
| Review not resumed after a reconnect | open | The game is re-read on request |
| Review speed never measured on the host | closed | A 40-move game no engine had seen: 41 positions in 4.6 s locally (112 ms each) and 11.6 s on the free host (282 ms each) |
| UCI: no real clock handling | improved | The move time now uses the increment and the moves left, and never more than half the clock. Still no pondering and no options; the engine announces none |

## Milestone 7: "why not this move?"

| Limit | Status | Now |
| --- | --- | --- |
| Ratings are a shallow search's opinion stated as fact | improved | Reworded everywhere: "At depth 6 the search prefers X and scores Y about 1.9 pawns lower", with a caution on every rating against a move. The badges read "lower at depth 6", not "mistake". A rating that rests on a forced mate is not hedged, because a mate the search has found is exact. The search is no deeper than before: in the sample game Morphy's 10.Nxb5 comes out as a missed chance when the search reaches depth 4 and as about as good when it reaches depth 5, and the caution says a sacrifice looks exactly like this |
| Ratings were not repeatable | improved | Each comparison now starts from an empty table, so a rating no longer depends on what was searched before. A review still gives each search a quarter of a second, and on a few positions that cuts it a ply short, so two reviews of one game can differ on those moves. Every rating states the depth it was made at |
| One benchmark check widened after a result | accepted, recorded | In `ANALYSIS_CREDIBILITY.md` |
| A fact's identity ignores the other pieces | accepted | Deliberate: a knight pinned by a bishop on b5 is the same pinned knight when the bishop steps back to a4. The cost is that two pins of one piece share a key |
| Fact comparison is in Lisp | accepted | It compares two lists by a key Prolog assigns |
| No "what changed" view in live play | deferred | It exists in a review |
| Review slower, not re-timed | closed | Timed: see milestone 6 |
| No screenshot of the comparison | closed | `docs/screenshots/why-not.png` |
| No test of the "why not?" bug with Prolog running | closed | The end-to-end run asks about the engine's own move and requires Prolog's sentences to be there |

## Milestone 8: reasoning debugger

| Limit | Status | Now |
| --- | --- | --- |
| A rule's entry omits its helper predicates | open | |
| Seven motif-to-fact links | accepted | Most motifs describe something the move creates |
| A verdict only for the chosen move or one asked about | accepted | The chain ends at a button that asks |
| Rule descriptions are comments and could go stale | accepted | They are the rule's documentation string, shown beside the rule's own source. A test requires every rule to have one |
| The move-aware checks have no entry in the rule index | open | `refuted/3` in `analysis.pl` removes a fact (now for three kinds); the index lists rules that produce one. Each fact does say how it was checked |
| Disagreements for the current position only | deferred | |
| "Ask the search" button never clicked | closed | Clicked in the browser: the chain's last step went from "not searched yet" to the search's confirmed sentence |

## Milestone 9: experimental workbench

| Limit | Status | Now |
| --- | --- | --- |
| Recorded files did not match the sources | closed | All four files were re-recorded and share one fingerprint with the sources. `experiment.lisp verify` checks it |
| Runs recorded with uncommitted changes | improved | Still true of these files, and they say so: results can only be committed after they exist. The fingerprint is what identifies the program, and it can be checked at any commit |
| Machine doing other work | improved | Each file can carry a note about load, and these do. The matches still shared the machine |
| No outside-engine match | deferred | See below |
| 66 positions, five crowded | open | See below |
| 24-game matches | accepted | Only one result is claimed from them: the hints lose, and that rests on three recordings of the match (20.8%, 25.0% and 31.3%: 72 games, 25.7% of the points), not on one. How little a single 24-game match shows: late move reductions alone against the first engine was also recorded three times and gave 62.5%, 35.4% and 60.4% |
| A pin read from lines, not moves | closed for the side to move | See milestone 3 |
| Hand-copied tables | improved | See milestone 4 |
| Prolog on the main line as a search experiment | accepted | Every form of "Prolog steers the search" measured so far loses. Not tried again |

## Deferred, and why

**More labelled positions, especially crowded ones.** This is the benchmark's real weakness and the one I most wanted to close. It was not, for a reason worth stating: a label on a crowded position is a claim that *every* tactical fact in it has been listed, for both sides. Ten of the first fifty labels were wrong. Thirty more written in one sitting would raise the count and lower the trust. The right way is a few at a time, each checked by a second reader or against a stronger engine's analysis.

**A match against an outside engine.** None is installed on this machine and I did not download one. The UCI clock handling added here is what such a match needs. Until one is run there is no outside reference for strength and the project claims none.

**A sequential test (SPRT) for the single features.** The accepted method, and hours of games per feature at this engine's speed.

## What the second held-out set looks like now

14 of 14 facts reported were really there, and 14 of 14 real facts were found. That is a perfect score on a set the rules have now been corrected against twice (the equal-value pin, then the step-aside check), so it is no longer a held-out result and is not presented as one. A third set, untouched, is what would show how the rules do on positions they have not met.
