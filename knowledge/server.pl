/*  server.pl -- line protocol between the Lisp engine and this knowledge base.

    stdin : one Prolog term per line, terminated by '.'
              version(Id).
              rules(Id).
              analyze(Id, pos(Side, Pieces), [m(Uci, pos(Side2, Pieces2)), ...]).
              inspect(Id, pos(Side, Pieces), Square).
    stdout: one JSON object per line, always carrying the request "id" and
            "status": "ok" | "error".

    Every request runs under a time limit and a catch-all, so a bad rule
    costs one answer, never the process.
*/

:- use_module(library(json)).
:- use_module(library(time)).
:- use_module(analysis).
:- use_module(rules).

request_time_limit(3).

main :-
    set_stream(user_input, encoding(utf8)),
    set_stream(user_output, encoding(utf8)),
    loop.

loop :-
    catch(read_term(user_input, Term, []), Error, ( Term = syntax(Error) )),
    (   Term == end_of_file
    ->  true
    ;   handle(Term),
        loop
    ).

handle(syntax(Error)) :- !,
    message_to_codes_safe(Error, Message),
    reply(_{id:0, status:error, message:Message}).
handle(Term) :-
    Term =.. [_, Id|_],
    integer(Id), !,
    request_time_limit(Limit),
    (   catch(call_with_time_limit(Limit, answer(Term, Dict0)), Error, true)
    ->  (   var(Error)
        ->  Dict = Dict0.put(_{id:Id, status:ok})
        ;   message_to_codes_safe(Error, Message),
            Dict = _{id:Id, status:error, message:Message}
        )
    ;   Dict = _{id:Id, status:error, message:"query failed"}
    ),
    reply(Dict).
handle(_) :-
    reply(_{id:0, status:error, message:"malformed request"}).

answer(version(_), _{version:Version}) :-
    current_prolog_flag(version_data, swi(Major, Minor, Patch, _)),
    format(string(Version), "SWI-Prolog ~d.~d.~d", [Major, Minor, Patch]).
answer(rules(_), _{rules:Rules}) :-
    rule_index(Rules).
answer(analyze(_, Pos, Moves), Dict) :-
    analyze(Pos, Moves, Dict).
answer(inspect(_, Pos, Square), Dict) :-
    inspect(Pos, Square, Dict).

message_to_codes_safe(Error, Message) :-
    term_string(Error, Message).

reply(Dict) :-
    json_write_dict(user_output, Dict, [width(0)]),
    nl(user_output),
    flush_output(user_output).
