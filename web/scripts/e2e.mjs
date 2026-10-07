// End-to-end check of the real engine over WebSocket, and capture of the
// messages it sends for the frontend contract test.
//
//   1. start the engine:   sbcl --script engine/run.lisp
//   2. run:                npm run e2e          (from web/)
//
// Exits non-zero on the first failed expectation. Needs Node >= 22 (global WebSocket).

import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const URL_ = process.env.VITE_ENGINE_URL ?? 'ws://127.0.0.1:8765';
const OUT = fileURLToPath(new URL('../../protocol/engine-messages.jsonl', import.meta.url));

const captured = [];
const queue = [];
let waiting = null;
let nextId = 1;

const socket = new WebSocket(URL_);
socket.onmessage = (event) => {
  captured.push(event.data);
  const message = JSON.parse(event.data);
  queue.push(message);
  if (waiting) waiting();
};
socket.onerror = () => fail(`cannot reach the engine at ${URL_} - is it running?`);

function fail(reason) {
  console.error(`FAIL  ${reason}`);
  process.exit(1);
}

function check(description, condition) {
  if (!condition) fail(description);
  console.log(`  ok    ${description}`);
}

/** Wait for the next message matching `predicate`, discarding earlier ones. */
async function until(predicate, label, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    while (queue.length > 0) {
      const message = queue.shift();
      if (predicate(message)) return message;
    }
    const left = deadline - Date.now();
    if (left <= 0) fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, left);
      waiting = () => {
        clearTimeout(timer);
        waiting = null;
        resolve();
      };
    });
  }
}

const send = (command) => socket.send(JSON.stringify({ ...command, id: nextId++ }));
const ofType = (type) => (m) => m.type === type;

await new Promise((resolve) => (socket.onopen = resolve));

console.log('connection');
const hello = await until(ofType('hello'), 'hello');
check('engine says hello with protocol 1', hello.protocol === 1);
check('Prolog knowledge layer is available', typeof hello.prolog === 'string');

console.log('new game');
send({ type: 'set_time_control', baseMs: null });
send({ type: 'set_engine_depth', depth: 5, moveTimeMs: 1500 });
let game = await until((m) => m.type === 'game_state' && m.settings.depth === 5, 'settings applied');
const previousId = game.positionId;
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
game = await until((m) => m.type === 'game_state' && m.positionId > previousId, 'fresh game');
check('20 legal moves in the start position', game.legalMoves.length === 20);
check('every legal move carries SAN from the engine', game.legalMoves.every((m) => m.san.length >= 2));
const rootSymbolic = await until(
  (m) => m.type === 'symbolic_analysis' && m.positionId === game.positionId,
  'symbolic analysis of the start position',
);
check('start position has no symbolic facts', rootSymbolic.status === 'ok' && rootSymbolic.facts.length === 0);

console.log('rejections');
send({ type: 'make_move', uci: 'e2e5', positionId: game.positionId });
check('illegal move is refused', (await until(ofType('error'), 'illegal move error')).code === 'illegal_move');
send({ type: 'make_move', uci: 'e2e4', positionId: game.positionId - 1 });
check('move for a stale position is refused', (await until(ofType('error'), 'stale error')).code === 'stale_position');
send({ type: 'levitate' });
check('unknown command is refused', (await until(ofType('error'), 'unknown error')).code === 'unknown_command');

console.log('human move, engine reply');
const before = game.positionId;
send({ type: 'make_move', uci: 'e2e4', positionId: before });
const played = await until(ofType('move_played'), 'move_played');
check('engine echoes the human move as SAN', played.move.san === 'e4' && played.move.by === 'human');
const started = await until(ofType('search_started'), 'search_started');
check('search runs on the position after the human move', started.positionId === before + 1);
const complete = await until(ofType('search_complete'), 'search_complete');
check('search reports a best move and a principal variation', complete.bestMove !== null && complete.pv.length > 0);
check('evaluation breakdown sums to its total', (() => {
  const e = complete.evalBreakdown;
  // Every term the engine reports, whatever they are, must add up to its total.
  const { total, ...terms } = e;
  return Object.values(terms).reduce((sum, value) => sum + value, 0) === total;
})());
const explanation = await until(ofType('explanation'), 'explanation');
check('explanation is about the move the search chose', explanation.move.uci === complete.bestMove.uci);
check('explanation separates search facts from Prolog claims',
  explanation.items.some((i) => i.source === 'search' && i.status === 'measured') &&
  explanation.items.some((i) => i.source === 'prolog'));
