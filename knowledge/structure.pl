/*  structure.pl -- strategic / structural features.

      open_file(File)
      semi_open_file(Color, File)        Color has no pawn there, the enemy does
      passed_pawn(Color, Sq)
      isolated_pawn(Color, Sq)
      doubled_pawns(Color, File, [Sq, ...])
      weak_square(Owner, Sq, SupportSq)  a hole in Owner's camp that an enemy
                                         pawn on SupportSq already controls
      king_shield(Color, KingSq, [MissingFile, ...])
      weak_back_rank(Color, KingSq)      no escape square, no heavy piece on guard
      outpost_piece(Color, Type, Sq, SupportSq)
      backward_pawn(Color, Sq)
      rook_on_seventh(Color, Sq)
      pawn_majority(Color, Wing, [Sq, ...], EnemyCount)
      pawn_break(Color, From, To, TargetSq)   for the side to move only
      unstoppable_pawn(Color, Sq)        the rule of the square
*/

:- module(structure,
          [ open_file/2,
            semi_open_file/2,
            passed_pawn/2,
            isolated_pawn/2,
            doubled_pawns/2,
            weak_square/2,
            king_shield/2,
            weak_back_rank/2,
            outpost_piece/2,
            backward_pawn/2,
            rook_on_seventh/2,
            pawn_majority/2,
            pawn_break/2,
            unstoppable_pawn/2,
            is_open_file/2,
            is_semi_open_file/3,
            is_passed/3,
            is_weak_square/4
          ]).

:- use_module(library(lists)).
:- use_module(board).

has_heavy_piece(Ctx, C) :-
    ( piece(Ctx, C, rook, _) ; piece(Ctx, C, queen, _) ), !.

is_open_file(Ctx, F) :- \+ piece(Ctx, _, pawn, F/_).

is_semi_open_file(Ctx, C, F) :-
    \+ piece(Ctx, C, pawn, F/_),
    opponent(C, O),
    piece(Ctx, O, pawn, F/_), !.

%   Files only matter while someone still has a rook or queen to put on them.
%   With no pawns left at all every file is "open" and the fact says nothing.
open_file(Ctx, open_file(F)) :-
    once(( has_heavy_piece(Ctx, white) ; has_heavy_piece(Ctx, black) )),
    once(piece(Ctx, _, pawn, _)),
    between(1, 8, F),
    is_open_file(Ctx, F).

%   A file with no pawn of one colour and at least one of the other, reported
%   while that colour still has a rook or queen to use it.
semi_open_file(Ctx, semi_open_file(C, F)) :-
    opponent(C, _),
    has_heavy_piece(Ctx, C),
    between(1, 8, F),
    is_semi_open_file(Ctx, C, F).

is_passed(Ctx, C, F/R) :-
    opponent(C, O),
    \+ ( piece(Ctx, O, pawn, F1/R1),
         abs(F1 - F) =< 1,
         ahead(C, R, R1)
       ).

ahead(white, R, R1) :- R1 > R.
ahead(black, R, R1) :- R1 < R.

%   A pawn with no enemy pawn ahead of it on its own file or either file beside it.
passed_pawn(Ctx, passed_pawn(C, Sq)) :-
    piece(Ctx, C, pawn, Sq),
    is_passed(Ctx, C, Sq).

%   A pawn with no friendly pawn on either neighbouring file.
isolated_pawn(Ctx, isolated_pawn(C, F/R)) :-
    piece(Ctx, C, pawn, F/R),
    \+ ( piece(Ctx, C, pawn, F1/_), abs(F1 - F) =:= 1 ).

%   Two or more pawns of one colour on the same file.
doubled_pawns(Ctx, doubled_pawns(C, F, Sqs)) :-
    opponent(C, _),
    between(1, 8, F),
    findall(F/R, piece(Ctx, C, pawn, F/R), Sqs),
    Sqs = [_, _|_].

%!  is_weak_square(+Ctx, +Owner, ?Sq, -SupportSq) is nondet.
%   A central square on Owner's 3rd or 4th rank that no Owner pawn can ever
%   attack again, and that an enemy pawn already controls: a classic outpost
%   for the opponent. Requiring the enemy pawn keeps the list short and real.
is_weak_square(Ctx, Owner, F/R, Support) :-
    opponent(Owner, O),
    between(3, 6, F),
    member(RR, [3, 4]),
    rel_rank(Owner, R, RR),
    \+ at(Ctx, F/R, Owner, pawn),
    \+ ( piece(Ctx, Owner, pawn, F1/R1),
         abs(F1 - F) =:= 1,
         rel_rank(Owner, R1, RR1),
         RR1 < RR
       ),
    once(attack(Ctx, O, pawn, Support, F/R)).

%   A central square on the owner's third or fourth rank that no pawn of the
%   owner can ever attack again and that an enemy pawn already controls.
weak_square(Ctx, weak_square(Owner, Sq, Support)) :-
    opponent(Owner, _),
    is_weak_square(Ctx, Owner, Sq, Support).

