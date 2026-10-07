/*  rules.pl -- the knowledge base describing itself.

      rule_index(-Dicts)

    One entry for every rule that can produce a fact, a move motif or a plan.
    Each entry is read straight from the source file the rule lives in: the
    clause text as written (variable names included) and the comment that
    stands directly above it. Nothing here is a second description of a rule
    that could drift away from the rule itself; if a rule changes, its entry
    changes with it.

    Which clauses count as rules is decided by their heads:
      tactics.pl, structure.pl   Kind(Ctx, Fact), for every Kind that
                                 analysis:root_fact/2 calls
      moves.pl                   motif(_, _, _, _, _, motif(Kind, ...))
      plans.pl                   plan(_, _, _, plan(Kind, ...))
*/

:- module(rules, [ rule_index/1 ]).

:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(library(readutil)).

:- dynamic cached_index/1.

rule_file(tactics).
rule_file(structure).
rule_file(moves).
rule_file(plans).

%!  rule_index(-Dicts) is det.
%   Read once, then remembered: the source does not change while running.
rule_index(Dicts) :-
    cached_index(Dicts), !.
rule_index(Dicts) :-
    fact_kinds(Kinds),
    findall(Entry,
            ( rule_file(Module),
              file_rules(Module, Kinds, Entries),
              member(Entry, Entries)
            ),
            All),
    merge_entries(All, Merged),
    maplist(entry_dict, Merged, Dicts),
    assertz(cached_index(Dicts)).

%   The kinds of fact are whatever analysis:root_fact/2 asks for.
fact_kinds(Kinds) :-
    findall(Name,
            ( clause(analysis:root_fact(_, _), Body),
              strip_module(Body, _, Goal),
              functor(Goal, Name, 2)
            ),
            Kinds).

%   file_rules(+Module, +FactKinds, -Entries)
%   Entries = [rule(Group, Kind, Module, Indicator, Comment, Source), ...]
file_rules(Module, Kinds, Entries) :-
    module_property(Module, file(File)),
    read_file_to_string(File, Text, [encoding(utf8)]),
    setup_call_cleanup(
        open(File, read, In, [encoding(utf8)]),
        read_rules(In, Text, Module, Kinds, Entries),
        close(In)).

read_rules(In, Text, Module, Kinds, Entries) :-
    read_term(In, Term, [subterm_positions(Layout), comments(Comments), module(Module)]),
    (   Term == end_of_file
    ->  Entries = []
    ;   (   clause_head(Term, Head),
            classify(Module, Kinds, Head, Group, Kind, Indicator)
        ->  arg(1, Layout, From),
            arg(2, Layout, To),
            comment_text(Comments, From, Comment),
            Length is To - From,
            sub_string(Text, From, Length, _, Source),
            Entries = [rule(Group, Kind, Module, Indicator, Comment, Source)|Rest]
        ;   Entries = Rest
        ),
        read_rules(In, Text, Module, Kinds, Rest)
    ).

clause_head((Head :- _), Head) :- !.
clause_head((:- _), _) :- !, fail.
clause_head(Head, Head).

classify(Module, Kinds, Head, fact, Kind, Kind/2) :-
    memberchk(Module, [tactics, structure]),
    functor(Head, Kind, 2),
    memberchk(Kind, Kinds), !.
classify(moves, _, motif(_, _, _, _, _, Motif), motif, Kind, motif/6) :-
    nonvar(Motif),
    Motif = motif(Kind, _, _, _),
    atom(Kind), !.
classify(plans, _, plan(_, _, _, Plan), plan, Kind, plan/4) :-
    nonvar(Plan),
    Plan = plan(Kind, _, _, _),
    atom(Kind).

%   The line comments standing above a clause (those that begin before the
%   clause does), joined into one sentence. Structured comments (%!) describe
%   a helper's modes, not a rule, and section rules (% -----) are decoration.
comment_text(Comments, ClauseStart, Text) :-
    findall(Line,
            ( member(Position-Comment, Comments),
              stream_position_data(char_count, Position, Start),
              Start < ClauseStart,
              sub_string(Comment, 0, 1, _, "%"),
              \+ sub_string(Comment, 0, 2, _, "%!"),
              \+ sub_string(Comment, _, _, _, "----"),
              split_string(Comment, "\n", "% \t\r", Parts),
              member(Line, Parts),
              Line \== ""
            ),
            Lines),
    atomic_list_concat(Lines, ' ', Atom),
    atom_string(Atom, Text).

%   A kind written as several clauses (a rook to an open or a semi-open file)
%   is one rule: the first comment found, and every clause.
merge_entries([], []).
merge_entries([rule(G, K, M, I, C, S)|Rest], [rule(G, K, M, I, Comment, Source)|Merged]) :-
    partition(same_rule(G, K), Rest, Same, Others),
    findall(C1, ( member(rule(_, _, _, _, C1, _), [rule(G, K, M, I, C, S)|Same]), C1 \== "" ), Cs),
    ( Cs = [Comment|_] -> true ; Comment = "" ),
    findall(S1, member(rule(_, _, _, _, _, S1), [rule(G, K, M, I, C, S)|Same]), Ss),
    atomic_list_concat(Ss, '\n\n', SourceAtom),
    atom_string(SourceAtom, Source),
    merge_entries(Others, Merged).

same_rule(G, K, rule(G, K, _, _, _, _)).

entry_dict(rule(Group, Kind, Module, Name/Arity, Comment, Source),
           _{id:Id, layer:prolog, group:Group, name:Kind, where:Where,
             summary:Comment, source:Source}) :-
    format(atom(Id), '~w:~w', [Group, Kind]),
    format(atom(Where), 'knowledge/~w.pl, ~w/~d', [Module, Name, Arity]).
