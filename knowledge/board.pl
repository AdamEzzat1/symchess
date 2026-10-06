/*  board.pl -- position context and attack geometry.

    A position arrives from Lisp as
        pos(Side, [p(Color, Type, SquareAtom), ...])
    and is turned once into an immutable context
        ctx(Side, Pieces, Assoc, Attacks)
    Pieces  : [p(Color, Type, File/Rank), ...]   (File, Rank in 1..8)
    Assoc   : File/Rank -> Color-Type            (O(log n) lookup)
    Attacks : [a(Color, Type, From, To), ...]    every square each piece hits

    Nothing is asserted: every predicate takes the context explicitly, so the
    root position and all "position after move M" contexts coexist safely.

    "Attack" here is pure geometry: a piece attacks a square whether that
    square is empty, holds an enemy (a threat) or a friend (a defence). It
    deliberately ignores pins, so a pinned defender still counts. That
    limitation is documented in docs/ARCHITECTURE.md (Chess Knowledge Layer).
*/

:- module(board,
          [ build_ctx/2,
            ctx_side/2,
            ctx_assoc/2,
            piece/4,              % piece(Ctx, Color, Type, Sq)
            at/4,                 % at(Ctx, Sq, Color, Type)
            attack/5,             % attack(Ctx, Color, Type, From, To)
            attacked_by/3,        % attacked_by(Ctx, Color, Sq)
            attackers/4,          % attackers(Ctx, Color, Sq, [Type-From, ...])
            first_on_ray/5,
            slider_dir/2,
            sq_atom/2,
            opponent/2,
            value/2,
            rel_rank/3,
            file_letter/2
          ]).

:- use_module(library(assoc)).
:- use_module(library(lists)).

opponent(white, black).
opponent(black, white).

%   Piece values in pawns. The king's value is only ever used for comparisons.
value(pawn, 1).
value(knight, 3).
value(bishop, 3).
value(rook, 5).
value(queen, 9).
value(king, 100).

%!  sq_atom(?File/Rank, ?Atom) is det.
%   e4 <-> 5/4.
sq_atom(F/R, Atom) :-
    atom(Atom), !,
    atom_codes(Atom, [FC, RC]),
    F is FC - 0'a + 1,
    R is RC - 0'0,
    on_board(F/R).
sq_atom(F/R, Atom) :-
    FC is F + 0'a - 1,
    RC is R + 0'0,
    atom_codes(Atom, [FC, RC]).

file_letter(F, Letter) :-
    C is F + 0'a - 1,
    char_code(Letter, C).

on_board(F/R) :- F >= 1, F =< 8, R >= 1, R =< 8.

%!  rel_rank(+Color, +Rank, -Relative) is det.
%   Rank counted from Color's own back rank (1) to the far side (8).
rel_rank(white, R, R).
rel_rank(black, R, RR) :-
    (   nonvar(R)
    ->  RR is 9 - R
    ;   R is 9 - RR
    ).

build_ctx(pos(Side, Raw), ctx(Side, Pieces, Assoc, Attacks)) :-
    maplist(norm_piece, Raw, Pieces),
    findall(Sq-(C-T), member(p(C, T, Sq), Pieces), Pairs),
    list_to_assoc(Pairs, Assoc),
    findall(a(C, T, From, To),
            ( member(p(C, T, From), Pieces),
              attack_from(T, C, Assoc, From, To)
            ),
            Attacks).

norm_piece(p(C, T, Atom), p(C, T, Sq)) :- sq_atom(Sq, Atom).

ctx_side(ctx(Side, _, _, _), Side).
ctx_assoc(ctx(_, _, Assoc, _), Assoc).

piece(ctx(_, Pieces, _, _), C, T, Sq) :- member(p(C, T, Sq), Pieces).

at(ctx(_, _, Assoc, _), Sq, C, T) :- get_assoc(Sq, Assoc, C-T).

attack(ctx(_, _, _, Attacks), C, T, From, To) :- member(a(C, T, From, To), Attacks).

attacked_by(Ctx, C, Sq) :- attack(Ctx, C, _, _, Sq), !.

attackers(Ctx, C, Sq, List) :- findall(T-From, attack(Ctx, C, T, From, Sq), List).

% ---------------------------------------------------------------- geometry

pawn_dir(white, 1).
pawn_dir(black, -1).

knight_delta(1, 2).   knight_delta(2, 1).   knight_delta(2, -1).  knight_delta(1, -2).
knight_delta(-1, -2). knight_delta(-2, -1). knight_delta(-2, 1).  knight_delta(-1, 2).

diag(1/1).  diag(1/(-1)).  diag((-1)/1).  diag((-1)/(-1)).
orth(1/0).  orth((-1)/0).  orth(0/1).     orth(0/(-1)).

slider_dir(bishop, D) :- diag(D).
slider_dir(rook, D)   :- orth(D).
slider_dir(queen, D)  :- diag(D).
slider_dir(queen, D)  :- orth(D).

attack_from(pawn, C, _, F/R, F1/R1) :-
    pawn_dir(C, D),
    R1 is R + D,
    ( F1 is F - 1 ; F1 is F + 1 ),
    on_board(F1/R1).
attack_from(knight, _, _, F/R, F1/R1) :-
    knight_delta(DF, DR),
    F1 is F + DF, R1 is R + DR,
    on_board(F1/R1).
attack_from(king, _, _, F/R, F1/R1) :-
    ( diag(DF/DR) ; orth(DF/DR) ),
    F1 is F + DF, R1 is R + DR,
    on_board(F1/R1).
attack_from(Slider, _, Assoc, From, To) :-
    slider_dir(Slider, Dir),
    ray(Assoc, From, Dir, To).

%   Squares along a ray, up to and including the first occupied one.
ray(Assoc, F/R, DF/DR, To) :-
    F1 is F + DF, R1 is R + DR,
    on_board(F1/R1),
    (   To = F1/R1
    ;   \+ get_assoc(F1/R1, Assoc, _),
        ray(Assoc, F1/R1, DF/DR, To)
    ).

%!  first_on_ray(+Assoc, +From, +Dir, -Sq, -ColorType) is semidet.
%   The first occupied square walking from From in direction Dir.
first_on_ray(Assoc, F/R, DF/DR, Sq, Piece) :-
    F1 is F + DF, R1 is R + DR,
    on_board(F1/R1),
    (   get_assoc(F1/R1, Assoc, Found)
    ->  Sq = F1/R1, Piece = Found
    ;   first_on_ray(Assoc, F1/R1, DF/DR, Sq, Piece)
    ).
