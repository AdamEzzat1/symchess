/*  render.pl -- turn fact / motif terms into explanation text and
    visualization primitives.

    Visualization primitives are the ONLY thing the frontend draws in analysis
    mode. Each belongs to exactly one fact, so every arrow and highlight on
    the board can be traced back to the rule that produced it.

      arrow(From, To, Style)   ring(Sq, Style)   square(Sq, Style)   file(F, Style)

    fact_use/2 states honestly what each kind of fact is used for:
      explanation   - shown to the user and used to derive plans; no effect on search
      mirrors_eval  - explanation only, but the Lisp evaluator independently
                      scores the same concept numerically
*/

:- module(render,
          [ fact_dict/2,           % fact_dict(+Id-Fact, -Dict)
            motif_dict/2,
            viz_dict/2,
            piece_phrase/4,
            sq_name/2,
            join_and/2
          ]).

:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(board).

sq_name(Sq, Atom) :- sq_atom(Sq, Atom).

cap(white, 'White').
cap(black, 'Black').

%   "white knight on f3"
piece_phrase(C, T, Sq, Phrase) :-
    sq_name(Sq, S),
    format(atom(Phrase), '~w ~w on ~w', [C, T, S]).

join_and([], '').
join_and([A], A) :- !.
join_and([A, B], Out) :- !, format(atom(Out), '~w and ~w', [A, B]).
join_and([A|Rest], Out) :-
    join_and(Rest, Tail),
    format(atom(Out), '~w, ~w', [A, Tail]).

viz_dict(arrow(From, To, Style), _{type:arrow, from:F, to:T, style:Style}) :-
    sq_name(From, F), sq_name(To, T).
viz_dict(ring(Sq, Style), _{type:ring, square:S, style:Style}) :- sq_name(Sq, S).
viz_dict(square(Sq, Style), _{type:square, square:S, style:Style}) :- sq_name(Sq, S).
viz_dict(file(F, Style), _{type:file, file:L, style:Style}) :- file_letter(F, L).

fact_use(passed_pawn, mirrors_eval) :- !.
fact_use(isolated_pawn, mirrors_eval) :- !.
fact_use(doubled_pawns, mirrors_eval) :- !.
fact_use(_, explanation).

fact_dict(Id-Fact,
          _{id:Id, key:Key, kind:Kind, side:Side, squares:Names, text:Text, label:Label,
            viz:VizDicts, use:Use}) :-
    describe(Fact, Kind, Side, Squares, Text, Viz),
    fact_label(Fact, Label),
    maplist(sq_name, Squares, Names),
    fact_key(Kind, Label, Key),
    maplist(viz_dict, Viz, VizDicts),
    fact_use(Kind, Use).

%   fact_key(+Kind, +Label, -Key): an identity for a fact that does not depend
%   on the order facts were found in, so the same fact can be recognised in
%   two different positions ("the knight on c6 is still pinned"). It is the
%   kind of fact and its subject, and deliberately not the other pieces
%   involved: a knight pinned by a bishop on b5 is still the same pinned
%   knight when the bishop steps back to a4. The id (f1, f2...) only means
%   something within one position.
fact_key(Kind, Label, Key) :-
    format(atom(Key), '~w|~w', [Kind, Label]).

%   fact_label(+Fact, -Label): the subject of a fact in three or four words,
%   for compact lists ("black knight c6"). The full sentence stays in `text`.
piece_label(C, T, Sq, Label) :-
    sq_name(Sq, S),
    format(atom(Label), '~w ~w ~w', [C, T, S]).
file_label(F, Label) :-
    file_letter(F, L),
    format(atom(Label), '~w-file', [L]).

fact_label(check(_, KSq, _), Label) :-
    sq_name(KSq, S), format(atom(Label), 'king ~w', [S]).
fact_label(pin(_, PC, _, _, T, Sq, _, _), Label) :-
    opponent(PC, C), piece_label(C, T, Sq, Label).
