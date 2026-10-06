/*  test_knowledge.pl -- rule tests for the Prolog knowledge layer.

    Run:  swipl -g run_tests -t halt knowledge/tests/test_knowledge.pl

    Each rule has at least one position where it must fire and, where a false
    positive would mislead the user, one where it must stay silent.
*/

:- use_module(library(plunit)).
:- use_module(library(lists)).
:- use_module(library(apply)).
:- use_module(library(json)).
:- use_module('../board').
:- use_module('../tactics').
:- use_module('../structure').
:- use_module('../moves').
:- use_module('../analysis').

% ------------------------------------------------------- test-only FEN reader
% (Production positions always come from the Lisp engine as piece lists.)

fen_pos(Fen, pos(Side, Pieces)) :-
    split_string(Fen, " ", "", [Board, SideText|_]),
    (   SideText == "w"
    ->  Side = white
    ;   Side = black
    ),
    split_string(Board, "/", "", Rows),
    foldl(row_pieces, Rows, 8-[], _-Pieces).

row_pieces(Row, R-Acc0, R1-Acc) :-
    string_chars(Row, Chars),
    row_chars(Chars, 1, R, Acc0, Acc),
    R1 is R - 1.

row_chars([], _, _, Acc, Acc).
row_chars([C|Cs], F, R, Acc0, Acc) :-
    (   char_type(C, digit(W))
    ->  F1 is F + W,
        Acc1 = Acc0
    ;   piece_char(C, Color, Type),
        sq_atom(F/R, Sq),
        Acc1 = [p(Color, Type, Sq)|Acc0],
        F1 is F + 1
    ),
    row_chars(Cs, F1, R, Acc1, Acc).

piece_char(C, Color, Type) :-
    downcase_atom(C, Lower),
    (   C == Lower
    ->  Color = black
    ;   Color = white
    ),
    memberchk(Lower-Type, [p-pawn, n-knight, b-bishop, r-rook, q-queen, k-king]).

ctx(Fen, Ctx) :- fen_pos(Fen, Pos), build_ctx(Pos, Ctx).

sq(Atom, Sq) :- sq_atom(Sq, Atom).

motifs(RootFen, Uci, AfterFen, Kinds, Total) :-
    ctx(RootFen, Root),
    ctx(AfterFen, After),
    move_motifs(Root, Uci, After, Motifs, Total),
    findall(K, member(motif(K, _, _, _), Motifs), Kinds).

% --------------------------------------------------------------------- board

:- begin_tests(board).

test(square_names) :-
    sq_atom(5/4, e4),
    sq_atom(Sq, h8),
    Sq == 8/8.

test(start_position_has_32_pieces) :-
    fen_pos("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", pos(white, Pieces)),
    length(Pieces, 32).