const reply = await until((m) => m.type === 'move_played' && m.move.by === 'engine', 'engine move');
check('the move played is the move that was explained', reply.move.uci === explanation.move.uci);
game = await until((m) => m.type === 'game_state' && m.history.length === 2, 'state after reply');
check('it is the human turn again', game.turn === 'white' && !game.engineThinking);

console.log('analysis mode');
send({ type: 'set_mode', mode: 'analysis' });
game = await until((m) => m.type === 'game_state' && m.settings.mode === 'analysis', 'analysis mode');
send({ type: 'inspect_square', square: 'e4', positionId: game.positionId });
const inspection = await until(ofType('inspection'), 'inspection');
check('inspection describes the e4 pawn', inspection.piece?.type === 'pawn' && inspection.lines.length >= 3);
send({ type: 'request_analysis', positionId: game.positionId });
const analysis = await until((m) => m.type === 'search_complete' && m.purpose === 'analysis', 'analysis search');
check('analysis search does not move a piece', analysis.positionId === game.positionId);

console.log('a position with real tactics');
const beforeFen = game.positionId;
send({ type: 'new_game', mode: 'analysis', fen: 'r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq - 0 1' });
game = await until((m) => m.type === 'game_state' && m.positionId > beforeFen, 'pin position');
const pinned = await until((m) => m.type === 'symbolic_analysis' && m.positionId === game.positionId, 'pin analysis');
const pin = pinned.facts.find((f) => f.kind === 'pin');
check('Prolog reports the pin on c6', pin?.squares.includes('c6'));
check('the pin comes with its own drawing primitives', pin?.viz.some((v) => v.type === 'arrow' && v.from === 'b5'));
check('every plan cites facts that exist', pinned.plans.every((p) => p.because.every((id) => pinned.facts.some((f) => f.id === id))));

console.log('take back');
send({ type: 'make_move', uci: 'c8d7', positionId: game.positionId });
await until((m) => m.type === 'game_state' && m.history.length === 1, 'after Bd7');
send({ type: 'undo_move' });
game = await until((m) => m.type === 'game_state' && m.history.length === 0, 'after undo');
check('undo restores the position', game.fen.startsWith('r1bqkbnr/ppp2ppp/2np4/1B2p3'));

console.log('stop_search');
// Still in analysis mode on the pin position. Ask for far more search than
// could ever finish, then stop it.
send({ type: 'stop_search' });
send({ type: 'set_engine_depth', depth: 30, moveTimeMs: 60000 });
game = await until((m) => m.type === 'game_state' && m.settings.depth === 30, 'deep settings');
check('stop_search with nothing running is harmless', game.status === 'active');
send({ type: 'request_analysis', positionId: game.positionId });
await until((m) => m.type === 'search_update' && m.depth >= 3, 'search under way');
let stoppedAt = Date.now();
send({ type: 'stop_search' });
const halted = await until((m) => m.type === 'search_complete', 'search to stop', 5000);
check('stop_search ends a running analysis within a second', Date.now() - stoppedAt < 1000);
check('the stopped search still reports the best move it had', halted.stopped === true && halted.bestMove !== null && halted.depth < 30);
check('...and its explanation', (await until(ofType('explanation'), 'explanation after stop')).move.uci === halted.bestMove.uci);
check('stopping an analysis does not move a piece', halted.positionId === game.positionId);
send({ type: 'sync' });
check('the engine keeps answering commands afterwards', (await until(ofType('game_state'), 'sync after stop')).positionId === game.positionId);

