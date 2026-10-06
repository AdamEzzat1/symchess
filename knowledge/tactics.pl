/*  tactics.pl -- tactical motifs as relations over a position context.

    Every motif is a plain term so it can be tested, rendered and cited:

      check(Checker, KingSq, [Type-From, ...])
      pin(Kind, PinnerColor, PinnerType, PinnerSq, PinnedType, PinnedSq, BackType, BackSq)
            Kind = absolute (back piece is the king) | relative
      skewer(Color, Type, From, FrontType, FrontSq, BackType, BackSq)
      fork(Color, Type, From, [TargetType-TargetSq, ...])
      hanging(Owner, Type, Sq, [AttackerType-From, ...])
      threatened(Owner, Type, Sq, AttackerType, AttackerSq)
      overloaded(Owner, Type, Sq, [GuardedSq, ...])
*/

:- module(tactics,
          [ check/2,
            pin/2,
            skewer/2,
            fork/2,
            hanging/2,
            threatened/2,
            overloaded/2,
            is_hanging/4,
            is_threatened/4,
            safe_piece/4
          ]).

:- use_module(library(lists)).
:- use_module(board).

check(Ctx, check(Checker, KingSq, Checkers)) :-
    piece(Ctx, Owner, king, KingSq),
    opponent(Owner, Checker),
    attackers(Ctx, Checker, KingSq, Checkers),
    Checkers \== [].

%   A slider looks through exactly one enemy piece at a more valuable one.
pin(Ctx, pin(Kind, PC, PT, PSq, T, Sq, BT, BSq)) :-
    piece(Ctx, PC, PT, PSq),
    slider_dir(PT, Dir),
    ctx_assoc(Ctx, Assoc),
    first_on_ray(Assoc, PSq, Dir, Sq, C-T),
    opponent(PC, C),
    T \== king,
    first_on_ray(Assoc, Sq, Dir, BSq, C-BT),
    pin_kind(Ctx, C, PT, PSq, T, Sq, BT, BSq, Kind).

pin_kind(_, _, _, _, _, _, king, _, absolute) :- !.
pin_kind(Ctx, C, PT, PSq, T, Sq, BT, BSq, relative) :-
    value(BT, VB), value(T, VT), value(PT, VP),
    VB > VT,
    % moving the pinned piece must actually cost something
    ( VB > VP ; \+ attacked_by(Ctx, C, BSq) ),
    % ...and the pinned piece must not simply be able to take the pinner
    \+ attack(Ctx, C, T, Sq, PSq).

%   Like a pin, but the valuable piece is in front and must move away.
skewer(Ctx, skewer(PC, PT, PSq, FT, FSq, BT, BSq)) :-
    piece(Ctx, PC, PT, PSq),
    slider_dir(PT, Dir),
    ctx_assoc(Ctx, Assoc),
    first_on_ray(Assoc, PSq, Dir, FSq, C-FT),
    opponent(PC, C),
    first_on_ray(Assoc, FSq, Dir, BSq, C-BT),
    BT \== king, BT \== pawn,
    value(FT, VF), value(BT, VB), value(PT, VP),
    VF > VB, VF > VP,
    ( VB > VP ; \+ attacked_by(Ctx, C, BSq) ).

%   One piece attacks two or more enemy pieces that each matter, and cannot
%   simply be taken for free itself.
fork(Ctx, fork(C, T, From, Targets)) :-
    piece(Ctx, C, T, From),
    T \== king,
    opponent(C, O),
    findall(TT-TSq,
            ( attack(Ctx, C, T, From, TSq),
              at(Ctx, TSq, O, TT),
              fork_target(Ctx, T, O, TT, TSq)
            ),
            Targets),
    Targets = [_, _|_],
    safe_piece(Ctx, C, T, From).

fork_target(_, _, _, king, _) :- !.
fork_target(_, _, _, pawn, _) :- !, fail.
fork_target(_, T, _, TT, _) :- value(TT, VT), value(T, V), VT > V, !.
fork_target(Ctx, _, O, _, TSq) :- \+ attacked_by(Ctx, O, TSq).

%!  safe_piece(+Ctx, +Color, +Type, +Sq) is semidet.
%   Not attacked by anything cheaper, and not attacked at all unless defended.
safe_piece(Ctx, C, T, Sq) :-
    opponent(C, O),
    value(T, V),
    \+ ( attack(Ctx, O, AT, _, Sq), value(AT, VA), VA < V ),
    ( \+ attacked_by(Ctx, O, Sq) ; attacked_by(Ctx, C, Sq) ).

is_hanging(Ctx, C, T, Sq) :-
    T \== king,
    opponent(C, O),
    attacked_by(Ctx, O, Sq),
    \+ attacked_by(Ctx, C, Sq).

hanging(Ctx, hanging(C, T, Sq, Attackers)) :-
    piece(Ctx, C, T, Sq),
    is_hanging(Ctx, C, T, Sq),
    opponent(C, O),
    attackers(Ctx, O, Sq, Attackers).

%   Defended, but attacked by something cheaper: it still has to move.
is_threatened(Ctx, C, T, Sq) :- threatened_by(Ctx, C, T, Sq, _, _), !.

threatened_by(Ctx, C, T, Sq, AT, ASq) :-
    T \== king,
    opponent(C, O),
    value(T, V),
    attack(Ctx, O, AT, ASq, Sq),
    value(AT, VA),
    VA < V.

threatened(Ctx, threatened(C, T, Sq, AT, ASq)) :-
    piece(Ctx, C, T, Sq),
    attacked_by(Ctx, C, Sq),             % defended (otherwise it is "hanging")
    once(threatened_by(Ctx, C, T, Sq, AT, ASq)).

%   A piece that is the only defender of two or more attacked friends.
overloaded(Ctx, overloaded(C, T, Sq, Guarded)) :-
    piece(Ctx, C, T, Sq),
    T \== king,
    opponent(C, O),
    findall(GSq,
            ( piece(Ctx, C, GT, GSq),
              GT \== king, GT \== pawn,
              GSq \== Sq,
              attacked_by(Ctx, O, GSq),
              attackers(Ctx, C, GSq, [_-Sq])
            ),
            Guarded),
    Guarded = [_, _|_].
