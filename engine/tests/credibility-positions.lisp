;;;; credibility-positions.lisp -- labelled positions for the explanation benchmark.
;;;;
;;;; Each entry:  (id category fen &key expect best avoid says)
;;;;
;;;;   :expect  every fact of an AUDITED kind that is really in the position,
;;;;            as (kind square), the square being the fact's subject piece.
;;;;            The list is exhaustive: any other audited fact Prolog reports
;;;;            for the position counts as a false positive.
;;;;   :best    the moves that are correct (UCI). Left out where several moves
;;;;            are about equally good.
;;;;   :avoid   moves that are mistakes: the engine must not play them.
;;;;   :says    (motif status) pairs the explanation of the engine's move must
;;;;            contain, judged only when the engine plays a :best move.
;;;;
;;;; The audited kinds are the tactical ones: pin, skewer, fork, hanging,
;;;; threatened, overloaded, discovered_attack, pinned_defender, trapped.
;;;;
;;;; What each label means here (the standard the rules are held to):
;;;;   hanging            an enemy piece could legally take it and nothing defends it
;;;;   threatened         defended, but attacked by a cheaper piece
;;;;   pin                moving the piece off the line is illegal (absolute) or
;;;;                      loses a more valuable piece behind it (relative)
;;;;   skewer             the valuable piece in front must move and the one behind is lost
;;;;   fork               one piece attacks two that matter and cannot just be taken
;;;;   discovered_attack  moving the masking piece really does uncover a threat
;;;;   overloaded         one piece is the only defender of two attacked pieces
;;;;   pinned_defender    a piece's only defender is pinned to its king
;;;;   trapped            attacked, with no safe square
;;;;
;;;; The labels were written from the position before the rules were run, then
;;;; every disagreement was looked at by hand. Best moves were checked with a
;;;; deeper search (see docs/ANALYSIS_CREDIBILITY.md).

