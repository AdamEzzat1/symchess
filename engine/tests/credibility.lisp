;;;; credibility.lisp -- how often are SymChess's explanations right?
;;;;
;;;;   sbcl --script engine/tests/credibility.lisp            the report
;;;;   sbcl --script engine/tests/credibility.lisp deep       also check the move labels with a deeper search
;;;;   sbcl --script engine/tests/credibility.lisp no-prolog  what is left when Prolog cannot be started
;;;;
;;;; Section 5 checks that every sentence can be traced (to a rule in the
;;;; index, a check, and facts that exist) and counts where Prolog and the
;;;; search disagree.
;;;;
;;;; Three things are measured and never mixed:
;;;;   motif accuracy        does Prolog report the motifs that are really there, and no others?
;;;;   move accuracy         does the search, at Club level's limits, play a correct move?
;;;;   explanation accuracy  does the explanation give each motif the right status,
;;;;                         and is every "confirmed" backed by the search's own line?
;;;;
;;;; Exit status is 0 whatever the scores are: this is a measurement, not a
;;;; pass/fail test. It is non-zero only if the script itself breaks.

(require :asdf)
(asdf:load-asd (merge-pathnames "../symchess.asd" *load-truename*))
(asdf:load-system "symchess")

(in-package :symchess)

(load (merge-pathnames "credibility-positions.lisp" *load-truename*))

(defparameter *audited*
  '("pin" "skewer" "fork" "hanging" "threatened" "overloaded"
    "discovered_attack" "pinned_defender" "trapped"))

;; Club level's limits: the search a visitor actually gets.
(defparameter *depth* 6)
(defparameter *time-ms* 2000)

(defparameter *mode* (second sb-ext:*posix-argv*))

(when (equal *mode* "no-prolog")
  (setf *swipl-program* "symchess-no-such-prolog"
        *error-output* (make-broadcast-stream)))

