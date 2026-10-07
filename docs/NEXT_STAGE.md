# SymChess: next-stage plan

From "explainable symbolic chess prototype" to "playable symbolic chess AI showcase".

This is a plan, not a record of work done. Strength and cost figures marked *(estimate)* are judgement, not measurement; everything marked *(measured)* comes from this repository's own benchmarks and tests.

The rule that does not move: **Lisp owns truth and search. Prolog owns symbolic meaning. React owns visualization and interaction.**

## Where the project actually is

The planning brief describes an earlier state. Three things have changed and the plan starts from them.

| Brief assumes | Reality today |
| --- | --- |
| Frosted Staunton pieces | An ice and amethyst glass set, plus a second "Figures" set and a 3D board |
| 3D is a future question | A Three.js board already ships, lazily loaded, with statues that fight on capture |
| Prolog root hints help the search | *(measured)* they change the node count by about 0.1%. They help explanation, not strength |

What the engine has: iterative-deepening PVS, quiescence, transposition table (2^20 entries), null-move pruning, check extension, killer and history ordering, MVV-LVA capture ordering. About 0.5M nodes/s on a desktop *(measured)*.

What it lacked when this plan was written: static exchange evaluation, late move reductions, aspiration windows, mobility and king safety. The evaluation was material, piece-square tables with a tapered king table, doubled, isolated and passed pawns, and the bishop pair. (An earlier draft of this plan wrongly said it had no passed-pawn or endgame scoring.) Milestone 1 has since added the missing pieces; see the results at the end.

What Prolog knows: check, pin, skewer, fork, hanging and threatened pieces, overloaded defenders, open and semi-open files, passed, isolated and doubled pawns, weak squares, the king's pawn shield, and nine plan rules.

One constraint shapes everything below: the public site runs on a free instance with **a tenth of a CPU**, one search at a time, capped at depth 7 and 3 seconds. Expert strength on a laptop and Expert strength on the hosted site are different things.

## 1. Executive summary

The next version should be the same three-language system, made worth playing against:

1. Three honest difficulty levels, where each level is a real configuration of search and evaluation, not a strong engine told to play badly at random.
2. An Expert level that is clearly stronger than today's engine, through evaluation and search work that is standard, well understood and testable.
3. Deeper Prolog motifs, used for what Prolog has been shown to be good at here: explaining, warning and planning. Any use in move choice has to earn its place in a benchmark.
4. A guided demo, so a visitor understands the project in a minute without knowing chess engines.

Animation is largely built. The remaining work there is consolidation, not expansion.

## 2. Difficulty model

Difficulty is one engine-side setting. The engine picks depth, time, evaluation set and mistake policy from it; the frontend only names the level. This keeps "how strong am I playing" a fact the engine owns.

| | Novice | Club | Expert |
| --- | --- | --- | --- |
| Search | Depth 2–3, no null move | Depth 5–6, today's search | Time-limited, all search improvements on |
| Evaluation | Material and piece-square tables only | Adds pawn structure, king shield, mobility | Full tapered evaluation |
| Prolog | Root facts for explanation | Root facts and plans | Root, plus principal-variation analysis after search |
| Mistakes | Picks among near-best moves; see below | None deliberate | None |
| Explanation | One sentence, one motif | Motifs plus the plan | Plan, warnings, and why alternatives were rejected |
| Label | "Novice: learning the pieces" | "Club: a steady opponent" | "Expert: plays to win" |
| Feels like | Beatable, never absurd | Punishes loose pieces, misses long plans | Tactically sharp, hard to trick |

**How Novice loses without faking it.** The engine searches normally at low depth, then chooses among moves within a score margin of the best (about half a pawn *(estimate)*, to be tuned), with two guards: it never chooses a move that loses material to a one-move reply, and it never passes up a mate in one. It is weak because it sees little and evaluates crudely, which is how a weak player is weak. No illegal moves, no random blunders.

