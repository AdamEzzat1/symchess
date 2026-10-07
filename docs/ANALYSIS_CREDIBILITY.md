# Analysis credibility

SymChess explains its moves. This document is about whether those explanations are right, how that was measured, and where they are still wrong.

Most chess programs are tested on one thing: do they play good moves. SymChess makes a second kind of claim ("this knight is pinned", "the search confirmed this fork"), so it needs a second kind of test. The benchmark here checks the claims themselves against positions whose answers were written down by hand.

Run it with:

```
sbcl --script engine/tests/credibility.lisp            the report
sbcl --script engine/tests/credibility.lisp deep       also check the move labels with a depth-10 search
sbcl --script engine/tests/credibility.lisp no-prolog  what is left when Prolog cannot be started
```

## Five things that are kept apart

| Measure | Question | Who answers it | Measured here |
| --- | --- | --- | --- |
| Motif accuracy | Does Prolog report the tactical facts that are really in the position, and no others? | Prolog | Yes |
| Move accuracy | Does the search play a correct move at Club level's limits? | Lisp | Yes |
| Explanation accuracy | Does the explanation give each idea the right status, and is every "confirmed" backed by the search's own line? | Lisp, from search and Prolog data | Yes |
| Search strength | Does the engine win games? | Lisp | No: see the self-play results in `NEXT_STAGE.md` |
| Presentation | Does the screen show only what the engine sent? | React | No: covered by the frontend's stale-state tests |

A program can be good at one of these and bad at another. An engine can find the right move and describe it wrongly; a rule can spot a real pin in a position where the engine then blunders. Reporting one number for all of it would hide exactly the failures worth knowing about.

## The labelled positions

`engine/tests/credibility-positions.lisp` holds 50 positions in ten groups: pins, forks, skewers, discovered attacks, overloaded defenders, hanging pieces, losing captures, quiet tactical moves, defensive moves, and ordinary positions used as controls.

Each position carries:

- **Every tactical fact that is really there**, for nine kinds of fact: pin, skewer, fork, hanging, threatened, overloaded, discovered attack, pinned defender, trapped. The list is exhaustive, so anything else Prolog reports of those kinds counts against it. This is what makes false positives countable.
- **The correct move or moves**, where there is one, or a move that must not be played.
- **The status the explanation must give** a named idea: confirmed, unconfirmed or overruled.

The file states what each kind of fact is taken to mean. For example, "hanging" means an enemy piece could *legally* take it and nothing defends it.

There are two sets:

- **Development set, 39 positions.** The rules were corrected against these, so a perfect score on them proves little.
- **Held-out set, 11 positions.** Written after the rules were frozen, labelled before being run, and no rule was changed afterwards. These are the fairer test.

## Results

All figures are *(measured)*, at depth 6 with a 2-second limit, which is what Club level gets.

### Motif accuracy

"Precision" is the share of reported facts that were really there. "Recall" is the share of real facts that were reported.

| Set | Rules | Real facts found | Reported but not there | Missed | Precision | Recall |
| --- | --- | --- | --- | --- | --- | --- |
| Development (39) | Before this milestone | 41 | 5 | 0 | 89.1% | 100% |
| Development (39) | After | 41 | 0 | 0 | 100% | 100% |
| Held-out (11) | Before this milestone | 17 | 1 | 1 | 94.4% | 94.4% |
| Held-out (11) | After | 17 | 0 | 1 | 100% | 94.4% |

By kind, after the corrections, both sets together: pin 15 of 16 found; hanging 23 of 23; threatened 7 of 7; discovered attack 4 of 4; skewer, fork and overloaded 2 of 2 each; trapped 2 of 2; pinned defender 1 of 1. No false reports of any kind.

**What was wrong, and was fixed.** Four faults, each of which produced a confident sentence about something that was not true:

1. *A pinned piece counted as an attacker.* A knight pinned to its own king was said to leave an enemy rook "hanging", though taking it was illegal. The rule now knows that a piece pinned to its king can only capture along the line of the pin.
2. *A pinned piece reported as a discovered attack.* A knight standing in front of its own queen, facing an enemy bishop, was described as ready to "uncover an attack". Moving it would have lost the queen. That is a pin on the knight, and is now reported only as one.
3. *A pawn "pinned" along its own file.* A pawn between an enemy queen and its own rook was called pinned, though a pawn advancing stays on the file and uncovers nothing.
4. *A skewer where the piece in front could simply take the attacker.* Found in the project's own unit test, whose example position turned out to be a false skewer.

**A check that needs no labels.** Whenever Prolog says an enemy piece is hanging, the benchmark asks the Lisp engine whether a legal capture of it wins material by the exchange count. Before the fixes: 9 of 11 across both sets. After: 9 of 9. The two that failed were the pinned-attacker cases above.

**What is still missed.** One held-out position: a knight that cannot move because the queen would then take an undefended bishop behind it. The pin rule only looks for a *more valuable* piece behind, and a bishop is not worth more than a knight. It is a real pin and the rule does not see it. This was left unfixed on purpose, so that the held-out set stays a set the rules were not adjusted to.

### Move accuracy

| Set | Positions with a labelled move | Correct |
| --- | --- | --- |
| Development | 20 | 20 |
| Held-out | 5 | 4 |

The held-out miss: with a free pawn to take, the engine moved its king toward the centre first. The pawn cannot escape and the position is still won, but it did not play the labelled move, and a depth-10 search made the same choice. It is recorded as a miss.

All five "losing capture" positions were handled correctly: the engine declined each of them.

### Explanation accuracy

| Check | Result |
| --- | --- |
| Labelled statuses matched (development) | 9 of 9 |
| Labelled statuses matched (held-out) | 3 of 3 |
| "Confirmed" sentences backed by the search's own line | 18 of 18 |

The last row is a stricter test than the engine applies to itself. The engine marks a fork "confirmed" if its expected line later captures one of the forked pieces. The benchmark asks independently whether that line ends at least a pawn ahead or in mate. No sentence called confirmed failed that test.

One case shows the status doing its job. A pawn advance forks a knight and a bishop, but the bishop escapes with a check and the knight then moves away. The engine labelled the fork "unconfirmed: treat this as a threat, not a win". The label written beforehand said "confirmed", and was wrong.

### "Why not this move?" ratings

Added in milestone 7. For every position with a labelled move, the benchmark asks the engine about that move and checks the rating it gives.

| Check | Development | Held-out |
| --- | --- | --- |
| A move to avoid is rated a mistake, a blunder or a missed chance; a best move is rated best or about as good | 20 of 20 | 5 of 5 |
| A Prolog warning is called confirmed only where the search also rates the move worse | 4 of 4 | none arose |

"Missed chance" was added after the labels were written, and the check was widened to accept it for one position. See `WORKBENCH_PLAN.md`, section 9.

### Tracing, and where Prolog and the search differ

Added in milestone 8. Every sentence of every explanation and comparison in the benchmark is checked for a rule that is in the index, a check with a stated basis (unless it is a plain measurement), and cited facts that exist in that position.

| Check | Development | Held-out |
| --- | --- | --- |
| Sentences that can be followed back | 266 of 266 | 80 of 80 |
| Prolog's top-ranked move was the search's move | 10 of 20 | 2 of 5 |
| Where they differed and a best move is labelled, the search's move was a labelled one | 6 of 6 | 2 of 3 |
| The same, Prolog's top move | 1 of 6 | 2 of 3 |

The first row shows the mechanism has no gaps. It says nothing about whether an explanation is right; the earlier sections do that. The others measure Prolog's unsearched ranking against the search. See `WORKBENCH_PLAN.md`, section 10.

### A second held-out set

Added in milestone 9: 16 positions, labelled before any rule was changed and before any was run. Four sit at the edge of the pin rule, four are endings, three are mates and sacrifices, and five are crowded opening positions with every tactical fact labelled.

Run against the rules as they stood, it found the pin it was written to probe (13 of 14 real facts found) and one fault that was not predicted: a warning about a mating queen sacrifice was called "confirmed". Both were then fixed, so for those two rules this set is no longer untouched.

