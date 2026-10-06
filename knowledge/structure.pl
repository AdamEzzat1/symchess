/*  structure.pl -- strategic / structural features.

      open_file(File)
      semi_open_file(Color, File)        Color has no pawn there, the enemy does
      passed_pawn(Color, Sq)
      isolated_pawn(Color, Sq)
      doubled_pawns(Color, File, [Sq, ...])
      weak_square(Owner, Sq, SupportSq)  a hole in Owner's camp that an enemy
                                         pawn on SupportSq already controls
      king_shield(Color, KingSq, [MissingFile, ...])
*/

:- module(structure,
          [ open_file/2,
            semi_open_file/2,
            passed_pawn/2,
            isolated_pawn/2,
            doubled_pawns/2,
            weak_square/2,
            king_shield/2,
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

passed_pawn(Ctx, passed_pawn(C, Sq)) :-
    piece(Ctx, C, pawn, Sq),
    is_passed(Ctx, C, Sq).

isolated_pawn(Ctx, isolated_pawn(C, F/R)) :-
    piece(Ctx, C, pawn, F/R),
    \+ ( piece(Ctx, C, pawn, F1/_), abs(F1 - F) =:= 1 ).

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
