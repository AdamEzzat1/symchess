;;;; search.lisp -- iterative deepening, principal-variation alpha-beta,
;;;; quiescence, transposition table, move ordering, time control.
;;;;
;;;; Nothing in this file calls Prolog. Symbolic knowledge enters only as
;;;; ROOT-HINTS: a move -> bonus table computed once before the search starts
;;;; and consulted when ordering moves at the root.

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

;;; ---------------------------------------------------------- move ordering
;;; Order: hash move, captures by MVV-LVA, killer moves, history heuristic.
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
                      (let ((victim (if (move-ep-p m) +pawn+ (abs (aref b (move-to m)))))
                            (attacker (abs (aref b (move-from m)))))
                        (+ 1000000 (* 16 victim) (- attacker)
                           (if (plusp (move-promo m)) 500 0))))
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
in the middle of an exchange. Simplification: checks are not extended here."
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
        (let ((m (aref moves i)))
          (when (make-move p m)
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
             (original-alpha alpha))
        (declare (type move-array moves scores) (type fixnum n best-score best-move legal))
        (score-moves p ctx moves scores n sp tt-move)
        (dotimes (i n)
          (pick-best moves scores i n)
          (let ((m (aref moves i)))
            (when (make-move p m)
              (incf legal)
              (let ((score
                      (if (= legal 1)
                          (- (the fixnum (negamax p ctx (1- depth) (- beta) (- alpha) (1+ sp) t)))
                          ;; PVS: prove later moves are worse with a null window
                          (let ((s (- (the fixnum (negamax p ctx (1- depth) (- (1+ alpha))
                                                           (- alpha) (1+ sp) t)))))
                            (if (and (> s alpha) (< s beta))
                                (- (the fixnum (negamax p ctx (1- depth) (- beta) (- alpha)
                                                        (1+ sp) t)))
                                s)))))
                (declare (type fixnum score))
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
          do (let ((score (negamax p ctx depth (- +inf+) +inf+ 0 nil)))
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