**Explanations must describe the move actually chosen.** If Novice plays its second choice, the explanation says so in plain terms ("a reasonable developing move") and does not claim it was the engine's best.

**On the hosted site**, Expert is capped by the server's limits. The interface should say what the server allows rather than promise laptop strength.

## 3. Lisp engine improvements

Ordered by strength gained per unit of risk. Impact is *(estimate)*.

**Must do**

| Change | Why | Impact | Risk |
| --- | --- | --- | --- |
| Tapered evaluation (middlegame and endgame scores blended by material) | Kings should hide early and march late; one table cannot say both | High | Low |
| Passed-pawn, mobility and king-safety terms | The largest gaps in the current evaluation | High | Medium: needs tuning |
| Static exchange evaluation (SEE) | Orders captures properly and prunes losing captures in quiescence | High | Medium: classic source of bugs |
| Late move reductions | The biggest single depth gain available | High | Medium: can hide tactics if too aggressive |
| A difficulty setting in the engine | Section 2 depends on it | Enables the feature | Low |

**Should do**

- Aspiration windows around the previous iteration's score.
- Transposition table ageing and depth-preferred replacement.
- Delta pruning in quiescence.
- Draw awareness in evaluation for trivially drawn endings (bare kings, king and minor piece).

**Optional**

- A small opening book for variety, chosen from by the engine.
- Internal iterative reductions when there is no hash move.

**Avoid for now**

- Bitboards. A rewrite of the board for speed is a different project.
- Neural evaluation. It would end the "classical AI" identity.
- Multi-threaded search. The host has a tenth of a CPU.
- Endgame tablebases.

**Guarding against bugs.** Every search change is checked three ways: perft is unchanged, a fixed tactical suite still solves, and a self-play match against the previous version does not get worse. A change that cannot show an improvement in self-play is removed.

## 4. Prolog knowledge improvements

Each rule is marked by what it is for. "Explains" means it feeds the reasoning panel. "Could order" means it is a candidate for the experiments in section 5 and stays explanation-only until one passes.

**Tactical**

| Rule | Example fact | Use |
| --- | --- | --- |
| Discovered attack | `discovered_attack(white, e4, d1, d8)`: moving e4 opens the queen on d1 against d8 | Explains; could order |
| Battery | `battery(white, [d1, d3], file(d))` | Explains |
| X-ray | `xray(white, a1, a8, through(a5))` | Explains |
| Pinned defender | `pinned_defender(black, f6, defends(d5))`: f6 guards d5 but cannot move | Explains; could order |
| Trapped piece | `trapped(black, bishop, h2)`: no safe square | Explains; could order |
| Removal of the guard | `guard_removable(black, e7, guards(d6), by(white, c5))` | Explains |

**King safety**

- `mating_net(black, g8, missing(1))`: the king's flight squares are covered but one.
- `open_line_to_king(white, file(h))`, `weak_back_rank(black)`.

**Strategic and pawn structure**

- `outpost(white, d5, for(knight))`: a square no enemy pawn can attack, supported by a pawn.
- `pawn_break(white, c4, against(d5))`, `minority_attack(white, queenside)`.
- `rook_on_seventh(white, d7)`, `rook_behind_passer(white, a1, a5)`.
- `backward_pawn(black, d6)`, `pawn_majority(white, queenside)`.

**Endgame**

- `king_in_square(black, a5)`: can the king catch the passed pawn.
- `opposition(white, e5, e7)`, `wrong_bishop(white, h_pawn)`.

**Plans** grow from these: "break with c4", "plant a knight on d5", "double on the open file", "bring the king to the centre".

**By difficulty**, the set shown grows: Novice sees hanging pieces, forks, pins and checks. Club adds structure and single-step plans. Expert adds the rest and plans with a named follow-up.