fact_label(skewer(PC, _, _, FT, FSq, _, _), Label) :-
    opponent(PC, C), piece_label(C, FT, FSq, Label).
fact_label(fork(C, T, From, _), Label) :- piece_label(C, T, From, Label).
fact_label(hanging(C, T, Sq, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(threatened(C, T, Sq, _, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(overloaded(C, T, Sq, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(open_file(F), Label) :- file_label(F, Label).
fact_label(semi_open_file(C, F), Label) :-
    file_label(F, FL), format(atom(Label), '~w for ~w', [FL, C]).
fact_label(passed_pawn(C, Sq), Label) :- piece_label(C, pawn, Sq, Label).
fact_label(isolated_pawn(C, Sq), Label) :- piece_label(C, pawn, Sq, Label).
fact_label(doubled_pawns(C, F, _), Label) :-
    file_label(F, FL), format(atom(Label), '~w pawns ~w', [C, FL]).
fact_label(weak_square(_, Sq, _), Label) :- sq_name(Sq, Label).
fact_label(king_shield(C, KSq, _), Label) :- piece_label(C, king, KSq, Label).
fact_label(battery(C, FT, FSq, _, _, _, _), Label) :- piece_label(C, FT, FSq, Label).
fact_label(discovered_attack(C, MT, MSq, _, _, _, _), Label) :- piece_label(C, MT, MSq, Label).
fact_label(pinned_defender(C, T, Sq, _, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(trapped(C, T, Sq, _, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(weak_back_rank(C, KSq), Label) :- piece_label(C, king, KSq, Label).
fact_label(outpost_piece(C, T, Sq, _), Label) :- piece_label(C, T, Sq, Label).
fact_label(backward_pawn(C, Sq), Label) :- piece_label(C, pawn, Sq, Label).
fact_label(rook_on_seventh(C, Sq), Label) :- piece_label(C, rook, Sq, Label).
fact_label(pawn_majority(C, Wing, _, _), Label) :-
    format(atom(Label), '~w ~w', [C, Wing]).
fact_label(pawn_break(C, From, _, _), Label) :- piece_label(C, pawn, From, Label).
fact_label(unstoppable_pawn(C, Sq), Label) :- piece_label(C, pawn, Sq, Label).

%   describe(+Fact, -Kind, -BenefitingSide, -Squares, -Text, -Viz)

describe(check(C, KSq, Checkers), check, C, [KSq|From], Text, [ring(KSq, check)|Arrows]) :-
    cap(C, Cap), sq_name(KSq, K),
    findall(Sq, member(_-Sq, Checkers), From),
    findall(arrow(Sq, KSq, check), member(Sq, From), Arrows),
    format(atom(Text), '~w is giving check to the king on ~w.', [Cap, K]).

describe(pin(absolute, PC, PT, PSq, T, Sq, _, BSq), pin, PC, [PSq, Sq, BSq], Text,
         [arrow(PSq, BSq, pin), ring(Sq, pin)]) :-
    opponent(PC, C),
    piece_phrase(C, T, Sq, Pinned), sq_name(BSq, B), sq_name(PSq, P),
    format(atom(Text), 'The ~w is pinned to its king on ~w by the ~w on ~w and cannot legally move off that line.',
           [Pinned, B, PT, P]).
describe(pin(relative, PC, PT, PSq, T, Sq, BT, BSq), pin, PC, [PSq, Sq, BSq], Text,
         [arrow(PSq, BSq, pin), ring(Sq, pin)]) :-
    opponent(PC, C),
    piece_phrase(C, T, Sq, Pinned), sq_name(BSq, B), sq_name(PSq, P),
    format(atom(Text), 'The ~w is pinned to the ~w on ~w by the ~w on ~w (relative pin: moving it loses material).',
           [Pinned, BT, B, PT, P]).

describe(skewer(PC, PT, PSq, FT, FSq, BT, BSq), skewer, PC, [PSq, FSq, BSq], Text,
         [arrow(PSq, BSq, skewer), ring(FSq, skewer)]) :-
    piece_phrase(PC, PT, PSq, Attacker), sq_name(FSq, F), sq_name(BSq, B),
    format(atom(Text), 'The ~w skewers the ~w on ~w through to the ~w on ~w.',
           [Attacker, FT, F, BT, B]).

describe(fork(C, T, From, Targets), fork, C, [From|Squares], Text, [ring(From, fork)|Arrows]) :-
    piece_phrase(C, T, From, Forker),
    findall(Sq, member(_-Sq, Targets), Squares),
    findall(arrow(From, Sq, fork), member(Sq, Squares), Arrows),
    findall(P, ( member(TT-Sq, Targets), sq_name(Sq, S), format(atom(P), 'the ~w on ~w', [TT, S]) ),
            Phrases),
    join_and(Phrases, List),
    format(atom(Text), 'The ~w forks ~w.', [Forker, List]).

describe(hanging(C, T, Sq, Attackers), hanging, O, [Sq|From], Text, [ring(Sq, hanging)|Arrows]) :-
    opponent(C, O),
    piece_phrase(C, T, Sq, Piece),
    findall(ASq, member(_-ASq, Attackers), From),
    findall(arrow(ASq, Sq, threat), member(ASq, From), Arrows),
    format(atom(Text), 'The ~w is attacked and has no defender.', [Piece]).

describe(threatened(C, T, Sq, AT, ASq), threatened, O, [Sq, ASq], Text,
         [ring(Sq, threat), arrow(ASq, Sq, threat)]) :-
    opponent(C, O),
    piece_phrase(C, T, Sq, Piece), sq_name(ASq, A),
    format(atom(Text), 'The ~w is attacked by the cheaper ~w on ~w.', [Piece, AT, A]).

describe(overloaded(C, T, Sq, Guarded), overloaded, O, [Sq|Guarded], Text,
         [ring(Sq, overloaded)|Arrows]) :-
    opponent(C, O),
    piece_phrase(C, T, Sq, Piece),
    maplist(sq_name, Guarded, Names),
    join_and(Names, List),
    findall(arrow(Sq, G, defend), member(G, Guarded), Arrows),
    format(atom(Text), 'The ~w is the only defender of ~w: it is overloaded.', [Piece, List]).

describe(open_file(F), open_file, null, [], Text, [file(F, open)]) :-
    file_letter(F, L),
    format(atom(Text), 'The ~w-file is open (no pawns of either colour).', [L]).

describe(semi_open_file(C, F), semi_open_file, C, [], Text, [file(F, semi_open)]) :-
    file_letter(F, L), cap(C, Cap),
    format(atom(Text), 'The ~w-file is semi-open for ~w.', [L, Cap]).

describe(passed_pawn(C, Sq), passed_pawn, C, [Sq], Text, [square(Sq, passed)]) :-
    cap(C, Cap), sq_name(Sq, S),
    format(atom(Text), '~w has a passed pawn on ~w.', [Cap, S]).

describe(isolated_pawn(C, Sq), isolated_pawn, O, [Sq], Text, [square(Sq, weak_pawn)]) :-
    opponent(C, O), sq_name(Sq, S),
    format(atom(Text), 'The ~w pawn on ~w is isolated: no friendly pawn can ever defend it.', [C, S]).

describe(doubled_pawns(C, F, Sqs), doubled_pawns, O, Sqs, Text, Viz) :-
    opponent(C, O), cap(C, Cap), file_letter(F, L),
    findall(square(Sq, weak_pawn), member(Sq, Sqs), Viz),
    format(atom(Text), '~w has doubled pawns on the ~w-file.', [Cap, L]).

describe(weak_square(Owner, Sq, Support), weak_square, O, [Sq, Support], Text,
         [square(Sq, weak), arrow(Support, Sq, support)]) :-
    opponent(Owner, O), cap(Owner, OwnerCap), sq_name(Sq, S), sq_name(Support, P),
    format(atom(Text), '~w is a hole in ~w\'s camp: no ~w pawn can attack it and the ~w pawn on ~w controls it.',
           [S, OwnerCap, Owner, O, P]).

describe(king_shield(C, KSq, Missing), king_shield, O, [KSq], Text, [ring(KSq, king_danger)]) :-
    opponent(C, O), sq_name(KSq, K),
    maplist(file_letter, Missing, Letters),
    join_and(Letters, List),
    format(atom(Text), 'The ~w king on ~w has no pawn cover on the ~w file(s).', [C, K, List]).

describe(battery(C, FT, FSq, BT, BSq, TT, TSq), battery, C, [BSq, FSq, TSq], Text,
         [arrow(BSq, FSq, support), arrow(FSq, TSq, threat)]) :-
    piece_phrase(C, FT, FSq, Front), sq_name(BSq, B), sq_name(TSq, T),
    format(atom(Text), 'The ~w is backed up by the ~w on ~w: together they bear on the ~w on ~w.',
           [Front, BT, B, TT, T]).

describe(discovered_attack(C, MT, MSq, ST, SSq, TT, TSq), discovered_attack, C,
         [MSq, SSq, TSq], Text,
         [arrow(SSq, TSq, threat), ring(MSq, overloaded)]) :-
    piece_phrase(C, MT, MSq, Mask), sq_name(SSq, S), sq_name(TSq, T),
    format(atom(Text), 'If the ~w moves off the line, the ~w on ~w attacks the ~w on ~w (a discovered attack is available).',
           [Mask, ST, S, TT, T]).

describe(pinned_defender(C, T, Sq, GT, GSq), pinned_defender, O, [Sq, GSq], Text,
         [ring(Sq, pin), arrow(Sq, GSq, defend), ring(GSq, hanging)]) :-
    opponent(C, O),
    piece_phrase(C, T, Sq, Defender), sq_name(GSq, G),
    format(atom(Text), 'The ~w is pinned to its king, and it is the only defender of the ~w on ~w.',
           [Defender, GT, G]).

describe(trapped(C, T, Sq, AT, ASq), trapped, O, [Sq, ASq], Text,
         [ring(Sq, hanging), arrow(ASq, Sq, threat)]) :-
    opponent(C, O),
    piece_phrase(C, T, Sq, Piece), sq_name(ASq, A),
    format(atom(Text), 'The ~w is attacked by the ~w on ~w and every square it could go to is covered (judged by attacked squares; pins are not considered).',
           [Piece, AT, A]).

describe(weak_back_rank(C, KSq), weak_back_rank, O, [KSq], Text, [ring(KSq, king_danger)]) :-
    opponent(C, O), sq_name(KSq, K),
    format(atom(Text), 'The ~w king on ~w has no escape square and no rook or queen guarding its back rank: a check along the rank could be mate.',
           [C, K]).

describe(outpost_piece(C, T, Sq, Support), outpost_piece, C, [Sq, Support], Text,
         [ring(Sq, support), arrow(Support, Sq, support)]) :-
    piece_phrase(C, T, Sq, Piece), sq_name(Support, P),
    format(atom(Text), 'The ~w stands on an outpost: no enemy pawn can ever attack it, and the pawn on ~w supports it.',
           [Piece, P]).

describe(backward_pawn(C, Sq), backward_pawn, O, [Sq], Text, [square(Sq, weak_pawn)]) :-
    opponent(C, O), sq_name(Sq, S),
    format(atom(Text), 'The ~w pawn on ~w is backward: its neighbours have gone past it and an enemy pawn covers the square in front.',
           [C, S]).

describe(rook_on_seventh(C, Sq), rook_on_seventh, C, [Sq], Text, [ring(Sq, support)]) :-
    cap(C, Cap), sq_name(Sq, S),
    format(atom(Text), '~w has a rook on ~w, deep in the enemy position.', [Cap, S]).

describe(pawn_majority(C, Wing, Sqs, M), pawn_majority, C, Sqs, Text, Viz) :-
    cap(C, Cap), length(Sqs, N),
    findall(square(Sq, passed), member(Sq, Sqs), Viz),
    format(atom(Text), '~w has a ~w pawn majority, ~d against ~d: the raw material for a passed pawn.',
           [Cap, Wing, N, M]).

describe(pawn_break(C, From, To, Target), pawn_break, C, [From, To, Target], Text,
         [arrow(From, To, plan), ring(Target, plan)]) :-
    cap(C, Cap), sq_name(From, F), sq_name(To, T), sq_name(Target, G),
    format(atom(Text), '~w can advance the pawn from ~w to ~w, challenging the pawn on ~w.',
           [Cap, F, T, G]).

describe(unstoppable_pawn(C, F/R), unstoppable_pawn, C, [F/R], Text,
         [square(F/R, passed), arrow(F/R, F/QR, plan)]) :-
    rel_rank(C, QR, 8),
    sq_name(F/R, S),
    format(atom(Text), 'The ~w pawn on ~w cannot be caught: the enemy king is outside its square and nothing else can stop it.',
           [C, S]).

% ------------------------------------------------------------------ motifs

motif_dict(motif(Kind, Score, Targets, Data),
           _{kind:Kind, score:Score, targets:Names, text:Text}) :-
    maplist(sq_name, Targets, Names),
    motif_text(Kind, Data, Text).

motif_text(gives_check, _, 'Gives check.').
motif_text(captures_hanging, captured(T), Text) :-
    format(atom(Text), 'Captures an undefended ~w.', [T]).
motif_text(wins_exchange, exchange(MT, T), Text) :-
    format(atom(Text), 'Trades up: the ~w takes a ~w.', [MT, T]).
motif_text(creates_fork, fork(T, _, Targets), Text) :-
    findall(P, ( member(TT-Sq, Targets), sq_name(Sq, S), format(atom(P), 'the ~w on ~w', [TT, S]) ),
            Phrases),
    join_and(Phrases, List),
    format(atom(Text), 'The ~w forks ~w.', [T, List]).
motif_text(creates_pin, pin(_, T, Sq, BT, BSq), Text) :-
    sq_name(Sq, S), sq_name(BSq, B),
    format(atom(Text), 'Pins the ~w on ~w against the ~w on ~w.', [T, S, BT, B]).
motif_text(creates_skewer, skewer(FT, FSq, BT, BSq), Text) :-
    sq_name(FSq, F), sq_name(BSq, B),
    format(atom(Text), 'Skewers the ~w on ~w through to the ~w on ~w.', [FT, F, BT, B]).
motif_text(hangs_piece, hangs(T, Sq), Text) :-
    sq_name(Sq, S),
    format(atom(Text), 'the ~w on ~w can be taken for less than it is worth.', [T, S]).
motif_text(leaves_hanging, leaves(T, Sq), Text) :-
    sq_name(Sq, S),
    format(atom(Text), 'the ~w on ~w is left undefended.', [T, S]).
motif_text(rescues, rescues(T, Sq), Text) :-
    sq_name(Sq, S),
    format(atom(Text), 'Moves the attacked ~w away from ~w to a safe square.', [T, S]).
motif_text(occupies_outpost, outpost(T, Sq), Text) :-
    sq_name(Sq, S),
    format(atom(Text), 'Puts a ~w on the outpost ~w, where no enemy pawn can chase it.', [T, S]).
motif_text(rook_to_open_file, file(F, open), Text) :-
    file_letter(F, L),
    format(atom(Text), 'Brings a rook to the open ~w-file.', [L]).
motif_text(rook_to_open_file, file(F, semi_open), Text) :-
    file_letter(F, L),
    format(atom(Text), 'Brings a rook to the semi-open ~w-file.', [L]).
motif_text(pushes_passed_pawn, passed(Sq), Text) :-
    sq_name(Sq, S),
    format(atom(Text), 'Advances the passed pawn to ~w.', [S]).
