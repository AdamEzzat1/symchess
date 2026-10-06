;;;; eval.lisp -- fast numeric evaluation (hot path, pure Lisp).
;;;;
;;;; Terms: material, piece-square tables (tapered king table), pawn structure
;;;; (doubled / isolated / passed) and the bishop pair. Every term is reported
;;;; separately by EVAL-BREAKDOWN so the UI can show exactly what the search saw.

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

(defun eval-terms (p)
  "Returns (values material placement pawns bishop-pair), all from White's side."
  (declare (type pos p))
  (let ((b (pos-board p))
        (material 0) (placement 0) (phase 0)
        (wk-mg 0) (wk-eg 0) (bk-mg 0) (bk-eg 0)
        (wbishops 0) (bbishops 0)
        ;; per file, offset by one so file-1 / file+1 never go out of range
        (wcount (make-array 10 :element-type 'fixnum :initial-element 0))
        (bcount (make-array 10 :element-type 'fixnum :initial-element 0))
        (wmin (make-array 10 :element-type 'fixnum :initial-element 8)) ; rearmost white pawn
        (bmax (make-array 10 :element-type 'fixnum :initial-element -1))) ; rearmost black pawn
    (declare (type fixnum material placement phase wk-mg wk-eg bk-mg bk-eg wbishops bbishops)
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
                     (decf pawns (aref **passed-bonus** (- 7 rank)))))))))
      (values material placement pawns
              (- (if (>= wbishops 2) +bishop-pair-bonus+ 0)
                 (if (>= bbishops 2) +bishop-pair-bonus+ 0))))))

(defun evaluate (p)
  "Static score in centipawns from the side to move's point of view."
  (declare (type pos p))
  (multiple-value-bind (material placement pawns bishops) (eval-terms p)
    (declare (type fixnum material placement pawns bishops))
    (* (pos-side p) (+ material placement pawns bishops))))

(defun eval-breakdown (p)
  "The same terms EVALUATE sums, itemised, from White's point of view."
  (multiple-value-bind (material placement pawns bishops) (eval-terms p)
    (obj "material" material
         "placement" placement
         "pawnStructure" pawns
         "bishopPair" bishops
         "total" (+ material placement pawns bishops))))

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