(defparameter *credibility-positions*
  '(;; ---------------------------------------------------------------- pins
    ("pin-ruy-lopez" "pins"
     "r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4"
     :expect (("pin" "c6")))
    ("pin-win-the-knight" "pins"
     "4k3/8/3p4/4n3/8/8/5P2/4R1K1 w - - 0 1"
     :expect (("pin" "e5"))
     :best ("f2f4"))
    ("pin-relative-to-queen" "pins"
     ;; The knight masks its own queen from the bishop, but moving it loses the
     ;; queen: that is a pin on the knight, not a discovered attack by it.
     "3qk3/8/5n2/6B1/8/8/8/4K3 w - - 0 1"
     :expect (("pin" "f6")))
    ("pin-rook-to-king" "pins"
     ;; No best move: the rook cannot escape, so taking it now or a move later
     ;; comes to the same thing.
     "6k1/p4r2/8/8/8/1B6/P7/4K3 w - - 0 1"
     :expect (("pin" "f7") ("threatened" "f7")))
    ("pin-queens-gambit" "pins"
     "rnbqkb1r/ppp2ppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR b KQkq - 3 4"
     :expect (("pin" "f6") ("hanging" "c4")))

    ;; --------------------------------------------------------------- forks
    ("fork-knight-available" "forks"
     "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1"
     :expect ()
     :best ("b5c7")
     :says (("creates_fork" "confirmed")))
    ("fork-knight-on-the-board" "forks"
     "r3k3/2N5/8/8/8/8/8/4K3 b - - 0 1"
     :expect (("fork" "c7") ("hanging" "a8")))
    ("fork-refuted-by-capture" "forks"
     ;; The knight attacks king and rook but can simply be taken.
     "r2qk3/2N5/8/8/8/8/8/4K3 b - - 0 1"
     :expect (("hanging" "c7") ("threatened" "a8"))
     :best ("d8c7")
     :says (("captures_hanging" "confirmed")))
    ("fork-king-and-queen" "forks"
     "4k3/8/8/1N1q4/8/8/8/4K3 w - - 0 1"
     :expect (("hanging" "b5"))
     :best ("b5c7")
     :says (("creates_fork" "confirmed")))
    ("fork-escaped-with-check" "forks"
     ;; d5 attacks knight and bishop, but ...Bf5+ lets both get away. The
     ;; explanation must not call this fork confirmed.
     "4k3/8/2n1b3/8/2PP4/3K4/8/8 w - - 0 1"
     :expect ()
     :says (("creates_fork" "unconfirmed")))

    ;; ------------------------------------------------------------- skewers
    ("skewer-none-queen-guards-along-the-line" "skewers"
     ;; The queen can stay on the file and keep the rook guarded, so the rook
     ;; behind is not lost by her moving. The queen herself is simply attacked.
     "4r1k1/8/8/4q3/8/8/8/4RK2 w - - 0 1"
     :expect (("threatened" "e5"))
     :best ("e1e5")
     :says (("wins_exchange" "confirmed")))
    ("skewer-through-the-king" "skewers"
     "6r1/8/8/3k4/8/8/B7/7K b - - 0 1"
     :expect (("skewer" "a2")))
    ("skewer-none-rook-is-guarded" "skewers"
     ;; If the queen steps aside the rooks are merely exchanged.
     "4rk2/8/8/4q3/8/8/8/4RK2 w - - 0 1"
     :expect (("threatened" "e5"))
     :best ("e1e5"))

    ;; -------------------------------------------------- discovered attacks
    ("discovered-check-wins-queen" "discovered attacks"
     "4k3/8/8/3q4/4N3/8/8/4RK2 w - - 0 1"
     :expect (("discovered_attack" "e4"))
     :best ("e4f6"))
    ("discovered-latent-on-rook" "discovered attacks"
     "4k2r/8/8/8/3N4/8/1B6/4K3 w - - 0 1"
     :expect (("discovered_attack" "d4")))
    ("discovered-none-target-guarded" "discovered attacks"
     ;; Behind the knight stands only a defended knight, worth less than the rook.
     "4k3/4n3/8/8/4N3/8/8/4RK2 w - - 0 1"
     :expect ())
    ("discovered-fried-liver" "discovered attacks"
     "r1bqk2r/pppp1ppp/2n2n2/2b1p1N1/2B1P3/8/PPPP1PPP/RNBQK2R w KQkq - 6 5"
     :expect (("discovered_attack" "f6"))
     :best ("g5f7")
     :says (("creates_fork" "confirmed") ("leaves_hanging" "overruled")))
    ("discovered-knight-on-the-rim" "discovered attacks"
     "r1bqkb1r/pppp1ppp/2n5/4p2n/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1"
     ;; Moving the f3 knight does uncover the queen's attack on h5, but no
     ;; knight move wins by it, so no best move is labelled.
     :expect (("discovered_attack" "f3")))

    ;; ------------------------------------------------- overloaded defenders
    ("overloaded-rook" "overloaded defenders"
     "7k/1n1r1n2/8/3B4/8/8/8/4KR2 w - - 0 1"
     :expect (("overloaded" "d7") ("hanging" "d5")))
    ("overloaded-none-king-helps" "overloaded defenders"
     "6k1/1n1r1n2/8/3B4/8/8/8/4KR2 w - - 0 1"
     :expect (("hanging" "d5") ("pin" "f7")))

    ;; ------------------------------------------------------ hanging pieces
    ("hanging-knight" "hanging pieces"
     "4k3/4n3/4n3/8/8/8/8/4R1K1 w - - 0 1"
     :expect (("hanging" "e6"))
     :best ("e1e6")
     :says (("captures_hanging" "confirmed")))
    ("hanging-none-attacker-is-pinned" "hanging pieces"
     ;; The knight "attacks" the rook but is pinned to its king: Nxe6 is illegal.
     "7k/8/1b2r3/8/3N4/8/8/6K1 w - - 0 1"
     :expect (("pin" "d4") ("hanging" "d4")))
    ("hanging-defender-is-pinned" "hanging pieces"
     "4k3/8/4p3/3n4/8/2N5/8/4RK2 w - - 0 1"
     :expect (("pin" "e6") ("pinned_defender" "e6") ("hanging" "c3") ("hanging" "e6"))
     :best ("c3d5"))
    ("hanging-bishop-to-move" "hanging pieces"
     "4k3/8/8/3b4/8/8/8/3RK3 b - - 0 1"
     :expect (("hanging" "d5")))
    ("trapped-knight-in-the-corner" "hanging pieces"
     "N7/pk6/8/8/8/8/8/4K3 w - - 0 1"
     :expect (("hanging" "a8") ("trapped" "a8")))

    ;; ----------------------------------------------------- losing captures
    ("losing-queen-for-pawn" "losing captures"
     "4k3/8/4p3/3p4/8/8/3Q4/4K3 w - - 0 1"
     :expect ()
     :avoid ("d2d5"))
    ("losing-rook-for-pawn" "losing captures"
     "4k3/8/4p3/3p4/8/8/3R4/4K3 w - - 0 1"
     :expect ()
     :avoid ("d2d5"))
    ("losing-knight-for-pawn" "losing captures"
     "r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 2 3"
     :expect ()
     :avoid ("f3e5"))
    ("losing-defended-through-a-second-rook" "losing captures"
     "3rk3/3r4/8/3p4/8/8/3R4/3RK3 w - - 0 1"
     :expect ()
     :avoid ("d2d5"))
    ("losing-queen-for-rook" "losing captures"
     "3rk3/8/8/8/8/8/8/3QK3 w - - 0 1"
     :expect (("threatened" "d1"))
     :avoid ("d1d8"))

    ;; ------------------------------------------------ quiet tactical moves
    ("quiet-mate-in-two" "quiet tactical moves"
     "7k/8/5K2/8/8/8/8/6R1 w - - 0 1"
     :expect ()
     :best ("f6f7"))
    ("quiet-pawn-fork" "quiet tactical moves"
     "4k3/8/2n1b3/8/2PP4/2K5/8/8 w - - 0 1"
     :expect ()
     :best ("d4d5")
     :says (("creates_fork" "confirmed")))
    ("quiet-king-wins-cornered-knight" "quiet tactical moves"
     "8/7k/8/8/8/1P6/P7/n1K5 w - - 0 1"
     ;; The knight is lost whatever White does, so no single move is "the" answer.
     :expect ())

    ;; ----------------------------------------------------- defensive moves
    ("defend-scholars-mate" "defensive moves"
     "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
     ;; The queen pins the f7 pawn to the king. (It does not pin the h7 pawn
     ;; to the rook: a pawn can still advance along its file.)
     :expect (("pin" "f7"))
     :best ("g7g6" "d8e7" "d8f6" "g8h6"))
    ("defend-save-the-bishop" "defensive moves"
     "4k3/8/8/3b4/8/8/8/3RK3 b - - 0 1"
     :expect (("hanging" "d5"))
     :best ("d5c6" "d5b7" "d5a8" "d5e6" "d5f7" "d5g8" "d5c4" "d5b3" "d5a2"
            "d5e4" "d5f3" "d5g2" "d5h1"))
    ("defend-only-move-saves-the-rook" "defensive moves"
     ;; The rook is pinned along the rank, so it cannot take the bishop.
     "6k1/5ppp/8/8/3b4/8/5PPP/r2R2K1 w - - 0 1"
     ;; The black bishop also pins the f2 pawn to the king.
     :expect (("pin" "d1") ("hanging" "d1") ("pin" "f2"))
     :best ("d1a1"))

    ;; ------------------------------------------------------ quiet controls
    ;; Ordinary positions with no tactic in them: anything reported is noise.
    ("control-start" "controls"
     "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
     :expect ())
    ("control-italian" "controls"
     "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
     :expect ())
    ("control-giuoco-pianissimo" "controls"
     ;; Each bishop pins the pawn in front of the enemy king.
     "r1bq1rk1/ppp2ppp/2np1n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQ1RK1 w - - 0 7"
     :expect (("pin" "f7") ("pin" "f2")))))

