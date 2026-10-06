;;;; bench.lisp -- performance and "is the symbolic layer earning its keep?"
;;;; numbers.   sbcl --script engine/tests/bench.lisp
;;;;
;;;; Step D/E of the verification loop: for each position, search the same
;;;; depth with and without Prolog's root hints and compare node counts and
;;;; the chosen move. Hints only reorder root moves, so the score must match.

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

(format t "~&== perft speed~%")
(let* ((p (pos-from-fen +start-fen+))
       (start (now-ms))
       (nodes (perft p 5))
       (ms (max 1 (- (now-ms) start))))
  (format t "  perft(5) = ~:D leaves in ~D ms  (~:D leaves/s)~%" nodes ms (floor (* 1000 nodes) ms)))

(format t "~&~%== search depth ~D: plain vs Prolog root hints~%" *depth*)
(format t "  ~16A ~8A ~10A ~10A ~7A ~7A ~8A ~6A~%"
        "position" "prolog" "nodes" "+hints" "change" "move" "+hints" "score=")
(let ((total-plain 0) (total-hinted 0) (prolog-ms 0) (count 0))
  (dolist (entry *positions*)
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
        (incf prolog-ms ms)
        (incf count)
        (format t "  ~16A ~5D ms ~10:D ~10:D ~6,1F% ~7A ~8A ~6A~%"
                name ms n1 n2 (* 100.0 (/ (- n2 n1) n1))
                (move-san p (search-result-best-move plain))
                (move-san p (search-result-best-move hinted))
                (if (= (search-result-score plain) (search-result-score hinted)) "yes" "NO")))))
  (format t "~%  total nodes: ~:D plain, ~:D with hints (~,1F%)~%"
          total-plain total-hinted (* 100.0 (/ (- total-hinted total-plain) total-plain)))
  (format t "  mean Prolog root analysis: ~,1F ms per position (uncached)~%"
          (/ prolog-ms count)))

(format t "~&~%== search speed~%")
(let* ((p (pos-from-fen "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1"))
       (r (progn (tt-clear) (search-position p :max-depth 7))))
  (format t "  kiwipete depth ~D: ~:D nodes in ~D ms (~:D nodes/s)~%"
          (search-result-depth r) (search-result-nodes r) (search-result-time-ms r)
          (floor (* 1000 (search-result-nodes r)) (max 1 (search-result-time-ms r)))))

(stop-prolog)
(sb-ext:exit :code 0)
