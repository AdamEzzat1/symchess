;;;; bench.lisp -- performance and "is the symbolic layer earning its keep?"
;;;; numbers.   sbcl --script engine/tests/bench.lisp
;;;;
;;;; Step D/E of the verification loop: for each position, search the same
;;;; depth with and without Prolog's root hints and compare node counts and
;;;; the chosen move. Hints only reorder root moves. Since late move reductions
;;;; were added, that order also decides which moves are searched less deeply,
;;;; so the score can occasionally differ as well as the node count.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

(defparameter *positions*
  '(("start" "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
    ("italian" "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
    ("pinned knight" "r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1")
    ("kiwipete" "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
    ("fork available" "r3k2r/ppp2ppp/2n5/3N4/8/8/PPP2PPP/R3K2R w KQkq - 0 1")
    ("hanging piece" "r1bqkb1r/pppp1ppp/2n5/4p2n/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1")
    ("rook endgame" "8/5pk1/6p1/8/3R4/6P1/r4PK1/8 w - - 0 1")))

(defparameter *depth* 6)

;; More positions for the hint experiment: ordinary openings, a few moves in.
(defparameter *openings*
  '(("open game" "e2e4" "e7e5" "g1f3" "b8c6")
    ("queen's gambit" "d2d4" "d7d5" "c2c4" "e7e6")
    ("sicilian" "e2e4" "c7c5" "g1f3" "d7d6")
    ("king's indian" "d2d4" "g8f6" "c2c4" "g7g6")
    ("french" "e2e4" "e7e6" "d2d4" "d7d5")
    ("english" "c2c4" "e7e5" "b1c3" "g8f6")
    ("reti" "g1f3" "d7d5" "g2g3" "g8f6")
    ("caro-kann" "e2e4" "c7c6" "d2d4" "d7d5")
    ("london" "d2d4" "d7d5" "g1f3" "g8f6" "c1f4" "e7e6")
    ("scandinavian" "e2e4" "d7d5" "e4d5" "d8d5")
    ("modern" "e2e4" "g7g6" "d2d4" "f8g7")
    ("dutch" "d2d4" "f7f5" "g2g3" "g8f6")))

(defparameter *hint-positions*
  (append *positions*
          (mapcar (lambda (entry)
                    (let ((p (pos-from-fen +start-fen+)))
                      (dolist (uci (rest entry))
                        (make-move p (parse-uci-move p uci)))
                      (list (first entry) (pos-to-fen p))))
                  *openings*)))

(format t "~&== perft speed~%")
(let* ((p (pos-from-fen +start-fen+))
       (start (now-ms))
       (nodes (perft p 5))
       (ms (max 1 (- (now-ms) start))))
  (format t "  perft(5) = ~:D leaves in ~D ms  (~:D leaves/s)~%" nodes ms (floor (* 1000 nodes) ms)))

(format t "~&~%== search depth ~D: plain vs Prolog root hints~%" *depth*)
(format t "  ~16A ~8A ~10A ~10A ~7A ~7A ~8A ~6A~%"
        "position" "prolog" "nodes" "+hints" "change" "move" "+hints" "score=")
(let ((total-plain 0) (total-hinted 0) (prolog-ms 0) (count 0)
      (fewer 0) (more 0) (same-move 0) (moves 0) (warm-ms 0))
  (dolist (entry *hint-positions*)
    (destructuring-bind (name fen) entry
      (let* ((p (pos-from-fen fen))
             (t0 (now-ms))
             (analysis (symbolic-analysis p))
             (ms (- (now-ms) t0))
             (hints (symbolic-hints p analysis))
             (plain (progn (tt-clear) (search-position p :max-depth *depth*)))
             (hinted (progn (tt-clear) (search-position p :max-depth *depth* :hints hints)))
             (n1 (search-result-nodes plain))
             (n2 (search-result-nodes hinted)))
        (incf total-plain n1)
        (incf total-hinted n2)
        ;; The very first query also starts Prolog: leave it out of the mean.
        (when (plusp count) (incf warm-ms ms))
        (incf prolog-ms ms)
        (incf count)
        (incf moves (length (legal-moves p)))
        (cond ((< n2 n1) (incf fewer)) ((> n2 n1) (incf more)))
        (when (= (search-result-best-move plain) (search-result-best-move hinted))
          (incf same-move))
        (format t "  ~16A ~5D ms ~10:D ~10:D ~6,1F% ~7A ~8A ~6A~%"
                name ms n1 n2 (* 100.0 (/ (- n2 n1) n1))
                (move-san p (search-result-best-move plain))
                (move-san p (search-result-best-move hinted))
                (if (= (search-result-score plain) (search-result-score hinted)) "yes" "NO")))))
  (format t "~%  total nodes: ~:D plain, ~:D with hints (~,1F%)~%"
          total-plain total-hinted (* 100.0 (/ (- total-hinted total-plain) total-plain)))
  (format t "  hints searched fewer nodes in ~D of ~D positions, more in ~D; same move chosen in ~D~%"
          fewer count more same-move)
  (let ((query (/ warm-ms (max 1 (1- count))))
        (branching (/ moves count)))
    (format t "  mean Prolog root analysis: ~,1F ms per position (after the first)~%" query)
    ;; Experiment D, by arithmetic: what would it cost to ask Prolog about
    ;; every position two moves from the root?
    (format t "  mean legal moves: ~,1F; so analysing every position two plies down~%" branching)
    (format t "  would take about ~,1F s per move, before any searching~%"
            (/ (* branching branching query) 1000.0))))

(format t "~&~%== search speed~%")
(let* ((p (pos-from-fen "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"))
       (r (progn (tt-clear) (search-position p :max-depth 7))))
  (format t "  kiwipete depth ~D: ~:D nodes in ~D ms (~:D nodes/s)~%"
          (search-result-depth r) (search-result-nodes r) (search-result-time-ms r)
          (floor (* 1000 (search-result-nodes r)) (max 1 (search-result-time-ms r)))))

(format t "~&~%== first engine against current engine: reaching depth 7~%")
(format t "  ~16A ~12A ~8A ~12A ~8A ~8A~%" "position" "old nodes" "old ms" "new nodes" "new ms" "speed-up")
(let ((old-ms 0) (new-ms 0))
  (dolist (entry *positions*)
    (destructuring-bind (name fen) entry
      (flet ((run ()
               (tt-clear)
               (search-position (pos-from-fen fen) :max-depth 7)))
        (let* ((old (progn (set-engine-features :activity nil :see nil :lmr nil
                                                :aspiration nil :delta nil)
                           (run)))
               (new (progn (set-engine-features) (run)))
               (t1 (max 1 (search-result-time-ms old)))
               (t2 (max 1 (search-result-time-ms new))))
          (incf old-ms t1)
          (incf new-ms t2)
          (format t "  ~16A ~12:D ~8D ~12:D ~8D ~7,1Fx~%" name
                  (search-result-nodes old) t1 (search-result-nodes new) t2 (/ t1 t2))))))
  (format t "~%  total: ~D ms old, ~D ms new (~,1Fx)~%" old-ms new-ms (/ old-ms (max 1 new-ms))))
(set-engine-features)

(stop-prolog)
(sb-ext:exit :code 0)
