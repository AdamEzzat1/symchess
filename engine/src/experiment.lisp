;;;; experiment.lisp -- measuring a change, and writing down what was measured.
;;;;
;;;; Used by the scripts in engine/tests/ (experiment.lisp, credibility.lisp,
;;;; selfplay.lisp). Nothing here runs in a game.
;;;;
;;;; Every results file carries the things needed to trace a number back to a
;;;; run: when, on what machine, at which commit, with which command, and the
;;;; exact switches each named configuration stands for.

(in-package :symchess)

;;; ------------------------------------------------------ named configurations

(defparameter *engine-features* '(:activity :see :lmr :aspiration :delta))

(defparameter *experiment-configurations*
  '(("old" "The first engine: every optional feature switched off.")
    ("activity" "The first engine plus the mobility, rook-file and king-shelter evaluation terms.")
    ("see" "The first engine plus static exchange evaluation for ordering and pruning captures.")
    ("lmr" "The first engine plus late move reductions.")
    ("aspiration" "The first engine plus aspiration windows at the root.")
    ("delta" "The first engine plus delta pruning in the quiescence search.")
    ("new" "Everything switched on: the engine as it plays.")
    ("hints" "Everything switched on, and Prolog's ranking of the moves used to order them at the root. The time Prolog takes is counted."))
  "Name and description. What each name switches on is decided by FEATURES-FOR.")

(defun feature-name (feature) (string-downcase (symbol-name feature)))