;;; Positions added AFTER the rules were changed, labelled before they were run
;;; and with no rule changed afterwards. They show how the rules do on
;;; positions they were not adjusted to.
(defparameter *held-out-positions*
  '(("held-skewer-queen-then-rook" "skewers"
     "7k/8/5r2/8/3q4/8/1B6/2K5 w - - 0 1"
     :expect (("skewer" "b2") ("hanging" "d4"))
     :best ("b2d4")
     :says (("captures_hanging" "confirmed")))
    ("held-pin-on-a-rank" "pins"
     "8/8/8/8/k2n3R/2P5/8/4K3 w - - 0 1"
     :expect (("pin" "d4") ("hanging" "d4"))
     :best ("c3d4" "h4d4"))
    ("held-pawn-fork-on-the-board" "forks"
     "4k3/8/8/2r1n3/3P4/8/8/3RK3 b - - 0 1"
     :expect (("fork" "d4") ("hanging" "c5") ("threatened" "e5")))
    ("held-hanging-pawn" "hanging pieces"
     "4k3/8/8/8/3p4/8/8/3RK3 w - - 0 1"
     :expect (("hanging" "d4"))
     :best ("d1d4")
     :says (("captures_hanging" "confirmed")))
    ("held-knight-tied-to-a-loose-bishop" "pins"
     ;; If the knight moves the queen takes the bishop with check. The bishop
     ;; is worth no more than the knight, but it is undefended: a real pin.
     "7k/6q1/8/8/8/2N5/8/B5K1 w - - 0 1"
     :expect (("pin" "c3")))
    ("held-trapped-bishop" "hanging pieces"
     "8/Bkp5/1p6/8/8/8/8/4K3 w - - 0 1"
     :expect (("hanging" "a7") ("trapped" "a7")))
    ("held-overloaded-queen" "overloaded defenders"
     "4k3/8/8/1n1q1n2/8/8/8/1R2KR2 w - - 0 1"
     :expect (("overloaded" "d5")))
    ("held-queen-hit-by-a-pawn" "defensive moves"
     "4k3/8/4p3/3q4/2P5/8/8/4K3 b - - 0 1"
     :expect (("threatened" "d5") ("hanging" "c4"))
     :best ("d5c4")
     :says (("captures_hanging" "confirmed")))
    ("held-control-pawn-ending" "controls"
     "8/8/4k3/8/8/4K3/4P3/8 w - - 0 1"
     :expect ())
    ("held-two-knights" "hanging pieces"
     "r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4"
     :expect (("hanging" "e4")))
    ("held-pinned-rook-takes-its-pinner" "hanging pieces"
     "6k1/8/8/8/8/8/8/r2R2K1 w - - 0 1"
     :expect (("pin" "d1") ("hanging" "a1") ("hanging" "d1"))
     :best ("d1a1")
     :says (("captures_hanging" "confirmed")))))

