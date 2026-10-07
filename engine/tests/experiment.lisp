;;;; experiment.lisp -- one runner for "does this change help?", with the
;;;; answer written to a file.
;;;;
;;;;   sbcl --script engine/tests/experiment.lisp               about a minute
;;;;       every configuration: work to reach a fixed depth, and labelled
;;;;       moves played right                      -> results/search.json
;;;;
;;;;   sbcl --script engine/tests/experiment.lisp matches [ms]  about 35 minutes at 100 ms
;;;;       self-play matches, 24 games each         -> results/matches.json
;;;;
;;;; The configurations are named in engine/src/experiment.lisp. Each results
;;;; file records the date, machine, commit and command, and what every
;;;; configuration switches on, so a figure on the results page can be traced
;;;; to the run that produced it and the run can be repeated.
;;;;
;;;; A measurement, not a test: the exit status is 0 whatever the numbers are.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

(load (merge-pathnames "credibility-positions.lisp" *load-truename*))

(defparameter *arguments*
  (let ((tail (member-if (lambda (a) (search "experiment" a)) sb-ext:*posix-argv*)))
    (if tail (rest tail) (rest sb-ext:*posix-argv*))))

(defparameter *names* (mapcar #'first *experiment-configurations*))

;; Seven positions of different kinds, and twelve ordinary openings a few moves in.
(defparameter *depth-positions*
  (append
   '(("start" "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")
     ("italian" "r1bqk1nr/pppp1ppp/2n5/2b1p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 4 4")
     ("pinned knight" "r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1")
     ("kiwipete" "r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1")
     ("fork available" "r3k2r/ppp2ppp/2n5/3N4/8/8/PPP2PPP/R3K2R w KQkq - 0 1")
     ("hanging piece" "r1bqkb1r/pppp1ppp/2n5/4p2n/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 1")
     ("rook endgame" "8/5pk1/6p1/8/3R4/6P1/r4PK1/8 w - - 0 1"))
   (mapcar (lambda (entry)
             (list (first entry) (pos-to-fen (opening-position (rest entry)))))
           *match-openings*)))

(defparameter *depth* 6)
(defparameter *time-ms* 2000)

(defun labelled-entries ()
  "Every benchmark position with a labelled move, from all three sets."
  (loop for entry in (append *credibility-positions* *held-out-positions* *second-held-out-positions*)
        for (id nil fen . keys) = entry
        when (or (getf keys :best) (getf keys :avoid))
          collect (list id fen (getf keys :best) (getf keys :avoid))))

(defun run-search-measures ()
  (let ((entries (labelled-entries))
        (depth-rows '())
        (move-rows '()))
    (format t "~&== work to reach depth ~D over ~D positions~%" *depth* (length *depth-positions*))
    (format t "   ~12A ~12@A ~10@A ~10@A~%" "configuration" "positions" "search ms" "prolog ms")
    (dolist (name *names*)
      (let ((row (measure-depth name *depth-positions* *depth*)))
        (push row depth-rows)
        (format t "   ~12A ~12:D ~10D ~10A~%" name (jget row "nodes") (jget row "searchMs")
                (let ((ms (jget row "prologMs"))) (if (eq ms :null) "" ms)))
        (finish-output)))
    (format t "~%== labelled moves played right, depth ~D within ~D ms, ~D positions~%"
            *depth* *time-ms* (length entries))
    (dolist (name *names*)
      (let ((row (measure-labelled-moves name entries *depth* *time-ms*)))
        (push row move-rows)
        (format t "   ~12A ~D of ~D~{  ~A~}~%" name (jget row "right") (jget row "positions")
                (mapcar (lambda (m) (format nil "(~A: ~A)" (jget m "position") (jget m "played")))
                        (jget row "missed")))
        (finish-output)))
    (let ((path (write-results
                 "search"
                 (obj "run" (run-metadata "sbcl --script engine/tests/experiment.lisp")
                      "configurations" (mapcar #'configuration-object *names*)
                      "depth" (obj "what" "Positions searched to reach a fixed depth, with no time limit. The counts do not depend on the machine."
                                   "depth" *depth*
                                   "positions" (mapcar #'first *depth-positions*)
                                   "rows" (reverse depth-rows))
                      "moves" (obj "what" "Benchmark positions with a labelled move where the configuration played a right move and no wrong one."
                                   "depth" *depth*
                                   "timeLimitMs" *time-ms*
                                   "rows" (reverse move-rows))))))
      (format t "~%written to ~A~%" (enough-namestring path)))))

(defparameter *pairings*
  '(("new" "old") ("hints" "new")
    ("activity" "old") ("see" "old") ("lmr" "old") ("aspiration" "old") ("delta" "old")))

(defun run-matches (ms)
  (let ((rows '())
        ;; Taken once, at the start: it describes the program that is running.
        (run (run-metadata (format nil "sbcl --script engine/tests/experiment.lisp matches ~D" ms)))
        (names (remove-duplicates (apply #'append *pairings*) :test #'string= :from-end t)))
    (dolist (pairing *pairings*)
      (destructuring-bind (candidate baseline) pairing
        (format t "~&== ~A against ~A, ~D ms per move~%" candidate baseline ms)
        (let ((row (play-match candidate baseline ms
                               :on-game (lambda (opening white scored)
                                          (declare (ignore opening white))
                                          (format t "~A" (ecase scored (:win "+") (:draw "=") (:loss "-")))
                                          (finish-output)))))
          (push row rows)
          (format t "~%   ~D wins, ~D draws, ~D losses: ~,1F% of the points~%"
                  (jget row "wins") (jget row "draws") (jget row "losses") (jget row "points")))
        ;; Written after every match, so a long run that is stopped keeps what it finished.
        (write-results
         "matches"
         (obj "run" run
              "configurations" (mapcar #'configuration-object names)
              "what" "Self-play: twelve openings, each played twice with colours swapped. Both sides get the same time per move, and the time Prolog takes is counted against the side that asks it."
              "openings" (mapcar #'first *match-openings*)
              "complete" (jbool (= (length rows) (length *pairings*)))
              "rows" (reverse rows)))))
    (format t "~%written to ~A~%" (enough-namestring (results-path "matches")))))

(if (equal (first *arguments*) "matches")
    (run-matches (if (second *arguments*) (parse-integer (second *arguments*)) 100))
    (run-search-measures))
(set-engine-features)
(stop-prolog)
