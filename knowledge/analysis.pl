/*  analysis.pl -- the three queries the Lisp engine may ask.

      analyze(+Pos, +Moves, -Reply)   root facts, plans, per-move motifs
                                      (each motif cites the facts it rests on)
      inspect(+Pos, +SquareAtom, -Reply)
      root_facts(+Ctx, -IdFacts)      (exported for tests)

    Replies are dicts ready for json_write_dict/3.
*/

:- module(analysis, [ analyze/3, inspect/3, root_facts/2, root_facts/3 ]).

:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(board).
:- use_module(tactics).
:- use_module(structure).
:- use_module(moves).
:- use_module(plans).
:- use_module(render).

root_fact(Ctx, F) :- check(Ctx, F).
root_fact(Ctx, F) :- fork(Ctx, F).
root_fact(Ctx, F) :- pin(Ctx, F).
root_fact(Ctx, F) :- skewer(Ctx, F).
root_fact(Ctx, F) :- hanging(Ctx, F).
root_fact(Ctx, F) :- threatened(Ctx, F).
root_fact(Ctx, F) :- overloaded(Ctx, F).
root_fact(Ctx, F) :- pinned_defender(Ctx, F).
root_fact(Ctx, F) :- trapped(Ctx, F).
root_fact(Ctx, F) :- discovered_attack(Ctx, F).
root_fact(Ctx, F) :- battery(Ctx, F).
root_fact(Ctx, F) :- weak_back_rank(Ctx, F).
root_fact(Ctx, F) :- unstoppable_pawn(Ctx, F).
root_fact(Ctx, F) :- weak_square(Ctx, F).
root_fact(Ctx, F) :- outpost_piece(Ctx, F).
root_fact(Ctx, F) :- rook_on_seventh(Ctx, F).
root_fact(Ctx, F) :- passed_pawn(Ctx, F).
root_fact(Ctx, F) :- pawn_break(Ctx, F).
root_fact(Ctx, F) :- king_shield(Ctx, F).
root_fact(Ctx, F) :- open_file(Ctx, F).
root_fact(Ctx, F) :- semi_open_file(Ctx, F).
root_fact(Ctx, F) :- isolated_pawn(Ctx, F).
root_fact(Ctx, F) :- doubled_pawns(Ctx, F).
root_fact(Ctx, F) :- backward_pawn(Ctx, F).
root_fact(Ctx, F) :- pawn_majority(Ctx, F).

%!  root_facts(+Ctx, -IdFacts) is det.
%   IdFacts = [f1-Fact, f2-Fact, ...]; ids are stable within one reply.
root_facts(Ctx, IdFacts) :-
    root_facts(Ctx, [], IdFacts).

%!  root_facts(+Ctx, +Moves, -IdFacts) is det.
%   As above, minus the facts that the legal moves Lisp supplied show to be
%   false (see refuted/3).
root_facts(Ctx, Moves, IdFacts) :-
    findall(F, ( root_fact(Ctx, F), \+ refuted(Ctx, Moves, F) ), Facts0),
    list_to_set(Facts0, Facts),
    number_facts(Facts, 1, IdFacts).

%!  refuted(+Ctx, +Moves, +Fact) is semidet.
%   The rules read lines of attack. One conclusion they draw is really about
%   moves: "this piece is pinned to a piece of its own value, because if it
%   moves the one behind is lost". That is false if the piece in front has a
%   move that leaves the line and guards its partner from where it lands.
%   Prolog does not generate moves, so it checks this only against moves it
%   was given: Lisp sends every legal move of the side to move with the
%   position it leads to. So the check is made when the pinned side is to
%   move, which is when the pin constrains anything, and not otherwise.
refuted(Ctx, Moves, pin(relative, PC, _, PSq, T, Sq, BT, BSq)) :-
    value(T, V), value(BT, V),
    opponent(PC, C),
    ctx_side(Ctx, C),
    sq_atom(Sq, From),
    member(m(Uci, AfterPos), Moves),
    sub_atom(Uci, 0, 2, _, From),
    build_ctx(AfterPos, After),
    % the line is open now, the partner is still there, and it is guarded
    attack(After, PC, _, PSq, BSq),
    at(After, BSq, C, BT),
    attacked_by(After, C, BSq), !.

number_facts([], _, []).
number_facts([F|Fs], N, [Id-F|Rest]) :-
    format(atom(Id), 'f~d', [N]),
    N1 is N + 1,
    number_facts(Fs, N1, Rest).

analyze(Pos, Moves, _{facts:FactDicts, plans:PlanDicts, moves:MoveDicts}) :-
    build_ctx(Pos, Root),
    root_facts(Root, Moves, IdFacts),
    maplist(fact_dict, IdFacts, FactDicts),
    plans(Root, IdFacts, Plans),
    number_plans(Plans, 1, PlanDicts),
    maplist(move_dict(Root, IdFacts), Moves, MoveDicts).

