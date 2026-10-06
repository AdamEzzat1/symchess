;;;; run.lisp -- start the engine server:   sbcl --script engine/run.lisp
;;;; (use --load instead of --script if you want the REPL afterwards)

(require :asdf)
(asdf:load-asd (merge-pathnames "symchess.asd" (or *load-truename* *default-pathname-defaults*)))
(asdf:load-system "symchess")
(symchess:main)