%   A castled-looking king (wing files, back rank) with pawns missing in front.
king_shield(Ctx, king_shield(C, F/R, Missing)) :-
    piece(Ctx, C, king, F/R),
    rel_rank(C, R, 1),
    memberchk(F, [1, 2, 3, 7, 8]),
    Lo is max(1, F - 1), Hi is min(8, F + 1),
    findall(SF,
            ( between(Lo, Hi, SF),
              \+ ( piece(Ctx, C, pawn, SF/PR),
                   rel_rank(C, PR, PRR),
                   PRR =< 3
                 )
            ),
            Missing),
    Missing \== [].

%   The king sits on its back rank behind a wall of its own men, with no rook
%   or queen of its own on that rank, while the enemy still has a heavy piece:
%   a check along the rank could be mate.
weak_back_rank(Ctx, weak_back_rank(C, F/R)) :-
    piece(Ctx, C, king, F/R),
    rel_rank(C, R, 1),
    opponent(C, O),
    has_heavy_piece(Ctx, O),
    rel_rank(C, R2, 2),
    Lo is max(1, F - 1), Hi is min(8, F + 1),
    forall(between(Lo, Hi, F2), at(Ctx, F2/R2, C, _)),
    \+ ( piece(Ctx, C, T, _/R), memberchk(T, [rook, queen]) ).

%   A knight or bishop already standing on a hole in the enemy camp.
outpost_piece(Ctx, outpost_piece(C, T, Sq, Support)) :-
    piece(Ctx, C, T, Sq),
    memberchk(T, [knight, bishop]),
    opponent(C, O),
    is_weak_square(Ctx, O, Sq, Support).

%   A pawn whose neighbours have all gone past it, so none can support its
%   advance, and whose next square is covered by an enemy pawn.
backward_pawn(Ctx, backward_pawn(C, F/R)) :-
    piece(Ctx, C, pawn, F/R),
    rel_rank(C, R, RR),
    once(( piece(Ctx, C, pawn, F1/_), abs(F1 - F) =:= 1 )),
    \+ ( piece(Ctx, C, pawn, F2/R2),
         abs(F2 - F) =:= 1,
         rel_rank(C, R2, RR2),
         RR2 =< RR
       ),
    step(C, R, R1),
    opponent(C, O),
    once(attack(Ctx, O, pawn, _, F/R1)).

step(white, R, R1) :- R1 is R + 1.
step(black, R, R1) :- R1 is R - 1.

%   A rook on the seventh rank that has something to do there: the enemy king
%   is cut off on its back rank, or there are pawns to attack.
rook_on_seventh(Ctx, rook_on_seventh(C, F/R)) :-
    piece(Ctx, C, rook, F/R),
    rel_rank(C, R, 7),
    opponent(C, O),
    (   piece(Ctx, O, king, _/KR), rel_rank(C, KR, 8)
    ->  true
    ;   piece(Ctx, O, pawn, _/R)
    ->  true
    ).

%   More pawns than the opponent on one wing (the opponent having at least
%   one there): the raw material for a passed pawn.
pawn_majority(Ctx, pawn_majority(C, Wing, Sqs, M)) :-
    opponent(C, O),
    member(Wing-Files, [queenside-[1, 2, 3], kingside-[6, 7, 8]]),
    findall(F/R, ( piece(Ctx, C, pawn, F/R), memberchk(F, Files) ), Sqs),
    findall(x, ( piece(Ctx, O, pawn, F/_), memberchk(F, Files) ), Theirs),
    length(Sqs, N),
    length(Theirs, M),
    M >= 1,
    N > M.

%   The side to move has a centre or bishop-file pawn that can advance (one
%   square, or two from its starting square) to a square from which it
%   attacks an enemy pawn.
pawn_break(Ctx, pawn_break(C, F/R, F/R1, Target)) :-
    ctx_side(Ctx, C),
    piece(Ctx, C, pawn, F/R),
    between(3, 6, F),
    pawn_advance(Ctx, C, F/R, R1),
    opponent(C, O),
    step(C, R1, R2),
    once(( member(DF, [-1, 1]),
           TF is F + DF,
           Target = TF/R2,
           at(Ctx, Target, O, pawn)
         )).

pawn_advance(Ctx, C, F/R, R1) :-
    step(C, R, RA),
    \+ at(Ctx, F/RA, _, _),
    (   R1 = RA
    ;   rel_rank(C, R, 2),
        step(C, RA, R1),
        \+ at(Ctx, F/R1, _, _)
    ).

%   The rule of the square. A passed pawn with a clear path, against a king
%   and pawns only, queens by force when the enemy king is too far away to
%   reach the queening square in time.
unstoppable_pawn(Ctx, unstoppable_pawn(C, F/R)) :-
    piece(Ctx, C, pawn, F/R),
    is_passed(Ctx, C, F/R),
    opponent(C, O),
    \+ ( piece(Ctx, O, T, _), T \== king, T \== pawn ),
    \+ ( piece(Ctx, _, _, F/RA), ahead(C, R, RA) ),
    rel_rank(C, R, RR0),
    RR is max(RR0, 3),                   % from its starting square it may jump two
    Moves is 8 - RR,
    rel_rank(C, QR, 8),
    piece(Ctx, O, king, KF/KR),
    KingMoves is max(abs(KF - F), abs(KR - QR)),
    ctx_side(Ctx, Side),
    (   Side == C
    ->  KingMoves > Moves
    ;   KingMoves - 1 > Moves
    ).
