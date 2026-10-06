/*  moves.pl -- what a candidate move does, judged by comparing the root
    context with the context AFTER the move.

    Lisp supplies both positions. Prolog never plays a move itself: it only
    reads the move's from/to squares off the UCI atom to know which piece to
    look at. So there is no second move generator to keep in sync.

      motif(Kind, Score, TargetSquares, Data)

    Score is an ordering hint in rough centipawns (negative = warning). It is
    used ONLY to order root moves before the search; it never changes a score
    the search reports.
*/

:- module(moves, [ move_motifs/5 ]).

:- use_module(library(lists)).
:- use_module(library(pairs)).
:- use_module(board).
:- use_module(tactics).
:- use_module(structure).

%!  move_motifs(+Root, +Uci, +After, -Motifs, -Total) is det.
move_motifs(Root, Uci, After, Motifs, Total) :-
    sub_atom(Uci, 0, 2, _, FromAtom),
    sub_atom(Uci, 2, 2, _, ToAtom),
    sq_atom(From, FromAtom),
    sq_atom(To, ToAtom),
    ctx_side(Root, C),
    findall(M, motif(Root, After, C, From, To, M), Motifs),
    findall(S, member(motif(_, S, _, _), Motifs), Scores),
    sum_list(Scores, Total).

captured_value(Root, To, C, V) :-
    opponent(C, O),
    (   at(Root, To, O, T)
    ->  value(T, V)
    ;   V = 0
    ).

motif(_, After, C, _, _, motif(gives_check, 300, [KSq], check)) :-
    opponent(C, O),
    piece(After, O, king, KSq),
    attacked_by(After, C, KSq).

motif(Root, _, C, _, To, motif(captures_hanging, Score, [To], captured(T))) :-
    opponent(C, O),
    at(Root, To, O, T),
    is_hanging(Root, O, T, To),
    value(T, V),
    Score is 150 * V.

motif(Root, _, C, From, To, motif(wins_exchange, Score, [To], exchange(MT, T))) :-
    opponent(C, O),
    at(Root, To, O, T),
    \+ is_hanging(Root, O, T, To),
    at(Root, From, C, MT),
    value(T, VT), value(MT, VM),
    VT > VM,
    Score is 100 * (VT - VM).

motif(_, After, C, _, To, motif(creates_fork, 400, Squares, fork(T, To, Targets))) :-
    at(After, To, C, T),
    fork(After, fork(C, T, To, Targets)),
    pairs_values(Targets, Squares).

%   Only a NEW pin counts: sliding along a line that already pinned the piece
%   (Bb5-a4 against a knight on c6) creates nothing.
motif(Root, After, C, _, To, motif(creates_pin, Score, [Sq], pin(Kind, T, Sq, BT, BSq))) :-
    once(pin(After, pin(Kind, C, _, To, T, Sq, BT, BSq))),
    \+ pin(Root, pin(_, C, _, _, T, Sq, _, _)),
    (   Kind == absolute
    ->  Score = 250
    ;   Score = 180
    ).

motif(Root, After, C, _, To, motif(creates_skewer, 250, [FSq, BSq], skewer(FT, FSq, BT, BSq))) :-
    once(skewer(After, skewer(C, _, To, FT, FSq, BT, BSq))),
    \+ skewer(Root, skewer(C, _, _, FT, FSq, BT, BSq)).

%   The moved piece lands where it can be taken for less than it is worth.
motif(Root, After, C, _, To, motif(hangs_piece, Score, [To], hangs(T, To))) :-
    at(After, To, C, T),
    T \== king,
    once(( is_hanging(After, C, T, To) ; is_threatened(After, C, T, To) )),
    captured_value(Root, To, C, VC),
    value(T, V),
    V > VC,
    Score is -120 * (V - VC).

%   Some other piece is undefended now but was not before (a defender left).
motif(Root, After, C, _, To, motif(leaves_hanging, Score, [Sq], leaves(T, Sq))) :-
    piece(After, C, T, Sq),
    Sq \== To,
    is_hanging(After, C, T, Sq),
    \+ is_hanging(Root, C, T, Sq),
    value(T, V),
    Score is -100 * V.

motif(Root, After, C, From, To, motif(rescues, Score, [From], rescues(T, From))) :-
    at(Root, From, C, T),
    T \== king,
    once(( is_hanging(Root, C, T, From) ; is_threatened(Root, C, T, From) )),
    at(After, To, C, T2),
    \+ is_hanging(After, C, T2, To),
    \+ is_threatened(After, C, T2, To),
    value(T, V),
    Score is 80 * V.

motif(_, After, C, _, To, motif(occupies_outpost, 120, [To], outpost(T, To))) :-
    at(After, To, C, T),
    memberchk(T, [knight, bishop]),
    opponent(C, O),
    once(is_weak_square(After, O, To, _)).

motif(_, After, C, F0/_, F/R, motif(rook_to_open_file, Score, [F/R], file(F, Kind))) :-
    F \== F0,
    at(After, F/R, C, rook),
    (   is_open_file(After, F)
    ->  Score = 80, Kind = open
    ;   is_semi_open_file(After, C, F)
    ->  Score = 50, Kind = semi_open
    ).

motif(Root, After, C, From, To, motif(pushes_passed_pawn, Score, [To], passed(To))) :-
    at(Root, From, C, pawn),
    at(After, To, C, pawn),
    is_passed(After, C, To),
    To = _/R,
    rel_rank(C, R, RR),
    Score is 30 + 15 * RR.
