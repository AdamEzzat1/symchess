;;;; server.lisp -- accept loop, per-client reader threads, clock ticker.

(in-package :symchess)

(defvar *server-socket* nil)
(defvar *log-directory* (asdf:system-relative-pathname "symchess" "../logs/"))

(defun open-session-log ()
  (multiple-value-bind (sec min hour day month year) (get-decoded-time)
    (let ((path (merge-pathnames
                 (format nil "session-~4,'0D~2,'0D~2,'0D-~2,'0D~2,'0D~2,'0D.jsonl"
                         year month day hour min sec)
                 *log-directory*)))
      (ensure-directories-exist path)
      (setf *log-stream* (open path :direction :output :if-exists :supersede
                                    :external-format :utf-8))
      path)))

(defun handle-client (socket)
  (let* ((stream (sb-bsd-sockets:socket-make-stream
                  socket :input t :output t
                         :element-type '(unsigned-byte 8) :buffering :full))
         (client (make-client :stream stream :socket socket)))
    (unwind-protect
         (when (ws-handshake stream)
           (sb-thread:with-mutex (*send-lock*) (push client *clients*))
           (send-direct client "hello"
                        "protocol" 1
                        "engine" "symchess 0.1.0"
                        "lisp" (format nil "~A ~A" (lisp-implementation-type)
                                       (lisp-implementation-version))
                        "prolog" (jnull *prolog-version-string*))
           (with-state
             (broadcast-game-state *game*)
             (unless (game-thinking *game*) (after-state-change *game*)))
           (loop
             (let ((text (ws-read-message stream (client-write-lock client))))
               (unless text (return))
               (handle-command client text))))
      (sb-thread:with-mutex (*send-lock*)
        (setf *clients* (remove client *clients*)))
      (ignore-errors (close stream :abort t))
      (ignore-errors (sb-bsd-sockets:socket-close socket)))))

(defun clock-ticker ()
  "Ends the game when the side to move runs out of time."
  (loop
    (sleep 0.25)
    (with-state
      (let ((g *game*))
        (when (and (game-tc-base-ms g) (game-clock-started g)
                   (string= (game-status g) "active"))
          (let ((side (pos-side (game-pos g))))
            (when (<= (clock-remaining g side) 0)
              (cancel-worker g)
              (flag-fall g side)
              (incf (game-position-id g))
              (broadcast-game-state g))))))))

(defun start-server (&key (port 8765) (log t))
  "Listen on 127.0.0.1:PORT and serve until the process exits."
  (when log
    (format t "~&[symchess] event log: ~A~%" (open-session-log)))
  (setf *prolog-version-string* (prolog-version))
  (format t "~&[symchess] Prolog knowledge layer: ~A~%"
          (or *prolog-version-string* "UNAVAILABLE (engine will run search-only)"))
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
    (setf (sb-bsd-sockets:sockopt-reuse-address socket) t)
    (sb-bsd-sockets:socket-bind socket #(127 0 0 1) port)
    (sb-bsd-sockets:socket-listen socket 8)
    (setf *server-socket* socket)
    (sb-thread:make-thread #'clock-ticker :name "symchess-clock")
    (format t "~&[symchess] listening on ws://127.0.0.1:~D~%" port)
    (finish-output)
    (loop
      (let ((client-socket (sb-bsd-sockets:socket-accept socket)))
        (sb-thread:make-thread
         (lambda ()
           (handler-case (handle-client client-socket)
             (error (e) (format *error-output* "~&[client] ~A~%" e))))
         :name "symchess-client")))))

(defun main ()
  (let ((port (let ((text (sb-ext:posix-getenv "SYMCHESS_PORT")))
                (if text (parse-integer text) 8765))))
    (handler-case (start-server :port port)
      (sb-sys:interactive-interrupt ()
        (stop-prolog)
        (sb-ext:exit :code 0 :abort t)))))