(defun features-for (name)
  "The feature switches configuration NAME stands for, as a plist for
SET-ENGINE-FEATURES. Names: \"new\" and \"hints\" (everything), \"old\"
(nothing), a feature's name (that feature alone), or \"no-\" and a feature's
name (everything but it)."
  (flet ((all (value) (loop for f in *engine-features* append (list f value))))
    (cond ((member name '("new" "hints") :test #'string=) (all t))
          ((string= name "old") (all nil))
          ((and (> (length name) 3) (string= (subseq name 0 3) "no-"))
           (loop for f in *engine-features*
                 append (list f (not (string= (subseq name 3) (feature-name f))))))
          ((member name (mapcar #'feature-name *engine-features*) :test #'string=)
           (loop for f in *engine-features* append (list f (string= name (feature-name f)))))
          (t (error "Unknown configuration ~S" name)))))

(defun configure (name)
  "Switch the engine to configuration NAME. True if it uses Prolog's root hints."
  (apply #'set-engine-features (features-for name))
  (string= name "hints"))

(defun configuration-object (name)
  (let ((features (features-for name)))
    (obj "name" name
         "description" (or (second (assoc name *experiment-configurations* :test #'string=)) "")
         "features" (cons :obj (loop for (f on) on features by #'cddr
                                     collect (cons (feature-name f) (jbool on))))
         "rootHints" (jbool (string= name "hints")))))

;;; ------------------------------------------------------------------ measures

(defun measure-depth (name positions depth)
  "Search each of POSITIONS (label and FEN) to exactly DEPTH with configuration
NAME and no time limit, so the node counts are the same on every machine and
every run. Returns an object."
  (let ((hints-p (configure name))
        (nodes 0) (ms 0) (prolog-ms 0) (moves '()))
    (unwind-protect
         (dolist (entry positions)
           (let* ((p (pos-from-fen (second entry)))
                  (hints (when hints-p
                           (let* ((start (now-ms))
                                  (analysis (symbolic-analysis p)))
                             (incf prolog-ms (- (now-ms) start))
                             (symbolic-hints p analysis))))
                  (result (progn (tt-clear)
                                 (search-position p :max-depth depth :hints hints))))
             (incf nodes (search-result-nodes result))
             (incf ms (search-result-time-ms result))
             (push (move-uci (search-result-best-move result)) moves)))
      (set-engine-features))
    (obj "configuration" name
         "depth" depth
         "positions" (length positions)
         "nodes" nodes
         "searchMs" ms
         "prologMs" (if hints-p prolog-ms :null)
         "moves" (nreverse moves))))

(defun measure-labelled-moves (name entries depth time-ms)
  "ENTRIES are (id fen best avoid): lists of UCI moves that are right and that
are wrong. Counts the positions where configuration NAME, searching to DEPTH
within TIME-MS, plays a right move and no wrong one."
  (let ((hints-p (configure name))
        (right 0) (missed '()))
    (unwind-protect
         (dolist (entry entries)
           (destructuring-bind (id fen best avoid) entry
             (let* ((p (pos-from-fen fen))
                    (hints (and hints-p (symbolic-hints p (symbolic-analysis p))))
                    (result (progn (tt-clear)
                                   (search-position p :max-depth depth :time-ms time-ms
                                                      :hints hints)))
                    (uci (move-uci (search-result-best-move result))))
               (if (and (or (null best) (member uci best :test #'string=))
                        (not (member uci avoid :test #'string=)))
                   (incf right)
                   (push (obj "position" id "played" uci) missed)))))
      (set-engine-features))
    (obj "configuration" name
         "depth" depth
         "timeLimitMs" time-ms
         "positions" (length entries)
         "right" right
         "missed" (nreverse missed))))

;;; -------------------------------------------------------------------- matches

(defparameter *match-openings*
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

(defun opening-position (moves)
  (let ((p (pos-from-fen +start-fen+)))
    (dolist (uci moves p)
      (let ((m (parse-uci-move p uci)))
        (unless (and m (make-move p m)) (error "Bad opening move ~A" uci))))))

(defun game-outcome (p)
  "NIL while the game goes on; otherwise :white, :black or :draw."
  (cond ((not (has-legal-move-p p))
         (if (in-check-p p) (if (= (pos-side p) 1) :black :white) :draw))
        ((or (>= (pos-halfmove p) 100)
             (>= (repetition-count p) 2)
             (insufficient-material-p p)
             (> (pos-ply p) 240))
         :draw)))

(defun play-game (opening white black ms)
  "One game from OPENING (a list of UCI moves). WHITE and BLACK are
configuration names or the names of difficulty levels. Both get MS per move.
Returns the outcome."
  (let ((p (opening-position opening)))
    (unwind-protect
         (loop
           (let ((result (game-outcome p)))
             (when result (return result)))
           (let* ((name (if (= (pos-side p) 1) white black))
                  (level (find-level name)))
             ;; The table holds scores from the other side's evaluation: start clean.
             (tt-clear)
             (make-move
              p
              (cond
                (level
                 ;; A difficulty level plays exactly as it does in a real game:
                 ;; its own depth, its own features, its own choice of move.
                 ;; Only Expert is on the clock.
                 (apply-level-features level)
                 (choose-level-move
                  p
                  (search-position p :max-depth (level-depth level)
                                     :time-ms (and (string= name "expert") ms))
                  level))
                ((configure name)
                 ;; Is Prolog's advice worth the time it takes to ask for it?
                 (let* ((started (now-ms))
                        (hints (symbolic-hints p (symbolic-analysis p)))
                        (left (max 10 (- ms (- (now-ms) started)))))
                   (search-result-best-move
                    (search-position p :max-depth 40 :time-ms left :hints hints))))
                (t
                 (search-result-best-move
                  (search-position p :max-depth 40 :time-ms ms)))))))
      (set-engine-features))))

(defun play-match (candidate baseline ms &key (openings *match-openings*) on-game)
  "Every opening twice, colours swapped. ON-GAME, if given, is called after each
game with the opening's name, whether the candidate had White, and the result
from the candidate's side (:win, :draw or :loss). Returns an object."
  (let ((wins 0) (draws 0) (losses 0))
    (dolist (entry openings)
      (destructuring-bind (name &rest moves) entry
        (dolist (candidate-white '(t nil))
          (let* ((result (if candidate-white
                             (play-game moves candidate baseline ms)
                             (play-game moves baseline candidate ms)))
                 (mine (if candidate-white :white :black))
                 (scored (cond ((eq result :draw) (incf draws) :draw)
                               ((eq result mine) (incf wins) :win)
                               (t (incf losses) :loss))))
            (when on-game (funcall on-game name candidate-white scored))))))
    (let ((games (+ wins draws losses)))
      (obj "candidate" candidate
           "baseline" baseline
           "msPerMove" ms
           "games" games
           "wins" wins
           "draws" draws
           "losses" losses
           "points" (if (zerop games) :null (* 100.0 (/ (+ wins (/ draws 2)) games)))))))

;;; ------------------------------------------------------------ writing it down

(defun git-output (&rest arguments)
  "The first line git prints for ARGUMENTS, or NIL if git cannot be run here."
  (ignore-errors
   (let ((text (with-output-to-string (out)
                 (sb-ext:run-program "git" arguments :search t :output out :error nil
                                     :directory (asdf:system-relative-pathname "symchess" "../")))))
     (string-trim '(#\Space #\Newline #\Return) text))))

(defun utc-date ()
  (multiple-value-bind (second minute hour day month year) (decode-universal-time (get-universal-time) 0)
    (declare (ignore second))
    (format nil "~4,'0D-~2,'0D-~2,'0D ~2,'0D:~2,'0D UTC" year month day hour minute)))

(defun source-digest ()
  "A fingerprint of the engine and the rules as they are on disk: the MD5 of
every engine/src/*.lisp and knowledge/*.pl file, in name order, with line
endings ignored. Two runs with the same digest ran the same program, whatever
git says."
  (let ((files (sort (mapcar #'namestring
                             (append (directory (merge-pathnames "*.lisp" (asdf:system-relative-pathname "symchess" "src/")))
                                     (directory (merge-pathnames "*.pl" (asdf:system-relative-pathname "symchess" "../knowledge/")))))
                     #'string<))
        (text (make-string-output-stream)))
    (dolist (file files)
      (with-open-file (in file :external-format :utf-8)
        (loop for line = (read-line in nil nil)
              while line
              do (write-line (remove #\Return line) text))))
    (format nil "~(~{~2,'0X~}~)"
            (coerce (sb-md5:md5sum-string (get-output-stream-string text) :external-format :utf-8)
                    'list))))

(defun run-metadata (command)
  "What a reader needs to trace a figure back to the run that produced it."
  (let ((commit (git-output "rev-parse" "--short" "HEAD"))
        (changes (git-output "status" "--porcelain" "--" "engine/src" "knowledge")))
    (obj "date" (utc-date)
         "command" command
         "engine" *engine-version*
         "lisp" (format nil "~A ~A" (lisp-implementation-type) (lisp-implementation-version))
         "prolog" (jnull (prolog-version))
         "machine" (format nil "~A, ~A"
                           (or (sb-ext:posix-getenv "PROCESSOR_IDENTIFIER") (machine-version) (machine-type))
                           (software-type))
         "sourceDigest" (source-digest)
         "commit" (if (and commit (plusp (length commit))) commit :null)
         ;; True when the engine or the rules differ from that commit.
         "uncommittedChanges" (cond ((null changes) :null)
                                    (t (jbool (plusp (length (remove #\Newline changes)))))))))

(defun scalar-list-p (x)
  (and (listp x) (not (objp x)) (every (lambda (v) (or (atom v) (and (objp v) (null (cdr v))))) x)))

(defun write-json-pretty (x out &optional (indent 0))
  "Like WRITE-JSON, but one field or element per line, so a results file can be
read and compared by eye. Lists of plain values stay on one line."
  (flet ((pad (n) (format out "~%~v@{ ~}" (* 2 n) nil)))
    (cond ((and (objp x) (cdr x))
           (write-char #\{ out)
           (loop for (k . v) in (cdr x)
                 for first = t then nil
                 do (unless first (write-char #\, out))
                    (pad (1+ indent))
                    (write-json-string k out)
                    (write-string ": " out)
                    (write-json-pretty v out (1+ indent)))
           (pad indent)
           (write-char #\} out))
          ((and (consp x) (not (objp x)) (not (scalar-list-p x)))
           (write-char #\[ out)
           (loop for v in x
                 for first = t then nil
                 do (unless first (write-char #\, out))
                    (pad (1+ indent))
                    (write-json-pretty v out (1+ indent)))
           (pad indent)
           (write-char #\] out))
          (t (write-json x out)))))

(defun results-path (name)
  (asdf:system-relative-pathname "symchess" (format nil "../results/~A.json" name)))

(defun write-results (name object)
  "Write OBJECT to results/NAME.json and return the path."
  (let ((path (results-path name)))
    (ensure-directories-exist path)
    (with-open-file (out path :direction :output :if-exists :supersede :external-format :utf-8)
      (write-json-pretty object out)
      (terpri out))
    path))
