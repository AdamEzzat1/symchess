/*  plans.pl -- candidate plans for the side to move, derived from facts.

    A plan is advice, not a search result. Each plan cites the ids of the
    facts it rests on ("because"), so the UI can show its justification and
    the reader can see it is a heuristic. Plans do NOT influence the search.

      plan(Kind, Text, BecauseIds, Viz)
*/

:- module(plans, [ plans/3 ]).

:- use_module(library(lists)).
:- use_module(board).
:- use_module(render).

max_plans(5).

%!  plans(+Ctx, +IdFacts, -Plans) is det.
%   Clause order of plan/4 is the priority order: tactics before strategy.
plans(Ctx, IdFacts, Plans) :-
    ctx_side(Ctx, Side),
    findall(P, plan(Ctx, Side, IdFacts, P), All),
    max_plans(Max),
    length(All, N),
    (   N > Max
    ->  length(Plans, Max), append(Plans, _, All)
    ;   Plans = All
    ).

plan(_, S, Facts, plan(win_material, Text, [Id], [ring(Sq, plan)])) :-
    opponent(S, O),
    member(Id-hanging(O, T, Sq, _), Facts),
    sq_name(Sq, Name),
    format(atom(Text), 'Win material: the ~w on ~w is undefended.', [T, Name]).

plan(_, S, Facts, plan(save_piece, Text, [Id], [ring(Sq, plan)])) :-
    (   member(Id-hanging(S, T, Sq, _), Facts)
    ;   member(Id-threatened(S, T, Sq, _, _), Facts)
    ),
    T \== pawn,
    sq_name(Sq, Name),
    format(atom(Text), 'Deal with the threat to your ~w on ~w: move it or defend it.', [T, Name]).

plan(_, S, Facts, plan(answer_tactic, Text, [Id], [ring(From, plan)])) :-
    opponent(S, O),
    (   member(Id-fork(O, T, From, _), Facts), Name = fork
    ;   member(Id-skewer(O, T, From, _, _, _, _), Facts), Name = skewer
    ),
    sq_name(From, F),
    format(atom(Text), 'Answer the ~w from the ~w on ~w before anything else.', [Name, T, F]).

plan(_, S, Facts, plan(exploit_pin, Text, [Id], [ring(Sq, plan)])) :-
    member(Id-pin(_, S, _, _, T, Sq, BT, _), Facts),
    sq_name(Sq, Name),
    format(atom(Text), 'Pile up on the pinned ~w on ~w: it cannot move without exposing the ~w.',
           [T, Name, BT]).

plan(Ctx, S, Facts, plan(use_outpost, Text, [Id], [arrow(NSq, Sq, plan)])) :-
    opponent(S, O),
    member(Id-weak_square(O, Sq, _), Facts),
    \+ at(Ctx, Sq, S, _),
    once(piece(Ctx, S, knight, NSq)),
    sq_name(Sq, Name),
    format(atom(Text), 'Route a knight to the outpost on ~w.', [Name]).

plan(Ctx, S, Facts, plan(use_open_file, Text, [Id], [file(F, plan)])) :-
    once(( member(Id-open_file(F), Facts),
           piece(Ctx, S, rook, _),
           \+ piece(Ctx, S, rook, F/_)
         )),
    file_letter(F, L),
    format(atom(Text), 'Put a rook on the open ~w-file.', [L]).

plan(_, S, Facts, plan(push_passed_pawn, Text, [Id], [ring(Sq, plan)])) :-
    member(Id-passed_pawn(S, Sq), Facts),
    sq_name(Sq, Name),
    format(atom(Text), 'Advance the passed pawn on ~w and support it with pieces.', [Name]).

plan(_, S, Facts, plan(attack_king, Text, [Id], [ring(KSq, plan)])) :-
    opponent(S, O),
    member(Id-king_shield(O, KSq, _), Facts),
    sq_name(KSq, Name),
    format(atom(Text), 'Aim pieces at the king on ~w: its pawn cover is damaged.', [Name]).

plan(_, S, Facts, plan(guard_king, Text, [Id], [ring(KSq, plan)])) :-
    member(Id-king_shield(S, KSq, _), Facts),
    sq_name(KSq, Name),
    format(atom(Text), 'Your king on ~w is short of pawn cover: keep defenders close.', [Name]).
