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
;;;; difficulty levels "novice", "club" and "expert" can also be named, and
;;;; "hints": the full engine with Prolog's root ordering hints, where the
;;;; time Prolog takes comes out of the same per-move allowance.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

;; The openings, the configurations and the game loop are shared with the
;; experiment runner: see engine/src/experiment.lisp.

(let* ((args (let ((tail (member-if (lambda (a) (search "selfplay" a)) sb-ext:*posix-argv*)))
               (if tail (rest tail) (rest sb-ext:*posix-argv*))))
       (ms (if (first args) (parse-integer (first args)) 100))
       (candidate (or (second args) "new"))
       (baseline (or (third args) "old")))
  (format t "~&~A against ~A, ~D ms per move, ~D games~%~%"
          candidate baseline ms (* 2 (length *match-openings*)))
  (let ((result (play-match candidate baseline ms
                            :on-game (lambda (opening white scored)
                                       (format t "  ~16A ~A as ~5A  ~(~A~)~%" opening candidate
                                               (if white "White" "Black") scored)
                                       (finish-output)))))
    (format t "~%~A: ~D wins, ~D draws, ~D losses  (~,1F% of the points)~%"
            candidate (jget result "wins") (jget result "draws") (jget result "losses")
            (jget result "points"))))
(set-engine-features)
(stop-prolog)
