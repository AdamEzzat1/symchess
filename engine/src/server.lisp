;;;; server.lisp -- listener, sessions, capacity limit, static files, ticker.
;;;;
;;;; One port does two jobs:
;;;;   * a WebSocket upgrade starts a SESSION: one visitor, one private game;
;;;;   * any other GET is answered from an in-memory copy of the built
;;;;     frontend (web/dist), so the hosted app is a single process on a
;;;;     single origin with no separate web server.
;;;;
;;;; Configuration (environment variables, all optional):
;;;;   SYMCHESS_HOST            address to bind         (default 127.0.0.1)
;;;;   SYMCHESS_PORT / PORT     port                    (default 8765)
;;;;   SYMCHESS_MAX_SESSIONS    simultaneous players    (default 8)
;;;;   SYMCHESS_IDLE_SECONDS    drop silent sessions    (default 0 = never)
;;;;   SYMCHESS_ALLOWED_ORIGINS "*" or comma list       (default local only)
;;;;   SYMCHESS_MAX_DEPTH       search depth ceiling    (default 30)
;;;;   SYMCHESS_MAX_MOVE_MS     thinking time ceiling   (default 120000)
;;;;   SYMCHESS_STATIC_DIR      built frontend          (default ../web/dist)
;;;;   SYMCHESS_LOG             "0" disables event log  (default on)

(in-package :symchess)

(defvar *log-directory* (asdf:system-relative-pathname "symchess" "../logs/"))

(defvar *max-sessions* 8)
(defvar *idle-ms* 0)
(defvar *handshake-timeout-ms* 15000)

