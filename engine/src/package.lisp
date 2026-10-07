(defpackage :symchess
  (:use :cl)
  (:export
   ;; board
   #:pos #:pos-from-fen #:pos-to-fen #:copy-position #:+start-fen+
   #:pos-side #:pos-hash #:compute-hash
   ;; moves
   #:generate-moves #:legal-moves #:make-move #:unmake-move #:in-check-p
   #:perft #:move-uci #:move-san #:parse-uci-move
   ;; eval / search
   #:evaluate #:eval-breakdown #:search-position #:tt-clear
   #:set-engine-features #:see
   #:search-result-best-move #:search-result-score #:search-result-depth
   #:search-result-nodes #:search-result-pv #:search-result-time-ms
   ;; json
   #:json-encode #:json-decode #:obj #:jget
   ;; prolog
   #:symbolic-analysis #:prolog-inspect #:stop-prolog #:prolog-version
   ;; server
   #:start-server #:main
   #:sha1 #:base64-encode #:ws-accept-key))
