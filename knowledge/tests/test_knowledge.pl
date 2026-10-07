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
    ctx("7k/8/5r2/8/3q4/8/1B6/2K5 w - - 0 1", Ctx),
    sq(b2, B2), sq(d4, D4), sq(f6, F6),
    skewer(Ctx, skewer(white, bishop, B2, queen, D4, rook, F6)).

test(no_skewer_when_the_front_piece_can_take_the_attacker_for_nothing) :-
    % the same line, but nothing guards the bishop: the queen just takes it
    ctx("7k/8/5r2/8/3q4/8/1B6/4K3 w - - 0 1", Ctx),
    \+ skewer(Ctx, _).

test(hanging_piece, [nondet]) :-
    ctx("4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1", Ctx),
    sq(e5, E5),
    hanging(Ctx, hanging(black, knight, E5, [rook-_])).

test(defended_piece_is_not_hanging) :-
    ctx("4k3/8/3p4/4n3/8/8/4R3/4K3 w - - 0 1", Ctx),
    \+ hanging(Ctx, hanging(black, knight, _, _)),
    % ...and a rook attacking a defended knight is not a "threat" either
    \+ threatened(Ctx, threatened(black, knight, _, _, _)).

test(no_hanging_when_the_only_attacker_is_pinned_to_its_king) :-
    % the d4 knight "attacks" e6 but is pinned by the b6 bishop: Nxe6 is illegal
    ctx("7k/8/1b2r3/8/3N4/8/8/6K1 w - - 0 1", Ctx),
    \+ hanging(Ctx, hanging(black, rook, _, _)).

test(pinned_piece_may_still_capture_along_the_pin_line, [nondet]) :-
    % the d1 rook is pinned along the rank and can take the piece that pins it
    ctx("6k1/8/8/8/8/8/8/r2R2K1 w - - 0 1", Ctx),
    sq(a1, A1),
    hanging(Ctx, hanging(black, rook, A1, [rook-_])).

test(capturing_with_a_pinned_piece_is_not_capturing_a_hanging_piece) :-
    % the same pinned knight: the move generator is not asked, so no motif
    ctx("7k/8/1b2r3/8/3N4/8/8/6K1 w - - 0 1", Ctx),
    sq(e6, E6),
    \+ is_hanging(Ctx, black, rook, E6).

test(no_relative_pin_of_a_pawn_along_its_own_file) :-
    % the h7 pawn stands between queen and rook, but pushing it keeps the file shut
    ctx("k6r/7p/8/7Q/8/8/8/4K3 w - - 0 1", Ctx),
    \+ pin(Ctx, _).

test(pawn_pinned_to_its_king_on_a_file_is_still_a_pin, [nondet]) :-
    % it may not capture sideways
    ctx("4k3/8/4p3/3n4/8/2N5/8/4RK2 w - - 0 1", Ctx),
    sq(e6, E6),
    pin(Ctx, pin(absolute, white, rook, _, pawn, E6, king, _)).

test(no_skewer_when_the_piece_behind_is_guarded_and_no_dearer) :-
    % if the queen steps aside the rooks are merely exchanged
    ctx("4rk2/8/8/4q3/8/8/8/4RK2 w - - 0 1", Ctx),
    \+ skewer(Ctx, _).

test(no_fork_on_two_guarded_pieces_worth_less_than_the_forker) :-
    % the queen attacks both knights, but each is defended by a pawn
    ctx("4k3/2p1p3/1n3n2/8/3Q4/8/8/4K3 w - - 0 1", Ctx),
    \+ fork(Ctx, _).

test(no_overload_when_a_second_piece_shares_the_work) :-
    % the king also guards f7, so the d7 rook has only one job that is its alone
    ctx("6k1/1n1r1n2/8/3B4/8/8/8/4KR2 w - - 0 1", Ctx),
    \+ overloaded(Ctx, _).

test(not_threatened_by_an_equal_piece) :-
    % rook against defended rook is an offer to exchange, not a threat
    ctx("3rk3/8/8/8/8/8/8/3RK3 w - - 0 1", Ctx),
    \+ threatened(Ctx, _).

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

test(battery_of_doubled_rooks, [nondet]) :-
    ctx("3r2k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1", Ctx),
    sq(d1, D1), sq(d2, D2), sq(d8, D8),
    battery(Ctx, battery(white, rook, D2, rook, D1, rook, D8)).

