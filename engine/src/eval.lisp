;;;; eval.lisp -- fast numeric evaluation (hot path, pure Lisp).
;;;;
;;;; Terms: material, piece-square tables (tapered king table), pawn structure
;;;; (doubled / isolated / passed), the bishop pair, piece activity (mobility,
;;;; rooks on open files) and king shelter. Every term is reported separately
;;;; by EVAL-BREAKDOWN so the UI can show exactly what the search saw.

(in-package :symchess)

(sb-ext:define-load-time-global **piece-value**
    (make-array 7 :element-type 'fixnum :initial-contents '(0 100 320 330 500 900 0)))
(declaim (type (simple-array fixnum (7)) **piece-value**))

;; Tables are written from White's point of view with rank 8 on the first row
;; (Tomasz Michniewski's "simplified evaluation function" values).
(defun pst (&rest rows)
  (make-array 64 :element-type 'fixnum :initial-contents (apply #'append rows)))

(sb-ext:define-load-time-global **pst**
    (vector
     nil
     (pst '(  0   0   0   0   0   0   0   0)
          '( 50  50  50  50  50  50  50  50)
          '( 10  10  20  30  30  20  10  10)
          '(  5   5  10  25  25  10   5   5)
          '(  0   0   0  20  20   0   0   0)
          '(  5  -5 -10   0   0 -10  -5   5)
          '(  5  10  10 -20 -20  10  10   5)
          '(  0   0   0   0   0   0   0   0))
     (pst '(-50 -40 -30 -30 -30 -30 -40 -50)
          '(-40 -20   0   0   0   0 -20 -40)
          '(-30   0  10  15  15  10   0 -30)
          '(-30   5  15  20  20  15   5 -30)
          '(-30   0  15  20  20  15   0 -30)
          '(-30   5  10  15  15  10   5 -30)
          '(-40 -20   0   5   5   0 -20 -40)
          '(-50 -40 -30 -30 -30 -30 -40 -50))
     (pst '(-20 -10 -10 -10 -10 -10 -10 -20)
          '(-10   0   0   0   0   0   0 -10)
          '(-10   0   5  10  10   5   0 -10)
          '(-10   5   5  10  10   5   5 -10)
          '(-10   0  10  10  10  10   0 -10)
          '(-10  10  10  10  10  10  10 -10)
          '(-10   5   0   0   0   0   5 -10)
          '(-20 -10 -10 -10 -10 -10 -10 -20))
     (pst '(  0   0   0   0   0   0   0   0)
          '(  5  10  10  10  10  10  10   5)
          '( -5   0   0   0   0   0   0  -5)
          '( -5   0   0   0   0   0   0  -5)
          '( -5   0   0   0   0   0   0  -5)
          '( -5   0   0   0   0   0   0  -5)
          '( -5   0   0   0   0   0   0  -5)
          '(  0   0   0   5   5   0   0   0))
     (pst '(-20 -10 -10  -5  -5 -10 -10 -20)
          '(-10   0   0   0   0   0   0 -10)
          '(-10   0   5   5   5   5   0 -10)
          '( -5   0   5   5   5   5   0  -5)
          '(  0   0   5   5   5   5   0  -5)
          '(-10   5   5   5   5   5   0 -10)
          '(-10   0   5   0   0   0   0 -10)
          '(-20 -10 -10  -5  -5 -10 -10 -20))
     ;; king, middlegame
     (pst '(-30 -40 -40 -50 -50 -40 -40 -30)
          '(-30 -40 -40 -50 -50 -40 -40 -30)
          '(-30 -40 -40 -50 -50 -40 -40 -30)
          '(-30 -40 -40 -50 -50 -40 -40 -30)
          '(-20 -30 -30 -40 -40 -30 -30 -20)
          '(-10 -20 -20 -20 -20 -20 -20 -10)
          '( 20  20   0   0   0   0  20  20)
          '( 20  30  10   0   0  10  30  20))))

(sb-ext:define-load-time-global **king-endgame-pst**
    (pst '(-50 -40 -30 -20 -20 -30 -40 -50)
         '(-30 -20 -10   0   0 -10 -20 -30)
         '(-30 -10  20  30  30  20 -10 -30)
         '(-30 -10  30  40  40  30 -10 -30)
         '(-30 -10  30  40  40  30 -10 -30)
         '(-30 -10  20  30  30  20 -10 -30)
         '(-30 -30   0   0   0   0 -30 -30)
         '(-50 -30 -30 -30 -30 -30 -30 -50)))
(declaim (type simple-vector **pst**)
         (type (simple-array fixnum (64)) **king-endgame-pst**))

(sb-ext:define-load-time-global **passed-bonus**
    (make-array 8 :element-type 'fixnum :initial-contents '(0 5 10 20 35 60 100 0)))
(sb-ext:define-load-time-global **phase-weight**
    (make-array 7 :element-type 'fixnum :initial-contents '(0 0 1 1 2 4 0)))
(declaim (type (simple-array fixnum (*)) **passed-bonus** **phase-weight**))

(defconstant +doubled-penalty+ 10)
(defconstant +isolated-penalty+ 12)
(defconstant +bishop-pair-bonus+ 30)

;;; ------------------------------------------------------- feature switches
;;; Every improvement over the first engine can be turned off. One build can
;;; then play itself, old against new (tests/selfplay.lisp), which is how each
;;; change has to earn its place.

(sb-ext:define-load-time-global **eval-activity** t) ; mobility, rook files, king shelter
(sb-ext:define-load-time-global **use-see** t)       ; static exchange evaluation
(sb-ext:define-load-time-global **use-lmr** t)       ; late move reductions
(sb-ext:define-load-time-global **use-aspiration** t) ; aspiration windows at the root
(sb-ext:define-load-time-global **use-delta** t)     ; delta pruning in quiescence
(sb-ext:define-load-time-global **use-futility** t)  ; give up on shallow nodes that are far ahead
(sb-ext:define-load-time-global **use-qchecks** t)   ; answer checks properly in quiescence
(sb-ext:define-load-time-global **use-nullr** t)     ; a deeper null-move reduction at depth

(defun set-engine-features (&key (activity t) (see t) (lmr t) (aspiration t) (delta t)
                                 (futility t) (qchecks t) (nullr t))
  "Switch the optional evaluation and search features. With no arguments, all on."
  (setf **eval-activity** activity
        **use-see** see
        **use-lmr** lmr
        **use-aspiration** aspiration
        **use-delta** delta
        **use-futility** futility
        **use-qchecks** qchecks
        **use-nullr** nullr)
  nil)

;;; ------------------------------------------------- activity and king shelter

(defconstant +rook-open-file+ 20)
(defconstant +rook-semi-open-file+ 10)
(defconstant +shelter-near+ 12)         ; a friendly pawn right in front of the king
(defconstant +shelter-far+ 6)           ; the same pawn one step further up
(defconstant +king-open-file+ 18)       ; no friendly pawn on a file beside the king

(declaim (inline slider-reach))
(defun slider-reach (b sq offsets side)
  "How many squares a sliding piece of SIDE on SQ can move to along OFFSETS."
  (declare (type board-array b) (type fixnum sq side)
           (type (simple-array fixnum (*)) offsets))
  (let ((n 0))
    (declare (type fixnum n))
    (dotimes (i 4 n)
      (let ((d (aref offsets i)))
        (loop for to fixnum = (+ sq d) then (+ to d)
              while (and (>= to 0) (on-board-p to))
              do (let ((pc (aref b to)))
                   (cond ((zerop pc) (incf n))
                         (t (when (/= (signum pc) side) (incf n))
                            (return)))))))))

(defun knight-reach (b sq side)
  (declare (type board-array b) (type fixnum sq side))
  (let ((n 0))
    (declare (type fixnum n))
    (dotimes (i 8 n)
      (let ((to (+ sq (aref **knight-offsets** i))))
        (when (and (>= to 0) (on-board-p to))
          (let ((pc (aref b to)))
            (when (or (zerop pc) (/= (signum pc) side)) (incf n))))))))

(defun king-shelter (b ksq side own-count)
  "Pawn cover for SIDE's king on KSQ, in centipawns. OWN-COUNT holds that side's
pawns per file, offset by one."
  (declare (type board-array b) (type fixnum ksq side)
           (type (simple-array fixnum (10)) own-count))
  (let ((file (sq-file ksq)) (rank (sq-rank ksq)) (score 0) (pawn (* side +pawn+)))
    (declare (type fixnum file rank score pawn))
    (loop for f fixnum from (max 0 (1- file)) to (min 7 (1+ file))
          do (if (zerop (aref own-count (1+ f)))
                 (decf score +king-open-file+)
                 (let ((r1 (+ rank side)) (r2 (+ rank side side)))
                   (cond ((and (<= 0 r1 7) (= (aref b (make-sq f r1)) pawn))
                          (incf score +shelter-near+))
                         ((and (<= 0 r2 7) (= (aref b (make-sq f r2)) pawn))
                          (incf score +shelter-far+))))))
    score))

(defun eval-terms (p)
  "Returns (values material placement pawns bishop-pair activity king-safety),
all from White's side."
  (declare (type pos p))
  (let ((b (pos-board p))
        (material 0) (placement 0) (phase 0)
        (wk-mg 0) (wk-eg 0) (bk-mg 0) (bk-eg 0)
        (wbishops 0) (bbishops 0)
        (activity 0) (shelter 0)
        (active **eval-activity**)
        ;; per file, offset by one so file-1 / file+1 never go out of range
        (wcount (make-array 10 :element-type 'fixnum :initial-element 0))
        (bcount (make-array 10 :element-type 'fixnum :initial-element 0))
        (wmin (make-array 10 :element-type 'fixnum :initial-element 8)) ; rearmost white pawn
        (bmax (make-array 10 :element-type 'fixnum :initial-element -1))) ; rearmost black pawn
    (declare (type fixnum material placement phase wk-mg wk-eg bk-mg bk-eg wbishops bbishops
                   activity shelter)
             (dynamic-extent wcount bcount wmin bmax))
    (dotimes (rank 8)
      (dotimes (file 8)
        (let ((piece (aref b (make-sq file rank))))
          (unless (zerop piece)
            (let* ((kind (abs piece))
                   (white (plusp piece))
                   ;; White reads the table top-down from rank 8; Black is mirrored.
                   (idx (if white (+ (* (- 7 rank) 8) file) (+ (* rank 8) file))))
              (incf phase (aref **phase-weight** kind))
              (cond ((= kind +king+)
                     (let ((mg (aref (the (simple-array fixnum (64)) (svref **pst** +king+)) idx))
                           (eg (aref **king-endgame-pst** idx)))
                       (if white
                           (setf wk-mg mg wk-eg eg)
                           (setf bk-mg mg bk-eg eg))))
                    (t
                     (let ((value (aref **piece-value** kind))
                           (square (aref (the (simple-array fixnum (64)) (svref **pst** kind))
                                         idx)))
                       (if white
                           (progn (incf material value) (incf placement square))
                           (progn (decf material value) (decf placement square))))
                     (cond ((= kind +bishop+) (if white (incf wbishops) (incf bbishops)))
                           ((= kind +pawn+)
                            (if white
                                (progn (incf (aref wcount (1+ file)))
                                       (setf (aref wmin (1+ file))
                                             (min (aref wmin (1+ file)) rank)))
                                (progn (incf (aref bcount (1+ file)))
                                       (setf (aref bmax (1+ file))
                                             (max (aref bmax (1+ file)) rank)))))))))))))
    ;; Tapered king placement: middlegame table fades into the endgame table.
    (let ((ph (min phase 24)))
      (incf placement (truncate (+ (* (- wk-mg bk-mg) ph) (* (- wk-eg bk-eg) (- 24 ph))) 24)))
    ;; Pawn structure.
    (let ((pawns 0))
      (declare (type fixnum pawns))
      (loop for f from 1 to 8
            do (let ((w (aref wcount f)) (bl (aref bcount f)))
                 (when (> w 1) (decf pawns (* +doubled-penalty+ (1- w))))
                 (when (> bl 1) (incf pawns (* +doubled-penalty+ (1- bl))))
                 (when (and (> w 0) (zerop (aref wcount (1- f))) (zerop (aref wcount (1+ f))))
                   (decf pawns (* +isolated-penalty+ w)))
                 (when (and (> bl 0) (zerop (aref bcount (1- f))) (zerop (aref bcount (1+ f))))
                   (incf pawns (* +isolated-penalty+ bl)))))
      ;; Passed pawns need each pawn's own rank, so scan pawns once more.
      (dotimes (rank 8)
        (dotimes (file 8)
          (let ((piece (aref b (make-sq file rank))) (f (1+ file)))
            (cond ((= piece +pawn+)
                   ;; no black pawn ahead on this or the adjacent files
                   (when (and (<= (aref bmax (1- f)) rank)
                              (<= (aref bmax f) rank)
                              (<= (aref bmax (1+ f)) rank))
                     (incf pawns (aref **passed-bonus** rank))))
                  ((= piece (- +pawn+))
                   (when (and (>= (aref wmin (1- f)) rank)
                              (>= (aref wmin f) rank)
                              (>= (aref wmin (1+ f)) rank))
                     (decf pawns (aref **passed-bonus** (- 7 rank)))))
                  ;; Activity: how many squares each piece reaches, and rooks on
                  ;; files their own pawns have left.
                  ((and active (/= piece 0))
                   (let ((kind (abs piece))
                         (side (signum piece))
                         (sq (make-sq file rank))
                         (gain 0))
                     (declare (type fixnum kind side sq gain))
                     (cond ((= kind +knight+)
                            (setf gain (* 4 (the fixnum (knight-reach b sq side)))))
                           ((= kind +bishop+)
                            (setf gain (* 4 (slider-reach b sq **bishop-offsets** side))))
                           ((= kind +rook+)
                            (setf gain (* 2 (slider-reach b sq **rook-offsets** side)))
                            (let ((own (if (= side 1) (aref wcount f) (aref bcount f)))
                                  (theirs (if (= side 1) (aref bcount f) (aref wcount f))))
                              (when (zerop own)
                                (incf gain (if (zerop theirs)
                                               +rook-open-file+
                                               +rook-semi-open-file+)))))
                           ((= kind +queen+)
                            (setf gain (+ (slider-reach b sq **rook-offsets** side)
                                          (slider-reach b sq **bishop-offsets** side)))))
                     (incf activity (* side gain))))))))
      ;; King shelter matters while the heavy pieces are on; it fades with them.
      (when (and active (>= (pos-wking p) 0) (>= (pos-bking p) 0))
        (setf shelter
              (truncate (* (min phase 24)
                           (- (the fixnum (king-shelter b (pos-wking p) 1 wcount))
                              (the fixnum (king-shelter b (pos-bking p) -1 bcount))))
                        24)))
      (values material placement pawns
              (- (if (>= wbishops 2) +bishop-pair-bonus+ 0)
                 (if (>= bbishops 2) +bishop-pair-bonus+ 0))
              activity shelter))))

(defun evaluate (p)
  "Static score in centipawns from the side to move's point of view."
  (declare (type pos p))
  (multiple-value-bind (material placement pawns bishops activity shelter) (eval-terms p)
    (declare (type fixnum material placement pawns bishops activity shelter))
    (* (pos-side p) (+ material placement pawns bishops activity shelter))))

(defun eval-breakdown (p)
  "The same terms EVALUATE sums, itemised, from White's point of view."
  (multiple-value-bind (material placement pawns bishops activity shelter) (eval-terms p)
    (obj "material" material
         "placement" placement
         "pawnStructure" pawns
         "bishopPair" bishops
         "activity" activity
         "kingSafety" shelter
         "total" (+ material placement pawns bishops activity shelter))))

(defun material-balance (p)
  "Material only, from White's point of view."
  (values (eval-terms p)))

(defun has-non-pawn-material-p (p side)
  (let ((b (pos-board p)))
    (dotimes (sq 128 nil)
      (when (on-board-p sq)
        (let ((piece (aref b sq)))
          (when (and (/= piece 0) (= (signum piece) side)
                     (< +pawn+ (abs piece) +king+))
            (return t)))))))
