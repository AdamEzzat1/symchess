;;;; uci.lisp -- run the engine under the Universal Chess Interface:
;;;;   sbcl --script engine/uci.lisp
;;;; Point a chess program (Arena, Cute Chess, Banksia...) at that command.

(require :asdf)
(asdf:load-asd (merge-pathnames "symchess.asd" (or *load-truename* *default-pathname-defaults*)))
;; Nothing but UCI may be written to standard output.
(let ((*standard-output* (make-broadcast-stream)))
  (asdf:load-system "symchess"))
(symchess:uci-loop)
