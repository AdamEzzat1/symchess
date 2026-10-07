;;;; symchess.asd -- Common Lisp engine core for the symbolic chess AI.
;;;; No third-party dependencies: only SBCL contribs.

(asdf:defsystem "symchess"
  :description "Classical alpha-beta chess engine with a Prolog knowledge layer."
  :version "0.1.0"
  :depends-on ((:require "sb-bsd-sockets") (:require "sb-md5"))
  :serial t
  :pathname "src/"
  :components ((:file "package")
               (:file "json")
               (:file "board")
               (:file "movegen")
               (:file "notation")
               (:file "pgn")
               (:file "eval")
               (:file "search")
               (:file "prolog-bridge")
               (:file "websocket")
               (:file "game")
               (:file "server")
               (:file "uci")
               (:file "experiment")))