;;; A second held-out set, written for milestone 9 BEFORE the pin rule was
;;; widened to equal-valued pieces and before any of these were run. It adds
;;; what the first two sets lack: crowded opening positions labelled in full,
;;; endings, mating attacks and sacrifices, and four positions aimed at the
;;; pin rule's edge (two where an equal-valued pin is real or not, two where
;;; the geometry looks like a pin and is not).
(defparameter *second-held-out-positions*
  '(;; ------------------------------------------------ pins of equal value
    ("new-knight-tied-to-a-loose-bishop" "pins of equal value"
     ;; If the knight moves the rook takes the bishop, with check. No square
     ;; the knight can reach defends e8.
     "k3b3/8/8/4n3/8/8/8/4R2K w - - 0 1"
     :expect (("pin" "e5") ("hanging" "e5"))
     :best ("e1e5")
     :says (("captures_hanging" "confirmed")))
    ("new-knight-in-front-of-a-guarded-bishop" "pins of equal value"
     ;; The same, but the king guards the bishop: taking it would cost the rook.
     "3kb3/8/8/4n3/8/8/8/4R2K w - - 0 1"
     :expect (("hanging" "e5"))
     :best ("e1e5"))
    ("new-bishop-that-can-step-back-and-guard" "pins of equal value"
     ;; Looks like a pin on e4, but the bishop can go to d3 or f3 and guard its
     ;; partner, so moving it loses nothing. A rule that reads lines and not
     ;; moves is expected to get this one wrong.
     "4q1k1/8/8/8/4B3/8/4B3/6K1 w - - 0 1"
     :expect (("hanging" "e4")))
    ("new-pawn-in-front-of-a-pawn" "pins of equal value"
     "6k1/b7/8/8/3P4/8/5P2/7K w - - 0 1"
     :expect (("hanging" "d4")))
    ;; ------------------------------------------------------------ endings
    ("new-push-or-be-caught" "endings"
     ;; The black king is one step outside the pawn's square. Only pushing now wins.
     "8/8/8/8/P4k2/8/8/K7 w - - 0 1"
     :expect ()
     :best ("a4a5"))
    ("new-queen-check-wins-the-rook" "endings"
     "r5k1/8/8/8/8/8/8/3Q2K1 w - - 0 1"
     :expect ()
     :best ("d1d5")
     :says (("creates_fork" "confirmed")))
    ("new-knight-check-wins-the-queen" "endings"
     "4k3/8/8/1q6/4N3/8/8/4K3 w - - 0 1"
     :expect ()
     :best ("e4d6")
     :says (("creates_fork" "confirmed")))
    ("new-attacked-queen-hits-back" "endings"
     ;; The queen is attacked. Qc6+ saves it and wins the knight; Qe5+ does not (Ne7).
     "4k3/8/8/3n4/8/2Q5/8/4K3 w - - 0 1"
     :expect (("hanging" "c3"))
     :best ("c3c6")
     :says (("creates_fork" "confirmed")))
    ;; ------------------------------------------- mates and sacrifices
    ("new-back-rank-mate" "mates and sacrifices"
     "6k1/5ppp/8/8/8/8/5PPP/4R1K1 w - - 0 1"
     :expect ()
     :best ("e1e8")
     :says (("gives_check" "confirmed")))
    ("new-smothered-mate" "mates and sacrifices"
     ;; Qg8+ Rxg8 Nf7 mate: the queen is given up.
     "5r1k/6pp/7N/8/2Q5/8/8/6K1 w - - 0 1"
     :expect (("hanging" "h6"))
     :best ("c4g8")
     :says (("gives_check" "confirmed")))
    ("new-queen-given-up-on-the-back-rank" "mates and sacrifices"
     ;; Qd8+ Rxd8 Rxd8 mate.
     "1r4k1/5ppp/8/8/8/8/3Q1PPP/3R2K1 w - - 0 1"
     :expect ()
     :best ("d2d8")
     :says (("gives_check" "confirmed")))
    ;; ------------------------------------------------- crowded positions
    ("new-quiet-italian" "crowded positions"
     "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2PP1N2/PP3PPP/RNBQK2R w KQkq - 0 6"
     :expect ())
    ("new-closed-ruy-lopez" "crowded positions"
     ;; The bishop on b3 pins the f7 pawn to the king: ...f5 is illegal.
     "r1bq1rk1/2p1bppp/p1np1n2/1p2p3/4P3/1BP2N1P/PP1P1PP1/RNBQR1K1 b - - 0 9"
     :expect (("pin" "f7")))
    ("new-queens-gambit-pin" "crowded positions"
     "r1bqkb1r/pppn1ppp/4pn2/3p2B1/2PP4/2N5/PP2PPPP/R2QKBNR w KQkq - 2 5"
     :expect (("pin" "f6") ("hanging" "c4")))
    ("new-scholars-mate" "crowded positions"
     "r1bqkb1r/pppp1ppp/2n2n2/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR w KQkq - 4 4"
     :expect (("hanging" "h5") ("hanging" "e4") ("pin" "f7"))
     :best ("h5f7")
     :says (("gives_check" "confirmed")))
    ("new-stop-the-scholars-mate" "crowded positions"
     "r1bqkbnr/pppp1ppp/2n5/4p2Q/2B1P3/8/PPPP1PPP/RNB1K1NR b KQkq - 3 3"
     :expect (("pin" "f7"))
     :best ("g7g6" "d8e7" "d8f6" "g8h6")
     :avoid ("g8f6"))))
