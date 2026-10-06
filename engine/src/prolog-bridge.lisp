;;;; prolog-bridge.lisp -- the cold path to the Prolog knowledge layer.
;;;;
;;;; One long-lived swipl child process. Lisp writes one Prolog term per line,
;;;; Prolog answers with one JSON object per line. Lisp is the only side that
;;;; makes moves: for every legal root move it ships the resulting piece list,
;;;; so Prolog never needs (or has) a move generator.
;;;;
;;;; Failure policy: any timeout, crash or malformed reply kills the child and
;;;; returns NIL. The engine keeps playing without symbolic input and the UI is
;;;; told the analysis is unavailable. Prolog can never stall the search.

(in-package :symchess)

(defvar *prolog-process* nil)
(defvar *prolog-lock* (sb-thread:make-mutex :name "prolog"))
(defvar *prolog-request-id* 0)
(defvar *prolog-timeout-ms* 4000)
(defvar *knowledge-server*
  (asdf:system-relative-pathname "symchess" "../knowledge/server.pl"))
(defvar *prolog-log*
  (asdf:system-relative-pathname "symchess" "../logs/prolog-stderr.log"))

(defvar *symbolic-cache* (make-hash-table))
(defvar *symbolic-cache-lock* (sb-thread:make-mutex :name "symbolic-cache"))
(defconstant +symbolic-cache-limit+ 512)

(defun find-swipl ()
  (or (sb-ext:posix-getenv "SYMCHESS_SWIPL")
      (find-if #'probe-file
               '("C:/Program Files/swipl/bin/swipl.exe"
                 "/usr/bin/swipl" "/usr/local/bin/swipl" "/opt/homebrew/bin/swipl"))
      "swipl"))

(defun stop-prolog ()
  (when *prolog-process*
    (ignore-errors (close (sb-ext:process-input *prolog-process*)))
    (ignore-errors (sb-ext:process-kill *prolog-process* 9))
    (ignore-errors (sb-ext:process-close *prolog-process*))
    (setf *prolog-process* nil)))

(defun ensure-prolog ()
  (unless (and *prolog-process* (sb-ext:process-alive-p *prolog-process*))
    (stop-prolog)
    (ensure-directories-exist *prolog-log*)
    (let ((swipl (find-swipl)))
      (setf *prolog-process*
            (sb-ext:run-program (if (pathnamep swipl) (sb-ext:native-namestring swipl) swipl)
                                (list "-q" "-g" "main" "-t" "halt"
                                      (sb-ext:native-namestring *knowledge-server*))
                                :search t :wait nil
                                :input :stream :output :stream
                                :error (sb-ext:native-namestring *prolog-log*)
                                :if-error-exists :supersede))))
  *prolog-process*)

