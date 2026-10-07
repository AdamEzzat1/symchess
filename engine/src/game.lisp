;;;; game.lisp -- authoritative game state, protocol commands and events.
;;;;
;;;; Sessions
;;;;   Every WebSocket connection owns one GAME. *GAME* is bound per thread to
;;;;   the session that thread is serving; nothing is shared between sessions
;;;;   except the search (one at a time, see *SEARCH-LOCK*), the Prolog child
;;;;   and its cache.
;;;;
;;;; Threading model, per session
;;;;   (game-lock g)       guards the game. Every command handler runs under it.
;;;;   (game-send-lock g)  guards the outbound sequence number, so `seq` order
;;;;                       is wire order.
;;;;   Lock order is always game -> send.
;;;; Workers (search / symbolic analysis) run on a COPY of the position and
;;;; carry the positionId they were started for. Results are applied only if
;;;; that id is still current, so a late worker can never corrupt the game.

(in-package :symchess)

(define-condition protocol-error (error)
  ((code :initarg :code :reader protocol-error-code)
   (message :initarg :message :reader protocol-error-message))
  (:report (lambda (c stream) (write-string (protocol-error-message c) stream))))

(defun protocol-error (code control &rest args)
  (error 'protocol-error :code code :message (apply #'format nil control args)))

(defvar *log-stream* nil)
(defvar *log-lock* (sb-thread:make-mutex :name "log"))
(defvar *prolog-version-string* nil)

;; The transposition table is shared and unlocked, so exactly one search may
;; run at a time across ALL sessions. Searches from other sessions queue here.
(defvar *search-lock* (sb-thread:make-mutex :name "search"))

;; Per-session ceilings, so one visitor cannot monopolise a shared server.
;; Should Prolog's per-move scores order the root moves of a real search?
;; Measured (docs/NEXT_STAGE.md, milestone 3): no change in nodes searched, and
;; weaker play once Prolog's time is counted. So they are off. The scores are
;; still computed, shown, and compared with the search's choice afterwards.
(defvar *use-root-hints* nil)

(defvar *max-depth* 30)
(defvar *max-move-time-ms* 120000)

(defvar *game* nil
  "The session this thread is serving. Bound per thread, never set globally.")