number_plans([], _, []).
number_plans([plan(Kind, Text, Because, Viz)|Ps], N,
             [_{id:Id, kind:Kind, text:Text, because:Because, viz:VizDicts}|Rest]) :-
    format(atom(Id), 'p~d', [N]),
    maplist(viz_dict, Viz, VizDicts),
    N1 is N + 1,
    number_plans(Ps, N1, Rest).

move_dict(Root, IdFacts, m(Uci, AfterPos), _{uci:Uci, score:Total, motifs:MotifDicts}) :-
    build_ctx(AfterPos, After),
    move_motifs(Root, Uci, After, Motifs, Total),
    ctx_side(Root, Side),
    sub_atom(Uci, 0, 2, _, FromAtom),
    sq_atom(From, FromAtom),
    maplist(motif_entry(Side, From, IdFacts), Motifs, MotifDicts).

%   A motif, with the ids of the facts of this position that it rests on.
motif_entry(Side, From, IdFacts, Motif, Dict) :-
    motif_dict(Motif, Dict0),
    findall(Id,
            ( motif_rests_on(Side, From, Motif, Fact),
              member(Id-Fact, IdFacts)
            ),
            Ids0),
    list_to_set(Ids0, Ids),
    Dict = Dict0.put(facts, Ids).

% ----------------------------------------------------------------- inspect

inspect(Pos, SquareAtom,
        _{square:SquareAtom, piece:Piece, white:White, black:Black,
          attacks:Attacks, lines:Lines, viz:VizDicts}) :-
    build_ctx(Pos, Ctx),
    sq_atom(Sq, SquareAtom),
    controllers(Ctx, white, Sq, WhiteList, White),
    controllers(Ctx, black, Sq, BlackList, Black),
    (   at(Ctx, Sq, C, T)
    ->  Piece = _{color:C, type:T},
        findall(To, attack(Ctx, C, T, Sq, To), Targets0),
        sort(Targets0, Targets),
        maplist(sq_name, Targets, Attacks),
        occupied_report(C, T, SquareAtom, Sq, WhiteList, BlackList, Attacks, Lines, Viz)
    ;   Piece = null,
        Attacks = [],
        empty_report(SquareAtom, Sq, WhiteList, BlackList, Lines, Viz)
    ),
    maplist(viz_dict, Viz, VizDicts).

controllers(Ctx, Color, Sq, List, Dicts) :-
    attackers(Ctx, Color, Sq, List),
    findall(_{type:T, square:Name}, ( member(T-From, List), sq_name(From, Name) ), Dicts).

describe_list(_, [], none) :- !.
describe_list(Color, List, Text) :-
    findall(P, ( member(T-From, List), sq_name(From, N), format(atom(P), '~w ~w on ~w', [Color, T, N]) ),
            Phrases),
    join_and(Phrases, Text).

occupied_report(C, T, Name, Sq, WhiteList, BlackList, Attacks, [L1, L2, L3, L4], Viz) :-
    opponent(C, O),
    (   C == white
    ->  Own = WhiteList, Enemy = BlackList
    ;   Own = BlackList, Enemy = WhiteList
    ),
    describe_list(O, Enemy, EnemyText),
    describe_list(C, Own, OwnText),
    length(Enemy, NE), length(Own, NO),
    format(atom(L1), '~w ~w on ~w.', [C, T, Name]),
    format(atom(L2), 'Attacked by (~d): ~w.', [NE, EnemyText]),
    format(atom(L3), 'Defended by (~d): ~w.', [NO, OwnText]),
    (   Attacks == []
    ->  L4 = 'It attacks no squares.'
    ;   atomic_list_concat(Attacks, ' ', AttackText),
        format(atom(L4), 'It controls: ~w.', [AttackText])
    ),
    findall(arrow(From, Sq, threat), member(_-From, Enemy), A1),
    findall(arrow(From, Sq, defend), member(_-From, Own), A2),
    append([[ring(Sq, inspect)], A1, A2], Viz).

empty_report(Name, Sq, WhiteList, BlackList, [L1, L2, L3], Viz) :-
    describe_list(white, WhiteList, WhiteText),
    describe_list(black, BlackList, BlackText),
    length(WhiteList, NW), length(BlackList, NB),
    format(atom(L1), '~w is empty.', [Name]),
    format(atom(L2), 'White controls it with (~d): ~w.', [NW, WhiteText]),
    format(atom(L3), 'Black controls it with (~d): ~w.', [NB, BlackText]),
    findall(arrow(From, Sq, control_white), member(_-From, WhiteList), A1),
    findall(arrow(From, Sq, control_black), member(_-From, BlackList), A2),
    append([[ring(Sq, inspect)], A1, A2], Viz).
