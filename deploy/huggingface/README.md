---
title: SymChess
emoji: ♟️
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
short_description: Play an explainable chess engine (Lisp + Prolog + React)
---

# SymChess

Play against a classical chess engine and switch to **Analysis** to see why it
chose each move: pins, forks, weak squares and plans are drawn on the board,
and every sentence of the explanation is labelled with where it came from.

This is a small free server. A limited number of people can play at once; if
it is full, the page waits and lets you in when a seat frees up. Sessions that
are idle for 15 minutes are disconnected.

Source and design notes: https://github.com/AdamEzzat1/symchess