(defvar *registry-lock* (sb-thread:make-mutex :name "registry"))
(defvar *sessions* '())                 ; games with a live client
(defvar *connections* '())              ; every accepted socket, upgraded or not

(defstruct connection
  socket
  (started (now-ms))
  (session nil))                        ; the GAME once upgraded

(defun env (name)
  (let ((value (sb-ext:posix-getenv name)))
    (and value (plusp (length value)) value)))

(defun env-integer (name default)
  (let ((value (env name)))
    (or (and value (ignore-errors (parse-integer value))) default)))

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

;;; ----------------------------------------------------------- static files
;;; The whole frontend build is read into memory once. Requests are answered
;;; by exact lookup in that table, so no request path ever touches the disk.

(defvar *static-files* (make-hash-table :test #'equal))

(defun content-type-for (name)
  (let* ((dot (position #\. name :from-end t))
         (ext (if dot (string-downcase (subseq name (1+ dot))) "")))
    (cond ((string= ext "html") "text/html; charset=utf-8")
          ((string= ext "js") "text/javascript; charset=utf-8")
          ((string= ext "css") "text/css; charset=utf-8")
          ((string= ext "json") "application/json")
          ((string= ext "svg") "image/svg+xml")
          ((string= ext "png") "image/png")
          ((string= ext "ico") "image/x-icon")
          ((string= ext "woff2") "font/woff2")
          ((string= ext "woff") "font/woff")
          ((string= ext "txt") "text/plain; charset=utf-8")
          (t "application/octet-stream"))))

(defun read-file-octets (path)
  (with-open-file (in path :element-type '(unsigned-byte 8))
    (let ((data (make-array (file-length in) :element-type '(unsigned-byte 8))))
      (read-sequence data in)
      data)))

(defun load-static-files (directory)
  "Read every file under DIRECTORY into *STATIC-FILES*. Returns the count."
  (clrhash *static-files*)
  (let* ((root (truename directory))
         (root-name (namestring root)))
    (dolist (path (directory (merge-pathnames "**/*.*" root)))
      (when (pathname-name path)        ; skip directories
        (let* ((full (namestring path))
               (relative (substitute #\/ #\\ (subseq full (length root-name)))))
          (setf (gethash (concatenate 'string "/" relative) *static-files*)
                (cons (content-type-for relative) (read-file-octets path)))))))
  (hash-table-count *static-files*))

(defun serve-static (stream lines)
  (let* ((parts (split-spaces (first lines)))
         (method (first parts))
         (target (or (second parts) "/"))
         (path (subseq target 0 (or (position #\? target) (length target))))
         (head (equal method "HEAD")))
    (cond ((not (member method '("GET" "HEAD") :test #'equal))
           (http-respond-text stream "405 Method Not Allowed" "Method not allowed."))
          ((string= path "/healthz")
           (http-respond-text stream "200 OK" "ok"))
          (t
           (let ((entry (gethash (if (string= path "/") "/index.html" path) *static-files*)))
             (cond (entry
                    (http-respond stream "200 OK" (car entry) (cdr entry)
                                  :head-only head
                                  ;; Vite fingerprints everything under /assets/.
                                  :cache (if (search "/assets/" path)
                                             "public, max-age=31536000, immutable"
                                             "no-cache")))
                   ((zerop (hash-table-count *static-files*))
                    (http-respond-text stream "200 OK"
                                       "SymChess engine. WebSocket endpoint only: no frontend build was found."))
                   (t (http-respond-text stream "404 Not Found" "Not found."))))))))

;;; --------------------------------------------------------------- sessions

(defun session-count ()
  (sb-thread:with-mutex (*registry-lock*) (length *sessions*)))

(defun claim-seat (game)
  "Add GAME to the session list unless the server is full. Returns T if seated."
  (sb-thread:with-mutex (*registry-lock*)
    (when (< (length *sessions*) *max-sessions*)
      (push game *sessions*)
      t)))

(defun release-seat (game)
  (sb-thread:with-mutex (*registry-lock*)
    (setf *sessions* (remove game *sessions*))))

(defun refuse (stream code message)
  "Tell a just-connected client why it cannot play, then close politely."
  (ignore-errors
   (ws-write-text stream
                  (json-encode (obj "type" "error" "seq" 1 "code" code
                                    "message" message "inReplyTo" :null)))
   ;; 1013 = Try Again Later
   (ws-write-frame stream 8 (coerce #(3 245) '(vector (unsigned-byte 8))))))

(defun serve-session (connection stream)
  (let* ((client (make-client :stream stream :socket (connection-socket connection)))
         (game (make-game :client client)))
    (unless (claim-seat game)
      (refuse stream "server_full"
              (format nil "All ~D seats are taken. This page will try again shortly."
                      *max-sessions*))
      (return-from serve-session nil))
    (setf (connection-session connection) game)
    (let ((*game* game))
      (unwind-protect
           (progn
             (broadcast "hello"
                        "protocol" 1
                        "engine" "symchess 0.4.0"
                        "lisp" (format nil "~A ~A" (lisp-implementation-type)
                                       (lisp-implementation-version))
                        "prolog" (jnull *prolog-version-string*)
                        "players" (session-count)
                        "maxPlayers" *max-sessions*
                        "maxDepth" *max-depth*
                        "maxMoveTimeMs" *max-move-time-ms*
                        ;; What each level means on this server, after its ceilings.
                        "levels" (mapcar (lambda (level)
                                           (obj "id" (level-name level)
                                                "depth" (min (level-depth level) *max-depth*)
                                                "moveTimeMs" (min (level-time-ms level)
                                                                  *max-move-time-ms*)))
                                         *levels*))
             (with-state
               (setf (game-move-time-ms game) (min (game-move-time-ms game) *max-move-time-ms*)
                     (game-depth game) (min (game-depth game) *max-depth*))
               (broadcast-game-state game)
               (after-state-change game))
             (loop
               ;; A read error (peer vanished, or HANG-UP woke us) ends the
               ;; session exactly like a clean close.
               (let ((text (ignore-errors
                            (ws-read-message stream (client-write-lock client)))))
                 (unless text (return))
                 (handle-command client text))))
        ;; The visitor is gone: stop their search and free the seat.
        (with-state (cancel-worker game) (cancel-review game))
        (setf (game-client game) nil)
        (release-seat game)))))

(defun handle-connection (socket)
  (let ((stream (sb-bsd-sockets:socket-make-stream
                 socket :input t :output t
                        :element-type '(unsigned-byte 8) :buffering :full))
        (connection (make-connection :socket socket)))
    (sb-thread:with-mutex (*registry-lock*) (push connection *connections*))
    (unwind-protect
         (let* ((lines (read-http-headers stream))
                (key (and lines (header-value lines "Sec-WebSocket-Key"))))
           (cond ((null lines) nil)
                 ((null key) (serve-static stream lines))
                 ((not (origin-allowed-p (header-value lines "Origin")))
                  (http-respond-text stream "403 Forbidden" "Origin not allowed."))
                 (t
                  (ws-accept stream key)
                  (serve-session connection stream))))
      (sb-thread:with-mutex (*registry-lock*)
        (setf *connections* (remove connection *connections*)))
      (ignore-errors (close stream :abort t))
      (ignore-errors (sb-bsd-sockets:socket-close socket)))))

(defun hang-up (connection)
  "Wake the thread blocked reading this socket; it then cleans up itself."
  (ignore-errors
   (sb-bsd-sockets:socket-shutdown (connection-socket connection) :direction :io)))

;;; ----------------------------------------------------------------- ticker

(defun tick-clock (g)
  "End the game when the side to move runs out of time."
  (let ((*game* g))
    (with-state
      (when (and (game-tc-base-ms g) (game-clock-started g)
                 (string= (game-status g) "active"))
        (let ((side (pos-side (game-pos g))))
          (when (<= (clock-remaining g side) 0)
            (cancel-worker g)
            (flag-fall g side)
            (incf (game-position-id g))
            (broadcast-game-state g)))))))

(defun ticker ()
  (loop
    (sleep 0.25)
    (handler-case
        (let ((now (now-ms))
              (connections (sb-thread:with-mutex (*registry-lock*)
                             (copy-list *connections*))))
          (dolist (connection connections)
            (let ((g (connection-session connection)))
              (cond ((null g)
                     ;; Never finished an HTTP request or handshake.
                     (when (> (- now (connection-started connection)) *handshake-timeout-ms*)
                       (hang-up connection)))
                    ((and (plusp *idle-ms*) (> (- now (game-last-activity g)) *idle-ms*))
                     (let ((*game* g))
                       (broadcast "error" "code" "idle_timeout"
                                          "message" "Disconnected after a period of inactivity to free the seat for someone else."
                                          "inReplyTo" :null))
                     (setf (game-last-activity g) now) ; say it once
                     (hang-up connection))
                    (t (tick-clock g))))))
      (error (e) (format *error-output* "~&[ticker] ~A~%" e)))))

;;; ------------------------------------------------------------------ start

(defun parse-origins (text)
  (cond ((null text) nil)
        ((string= text "*") :any)
        (t (loop with start = 0
                 for comma = (position #\, text :start start)
                 for item = (string-trim " " (subseq text start comma))
                 unless (zerop (length item)) collect item
                 while comma
                 do (setf start (1+ comma))))))

(defun parse-host (text)
  "Dotted IPv4 text -> the octet vector sb-bsd-sockets wants."
  (let ((octets (loop with start = 0
                      for dot = (position #\. text :start start)
                      collect (parse-integer text :start start :end dot)
                      while dot
                      do (setf start (1+ dot)))))
    (unless (and (= (length octets) 4) (every (lambda (o) (<= 0 o 255)) octets))
      (error "SYMCHESS_HOST must be an IPv4 address, got ~S" text))
    (coerce octets 'vector)))

(defun start-server (&key (host "127.0.0.1") (port 8765) (log t) static-dir)
  "Listen on HOST:PORT and serve until the process exits."
  (when log
    (format t "~&[symchess] event log: ~A~%" (open-session-log)))
  (when (and static-dir (probe-file static-dir))
    (format t "~&[symchess] serving ~D frontend files from ~A~%"
            (load-static-files static-dir) static-dir))
  (setf *prolog-version-string* (prolog-version))
  (format t "~&[symchess] Prolog knowledge layer: ~A~%"
          (or *prolog-version-string* "UNAVAILABLE (engine will run search-only)"))
  (let ((socket (make-instance 'sb-bsd-sockets:inet-socket :type :stream :protocol :tcp)))
    (setf (sb-bsd-sockets:sockopt-reuse-address socket) t)
    (sb-bsd-sockets:socket-bind socket (parse-host host) port)
    (sb-bsd-sockets:socket-listen socket 32)
    (sb-thread:make-thread #'ticker :name "symchess-ticker")
    (format t "~&[symchess] listening on ~A:~D  (seats: ~D, idle limit: ~:[none~;~:*~D s~], origins: ~A)~%"
            host port *max-sessions*
            (and (plusp *idle-ms*) (floor *idle-ms* 1000))
            (cond ((eq *allowed-origins* :any) "any")
                  ((null *allowed-origins*) "local only")
                  (t *allowed-origins*)))
    (finish-output)
    (loop
      (let ((client-socket (sb-bsd-sockets:socket-accept socket))
            ;; A hard ceiling on open sockets, well above the seat count, so a
            ;; flood of half-open connections cannot exhaust threads.
            (busy (sb-thread:with-mutex (*registry-lock*) (length *connections*))))
        (if (> busy (+ 64 (* 4 *max-sessions*)))
            (ignore-errors (sb-bsd-sockets:socket-close client-socket))
            (sb-thread:make-thread
             (lambda ()
               (handler-case (handle-connection client-socket)
                 (error (e) (format *error-output* "~&[connection] ~A~%" e))))
             :name "symchess-connection"))))))

(defun main ()
  (setf *max-sessions* (max 1 (env-integer "SYMCHESS_MAX_SESSIONS" 8))
        *idle-ms* (* 1000 (max 0 (env-integer "SYMCHESS_IDLE_SECONDS" 0)))
        *allowed-origins* (parse-origins (env "SYMCHESS_ALLOWED_ORIGINS"))
        *max-depth* (max 1 (min 30 (env-integer "SYMCHESS_MAX_DEPTH" 30)))
        *max-move-time-ms* (max 50 (min 120000 (env-integer "SYMCHESS_MAX_MOVE_MS" 120000))))
  (let ((port (env-integer "SYMCHESS_PORT" (env-integer "PORT" 8765)))
        (host (or (env "SYMCHESS_HOST") "127.0.0.1"))
        (static-dir (or (env "SYMCHESS_STATIC_DIR")
                        (namestring (asdf:system-relative-pathname "symchess" "../web/dist/")))))
    (handler-case (start-server :host host :port port
                                :log (not (equal (env "SYMCHESS_LOG") "0"))
                                :static-dir static-dir)
      (sb-sys:interactive-interrupt ()
        (stop-prolog)
        (sb-ext:exit :code 0 :abort t)))))