(defun field (plist key)
  (loop for (k v) on plist by #'cddr when (equal k key) return v))

(defun entry-key (entry key) (getf (cdddr entry) key))

(defvar *known-rules* nil "Ids in the rule index, filled before the first set is run.")

(defun untraceable (item analysis)
  "NIL if ITEM can be followed back, else a word for what is missing: its rule
must be in the index; unless it is a plain measurement it must have a check
that is in the index and a basis; and every fact it cites must be a fact of
the position."
  (let ((rule (jget item "rule"))
        (check (jget item "check"))
        (ids (mapcar (lambda (f) (jget f "id")) (and analysis (jget analysis "facts" '())))))
    (cond ((not (member rule *known-rules* :test #'equal)) "rule")
          ((and (not (equal (jget item "status") "measured"))
                (not (and (member check *known-rules* :test #'equal)
                          (stringp (jget item "basis")))))
           "check")
          ((notevery (lambda (id) (member id ids :test #'equal)) (jget item "facts" '())) "facts")
          (t nil))))

(defun percent (part whole)
  (if (zerop whole) "   n/a" (format nil "~5,1F%" (* 100.0 (/ part whole)))))

;;; ------------------------------------------------------------ motif accuracy

(defun audited-facts (analysis)
  "Every audited fact Prolog reported, as (kind square...): all the squares the fact names."
  (loop for fact in (jget analysis "facts" '())
        for kind = (jget fact "kind")
        when (member kind *audited* :test #'equal)
          collect (cons kind (jget fact "squares" '()))))

(defun score-motifs (expected reported)
  "Three lists: expected and reported, expected but missing, reported but not
expected. A label (kind square) is met by one reported fact of that kind that
names that square; each reported fact can meet only one label."
  (let ((left (copy-list reported)) (hit '()) (missed '()))
    (dolist (want expected)
      (let ((found (find-if (lambda (fact)
                              (and (equal (first fact) (first want))
                                   (member (second want) (rest fact) :test #'equal)))
                            left)))
        (if found
            (progn (push want hit)
                   (setf left (remove found left :test #'eq :count 1)))
            (push want missed))))
    (values (nreverse hit) (nreverse missed)
            ;; Shown by the first square the fact names.
            (mapcar (lambda (fact) (list (first fact) (second fact))) left))))

;;; ------------------------------------------------- explanation: an independent check
;;; The engine decides "confirmed" inside BUILD-EXPLANATION. This asks a
;;; stricter question without using that code: does the line the search
;;; expects actually deliver what the sentence says?

(defun line-delivers-p (p result item)
  (let* ((motif (jget item "motif"))
         (pv (search-result-pv result))
         (best (search-result-best-move result)))
    (cond ((equal motif "gives_check")
           (let ((q (copy-position p)))
             (make-move q best)
             (in-check-p q)))
          ;; Everything else that is called confirmed is a claim about winning
          ;; something: the line must end at least a pawn up, or in mate.
          (t (or (> (search-result-score result) +mate-bound+)
                 (>= (pv-material-swing p pv) 100))))))

;;; -------------------------------------------------- hanging facts against SEE
;;; A machine check that needs no labels: if Prolog says an enemy piece is
;;; hanging, the side to move should have a legal capture of it that the
;;; exchange count says wins material.

(defun hanging-cross-check (p analysis)
  "Two values: hanging facts about the opponent's pieces, and how many of them
have a legal capture with a positive exchange value."
  (let ((mine (side-name (pos-side p))) (claims 0) (backed 0)
        (legal (legal-moves p)))
    (dolist (fact (jget analysis "facts" '()))
      (when (and (equal (jget fact "kind") "hanging")
                 ;; A hanging fact is filed under the side that can take.
                 (equal (jget fact "side") mine))
        (incf claims)
        (let ((square (first (jget fact "squares"))))
          (when (some (lambda (m)
                        (and (move-capture-p m)
                             (string= (square-name (move-to m)) square)
                             (plusp (see p m))))
                      legal)
            (incf backed)))))
    (values claims backed)))

;;; -------------------------------------------------------------------- the run

(defun run-set (key title positions)
 (let ((kinds (make-hash-table :test #'equal))   ; kind -> (tp fp fn)
      (categories (make-hash-table :test #'equal))
      (category-order '())
      (false-positives '()) (false-negatives '())
      (move-total 0) (move-right 0) (move-misses '())
      (says-total 0) (says-right 0) (says-misses '())
      (confirmed-total 0) (confirmed-bad '())
      (hanging-claims 0) (hanging-backed 0)
      (deep-disagreements '())
      (why-total 0) (why-right 0) (why-misses '())
      (warned-total 0) (warned-bad '())
      (traced-total 0) (traced-bad '()) (citing 0)
      (tally (list 0 0 0 0))            ; confirmed unconfirmed overruled unchecked
      (ranked 0) (same-move 0)
      (differ-labelled 0) (differ-search-right 0) (differ-prolog-right 0)
      (prolog-ok t)
      (nodes 0) (time 0) (searched 0))
  (flet ((bump (table key index &optional (by 1))
           (let ((cell (or (gethash key table)
                           (setf (gethash key table) (list 0 0 0 0 0)))))
             (incf (nth index cell) by))))
    (set-engine-features)
    (format t "~%######## ~A: ~D labelled positions~%~%" title (length positions))
    (dolist (entry positions)
      (destructuring-bind (id category fen &key expect best avoid says) entry
        (unless (member category category-order :test #'equal)
          (setf category-order (append category-order (list category))))
        (let* ((p (pos-from-fen fen))
               (analysis (symbolic-analysis p)))
          (bump categories category 0)
          ;; --- motifs
          (if (null analysis)
              (setf prolog-ok nil)
              (multiple-value-bind (hit missed extra) (score-motifs expect (audited-facts analysis))
                (dolist (m hit) (bump kinds (first m) 0))
                (dolist (m extra) (bump kinds (first m) 1) (push (list id m) false-positives))
                (dolist (m missed) (bump kinds (first m) 2) (push (list id m) false-negatives))
                (bump categories category 1 (length hit))
                (bump categories category 2 (length extra))
                (bump categories category 3 (length missed))
                (multiple-value-bind (claims backed) (hanging-cross-check p analysis)
                  (incf hanging-claims claims)
                  (incf hanging-backed backed))))
          ;; --- move
          (when (or best avoid says)
            (tt-clear)
            (let* ((result (search-position p :max-depth *depth* :time-ms *time-ms*))
                   (uci (move-uci (search-result-best-move result)))
                   (right (and (or (null best) (member uci best :test #'string=))
                               (not (member uci avoid :test #'string=)))))
              (incf searched)
              (incf nodes (search-result-nodes result))
              (incf time (search-result-time-ms result))
              (when (or best avoid)
                (incf move-total)
                (if right
                    (progn (incf move-right) (bump categories category 4))
                    (push (list id uci (or best (list "not" (first avoid)))) move-misses)))
              ;; --- explanation
              (when analysis
                (let* ((fields (build-explanation p result analysis :analysis))
                       (items (field fields "items"))
                       (agreement (field fields "agreement")))
                  ;; --- can every sentence be followed back?
                  (dolist (item items)
                    (incf traced-total)
                    (when (jget item "facts" '()) (incf citing))
                    (let ((missing (untraceable item analysis)))
                      (when missing (push (list id missing (jget item "text")) traced-bad))))
                  ;; --- where the two layers stand
                  (loop for key in '("confirmed" "unconfirmed" "overruled" "unchecked")
                        for i from 0
                        do (incf (nth i tally) (jget agreement key 0)))
                  (let ((top (first (jget analysis "moves"))))
                    (when (and top (plusp (jget top "score" 0)))
                      (incf ranked)
                      (cond ((string= (jget top "uci") uci) (incf same-move))
                            (best
                             ;; They differ, and the position has a labelled best move.
                             (incf differ-labelled)
                             (when (member uci best :test #'string=) (incf differ-search-right))
                             (when (member (jget top "uci") best :test #'string=)
                               (incf differ-prolog-right))))))
                  (dolist (item items)
                    (when (and (equal (jget item "source") "prolog")
                               (equal (jget item "status") "confirmed")
                               (stringp (jget item "motif")))
                      (incf confirmed-total)
                      (unless (line-delivers-p p result item)
                        (push (list id (jget item "motif") (jget item "text")) confirmed-bad))))
                  (when (and says right)
                    (dolist (want says)
                      (incf says-total)
                      (let ((got (find (first want) items
                                       :key (lambda (i) (jget i "motif")) :test #'equal)))
                        (if (and got (equal (jget got "status") (second want)))
                            (incf says-right)
                            (push (list id want (and got (jget got "status"))) says-misses)))))))
              ;; --- "why not this move?": does the verdict match the label?
              ;; A move labelled as one to avoid must be rated a mistake, a
              ;; blunder or a missed chance; a move labelled best must be rated the engine's
              ;; choice or about as good. And a Prolog warning may be called
              ;; confirmed only where the search also rates the move worse.
              (flet ((ask (uci wanted)
                       (let ((m (parse-uci-move p uci)))
                         (when m
                           (let* ((alt (if (= m (search-result-best-move result))
                                           result
                                           (search-line p m (search-result-depth result))))
                                  (answer (build-counterfactual p result alt analysis))
                                  (verdict (field answer "verdict")))
                             (incf why-total)
                             (if (member verdict wanted :test #'string=)
                                 (incf why-right)
                                 (push (list id uci verdict wanted) why-misses))
                             (dolist (item (field answer "items"))
                               (incf traced-total)
                               (when (jget item "facts" '()) (incf citing))
                               (let ((missing (untraceable item analysis)))
                                 (when missing (push (list id missing (jget item "text")) traced-bad))))
                             (dolist (item (field answer "items"))
                               (when (and (equal (jget item "source") "prolog")
                                          (equal (jget item "status") "confirmed")
                                          (eql 0 (search "Prolog warned" (jget item "text"))))
                                 (incf warned-total)
                                 (unless (member verdict '("mistake" "blunder" "missed_chance")
                                                 :test #'string=)
                                   (push (list id uci (jget item "text")) warned-bad)))))))))
                ;; "Missed chance" counts: a move that throws a win away for a
                ;; draw is one to avoid, though it does not lose.
                (dolist (uci avoid) (ask uci '("mistake" "blunder" "missed_chance")))
                (when best (ask (first best) '("best" "as_good"))))
              ;; --- optional: is the label itself right?
              (when (and (equal *mode* "deep") (or best avoid))
                (tt-clear)
                (let* ((deep (search-position p :max-depth 10 :time-ms 20000))
                       (move (move-uci (search-result-best-move deep))))
                  (unless (and (or (null best) (member move best :test #'string=))
                               (not (member move avoid :test #'string=)))
                    (push (list id move (search-result-depth deep)) deep-disagreements)))))))))

    ;; ---------------------------------------------------------------- report
    (format t "== 1. Motif accuracy (Prolog)~%")
    (if (not prolog-ok)
        (format t "   Prolog could not be started: motif and explanation accuracy were not measured.~%")
        (let ((tp 0) (fp 0) (fn 0))
          (format t "   ~18A ~4@A ~4@A ~4@A  ~9@A ~7@A~%" "motif" "hit" "extra" "miss" "precision" "recall")
          (dolist (kind *audited*)
            (destructuring-bind (a b c &rest ignore) (gethash kind kinds (list 0 0 0 0 0))
              (declare (ignore ignore))
              (incf tp a) (incf fp b) (incf fn c)
              (format t "   ~18A ~4D ~4D ~4D  ~9@A ~7@A~%" kind a b c
                      (percent a (+ a b)) (percent a (+ a c)))))
          (format t "   ~18A ~4D ~4D ~4D  ~9@A ~7@A~%" "all" tp fp fn
                  (percent tp (+ tp fp)) (percent tp (+ tp fn)))
          (format t "~%   reported but not really there:~%")
          (if false-positives
              (dolist (x (reverse false-positives))
                (format t "     ~A: ~A on ~A~%" (first x) (first (second x)) (second (second x))))
              (format t "     none~%"))
          (format t "   really there but not reported:~%")
          (if false-negatives
              (dolist (x (reverse false-negatives))
                (format t "     ~A: ~A on ~A~%" (first x) (first (second x)) (second (second x))))
              (format t "     none~%"))
          (format t "~%   hanging enemy pieces that a legal capture really wins (exchange count): ~D of ~D~%"
                  hanging-backed hanging-claims)))

    (format t "~%== 2. Move accuracy (Lisp search)~%")
    (format t "   correct move played: ~D of ~D (~A)~%" move-right move-total (percent move-right move-total))
    (format t "   ~D searches, ~:D positions, ~,1F s in all~%" searched nodes (/ time 1000.0))
    (dolist (x (reverse move-misses))
      (format t "     ~A: played ~A, wanted ~{~A~^ ~}~%" (first x) (second x) (third x)))

    (format t "~%== 3. Explanation accuracy~%")
    (cond ((not prolog-ok)
           (format t "   not measured without Prolog. Explanations then contain search and evaluation sentences only.~%"))
          (t
           (format t "   labelled statuses matched: ~D of ~D (~A)~%" says-right says-total (percent says-right says-total))
           (dolist (x (reverse says-misses))
             (format t "     ~A: wanted ~A ~A, got ~A~%" (first x) (first (second x)) (second (second x))
                     (or (third x) "no such sentence")))
           (format t "   \"confirmed\" sentences backed by the search's own line: ~D of ~D~%"
                   (- confirmed-total (length confirmed-bad)) confirmed-total)
           (dolist (x (reverse confirmed-bad))
             (format t "     ~A: ~A -- ~A~%" (first x) (second x) (third x)))))

    (format t "~%== 4. \"Why not this move?\" verdicts~%")
    (format t "   verdict matched the label: ~D of ~D (~A)~%" why-right why-total (percent why-right why-total))
    (dolist (x (reverse why-misses))
      (format t "     ~A: ~A was rated ~A, wanted ~{~A~^ or ~}~%" (first x) (second x) (third x) (fourth x)))
    (format t "   Prolog warnings called confirmed where the search also rates the move worse: ~D of ~D~%"
            (- warned-total (length warned-bad)) warned-total)
    (dolist (x (reverse warned-bad))
      (format t "     ~A: ~A -- ~A~%" (first x) (second x) (third x)))

    (format t "~%== 5. Tracing claims, and where Prolog and the search differ~%")
    (format t "   sentences that name a rule in the index, a check and existing facts: ~D of ~D~%"
            (- traced-total (length traced-bad)) traced-total)
    (dolist (x (reverse traced-bad))
      (format t "     ~A: no ~A -- ~A~%" (first x) (second x) (third x)))
    (format t "   of those, sentences that cite a fact of the position: ~D~%" citing)
    (format t "   Prolog's sentences about the chosen move: ~D confirmed, ~D unconfirmed, ~D overruled, ~D not checkable~%"
            (first tally) (second tally) (third tally) (fourth tally))
    (format t "   Prolog's top-ranked move was the search's move: ~D of ~D positions where Prolog ranked one~%"
            same-move ranked)
    (format t "   where they differed and a best move is labelled (~D): the search's move was a labelled one ~D times, Prolog's ~D~%"
            differ-labelled differ-search-right differ-prolog-right)

    (format t "~%== By category~%")
    (format t "   ~24A ~9@A ~4@A ~5@A ~4@A ~6@A~%" "category" "positions" "hit" "extra" "miss" "moves")
    (dolist (category category-order)
      (destructuring-bind (n a b c d) (gethash category categories)
        (format t "   ~24A ~9D ~4D ~5D ~4D ~6D~%" category n a b c d)))

    (when (equal *mode* "deep")
      (format t "~%== Label check: a depth-10 search against the move labels~%")
      (if deep-disagreements
          (dolist (x (reverse deep-disagreements))
            (format t "   ~A: the deeper search prefers ~A (reached depth ~D)~%" (first x) (second x) (third x)))
          (format t "   the deeper search agrees with every label~%")))

    ;; ------------------------------------------------- the same, for the record
    (let ((tp 0) (fp 0) (fn 0))
      (dolist (kind *audited*)
        (destructuring-bind (a b c &rest ignore) (gethash kind kinds (list 0 0 0 0 0))
          (declare (ignore ignore))
          (incf tp a) (incf fp b) (incf fn c)))
      (flet ((named (x) (format nil "~A: ~A on ~A" (first x) (first (second x)) (second (second x)))))
        (obj "id" key
             "title" title
             "positions" (length positions)
             "prolog" (jbool prolog-ok)
             "motifs" (obj "found" tp "extra" fp "missed" fn
                           "reportedButNotThere" (mapcar #'named (reverse false-positives))
                           "thereButNotReported" (mapcar #'named (reverse false-negatives)))
             "moves" (obj "right" move-right "of" move-total
                          "missed" (mapcar (lambda (x) (format nil "~A: played ~A" (first x) (second x)))
                                           (reverse move-misses)))
             "statuses" (obj "right" says-right "of" says-total)
             "confirmedBacked" (obj "right" (- confirmed-total (length confirmed-bad)) "of" confirmed-total)
             "whyNot" (obj "right" why-right "of" why-total)
             "warningsConfirmed" (obj "right" (- warned-total (length warned-bad)) "of" warned-total)
             "traceable" (obj "right" (- traced-total (length traced-bad)) "of" traced-total)
             "prologSentences" (obj "confirmed" (first tally) "unconfirmed" (second tally)
                                    "overruled" (third tally) "unchecked" (fourth tally))
             "topMove" (obj "same" same-move "of" ranked
                            "differedWithLabel" differ-labelled
                            "searchRight" differ-search-right
                            "prologRight" differ-prolog-right)))))))

(setf *known-rules*
      (mapcar (lambda (rule) (jget rule "id")) (field (rule-index-fields) "rules")))

(format t "SymChess explanation benchmark~%")
(format t "rule index: ~D entries~%" (length *known-rules*))
(format t "search limits: depth ~D, ~D ms (Club level)~%" *depth* *time-ms*)
(let ((sets (list
             (run-set "development" "Development set (the rules were corrected against these)"
                      *credibility-positions*)
             (run-set "held-out" "Held-out set (labelled after the rules of milestone 5 were frozen)"
                      *held-out-positions*)
             (run-set "second-held-out" "Second held-out set (labelled for milestone 9, before the pin rule changed)"
                      *second-held-out-positions*))))
  ;; Only the plain run is recorded: the other modes answer different questions.
  (when (null *mode*)
    (format t "~%written to ~A~%"
            (enough-namestring
             (write-results
              "credibility"
              (obj "run" (run-metadata "sbcl --script engine/tests/credibility.lisp")
                   "what" "Labelled positions: does Prolog report the tactical facts that are really there, does the search play a right move, and does the explanation give each idea the right status?"
                   "depth" *depth*
                   "timeLimitMs" *time-ms*
                   "sets" sets))))))
(stop-prolog)
