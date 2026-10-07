;;;; selfplay.lisp -- does a change make the engine stronger?
;;;;
;;;;   sbcl --script engine/tests/selfplay.lisp [ms-per-move] [candidate] [baseline]
;;;;
;;;; Plays the engine against itself with different features switched on, from
;;;; a set of ordinary openings, each played twice with colours swapped so that
;;;; neither side is favoured by the position. Both sides get the same time per
;;;; move, so a feature that costs speed has to pay for itself.
;;;;
;;;; Configurations: "new" (everything on), "old" (the first engine), or one
;;;; feature name (activity, see, lmr, aspiration, delta) for that feature
;;;; alone, or "no-" and a feature name for everything except it. The
;;;; difficulty levels "novice", "club" and "expert" can also be named.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

(defparameter *openings*
  '(("Open game"          "e2e4" "e7e5" "g1f3" "b8c6")
    ("Queen's gambit"     "d2d4" "d7d5" "c2c4" "e7e6")
    ("Sicilian"           "e2e4" "c7c5" "g1f3" "d7d6")
    ("King's Indian"      "d2d4" "g8f6" "c2c4" "g7g6")
    ("French"             "e2e4" "e7e6" "d2d4" "d7d5")
    ("English"            "c2c4" "e7e5" "b1c3" "g8f6")
    ("Reti"               "g1f3" "d7d5" "g2g3" "g8f6")
    ("Caro-Kann"          "e2e4" "c7c6" "d2d4" "d7d5")
    ("London"             "d2d4" "d7d5" "g1f3" "g8f6" "c1f4" "e7e6")
    ("Scandinavian"       "e2e4" "d7d5" "e4d5" "d8d5")
    ("Modern"             "e2e4" "g7g6" "d2d4" "f8g7")
    ("Dutch"              "d2d4" "f7f5" "g2g3" "g8f6")))

(defun configure (name)
  (cond ((string= name "new") (set-engine-features))
        ((string= name "old")
         (set-engine-features :activity nil :see nil :lmr nil :aspiration nil :delta nil))
        ;; "no-lmr": everything except that one feature
        ((and (> (length name) 3) (string= (subseq name 0 3) "no-"))
         (let ((off (subseq name 3)))
           (set-engine-features :activity (string/= off "activity")
                                :see (string/= off "see")
                                :lmr (string/= off "lmr")
                                :aspiration (string/= off "aspiration")
                                :delta (string/= off "delta"))))
        (t (set-engine-features :activity (string= name "activity")
                                :see (string= name "see")
                                :lmr (string= name "lmr")
                                :aspiration (string= name "aspiration")
                                :delta (string= name "delta")))))

(defun opening-position (moves)
  (let ((p (pos-from-fen +start-fen+)))
    (dolist (uci moves p)
      (let ((m (parse-uci-move p uci)))
        (unless (and m (make-move p m)) (error "Bad opening move ~A" uci))))))

(defun outcome (p)
  "NIL while the game goes on; otherwise :white, :black or :draw."
  (cond ((not (has-legal-move-p p))
         (if (in-check-p p) (if (= (pos-side p) 1) :black :white) :draw))
        ((or (>= (pos-halfmove p) 100)
             (>= (repetition-count p) 2)
             (insufficient-material-p p)
             (> (pos-ply p) 240))
         :draw)))

(defun play (opening white black ms)
  "One game. WHITE and BLACK are configuration names. Returns the outcome."
  (let ((p (opening-position opening)))
    (loop
      (let ((result (outcome p)))
        (when result (return result)))
      (let* ((name (if (= (pos-side p) 1) white black))
             (level (find-level name)))
        ;; The table holds scores from the other side's evaluation: start clean.
        (tt-clear)
        (make-move
         p
         (if level
             ;; A difficulty level plays exactly as it does in a real game:
             ;; its own depth, its own features, its own choice of move.
             ;; Only Expert is on the clock.
             (progn
               (apply-level-features level)
               (choose-level-move
                p
                (search-position p :max-depth (level-depth level)
                                   :time-ms (and (string= name "expert") ms))
                level))
             (progn
               (configure name)
               (search-result-best-move (search-position p :max-depth 40 :time-ms ms)))))))))

(let* ((args (let ((tail (member-if (lambda (a) (search "selfplay" a)) sb-ext:*posix-argv*)))
               (if tail (rest tail) (rest sb-ext:*posix-argv*))))
       (ms (if (first args) (parse-integer (first args)) 100))
       (candidate (or (second args) "new"))
       (baseline (or (third args) "old"))
       (wins 0) (draws 0) (losses 0))
  (format t "~&~A against ~A, ~D ms per move, ~D games~%~%"
          candidate baseline ms (* 2 (length *openings*)))
  (dolist (entry *openings*)
    (destructuring-bind (name &rest moves) entry
      (dolist (candidate-white '(t nil))
        (let* ((result (if candidate-white
                           (play moves candidate baseline ms)
                           (play moves baseline candidate ms)))
               (mine (if candidate-white :white :black)))
          (cond ((eq result :draw) (incf draws))
                ((eq result mine) (incf wins))
                (t (incf losses)))
          (format t "  ~16A ~A as ~5A  ~A~%" name candidate
                  (if candidate-white "White" "Black")
                  (cond ((eq result :draw) "draw")
                        ((eq result mine) "win")
                        (t "loss")))
          (finish-output)))))
  (let ((games (+ wins draws losses)))
    (format t "~%~A: ~D wins, ~D draws, ~D losses  (~,1F% of the points)~%"
            candidate wins draws losses
            (* 100.0 (/ (+ wins (/ draws 2)) games)))))
(set-engine-features)