test(no_battery_without_a_target) :-
    % queen and rook stand side by side on both back ranks, aiming at nothing
    ctx("r2q1rk1/pp2bppp/2n1pn2/3p4/3P1B2/2PBPN2/PP3PPP/RN1Q1RK1 w - - 0 9", Ctx),
    \+ battery(Ctx, _).

test(discovered_attack_behind_a_knight, [nondet]) :-
    ctx("4k3/4q3/8/8/4N3/8/8/4RK2 w - - 0 1", Ctx),
    sq(e4, E4), sq(e1, E1), sq(e7, E7),
    discovered_attack(Ctx, discovered_attack(white, knight, E4, rook, E1, queen, E7)).

test(no_discovered_attack_behind_a_pawn_on_its_file) :-
    % the pawn can only go forward, which keeps the file closed
    ctx("4k3/4q3/8/8/4P3/8/8/4R1K1 w - - 0 1", Ctx),
    \+ discovered_attack(Ctx, _).

test(no_discovered_attack_when_moving_the_mask_loses_the_piece_behind_it) :-
    % the f6 knight masks its queen from the g5 bishop: that knight is pinned
    ctx("3qk3/8/5n2/6B1/8/8/8/4K3 w - - 0 1", Ctx),
    \+ discovered_attack(Ctx, _).

test(pinned_defender, [nondet]) :-
    % the d2 knight is pinned by the a5 bishop and alone guards the f3 bishop
    ctx("4kr2/8/8/b7/8/5B2/3N4/4K3 b - - 0 1", Ctx),
    sq(d2, D2), sq(f3, F3),
    pinned_defender(Ctx, pinned_defender(white, knight, D2, bishop, F3)).

test(no_pinned_defender_when_another_piece_also_defends) :-
    ctx("4kr2/8/8/b7/8/5B2/3N2P1/4K3 b - - 0 1", Ctx),
    \+ pinned_defender(Ctx, _).

test(trapped_knight_in_the_corner, [nondet]) :-
    ctx("N7/pk6/8/8/8/8/8/4K3 w - - 0 1", Ctx),
    sq(a8, A8),
    trapped(Ctx, trapped(white, knight, A8, _, _)).

test(attacked_piece_with_a_safe_square_is_not_trapped) :-
    ctx("4k3/8/8/8/3p4/2N5/8/4K3 w - - 0 1", Ctx),
    \+ trapped(Ctx, _).

test(unattacked_piece_is_not_trapped) :-
    % the a1 bishop cannot move, but nothing attacks it
    ctx("4k3/8/8/8/8/1p6/P1p5/BK6 b - - 0 1", Ctx),
    \+ trapped(Ctx, _).

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

test(weak_back_rank, [nondet]) :-
    ctx("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", Ctx),
    sq(g8, G8),
    weak_back_rank(Ctx, weak_back_rank(black, G8)).

test(back_rank_guarded_by_a_rook_is_not_weak) :-
    ctx("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", Ctx),
    \+ weak_back_rank(Ctx, weak_back_rank(white, _)).

