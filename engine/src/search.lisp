;;;; search.lisp -- iterative deepening with aspiration windows,
;;;; principal-variation alpha-beta with late move reductions, quiescence,
;;;; static exchange evaluation, transposition table, move ordering, time control.
;;;;
;;;; Nothing in this file calls Prolog. Symbolic knowledge can enter only as
;;;; ROOT-HINTS: a move -> bonus table computed once before the search starts
;;;; and consulted when ordering moves at the root. The game does not pass one
;;;; (measured: it does not help); the benchmark and self-play scripts can.

(in-package :symchess)

(defconstant +inf+ 32000)
(defconstant +mate+ 30000)
(defconstant +mate-bound+ 29000)        ; |score| above this means forced mate
(defconstant +max-search-ply+ 128)

;;; ---------------------------------------------------- transposition table

(defconstant +tt-bits+ 20)
(defconstant +tt-size+ (ash 1 +tt-bits+))
(defconstant +tt-exact+ 1)
(defconstant +tt-lower+ 2)
(defconstant +tt-upper+ 3)

(sb-ext:define-load-time-global **tt-keys**
    (make-array +tt-size+ :element-type 'hash-key :initial-element 0))
(sb-ext:define-load-time-global **tt-moves**
    (make-array +tt-size+ :element-type 'fixnum :initial-element 0))
;; info = (score + 32768) | depth << 16 | flag << 24
(sb-ext:define-load-time-global **tt-info**
    (make-array +tt-size+ :element-type 'fixnum :initial-element 0))
(declaim (type (simple-array hash-key (*)) **tt-keys**)
         (type (simple-array fixnum (*)) **tt-moves** **tt-info**))

(defun tt-clear ()
  (fill **tt-keys** 0)
  (fill **tt-moves** 0)
  (fill **tt-info** 0)
  nil)

(declaim (inline tt-index))
(defun tt-index (key) (logand key (1- +tt-size+)))

(defun tt-store (key move score depth flag)
  (declare (type hash-key key) (type fixnum move score depth flag))
  (let ((i (tt-index key)))
    (setf (aref **tt-keys** i) key
          (aref **tt-moves** i) move
          (aref **tt-info** i) (logior (+ score 32768)
                                       (ash (max 0 (min depth 255)) 16)
                                       (ash flag 24)))))

(defun tt-probe (key)
  "Returns (values hit move score depth flag)."
  (declare (type hash-key key))
  (let ((i (tt-index key)))
    (if (and (= (aref **tt-keys** i) key) (/= (aref **tt-info** i) 0))
        (let ((info (aref **tt-info** i)))
          (values t
                  (aref **tt-moves** i)
                  (- (logand info #xFFFF) 32768)
                  (logand (ash info -16) #xFF)
                  (logand (ash info -24) 3)))
        (values nil 0 0 0 0))))

;; Mate scores are stored relative to the node, not the root.
(declaim (inline score-to-tt score-from-tt))
(defun score-to-tt (score ply)
  (cond ((> score +mate-bound+) (+ score ply))
        ((< score (- +mate-bound+)) (- score ply))
        (t score)))
(defun score-from-tt (score ply)
  (cond ((> score +mate-bound+) (- score ply))
        ((< score (- +mate-bound+)) (+ score ply))
        (t score)))

;;; ----------------------------------------------------------- search state

(defun now-ms ()
  (floor (* 1000 (get-internal-real-time)) internal-time-units-per-second))

(defstruct sctx
  (nodes 0 :type fixnum)
  (abort nil)
  (stop-fn nil)                         ; () -> true when the search must stop
  (deadline 0 :type fixnum)             ; NOW-MS value, or 0 for no time limit
  (killers (make-array (* 2 +max-search-ply+) :element-type 'fixnum :initial-element 0)
   :type (simple-array fixnum (*)))
  (history (make-array (* 2 128 128) :element-type 'fixnum :initial-element 0)
   :type (simple-array fixnum (*)))
  (pv (make-array (* +max-search-ply+ +max-search-ply+) :element-type 'fixnum
                                                         :initial-element 0)
   :type (simple-array fixnum (*)))
  (pv-len (make-array +max-search-ply+ :element-type 'fixnum :initial-element 0)
   :type (simple-array fixnum (*)))
  (move-lists (let ((v (make-array +max-search-ply+)))
                (dotimes (i +max-search-ply+ v) (setf (svref v i) (make-move-array))))
   :type simple-vector)
  (score-lists (let ((v (make-array +max-search-ply+)))
                 (dotimes (i +max-search-ply+ v) (setf (svref v i) (make-move-array))))
   :type simple-vector)
  (root-hints nil))                     ; hash-table: move -> ordering bonus, or NIL

(defstruct search-result
  best-move score depth nodes time-ms pv)

(declaim (inline check-limits))
(defun check-limits (ctx)
  (declare (type sctx ctx))
  (when (zerop (logand (sctx-nodes ctx) 2047))
    (when (or (and (plusp (sctx-deadline ctx)) (> (now-ms) (sctx-deadline ctx)))
              (and (sctx-stop-fn ctx) (funcall (sctx-stop-fn ctx))))
      (setf (sctx-abort ctx) t))))

;;; ------------------------------------------------ static exchange evaluation
;;; "If I take here and we both keep recapturing with our cheapest piece, who
;;; comes out ahead?" Answered on the board alone, without searching.

(sb-ext:define-load-time-global **see-value**
    (make-array 7 :element-type 'fixnum :initial-contents '(0 100 320 330 500 900 20000)))
(declaim (type (simple-array fixnum (7)) **see-value**))

(defun least-attacker (b sq side)
  "Square of SIDE's least valuable piece attacking SQ on board B, or -1.
Pieces already lifted off B are seen through, which is what finds x-rays."
  (declare (type board-array b) (type fixnum sq side))
  (let ((pawn (* side +pawn+)))
    (dolist (d '(15 17))
      (let ((from (- sq (* side (the fixnum d)))))
        (when (and (>= from 0) (on-board-p from) (= (aref b from) pawn))
          (return-from least-attacker from)))))
  (let ((knight (* side +knight+)))
    (dotimes (i 8)
      (let ((from (+ sq (aref **knight-offsets** i))))
        (when (and (>= from 0) (on-board-p from) (= (aref b from) knight))
          (return-from least-attacker from)))))
  (let ((bishop (* side +bishop+)) (rook (* side +rook+)) (queen (* side +queen+))
        (rook-sq -1) (queen-sq -1))
    (declare (type fixnum rook-sq queen-sq))
    (dotimes (i 4)
      (let ((d (aref **bishop-offsets** i)))
        (loop for from fixnum = (+ sq d) then (+ from d)
              while (and (>= from 0) (on-board-p from))
              do (let ((pc (aref b from)))
                   (when (/= pc 0)
                     (cond ((= pc bishop) (return-from least-attacker from))
                           ((= pc queen) (setf queen-sq from)))
                     (return))))))
    (dotimes (i 4)
      (let ((d (aref **rook-offsets** i)))
        (loop for from fixnum = (+ sq d) then (+ from d)
              while (and (>= from 0) (on-board-p from))
              do (let ((pc (aref b from)))
                   (when (/= pc 0)
                     (cond ((= pc rook) (setf rook-sq from))
                           ((= pc queen) (setf queen-sq from)))
                     (return))))))
    (when (>= rook-sq 0) (return-from least-attacker rook-sq))
    (when (>= queen-sq 0) (return-from least-attacker queen-sq)))
  (let ((king (* side +king+)))
    (dotimes (i 8)
      (let ((from (+ sq (aref **king-offsets** i))))
        (when (and (>= from 0) (on-board-p from) (= (aref b from) king))
          (return-from least-attacker from)))))
  -1)

(defun see (p m)
  "Static exchange evaluation of move M: the material, in centipawns, its mover
ends up winning (negative: losing) once every profitable recapture is made."
  (declare (type pos p) (type fixnum m))
  (let* ((b (pos-board p))
         (from (move-from m))
         (to (move-to m))
         (side (pos-side p))
         (promo (move-promo m))
         (gain (make-array 34 :element-type 'fixnum :initial-element 0))
         (squares (make-array 34 :element-type 'fixnum :initial-element 0))
         (pieces (make-array 34 :element-type 'fixnum :initial-element 0))
         (lifted 0)
         (d 0)
         ;; the piece now standing on TO, which the next capture would win
         (standing (if (plusp promo) promo (abs (aref b from)))))
    (declare (type fixnum from to side promo lifted d standing)
             (dynamic-extent gain squares pieces))
    (flet ((lift (sq)
             (setf (aref squares lifted) sq
                   (aref pieces lifted) (aref b sq)
                   (aref b sq) 0)
             (incf lifted)))
      (setf (aref gain 0)
            (+ (if (move-ep-p m) 100 (aref **see-value** (abs (aref b to))))
               (if (plusp promo) (- (aref **see-value** promo) 100) 0)))
      (when (move-ep-p m) (lift (- to (* 16 side))))
      (lift from)
      (setf side (- side))
      (loop
        (let ((sq (least-attacker b to side)))
          (declare (type fixnum sq))
          (when (or (< sq 0) (>= d 31)) (return))
          (incf d)
          (setf (aref gain d) (- (aref **see-value** standing) (aref gain (1- d)))
                standing (abs (aref b sq)))
          (lift sq)
          (setf side (- side))))
      ;; Walk back: at each step the side to move may decline to recapture.
      (loop while (plusp d)
            do (setf (aref gain (1- d)) (- (max (- (aref gain (1- d))) (aref gain d))))
               (decf d))
      (dotimes (i lifted)
        (setf (aref b (aref squares i)) (aref pieces i)))
      (aref gain 0))))

;;; ---------------------------------------------------------- move ordering
;;; Order: hash move, winning and even captures by MVV-LVA, killer moves,
;;; history heuristic, then captures that lose material (negative scores).
;;; At the root only, Prolog's hint bonus is added on top.

(defun score-moves (p ctx moves scores n sp tt-move)
  (declare (type pos p) (type sctx ctx) (type move-array moves scores) (type fixnum n sp tt-move))
  (let* ((b (pos-board p))
         (side-index (if (= (pos-side p) 1) 0 1))
         (killers (sctx-killers ctx))
         (history (sctx-history ctx))
         (k1 (aref killers (* 2 sp)))
         (k2 (aref killers (1+ (* 2 sp))))
         (hints (and (zerop sp) (sctx-root-hints ctx))))
    (dotimes (i n)
      (let* ((m (aref moves i))
             (score
               (cond ((= m tt-move) 10000000)
                     ((move-capture-p m)
                      (let* ((victim (if (move-ep-p m) +pawn+ (abs (aref b (move-to m)))))
                             (attacker (abs (aref b (move-from m))))
                             (mvv-lva (+ (* 16 victim) (- attacker)
                                         (if (plusp (move-promo m)) 500 0))))
                        ;; Only a dearer piece taking a cheaper one can lose
                        ;; material, so only those are worth an exchange count.
                        (if (and **use-see** (> attacker victim) (zerop (move-promo m))
                                 (< (the fixnum (see p m)) -50))
                            (- mvv-lva 200000)
                            (+ 1000000 mvv-lva))))
                     ((plusp (move-promo m)) (+ 900000 (move-promo m)))
                     ((= m k1) 800000)
                     ((= m k2) 790000)
                     (t (min 700000
                             (aref history (+ (* side-index 16384)
                                              (* 128 (move-from m))
                                              (move-to m))))))))
        (when (and hints (/= m tt-move))
          ;; Hint scores are roughly centipawns; scale so a strong hint can lift a
          ;; quiet move above ordinary captures, and a warning can sink a capture.
          (incf score (* 2000 (the fixnum (gethash m hints 0)))))
        (setf (aref scores i) score)))))

(declaim (inline pick-best))
(defun pick-best (moves scores i n)
  "Selection sort step: bring the best remaining move to index I."
  (declare (type move-array moves scores) (type fixnum i n))
  (let ((best i))
    (loop for j from (1+ i) below n
          do (when (> (aref scores j) (aref scores best)) (setf best j)))
    (unless (= best i)
      (rotatef (aref moves i) (aref moves best))
      (rotatef (aref scores i) (aref scores best)))))

(defun update-pv (ctx sp m)
  (declare (type sctx ctx) (type fixnum sp m))
  (let* ((pv (sctx-pv ctx))
         (lens (sctx-pv-len ctx))
         (row (* sp +max-search-ply+))
         (child (* (1+ sp) +max-search-ply+))
         (child-len (aref lens (1+ sp))))
    (setf (aref pv row) m)
    (dotimes (i child-len)
      (setf (aref pv (+ row 1 i)) (aref pv (+ child i))))
    (setf (aref lens sp) (1+ child-len))))

;;; ------------------------------------------------------------- quiescence

(defun quiesce (p ctx alpha beta sp)
  "Search captures until the position is quiet, so static eval is not taken
in the middle of an exchange. Captures that lose material are not tried, nor
are captures that could not lift the score to alpha even if they won the
piece for free. Simplification: checks are not extended here."
  (declare (type pos p) (type sctx ctx) (type fixnum alpha beta sp))
  (incf (sctx-nodes ctx))
  (check-limits ctx)
  (setf (aref (sctx-pv-len ctx) sp) 0)
  (when (sctx-abort ctx) (return-from quiesce 0))
  (let ((stand (evaluate p)))
    (declare (type fixnum stand))
    (when (>= sp (- +max-search-ply+ 2)) (return-from quiesce stand))
    (when (>= stand beta) (return-from quiesce stand))
    (when (> stand alpha) (setf alpha stand))
    (let* ((moves (svref (sctx-move-lists ctx) sp))
           (scores (svref (sctx-score-lists ctx) sp))
           (n (generate-moves p moves t)))
      (declare (type move-array moves scores) (type fixnum n))
      (score-moves p ctx moves scores n sp 0)
      (dotimes (i n)
        (pick-best moves scores i n)
        ;; Sorted, so the first losing capture means only losing ones remain.
        (when (minusp (aref scores i)) (return))
        (let ((m (aref moves i)))
          (when (and (not (and **use-delta**
                               (move-capture-p m)
                               (zerop (move-promo m))
                               (< (+ stand 200
                                     (aref **see-value**
                                           (if (move-ep-p m)
                                               +pawn+
                                               (abs (aref (pos-board p) (move-to m))))))
                                  alpha)))
                     (make-move p m))
            (let ((score (- (the fixnum (quiesce p ctx (- beta) (- alpha) (1+ sp))))))
              (declare (type fixnum score))
              (unmake-move p)
              (when (sctx-abort ctx) (return-from quiesce 0))
              (when (> score alpha)
                (setf alpha score)
                (when (>= alpha beta) (return-from quiesce alpha)))))))
      alpha)))

;;; --------------------------------------------------------------- negamax

(defun negamax (p ctx depth alpha beta sp allow-null)
  (declare (type pos p) (type sctx ctx) (type fixnum depth alpha beta sp))
  (setf (aref (sctx-pv-len ctx) sp) 0)
  (when (and (plusp sp)
             (or (>= (pos-halfmove p) 100) (plusp (repetition-count p))))
    (return-from negamax 0))
  (when (>= sp (- +max-search-ply+ 2)) (return-from negamax (evaluate p)))
  (let ((in-check (in-check-p p))
        (pv-node (> (- beta alpha) 1)))
    (when in-check (incf depth))        ; check extension
    (when (<= depth 0) (return-from negamax (quiesce p ctx alpha beta sp)))
    (incf (sctx-nodes ctx))
    (check-limits ctx)
    (when (sctx-abort ctx) (return-from negamax 0))
    (multiple-value-bind (hit tt-move tt-score tt-depth tt-flag) (tt-probe (pos-hash p))
      (declare (type fixnum tt-move tt-score tt-depth tt-flag))
      ;; Hash cutoffs only away from the PV, so the reported line stays complete.
      (when (and hit (not pv-node) (plusp sp) (>= tt-depth depth))
        (let ((s (score-from-tt tt-score sp)))
          (cond ((= tt-flag +tt-exact+) (return-from negamax s))
                ((and (= tt-flag +tt-lower+) (>= s beta)) (return-from negamax s))
                ((and (= tt-flag +tt-upper+) (<= s alpha)) (return-from negamax s)))))
      ;; Null-move pruning: if passing still fails high, this node is too good.
      (when (and allow-null (not pv-node) (not in-check) (>= depth 3) (plusp sp)
                 (has-non-pawn-material-p p (pos-side p))
                 (>= (the fixnum (evaluate p)) beta))
        (make-null-move p)
        (let ((s (- (the fixnum (negamax p ctx (- depth 3) (- beta) (- 1 beta) (1+ sp) nil)))))
          (unmake-null-move p)
          (when (sctx-abort ctx) (return-from negamax 0))
          (when (and (>= s beta) (< s +mate-bound+)) (return-from negamax beta))))
      (let* ((moves (svref (sctx-move-lists ctx) sp))
             (scores (svref (sctx-score-lists ctx) sp))
             (n (generate-moves p moves))
             (best-score (- +inf+))
             (best-move 0)
             (legal 0)
             (original-alpha alpha)
             (k1 (aref (sctx-killers ctx) (* 2 sp)))
             (k2 (aref (sctx-killers ctx) (1+ (* 2 sp)))))
        (declare (type move-array moves scores)
                 (type fixnum n best-score best-move legal k1 k2))
        (score-moves p ctx moves scores n sp tt-move)
        (dotimes (i n)
          (pick-best moves scores i n)
          (let ((m (aref moves i)))
            (when (make-move p m)
              (incf legal)
              (let* (;; Late move reduction: with good ordering, a quiet move
                     ;; tried this late is rarely best, so look at it less
                     ;; deeply first and only search it properly if it surprises.
                     (reduction
                       (if (and **use-lmr** (>= depth 3) (> legal 3) (not in-check)
                                (not (move-capture-p m)) (zerop (move-promo m))
                                (/= m k1) (/= m k2)
                                (not (in-check-p p))) ; the move just made gives check
                           (if (and (>= depth 6) (> legal 8)) 2 1)
                           0))
                     (score
                       (if (= legal 1)
                           (- (the fixnum (negamax p ctx (1- depth) (- beta) (- alpha) (1+ sp) t)))
                           ;; PVS: prove later moves are worse with a null window
                           (let ((s (- (the fixnum (negamax p ctx (- depth 1 reduction)
                                                            (- (1+ alpha)) (- alpha) (1+ sp) t)))))
                             (declare (type fixnum s))
                             (when (and (plusp reduction) (> s alpha))
                               (setf s (- (the fixnum (negamax p ctx (1- depth) (- (1+ alpha))
                                                               (- alpha) (1+ sp) t)))))
                             (if (and (> s alpha) (< s beta))
                                 (- (the fixnum (negamax p ctx (1- depth) (- beta) (- alpha)
                                                         (1+ sp) t)))
                                 s)))))
                (declare (type fixnum reduction score))
                (unmake-move p)
                (when (sctx-abort ctx) (return-from negamax 0))
                (when (> score best-score)
                  (setf best-score score
                        best-move m)
                  (when (> score alpha)
                    (setf alpha score)
                    (update-pv ctx sp m)
                    (when (>= alpha beta)
                      (unless (move-capture-p m)
                        (let ((killers (sctx-killers ctx)))
                          (unless (= (aref killers (* 2 sp)) m)
                            (setf (aref killers (1+ (* 2 sp))) (aref killers (* 2 sp))
                                  (aref killers (* 2 sp)) m)))
                        (incf (aref (sctx-history ctx)
                                    (+ (* (if (= (pos-side p) 1) 0 1) 16384)
                                       (* 128 (move-from m))
                                       (move-to m)))
                              (* depth depth)))
                      (return))))))))
        (when (zerop legal)
          (return-from negamax (if in-check (+ (- +mate+) sp) 0)))
        (tt-store (pos-hash p) best-move (score-to-tt best-score sp) depth
                  (cond ((>= best-score beta) +tt-lower+)
                        ((> best-score original-alpha) +tt-exact+)
                        (t +tt-upper+)))
        best-score))))

;;; ---------------------------------------------------- iterative deepening

(defun root-search (p ctx depth previous)
  "One iteration from the root. From depth 4 on it first tries a narrow window
around the PREVIOUS iteration's score, widening it whenever the score falls
outside: most iterations confirm the last score and finish sooner."
  (declare (type pos p) (type sctx ctx) (type fixnum depth previous))
  (if (or (not **use-aspiration**) (< depth 4) (> (abs previous) +mate-bound+))
      (negamax p ctx depth (- +inf+) +inf+ 0 nil)
      (let* ((delta 40)
             (alpha (- previous delta))
             (beta (+ previous delta)))
        (declare (type fixnum delta alpha beta))
        (loop
          (let ((score (negamax p ctx depth alpha beta 0 nil)))
            (declare (type fixnum score))
            (cond ((sctx-abort ctx) (return score))
                  ((<= score alpha)
                   (setf delta (* delta 3)
                         alpha (if (> delta 700) (- +inf+) (- previous delta))))
                  ((>= score beta)
                   (setf delta (* delta 3)
                         beta (if (> delta 700) +inf+ (+ previous delta))))
                  (t (return score))))))))

(defun search-position (p &key (max-depth 6) time-ms stop-fn on-iteration hints)
  "Search a COPY of P. ON-ITERATION, if given, is called with a SEARCH-RESULT
after every completed depth. HINTS is an optional hash-table move -> bonus.
Returns the result of the last fully completed iteration."
  (let* ((p (copy-position p))
         (start (now-ms))
         (ctx (make-sctx :stop-fn stop-fn
                         :deadline (if time-ms (+ start time-ms) 0)
                         :root-hints hints))
         (legal (legal-moves p))
         (result (make-search-result :best-move (first legal) :score 0 :depth 0
                                     :nodes 0 :time-ms 0
                                     :pv (and legal (list (first legal))))))
    (when (null legal) (return-from search-position result))
    (loop for depth from 1 to (min max-depth 60)
          do (let ((score (root-search p ctx depth (search-result-score result))))
               ;; An aborted iteration returns garbage: keep the previous result.
               ;; Depth 1 is cheap enough that it is always allowed to finish.
               (when (and (sctx-abort ctx) (> depth 1)) (return))
               (let ((len (aref (sctx-pv-len ctx) 0)))
                 (when (plusp len)
                   (setf result
                         (make-search-result
                          :best-move (aref (sctx-pv ctx) 0)
                          :score score
                          :depth depth
                          :nodes (sctx-nodes ctx)
                          :time-ms (- (now-ms) start)
                          :pv (loop for i below len collect (aref (sctx-pv ctx) i))))
                   (when on-iteration (funcall on-iteration result))))
               (when (sctx-abort ctx) (return))
               (when (> (abs score) +mate-bound+) (return))
               ;; Do not start an iteration that is unlikely to finish.
               (when (and time-ms (> (- (now-ms) start) (floor time-ms 2))) (return))))
    (setf (search-result-nodes result) (sctx-nodes ctx)
          (search-result-time-ms result) (- (now-ms) start))
    result))

(defun root-move-scores (p depth)
  "Every legal move of P with the score a DEPTH-ply search gives it, from the
mover's point of view, best first. Each move gets a full window, so the scores
are exact and comparable, which the ordinary search's scores for non-best
moves are not."
  (let ((p (copy-position p))
        (ctx (make-sctx))
        (scored '()))
    (dolist (m (legal-moves p))
      (make-move p m)
      (push (cons m (- (the fixnum (negamax p ctx (1- depth) (- +inf+) +inf+ 1 t)))) scored)
      (unmake-move p))
    (stable-sort (nreverse scored) #'> :key #'cdr)))

(defun search-line (p move depth)
  "A SEARCH-RESULT describing MOVE as if it had been the choice: its score and
the line expected to follow it, from a search of the position it leads to."
  (let ((child (copy-position p)))
    (make-move child move)
    (let ((r (search-position child :max-depth (max 1 (1- depth)))))
      (make-search-result :best-move move
                          :score (- (search-result-score r))
                          :depth (1+ (search-result-depth r))
                          :nodes (search-result-nodes r)
                          :time-ms (search-result-time-ms r)
                          :pv (cons move (search-result-pv r))))))
