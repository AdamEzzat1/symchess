;;;; websocket.lisp -- a small RFC 6455 server on sb-bsd-sockets.
;;;; Text frames only, no extensions; enough for one local browser client.

(in-package :symchess)

;;; ------------------------------------------------------------------ SHA-1
;;; Needed only for the WebSocket handshake.

(defun sha1 (octets)
  (let* ((len (length octets))
         (bit-length (* 8 len))
         (pad (let ((r (mod (+ len 9) 64))) (if (zerop r) 0 (- 64 r))))
         (total (+ len 9 pad))
         (msg (make-array total :element-type '(unsigned-byte 8) :initial-element 0))
         (w (make-array 80 :initial-element 0))
         (h0 #x67452301) (h1 #xEFCDAB89) (h2 #x98BADCFE) (h3 #x10325476) (h4 #xC3D2E1F0))
    (replace msg octets)
    (setf (aref msg len) #x80)
    (dotimes (i 8)
      (setf (aref msg (- total 1 i)) (ldb (byte 8 (* 8 i)) bit-length)))
    (flet ((rol (x n) (ldb (byte 32 0) (logior (ash x n) (ash x (- n 32)))))
           (add (&rest xs) (ldb (byte 32 0) (apply #'+ xs))))
      (loop for off from 0 below total by 64
            do (dotimes (i 16)
                 (setf (aref w i)
                       (logior (ash (aref msg (+ off (* 4 i))) 24)
                               (ash (aref msg (+ off (* 4 i) 1)) 16)
                               (ash (aref msg (+ off (* 4 i) 2)) 8)
                               (aref msg (+ off (* 4 i) 3)))))
               (loop for i from 16 below 80
                     do (setf (aref w i)
                              (rol (logxor (aref w (- i 3)) (aref w (- i 8))
                                           (aref w (- i 14)) (aref w (- i 16)))
                                   1)))
               (let ((a h0) (b h1) (c h2) (d h3) (e h4))
                 (dotimes (i 80)
                   (multiple-value-bind (f k)
                       (cond ((< i 20)
                              (values (logior (logand b c)
                                              (logand (logxor b #xFFFFFFFF) d))
                                      #x5A827999))
                             ((< i 40) (values (logxor b c d) #x6ED9EBA1))
                             ((< i 60)
                              (values (logior (logand b c) (logand b d) (logand c d))
                                      #x8F1BBCDC))
                             (t (values (logxor b c d) #xCA62C1D6)))
                     (let ((temp (add (rol a 5) f e k (aref w i))))
                       (setf e d
                             d c
                             c (rol b 30)
                             b a
                             a temp))))
                 (setf h0 (add h0 a) h1 (add h1 b) h2 (add h2 c)
                       h3 (add h3 d) h4 (add h4 e)))))
    (let ((digest (make-array 20 :element-type '(unsigned-byte 8))))
      (loop for h in (list h0 h1 h2 h3 h4)
            for j from 0 by 4
            do (dotimes (i 4)
                 (setf (aref digest (+ j i)) (ldb (byte 8 (* 8 (- 3 i))) h))))
      digest)))

(defun base64-encode (octets)
  (let ((alphabet "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/")
        (n (length octets)))
    (with-output-to-string (out)
      (loop for i from 0 below n by 3
            do (let* ((b0 (aref octets i))
                      (b1 (if (< (+ i 1) n) (aref octets (+ i 1)) 0))
                      (b2 (if (< (+ i 2) n) (aref octets (+ i 2)) 0))
                      (triple (logior (ash b0 16) (ash b1 8) b2)))
                 (write-char (char alphabet (ldb (byte 6 18) triple)) out)
                 (write-char (char alphabet (ldb (byte 6 12) triple)) out)
                 (write-char (if (< (+ i 1) n) (char alphabet (ldb (byte 6 6) triple)) #\=) out)
                 (write-char (if (< (+ i 2) n) (char alphabet (ldb (byte 6 0) triple)) #\=)
                             out))))))

(defun ws-accept-key (client-key)
  (base64-encode
   (sha1 (sb-ext:string-to-octets
          (concatenate 'string client-key "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
          :external-format :latin-1))))

;;; -------------------------------------------------------------- handshake

(defun read-http-headers (stream)
  "Read up to the blank line. Returns a list of header lines (first is the
request line), or NIL on EOF / oversized request."
  (let ((buffer (make-array 0 :element-type 'character :adjustable t :fill-pointer t))
        (lines '()))
    (loop for count from 0
          do (when (> count 16384) (return-from read-http-headers nil))
             (let ((byte (read-byte stream nil nil)))
               (unless byte (return-from read-http-headers nil))
               (cond ((= byte 10)
                      (let ((line (string-right-trim '(#\Return) (coerce buffer 'simple-string))))
                        (when (zerop (length line)) (return))
                        (push line lines)
                        (setf (fill-pointer buffer) 0)))
                     (t (vector-push-extend (code-char byte) buffer)))))
    (nreverse lines)))

(defun header-value (lines name)
  (dolist (line (rest lines))
    (let ((colon (position #\: line)))
      (when (and colon (string-equal name (subseq line 0 colon)))
        (return (string-trim " " (subseq line (1+ colon))))))))

(defvar *allowed-origins* nil
  "NIL: only pages served from this machine may connect (the default, which
protects a developer's own computer). :ANY: any page may connect; used when
hosting, where every visitor gets an anonymous game of their own and there is
nothing to steal. Otherwise a list of exact origin strings.")

(defun local-origin-p (origin)
  (some (lambda (prefix)
          (let ((n (length prefix)))
            (and (>= (length origin) n)
                 (string-equal prefix origin :end2 n)
                 (or (= (length origin) n) (char= (char origin n) #\:)))))
        '("http://localhost" "http://127.0.0.1" "http://[::1]"
          "https://localhost" "https://127.0.0.1")))

(defun origin-allowed-p (origin)
  "Browsers always send Origin on WebSocket handshakes; non-browser tools
usually send none, and are allowed."
  (cond ((null origin) t)
        ((eq *allowed-origins* :any) t)
        ((null *allowed-origins*) (local-origin-p origin))
        (t (or (local-origin-p origin)
               (member origin *allowed-origins* :test #'string-equal)))))

(defun write-ascii (stream text)
  (write-sequence (sb-ext:string-to-octets text :external-format :latin-1) stream))

(defun http-respond (stream status content-type body &key (cache "no-cache") head-only)
  "Write a complete HTTP/1.1 response and flush. BODY is an octet vector."
  (let ((crlf (coerce '(#\Return #\Newline) 'string)))
    (write-ascii stream
                 (format nil "HTTP/1.1 ~A~AContent-Type: ~A~AContent-Length: ~D~ACache-Control: ~A~AX-Content-Type-Options: nosniff~AConnection: close~A~A"
                         status crlf content-type crlf (length body) crlf cache crlf crlf
                         crlf crlf))
    (unless head-only (write-sequence body stream))
    (finish-output stream)))

(defun http-respond-text (stream status text)
  (http-respond stream status "text/plain; charset=utf-8"
                (sb-ext:string-to-octets text :external-format :utf-8)))

(defun ws-accept (stream key)
  "Send the 101 response that completes a WebSocket opening handshake."
  (let ((crlf (coerce '(#\Return #\Newline) 'string)))
    (write-ascii stream
                 (format nil "HTTP/1.1 101 Switching Protocols~AUpgrade: websocket~AConnection: Upgrade~ASec-WebSocket-Accept: ~A~A~A"
                         crlf crlf crlf (ws-accept-key key) crlf crlf))
    (finish-output stream)))

;;; ----------------------------------------------------------------- frames

;; Commands are tiny; a small ceiling keeps a hostile client cheap.
(defconstant +ws-max-payload+ (* 64 1024))

(defun ws-write-frame (stream opcode payload)
  (let ((len (length payload)))
    (write-byte (logior #x80 opcode) stream)
    (cond ((< len 126) (write-byte len stream))
          ((< len 65536)
           (write-byte 126 stream)
           (write-byte (ldb (byte 8 8) len) stream)
           (write-byte (ldb (byte 8 0) len) stream))
          (t
           (write-byte 127 stream)
           (loop for shift from 56 downto 0 by 8
                 do (write-byte (ldb (byte 8 shift) len) stream))))
    (write-sequence payload stream)
    (finish-output stream)))

(defun ws-write-text (stream text)
  (ws-write-frame stream 1 (sb-ext:string-to-octets text :external-format :utf-8)))

(defun ws-read-frame (stream)
  "Returns (values fin opcode payload), or NIL at end of stream."
  (let ((b0 (read-byte stream nil nil))
        (b1 (read-byte stream nil nil)))
    (unless (and b0 b1) (return-from ws-read-frame nil))
    (let ((len (logand b1 127))
          (masked (logbitp 7 b1)))
      (flet ((read-uint (bytes)
               (let ((v 0))
                 (dotimes (i bytes v)
                   (let ((byte (read-byte stream nil nil)))
                     (unless byte (return-from ws-read-frame nil))
                     (setf v (logior (ash v 8) byte)))))))
        (cond ((= len 126) (setf len (read-uint 2)))
              ((= len 127) (setf len (read-uint 8))))
        (when (> len +ws-max-payload+) (return-from ws-read-frame nil))
        (let ((mask (and masked (make-array 4 :element-type '(unsigned-byte 8))))
              (payload (make-array len :element-type '(unsigned-byte 8))))
          (when masked
            (unless (= (read-sequence mask stream) 4) (return-from ws-read-frame nil)))
          (unless (= (read-sequence payload stream) len) (return-from ws-read-frame nil))
          (when masked
            (dotimes (i len)
              (setf (aref payload i) (logxor (aref payload i) (aref mask (logand i 3))))))
          (values (logbitp 7 b0) (logand b0 15) payload))))))

(defun ws-read-message (stream write-lock)
  "Next complete text message as a string, or NIL when the peer closed.
Answers pings; reassembles fragmented messages."
  (let ((parts '()) (size 0))
    (loop
      (multiple-value-bind (fin opcode payload) (ws-read-frame stream)
        (unless payload (return nil))
        (case opcode
          (8 (ignore-errors
              (sb-thread:with-mutex (write-lock) (ws-write-frame stream 8 payload)))
           (return nil))
          (9 (sb-thread:with-mutex (write-lock) (ws-write-frame stream 10 payload)))
          (10 nil)
          ((0 1)
           (push payload parts)
           (incf size (length payload))
           (when (> size +ws-max-payload+) (return nil))
           (when fin
             (let ((all (make-array size :element-type '(unsigned-byte 8))) (at 0))
               (dolist (part (nreverse parts))
                 (replace all part :start1 at)
                 (incf at (length part)))
               (return (sb-ext:octets-to-string all :external-format :utf-8)))))
          (t (return nil)))))))