test(no_weak_back_rank_in_the_start_position) :-
    ctx("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Ctx),
    \+ weak_back_rank(Ctx, _).

test(knight_on_an_outpost, [nondet]) :-
    ctx("4k3/pp3ppp/8/3N4/4P3/8/8/4K3 w - - 0 1", Ctx),
    sq(d5, D5), sq(e4, E4),
    outpost_piece(Ctx, outpost_piece(white, knight, D5, E4)).

test(no_outpost_while_a_pawn_can_still_chase_the_knight) :-
    ctx("4k3/ppp2ppp/8/3N4/4P3/8/8/4K3 w - - 0 1", Ctx),
    \+ outpost_piece(Ctx, _).

test(backward_pawn, [nondet]) :-
    ctx("4k3/8/8/4p3/2P1P3/3P4/8/4K3 w - - 0 1", Ctx),
    sq(d3, D3),
    backward_pawn(Ctx, backward_pawn(white, D3)).

test(pawn_with_a_neighbour_beside_it_is_not_backward) :-
    ctx("4k3/8/8/4p3/4P3/2PP4/8/4K3 w - - 0 1", Ctx),
    \+ backward_pawn(Ctx, backward_pawn(white, _)).

test(rook_on_the_seventh, [nondet]) :-
    ctx("8/5pk1/6p1/8/3R4/6P1/r4PK1/8 w - - 0 1", Ctx),
    sq(a2, A2),
    rook_on_seventh(Ctx, rook_on_seventh(black, A2)).

test(rook_on_the_seventh_with_nothing_to_do_there) :-
    ctx("8/R7/4k3/8/8/8/8/4K3 w - - 0 1", Ctx),
    \+ rook_on_seventh(Ctx, _).

test(pawn_majority, [nondet]) :-
    ctx("4k3/pp6/8/8/8/8/PPP5/4K3 w - - 0 1", Ctx),
    pawn_majority(Ctx, pawn_majority(white, queenside, Sqs, 2)),
    length(Sqs, 3).

test(equal_pawns_are_not_a_majority) :-
    ctx("4k3/ppp5/8/8/8/8/PPP5/4K3 w - - 0 1", Ctx),
    \+ pawn_majority(Ctx, _).

test(pawn_break_with_a_double_step, [nondet]) :-
    ctx("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", Ctx),
    sq(d2, D2), sq(d4, D4), sq(e5, E5),
    pawn_break(Ctx, pawn_break(white, D2, D4, E5)).

test(pawn_breaks_are_only_for_the_side_to_move) :-
    ctx("rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2", Ctx),
    \+ pawn_break(Ctx, pawn_break(black, _, _, _)).

test(no_pawn_break_in_the_start_position) :-
    ctx("rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", Ctx),
    \+ pawn_break(Ctx, _).

test(unstoppable_pawn_king_outside_the_square, [nondet]) :-
    % pawn needs 3 moves, king needs 4, pawn moves first
    ctx("8/4k3/8/P7/8/8/8/7K w - - 0 1", Ctx),
    sq(a5, A5),
    unstoppable_pawn(Ctx, unstoppable_pawn(white, A5)).

test(same_pawn_is_caught_if_the_king_moves_first) :-
    ctx("8/4k3/8/P7/8/8/8/7K b - - 0 1", Ctx),
    \+ unstoppable_pawn(Ctx, _).

test(pawn_is_not_unstoppable_against_a_piece) :-
    ctx("8/4k3/8/P7/8/8/n7/7K w - - 0 1", Ctx),
    \+ unstoppable_pawn(Ctx, _).

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

%   Every fact a rule can produce must have a sentence, a label and something
%   to draw, or the whole reply for that position would fail.
test(every_new_kind_of_fact_renders) :-
    Samples = [ battery-"3r2k1/5ppp/8/8/8/8/3R1PPP/3R2K1 w - - 0 1",
                discovered_attack-"4k3/4q3/8/8/4N3/8/8/4RK2 w - - 0 1",
                pinned_defender-"4kr2/8/8/b7/8/5B2/3N4/4K3 b - - 0 1",
                trapped-"N7/pk6/8/8/8/8/8/4K3 w - - 0 1",
                weak_back_rank-"6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1",
                outpost_piece-"4k3/pp3ppp/8/3N4/4P3/8/8/4K3 w - - 0 1",
                backward_pawn-"4k3/8/8/4p3/2P1P3/3P4/8/4K3 w - - 0 1",
                rook_on_seventh-"8/5pk1/6p1/8/3R4/6P1/r4PK1/8 w - - 0 1",
                pawn_majority-"4k3/pp6/8/8/8/8/PPP5/4K3 w - - 0 1",
                pawn_break-"rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
                unstoppable_pawn-"8/4k3/8/P7/8/8/8/7K w - - 0 1" ],
    forall(member(Kind-Fen, Samples), renders(Kind, Fen)).

renders(Kind, Fen) :-
    fen_pos(Fen, Pos),
    analyze(Pos, [], Reply),
    get_dict(facts, Reply, Facts),
    member(Dict, Facts),
    get_dict(kind, Dict, Kind),
    get_dict(text, Dict, Text), Text \== '',
    get_dict(label, Dict, Label), Label \== '',
    get_dict(viz, Dict, Viz), Viz \== [],
    !.

test(new_facts_lead_to_plans, [nondet]) :-
    fen_pos("6k1/5ppp/8/8/8/8/5PPP/3R2K1 w - - 0 1", Pos),
    analyze(Pos, [], Reply),
    member(Plan, Reply.plans),
    Plan.kind == back_rank.

test(unstoppable_pawn_plan_comes_before_the_generic_passed_pawn_plan) :-
    fen_pos("8/4k3/8/P7/8/8/8/7K w - - 0 1", Pos),
    analyze(Pos, [], Reply),
    Reply.plans = [First|_],
    First.kind == queen_the_pawn.

:- end_tests(analysis).