(defun read-line-with-timeout (stream timeout-ms)
  "READ-LINE, but give up (returning NIL) after TIMEOUT-MS."
  (let ((deadline (+ (now-ms) timeout-ms)))
    (loop
      (when (listen stream)
        (return (string-right-trim '(#\Return #\Newline) (read-line stream nil nil))))
      (when (> (now-ms) deadline) (return nil))
      (sleep 0.002))))

(defun prolog-request (make-term)
  "MAKE-TERM is called with a fresh request id and returns the term text.
Returns the decoded JSON reply, or NIL if Prolog is unavailable."
  (sb-thread:with-mutex (*prolog-lock*)
    (handler-case
        (let* ((process (ensure-prolog))
               (id (incf *prolog-request-id*))
               (in (sb-ext:process-input process))
               (out (sb-ext:process-output process)))
          (write-string (funcall make-term id) in)
          (write-char #\Newline in)
          (finish-output in)
          (let ((line (read-line-with-timeout out *prolog-timeout-ms*)))
            (cond ((null line)
                   (format *error-output* "~&[prolog] timeout, restarting~%")
                   (stop-prolog)
                   nil)
                  (t
                   (let ((reply (json-decode line)))
                     (cond ((not (eql (jget reply "id") id))
                            (format *error-output* "~&[prolog] reply id mismatch~%")
                            (stop-prolog)
                            nil)
                           ((not (equal (jget reply "status") "ok"))
                            (format *error-output* "~&[prolog] error: ~A~%"
                                    (jget reply "message"))
                            nil)
                           (t reply)))))))
      (error (e)
        (format *error-output* "~&[prolog] bridge failure: ~A~%" e)
        (stop-prolog)
        nil))))

(defun prolog-version ()
  (let ((reply (prolog-request (lambda (id) (format nil "version(~D)." id)))))
    (and reply (jget reply "version"))))

;;; ---------------------------------------------------------- serialisation

(defun piece-kind-name (kind)
  (aref #("" "pawn" "knight" "bishop" "rook" "queen" "king") kind))

(defun side-name (side) (if (= side 1) "white" "black"))

(defun write-prolog-position (p out)
  "pos(Side, [p(Color,Type,Square), ...])"
  (format out "pos(~A,[" (side-name (pos-side p)))
  (let ((first t) (b (pos-board p)))
    (dotimes (sq 128)
      (when (and (on-board-p sq) (/= (aref b sq) 0))
        (let ((piece (aref b sq)))
          (format out "~:[,~;~]p(~A,~A,~A)" first
                  (side-name (signum piece)) (piece-kind-name (abs piece)) (square-name sq))
          (setf first nil)))))
  (write-string "])" out))

(defun analyze-term (p legal id)
  (with-output-to-string (out)
    (format out "analyze(~D," id)
    (write-prolog-position p out)
    (write-string ",[" out)
    (let ((first t))
      (dolist (m legal)
        (unless first (write-char #\, out))
        (setf first nil)
        (format out "m('~A'," (move-uci m))
        (make-move p m)
        (write-prolog-position p out)
        (unmake-move p)
        (write-char #\) out)))
    (write-string "])." out)))

;;; ------------------------------------------------------------- public API

(defun symbolic-analysis (p)
  "Root-position analysis from Prolog: facts, plans and per-move motifs.
Cached by position hash. Returns a JSON object or NIL when unavailable.
Each entry of \"moves\" gains a \"san\" field and the list is sorted best-first."
  (let ((key (pos-hash p)))
    (or (sb-thread:with-mutex (*symbolic-cache-lock*) (gethash key *symbolic-cache*))
        (let* ((p (copy-position p))
               (legal (legal-moves p))
               (start (now-ms))
               (reply (prolog-request (lambda (id) (analyze-term p legal id)))))
          (when reply
            (let ((moves (jget reply "moves")))
              (dolist (entry moves)
                (let ((m (find (jget entry "uci") legal :key #'move-uci :test #'string=)))
                  (when m (jset entry "san" (move-san p m legal)))))
              (jset reply "moves"
                    (stable-sort (copy-list moves) #'> :key (lambda (e) (jget e "score" 0)))))
            (jset reply "elapsedMs" (- (now-ms) start))
            (sb-thread:with-mutex (*symbolic-cache-lock*)
              (when (>= (hash-table-count *symbolic-cache*) +symbolic-cache-limit+)
                (clrhash *symbolic-cache*))
              (setf (gethash key *symbolic-cache*) reply)))
          reply))))

(defun symbolic-hints (p analysis)
  "Hash-table move -> ordering bonus, from a SYMBOLIC-ANALYSIS result."
  (when analysis
    (let ((table (make-hash-table))
          (legal (legal-moves p)))
      (dolist (entry (jget analysis "moves") table)
        (let ((m (find (jget entry "uci") legal :key #'move-uci :test #'string=))
              (score (jget entry "score" 0)))
          (when (and m (integerp score) (/= score 0))
            (setf (gethash m table) score)))))))

(defun prolog-inspect (p square)
  "Ask Prolog who controls SQUARE (a name like \"e4\"). JSON object or NIL."
  (parse-square square)                 ; validates before it reaches Prolog
  (prolog-request
   (lambda (id)
     (with-output-to-string (out)
       (format out "inspect(~D," id)
       (write-prolog-position p out)
       (format out ",~A)." square)))))
