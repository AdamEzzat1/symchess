# Research notes: what would make SymChess more credible

Written for the limitations pass that followed milestone 9. The question was narrow: given what the project already is (a small classical engine with a rule-based explanation layer), what do people who build and test engines, and people who evaluate explanations, consider sound practice, and where does SymChess fall short of it?

These notes are short on purpose. Each section gives what was read, what it implies here, and what was done about it. A source's summary below is my reading of it, checked against the page or a search summary of it on 2026-10-07; where I only saw a summary and not the page, it says so.

## 1. Testing whether an engine change helps

**Read.** The Chess Programming Wiki's pages on [engine testing](https://chessprogramming.org/Engine_Testing) and test positions (search summaries of both).

- Self-play matches judged by a sequential test (SPRT) are described there as the modern, preferred way to test a strength change. The test fixes two hypotheses about the Elo difference in advance and stops when the evidence favours one.
- A match result is reported with its error margin. The wiki's own example is a difference of 6.7 Elo plus or minus 19.5: a result whose margin is three times its size shows nothing.
- Suites of test positions "have fallen out of favour among top engine developers" for measuring strength, because solving a fixed set is easy to overfit and does not track playing strength well.

**Implies.**

- The 24-game matches in `results/matches.json` cannot rank single features, and the project should keep saying so. That was already the documented position; the research confirms it is the right one.
- A tactical suite is the wrong tool for claiming strength and a perfectly good tool for catching regressions. That is the use made of it here.
- SPRT would be the right way to settle "does feature X help". It needs thousands of fast games. At this engine's speed that is hours per feature.

**Done.** The labelled-move positions became a regression suite inside the engine tests: the full engine at depth 6 must keep solving every one except a named known miss. No strength claim rests on it.

**Not done.** SPRT. It is the recommended next step for anyone who wants to rank the features, and it is written up as such in `docs/LIMITATIONS.md`. Building it without the hours to run it would add machinery and no evidence.

## 2. Transposition table ageing

**Read.** The wiki's material on replacement schemes (search summary) and a TalkChess thread on [replacement strategies](https://talkchess.com/viewtopic.php?p=662296).

- Ageing exists to solve a problem of depth-preferred schemes: a deep entry from an earlier search is never overwritten by shallower entries from the current one, so the table silts up with positions that can no longer occur. An age stamp lets old entries be replaced first.

**Implies.** SymChess's table is always-replace with one entry per slot (`tt-store` in `engine/src/search.lisp`). An old entry is overwritten by the first new position that lands on its slot. The problem ageing solves does not arise.

**Done.** Nothing in the code, deliberately. The limitation "no table ageing" is closed as not applicable, with this reasoning recorded. If the table ever becomes depth-preferred or bucketed, ageing has to come with it.

## 3. UCI