**Unchanged rules for Prolog.** It never generates moves; Lisp sends the positions. It holds no state between queries. Every new rule ships with positive and negative test positions, because the existing suite's most valuable tests are the ones where a rule must stay silent.

## 5. Lisp–Prolog integration experiments

The earlier result matters here: root hints did not speed the search. So each experiment starts from "this probably helps explanation only" and has to prove otherwise.

| Experiment | Goal | Cost | Measure | Keep if | Remove if |
| --- | --- | --- | --- | --- | --- |
| A. Post-search explanation only | Explanations describe the line the search actually chose | One query per move | Faithfulness tests (section 10) | Explanations match the played line | Never; this is the baseline |
| B. Principal-variation analysis | Explain what the engine expects to happen next | One query per position on the main line, after search | Added time per move; do the facts read as a coherent story | Under 300 ms added and the story holds | It slows moves noticeably |
| C. Root danger warnings before ordering | Search the moves Prolog calls dangerous first | Already paid for | Nodes to reach a fixed depth, over a 50-position suite | Nodes fall by 5% or more | Under 2%: keep the facts, drop the ordering |
| D. Selected quiet-node analysis | Strategic bonus at a handful of quiet nodes near the root | High: tens of milliseconds per query against microseconds per node | Self-play match at equal time | Wins the match | Expected to fail; run once to have the number |
| E. Root hints (existing) | Order root moves by symbolic score | Paid | Done: about 0.1% change *(measured)* | n/a | Already demoted to explanation |

The asymmetry to remember: a Prolog query costs 20–125 ms *(measured)*; the search visits a node in about two microseconds. One query costs as much as tens of thousands of nodes. Prolog in the search loop cannot pay for itself, and experiment D exists to show that with a number rather than assert it.

## 6. Expert mode design

The strongest version that is still this project:

1. **Search**: PVS with late move reductions, aspiration windows, SEE-ordered captures, null move, check extension, a better table.
2. **Evaluation**: tapered, with mobility, king safety and passed pawns.
3. **Symbolic pre-analysis**: one Prolog query at the root for facts, dangers and plans. Used for explanation, and for ordering only if experiment C passes.
4. **Tactical verification**: any tactic Prolog claims for the chosen move is checked against the search's own line. Confirmed claims are labelled confirmed; the rest are labelled as ideas. This already exists in a narrow form and should be widened to every tactical motif.
5. **Plan**: Prolog names a plan for the position after the engine's move, and principal-variation analysis (experiment B) shows whether the expected line follows it.
6. **Explanation trace**: what was chosen, what the search expects, which facts support it, and what the second choice was and why it scored lower.

**Benchmark suite**: a tactical set (mates in two and three, forks, pins, discovered attacks), a small endgame set (king and pawn, rook endings), a quiet positional set, and a self-play ladder between versions. A realistic aim is "solves most club-level tactics within the time limit and does not hang pieces" *(estimate)*. It will not approach Stockfish and the README should say so.

## 7. 3D and animated piece direction

**A decision is needed here.** The brief says pieces should not literally fight; the current 3D board has statues that wind up and strike with weapons, built at the owner's request. Both are legitimate. This plan keeps what was built and offers the restrained version as the "Minimal" setting, so the choice is the player's.

**Style: arcane glass automata on a symbolic analysis board.**

