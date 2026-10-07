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
(defparameter *engine-version* "symchess 0.7.0")

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
        ;; Between the two: the whole evaluation, a shorter look ahead, and a
        ;; little of Novice's freedom to pick a move that is nearly as good.
        (make-level :name "casual" :depth 4 :time-ms 1500 :full t :margin 25)
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
          ((string= name "casual")
           (if best-p
               (format nil "Casual level: a ~D-ply search with the full evaluation."
                       (search-result-depth result))
               (format nil "Casual level: played ~A rather than its top choice ~A. At this level it picks among the moves it scores within ~,2F pawns of its best, never one that loses material to the next move."
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
  (level "club")                        ; the name of an entry of *LEVELS*
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
  (line nil)                            ; recent explained lines, newest first: ((:sid :pid :pos :pv) ...)
  (review-id 0)                         ; counts imported games
  (review-flag nil)                     ; (list nil) while an imported game is being reviewed
  (review-open nil)                     ; the gameId the client is holding, if any
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

;;; Every sentence also says where it came from, so that it can be followed
;;; back:
;;;   rule  - what produced the claim: an entry of the rule index (a Prolog
;;;           rule, or one of the engine's own measurements below)
;;;   check - what decided the status: another entry of the index
;;;   basis - that check as it applied here, with its numbers
;;;   facts - ids of the facts of this position the claim rests on, as
;;;           stated by Prolog (never matched up by squares)

(defun explanation-item (source status text &key (squares '()) motif rule check basis (facts '()))
  (obj "source" source "status" status "text" text "squares" squares
       ;; Which Prolog motif this sentence is about.
       "motif" (or motif :null)
       "rule" (or rule (and motif (format nil "motif:~A" motif)) :null)
       "check" (or check :null)
       "basis" (or basis :null)
       "facts" facts))

(defun motif-facts (motif)
  "The ids of the facts Prolog says MOTIF rests on."
  (jget motif "facts" '()))

;;; The engine's own entries in the rule index. Prolog describes its rules
;;; from its source (knowledge/rules.pl); these describe the measurements and
;;; checks made on this side, next to the code that makes them.
(defparameter *engine-rules*
  '(("search:score" "search" "measurement" "engine/src/search.lisp, search-position"
     "The value the alpha-beta search returned for the move, at the depth stated. A number from a search, not a judgement.")
    ("search:line" "search" "measurement" "engine/src/search.lisp, search-position"
     "The principal variation: the sequence of moves the search found best for both sides.")
    ("search:material" "search" "measurement" "engine/src/game.lisp, pv-material-swing"
     "The material count at the end of the search's line minus the count before it, for the side that moves first.")
    ("search:level" "search" "measurement" "engine/src/game.lisp, choose-level-move"
     "Below full strength the engine may pass over its best move. The note says which move it found best and which it played.")
    ("eval:terms" "eval" "measurement" "engine/src/eval.lisp, eval-breakdown"
     "The static evaluator's six terms for the position as it stands, before any move.")
    ("prolog:ranking" "prolog" "measurement" "knowledge/moves.pl, move_motifs/5"
     "Prolog's score for a move is the sum of the scores of its motifs. It is made without searching and the search does not use it.")
    ("prolog:line_end" "prolog" "measurement" "engine/src/game.lisp, expected-facts"
     "Prolog is asked about the position at the end of the search's line and its tactical facts are reported. That position may never arise.")
    ("prolog:unavailable" "prolog" "measurement" "engine/src/prolog-bridge.lisp, prolog-request"
     "Prolog did not answer in time or is not installed, so nothing symbolic is reported.")
    ("engine:verdict_bands" "search" "check" "engine/src/game.lisp, loss-verdict"
     "A move is rated by how much worse it scores than the search's choice at the same depth: up to 0.15 pawns about as good, up to 0.6 an inaccuracy, up to 2.0 a mistake, more a blunder. A move that gives up more than 0.6 but leaves its mover no worse is a missed chance.")
    ("engine:fact_delta" "prolog" "check" "engine/src/game.lisp, fact-delta"
     "Prolog is asked about the position before the move and the position after it. A fact is new if its key appears only afterwards, gone if only before.")
    ("engine:plan_support" "prolog" "check" "engine/src/game.lisp, build-counterfactual"
     "A plan keeps its support after a move if every fact it cites is still reported in the position after that move.")
    ("check:is_check" "search" "check" "engine/src/game.lisp, build-explanation"
     "A move Prolog says gives check is confirmed without a search: giving check is a property of the position after the move.")
    ("check:material_gain" "search" "check" "engine/src/game.lisp, pv-material-swing"
     "A motif that claims to win material is confirmed if the search's line ends at least one pawn of material ahead, and unconfirmed if it does not.")
    ("check:capture_on_target" "search" "check" "engine/src/game.lisp, pv-captures-on-p"
     "A fork, pin or skewer is confirmed if the mover later captures on one of its target squares in the search's line, and unconfirmed if not.")
    ("check:warning" "search" "check" "engine/src/game.lisp, build-counterfactual"
     "A Prolog warning about a move is confirmed if the search's line for that move ends at least one pawn of material down and the search rates the move worse than its best; unconfirmed if the search rates the move more than 0.6 pawns worse without that loss showing; overruled otherwise, including a sacrifice the search rates as its best.")
    ("check:warning_played" "search" "check" "engine/src/game.lisp, build-explanation"
     "A Prolog warning about the move the search chose is overruled: the search looked at the move and preferred it to every other.")
    ("check:top_move" "search" "check" "engine/src/game.lisp, build-explanation"
     "Prolog's highest-ranked move is compared with the move the search chose. If they differ, Prolog's suggestion is overruled.")
    ("check:none" "search" "check" "engine/src/game.lisp, build-explanation"
     "Positional advice. The search does not look far enough to confirm or refute it, so it is reported as a heuristic."))
  "id, layer, group, where, summary.")

(defvar *rule-index* nil
  "The full rule index once Prolog has supplied its part. Filled on first use.")
(defvar *rule-index-lock* (sb-thread:make-mutex :name "rule-index"))

(defun engine-rule-objects ()
  (loop for (id layer group where summary) in *engine-rules*
        collect (obj "id" id "layer" layer "group" group
                     "name" (subseq id (1+ (position #\: id)))
                     "where" where "summary" summary "source" :null)))

(defun rule-index-fields ()
  "The fields of a `rules` message. Prolog's rules come from Prolog; if it
cannot be reached the engine's own entries are still sent, and the status says
the index is incomplete. The complete index is kept; an incomplete one is not,
so Prolog is asked again next time."
  (let ((known (sb-thread:with-mutex (*rule-index-lock*) *rule-index*)))
    (if known
        (list "status" "ok" "rules" known)
        (let ((prolog (prolog-rules)))
          (cond (prolog
                 (let ((all (append prolog (engine-rule-objects))))
                   (sb-thread:with-mutex (*rule-index-lock*) (setf *rule-index* all))
                   (list "status" "ok" "rules" all)))
                (t (list "status" "unavailable" "rules" (engine-rule-objects))))))))

(defun agreement-fields (items &optional top-san chosen-san)
  "Where Prolog and the search stand on one search, counted from ITEMS: every
Prolog sentence the search confirmed, left unconfirmed, overruled, or could
not check. TOP-SAN is Prolog's highest-ranked move and CHOSEN-SAN the search's
move, when both are known."
  (flet ((tally (status)
           (count-if (lambda (item)
                       (and (equal (jget item "source") "prolog")
                            (equal (jget item "status") status)))
                     items)))
    (obj "confirmed" (tally "confirmed")
         "unconfirmed" (tally "unconfirmed")
         "overruled" (tally "overruled")
         "unchecked" (tally "heuristic")
         "prologTop" (or top-san :null)
         "searchMove" (or chosen-san :null)
         "sameMove" (if (and top-san chosen-san) (jbool (string= top-san chosen-san)) :null))))

(defun remember-line (g sid pid p pv)
  "Keep the line behind search SID so it can be replayed on request. A few
are kept: the engine's own choice and a move the user asked about can both be
on screen."
  (push (list :sid sid :pid pid :pos (copy-position p) :pv pv) (game-line g))
  (when (nthcdr 4 (game-line g))
    (setf (game-line g) (subseq (game-line g) 0 4))))

;;; ---------------------------------------------------- comparing two positions
;;; "What did that move change?" is answered with two things the engine
;;; already has: the evaluator's terms for each position, and Prolog's facts
;;; for each. Prolog gives every fact a key that is the same wherever that
;;; fact holds; comparing keys is all that happens here.

(defparameter *delta-ignored-kinds* '("pawn_break")
  "Facts reported only for the side to move. They vanish after any move, which
says nothing about the position, so they are left out of comparisons.")

(defparameter *tactical-kinds*
  '("check" "fork" "pin" "skewer" "hanging" "threatened" "overloaded" "pinned_defender"
    "trapped" "discovered_attack" "weak_back_rank" "unstoppable_pawn")
  "Facts about what can be won or lost now. In a comparison they are reported
before facts about pawn structure and files.")

(defun delta-facts (analysis)
  (let ((facts (remove-if (lambda (fact)
                            (member (jget fact "kind") *delta-ignored-kinds* :test #'equal))
                          (and analysis (jget analysis "facts" '())))))
    (flet ((tactical (fact) (member (jget fact "kind") *tactical-kinds* :test #'equal)))
      (append (remove-if-not #'tactical facts) (remove-if #'tactical facts)))))

(defun fact-delta (before after)
  "Two lists of fact objects from analyses BEFORE and AFTER: the facts true
only afterwards (added) and the facts true only beforehand (removed)."
  (let ((old (delta-facts before))
        (new (delta-facts after)))
    (flet ((key (fact) (jget fact "key"))
           (missing-from (facts)
             (lambda (fact)
               (find (jget fact "key") facts :key (lambda (f) (jget f "key")) :test #'equal))))
      (declare (ignorable #'key))
      (values (remove-if (missing-from old) new)
              (remove-if (missing-from new) old)))))

(defparameter *term-names*
  '(("material" . "material") ("placement" . "piece placement") ("pawnStructure" . "pawn structure")
    ("bishopPair" . "bishop pair") ("activity" . "piece activity") ("kingSafety" . "king safety")))

(defun term-delta (before after)
  "The change in each evaluation term between two breakdowns, White's view."
  (cons :obj (loop for (key) in *term-names*
                   collect (cons key (- (jget after key 0) (jget before key 0))))))

;;; Verdict words come from fixed bands on the score difference. The bands are
;;; wide because a difference of a few hundredths at this depth is noise.
(defun clamp-score (score) (max -2000 (min 2000 score)))

(defun loss-verdict (loss &optional (mover-score -1))
  "LOSS: centipawns the mover gave up compared with the better alternative.
MOVER-SCORE: where the move leaves its mover. A move that throws away a lot
but still leaves its mover no worse is a missed chance, not a blunder."
  (cond ((<= loss 15) "as_good")
        ((<= loss 60) "inaccuracy")
        ((>= mover-score 0) "missed_chance")
        ((<= loss 200) "mistake")
        (t "blunder")))

(defun verdict-words (verdict)
  (cdr (assoc verdict '(("best" . "the engine's own choice")
                        ("as_good" . "about as good as the engine's choice")
                        ("inaccuracy" . "an inaccuracy")
                        ("missed_chance" . "a missed chance")
                        ("mistake" . "a mistake")
                        ("blunder" . "a blunder"))
              :test #'string=)))

;;; A rating is what one search to one depth thinks. It is worded that way
;;; everywhere: "at depth 6 the search prefers...", never a bare "this is a
;;; mistake". A search this shallow is wrong about sacrifices that pay off
;;; beyond its horizon, and the caution says so where it matters most.
(defun depth-caution (verdict depth &optional mate)
  "A sentence limiting what a rating of VERDICT at DEPTH can be taken to mean,
or NIL where the rating says nothing against the move. MATE: one of the two
lines being compared ends in a forced mate. A mate the search has found is
exact, so the rating is not a matter of depth and is not hedged."
  (cond ((member verdict '("best" "as_good") :test #'string=) nil)
        (mate
         "One of the two lines ends in a forced mate, which the search has seen to the end: this rating does not depend on how deep it looked.")
        ((string= verdict "missed_chance")
         (format nil "This is a depth-~D preference, not proof of an error: a sacrifice or a slow plan that pays off beyond ~D plies looks exactly like this." depth depth))
        (t
         (format nil "This is what a depth-~D search prefers, not proof of a mistake." depth))))

(defun mate-score-p (score) (> (abs score) +mate-bound+))

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

(defun position-step-fields (p move by)
  "What the interface needs to show position P as one step of a line or game:
the board, who is in check, and Prolog's facts. MOVE and BY describe the move
that led here (:null for a starting position). One Prolog query."
  (let* ((over (not (has-legal-move-p p)))
         (analysis (and (not over) (symbolic-analysis p))))
    (list "move" move
          "by" by
          "fen" (pos-to-fen p)
          "board" (board-object p)
          "turn" (side-name (pos-side p))
          "check" (if (in-check-p p)
                      (square-name (king-square p (pos-side p)))
                      :null)
          "checkmate" (jbool (and over (in-check-p p)))
          "symbolic" (jbool analysis)
          "facts" (if analysis (jget analysis "facts" '()) '()))))

(defun line-replay-steps (p pv)
  "The positions along line PV starting from P, as step objects: the first is P
itself, each later one the position after one more move. Every step carries the
board and Prolog's facts for it, so the interface can show the line without
making a move or judging a position itself. One Prolog query per step."
  (let ((p (copy-position p))
        (steps '()))
    (flet ((snapshot (move by)
             (push (apply #'obj (position-step-fields p move by)) steps)))
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
         (top-san nil)                  ; Prolog's highest-ranked move, if it ranked any
         (items '()))
    (flet ((add (&rest args) (push (apply #'explanation-item args) items)))
      (when note (add "search" "measured" note :rule "search:level"))
      (add "search" "measured"
           (format nil "Searched ~D plies deep (~:D positions, ~,1F s). ~A scores ~A (White's view)."
                   (search-result-depth result) (search-result-nodes result)
                   (/ (search-result-time-ms result) 1000.0)
                   san (score-text (search-result-score result) side))
           :rule "search:score")
      (when (rest pv)
        (add "search" "measured"
             (format nil "Expected continuation: ~{~A~^ ~}." (pv-san p pv))
             :rule "search:line"))
      (cond ((>= swing 100)
             (add "search" "measured"
                  (format nil "Along that line ~A comes out about ~,1F pawns of material ahead."
                          mover (/ swing 100.0))
                  :rule "search:material"))
            ((<= swing -100)
             (add "search" "measured"
                  (format nil "Along that line ~A gives up about ~,1F pawns of material; the evaluation at the end of the line still favours the move."
                          mover (/ (- swing) 100.0))
                  :rule "search:material")))
      (let ((terms (eval-breakdown p)))
        (add "eval" "measured"
             (format nil "Static evaluation before the move, White's view: material ~@D, piece placement ~@D, pawn structure ~@D, bishop pair ~@D, piece activity ~@D, king safety ~@D (centipawns)."
                     (jget terms "material") (jget terms "placement")
                     (jget terms "pawnStructure") (jget terms "bishopPair")
                     (jget terms "activity") (jget terms "kingSafety"))
             :rule "eval:terms"))
      ;; Where the line leads: Prolog's reading of the position the search
      ;; expects to reach. Advice about a position that may never arise.
      (dolist (fact expected)
        (add "prolog" "heuristic"
             (format nil "At the end of the expected line: ~A" (jget fact "text"))
             :squares (jget fact "squares" '())
             :rule (format nil "fact:~A" (jget fact "kind"))
             :check "prolog:line_end"
             :basis "A fact about the position at the end of the search's line, not about the board now."))
      (if (null analysis)
          (add "prolog" "heuristic"
               "The Prolog knowledge layer was unavailable, so this explanation is search-only."
               :rule "prolog:unavailable" :check "check:none"
               :basis "Nothing from Prolog to check.")
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
                (flet ((say (status sentence check basis)
                         (add "prolog" status sentence
                              :squares targets :motif kind :facts (motif-facts motif)
                              :check check :basis basis)))
                  (cond ((minusp score)
                         (say "overruled"
                              (format nil "Prolog warned: ~A The search played it anyway." text)
                              "check:warning_played"
                              (format nil "Overruled because the search compared ~A with every other move and still chose it." san)))
                        ((string= kind "gives_check")
                         (say "confirmed" text "check:is_check"
                              "Confirmed because the move does give check."))
                        ((member kind '("captures_hanging" "wins_exchange") :test #'string=)
                         (if (>= swing 100)
                             (say "confirmed"
                                  (format nil "~A The search line keeps the material." text)
                                  "check:material_gain"
                                  (format nil "Confirmed because the line after ~A ends ~,1F pawns of material ahead." san (/ swing 100.0)))
                             (say "unconfirmed"
                                  (format nil "~A But the search line does not end material ahead." text)
                                  "check:material_gain"
                                  (format nil "Not confirmed: the line after ~A ends ~:[level on material~;~:*~,1F pawns of material ~:[down~;up~]~], under the one pawn needed."
                                          san (and (/= swing 0) (/ (abs swing) 100.0)) (plusp swing)))))
                        ((member kind '("creates_fork" "creates_pin" "creates_skewer")
                                 :test #'string=)
                         (if (pv-captures-on-p p pv targets)
                             (say "confirmed"
                                  (format nil "~A The expected line cashes this in." text)
                                  "check:capture_on_target"
                                  (format nil "Confirmed because ~A later captures on ~{~A~^ or ~} in the search's line." mover targets))
                             (say "unconfirmed"
                                  (format nil "~A The expected line does not capture any of those targets, so treat this as a threat, not a win." text)
                                  "check:capture_on_target"
                                  (format nil "Not confirmed: ~A does not capture on ~{~A~^ or ~} anywhere in the search's line." mover targets))))
                        (t (say "heuristic" text "check:none"
                                "Not checked: the search cannot verify positional advice at this depth."))))))
            (cond ((and entry (/= 0 (jget entry "score" 0)))
                   (add "prolog" "heuristic"
                        (format nil "Prolog's own ranking of the moves, made without searching, put ~A number ~D of ~D (score ~@D). The search did not use that ranking."
                                san (1+ rank) (length entries) (jget entry "score" 0))
                        :rule "prolog:ranking" :check "check:none"
                        :basis "A ranking, not a claim the search can test."))
                  (t
                   (add "prolog" "heuristic"
                        (format nil "Prolog found no tactical or positional motif for ~A, so this choice rests on the search alone."
                                san)
                        :rule "prolog:ranking" :check "check:none"
                        :basis "No motif fired for this move, so there is nothing to test.")))
            (setf top-san (and top (plusp (jget top "score" 0))
                               (jget top "san" (jget top "uci"))))
            (when (and top (plusp (jget top "score" 0))
                       (string/= (jget top "uci") uci))
              (add "prolog" "overruled"
                   (format nil "Prolog's top suggestion was ~A~@[ (~A)~]; the search preferred ~A."
                           (jget top "san" (jget top "uci"))
                           (let ((motif (first (jget top "motifs"))))
                             (and motif (jget motif "kind")))
                           san)
                   :rule "prolog:ranking" :check "check:top_move"
                   :basis (format nil "Overruled because the search chose ~A, not ~A."
                                  san (jget top "san" (jget top "uci"))))))))
    (setf items (nreverse items))
    (list "move" (move-object p best legal)
          ;; An analysis search recommends a move; only a play search plays it.
          "summary" (format nil (if (eq purpose :play)
                                    "~A plays ~A (~A)."
                                    "Best for ~A: ~A (~A).")
                            mover san (score-text (search-result-score result) side))
          "items" items
          ;; Where the two layers stand on this search, counted.
          "agreement" (agreement-fields items top-san (and analysis san)))))

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

;;; ------------------------------------------------------- reviewing a game
;;; An imported game is walked once, position by position, in its own thread.
;;; Each position gets a short full-strength search and one Prolog query, and
;;; is sent as soon as it is ready. Messages carry the game's id, so a client
;;; that has moved on to another game can ignore them.

(defvar *review-depth* 5)
(defvar *review-time-ms* 250)

(defun cancel-review (g)
  (when (game-review-flag g)
    (setf (car (game-review-flag g)) t
          (game-review-flag g) nil)))

(defun close-review (g)
  "Stop any review and tell the client its imported game is no longer held."
  (cancel-review g)
  (when (game-review-open g)
    (broadcast "review_closed" "gameId" (game-review-open g))
    (setf (game-review-open g) nil)))

(defun review-change (san mover before after judged)
  "What the move SAN changed, and how it compares with the move the search
would have played. BEFORE and AFTER are snapshots (plists of :score, a
White-view centipawn score or NIL; :terms, an evaluation breakdown; :analysis,
Prolog's reply or NIL). JUDGED compares the move with the search's own choice
from the same position at the same depth: a plist of :same, :best-san,
:best-score and :move-score (both from the mover's point of view) and :depth.
MOVER is +1 or -1. Returns an object, or :null for the starting position."
  (if (null before)
      :null
      (let* ((b (getf before :score))
             (a (getf after :score))
             (same (getf judged :same))
             (best-score (getf judged :best-score))
             (move-score (getf judged :move-score))
             (mate (and judged (or (mate-score-p best-score) (mate-score-p move-score))))
             (loss (and judged
                        (if same 0 (max 0 (- (clamp-score best-score) (clamp-score move-score))))))
             (verdict (cond ((null judged) :null)
                            (same "best")
                            (t (loss-verdict loss (clamp-score move-score)))))
             (terms (term-delta (getf before :terms) (getf after :terms)))
             (lines '()))
        (multiple-value-bind (added removed) (fact-delta (getf before :analysis) (getf after :analysis))
          (flet ((say (control &rest args) (push (apply #'format nil control args) lines))
                 (pawns (cp) (format nil "~:[-~;+~]~,2F" (>= cp 0) (/ (abs cp) 100.0))))
            ;; --- the move against the search's own choice, like for like
            (cond ((null judged))
                  (same
                   (say "~A is the move the search would play too (depth ~D)." san (getf judged :depth)))
                  (mate
                   (say "At depth ~D the search preferred ~A; by that measure ~A is ~A."
                        (getf judged :depth) (getf judged :best-san) san (verdict-words verdict)))
                  (t
                   (say "At depth ~D the search preferred ~A~:[, scoring ~A about ~,1F pawns lower~;~2*~]: by that measure ~A is ~A."
                        (getf judged :depth) (getf judged :best-san)
                        (zerop loss) san (/ loss 100.0)
                        san (verdict-words verdict))))
            (let ((caution (and judged (not same) (depth-caution verdict (getf judged :depth) mate))))
              (when caution (say "~A" caution)))
            ;; --- what changed in the position
            (cond ((not (and a b))
                   (say "The game ends here, so there is no score to compare."))
                  ((< (abs (- a b)) 60)
                   (say "The evaluation barely moved: ~A before, ~A after (White's view)." (pawns b) (pawns a)))
                  (t
                   (say "The evaluation went from ~A to ~A (White's view)." (pawns b) (pawns a))
                   (let* ((static (- (jget (getf after :terms) "total" 0)
                                     (jget (getf before :terms) "total" 0)))
                          (agrees (and (plusp (* static (- a b)))
                                       (>= (* 2 (abs static)) (abs (- a b)))))
                          (moved (sort (remove-if (lambda (entry)
                                                    (or (< (abs (cdr entry)) 20)
                                                        ;; only terms that moved the same way
                                                        (minusp (* (cdr entry) (- a b)))))
                                                  (copy-list (rest terms)))
                                       #'> :key (lambda (entry) (abs (cdr entry))))))
                     ;; Name the evaluator's terms only when the position as it
                     ;; stands accounts for most of the change. Otherwise the
                     ;; change is in what the search sees coming.
                     (if (and agrees moved)
                         (say "The evaluator's terms behind it: ~{~A~^, ~}."
                              (loop for (key . change) in moved
                                    repeat 3
                                    collect (format nil "~A ~A"
                                                    (cdr (assoc key *term-names* :test #'string=))
                                                    (pawns change))))
                         (say "That is mostly what the search sees ahead, not the position as it stands.")))))
            (loop for fact in added repeat 3 do (say "New: ~A" (jget fact "text")))
            (loop for fact in removed repeat 3 do (say "Gone: ~A" (jget fact "text")))
            (obj "before" (if b (obj "cp" b "mate" :null) :null)
                 "after" (if a (obj "cp" a "mate" :null) :null)
                 "best" (if judged (getf judged :best-san) :null)
                 "lossCp" (if (and judged (not mate)) loss :null)
                 "verdict" verdict
                 "terms" terms
                 "factsAdded" added
                 "factsRemoved" removed
                 "lines" (nreverse lines)))))))

(defun run-review (rid flag start moves)
  (let ((p (copy-position start))
        (ply 0)
        (previous nil)
        (searched nil))                 ; the search of the position now on the board
    (labels ((stop () (car flag))
             (look (move by judged)
               "Search and describe the position on the board and send it."
               (when (stop) (return-from run-review nil))
               (let* ((fields (position-step-fields p move by))
                      (result (and (has-legal-move-p p)
                                   (sb-thread:with-mutex (*search-lock*)
                                     (unless (stop)
                                       (set-engine-features)
                                       ;; From an empty table, so the rating of a
                                       ;; move does not depend on what was
                                       ;; searched before it.
                                       (tt-clear)
                                       (search-position p :max-depth *review-depth*
                                                          :time-ms *review-time-ms*
                                                          :stop-fn #'stop)))))
                      (scored (and result (search-result-best-move result)))
                      (terms (eval-breakdown p))
                      (snapshot (list :score (and scored
                                                  (* (pos-side p)
                                                     (clamp-score (search-result-score result))))
                                      :terms terms
                                      ;; Already cached by POSITION-STEP-FIELDS.
                                      :analysis (and (has-legal-move-p p) (symbolic-analysis p))))
                      (change (if (eq move :null)
                                  :null
                                  (review-change (jget move "san") (- (pos-side p))
                                                 previous snapshot judged))))
                 (setf previous snapshot
                       searched (and scored result))
                 (when (stop) (return-from run-review nil))
                 (apply #'broadcast "review_step"
                        "gameId" rid
                        "ply" ply
                        "change" change
                        ;; White's view, like every other score. No score for a
                        ;; position where the game has ended.
                        "score" (if scored
                                    (score-object (search-result-score result) (pos-side p))
                                    :null)
                        "depth" (if scored (search-result-depth result) 0)
                        "evalBreakdown" terms
                        fields)))
             (judge (m)
               "Compare game move M with the search's choice in the position on the board."
               (when searched
                 (let* ((choice (search-result-best-move searched))
                        (same (= choice m))
                        (alt (if same
                                 searched
                                 (sb-thread:with-mutex (*search-lock*)
                                   (unless (stop)
                                     (set-engine-features)
                                     (search-line p m (search-result-depth searched)
                                                  :time-ms *review-time-ms* :stop-fn #'stop))))))
                   (when alt
                     (list :same same
                           :best-san (move-san p choice)
                           :best-score (search-result-score searched)
                           :move-score (search-result-score alt)
                           :depth (search-result-depth searched)))))))
      (look :null :null nil)
      (dolist (m moves)
        (let* ((legal (legal-moves p))
               (move (move-object p m legal))
               (by (side-name (pos-side p)))
               (judged (judge m)))
          (make-move p m)
          (incf ply)
          (look move by judged)))
      (broadcast "review_complete" "gameId" rid "plies" ply))))

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
        (remember-line g sid pid p (search-result-pv played))
        (when (eq purpose :play)
          (setf (game-thinking g) nil)
          (when (apply-move g (search-result-best-move played) "engine")
            (after-state-change g)))))))

;;; ------------------------------------------------------ "why not this move?"

(defun position-after (p move)
  (let ((q (copy-position p)))
    (make-move q move)
    q))

(defun build-counterfactual (p best alt analysis)
  "Compare ALT (a search result for the move the user asked about) with BEST
(the engine's own search of the same position). Every statement is either a
number from one of those two searches or a fact from Prolog, and says which."
  (let* ((legal (legal-moves p))
         (side (pos-side p))
         (mover (string-capitalize (side-name side)))
         (move (search-result-best-move alt))
         (choice (search-result-best-move best))
         (same (= move choice))
         (san (move-san p move legal))
         (best-san (move-san p choice legal))
         (alt-score (search-result-score alt))
         (best-score (search-result-score best))
         (mate (or (mate-score-p alt-score) (mate-score-p best-score)))
         (loss (max 0 (- (clamp-score best-score) (clamp-score alt-score))))
         (verdict (if same "best" (loss-verdict loss (clamp-score alt-score))))
         (alt-swing (pv-material-swing p (search-result-pv alt)))
         (best-swing (pv-material-swing p (search-result-pv best)))
         (after-alt (and analysis (symbolic-analysis (position-after p move))))
         (after-best (and analysis (if same after-alt (symbolic-analysis (position-after p choice)))))
         (items '()))
    (multiple-value-bind (added removed) (fact-delta analysis after-alt)
      (multiple-value-bind (best-added best-removed) (fact-delta analysis after-best)
        (flet ((add (&rest args) (push (apply #'explanation-item args) items))
               (pawns (cp) (/ (abs cp) 100.0)))
          ;; --- what the two searches found
          (if same
              (add "search" "measured"
                   (format nil "~A is the move the engine would play itself. It scores ~A (White's view), searched ~D plies deep."
                           san (score-text alt-score side) (search-result-depth alt))
                   :rule "search:score")
              (add "search" "measured"
                   (format nil "~A scores ~A; the engine's choice ~A scores ~A (White's view, ~D and ~D plies deep).~:[ ~A is about ~,1F pawns worse.~;~]"
                           san (score-text alt-score side) best-san (score-text best-score side)
                           (search-result-depth alt) (search-result-depth best)
                           (or mate (zerop loss)) san (pawns loss))
                   :rule "search:score" :check "engine:verdict_bands"
                   :basis (format nil "Verdict \"~A\": the difference between the two scores, in fixed bands (up to 0.15 about as good, 0.6 an inaccuracy, 2.0 a mistake, more a blunder). A move that gives up more than 0.6 but leaves its mover no worse is called a missed chance."
                                  verdict)))
          (when (rest (search-result-pv alt))
            (add "search" "measured"
                 (format nil "After ~A the engine expects: ~{~A~^ ~}." san (pv-san p (search-result-pv alt)))
                 :rule "search:line"))
          (unless same
            (when (or (>= (abs alt-swing) 100) (>= (abs (- alt-swing best-swing)) 100))
              (add "search" "measured"
                   (format nil "Material along the two lines: after ~A, ~A ends ~:[level~;~:*~A~]; after ~A, ~:[level~;~:*~A~]."
                           san mover
                           (and (/= alt-swing 0)
                                (format nil "~,1F pawns ~:[down~;up~]" (pawns alt-swing) (plusp alt-swing)))
                           best-san
                           (and (/= best-swing 0)
                                (format nil "~,1F pawns ~:[down~;up~]" (pawns best-swing) (plusp best-swing))))
                   :rule "search:material")))
          ;; --- what Prolog said about the move, and whether the search bears it out
          (if (null analysis)
              (add "prolog" "heuristic"
                   "The Prolog knowledge layer was unavailable, so this comparison is search-only."
                   :rule "prolog:unavailable" :check "check:none"
                   :basis "Nothing from Prolog to check.")
              (let ((entry (find (move-uci move) (jget analysis "moves")
                                 :key (lambda (e) (jget e "uci")) :test #'string=)))
                (dolist (motif (and entry (jget entry "motifs")))
                  (let ((kind (jget motif "kind"))
                        (targets (jget motif "targets" '()))
                        (text (jget motif "text")))
                    (flet ((say (status sentence check basis)
                             (add "prolog" status sentence
                                  :squares targets :motif kind :facts (motif-facts motif)
                                  :check check :basis basis)))
                      (cond
                        ((minusp (jget motif "score" 0))
                         (cond ((and (<= alt-swing -100) (or same (<= loss 60)))
                                ;; A sound sacrifice: the material does go, and
                                ;; the search still rates the move as highly as
                                ;; any. The warning was true and beside the point.
                                (say "overruled"
                                     (format nil "Prolog warned: ~A The material is given up in the search's line, and ~:[the search still rates the move about as good as its own choice~;it is still the move the search would play itself~]: a sacrifice."
                                             text same)
                                     "check:warning"
                                     (format nil "Overruled: the line after ~A ends ~,1F pawns of material down, but the search does not rate the move worse than its best." san (pawns alt-swing))))
                               ((<= alt-swing -100)
                                (say "confirmed"
                                     (format nil "Prolog warned: ~A The search agrees: its line loses material." text)
                                     "check:warning"
                                     (format nil "Confirmed because the line after ~A ends ~,1F pawns of material down." san (pawns alt-swing))))
                               ((and (not same) (> loss 60))
                                (say "unconfirmed"
                                     (format nil "Prolog warned: ~A The search does rate the move worse, but its line does not show that material being lost." text)
                                     "check:warning"
                                     "Not confirmed: the line's material count is under a pawn down."))
                               (t
                                (say "overruled"
                                     (format nil "Prolog warned: ~A The search finds nothing wrong with the move." text)
                                     "check:warning"
                                     "Overruled: the search rates this move within 0.6 pawns of its best and the line loses no material."))))
                        ((string= kind "gives_check")
                         (say "confirmed" text "check:is_check" "Confirmed because the move does give check."))
                        ((>= alt-swing 100)
                         (say "confirmed"
                              (format nil "~A The search's line for it does win material." text)
                              "check:material_gain"
                              (format nil "Confirmed because the line after ~A ends ~,1F pawns of material up." san (pawns alt-swing))))
                        ((member kind '("captures_hanging" "wins_exchange" "creates_fork"
                                        "creates_pin" "creates_skewer")
                                 :test #'string=)
                         (say "unconfirmed"
                              (format nil "~A But the search's line for it does not end material ahead." text)
                              "check:material_gain"
                              "Not confirmed: the line's material count is under a pawn up."))
                        (t (say "heuristic" text "check:none"
                                "Not checked: the search cannot verify positional advice at this depth."))))))
                ;; --- what the move changes on the board, by Prolog's facts
                (flet ((say (facts control &optional (limit 3))
                         (loop for fact in facts
                               repeat limit
                               do (add "prolog" "heuristic"
                                       (format nil control (jget fact "text"))
                                       :squares (jget fact "squares" '())
                                       :rule (format nil "fact:~A" (jget fact "kind"))
                                       :check "engine:fact_delta"
                                       :basis "A fact Prolog reports in one position and not the other."))))
                  (say added (format nil "New after ~A: ~~A" san))
                  (say removed (format nil "No longer true after ~A: ~~A" san))
                  (unless same
                    (say (remove-if (lambda (fact)
                                      (find (jget fact "key") added
                                            :key (lambda (f) (jget f "key")) :test #'equal))
                                    best-added)
                         (format nil "~A would instead create: ~~A" best-san)
                         2)))
                ;; --- plans whose supporting facts the move removes
                (unless same
                  (let ((facts (jget analysis "facts" '())))
                    (flet ((survives (plan after)
                             (every (lambda (id)
                                      (let ((fact (find id facts :key (lambda (f) (jget f "id")) :test #'equal)))
                                        (or (null fact)
                                            (member (jget fact "kind") *delta-ignored-kinds* :test #'equal)
                                            (find (jget fact "key") (jget after "facts" '())
                                                  :key (lambda (f) (jget f "key")) :test #'equal))))
                                    (jget plan "because" '()))))
                      (loop for plan in (jget analysis "plans" '())
                            with said = 0
                            when (and after-alt after-best (< said 2)
                                      (not (survives plan after-alt))
                                      (survives plan after-best))
                              do (incf said)
                                 (add "prolog" "heuristic"
                                      (format nil "The plan \"~A\" loses the facts it rests on after ~A; after ~A it keeps them."
                                              (jget plan "text") san best-san)
                                      :rule (format nil "plan:~A" (jget plan "kind"))
                                      :facts (jget plan "because" '())
                                      :check "engine:plan_support"
                                      :basis "A plan is kept if every fact it cites is still reported after the move.")))))))
          (setf items (nreverse items))
          (list "move" (move-object p move legal)
                "best" (move-object p choice legal)
                "isBest" (jbool same)
                "score" (score-object alt-score side)
                "bestScore" (score-object best-score side)
                "lossCp" (if (or same mate) :null loss)
                "verdict" verdict
                "depth" (search-result-depth alt)
                "line" (pv-san p (search-result-pv alt))
                "bestLine" (pv-san p (search-result-pv best))
                "factsAdded" added
                "factsRemoved" removed
                "bestFactsAdded" best-added
                "bestFactsRemoved" best-removed
                "summary" (if same
                              (format nil "~A is the engine's own choice (~A)." san (score-text alt-score side))
                              (format nil "At depth ~D the search prefers ~A~:[ and scores ~A about ~,1F pawns lower~;~2*~]: by that measure ~A is ~A~:[~;, though ~A is still not worse~]."
                                      (search-result-depth alt) best-san
                                      (or mate (zerop loss)) san (pawns loss)
                                      san (verdict-words verdict)
                                      (string= verdict "missed_chance") mover))
                ;; What the rating can and cannot be taken to mean.
                "caution" (or (and (not same) (depth-caution verdict (search-result-depth alt) mate)) :null)
                "items" items
                "agreement" (agreement-fields items)
                ;; The asked move, the engine's move, and the reply that answers the asked one.
                "viz" (append
                       (list (obj "type" "arrow" "from" (square-name (move-from move))
                                  "to" (square-name (move-to move)) "style" "asked"))
                       (unless same
                         (list (obj "type" "arrow" "from" (square-name (move-from choice))
                                    "to" (square-name (move-to choice)) "style" "pv")))
                       (let ((reply (second (search-result-pv alt))))
                         (when reply
                           (list (obj "type" "arrow" "from" (square-name (move-from reply))
                                      "to" (square-name (move-to reply)) "style" "threat")))))))))))

(defun run-counterfactual (g p pid sid flag move depth time-ms)
  (let ((analysis (symbolic-analysis p)))
    (when (cancelled-p flag) (return-from run-counterfactual nil))
    (apply #'broadcast "symbolic_analysis" (symbolic-fields pid analysis))
    (multiple-value-bind (best alt)
        ;; Both searches at full strength, one after the other, under the lock.
        (sb-thread:with-mutex (*search-lock*)
          (when (cancelled-p flag) (return-from run-counterfactual nil))
          (set-engine-features)
          ;; From an empty table: the same question gets the same answer.
          (tt-clear)
          (let* ((stop (lambda () (car flag)))
                 (best (search-position p :max-depth depth :time-ms time-ms :stop-fn stop))
                 (choice (search-result-best-move best)))
            (values best
                    (cond ((null choice) nil)
                          ((= choice move) best)
                          (t (search-line p move (search-result-depth best)
                                          :time-ms time-ms :stop-fn stop))))))
      (when (or (cancelled-p flag) (null alt) (null (search-result-best-move best)))
        (return-from run-counterfactual nil))
      ;; Prolog queries for the two resulting positions: outside every lock.
      (let ((fields (build-counterfactual p best alt analysis)))
        (with-state
          (when (or (cancelled-p flag) (/= pid (game-position-id g)))
            (return-from run-counterfactual nil))
          (remember-line g sid pid p (search-result-pv alt))
          (apply #'broadcast "counterfactual" "positionId" pid "searchId" sid fields))))))

(defun run-symbolic (g p pid flag)
  (let ((analysis (symbolic-analysis p)))
    (with-state
      (unless (or (cancelled-p flag) (/= pid (game-position-id g)))
        (apply #'broadcast "symbolic_analysis" (symbolic-fields pid analysis))))))

(defun start-worker (g kind &optional move)
  "KIND is :play, :analysis (both search), :symbolic (Prolog only) or :why
(compare MOVE with the engine's choice)."
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
                   (case kind
                     (:symbolic (run-symbolic g p pid flag))
                     (:why (run-counterfactual g p pid sid flag move depth time-ms))
                     (t (run-search g p pid sid flag kind depth time-ms)))
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
  (close-review g)
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
  (let* ((sid (jget msg "searchId"))
         (line (and (integerp sid)
                    (find sid (game-line g) :key (lambda (l) (getf l :sid))))))
    (unless line
      (protocol-error "stale_line" "That line is no longer one the engine is holding."))
    ;; Several Prolog queries: never hold the state lock while waiting on them.
    (sb-thread:make-thread
     (lambda (&aux (*game* g))
       (broadcast "line_replay"
                  "positionId" (getf line :pid)
                  "searchId" sid
                  "steps" (line-replay-steps (getf line :pos) (getf line :pv))))
     :name "symchess-line")))

(defun cmd-explain-move (g msg)
  "Why not this move? Search it and the engine's own choice and compare them."
  (check-position-id g msg)
  (unless (string= (game-status g) "active")
    (protocol-error "game_over" "Nothing to compare: the game is over."))
  (when (game-thinking g)
    (protocol-error "engine_busy" "The engine is choosing its move."))
  (let* ((uci (require-string msg "uci"))
         (m (parse-uci-move (game-pos g) uci)))
    (unless m
      (protocol-error "illegal_move" "~A is not legal in this position." uci))
    (start-worker g :why m)))

(defparameter *max-pgn-length* 200000)

(defun cmd-load-pgn (g msg)
  "Import a game: every move is checked by the move generator, the game
becomes this session's game (in analysis mode, at its last position), and a
review of all its positions starts in the background."
  (let ((text (require-string msg "pgn")))
    (when (> (length text) *max-pgn-length*)
      (protocol-error "bad_pgn" "That PGN is too long (limit ~D characters)." *max-pgn-length*))
    (let* ((read (read-pgn-game text))
           (moves (getf read :moves))
           (failure (getf read :error))
           (start (getf read :start)))
      (when (and (null moves) failure)
        (protocol-error "bad_pgn" "No moves could be read. Half-move ~D (~A): ~A"
                        (first failure) (second failure) (third failure)))
      (when (null moves)
        (protocol-error "bad_pgn" "There are no moves in that PGN."))
      (cancel-worker g)
      (cancel-review g)
      ;; Replay the game onto the session's own position, recording each move
      ;; exactly as if it had been played here.
      (let ((p (copy-position start))
            (records '()))
        (dolist (m moves)
          (let ((mover (pos-side p)))
            (push (list :move m
                        :san (move-san p m)
                        :uci (move-uci m)
                        :by "human"
                        :captured (if (move-ep-p m)
                                      (* (- mover) +pawn+)
                                      (aref (pos-board p) (move-to m))))
                  records)
            (make-move p m)))
        (setf (game-mode g) "analysis"
              (game-pos g) p
              (game-start-fen g) (pos-to-fen start)
              (game-records g) records
              (game-line g) nil
              (game-status g) "active"
              (game-winner g) nil))
      (incf (game-position-id g))
      (reset-clocks g)
      (update-status g)
      (let ((rid (incf (game-review-id g)))
            (flag (list nil)))
        (setf (game-review-flag g) flag
              (game-review-open g) rid)
        (broadcast "game_loaded"
                   "gameId" rid
                   "tags" (cons :obj (loop for key in '("Event" "Site" "Date" "White" "Black" "Result")
                                           for value = (cdr (assoc key (getf read :tags)
                                                                   :test #'string-equal))
                                           when value collect (cons key value)))
                   "moves" (getf read :sans)
                   "result" (jnull (getf read :result))
                   "error" (if failure
                               (obj "ply" (first failure)
                                    "text" (second failure)
                                    "message" (third failure))
                               :null))
        (broadcast-game-state g)
        (after-state-change g)
        (sb-thread:make-thread
         (lambda (&aux (*game* g))
           (handler-case (run-review rid flag start moves)
             (error (e)
               (format *error-output* "~&[review] ~A~%" e)
               (broadcast "error" "code" "review_failed"
                                  "message" (princ-to-string e)
                                  "inReplyTo" :null))))
         :name "symchess-review")))))

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
                    ((string= type "load_pgn") (cmd-load-pgn g msg))
                    ((string= type "explain_move") (cmd-explain-move g msg))
                    ((string= type "stop_review") (cancel-review g))
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