**Read.** The UCI specification as mirrored at [page.mi.fu-berlin.de/block/uci.htm](https://page.mi.fu-berlin.de/block/uci.htm) (search summary of the `go` and `setoption` sections).

- `go` may carry `wtime`, `btime`, `winc`, `binc` and `movestogo`. Without `movestogo` the game is sudden death.
- Options such as hash size are optional; an engine announces only the ones it has.

**Implies.** To play a timed match against another program, an engine must turn a clock into a time per move without flagging. Pondering and options are not needed for that.

**Done.** `uci-time-for-move` now uses the increment and `movestogo`, and never spends more than half of what is left. The engine still announces no options, which is honest: it has none.

**Not done.** A match against an outside engine. None is installed on this machine and none was downloaded. With the clock handled, a tool such as cutechess-cli can now run one.

## 4. Calling a move a mistake

**Read.** Lichess's page on its [accuracy metric](https://www.lichess.org/page/accuracy) (search summary), and forum descriptions of its move labels.

- Lichess converts an evaluation to a winning chance with a logistic curve, `Win% = 50 + 50 * (2 / (1 + exp(-0.00368208 * centipawns)) - 1)`, and judges a move by the winning chance it gave up, not by raw centipawns. Losing a pawn's worth when already winning by a queen costs almost nothing on that scale.
- Its labels come from a deep search by a very strong engine. A forum summary gives the cut-offs as roughly 50, 100 and 300 centipawns for inaccuracy, mistake and blunder, and says they are relaxed in clearly won positions. I did not verify those figures against Lichess's source.

**Implies.** Two things SymChess was doing were unsound.

- It attached the words "mistake" and "blunder" to the opinion of a depth-5 or depth-6 search. Those words, on a chess site, carry the authority of a search several times deeper by a far stronger program. SymChess had not earned them, and its marking of Morphy's 10.Nxb5 showed why.
- It judged by raw centipawns. The "missed chance" band added in milestone 7 was a patch for the same problem the winning-chance scale solves properly.

**Done.** The wording changed everywhere a rating is shown: "At depth 6 the search prefers X and scores Y about 1.9 pawns lower", with a caution attached to every rating against a move ("a depth-6 preference, not proof of a mistake"; for a missed chance, "a sacrifice or a slow plan that pays off beyond 6 plies looks exactly like this"). The badges now read "lower at depth 6", not "mistake".

**Not done.** Moving the bands to a winning-chance scale. It is the better design, and it would change every recorded rating figure, so it belongs in its own change with its own measurement.

## 5. Evaluating explanations

**Read.** Search summaries of Jacovi and Goldberg, [Towards Faithfully Interpretable NLP Systems](https://alphaxiv.org/abs/2004.03685), and of a systematic review of evaluation methods for explainable AI, [From Anecdotal Evidence to Quantitative Evaluation Methods](https://arxiv.org/pdf/2201.08164).

- They separate *plausibility* (does the explanation convince a person) from *faithfulness* (does it report what the system actually did). A plausible explanation is not thereby a faithful one, and checking that an explanation "looks reasonable" measures the first, not the second.
- The review's complaint about the field is that explanations are too often shown with a few persuasive examples and not measured.

**Implies.** This is the frame SymChess's own design needed a name for.

- Its search sentences are faithful by construction: they are numbers the search returned.
- Its Prolog sentences are *not* explanations of the search. The search does not use Prolog. They are a second opinion, and the status on each (confirmed, unconfirmed, overruled) is the honest statement of how that opinion relates to what the search found. Presenting them as "why the engine played this" would be plausible and unfaithful.
- The benchmark measures the right things in these terms: whether Prolog's facts are true of the position (precision and recall against labels), and whether a "confirmed" really is backed by the search's line.

**Done.** The README and architecture notes now say this in so many words. No code change: the design already kept the two apart, which is the main thing the project has to show.

## 6. What makes the project legible

No source consulted; this is judgement, and is labelled as such.

- A reviewer gives a repository a few minutes. What they can check quickly is worth more than what they are told: a results page whose figures name the run that produced them, a test count, a command that reproduces a table.
- Documented limits read as competence only if they are specific and current. A stale list of limits reads as neglect.

**Done.** `docs/LIMITATIONS.md` is now the single register of limits, each marked closed, improved, open or deferred, with the reason. `engine/tests/experiment.lisp verify` checks that the recorded results were made by the sources in the repository. Screenshots of the main views are in `docs/screenshots/`.

## 7. Ideas considered and rejected

| Idea | Why not |
| --- | --- |
| A neural evaluator, or an LLM to write the explanations | Outside the project's identity, and an LLM's explanation would be plausible without being faithful, which is the exact failure section 5 describes |
| Opening book and endgame tablebases | Would raise playing strength and say nothing about search or explanation, which is what the project is about |
| Full parity for the 3D board | Large, and the precise overlays are the point of the flat board |
| Every missing motif (minority attack, opposition, wrong-coloured bishop) | Milestone 5 and 9 both found faults in existing rules. More rules before more labelled positions would add claims faster than the means to check them |
| Moving the fact comparison from Lisp to Prolog | It compares two lists by key. Nothing would become clearer or more correct |
| Using Prolog's ranking to order the search again | Measured three times now (milestone 3, and twice in milestone 9). It does not help and at short time controls it loses badly |
| Elo figures | Nothing here supports one. Self-play percentages against the project's own earlier version are what was measured, and that is what is reported |
