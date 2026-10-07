;;;; uci.lisp -- the Universal Chess Interface, so chess programs can drive
;;;; the engine:   sbcl --script engine/uci.lisp
;;;;
;;;; A second front door beside the WebSocket server. It shares the board, the
;;;; move generator and the search, and nothing else: no sessions, no clocks,
;;;; no Prolog. What it supports is small and listed in README.md:
;;;;   uci, isready, ucinewgame, position, go depth/movetime/infinite
;;;;   (and wtime/btime, crudely), stop, quit.

(in-package :symchess)

(defun split-words (line)
  (let ((words '()) (start nil))
    (dotimes (i (length line))
      (if (member (char line i) '(#\Space #\Tab #\Return))
          (when start (push (subseq line start i) words) (setf start nil))
          (unless start (setf start i))))
    (when start (push (subseq line start) words))
    (nreverse words)))

(defun uci-position (words)
  "The position a `position` command describes, or NIL if it cannot be read.
A move that is not legal ends the list there: the moves before it stand."
  (let* ((moves-at (position "moves" words :test #'string=))
         (setup (subseq words 0 moves-at))
         (p (cond ((equal (first setup) "startpos") (pos-from-fen +start-fen+))
                  ((equal (first setup) "fen")
                   (handler-case (pos-from-fen (format nil "~{~A~^ ~}" (rest setup)))
                     (error () nil)))
                  (t nil))))
    (when p
      (dolist (text (and moves-at (subseq words (1+ moves-at))))
        (let ((m (parse-uci-move p text)))
          (unless m (return))
          (make-move p m)))
      p)))

(defun uci-score (score)
  "A search score, from the side to move's point of view, in UCI's words."
  (if (> (abs score) +mate-bound+)
      (let ((moves (ceiling (- +mate+ (abs score)) 2)))
        (format nil "mate ~D" (if (plusp score) moves (- moves))))
      (format nil "cp ~D" score)))

(defun uci-time-for-move (clock-ms increment-ms moves-to-go)
  "Milliseconds to spend on one move with CLOCK-MS left. A share of the clock
(a thirtieth, or an equal share of the moves left before the time control)
plus most of the increment, never more than half of what is left and never
less than 20 ms. Simple on purpose: it keeps the engine from losing on time
in a match, and claims nothing more."
  (let* ((share (floor clock-ms (if (and moves-to-go (plusp moves-to-go))
                                    (1+ moves-to-go)
                                    30)))
         (bonus (floor (* 3 (or increment-ms 0)) 4)))
    (max 20 (min (+ share bonus) (floor clock-ms 2)))))

(defun uci-loop (&optional (in *standard-input*) (out *standard-output*))
  "Read UCI commands from IN and answer on OUT until `quit` or end of input."
  (let ((p (pos-from-fen +start-fen+))
        (lock (sb-thread:make-mutex :name "uci-out"))
        (stop (list nil))
        (worker nil)
        (unbounded nil))
    (labels ((say (control &rest args)
               (sb-thread:with-mutex (lock)
                 (apply #'format out control args)
                 (terpri out)
                 (finish-output out)))
             (wait ()
               (when worker
                 (ignore-errors (sb-thread:join-thread worker :default nil))
                 (setf worker nil)))
             (halt ()
               (setf (car stop) t)
               (wait))
             (go-search (words)
               (halt)
               (let* ((flag (list nil))
                      (root (copy-position p))
                      (number (lambda (key)
                                (let ((at (position key words :test #'string=)))
                                  (and at (nth (1+ at) words)
                                       (parse-integer (nth (1+ at) words) :junk-allowed t)))))
                      (depth (funcall number "depth"))
                      (movetime (funcall number "movetime"))
                      (white (= (pos-side root) 1))
                      (clock (funcall number (if white "wtime" "btime")))
                      (time-ms (or movetime
                                   (and clock
                                        (uci-time-for-move clock
                                                           (funcall number (if white "winc" "binc"))
                                                           (funcall number "movestogo"))))))
                 (setf stop flag
                       unbounded (and (null depth) (null time-ms)))
                 (setf worker
                       (sb-thread:make-thread
                        (lambda ()
                          (let* ((result
                                   (search-position
                                    root
                                    :max-depth (min 30 (or depth 30))
                                    :time-ms time-ms
                                    :stop-fn (lambda () (car flag))
                                    :on-iteration
                                    (lambda (r)
                                      (say "info depth ~D score ~A nodes ~D time ~D pv~{ ~A~}"
                                           (search-result-depth r)
                                           (uci-score (search-result-score r))
                                           (search-result-nodes r)
                                           (search-result-time-ms r)
                                           (mapcar #'move-uci (search-result-pv r))))))
                                 (best (or (search-result-best-move result)
                                           ;; Stopped before one depth finished.
                                           (first (legal-moves root)))))
                            (say "bestmove ~A" (if best (move-uci best) "0000"))))
                        :name "uci-search")))))
      (loop for line = (read-line in nil nil)
            while line
            do (let* ((words (split-words line))
                      (command (first words)))
                 (cond
                   ((null command))
                   ((string= command "uci")
                    (say "id name SymChess")
                    (say "id author Adam Ezzat")
                    (say "uciok"))
                   ((string= command "isready") (say "readyok"))
                   ((string= command "ucinewgame")
                    (halt)
                    (tt-clear)
                    (setf p (pos-from-fen +start-fen+)))
                   ((string= command "position")
                    (halt)
                    (let ((next (uci-position (rest words))))
                      (if next
                          (setf p next)
                          (say "info string could not read that position"))))
                   ((string= command "go") (go-search (rest words)))
                   ((string= command "stop") (halt))
                   ((string= command "quit")
                    ;; A search with its own limit is allowed to finish and
                    ;; report; one without is stopped.
                    (if unbounded (halt) (wait))
                    (return))
                   (t (say "info string unknown command ~A" command)))))
      ;; End of input is treated like quit.
      (if unbounded (halt) (wait)))))
