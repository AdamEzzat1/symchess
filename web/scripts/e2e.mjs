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
  return e.material + e.placement + e.pawnStructure + e.bishopPair === e.total;
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

// leave the engine in a clean default state for the UI
send({ type: 'set_engine_depth', depth: 6, moveTimeMs: 3000 });
send({ type: 'new_game', humanColor: 'white', mode: 'play' });
await until((m) => m.type === 'game_state' && m.settings.mode === 'play' && m.history.length === 0, 'reset');

mkdirSync(fileURLToPath(new URL('../../protocol/', import.meta.url)), { recursive: true });
writeFileSync(OUT, captured.join('\n') + '\n');
console.log(`\nall checks passed; captured ${captured.length} engine messages -> protocol/engine-messages.jsonl`);
socket.close();