Current figures, from `results/credibility.json`:

| Measure | Development (39) | Held-out (11) | Second held-out (16) |
| --- | --- | --- | --- |
| Tactical facts reported that were really there | 41 of 41 | 18 of 18 | 14 of 15 |
| Real tactical facts that were found | 41 of 41 | 18 of 18 | 14 of 14 |
| Right move played at Club level | 20 of 20 | 4 of 5 | 11 of 11 |
| Explanation gave the labelled status | 9 of 9 | 3 of 3 | 8 of 8 |
| "Why not?" rating matches the label | 20 of 20 | 5 of 5 | 12 of 12 |
| Sentences that can be followed back | 266 of 266 | 80 of 80 | 147 of 147 |
| Prolog's top-ranked move was the search's | 10 of 20 | 2 of 5 | 7 of 11 |

When this was first measured the last column showed one fact that was not there: a bishop in front of its unguarded partner, which could step aside and guard it. The rule read lines and not moves, so it called that a pin. The limitations pass that followed fixed it by checking such a pin against the legal moves Lisp supplies, and the table above is from after that fix. The set has now been used to correct the rules twice and is no longer a held-out result; see `LIMITATIONS.md`.

### Without Prolog

With Prolog unavailable the benchmark still runs. It reports that motif and explanation accuracy were not measured, and gives the same move accuracy (20 of 20 and 4 of 5), because the search never depended on Prolog.

## The claims, set before the run

| Claim | Result |
| --- | --- |
| Motif precision at least 90%, recall at least 80% | Not met at the start on the development set (89.1% precision). Met after the fixes, and met on the held-out set: 100% precision and 94.4% recall, from 17 facts. |
| No "confirmed" without the search line delivering it | Met: 18 of 18. |
| Club level plays the labelled move in at least 80% of positions | Met: 20 of 20, and 4 of 5 held-out. |

## How far to trust these numbers

- **The sets are small.** Eighteen facts in the held-out set means one miss moves recall by more than five points. Counts are given beside every percentage for that reason.
- **The positions are mostly sparse.** Many were built to show one idea with few pieces. Crowded middlegame positions, where rules interact, are under-represented, so the real false-report rate in play is probably higher than zero.
- **The labels are one person's.** They were written before running the rules and every disagreement was examined by hand. That examination also found the labels wrong several times: six "best moves" were mistaken or not uniquely best and were corrected or removed after the engine and a deeper search disagreed, and four positions had real facts missing from their labels (pins on the pawn in front of a castled king, an undefended pawn). The labeller and the rule-writer are the same, so shared blind spots are possible.
- **A perfect development score is expected**, not earned. Only the held-out figures and the before-and-after comparison say anything.
- **Facts are judged true or false, not useful or useless.** A discovered attack that exists but wins nothing counts as correct here. Whether a fact is *worth saying* is a different question that this benchmark does not answer.

## What is still not modelled

- A pin against an undefended piece of equal value (the held-out miss).
- Defenders that are themselves pinned are reported by the separate "pinned defender" fact, but the "hanging" rule does not use it.
- The exchange count in the Lisp engine treats a pinned defender as a real defender. This is pinned down by a test so it cannot change unnoticed.
- "Trapped" is judged by attacked squares and then, for the side to move, checked against the legal moves Lisp supplies; a discovered attack likewise. For the other side both are still geometric. Each fact says how it was checked.
- A piece pinned to its king is no longer counted as attacking or defending off its line. That made one more fact true in the development set (the knight on d5 in `hanging-defender-is-pinned`), and the label was corrected to include it.
- Nothing here measures whether the *plans* Prolog suggests are good.

## Why this matters for the project

The promise of a symbolic layer is that its statements can be read, and therefore checked. This is the check. It found four ways the program had been saying untrue things with complete confidence, fixed them, and left a tool that will catch the next one. The counterfactual ("why not this move?") and reasoning-graph work proposed for later would otherwise have been built on those faults.
