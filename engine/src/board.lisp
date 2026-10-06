;;;; board.lisp -- 0x88 mailbox position, Zobrist hashing, make/unmake, FEN.
;;;;
;;;; Square index = rank*16 + file (a1 = 0, h1 = 7, a8 = 112, h8 = 119).
;;;; A square is on the board iff (logand sq #x88) is zero.
;;;; Pieces are small integers: white positive, black negative.

(in-package :symchess)

(defconstant +pawn+ 1)
(defconstant +knight+ 2)
(defconstant +bishop+ 3)
(defconstant +rook+ 4)
(defconstant +queen+ 5)
(defconstant +king+ 6)

(defconstant +max-ply+ 2048)

(deftype board-array () '(simple-array (signed-byte 8) (128)))
(deftype hash-key () '(unsigned-byte 62))

(defparameter +start-fen+ "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1")

(declaim (inline on-board-p sq-file sq-rank make-sq))
(defun on-board-p (sq) (zerop (logand sq #x88)))
(defun sq-file (sq) (logand sq 7))
(defun sq-rank (sq) (ash sq -4))
(defun make-sq (file rank) (+ (* 16 rank) file))

;;; ------------------------------------------------------------------ moves
;;; A move is a fixnum: from(7) | to(7) | promo(3) | capture | double | ep | castle

(declaim (inline make-move-code move-from move-to move-promo
                 move-capture-p move-double-p move-ep-p move-castle-p))
(defun make-move-code (from to &key (promo 0) capture double ep castle)
  (logior from
          (ash to 7)
          (ash promo 14)
          (if capture (ash 1 17) 0)
          (if double (ash 1 18) 0)
          (if ep (ash 1 19) 0)
          (if castle (ash 1 20) 0)))
(defun move-from (m) (logand m 127))
(defun move-to (m) (logand (ash m -7) 127))
(defun move-promo (m) (logand (ash m -14) 7))
(defun move-capture-p (m) (logbitp 17 m))
(defun move-double-p (m) (logbitp 18 m))
(defun move-ep-p (m) (logbitp 19 m))
(defun move-castle-p (m) (logbitp 20 m))

;;; ---------------------------------------------------------------- zobrist

(defun make-zobrist-table (n state)
  (let ((table (make-array n :element-type 'hash-key :initial-element 0)))
    (dotimes (i n table)
      (setf (aref table i) (random (ash 1 62) state)))))

;; Fixed seed: hashes (and therefore search behaviour) are reproducible.
(sb-ext:define-load-time-global **z-state** (sb-ext:seed-random-state 20261006))
(sb-ext:define-load-time-global **z-piece** (make-zobrist-table (* 13 128) **z-state**))
(sb-ext:define-load-time-global **z-castle** (make-zobrist-table 16 **z-state**))
(sb-ext:define-load-time-global **z-ep** (make-zobrist-table 8 **z-state**))
(sb-ext:define-load-time-global **z-side** (random (ash 1 62) **z-state**))
(declaim (type (simple-array hash-key (*)) **z-piece** **z-castle** **z-ep**)
         (type hash-key **z-side**))

(declaim (inline zkey))
(defun zkey (piece sq)
  (aref **z-piece** (+ (* (+ piece 6) 128) sq)))

;;; Castling rights: 1 = white king side, 2 = white queen side,
;;;                  4 = black king side, 8 = black queen side.
;;; Any move touching these squares clears the matching rights.
(sb-ext:define-load-time-global **castle-mask**
    (let ((mask (make-array 128 :element-type '(unsigned-byte 8) :initial-element 15)))
      (setf (aref mask 0) 13      ; a1
            (aref mask 4) 12      ; e1
            (aref mask 7) 14      ; h1
            (aref mask 112) 7     ; a8
            (aref mask 116) 3     ; e8
            (aref mask 119) 11)   ; h8
      mask))
(declaim (type (simple-array (unsigned-byte 8) (128)) **castle-mask**))

;;; --------------------------------------------------------------- position

(defstruct (pos (:constructor %make-pos) (:copier nil))
  (board (make-array 128 :element-type '(signed-byte 8) :initial-element 0)
   :type board-array)
  (side 1 :type (integer -1 1))
  (castling 0 :type (unsigned-byte 4))
  (ep -1 :type (integer -1 127))
  (halfmove 0 :type fixnum)
  (fullmove 1 :type fixnum)
  (wking -1 :type fixnum)
  (bking -1 :type fixnum)
  (hash 0 :type hash-key)
  ;; Undo stack, indexed by ply. u-hash doubles as the repetition history.
  (ply 0 :type fixnum)
  (u-move (make-array +max-ply+ :element-type 'fixnum :initial-element 0)
   :type (simple-array fixnum (*)))
  (u-captured (make-array +max-ply+ :element-type '(signed-byte 8) :initial-element 0)
   :type (simple-array (signed-byte 8) (*)))
  (u-castling (make-array +max-ply+ :element-type '(unsigned-byte 8) :initial-element 0)
   :type (simple-array (unsigned-byte 8) (*)))
  (u-ep (make-array +max-ply+ :element-type '(signed-byte 16) :initial-element -1)
   :type (simple-array (signed-byte 16) (*)))
  (u-halfmove (make-array +max-ply+ :element-type 'fixnum :initial-element 0)
   :type (simple-array fixnum (*)))
  (u-hash (make-array +max-ply+ :element-type 'hash-key :initial-element 0)
   :type (simple-array hash-key (*))))

(defun copy-position (p)
  "Deep copy, including the undo/repetition history. Search runs on copies."
  (let ((c (%make-pos :side (pos-side p) :castling (pos-castling p) :ep (pos-ep p)
                      :halfmove (pos-halfmove p) :fullmove (pos-fullmove p)
                      :wking (pos-wking p) :bking (pos-bking p)
                      :hash (pos-hash p) :ply (pos-ply p))))
    (replace (pos-board c) (pos-board p))
    (let ((n (pos-ply p)))
      (replace (pos-u-move c) (pos-u-move p) :end2 n)
      (replace (pos-u-captured c) (pos-u-captured p) :end2 n)
      (replace (pos-u-castling c) (pos-u-castling p) :end2 n)
      (replace (pos-u-ep c) (pos-u-ep p) :end2 n)
      (replace (pos-u-halfmove c) (pos-u-halfmove p) :end2 n)
      (replace (pos-u-hash c) (pos-u-hash p) :end2 n))
    c))

(defun compute-hash (p)
  "Hash from scratch. Tests compare this against the incremental hash."
  (let ((h 0) (b (pos-board p)))
    (dotimes (sq 128)
      (when (and (on-board-p sq) (/= (aref b sq) 0))
        (setf h (logxor h (zkey (aref b sq) sq)))))
    (setf h (logxor h (aref **z-castle** (pos-castling p))))
    (when (>= (pos-ep p) 0)
      (setf h (logxor h (aref **z-ep** (sq-file (pos-ep p))))))
    (when (= (pos-side p) -1)
      (setf h (logxor h **z-side**)))
    h))

;;; ---------------------------------------------------------------- attacks

(sb-ext:define-load-time-global **knight-offsets**
    (make-array 8 :element-type 'fixnum :initial-contents '(33 31 18 14 -33 -31 -18 -14)))
(sb-ext:define-load-time-global **king-offsets**
    (make-array 8 :element-type 'fixnum :initial-contents '(16 -16 1 -1 17 15 -17 -15)))
(sb-ext:define-load-time-global **rook-offsets**
    (make-array 4 :element-type 'fixnum :initial-contents '(16 -16 1 -1)))
(sb-ext:define-load-time-global **bishop-offsets**
    (make-array 4 :element-type 'fixnum :initial-contents '(17 15 -17 -15)))
(declaim (type (simple-array fixnum (*))
               **knight-offsets** **king-offsets** **rook-offsets** **bishop-offsets**))

(defun square-attacked-p (p sq by)
  "True if SQ is attacked by any piece of side BY (1 or -1)."
  (declare (type pos p) (type fixnum sq by))
  (let ((b (pos-board p)))
    ;; pawns: a white pawn on s attacks s+15 and s+17
    (let ((pawn (* by +pawn+)))
      (dolist (d '(15 17))
        (let ((from (- sq (* by d))))
          (when (and (on-board-p from) (>= from 0) (= (aref b from) pawn))
            (return-from square-attacked-p t)))))
    (let ((knight (* by +knight+)) (king (* by +king+)))
      (dotimes (i 8)
        (let ((from (+ sq (aref **knight-offsets** i))))
          (when (and (>= from 0) (on-board-p from) (= (aref b from) knight))
            (return-from square-attacked-p t)))
        (let ((from (+ sq (aref **king-offsets** i))))
          (when (and (>= from 0) (on-board-p from) (= (aref b from) king))
            (return-from square-attacked-p t)))))
    (let ((rook (* by +rook+)) (bishop (* by +bishop+)) (queen (* by +queen+)))
      (dotimes (i 4)
        (let ((d (aref **rook-offsets** i)))
          (loop for from = (+ sq d) then (+ from d)
                while (and (>= from 0) (on-board-p from))
                do (let ((pc (aref b from)))
                     (when (/= pc 0)
                       (when (or (= pc rook) (= pc queen))
                         (return-from square-attacked-p t))
                       (return)))))
        (let ((d (aref **bishop-offsets** i)))
          (loop for from = (+ sq d) then (+ from d)
                while (and (>= from 0) (on-board-p from))
                do (let ((pc (aref b from)))
                     (when (/= pc 0)
                       (when (or (= pc bishop) (= pc queen))
                         (return-from square-attacked-p t))
                       (return)))))))
    nil))

(defun king-square (p side)
  (if (= side 1) (pos-wking p) (pos-bking p)))

(defun in-check-p (p)
  (square-attacked-p p (king-square p (pos-side p)) (- (pos-side p))))

;;; ------------------------------------------------------------ make/unmake

(declaim (inline castle-rook-squares))
(defun castle-rook-squares (king-to)
  "Rook from/to squares for a castling move whose king lands on KING-TO."
  (case king-to
    (6 (values 7 5))
    (2 (values 0 3))
    (118 (values 119 117))
    (t (values 112 115))))

(defun unmake-move (p)
  (declare (type pos p))
  (let* ((ply (1- (pos-ply p)))
         (m (aref (pos-u-move p) ply))
         (b (pos-board p))
         (from (move-from m))
         (to (move-to m))
         (side (- (pos-side p)))        ; the side that made the move
         (placed (aref b to))
         (piece (if (zerop (move-promo m)) placed (* side +pawn+))))
    (setf (aref b from) piece
          (aref b to) (aref (pos-u-captured p) ply))
    (cond ((move-ep-p m)
           (setf (aref b (- to (* 16 side))) (* (- side) +pawn+)))
          ((move-castle-p m)
           (multiple-value-bind (rf rt) (castle-rook-squares to)
             (setf (aref b rf) (aref b rt)
                   (aref b rt) 0))))
    (when (= (abs piece) +king+)
      (if (= side 1) (setf (pos-wking p) from) (setf (pos-bking p) from)))
    (when (= side -1) (decf (pos-fullmove p)))
    (setf (pos-side p) side
          (pos-castling p) (aref (pos-u-castling p) ply)
          (pos-ep p) (aref (pos-u-ep p) ply)
          (pos-halfmove p) (aref (pos-u-halfmove p) ply)
          (pos-hash p) (aref (pos-u-hash p) ply)
          (pos-ply p) ply)
    nil))

(defun make-move (p m)
  "Play pseudo-legal move M. Returns T if it was legal; otherwise restores the
position and returns NIL."
  (declare (type pos p) (type fixnum m))
  (let* ((b (pos-board p))
         (from (move-from m))
         (to (move-to m))
         (side (pos-side p))
         (piece (aref b from))
         (ply (pos-ply p))
         (captured (aref b to))
         (h (pos-hash p))
         (old-castling (pos-castling p))
         (old-ep (pos-ep p)))
    (declare (type hash-key h))
    (setf (aref (pos-u-move p) ply) m
          (aref (pos-u-captured p) ply) captured
          (aref (pos-u-castling p) ply) old-castling
          (aref (pos-u-ep p) ply) old-ep
          (aref (pos-u-halfmove p) ply) (pos-halfmove p)
          (aref (pos-u-hash p) ply) h)
    (when (>= old-ep 0)
      (setf h (logxor h (aref **z-ep** (sq-file old-ep)))))
    (setf (pos-ep p) -1)
    (unless (zerop captured)
      (setf h (logxor h (zkey captured to))))
    (setf h (logxor h (zkey piece from)))
    (setf (aref b from) 0)
    (let ((placed (if (zerop (move-promo m)) piece (* side (move-promo m)))))
      (setf (aref b to) placed)
      (setf h (logxor h (zkey placed to))))
    (cond ((move-ep-p m)
           (let ((csq (- to (* 16 side))))
             (setf h (logxor h (zkey (aref b csq) csq)))
             (setf (aref b csq) 0)))
          ((move-castle-p m)
           (multiple-value-bind (rf rt) (castle-rook-squares to)
             (let ((rook (aref b rf)))
               (setf (aref b rf) 0
                     (aref b rt) rook)
               (setf h (logxor h (zkey rook rf) (zkey rook rt))))))
          ((move-double-p m)
           (let ((epsq (- to (* 16 side))))
             (setf (pos-ep p) epsq)
             (setf h (logxor h (aref **z-ep** (sq-file epsq)))))))
    (when (= (abs piece) +king+)
      (if (= side 1) (setf (pos-wking p) to) (setf (pos-bking p) to)))
    (let ((nc (logand old-castling (aref **castle-mask** from) (aref **castle-mask** to))))
      (unless (= nc old-castling)
        (setf h (logxor h (aref **z-castle** old-castling) (aref **z-castle** nc))))
      (setf (pos-castling p) nc))
    (setf (pos-halfmove p)
          (if (or (= (abs piece) +pawn+) (/= captured 0)) 0 (1+ (pos-halfmove p))))
    (when (= side -1) (incf (pos-fullmove p)))
    (setf (pos-side p) (- side))
    (setf h (logxor h **z-side**))
    (setf (pos-hash p) h
          (pos-ply p) (1+ ply))
    (if (square-attacked-p p (king-square p side) (- side))
        (progn (unmake-move p) nil)
        t)))

(defun make-null-move (p)
  "Pass the turn (used by null-move pruning)."
  (declare (type pos p))
  (let ((ply (pos-ply p)) (h (pos-hash p)))
    (declare (type hash-key h))
    (setf (aref (pos-u-move p) ply) 0
          (aref (pos-u-captured p) ply) 0
          (aref (pos-u-castling p) ply) (pos-castling p)
          (aref (pos-u-ep p) ply) (pos-ep p)
          (aref (pos-u-halfmove p) ply) (pos-halfmove p)
          (aref (pos-u-hash p) ply) h)
    (when (>= (pos-ep p) 0)
      (setf h (logxor h (aref **z-ep** (sq-file (pos-ep p))))))
    (setf (pos-ep p) -1
          (pos-side p) (- (pos-side p))
          (pos-hash p) (logxor h **z-side**)
          (pos-ply p) (1+ ply))
    nil))

(defun unmake-null-move (p)
  (declare (type pos p))
  (let ((ply (1- (pos-ply p))))
    (setf (pos-side p) (- (pos-side p))
          (pos-ep p) (aref (pos-u-ep p) ply)
          (pos-hash p) (aref (pos-u-hash p) ply)
          (pos-ply p) ply)
    nil))

(defun repetition-count (p)
  "How many earlier positions in this game/search line equal the current one."
  (declare (type pos p))
  (let ((h (pos-hash p)) (count 0) (ply (pos-ply p)))
    (loop for i from (- ply 2) downto (max 0 (- ply (pos-halfmove p))) by 2
          do (when (= (aref (pos-u-hash p) i) h) (incf count)))
    count))

;;; -------------------------------------------------------------------- FEN

(defun piece-char (piece)
  (let ((ch (char " PNBRQK" (abs piece))))
    (if (minusp piece) (char-downcase ch) ch)))

(defun char-piece (ch)
  (let ((idx (position (char-upcase ch) " PNBRQK")))
    (unless (and idx (> idx 0)) (error "Bad piece character ~C" ch))
    (if (upper-case-p ch) idx (- idx))))

(defun square-name (sq)
  (format nil "~C~D" (code-char (+ 97 (sq-file sq))) (1+ (sq-rank sq))))

(defun parse-square (name)
  (unless (and (= (length name) 2)
               (char<= #\a (char name 0) #\h)
               (char<= #\1 (char name 1) #\8))
    (error "Bad square ~S" name))
  (make-sq (- (char-code (char name 0)) 97) (- (char-code (char name 1)) 49)))

(defun split-spaces (string)
  (loop with start = 0
        for end = (position #\Space string :start start)
        for part = (subseq string start end)
        unless (zerop (length part)) collect part
        while end
        do (setf start (1+ end))))

(defun pos-from-fen (fen)
  (let* ((parts (split-spaces fen))
         (p (%make-pos))
         (b (pos-board p)))
    (unless (>= (length parts) 4) (error "FEN needs at least 4 fields: ~S" fen))
    (let ((rank 7) (file 0))
      (loop for ch across (first parts)
            do (cond ((char= ch #\/) (decf rank) (setf file 0))
                     ((digit-char-p ch) (incf file (digit-char-p ch)))
                     (t (unless (and (<= 0 rank 7) (<= 0 file 7))
                          (error "FEN board overflow: ~S" fen))
                        (let ((piece (char-piece ch)) (sq (make-sq file rank)))
                          (setf (aref b sq) piece)
                          (cond ((= piece +king+) (setf (pos-wking p) sq))
                                ((= piece (- +king+)) (setf (pos-bking p) sq))))
                        (incf file)))))
    (when (or (minusp (pos-wking p)) (minusp (pos-bking p)))
      (error "FEN must contain both kings: ~S" fen))
    (setf (pos-side p) (if (string= (second parts) "b") -1 1))
    (let ((rights 0))
      (loop for ch across (third parts)
            do (case ch (#\K (setf rights (logior rights 1)))
                        (#\Q (setf rights (logior rights 2)))
                        (#\k (setf rights (logior rights 4)))
                        (#\q (setf rights (logior rights 8)))))
      (setf (pos-castling p) rights))
    (setf (pos-ep p) (if (string= (fourth parts) "-") -1 (parse-square (fourth parts))))
    (setf (pos-halfmove p) (if (fifth parts) (parse-integer (fifth parts)) 0)
          (pos-fullmove p) (if (sixth parts) (parse-integer (sixth parts)) 1))
    (setf (pos-hash p) (compute-hash p))
    p))

(defun pos-to-fen (p)
  (let ((b (pos-board p)))
    (with-output-to-string (out)
      (loop for rank from 7 downto 0
            do (let ((empty 0))
                 (dotimes (file 8)
                   (let ((piece (aref b (make-sq file rank))))
                     (if (zerop piece)
                         (incf empty)
                         (progn (when (plusp empty) (format out "~D" empty) (setf empty 0))
                                (write-char (piece-char piece) out)))))
                 (when (plusp empty) (format out "~D" empty))
                 (when (plusp rank) (write-char #\/ out))))
      (format out " ~A " (if (= (pos-side p) 1) "w" "b"))
      (let ((c (pos-castling p)))
        (if (zerop c)
            (write-char #\- out)
            (progn (when (logtest c 1) (write-char #\K out))
                   (when (logtest c 2) (write-char #\Q out))
                   (when (logtest c 4) (write-char #\k out))
                   (when (logtest c 8) (write-char #\q out)))))
      (format out " ~A ~D ~D"
              (if (minusp (pos-ep p)) "-" (square-name (pos-ep p)))
              (pos-halfmove p) (pos-fullmove p)))))
