;;;; run-tests.lisp -- engine test suite.   sbcl --script engine/tests/run-tests.lisp
;;;; Exits non-zero if any check fails.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

(defvar *failures* 0)
(defvar *checks* 0)

(defmacro check (description form expected &key (test '#'equal))
  `(let ((actual ,form) (expected ,expected))
     (incf *checks*)
     (if (funcall ,test actual expected)
         (format t "  ok    ~A~%" ,description)
         (progn (incf *failures*)
                (format t "  FAIL  ~A~%        expected ~S~%        got      ~S~%"
                        ,description expected actual)))))

(defun section (name) (format t "~&~%== ~A~%" name))

(defun getf-string (plist key)
  "GETF for the string-keyed field lists the protocol layer builds."
  (loop for (k v) on plist by #'cddr
        when (equal k key) return v))

;;; ------------------------------------------------------------------ perft
;;; Reference counts: https://www.chessprogramming.org/Perft_Results

(defparameter *perft-suite*
  '(("startpos" "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1"
     (20 400 8902 197281))
    ("kiwipete" "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"
     (48 2039 97862))
    ("endgame ep/pins" "8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1"
     (14 191 2812 43238))
    ("promotions" "r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1"
     (6 264 9467))
    ("castling/checks" "rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ - 1 8"
     (44 1486 62379))))

(defun hash-consistent-p (p depth)
  "Incremental hash equals a from-scratch hash at every node to DEPTH."
  (and (= (pos-hash p) (compute-hash p))
       (or (zerop depth)
           (let* ((moves (make-move-array)) (n (generate-moves p moves)))
             (dotimes (i n t)
               (when (make-move p (aref moves i))
                 (let ((ok (hash-consistent-p p (1- depth))))
                   (unmake-move p)
                   (unless ok (return nil)))))))))

(section "perft")
(dolist (entry *perft-suite*)
  (destructuring-bind (name fen counts) entry
    (loop for expected in counts
          for depth from 1
          do (check (format nil "~A depth ~D" name depth)
                    (perft (pos-from-fen fen) depth) expected))))

(section "make/unmake and hashing")
(dolist (entry *perft-suite*)
  (destructuring-bind (name fen counts) entry
    (declare (ignore counts))
    (let* ((p (pos-from-fen fen)) (before (pos-to-fen p)))
      (check (format nil "~A incremental hash matches recomputed hash" name)
             (hash-consistent-p p 3) t)
      (check (format nil "~A position restored after perft" name)
             (progn (perft p 3) (pos-to-fen p)) before))))
(check "FEN round trip"
       (pos-to-fen (pos-from-fen "r3k2r/8/8/3pP3/8/8/8/R3K2R w Kq d6 4 20"))
       "r3k2r/8/8/3pP3/8/8/8/R3K2R w Kq d6 4 20")
(check "copy-position is independent"
       (let* ((p (pos-from-fen +start-fen+)) (c (copy-position p)))
         (make-move c (parse-uci-move c "e2e4"))
         (pos-to-fen p))
       +start-fen+)

(section "notation")
(flet ((san (fen uci)
         (let ((p (pos-from-fen fen)))
           (move-san p (parse-uci-move p uci)))))
  (check "pawn push" (san +start-fen+ "e2e4") "e4")
  (check "knight move" (san +start-fen+ "g1f3") "Nf3")
  (check "castle short" (san "r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1" "e1g1") "O-O")
  (check "castle long" (san "r3k2r/8/8/8/8/8/8/R3K2R b KQkq - 0 1" "e8c8") "O-O-O")
  (check "file disambiguation" (san "4k3/8/8/8/8/8/4K3/R6R w - - 0 1" "a1d1") "Rad1")
  (check "rank disambiguation" (san "4k3/8/8/R7/8/8/8/R3K3 w - - 0 1" "a1a3") "R1a3")
  (check "capture promotion with check"
         (san "3rk3/4P3/8/8/8/8/8/4K3 w - - 0 1" "e7d8q") "exd8=Q+")
  (check "en passant" (san "4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1" "e5d6") "exd6")
  (check "checkmate suffix"
         (san "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1" "a1a8") "Ra8#"))

(section "game rules")
(check "stalemate has no legal move and no check"
       (let ((p (pos-from-fen "7k/5Q2/6K1/8/8/8/8/8 b - - 0 1")))
         (list (has-legal-move-p p) (in-check-p p)))
       '(nil nil))
(check "K+N vs K is insufficient material"
       (insufficient-material-p (pos-from-fen "8/8/4k3/8/8/2N5/8/4K3 w - - 0 1")) t)
(check "K+R vs K is sufficient material"
       (insufficient-material-p (pos-from-fen "8/8/4k3/8/8/2R5/8/4K3 w - - 0 1")) nil)
(check "repetition is counted"
       (let ((p (pos-from-fen +start-fen+)))
         (dolist (uci '("g1f3" "g8f6" "f3g1" "f6g8" "g1f3" "g8f6" "f3g1" "f6g8"))
           (make-move p (parse-uci-move p uci)))
         (repetition-count p))
       2)

(section "evaluation")
(check "start position is balanced" (evaluate (pos-from-fen +start-fen+)) 0)
(check "evaluation is colour-symmetric"
       (let ((white (pos-from-fen "r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2NP1N2/PPP2PPP/R1BQK2R w KQkq - 0 1"))
             (black (pos-from-fen "r1bqk2r/ppp2ppp/2np1n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R b KQkq - 0 1")))
         (= (evaluate white) (evaluate black)))
       t)
(check "breakdown total equals evaluate"
       (let ((p (pos-from-fen "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")))
         (= (jget (eval-breakdown p) "total") (evaluate p)))
       t)

(section "static exchange evaluation")
(flet ((exchange (fen uci)
         (let ((p (pos-from-fen fen)))
           (see p (parse-uci-move p uci)))))
  (check "taking an undefended pawn wins it"
         (exchange "4k3/8/8/3p4/8/8/3R4/4K3 w - - 0 1" "d2d5") 100)
  (check "rook takes a pawn defended by a pawn: loses rook for pawn"
         (exchange "4k3/8/4p3/3p4/8/8/3R4/4K3 w - - 0 1" "d2d5") -400)
  (check "a second rook behind the first is seen through (x-ray)"
         (exchange "4k3/8/4p3/3p4/8/8/3R4/3RK3 w - - 0 1" "d2d5") -300)
  (check "knight takes a defended knight: even"
         (exchange "4k3/8/2p5/3n4/8/2N5/8/4K3 w - - 0 1" "c3d5") 0)
  (check "pawn takes a defended queen: wins queen for pawn"
         (exchange "4k3/8/2p5/3q4/4P3/8/8/4K3 w - - 0 1" "e4d5") 800)
  (check "the side to recapture may decline a losing recapture"
         ;; Black's queen is the only defender: retaking would lose it to the rook behind.
         (exchange "3qk3/8/8/3p4/8/8/3R4/3RK3 w - - 0 1" "d2d5") 100))
(check "exchange evaluation leaves the board untouched"
       (let* ((fen "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
              (p (pos-from-fen fen)))
         (dolist (m (legal-moves p)) (see p m))
         (pos-to-fen p))
       "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")

(section "feature switches")
(flet ((best (fen depth)
         (tt-clear)
         (let ((p (pos-from-fen fen)))
           (move-uci (search-result-best-move (search-position p :max-depth depth))))))
  (set-engine-features :activity nil :see nil :lmr nil :aspiration nil :delta nil)
  (check "first engine (all features off) still mates in 2"
         (best "7k/8/5K2/8/8/8/8/6R1 w - - 0 1" 4) "f6f7")
  (check "first engine evaluates the start position as balanced"
         (evaluate (pos-from-fen +start-fen+)) 0)
  (set-engine-features)
  (check "full engine finds the quiet first move of a mate in 2"
         ;; Kf7 is a quiet king move tried late: reductions must not hide it.
         (best "7k/8/5K2/8/8/8/8/6R1 w - - 0 1" 4) "f6f7")
  (check "full engine finds the knight fork"
         (best "4k3/8/8/8/3n4/8/8/Q3K3 b - - 0 1" 4) "d4c2")
  (check "breakdown includes the new terms and still sums to evaluate"
         (let* ((p (pos-from-fen "r1bq1rk1/ppp2ppp/2n1pn2/3p4/3P1B2/2P1PN2/PP3PPP/RN1QKB1R w KQ - 0 1"))
                (b (eval-breakdown p)))
           (and (integerp (jget b "activity")) (integerp (jget b "kingSafety"))
                (= (jget b "total") (evaluate p))))
         t))

(section "difficulty levels")
(let ((novice (find-level "novice")))
  (labels ((novice-moves (fen trials)
             ;; Every distinct move Novice chooses over TRIALS choices.
             (let ((p (pos-from-fen fen))
                   (state (sb-ext:seed-random-state 7))
                   (moves '()))
               (apply-level-features novice)
               (tt-clear)
               (let ((r (search-position p :max-depth (level-depth novice))))
                 (dotimes (i trials)
                   (pushnew (choose-level-move p r novice state) moves)))
               (set-engine-features)
               moves))
           (uci-list (moves) (sort (mapcar #'move-uci moves) #'string<))
           (gives-material-away-p (fen move)
             ;; After MOVE, can the opponent win a minor piece or more at once?
             (let ((p (pos-from-fen fen)))
               (make-move p move)
               (some (lambda (reply) (and (move-capture-p reply) (>= (see p reply) 300)))
                     (legal-moves p)))))
    (check "novice varies its first move"
           (> (length (novice-moves +start-fen+ 40)) 1) t)
    (check "novice never passes up a mate in one"
           (uci-list (novice-moves "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1" 40)) '("a1a8"))
    (check "novice takes a free queen, nothing else comes close"
           (uci-list (novice-moves "4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1" 40)) '("d2d5"))
    (let ((fen "4k3/8/2p5/3p4/4Q3/8/8/4K3 w - - 0 1")) ; the queen is attacked by a pawn
      (check "novice never leaves a piece to be taken next move"
             (notany (lambda (m) (gives-material-away-p fen m)) (novice-moves fen 60)) t))
    (let ((fen "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1"))
      (check "novice gives nothing away in an ordinary opening position"
             (notany (lambda (m) (gives-material-away-p fen m)) (novice-moves fen 60)) t))))
(check "club and expert always play the search's best move"
       (let* ((p (pos-from-fen +start-fen+))
              (r (progn (tt-clear) (search-position p :max-depth 4))))
         (list (multiple-value-list (choose-level-move p r (find-level "club")))
               (multiple-value-list (choose-level-move p r (find-level "expert")))))
       (let* ((p (pos-from-fen +start-fen+))
              (best (search-result-best-move (progn (tt-clear) (search-position p :max-depth 4)))))
         (list (list best t) (list best t))))
(check "a level's depth and time respect the server's ceilings"
       (let ((g (make-game)) (*max-depth* 7) (*max-move-time-ms* 1500))
         (set-game-level g (find-level "expert"))
         (list (game-level g) (game-depth g) (game-move-time-ms g)))
       '("expert" 7 1500))
(check "the explanation is about the move played, not the one passed over"
       (let* ((p (pos-from-fen +start-fen+))
              (r (progn (tt-clear) (search-position p :max-depth 3)))
              (other (find (search-result-best-move r) (legal-moves p) :test #'/=))
              (fields (build-explanation p (search-line p other 3) nil :play "the note")))
         (list (string= (jget (getf-string fields "move") "uci") (move-uci other))
               (jget (first (getf-string fields "items")) "text")))
       '(t "the note"))

(section "search")
(flet ((best (fen depth)
         (tt-clear)
         (let ((p (pos-from-fen fen)))
           (move-uci (search-result-best-move (search-position p :max-depth depth))))))
  (check "mate in 1 (back rank)" (best "6k1/5ppp/8/8/8/8/8/R3K3 w - - 0 1" 3) "a1a8")
  (check "mate in 2 (Kf7 then Rh1#)" (best "7k/8/5K2/8/8/8/8/6R1 w - - 0 1" 4) "f6f7")
  (check "wins a hanging queen" (best "4k3/8/8/3q4/8/8/3R4/4K3 w - - 0 1" 3) "d2d5")
  (check "black finds the knight fork of king and queen"
         (best "4k3/8/8/8/3n4/8/8/Q3K3 b - - 0 1" 4) "d4c2")
  (check "avoids stalemating when a win is available"
         (not (string= (best "7k/8/5QK1/8/8/8/8/8 w - - 0 1" 4) "f6f7")) t))
(check "search is deterministic"
       (flet ((run ()
                (tt-clear)
                (let ((r (search-position (pos-from-fen +start-fen+) :max-depth 5)))
                  (list (move-uci (search-result-best-move r)) (search-result-score r)
                        (search-result-nodes r)))))
         (equal (run) (run)))
       t)
(check "search leaves the caller's position untouched"
       (let ((p (pos-from-fen +start-fen+)))
         (search-position p :max-depth 4)
         (pos-to-fen p))
       +start-fen+)
(check "stop function aborts promptly"
       (let ((r (progn (tt-clear)
                       (search-position (pos-from-fen +start-fen+) :max-depth 30
                                                                   :stop-fn (lambda () t)))))
         (< (search-result-depth r) 8))
       t)
(check "principal variation is a legal line"
       (let* ((p (pos-from-fen "r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1"))
              (r (progn (tt-clear) (search-position p :max-depth 5))))
         (= (length (pv-san p (search-result-pv r))) (length (search-result-pv r))))
       t)

(section "Prolog unavailable")
;; The engine must keep playing, and say so, when the knowledge layer cannot
;; be started. A program name that does not exist stands in for a broken install.
(let ((*swipl-program* "symchess-no-such-prolog")
      (*error-output* (make-broadcast-stream)) ; the bridge logs the failure; keep output clean
      (p (pos-from-fen "r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 3 4")))
  (stop-prolog)
  (let* ((analysis (symbolic-analysis p))
         (hints (symbolic-hints p analysis))
         (result (progn (tt-clear) (search-position p :max-depth 4 :hints hints)))
         (fields (build-explanation p result analysis))
         (items (getf-string fields "items")))
    (check "analysis is NIL, not an error" analysis nil)
    (check "no line-end facts are invented either"
           (expected-facts p (search-result-pv result)) nil)
    (check "no ordering hints are invented" hints nil)
    (check "search still returns a legal move"
           (and (member (search-result-best-move result) (legal-moves p)) t) t)
    (check "symbolic_analysis message reports unavailable"
           (getf-string (symbolic-fields 1 analysis) "status") "unavailable")
    (check "explanation says it is search-only"
           (and (find-if (lambda (item)
                           (and (string= (jget item "source") "prolog")
                                (search "unavailable" (jget item "text"))))
                         items)
                t)
           t)
    (check "explanation still carries the measured search facts"
           (and (find "measured" items :key (lambda (item) (jget item "status")) :test #'string=)
                t)
           t)))
(stop-prolog)

(section "where the line leads")
;; These need a working Prolog. If it cannot be started they are reported as
;; skipped rather than failed: the engine is specified to work without it.
(let* ((p (pos-from-fen "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1"))
       (fork (parse-uci-move p "b5c7"))
       (reply (let ((q (copy-position p)))
                (make-move q fork)
                (first (legal-moves q)))))
  (if (null (symbolic-analysis p))
      (format t "  skip  Prolog is not available~%")
      (let ((facts (expected-facts p (list fork reply))))
        (check "a one-move line has no 'end of the line' to describe"
               (expected-facts p (list fork)) nil)
        (check "at most three facts are reported" (<= (length facts) 3) t)
        (check "every reported fact is a tactical kind with a sentence"
               (every (lambda (f)
                        (and (member (jget f "kind") *line-end-kinds* :test #'equal)
                             (plusp (length (jget f "text")))))
                      facts)
               t)
        (check "the explanation says where the line leads"
               (let* ((sample (list (obj "kind" "fork" "text" "A fork." "squares" '("c7"))))
                      (r (progn (tt-clear) (search-position p :max-depth 3)))
                      (items (getf-string (build-explanation p r nil :play nil sample) "items")))
                 (and (find "At the end of the expected line: A fork." items
                            :key (lambda (i) (jget i "text")) :test #'string=)
                      t))
               t))))

(section "replaying a line")
(let* ((p (pos-from-fen "r3k3/8/8/1N6/8/8/8/4K3 w - - 0 1"))
       (fork (parse-uci-move p "b5c7"))
       (q (let ((q (copy-position p))) (make-move q fork) q))
       (reply (first (legal-moves q)))
       (steps (line-replay-steps p (list fork reply)))
       (before (pos-to-fen p)))
  (check "one step for the start and one per move" (length steps) 3)
  (check "the first step is the starting position, with no move"
         (list (jget (first steps) "fen") (jget (first steps) "move")) (list before :null))
  (check "each later step names its move and who made it"
         (list (jget (jget (second steps) "move") "san") (jget (second steps) "by"))
         (list "Nc7+" "white"))
  (check "a step reports check on the king's square" (jget (second steps) "check") "e8")
  (check "the step's board is the position after the move"
         (jget (jget (second steps) "board") "c7") "wN")
  (check "the position passed in is left alone" (pos-to-fen p) before)
  (check "a move that is not legal ends the line there"
         (length (line-replay-steps p (list fork fork))) 2)
  (check "a long line is cut to the step limit"
         (let ((*line-steps* 1)) (length (line-replay-steps p (list fork reply)))) 2))
(let* ((p (pos-from-fen "6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1"))
       (steps (line-replay-steps p (list (parse-uci-move p "a1a8")))))
  (check "a step that ends the game says checkmate and asks Prolog nothing"
         (list (jget (second steps) "checkmate") (jget (second steps) "facts"))
         (list :true '())))
(stop-prolog)

(section "json and websocket primitives")
(check "json round trip"
       (json-encode (json-decode "{\"a\":[1,2,{\"b\":null}],\"c\":\"x\\ny\",\"d\":true,\"e\":-3}"))
       "{\"a\":[1,2,{\"b\":null}],\"c\":\"x\\ny\",\"d\":true,\"e\":-3}")
(check "json empty containers" (json-encode (obj "a" '() "b" (obj))) "{\"a\":[],\"b\":{}}")
(check "RFC 6455 accept key" (ws-accept-key "dGhlIHNhbXBsZSBub25jZQ==")
       "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
(check "sha1 of empty input"
       (format nil "~{~2,'0x~}" (coerce (sha1 (make-array 0 :element-type '(unsigned-byte 8))) 'list))
       "DA39A3EE5E6B4B0D3255BFEF95601890AFD80709")

(format t "~&~%~D checks, ~D failure~:P~%" *checks* *failures*)
(sb-ext:exit :code (if (zerop *failures*) 0 1))