- **Material**: frosted glass. Ice for one side, amethyst for the other, each with a single glow colour used for eyes, gems and seams. No gold, no heraldry, no house colours.
- **Silhouettes**: a different outline for every piece at a glance: battlements, mitre, horse and rider, tall crown, crown and cross, brimmed helm.
- **Principles**: weight (things settle, they do not snap), restraint (one idea per animation), speed (nothing over about 1.2 seconds), and truth (the scene always ends matching the engine's board).

| Moment | Expressive | Minimal |
| --- | --- | --- |
| Selected | Rises, glows, half-raises its weapon | A highlight |
| Move | Lifts, glides, settles | Short glide |
| Capture | Approach, wind-up, strike, shatter | The taken piece fades into shards; no strike |
| Check | Low red glow under the king | Same |
| Checkmate | Board lines converge on the king, which frosts over and dims | The king dims |
| Promotion | The pawn dissolves upward and the new piece forms from the same light | Swap |
| Fact hover | The named pieces brighten, the rest dim | Same |

**Reduced motion**: when the device asks for it, everything becomes an instant change or a short fade. This is already true for what is built.

Still to build: checkmate, promotion, and the Minimal/Expressive switch. Checkmate and promotion do not exist in any view today.

## 8. Frontend implementation plan

**Recommendation: keep the hybrid that exists.** The flat SVG board stays the default and the place where analysis lives. The Three.js board stays an optional view.

Why not make everything 3D: the overlays (arrows, pins, weak squares, the inspector) are precise because they share one coordinate system with the SVG board. Rebuilding them in 3D is a large job that buys spectacle and costs clarity.

**What the 3D view should gain, in order**: the best-move arrow and the inspector's highlight (projected onto the board plane), drag or at least hover feedback, coordinates, then checkmate and promotion animations.

**Animation state machine**, already the shape of the 3D code and worth making explicit:

```
idle -> animating(move) -> reconcile -> idle
            ^ a newer state arrives: queue it, never interrupt
```

The engine's `game_state` is the only input. An animation is a way of travelling from the previous state to the next; when it ends, the scene is rebuilt from the engine's board, so a bug in an animation can produce a wrong picture for a second but never a wrong position.

**Performance**: Three.js stays in its own lazily loaded file. The render loop should stop when nothing is moving; today it runs continuously, which costs battery on laptops and phones.

**Mobile**: default to the flat board. Offer 3D, do not push it.

**Testing**: the pure parts are unit-testable now (the diff that decides whether a move is a capture, the choice of animation). Screenshots through deep links cover appearance. A `slow` parameter already exists to inspect motion.

## 9. New portfolio features

In priority order:

1. **Guided demo**: four or five prepared positions with captions, each showing one idea: a pin found by Prolog, a tactic confirmed by search, a plan, the same position at three difficulty levels. This is the feature that makes a one-minute visit land.
2. **"Why this move?" replay**: step through the main line with the facts for each position (experiment B makes this nearly free).
3. **Search beside reasoning**: one view with the search's numbers on one side and Prolog's facts on the other, linked where they agree.
4. **Puzzle mode**: the tactical test suite, presented to the player. The positions exist already.
5. **Benchmark page**: the measured numbers, including the ones that are unflattering.

Shareable position links already exist. Skip a video-capture mode; record the screen instead.

**The sixty-second demo**: open the guided demo, show the pin and its confirmation, switch to 3D, take a piece.

**The five-minute walkthrough**: the three-language boundary and why it is drawn there; the `positionId` rule that stops stale answers; the measured result that Prolog hints did not speed the search and what was done about it; then the engine improvements with their before-and-after numbers.

**What recruiters remember** is the boundary discipline and the honesty about what did not work, more than the animation.

## 10. Verification plan

| Area | Test |
| --- | --- |
| Engine correctness | Perft unchanged after every search or move-generation change |
| SEE | A table of exchange positions with known results |
| Search strength | Fixed tactical suite; self-play match against the previous version |
| Difficulty | Novice never plays a move that loses material in one; never misses mate in one; Expert beats Club beats Novice over a match |
| Prolog rules | A positive and a negative position for every rule |
| Integration | Prolog missing, slow, or returning nonsense: the engine still plays (already tested for missing) |
| Explanation faithfulness | Every "confirmed" label is backed by the search's line; an explanation never names a move other than the one played |
| Animation | Unit tests on the state diff; the scene equals the engine's board after any sequence of moves |
| Appearance | Screenshots through deep links for each piece style |
| Performance | Nodes per second, time to depth, Prolog query time, measured on a laptop and under the host's limits |

## 11. Risks and cuts

**The blunt version.**

- **The project is growing sideways.** It now has two piece sets, a 3D board, three languages and a hosted deployment, on top of an engine with a thin evaluation. The engine is the weakest part and the animation is the most recent work. The next effort should go to the engine.
- **3D is at risk of becoming a second product.** It has no overlays, no keyboard play and no drag. Either bring the best-move arrow and the inspector into it or state plainly that it is a spectacle view. Do not try to reach parity with the flat board.
- **Difficulty that fakes intelligence** is the easiest mistake to make. A strong engine with random blunders is worse to play than an honestly weak one.
- **Prolog overreach.** The evidence so far says Prolog belongs in explanation. Putting it in the search loop to justify its presence would make the engine slower and the story less true.
- **Explanations drifting from search.** Every new motif adds a way for the panel to say something the search did not conclude.
- **The host.** A tenth of a CPU makes Expert on the public site much weaker than on a laptop. Say so in the interface.
- **Tests.** There are no component tests for the frontend and the motion has mostly been checked by eye.

**Cut from the next version**: bitboards, neural evaluation, multiple search threads, tablebases, a fully 3D interface, per-matchup fight choreography, online play between people, accounts, saved games, a video-capture mode.

## 12. Final recommendation

Four milestones, each shippable on its own.

1. **A stronger engine.** Tapered evaluation with mobility, king safety and passed pawns; SEE; late move reductions; the tactical suite and self-play harness that prove each one. Nothing visible changes except that it plays better.
2. **Difficulty.** The engine-side setting, the three levels, Novice's guarded move choice, the level tests, and the labels in the interface.
3. **Deeper reasoning.** The new Prolog motifs with their tests, wider tactical verification, principal-variation analysis, and experiments C and D run and reported.
4. **Showcase.** The guided demo, the "why this move" replay, checkmate and promotion animations, the Minimal/Expressive switch, the best-move arrow in 3D, and the benchmark page.

The order is deliberate: strength first, because every later feature (difficulty, explanation, demo) is more convincing on top of an engine that plays well.

## Milestone 1: results

Built: mobility, rooks on open files and king shelter in the evaluation; static exchange evaluation; late move reductions; aspiration windows; delta pruning in quiescence. Each can be switched off, so one build can play the first engine against the current one (`engine/tests/selfplay.lisp`).

All figures below are *(measured)* on one desktop, with other programs running.

**Strength.** The current engine against the first engine, 100 ms per move, 12 openings each played with both colours:

| Match | Games | Wins | Draws | Losses | Points |
| --- | --- | --- | --- | --- | --- |
| Current against first engine | 96 | 49 | 21 | 26 | 62.0% |
| Current against itself without the new evaluation terms | 72 | 30 | 26 | 16 | 59.7% |

62% of the points is a real but modest gain, roughly 85 rating points. With 96 games the margin of error is about five percentage points either way, so "clearly better" is supported and a precise figure is not.

**Speed to depth.** Over seven test positions the current engine reaches depth 7 in 2.7 s against 8.8 s, about 3.2 times faster, by searching far fewer positions. It examines each position more slowly: roughly 150,000 to 200,000 positions a second, down from about 500,000, because the evaluation does more work.

**Single features**, each alone against the first engine, were run for only 24 games apiece. Those samples are too small to rank the features and are not reported as findings. The one question worth answering, whether the heavier evaluation pays for its cost, got its own larger match (second row above), and it does.

**Not done from the milestone list:** a dedicated tactical test suite (self-play and the existing tactical checks were used instead), transposition-table ageing, and draw awareness for trivial endings.

**A side effect to know about:** root ordering hints from Prolog used to change only the node count. With late move reductions, move order also decides which moves are searched less deeply, so hints can now occasionally change the score at a fixed depth. The benchmark's wording was updated to say so.