const beforeStopGame = game.positionId;
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
game = await until((m) => m.type === 'game_state' && m.positionId > beforeStopGame, 'play game for stop');
send({ type: 'make_move', uci: 'e2e4', positionId: game.positionId });
await until(ofType('search_started'), 'engine thinking');
stoppedAt = Date.now();
send({ type: 'stop_search' });
const forced = await until((m) => m.type === 'move_played' && m.move.by === 'engine', 'engine to move now', 5000);
check('stop_search during the engine turn makes it move now, not stall', Date.now() - stoppedAt < 1500 && forced.move.uci.length >= 4);
game = await until((m) => m.type === 'game_state' && m.history.length === 2, 'state after forced move');
check('thinking state is cleared and it is the human turn', !game.engineThinking && game.turn === 'white');
send({ type: 'set_engine_depth', depth: 5, moveTimeMs: 1500 });
game = await until((m) => m.type === 'game_state' && m.settings.depth === 5, 'settings restored');

console.log('clock');
send({ type: 'set_time_control', baseMs: 1000, incrementMs: 0 });
const beforeClock = game.positionId;
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
game = await until((m) => m.type === 'game_state' && m.positionId > beforeClock && m.clocks.enabled, 'timed game');
check('clocks start at the base time and are not running before the first move',
  game.clocks.whiteMs === 1000 && game.clocks.blackMs === 1000 && game.clocks.running === null);
send({ type: 'make_move', uci: 'e2e4', positionId: game.positionId });
game = await until((m) => m.type === 'game_state' && m.history.length === 2, 'engine reply on the clock');
check('the human clock is running after the engine replies', game.clocks.running === 'white');
game = await until((m) => m.type === 'game_state' && m.status === 'timeout', 'flag fall', 5000);
check('the engine ends the game when the human flag falls', game.winner === 'black' && game.clocks.whiteMs === 0);
check('no legal moves are offered once the game is over', game.legalMoves.length === 0);
send({ type: 'make_move', uci: 'd2d4', positionId: game.positionId });
check('moves after the game is over are refused', (await until(ofType('error'), 'game over error')).code === 'game_over');
send({ type: 'set_time_control', baseMs: null });

console.log('difficulty levels');
check('hello lists the three levels', Array.isArray(hello.levels) && hello.levels.map((l) => l.id).join() === 'novice,club,expert');
send({ type: 'set_level', level: 'grandmaster' });
check('an unknown level is refused', (await until(ofType('error'), 'bad level')).code === 'bad_request');
send({ type: 'set_level', level: 'novice' });
game = await until((m) => m.type === 'game_state' && m.settings.level === 'novice', 'novice level');
check('choosing a level sets its depth', game.settings.depth === hello.levels[0].depth);
const beforeLevel = game.positionId;
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
game = await until((m) => m.type === 'game_state' && m.positionId > beforeLevel, 'novice game');
check('a new game keeps the level', game.settings.level === 'novice');
send({ type: 'make_move', uci: 'e2e4', positionId: game.positionId });
const noviceExplanation = await until(ofType('explanation'), 'novice explanation');
const noviceMove = await until((m) => m.type === 'move_played' && m.move.by === 'engine', 'novice reply');
check('the explanation opens by naming the level', noviceExplanation.items[0].text.startsWith('Novice level'));
check('the explanation is about the move the engine actually played', noviceExplanation.move.uci === noviceMove.move.uci);
await until((m) => m.type === 'game_state' && m.history.length === 2, 'state after novice reply');

// leave the engine in a clean default state for the UI
send({ type: 'set_level', level: 'club' });
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
await until((m) => m.type === 'game_state' && m.settings.mode === 'play' && m.history.length === 0, 'reset');

mkdirSync(fileURLToPath(new URL('../../protocol/', import.meta.url)), { recursive: true });
writeFileSync(OUT, captured.join('\n') + '\n');
console.log(`\nall checks passed; captured ${captured.length} engine messages -> protocol/engine-messages.jsonl`);
socket.close();
