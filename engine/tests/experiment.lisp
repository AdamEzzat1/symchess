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
;;;;   sbcl --script engine/tests/experiment.lisp ladder [ms]   about 25 minutes at 1000 ms
;;;;       each difficulty level against the one below it. Novice, Casual and
;;;;       Club search to their own fixed depth; only Expert uses the clock,
;;;;       so [ms] is Expert's time per move  -> results/ladder.json
;;;;
;;;;   sbcl --script engine/tests/experiment.lisp strength [ms ...]   about 10 minutes at 100 ms
;;;;       the engine against itself as it was at version 0.7.0, 48 games at
;;;;       each time given (default 100 and 300)   -> results/strength.json
;;;;
;;;;   sbcl --script engine/tests/experiment.lisp verify
;;;;       were the recorded files made by the sources as they are now? Compares
;;;;       each file's fingerprint with the engine and rule files on disk and
;;;;       exits non-zero if any differ. Run it before publishing results.
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

(defun run-pairings (file pairings ms what command)
  (let ((rows '())
        (run (run-metadata command))
        (names (remove-duplicates (apply #'append pairings) :test #'string= :from-end t)))
    (dolist (pairing pairings)
      (destructuring-bind (candidate baseline) pairing
        (format t "~&== ~A against ~A~%" candidate baseline)
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
         file
         (obj "run" run
              "configurations" (mapcar (lambda (name)
                                         (let ((level (find-level name)))
                                           (if level
                                               (obj "name" name
                                                    "description" (format nil "Difficulty level: depth ~D, ~:[the first engine's evaluation~;the full evaluation~], may pick a move within ~,2F pawns of its best."
                                                                          (level-depth level) (level-full level)
                                                                          (/ (level-margin level) 100.0))
                                                    "features" (obj) "rootHints" :false)
                                               (configuration-object name))))
                                       names)
              "what" what
              "openings" (mapcar #'first *match-openings*)
              "complete" (jbool (= (length rows) (length pairings)))
              "rows" (reverse rows)))))
    (format t "~%written to ~A~%" (enough-namestring (results-path file)))))

(defun run-strength (times)
  "The engine as it is against the engine as it was, over twice the usual
openings, once for each time per move in TIMES."
  (let ((rows '())
        (openings (append *match-openings* *more-openings*))
        (run (run-metadata (format nil "sbcl --script engine/tests/experiment.lisp strength~{ ~D~}" times))))
    (dolist (ms times)
      (format t "~&== new against v07, ~D ms per move, ~D games~%" ms (* 2 (length openings)))
      (let ((row (play-match "new" "v07" ms
                             :openings openings
                             :on-game (lambda (opening white scored)
                                        (declare (ignore opening white))
                                        (format t "~A" (ecase scored (:win "+") (:draw "=") (:loss "-")))
                                        (finish-output)))))
        (push row rows)
        (format t "~%   ~D wins, ~D draws, ~D losses: ~,1F% of the points~%"
                (jget row "wins") (jget row "draws") (jget row "losses") (jget row "points")))
      (write-results
       "strength"
       (obj "run" run
            "configurations" (mapcar #'configuration-object '("new" "v07"))
            "what" "The engine as it is now against itself as it was at version 0.7.0: twenty-four openings, each played twice with colours swapped, both sides with the same time per move."
            "openings" (mapcar #'first openings)
            "complete" (jbool (= (length rows) (length times)))
            "rows" (reverse rows))))
    (format t "~%written to ~A~%" (enough-namestring (results-path "strength")))))

(defun run-ladder (ms)
  (run-pairings
   "ladder"
   '(("casual" "novice") ("club" "casual") ("club" "novice") ("expert" "club"))
   ms
   (format nil "The difficulty levels against each other: twelve openings, each played twice with colours swapped. Novice, Casual and Club search to their own fixed depth with no clock. Expert had ~D ms per move, a third of its real allowance." ms)
   (format nil "sbcl --script engine/tests/experiment.lisp ladder ~D" ms)))

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

(let ((mode (first *arguments*))
      (ms (and (second *arguments*) (parse-integer (second *arguments*)))))
  (cond ((equal mode "verify")
         (let ((now (source-digest)) (stale 0))
           (format t "~&sources on disk: ~A~%" now)
           (dolist (name '("search" "matches" "ladder" "strength" "credibility"))
             (let* ((path (results-path name))
                    (run (and (probe-file path)
                              (jget (json-decode
                                     (with-open-file (in path :external-format :utf-8)
                                       (let ((text (make-string (file-length in))))
                                         (subseq text 0 (read-sequence text in)))))
                                    "run")))
                    (digest (and run (jget run "sourceDigest"))))
               (cond ((null digest) (incf stale) (format t "  ~12A missing~%" name))
                     ((string= digest now)
                      (format t "  ~12A matches (recorded ~A)~%" name (jget run "date")))
                     (t (incf stale)
                        (format t "  ~12A STALE: made by ~A on ~A~%" name digest (jget run "date"))))))
           (stop-prolog)
           (sb-ext:exit :code (if (zerop stale) 0 1))))
        ((equal mode "matches") (run-matches (or ms 100)))
        ((equal mode "ladder") (run-ladder (or ms 1000)))
        ((equal mode "strength")
         (run-strength (or (mapcar #'parse-integer (rest *arguments*)) '(100 300))))
        (t (run-search-measures))))
(set-engine-features)
(stop-prolog)
