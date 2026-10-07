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
      battery(Color, FrontType, FrontSq, BackType, BackSq, TargetType, TargetSq)
      discovered_attack(Color, MaskType, MaskSq, SliderType, SliderSq, TargetType, TargetSq)
      pinned_defender(Owner, Type, Sq, GuardedType, GuardedSq)
      trapped(Owner, Type, Sq, AttackerType, AttackerSq)

    All of these read attack geometry only. None of them generates moves:
    "where could this piece go" below means "which squares does it attack",
    so lines opened by the move itself are not accounted for. One piece of
    legality is modelled, because leaving it out produced false reports: a
    piece pinned to its own king cannot capture off the pin line, so it does
    not make an enemy piece "hanging" (see can_capture/5).
*/

:- module(tactics,
          [ check/2,
            pin/2,
            skewer/2,
            fork/2,
            hanging/2,
            threatened/2,
            overloaded/2,
            battery/2,
            discovered_attack/2,
            pinned_defender/2,
            trapped/2,
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
    pin_kind(Ctx, C, PT, PSq, T, Sq, BT, BSq, Kind),
    \+ harmless_pin(Kind, T, Dir).

%   A pawn on a file can still advance along it, so "pinning" it to a piece
%   behind it costs it nothing. (Pinned to the king it still matters: it may
%   not capture sideways.)
harmless_pin(relative, pawn, 0/_).

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
    ( VB > VP ; \+ attacked_by(Ctx, C, BSq) ),
    % ...and the piece in front must not simply be able to take the attacker for nothing
    \+ ( attack(Ctx, C, FT, FSq, PSq), \+ attacked_by(Ctx, PC, PSq) ).

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

%!  can_capture(+Ctx, +Color, -Type, -From, +Sq) is nondet.
%   Color's piece on From attacks Sq and is not stopped from taking there by
%   an absolute pin: a piece pinned to its king may only move along the line
%   of the pin.
can_capture(Ctx, C, T, From, Sq) :-
    attack(Ctx, C, T, From, Sq),
    \+ pinned_away_from(Ctx, From, Sq).

pinned_away_from(Ctx, From, Sq) :-
    pin(Ctx, pin(absolute, _, _, PSq, _, From, _, _)),
    \+ collinear(PSq, From, Sq).

is_hanging(Ctx, C, T, Sq) :-
    T \== king,
    opponent(C, O),
    \+ attacked_by(Ctx, C, Sq),
    once(can_capture(Ctx, O, _, _, Sq)).

hanging(Ctx, hanging(C, T, Sq, Attackers)) :-
    piece(Ctx, C, T, Sq),
    is_hanging(Ctx, C, T, Sq),
    opponent(C, O),
    findall(AT-ASq, can_capture(Ctx, O, AT, ASq, Sq), Attackers).

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

%   Two line pieces of one colour, one behind the other on a line both of them
%   move along, bearing on an enemy piece. Without a target (a queen and rook
%   side by side on the back rank, say) it is not worth reporting.
battery(Ctx, battery(C, FT, FSq, BT, BSq, TT, TSq)) :-
    piece(Ctx, C, BT, BSq),
    slider_dir(BT, Dir),
    toward_enemy(C, Dir),
    ctx_assoc(Ctx, Assoc),
    first_on_ray(Assoc, BSq, Dir, FSq, C-FT),
    once(slider_dir(FT, Dir)),
    first_on_ray(Assoc, FSq, Dir, TSq, O-TT),
    opponent(C, O).

toward_enemy(white, _/DR) :- DR > 0, !.
toward_enemy(black, _/DR) :- DR < 0, !.
toward_enemy(_, DF/0) :- DF > 0.

%   A line piece is masked by one of its own men, and behind that man stands
%   an enemy piece worth hitting. If the masking piece moves off the line, the
%   attack appears; if it moves with a threat of its own, both land at once.
discovered_attack(Ctx, discovered_attack(C, MT, MSq, ST, SSq, TT, TSq)) :-
    piece(Ctx, C, ST, SSq),
    slider_dir(ST, Dir),
    ctx_assoc(Ctx, Assoc),
    first_on_ray(Assoc, SSq, Dir, MSq, C-MT),
    \+ slider_dir(MT, Dir),              % that would be a battery, not a mask
    \+ pawn_stays_on_line(MT, Dir),
    first_on_ray(Assoc, MSq, Dir, TSq, O-TT),
    opponent(C, O),
    discovered_target(Ctx, ST, O, TT, TSq),
    \+ target_strikes_first(Ctx, C, ST, SSq, TT, Dir).

%   If the piece behind the mask is itself a line piece on this line, opening
%   the line lets it take the slider. Where that loses material the masking
%   piece is pinned, not poised: no discovered attack.
target_strikes_first(Ctx, C, ST, SSq, TT, Dir) :-
    once(slider_dir(TT, Dir)),
    value(ST, VS), value(TT, VT),
    ( VS > VT ; \+ attacked_by(Ctx, C, SSq) ).

%   A pawn moving straight ahead never leaves its own file.
pawn_stays_on_line(pawn, 0/_).

discovered_target(_, _, _, king, _) :- !.
discovered_target(_, ST, _, TT, _) :- value(TT, VT), value(ST, VS), VT > VS, !.
discovered_target(Ctx, _, O, TT, TSq) :- TT \== pawn, \+ attacked_by(Ctx, O, TSq).

%   A piece pinned to its king is the only defender of an attacked friend, so
%   that friend is really undefended. (If the friend stands on the pin line
%   itself the pinned piece may still recapture along it: not reported.)
pinned_defender(Ctx, pinned_defender(C, T, Sq, GT, GSq)) :-
    pin(Ctx, pin(absolute, PC, _, PSq, T, Sq, _, _)),
    opponent(PC, C),
    piece(Ctx, C, GT, GSq),
    GT \== king,
    GSq \== Sq,
    attacked_by(Ctx, PC, GSq),
    attackers(Ctx, C, GSq, [_-Sq]),
    \+ collinear(PSq, Sq, GSq).

collinear(F1/R1, F2/R2, F3/R3) :-
    (F3 - F2) * (R1 - R2) =:= (R3 - R2) * (F1 - F2).

%   A piece under attack with nowhere safe to go.
trapped(Ctx, trapped(C, T, Sq, AT, ASq)) :-
    piece(Ctx, C, T, Sq),
    memberchk(T, [knight, bishop, rook, queen]),
    opponent(C, O),
    (   threatened_by(Ctx, C, T, Sq, AT, ASq)
    ->  true
    ;   is_hanging(Ctx, C, T, Sq),
        once(attack(Ctx, O, AT, ASq, Sq))
    ),
    \+ ( attack(Ctx, C, T, Sq, To),
         \+ at(Ctx, To, C, _),
         safe_destination(Ctx, C, T, Sq, To)
       ).

%   To is safe for the piece from From: nothing cheaper attacks it, and it is
%   either unattacked or defended by some other friend. An enemy standing on
%   To does not count as attacking To: it would be captured.
safe_destination(Ctx, C, T, From, To) :-
    opponent(C, O),
    value(T, V),
    \+ ( attack(Ctx, O, XT, XSq, To), XSq \== To, value(XT, VX), VX < V ),
    (   \+ ( attack(Ctx, O, _, YSq, To), YSq \== To )
    ->  true
    ;   attack(Ctx, C, _, DSq, To), DSq \== From
    ->  true
    ).