test(knight_attacks_from_g1) :-
    ctx("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Ctx),
    sq(g1, G1),
    findall(To, attack(Ctx, white, knight, G1, To), Tos),
    maplist(sq, Names, Tos),
    msort(Names, [e2, f3, h3]).

test(slider_stops_at_first_piece, [nondet]) :-
    ctx("4k3/8/8/8/4p3/8/8/4R1K1 w - - 0 1", Ctx),
    sq(e1, E1), sq(e4, E4), sq(e5, E5),
    attack(Ctx, white, rook, E1, E4),
    \+ attack(Ctx, white, rook, E1, E5).

test(pawns_attack_diagonally_only, [nondet]) :-
    ctx("4k3/8/8/8/4P3/8/8/4K3 w - - 0 1", Ctx),
    sq(e4, E4), sq(d5, D5), sq(e5, E5),
    attack(Ctx, white, pawn, E4, D5),
    \+ attack(Ctx, white, pawn, E4, E5).

:- end_tests(board).

% ------------------------------------------------------------------- tactics

:- begin_tests(tactics).

test(absolute_pin, [nondet]) :-
    ctx("r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Ctx),
    sq(b5, B5), sq(c6, C6), sq(e8, E8),
    pin(Ctx, pin(absolute, white, bishop, B5, knight, C6, king, E8)).

test(no_pin_when_two_pieces_block) :-
    % the d7 pawn also stands between bishop and king
    ctx("r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Ctx),
    \+ pin(Ctx, pin(_, white, bishop, _, _, _, _, _)).

test(relative_pin, [nondet]) :-
    ctx("rnbqkb1r/ppp2ppp/3p1n2/4p1B1/4P3/5N2/PPP2PPP/RN1QKB1R b KQkq - 0 1", Ctx),
    sq(g5, G5), sq(f6, F6), sq(d8, D8),
    pin(Ctx, pin(relative, white, bishop, G5, knight, F6, queen, D8)).

test(fork_by_knight, [nondet]) :-
    ctx("r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1", Ctx),
    sq(c7, C7),
    fork(Ctx, fork(white, knight, C7, Targets)),
    length(Targets, 2),
    memberchk(king-_, Targets),
    memberchk(rook-_, Targets).

test(no_fork_when_forker_can_be_taken_for_free) :-
    % same fork, but a black bishop on d8 simply captures the knight
    ctx("r2bk3/2N5/8/8/8/8/8/4K3 b - - 0 1", Ctx),
    \+ fork(Ctx, fork(white, knight, _, _)).

test(skewer, [nondet]) :-
    ctx("7k/8/5r2/8/3q4/8/1B6/4K3 w - - 0 1", Ctx),
    sq(b2, B2), sq(d4, D4), sq(f6, F6),
    skewer(Ctx, skewer(white, bishop, B2, queen, D4, rook, F6)).

test(hanging_piece, [nondet]) :-
    ctx("4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1", Ctx),
    sq(e5, E5),
    hanging(Ctx, hanging(black, knight, E5, [rook-_])).

test(defended_piece_is_not_hanging) :-
    ctx("4k3/8/3p4/4n3/8/8/4R3/4K3 w - - 0 1", Ctx),
    \+ hanging(Ctx, hanging(black, knight, _, _)),
    % ...and a rook attacking a defended knight is not a "threat" either
    \+ threatened(Ctx, threatened(black, knight, _, _, _)).

test(threatened_by_cheaper_piece, [nondet]) :-
    ctx("4k3/8/8/2p5/3Q4/2P5/8/4K3 w - - 0 1", Ctx),
    sq(d4, D4), sq(c5, C5),
    threatened(Ctx, threatened(white, queen, D4, pawn, C5)).

test(check, [nondet]) :-
    ctx("4k3/8/8/8/8/8/4R3/4K3 b - - 0 1", Ctx),
    sq(e8, E8),
    check(Ctx, check(white, E8, [rook-_])).

test(overloaded_defender, [nondet]) :-
    % the black queen alone guards both the b6 knight and the f6 bishop
    ctx("3qk3/8/1n3b2/8/8/8/1R3R2/4K3 w - - 0 1", Ctx),
    sq(d8, D8),
    overloaded(Ctx, overloaded(black, queen, D8, Guarded)),
    length(Guarded, 2).

:- end_tests(tactics).

% ----------------------------------------------------------------- structure

:- begin_tests(structure).

test(start_position_is_quiet) :-
    ctx("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Ctx),
    root_facts(Ctx, Facts),
    Facts == [].

test(open_and_passed_and_isolated, [nondet]) :-
    ctx("4k3/pp3ppp/8/8/3P4/8/PP3PPP/3RK3 w - - 0 1", Ctx),
    sq(d4, D4),
    open_file(Ctx, open_file(3)),
    open_file(Ctx, open_file(5)),
    \+ open_file(Ctx, open_file(4)),
    passed_pawn(Ctx, passed_pawn(white, D4)),
    isolated_pawn(Ctx, isolated_pawn(white, D4)).

test(pawn_is_not_passed_with_enemy_on_adjacent_file) :-
    ctx("4k3/ppp2ppp/8/8/3P4/8/PP3PPP/3RK3 w - - 0 1", Ctx),
    sq(d4, D4),
    \+ passed_pawn(Ctx, passed_pawn(white, D4)).

test(doubled_pawns, [nondet]) :-
    ctx("4k3/8/8/8/2P5/2P5/8/4K3 w - - 0 1", Ctx),
    doubled_pawns(Ctx, doubled_pawns(white, 3, Sqs)),
    length(Sqs, 2).

test(weak_square_outpost, [nondet]) :-
    ctx("4k3/pp3ppp/3p4/8/4P3/8/PPP2PPP/4K3 w - - 0 1", Ctx),
    sq(d5, D5), sq(e4, E4),
    weak_square(Ctx, weak_square(black, D5, E4)).

test(no_weak_square_while_a_pawn_can_cover_it) :-
    % black's c7 pawn can still play ...c6 to cover d5
    ctx("4k3/ppp2ppp/3p4/8/4P3/8/PPP2PPP/4K3 w - - 0 1", Ctx),
    sq(d5, D5),
    \+ weak_square(Ctx, weak_square(black, D5, _)).

test(king_shield_missing, [nondet]) :-
    ctx("4k3/8/8/8/8/8/PP3P2/6K1 w - - 0 1", Ctx),
    king_shield(Ctx, king_shield(white, _, Missing)),
    msort(Missing, [7, 8]).

test(intact_king_shield_is_silent) :-
    ctx("4k3/8/8/8/8/8/5PPP/6K1 w - - 0 1", Ctx),
    \+ king_shield(Ctx, king_shield(white, _, _)).

:- end_tests(structure).

% -------------------------------------------------------------------- motifs

:- begin_tests(motifs).

test(knight_move_creates_fork_with_check) :-
    motifs("r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1", b5c7,
           "r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1", Kinds, Total),
    memberchk(creates_fork, Kinds),
    memberchk(gives_check, Kinds),
    Total > 0.

test(queen_stepping_into_a_pawn_attack_is_flagged) :-
    motifs("4k3/8/8/2p5/8/8/8/3QK3 w - - 0 1", d1d4,
           "4k3/8/8/2p5/3Q4/8/8/4K3 b - - 0 1", Kinds, Total),
    memberchk(hangs_piece, Kinds),
    Total < 0.

test(capturing_an_undefended_piece) :-
    motifs("4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1", e2e5,
           "4k3/8/8/4R3/8/8/8/4K3 b - - 0 1", Kinds, Total),
    memberchk(captures_hanging, Kinds),
    Total > 0.

test(moving_a_defender_away_is_flagged) :-
    % the d1 rook guards the d4 knight against the d8 rook; Rh1 abandons it
    motifs("3rk3/8/8/8/3N4/8/8/3RK3 w - - 0 1", d1h1,
           "3rk3/8/8/8/3N4/8/8/4K2R b - - 0 1", Kinds, _),
    memberchk(leaves_hanging, Kinds).

test(quiet_developing_move_has_no_motifs) :-
    motifs("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", g1f3,
           "rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq - 0 1", Kinds, Total),
    Kinds == [],
    Total =:= 0.

test(rook_to_open_file) :-
    motifs("4k3/pp3ppp/8/8/8/8/PP3PPP/R3K3 w - - 0 1", a1d1,
           "4k3/pp3ppp/8/8/8/8/PP3PPP/3RK3 b - - 0 1", Kinds, _),
    memberchk(rook_to_open_file, Kinds).

test(keeping_an_existing_pin_is_not_creating_one) :-
    motifs("r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1", b5a4,
           "r1bqkbnr/ppp2ppp/2np4/4p3/B3P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Kinds, _),
    \+ memberchk(creates_pin, Kinds).

test(new_pin_is_reported) :-
    motifs("r1bqkbnr/ppp2ppp/2np4/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 0 1", f1b5,
           "r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Kinds, _),
    memberchk(creates_pin, Kinds).

:- end_tests(motifs).

% ------------------------------------------------------------------ analysis

:- begin_tests(analysis).

test(analyze_reply_is_json_serialisable) :-
    fen_pos("r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Pos),
    fen_pos("r2qkbnr/pppb1ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1", After),
    analyze(Pos, [m(c8d7, After)], Reply),
    with_output_to(string(Json), json_write_dict(current_output, Reply, [width(0)])),
    sub_string(Json, _, _, _, "\"kind\":\"pin\""), !.

test(every_visual_belongs_to_a_fact, [nondet]) :-
    fen_pos("r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Pos),
    analyze(Pos, [], Reply),
    forall(member(Fact, Reply.facts),
           ( get_dict(id, Fact, _), get_dict(text, Fact, _), is_list(Fact.viz) )).

test(facts_carry_a_short_label, [nondet]) :-
    fen_pos("r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1", Pos),
    analyze(Pos, [], Reply),
    member(Fact, Reply.facts),
    get_dict(kind, Fact, pin),
    get_dict(label, Fact, 'black knight c6').

test(plans_cite_existing_facts, [nondet]) :-
    fen_pos("4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1", Pos),
    analyze(Pos, [], Reply),
    Reply.plans = [First|_],
    findall(Id, ( member(F, Reply.facts), get_dict(id, F, Id) ), Ids),
    forall(member(B, First.because), memberchk(B, Ids)).

test(inspect_occupied_square) :-
    fen_pos("4k3/8/3p4/4n3/8/8/4R3/4K3 w - - 0 1", Pos),
    inspect(Pos, e5, Reply),
    get_dict(color, Reply.piece, black),
    get_dict(type, Reply.piece, knight),
    length(Reply.white, 1),
    length(Reply.black, 1).

test(inspect_empty_square) :-
    fen_pos("4k3/8/8/8/8/8/4R3/4K3 w - - 0 1", Pos),
    inspect(Pos, e4, Reply),
    Reply.piece == null,
    length(Reply.white, 1).

:- end_tests(analysis).
