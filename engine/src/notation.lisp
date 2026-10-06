;;;; notation.lisp -- UCI and SAN move text. The frontend never derives
;;;; notation itself; it displays what the engine sends.

(in-package :symchess)

(defun move-uci (m)
  (format nil "~A~A~A"
          (square-name (move-from m))
          (square-name (move-to m))
          (if (zerop (move-promo m))
              ""
              (string (char-downcase (char " PNBRQK" (move-promo m)))))))

(defun parse-uci-move (p text)
  "Find the legal move in P matching TEXT (e.g. \"e2e4\", \"e7e8q\"), or NIL."
  (find text (legal-moves p) :key #'move-uci :test #'string=))

(defun move-san (p m &optional (legal (legal-moves p)))
  "Standard algebraic notation for legal move M in position P."
  (let* ((b (pos-board p))
         (from (move-from m))
         (to (move-to m))
         (kind (abs (aref b from)))
         (base
           (cond
             ((move-castle-p m) (if (= (sq-file to) 6) "O-O" "O-O-O"))
             ((= kind +pawn+)
              (concatenate
               'string
               (if (move-capture-p m)
                   (format nil "~Cx" (code-char (+ 97 (sq-file from))))
                   "")
               (square-name to)
               (if (plusp (move-promo m))
                   (format nil "=~C" (char " PNBRQK" (move-promo m)))
                   "")))
             (t
              (let* ((rivals (remove-if-not
                              (lambda (o)
                                (and (/= o m)
                                     (= (move-to o) to)
                                     (= (abs (aref b (move-from o))) kind)))
                              legal))
                     (disambiguation
                       (cond ((null rivals) "")
                             ((notany (lambda (o) (= (sq-file (move-from o)) (sq-file from)))
                                      rivals)
                              (string (code-char (+ 97 (sq-file from)))))
                             ((notany (lambda (o) (= (sq-rank (move-from o)) (sq-rank from)))
                                      rivals)
                              (format nil "~D" (1+ (sq-rank from))))
                             (t (square-name from)))))
                (format nil "~C~A~:[~;x~]~A"
                        (char " PNBRQK" kind) disambiguation
                        (move-capture-p m) (square-name to)))))))
    (make-move p m)
    (let ((suffix (cond ((not (in-check-p p)) "")
                        ((has-legal-move-p p) "+")
                        (t "#"))))
      (unmake-move p)
      (concatenate 'string base suffix))))

(defun pv-san (p moves)
  "SAN strings for a line of MOVES starting from P. P is left unchanged.
Stops quietly if the line stops being legal (a truncated/hashed PV)."
  (let ((made 0) (out '()))
    (dolist (m moves)
      (let ((legal (legal-moves p)))
        (unless (member m legal) (return))
        (push (move-san p m legal) out)
        (make-move p m)
        (incf made)))
    (dotimes (i made) (unmake-move p))
    (nreverse out)))
