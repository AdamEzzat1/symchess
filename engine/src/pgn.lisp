;;;; pgn.lisp -- reading moves and games written by people.
;;;;
;;;; Nothing here knows how a piece moves. A move in standard notation is
;;;; read as a description (which piece, where to, any hints), and the one
;;;; legal move that fits the description is picked from the move generator's
;;;; own list. If none fits, or more than one, the move is refused.

(in-package :symchess)

(defun san-core (text)
  "TEXT without check marks, annotations or an en passant note, with castling
written with letter O."
  (let* ((s (string-trim " " text))
         (s (if (and (> (length s) 5) (string-equal "e.p." (subseq s (- (length s) 4))))
                (string-trim " " (subseq s 0 (- (length s) 4)))
                s))
         (s (string-right-trim "+#!?" s)))
    (substitute #\O #\0 (if (and (plusp (length s)) (find (char s 0) "0Oo"))
                            (string-upcase s)
                            s))))

(defun parse-san-move (p text)
  "The legal move in P that TEXT describes in standard notation, or NIL if no
legal move fits or the text is ambiguous."
  (let ((s (san-core text))
        (legal (legal-moves p))
        (b (pos-board p)))
    (flet ((castle (file)
             (find-if (lambda (m) (and (move-castle-p m) (= (sq-file (move-to m)) file))) legal)))
      (cond
        ((string= s "O-O") (castle 6))
        ((string= s "O-O-O") (castle 2))
        ((< (length s) 2) nil)
        (t
         (let* ((kind (let ((i (position (char s 0) "PNBRQK")))
                        ;; A leading capital names the piece; otherwise it is a pawn.
                        (if (and i (plusp i)) (1+ i) +pawn+)))
                (body (if (= kind +pawn+) s (subseq s 1)))
                (promo 0))
           ;; Promotion: "e8=Q" or "e8Q".
           (let ((n (length body)))
             (when (and (>= n 3) (find (char body (1- n)) "NBRQ"))
               (setf promo (1+ (position (char body (1- n)) "PNBRQK"))
                     body (string-right-trim "=" (subseq body 0 (1- n))))))
           (let* ((body (remove #\x (remove #\: body)))
                  (n (length body)))
             (when (< n 2) (return-from parse-san-move nil))
             (let* ((to (handler-case (parse-square (subseq body (- n 2)))
                          (error () (return-from parse-san-move nil))))
                    (hints (subseq body 0 (- n 2)))
                    (fits (remove-if-not
                           (lambda (m)
                             (let ((from (move-from m)))
                               (and (not (move-castle-p m))
                                    (= (move-to m) to)
                                    (= (abs (aref b from)) kind)
                                    (= (move-promo m) promo)
                                    (every (lambda (c)
                                             (cond ((char<= #\a c #\h)
                                                    (= (sq-file from) (- (char-code c) 97)))
                                                   ((char<= #\1 c #\8)
                                                    (= (sq-rank from) (- (char-code c) 49)))
                                                   (t nil)))
                                           hints))))
                           legal)))
               (and fits (null (rest fits)) (first fits))))))))))

;;; ------------------------------------------------------------------- PGN

(defparameter *result-tokens* '("1-0" "0-1" "1/2-1/2" "*"))

(defun strip-move-number (token)
  "\"12.e4\" -> \"e4\", \"12...\" -> \"\". Castling written with zeros is left alone."
  (let ((digits (or (position-if-not #'digit-char-p token) (length token))))
    (if (and (plusp digits) (< digits (length token)) (char= (char token digits) #\.))
        (string-left-trim "." (subseq token digits))
        token)))

(defun pgn-tokens (text)
  "Three values from the first game in TEXT: its tags as an alist, the move
texts in order, and the result token (or NIL). Comments, variations and
annotation glyphs are skipped."
  (let ((i 0) (n (length text)) (tags '()) (moves '()) (result nil))
    (flet ((peek () (and (< i n) (char text i)))
           (skip-to (ch) (setf i (let ((at (position ch text :start i))) (if at (1+ at) n)))))
      (loop
        (let ((c (peek)))
          (cond
            ((null c) (return))
            ((member c '(#\Space #\Tab #\Newline #\Return)) (incf i))
            ((char= c #\[)
             ;; A tag pair after the moves have started is the next game.
             (when moves (return))
             (let* ((end (or (position #\] text :start i) n))
                    (inside (subseq text (1+ i) end))
                    (space (position #\Space inside))
                    (open (position #\" inside))
                    (close (and open (position #\" inside :from-end t))))
               (when (and space open close (> close open))
                 (push (cons (subseq inside 0 space) (subseq inside (1+ open) close)) tags))
               (setf i (min n (1+ end)))))
            ((char= c #\{) (skip-to #\}))
            ((char= c #\;) (skip-to #\Newline))
            ((char= c #\()
             ;; Variations nest, and may contain comments.
             (let ((depth 0))
               (loop
                 (let ((ch (peek)))
                   (cond ((null ch) (return))
                         ((char= ch #\{) (skip-to #\}))
                         ((char= ch #\() (incf depth) (incf i))
                         ((char= ch #\)) (decf depth) (incf i) (when (zerop depth) (return)))
                         (t (incf i)))))))
            ((char= c #\)) (incf i))
            ((char= c #\$)
             (incf i)
             (loop while (and (peek) (digit-char-p (peek))) do (incf i)))
            (t
             (let* ((end (or (position-if
                              (lambda (ch)
                                (member ch '(#\Space #\Tab #\Newline #\Return #\{ #\( #\; #\))))
                              text :start i)
                             n))
                    (token (subseq text i end)))
               (setf i end)
               (cond ((member token *result-tokens* :test #'string=)
                      (setf result token)
                      (return))
                     (t
                      (let ((move (strip-move-number token)))
                        (when (and (plusp (length move))
                                   (string/= move "e.p.")
                                   (notevery (lambda (ch) (find ch "!?")) move))
                          (push move moves)))))))))))
    (values (nreverse tags) (nreverse moves) result)))

(defparameter *max-pgn-plies* 400
  "The most half-moves of one game that READ-PGN-GAME will keep.")

(defun read-pgn-game (text)
  "Read the first game in TEXT. Returns a plist:
  :start   the starting position
  :moves   the legal moves read, in order, up to the first one that failed
  :sans    the engine's own notation for those moves
  :tags    alist of tag pairs
  :result  the result token, or NIL
  :error   NIL, or (ply text reason) for the half-move that stopped the reading.
Every move is checked against the move generator; none is taken on trust."
  (multiple-value-bind (tags tokens result) (pgn-tokens text)
    (let* ((fen (cdr (assoc "FEN" tags :test #'string-equal)))
           (start (if fen
                      (handler-case (pos-from-fen fen)
                        (error ()
                          (return-from read-pgn-game
                            (list :start (pos-from-fen +start-fen+) :moves '() :sans '()
                                  :tags tags :result result
                                  :error (list 0 fen "The FEN tag is not a legal position.")))))
                      (pos-from-fen +start-fen+)))
           (p (copy-position start))
           (moves '()) (sans '()) (failure nil) (ply 0))
      (dolist (token tokens)
        (incf ply)
        (when (> ply *max-pgn-plies*)
          (setf failure (list ply token
                              (format nil "Only the first ~D half-moves are kept." *max-pgn-plies*)))
          (return))
        (let ((m (parse-san-move p token)))
          (unless m
            (setf failure (list ply token
                                (if (has-legal-move-p p)
                                    "Not a legal move in that position, or ambiguous."
                                    "The game is already over at that point.")))
            (return))
          (push (move-san p m) sans)
          (push m moves)
          (make-move p m)))
      (list :start start :moves (nreverse moves) :sans (nreverse sans)
            :tags tags :result result :error failure))))