(defmacro with-state (&body body)
  `(sb-thread:with-recursive-lock ((game-lock *game*)) ,@body))

;;; ------------------------------------------------------------- difficulty
;;; A level is a real configuration of the engine, not a strong engine told to
;;; blunder. Novice is weak the way a weak player is weak: it looks a short
;;; way ahead, judges positions crudely, and does not always pick the best of
;;; the moves it thinks are reasonable. It still never gives a piece away to a
;;; one-move reply and never passes up a mate it has seen, because every move
;;; it may pick has been searched and found close to the best.

(defstruct level
  name
  depth          ; search depth, before the server's ceiling
  time-ms        ; thinking time per move, before the server's ceiling
  full           ; T: the whole evaluation and search. NIL: the first engine.
  margin)        ; centipawns below the best move that it may still choose

(defparameter *levels*
  (list (make-level :name "novice" :depth 3 :time-ms 1000 :full nil :margin 60)
        (make-level :name "club" :depth 6 :time-ms 2000 :full t :margin 0)
        ;; Expert searches as deep as its time allows.
        (make-level :name "expert" :depth 30 :time-ms 3000 :full t :margin 0)))

(defun find-level (name)
  (find name *levels* :key #'level-name :test #'equal))

(defun apply-level-features (level)
  (if (level-full level)
      (set-engine-features)
      (set-engine-features :activity nil :see nil :lmr nil :aspiration nil :delta nil)))

;; Seeded from the clock, so two games at Novice do not go the same way.
(defvar *level-random* (make-random-state t))

(defun choose-level-move (p result level &optional (state *level-random*))
  "The move a LEVEL engine plays given its search RESULT. Second value: true if
it is the search's best move. Must run with LEVEL's features switched on."
  (let ((best (search-result-best-move result))
        (margin (level-margin level)))
    (if (or (zerop margin)
            ;; A forced mate, for or against, is never traded for variety.
            (> (abs (search-result-score result)) +mate-bound+))
        (values best t)
        (let* ((scored (root-move-scores p (max 1 (search-result-depth result))))
               (top (cdr (first scored))))
          (if (> (abs top) +mate-bound+)
              (values (car (first scored)) t)
              (let* ((candidates (remove-if (lambda (entry) (< (cdr entry) (- top margin)))
                                            scored))
                     (pick (car (nth (random (length candidates) state) candidates))))
                (values pick (= pick best))))))))

(defun level-note (p level result chosen best-p)
  "One plain sentence saying what this level did, for the explanation."
  (let ((name (level-name level)))
    (cond ((string= name "novice")
           (if best-p
               (format nil "Novice level: a ~D-ply search with a simple evaluation (material and piece placement only)."
                       (search-result-depth result))
               (format nil "Novice level: played ~A rather than its top choice ~A. At this level it picks among the moves it scores within ~,1F pawns of its best, never one that loses material to the next move."
                       (move-san p chosen) (move-san p (search-result-best-move result))
                       (/ (level-margin level) 100.0))))
          ((string= name "club")
           (format nil "Club level: a ~D-ply search with the full evaluation."
                   (search-result-depth result)))
          (t
           (format nil "Expert level: searched as deep as the time allowed, reaching ~D plies."
                   (search-result-depth result))))))

(defstruct client
  stream socket
  (write-lock (sb-thread:make-mutex :name "client-write")))

(defstruct game
  (pos (pos-from-fen +start-fen+))
  (start-fen +start-fen+)
  (records '())                         ; newest first: (:move :san :uci :by :captured)
  (position-id 1)
  (mode "play")                         ; "play" | "analysis"
  (human-color "white")
  (level "club")                        ; "novice" | "club" | "expert"
  (depth 6)
  (move-time-ms 2000)
  (status "active")
  (winner nil)
  (tc-base-ms nil)                      ; NIL = untimed
  (tc-inc-ms 0)
  (clock-white 0)
  (clock-black 0)
  (clock-started nil)                   ; NOW-MS when the running clock started
  (search-id 0)
  (line nil)                            ; the newest explained line: (:sid :pid :pos :pv)
  (stop-flag nil)                       ; (list nil); car set to T to cancel a worker
  (worker nil)
  (thinking nil)
  (worker-kind nil)                     ; :play | :analysis | :symbolic
  ;; session plumbing
  (client nil)
  (lock (sb-thread:make-mutex :name "game"))
  (send-lock (sb-thread:make-mutex :name "send"))
  (seq 0)
  (last-activity (now-ms)))

;;; ---------------------------------------------------------------- sending

(defun log-event (direction text)
  (when *log-stream*
    (sb-thread:with-mutex (*log-lock*)
      (format *log-stream* "{\"dir\":\"~A\",\"t\":~D,\"msg\":~A}~%" direction (now-ms) text)
      (finish-output *log-stream*))))

(defun send-text (client text)
  "Write one text frame. A dead peer is not an error here: its reader thread
notices the closed socket and ends the session."
  (ignore-errors
   (sb-thread:with-mutex ((client-write-lock client))
     (ws-write-text (client-stream client) text))))

(defun broadcast (type &rest fields)
  "Send one event to this session's client. Assigns the next sequence number."
  (let ((g *game*))
    (sb-thread:with-mutex ((game-send-lock g))
      (let ((text (json-encode (apply #'obj "type" type "seq" (incf (game-seq g)) fields))))
        (log-event "out" text)
        (when (game-client g)
          (send-text (game-client g) text))))))

(defun send-direct (client type &rest fields)
  (declare (ignore client))
  (apply #'broadcast type fields))

;;; ----------------------------------------------------------------- clocks

(defun clock-remaining (g side)
  "Milliseconds left for SIDE right now."
  (let ((base (if (= side 1) (game-clock-white g) (game-clock-black g))))
    (if (and (game-clock-started g)
             (string= (game-status g) "active")
             (= side (pos-side (game-pos g))))
        (max 0 (- base (- (now-ms) (game-clock-started g))))
        base)))

(defun reset-clocks (g)
  (setf (game-clock-white g) (or (game-tc-base-ms g) 0)
        (game-clock-black g) (or (game-tc-base-ms g) 0)
        (game-clock-started g) nil))

(defun clock-on-move (g mover)
  "Charge MOVER for the time used. Returns NIL if the flag fell."
  (cond ((null (game-tc-base-ms g)) t)
        ((null (game-clock-started g))  ; clocks start once the first move is played
         (setf (game-clock-started g) (now-ms))
         t)
        (t
         (let ((left (clock-remaining g mover)))
           (cond ((<= left 0) nil)
                 (t (if (= mover 1)
                        (setf (game-clock-white g) (+ left (game-tc-inc-ms g)))
                        (setf (game-clock-black g) (+ left (game-tc-inc-ms g))))
                    (setf (game-clock-started g) (now-ms))
                    t))))))

(defun flag-fall (g side)
  (setf (game-clock-white g) (clock-remaining g 1)
        (game-clock-black g) (clock-remaining g -1))
  (if (= side 1) (setf (game-clock-white g) 0) (setf (game-clock-black g) 0))
  (setf (game-status g) "timeout"
        (game-winner g) (side-name (- side))
        (game-clock-started g) nil))

(defun search-time-budget (g)
  "Per-move thinking time: the configured limit, tightened by the clock."
  (let ((limit (game-move-time-ms g)))
    (if (and (game-tc-base-ms g) (string= (game-mode g) "play"))
        (let ((left (clock-remaining g (pos-side (game-pos g)))))
          (max 50 (min limit (+ (floor left 30) (floor (game-tc-inc-ms g) 2)))))
        limit)))

;;; -------------------------------------------------------------- snapshots

(defun board-object (p)
  (let ((cells '()) (b (pos-board p)))
    (dotimes (sq 128)
      (when (and (on-board-p sq) (/= (aref b sq) 0))
        (let ((piece (aref b sq)))
          (push (cons (square-name sq)
                      (format nil "~A~C" (if (plusp piece) "w" "b") (char " PNBRQK" (abs piece))))
                cells))))
    (cons :obj (nreverse cells))))

(defun move-object (p m legal)
  (obj "uci" (move-uci m)
       "san" (move-san p m legal)
       "from" (square-name (move-from m))
       "to" (square-name (move-to m))
       "promotion" (if (zerop (move-promo m))
                       :null
                       (string (char-downcase (char " PNBRQK" (move-promo m)))))
       "capture" (jbool (move-capture-p m))))

(defun update-status (g)
  (let ((p (game-pos g)))
    (multiple-value-bind (status winner)
        (cond ((not (has-legal-move-p p))
               (if (in-check-p p)
                   (values "checkmate" (side-name (- (pos-side p))))
                   (values "stalemate" nil)))
              ((insufficient-material-p p) (values "draw_material" nil))
              ((>= (repetition-count p) 2) (values "draw_repetition" nil))
              ((or (>= (pos-halfmove p) 100) (>= (pos-ply p) (- +max-ply+ 200)))
               (values "draw_50" nil))
              (t (values "active" nil)))
      (setf (game-status g) status
            (game-winner g) winner)
      (unless (string= status "active")
        (setf (game-clock-white g) (clock-remaining g 1)
              (game-clock-black g) (clock-remaining g -1)
              (game-clock-started g) nil)))))

(defun game-state-fields (g)
  (let* ((p (game-pos g))
         (active (string= (game-status g) "active"))
         (legal (if active (legal-moves p) '()))
         (records (reverse (game-records g)))
         (last (first (game-records g))))
    (list "positionId" (game-position-id g)
          "fen" (pos-to-fen p)
          "board" (board-object p)
          "turn" (side-name (pos-side p))
          "moveNumber" (pos-fullmove p)
          "check" (if (in-check-p p) (square-name (king-square p (pos-side p))) :null)
          "lastMove" (if last
                         (obj "from" (square-name (move-from (getf last :move)))
                              "to" (square-name (move-to (getf last :move))))
                         :null)
          "history" (loop for record in records
                          for ply from 1
                          collect (obj "ply" ply
                                       "san" (getf record :san)
                                       "uci" (getf record :uci)
                                       "by" (getf record :by)))
          "legalMoves" (mapcar (lambda (m) (move-object p m legal)) legal)
          "status" (game-status g)
          "winner" (jnull (game-winner g))
          "clocks" (obj "enabled" (jbool (game-tc-base-ms g))
                        "whiteMs" (clock-remaining g 1)
                        "blackMs" (clock-remaining g -1)
                        "incrementMs" (game-tc-inc-ms g)
                        "running" (if (and active (game-tc-base-ms g) (game-clock-started g))
                                      (side-name (pos-side p))
                                      :null))
          "settings" (obj "mode" (game-mode g)
                          "humanColor" (game-human-color g)
                          "level" (game-level g)
                          "depth" (game-depth g)
                          "moveTimeMs" (game-move-time-ms g))
          ;; Pieces each side has captured, as piece letters of the lost pieces.
          "captured" (flet ((taken-by (side)
                              (loop for record in records
                                    for piece = (getf record :captured)
                                    when (and (/= piece 0) (= (signum piece) (- side)))
                                      collect (string (char-downcase
                                                       (char " PNBRQK" (abs piece)))))))
                       (obj "white" (taken-by 1) "black" (taken-by -1)))
          "engineThinking" (jbool (game-thinking g)))))

(defun broadcast-game-state (g)
  (apply #'broadcast "game_state" (game-state-fields g)))

;;; ------------------------------------------------------------ search info

(defun score-object (score side)
  "Search score (side-to-move view) as a White-relative JSON object."
  (if (> (abs score) +mate-bound+)
      (let ((moves (ceiling (- +mate+ (abs score)) 2)))
        (obj "cp" :null "mate" (* side (if (plusp score) moves (- moves)))))
      (obj "cp" (* side score) "mate" :null)))

(defun score-text (score side)
  (if (> (abs score) +mate-bound+)
      (format nil "mate in ~D for ~A"
              (ceiling (- +mate+ (abs score)) 2)
              (side-name (if (plusp score) side (- side))))
      (let ((cp (* side score)))
        (format nil "~:[-~;+~]~,2F" (>= cp 0) (/ (abs cp) 100.0)))))

(defun search-info-fields (p result)
  (let* ((pv (search-result-pv result))
         (best (search-result-best-move result))
         (legal (legal-moves p))
         (time-ms (search-result-time-ms result))
         (nodes (search-result-nodes result)))
    (list "depth" (search-result-depth result)
          "score" (score-object (search-result-score result) (pos-side p))
          "nodes" nodes
          "timeMs" time-ms
          "nps" (if (plusp time-ms) (floor (* 1000 nodes) time-ms) 0)
          "bestMove" (if best (move-object p best legal) :null)
          "pv" (pv-san p pv)
          "pvUci" (mapcar #'move-uci pv))))

;;; ------------------------------------------------------------ explanation
;;; Every sentence is tagged with where it came from and how far the search
;;; backs it up:
;;;   measured    - a number the search or evaluator actually produced
;;;   confirmed   - a Prolog motif that the principal variation cashes in
;;;   unconfirmed - a Prolog motif the principal variation does not act on
;;;   overruled   - a Prolog warning the search decided to ignore
;;;   heuristic   - positional advice the search cannot verify at this depth

(defun explanation-item (source status text &optional (targets '()) (motif :null))
  (obj "source" source "status" status "text" text "squares" targets
       ;; Which Prolog motif this sentence is about, so the UI can tie a
       ;; verdict to the right fact instead of guessing from squares.
       "motif" motif))

(defun pv-captures-on-p (p pv targets)
  "Does the side to move capture on one of TARGETS later in PV (not move 1)?"
  (let ((p (copy-position p)) (hit nil))
    (loop for m in pv
          for i from 0
          do (when (and (evenp i) (plusp i) (move-capture-p m)
                        (member (square-name (move-to m)) targets :test #'string=))
               (setf hit t))
             (unless (make-move p m) (return)))
    hit))

(defun pv-material-swing (p pv)
  "Material change over PV in centipawns, from the mover's point of view."
  (let* ((p (copy-position p))
         (side (pos-side p))
         (before (material-balance p)))
    (dolist (m pv)
      (unless (make-move p m) (return)))
    (* side (- (material-balance p) before))))

(defparameter *line-end-kinds*
  '("check" "fork" "pin" "skewer" "hanging" "trapped" "pinned_defender"
    "discovered_attack" "weak_back_rank" "unstoppable_pawn")
  "The facts worth reporting about where the engine expects the game to go.")

(defun expected-facts (p pv)
  "What Prolog sees in the position at the end of line PV: a list of fact
objects, at most three, tactical kinds only. NIL if the line is a single move,
if it ends the game, or if Prolog is unavailable. Costs one Prolog query."
  (when (rest pv)
    (let ((end (copy-position p)))
      (dolist (m pv)
        (unless (make-move end m) (return-from expected-facts nil)))
      (when (has-legal-move-p end)
        (let ((analysis (symbolic-analysis end)))
          (when analysis
            (let ((picked '()))
              (dolist (fact (jget analysis "facts" '()))
                (when (and (< (length picked) 3)
                           (member (jget fact "kind") *line-end-kinds* :test #'equal))
                  (push fact picked)))
              (nreverse picked))))))))

(defparameter *line-steps* 8
  "The most moves of a line that LINE-REPLAY-STEPS will walk.")

(defun line-replay-steps (p pv)
  "The positions along line PV starting from P, as step objects: the first is P
itself, each later one the position after one more move. Every step carries the
board and Prolog's facts for it, so the interface can show the line without
making a move or judging a position itself. One Prolog query per step."
  (let ((p (copy-position p))
        (steps '()))
    (flet ((snapshot (move by)
             (let* ((over (not (has-legal-move-p p)))
                    (analysis (and (not over) (symbolic-analysis p))))
               (push (obj "move" move
                          "by" by
                          "fen" (pos-to-fen p)
                          "board" (board-object p)
                          "turn" (side-name (pos-side p))
                          "check" (if (in-check-p p)
                                      (square-name (king-square p (pos-side p)))
                                      :null)
                          "checkmate" (jbool (and over (in-check-p p)))
                          "symbolic" (jbool analysis)
                          "facts" (if analysis (jget analysis "facts" '()) '()))
                     steps))))
      (snapshot :null :null)
      (loop for m in pv
            repeat *line-steps*
            do (let ((legal (legal-moves p)))
                 (unless (member m legal) (return))
                 (let ((move (move-object p m legal))
                       (by (side-name (pos-side p))))
                   (make-move p m)
                   (snapshot move by)))))
    (nreverse steps)))

(defun build-explanation (p result analysis &optional (purpose :play) note expected)
  (let* ((best (search-result-best-move result))
         (legal (legal-moves p))
         (san (move-san p best legal))
         (side (pos-side p))
         (mover (string-capitalize (side-name side)))
         (pv (search-result-pv result))
         (swing (pv-material-swing p pv))
         (items '()))
    (flet ((add (&rest args) (push (apply #'explanation-item args) items)))
      (when note (add "search" "measured" note))
      (add "search" "measured"
           (format nil "Searched ~D plies deep (~:D positions, ~,1F s). ~A scores ~A (White's view)."
                   (search-result-depth result) (search-result-nodes result)
                   (/ (search-result-time-ms result) 1000.0)
                   san (score-text (search-result-score result) side)))
      (when (rest pv)
        (add "search" "measured"
             (format nil "Expected continuation: ~{~A~^ ~}." (pv-san p pv))))
      (cond ((>= swing 100)
             (add "search" "measured"
                  (format nil "Along that line ~A comes out about ~,1F pawns of material ahead."
                          mover (/ swing 100.0))))
            ((<= swing -100)
             (add "search" "measured"
                  (format nil "Along that line ~A gives up about ~,1F pawns of material; the evaluation at the end of the line still favours the move."
                          mover (/ (- swing) 100.0)))))
      (let ((terms (eval-breakdown p)))
        (add "eval" "measured"
             (format nil "Static evaluation before the move, White's view: material ~@D, piece placement ~@D, pawn structure ~@D, bishop pair ~@D, piece activity ~@D, king safety ~@D (centipawns)."
                     (jget terms "material") (jget terms "placement")
                     (jget terms "pawnStructure") (jget terms "bishopPair")
                     (jget terms "activity") (jget terms "kingSafety"))))
      ;; Where the line leads: Prolog's reading of the position the search
      ;; expects to reach. Advice about a position that may never arise.
      (dolist (fact expected)
        (add "prolog" "heuristic"
             (format nil "At the end of the expected line: ~A" (jget fact "text"))
             (jget fact "squares" '())))
      (if (null analysis)
          (add "prolog" "heuristic"
               "The Prolog knowledge layer was unavailable, so this explanation is search-only.")
          (let* ((entries (jget analysis "moves"))
                 (uci (move-uci best))
                 (entry (find uci entries :key (lambda (e) (jget e "uci")) :test #'string=))
                 (rank (position uci entries :key (lambda (e) (jget e "uci")) :test #'string=))
                 (top (first entries)))
            (dolist (motif (and entry (jget entry "motifs")))
              (let* ((kind (jget motif "kind"))
                     (targets (jget motif "targets" '()))
                     (score (jget motif "score" 0))
                     (text (jget motif "text")))
                (cond ((minusp score)
                       (add "prolog" "overruled"
                            (format nil "Prolog warned: ~A The search played it anyway." text)
                            targets kind))
                      ((string= kind "gives_check")
                       (add "prolog" "confirmed" text targets kind))
                      ((member kind '("captures_hanging" "wins_exchange") :test #'string=)
                       (if (>= swing 100)
                           (add "prolog" "confirmed"
                                (format nil "~A The search line keeps the material." text) targets kind)
                           (add "prolog" "unconfirmed"
                                (format nil "~A But the search line does not end material ahead." text)
                                targets kind)))
                      ((member kind '("creates_fork" "creates_pin" "creates_skewer")
                               :test #'string=)
                       (if (pv-captures-on-p p pv targets)
                           (add "prolog" "confirmed"
                                (format nil "~A The expected line cashes this in." text) targets kind)
                           (add "prolog" "unconfirmed"
                                (format nil "~A The expected line does not capture any of those targets, so treat this as a threat, not a win." text)
                                targets kind)))
                      (t (add "prolog" "heuristic" text targets kind)))))
            (cond ((and entry (/= 0 (jget entry "score" 0)))
                   (add "prolog" "heuristic"
                        (format nil "Prolog's own ranking of the moves, made without searching, put ~A number ~D of ~D (score ~@D). The search did not use that ranking."
                                san (1+ rank) (length entries) (jget entry "score" 0))))
                  (t
                   (add "prolog" "heuristic"
                        (format nil "Prolog found no tactical or positional motif for ~A, so this choice rests on the search alone."
                                san))))
            (when (and top (plusp (jget top "score" 0))
                       (string/= (jget top "uci") uci))
              (add "prolog" "overruled"
                   (format nil "Prolog's top suggestion was ~A~@[ (~A)~]; the search preferred ~A."
                           (jget top "san" (jget top "uci"))
                           (let ((motif (first (jget top "motifs"))))
                             (and motif (jget motif "kind")))
                           san))))))
    (list "move" (move-object p best legal)
          ;; An analysis search recommends a move; only a play search plays it.
          "summary" (format nil (if (eq purpose :play)
                                    "~A plays ~A (~A)."
                                    "Best for ~A: ~A (~A).")
                            mover san (score-text (search-result-score result) side))
          "items" (nreverse items))))

;;; ---------------------------------------------------------------- workers

(defun finish-worker (g)
  "stop_search: make a running search stop NOW and use the best result it has.
Unlike CANCEL-WORKER the result is kept: an analysis search reports what it
found, and a search for the engine's own move plays its best move so far, so
the game never stalls waiting for a move that was stopped. Safe to call at
any time; with no search running it does nothing."
  (let ((flag (game-stop-flag g)))
    (when (and flag
               (null (car flag))
               (member (game-worker-kind g) '(:play :analysis)))
      (setf (car flag) :finish))))

;; The stop flag's car is NIL (keep going), T (cancelled: discard everything)
;; or :FINISH (stop searching, keep the result).
(defun cancelled-p (flag) (eq (car flag) t))

(defun cancel-worker (g)
  (when (game-stop-flag g)
    (setf (car (game-stop-flag g)) t))
  (setf (game-thinking g) nil))

(defun symbolic-fields (pid analysis)
  (if analysis
      (list "positionId" pid
            "status" "ok"
            "facts" (jget analysis "facts" '())
            "plans" (jget analysis "plans" '())
            "moveHints" (jget analysis "moves" '())
            "elapsedMs" (jget analysis "elapsedMs" 0))
      (list "positionId" pid "status" "unavailable"
            "facts" '() "plans" '() "moveHints" '() "elapsedMs" 0)))

(defun apply-move (g m by)
  "Play legal move M on the authoritative position and announce it.
Returns NIL (and ends the game) if the mover's flag had fallen."
  (let* ((p (game-pos g))
         (legal (legal-moves p))
         (mover (pos-side p))
         (san (move-san p m legal))
         (captured (if (move-ep-p m) (* (- mover) +pawn+) (aref (pos-board p) (move-to m)))))
    (unless (clock-on-move g mover)
      (flag-fall g mover)
      (incf (game-position-id g))
      (broadcast-game-state g)
      (return-from apply-move nil))
    (make-move p m)
    (push (list :move m :san san :uci (move-uci m) :by by :captured captured)
          (game-records g))
    (incf (game-position-id g))
    (update-status g)
    (broadcast "move_played"
               "positionId" (game-position-id g)
               "move" (obj "san" san "uci" (move-uci m)
                           "from" (square-name (move-from m))
                           "to" (square-name (move-to m))
                           "by" by
                           "ply" (length (game-records g))))
    (broadcast-game-state g)
    t))

(defun run-search (g p pid sid flag purpose depth time-ms)
  (let ((analysis (symbolic-analysis p)))
    (when (cancelled-p flag) (return-from run-search nil))
    (apply #'broadcast "symbolic_analysis" (symbolic-fields pid analysis))
    (broadcast "search_started"
               "positionId" pid "searchId" sid
               "purpose" (if (eq purpose :play) "play" "analysis")
               "maxDepth" depth "timeLimitMs" time-ms
               "symbolicHints" (jbool (and *use-root-hints* analysis)))
    (let* ((level (or (find-level (game-level g)) (find-level "club")))
           (played nil)                 ; the result that describes the move played
           (note nil)
           (terms nil)
           (result
             ;; Searches from all sessions take turns; the time limit starts
             ;; when this one actually begins. The feature switches are global,
             ;; so everything that depends on them happens inside the lock.
             (sb-thread:with-mutex (*search-lock*)
               (when (cancelled-p flag) (return-from run-search nil))
               ;; The level decides how the engine plays. Analysis is always
               ;; the engine's full strength.
               (if (eq purpose :play) (apply-level-features level) (set-engine-features))
               (unwind-protect
                    (let ((r (search-position p :max-depth depth :time-ms time-ms
                                                :stop-fn (lambda () (car flag))
                                                :hints (and *use-root-hints*
                                                            (symbolic-hints p analysis))
                                                :on-iteration
                                                (lambda (r)
                                                  (unless (cancelled-p flag)
                                                    (apply #'broadcast "search_update"
                                                           "positionId" pid "searchId" sid
                                                           (search-info-fields p r)))))))
                      (setf played r
                            terms (eval-breakdown p))
                      (when (and (eq purpose :play) (search-result-best-move r)
                                 (not (cancelled-p flag)))
                        (multiple-value-bind (move best-p) (choose-level-move p r level)
                          (setf note (level-note p level r move best-p))
                          ;; If it plays something other than its best, the
                          ;; explanation must be about the move it plays.
                          (unless best-p
                            (setf played (search-line p move (search-result-depth r))))))
                      r)
                 (set-engine-features))))
           ;; One more Prolog query, outside the search: what does the line
           ;; lead to? Novice keeps its explanations short.
           (expected (and played
                          (not (cancelled-p flag))
                          (or (not (eq purpose :play)) (level-full level))
                          (expected-facts p (search-result-pv played)))))
      (with-state
        ;; Stale-result guard: the game may have moved on while we searched.
        (when (or (cancelled-p flag) (/= pid (game-position-id g))
                  (null (search-result-best-move result)))
          (return-from run-search nil))
        (apply #'broadcast "search_complete"
               "positionId" pid "searchId" sid
               "purpose" (if (eq purpose :play) "play" "analysis")
               "stopped" (jbool (eq (car flag) :finish))
               "evalBreakdown" terms
               (search-info-fields p result))
        (apply #'broadcast "explanation" "positionId" pid "searchId" sid
               (build-explanation p played analysis purpose note expected))
        ;; Kept so the line can be replayed on request.
        (setf (game-line g) (list :sid sid :pid pid :pos (copy-position p)
                                  :pv (search-result-pv played)))
        (when (eq purpose :play)
          (setf (game-thinking g) nil)
          (when (apply-move g (search-result-best-move played) "engine")
            (after-state-change g)))))))

(defun run-symbolic (g p pid flag)
  (let ((analysis (symbolic-analysis p)))
    (with-state
      (unless (or (cancelled-p flag) (/= pid (game-position-id g)))
        (apply #'broadcast "symbolic_analysis" (symbolic-fields pid analysis))))))

(defun start-worker (g kind)
  "KIND is :play, :analysis (both search) or :symbolic (Prolog only)."
  (cancel-worker g)
  (let* ((p (copy-position (game-pos g)))
         (pid (game-position-id g))
         (sid (incf (game-search-id g)))
         (flag (list nil))
         (previous (game-worker g))
         (depth (game-depth g))
         (time-ms (search-time-budget g)))
    (setf (game-stop-flag g) flag
          (game-worker-kind g) kind
          (game-thinking g) (eq kind :play))
    (setf (game-worker g)
          (sb-thread:make-thread
           (lambda ()
             (let ((*game* g))          ; new threads do not inherit bindings
               ;; One worker per session at a time.
               (when previous
                 (ignore-errors (sb-thread:join-thread previous :default nil)))
               (handler-case
                   (if (eq kind :symbolic)
                       (run-symbolic g p pid flag)
                       (run-search g p pid sid flag kind depth time-ms))
                 (error (e)
                   (format *error-output* "~&[worker] ~A~%" e)
                   (with-state
                     (when (= pid (game-position-id g)) (setf (game-thinking g) nil)))
                   (broadcast "error" "code" "worker_failed"
                                      "message" (princ-to-string e)
                                      "inReplyTo" :null)))))
           :name "symchess-worker"))))

(defun engine-to-move-p (g)
  (and (string= (game-status g) "active")
       (string= (game-mode g) "play")
       (string/= (side-name (pos-side (game-pos g))) (game-human-color g))))

(defun after-state-change (g)
  "Decide what the engine does next for the current position."
  (cond ((engine-to-move-p g) (start-worker g :play))
        ((string= (game-status g) "active") (start-worker g :symbolic))
        (t (cancel-worker g))))

;;; --------------------------------------------------------------- commands

(defun require-string (msg key)
  (let ((v (jget msg key)))
    (unless (stringp v) (protocol-error "bad_request" "Field ~S must be a string." key))
    v))

(defun check-position-id (g msg)
  (let ((pid (jget msg "positionId")))
    (when (and (integerp pid) (/= pid (game-position-id g)))
      (broadcast-game-state g)
      (protocol-error "stale_position"
                      "Command was for position ~D but the game is at ~D." pid
                      (game-position-id g)))))

(defun cmd-new-game (g msg)
  (cancel-worker g)
  (let ((fen (jget msg "fen"))
        (color (jget msg "humanColor"))
        (mode (jget msg "mode")))
    (let ((p (if (stringp fen)
                 (handler-case (pos-from-fen fen)
                   (error (e) (protocol-error "bad_fen" "~A" e)))
                 (pos-from-fen +start-fen+))))
      (when (member color '("white" "black") :test #'equal)
        (setf (game-human-color g) color))
      (when (member mode '("play" "analysis") :test #'equal)
        (setf (game-mode g) mode))
      (setf (game-pos g) p
            (game-start-fen g) (pos-to-fen p)
            (game-records g) '()
            (game-line g) nil
            (game-status g) "active"
            (game-winner g) nil)
      (incf (game-position-id g))
      (reset-clocks g)
      (update-status g)
      (broadcast-game-state g)
      (after-state-change g))))

(defun cmd-make-move (g msg)
  (check-position-id g msg)
  (unless (string= (game-status g) "active")
    (protocol-error "game_over" "The game is over (~A)." (game-status g)))
  (when (engine-to-move-p g)
    (protocol-error "not_your_turn" "The engine is to move."))
  (let* ((uci (require-string msg "uci"))
         (m (parse-uci-move (game-pos g) uci)))
    (unless m
      (broadcast-game-state g)
      (protocol-error "illegal_move" "~A is not legal in this position." uci))
    (cancel-worker g)
    (when (apply-move g m "human")
      (after-state-change g))))

(defun cmd-undo (g)
  (when (null (game-records g))
    (protocol-error "nothing_to_undo" "There are no moves to take back."))
  (cancel-worker g)
  (flet ((pop-one ()
           (unmake-move (game-pos g))
           (pop (game-records g))))
    (pop-one)
    (setf (game-status g) "active")
    ;; In play mode also take back the engine's reply, so the human is to move.
    (when (and (engine-to-move-p g) (game-records g))
      (pop-one)))
  (setf (game-status g) "active"
        (game-winner g) nil)
  (when (game-clock-started g) (setf (game-clock-started g) (now-ms)))
  (incf (game-position-id g))
  (broadcast-game-state g)
  (after-state-change g))

(defun cmd-request-analysis (g msg)
  (check-position-id g msg)
  (unless (string= (game-status g) "active")
    (protocol-error "game_over" "Nothing to analyse: the game is over."))
  (when (game-thinking g)
    (protocol-error "engine_busy" "The engine is choosing its move."))
  (start-worker g :analysis))

(defun set-game-level (g level)
  "Adopt LEVEL and its depth and time, within the server's ceilings."
  (setf (game-level g) (level-name level)
        (game-depth g) (min (level-depth level) *max-depth*)
        (game-move-time-ms g) (min (level-time-ms level) *max-move-time-ms*)))

(defun cmd-set-level (g msg)
  (let ((level (find-level (jget msg "level"))))
    (unless level
      (protocol-error "bad_request" "level must be novice, club or expert."))
    (set-game-level g level)
    (broadcast-game-state g)))

(defun cmd-set-engine-depth (g msg)
  (let ((depth (jget msg "depth"))
        (time-ms (jget msg "moveTimeMs")))
    ;; Requests above the server's ceiling are clamped, not refused; the
    ;; game_state that follows tells the client what it actually got.
    (when (integerp depth)
      (unless (<= 1 depth 30) (protocol-error "bad_request" "depth must be 1..30."))
      (setf (game-depth g) (min depth *max-depth*)))
    (when (integerp time-ms)
      (unless (<= 50 time-ms 120000)
        (protocol-error "bad_request" "moveTimeMs must be 50..120000."))
      (setf (game-move-time-ms g) (min time-ms *max-move-time-ms*)))
    (broadcast-game-state g)))

(defun cmd-set-time-control (g msg)
  (let ((base (jget msg "baseMs"))
        (inc (jget msg "incrementMs" 0)))
    (cond ((integerp base)
           (unless (and (<= 1000 base 86400000) (integerp inc) (<= 0 inc 600000))
             (protocol-error "bad_request" "Unreasonable time control."))
           (setf (game-tc-base-ms g) base
                 (game-tc-inc-ms g) inc))
          (t (setf (game-tc-base-ms g) nil
                   (game-tc-inc-ms g) 0)))
    (reset-clocks g)
    (broadcast-game-state g)))

(defun cmd-set-mode (g msg)
  (let ((mode (require-string msg "mode"))
        (color (jget msg "humanColor")))
    (unless (member mode '("play" "analysis") :test #'string=)
      (protocol-error "bad_request" "mode must be \"play\" or \"analysis\"."))
    (cancel-worker g)
    (setf (game-mode g) mode)
    (when (member color '("white" "black") :test #'equal)
      (setf (game-human-color g) color))
    (broadcast-game-state g)
    (after-state-change g)))

(defun cmd-inspect-square (g msg)
  (check-position-id g msg)
  (let ((square (require-string msg "square"))
        (p (copy-position (game-pos g)))
        (pid (game-position-id g)))
    (handler-case (parse-square square)
      (error () (protocol-error "bad_request" "~S is not a square." square)))
    ;; Prolog may take a moment; never hold the state lock while waiting on it.
    (sb-thread:make-thread
     (lambda (&aux (*game* g))
       (let ((reply (prolog-inspect p square)))
         (if reply
             (broadcast "inspection"
                        "positionId" pid
                        "square" square
                        "piece" (jget reply "piece" :null)
                        "white" (jget reply "white" '())
                        "black" (jget reply "black" '())
                        "attacks" (jget reply "attacks" '())
                        "lines" (jget reply "lines" '())
                        "viz" (jget reply "viz" '()))
             (broadcast "error" "code" "symbolic_unavailable"
                                "message" "The Prolog knowledge layer did not answer."
                                "inReplyTo" (jget msg "id" :null)))))
     :name "symchess-inspect")))

(defun cmd-request-line (g msg)
  "Replay the line behind an explanation: the client names the search it is
looking at, and gets nothing if that is no longer the newest one."
  (let ((line (game-line g))
        (sid (jget msg "searchId")))
    (unless (and line (integerp sid) (= sid (getf line :sid)))
      (protocol-error "stale_line" "That line is no longer the engine's latest."))
    ;; Several Prolog queries: never hold the state lock while waiting on them.
    (sb-thread:make-thread
     (lambda (&aux (*game* g))
       (broadcast "line_replay"
                  "positionId" (getf line :pid)
                  "searchId" sid
                  "steps" (line-replay-steps (getf line :pos) (getf line :pv))))
     :name "symchess-line")))

(defun cmd-resign (g)
  (unless (string= (game-status g) "active")
    (protocol-error "game_over" "The game is already over."))
  (cancel-worker g)
  (setf (game-status g) "resigned"
        (game-winner g) (if (string= (game-human-color g) "white") "black" "white")
        (game-clock-white g) (clock-remaining g 1)
        (game-clock-black g) (clock-remaining g -1)
        (game-clock-started g) nil)
  (incf (game-position-id g))
  (broadcast-game-state g))

(defun handle-command (client text)
  (log-event "in" text)
  (setf (game-last-activity *game*) (now-ms))
  (let ((msg nil))
    (handler-case
        (progn
          (setf msg (json-decode text))
          (unless (objp msg) (protocol-error "bad_request" "Commands must be JSON objects."))
          (let ((type (require-string msg "type"))
                (g *game*))
            (with-state
              (cond ((string= type "sync")
                     (broadcast-game-state g)
                     (unless (game-thinking g) (after-state-change g)))
                    ((string= type "new_game") (cmd-new-game g msg))
                    ((string= type "make_move") (cmd-make-move g msg))
                    ((string= type "undo_move") (cmd-undo g))
                    ((string= type "request_analysis") (cmd-request-analysis g msg))
                    ((string= type "stop_search") (finish-worker g))
                    ((string= type "set_engine_depth") (cmd-set-engine-depth g msg))
                    ((string= type "set_level") (cmd-set-level g msg))
                    ((string= type "set_time_control") (cmd-set-time-control g msg))
                    ((string= type "set_mode") (cmd-set-mode g msg))
                    ((string= type "inspect_square") (cmd-inspect-square g msg))
                    ((string= type "request_line") (cmd-request-line g msg))
                    ((string= type "resign") (cmd-resign g))
                    (t (protocol-error "unknown_command" "Unknown command type ~S." type))))))
      (protocol-error (e)
        (send-direct client "error"
                     "code" (protocol-error-code e)
                     "message" (protocol-error-message e)
                     "inReplyTo" (if (objp msg) (jget msg "id" :null) :null)))
      (error (e)
        (format *error-output* "~&[command] ~A~%" e)
        (send-direct client "error"
                     "code" "internal_error"
                     "message" (princ-to-string e)
                     "inReplyTo" (if (objp msg) (jget msg "id" :null) :null))))))
