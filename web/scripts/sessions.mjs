// Multi-visitor checks for the hosted configuration. Starts its own engine on
// a spare port with a tiny seat limit and a short idle timeout, then verifies:
// private games, the seat limit, seats being freed, the idle timeout, the
// per-player ceilings, and that the engine serves the built frontend.
//
//   npm run build && npm run sessions        (from web/)
//
// Set SBCL to the sbcl executable if it is not on PATH.

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PORT = 8799;
const HTTP = `http://127.0.0.1:${PORT}`;
const WS = `ws://127.0.0.1:${PORT}/ws`;
const ORIGIN = 'https://somewhere-else.example';

const engine = spawn(process.env.SBCL ?? 'sbcl', ['--script', fileURLToPath(new URL('../../engine/run.lisp', import.meta.url))], {
  env: {
    ...process.env,
    SYMCHESS_PORT: String(PORT),
    SYMCHESS_MAX_SESSIONS: '2',
    SYMCHESS_IDLE_SECONDS: '3',
    SYMCHESS_ALLOWED_ORIGINS: '*',
    SYMCHESS_MAX_DEPTH: '4',
    SYMCHESS_MAX_MOVE_MS: '1000',
    SYMCHESS_LOG: '0',
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});

function finish(code) {
  engine.kill();
  process.exit(code);
}
function fail(reason) {
  console.error(`FAIL  ${reason}`);
  finish(1);
}
function check(description, condition) {
  if (!condition) fail(description);
  console.log(`  ok    ${description}`);
}

await new Promise((resolve) => {
  const timer = setTimeout(() => fail('engine did not start within 60 s'), 60_000);
  engine.stdout.on('data', (chunk) => {
    if (String(chunk).includes('listening')) {
      clearTimeout(timer);
      resolve();
    }
  });
  engine.on('exit', () => fail('engine exited early'));
});
engine.removeAllListeners('exit');

/** A tiny client: collects messages and lets a test wait for one. */
function client() {
  // Node's WebSocket sends no Origin by default; a browser on another site
  // would, so send one to prove the hosted origin policy lets it in.
  const socket = new WebSocket(WS, { headers: { Origin: ORIGIN } });
  const queue = [];
  let wake = null;
  let closedCode = null;
  socket.onmessage = (event) => {
    queue.push(JSON.parse(event.data));
    wake?.();
  };
  socket.onclose = (event) => {
    closedCode = event.code;
    wake?.();
  };
  return {
    send: (command) => socket.send(JSON.stringify(command)),
    close: () => socket.close(),
    get closedCode() {
      return closedCode;
    },
    async until(predicate, label, timeoutMs = 20_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        while (queue.length > 0) {
          const message = queue.shift();
          if (predicate(message)) return message;
        }
        if (closedCode !== null && queue.length === 0) fail(`socket closed while waiting for ${label}`);
        const left = deadline - Date.now();
        if (left <= 0) fail(`timed out waiting for ${label}`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, left);
          wake = () => {
            clearTimeout(timer);
            wake = null;
            resolve();
          };
        });
      }
    },
    async untilClosed(label, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      while (closedCode === null) {
        if (Date.now() > deadline) fail(`timed out waiting for ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return closedCode;
    },
  };
}
const state = (m) => m.type === 'game_state';

console.log('frontend is served by the engine');
const page = await fetch(`${HTTP}/`);
const html = await page.text();
check('GET / returns the app shell', page.status === 200 && html.includes('<div id="root">'));
const asset = /assets\/[^"]+\.js/.exec(html)?.[0];
const script = asset ? await fetch(`${HTTP}/${asset}`) : null;
check('the script it references is served as JavaScript',
  script?.status === 200 && script.headers.get('content-type').includes('javascript'));
check('unknown paths are 404, not files from disk',
  (await fetch(`${HTTP}/../engine/run.lisp`)).status === 404 && (await fetch(`${HTTP}/nope.txt`)).status === 404);
check('health check answers', (await (await fetch(`${HTTP}/healthz`)).text()) === 'ok');

console.log('each visitor gets a private game');
const alice = client();
const bob = client();
const helloA = await alice.until((m) => m.type === 'hello', 'alice hello');
await bob.until((m) => m.type === 'hello', 'bob hello');
check('hello reports the seat limit', helloA.maxPlayers === 2);
let a = await alice.until(state, 'alice state');
let b = await bob.until(state, 'bob state');
alice.send({ type: 'set_mode', mode: 'analysis' });
a = await alice.until((m) => state(m) && m.settings.mode === 'analysis', 'alice analysis mode');
alice.send({ type: 'make_move', uci: 'd2d4', positionId: a.positionId });
a = await alice.until((m) => state(m) && m.history.length === 1, 'alice move');
bob.send({ type: 'sync' });
b = await bob.until(state, 'bob resync');
check("alice's move did not appear in bob's game", a.history[0].san === 'd4' && b.history.length === 0);
check("alice's mode change did not leak to bob", b.settings.mode === 'play');
check('sequence numbers are per session', b.seq < 20);

console.log('per-player ceilings');
bob.send({ type: 'set_engine_depth', depth: 20, moveTimeMs: 60000 });
b = await bob.until(state, 'bob settings');
check('depth and time requests are clamped to the server ceiling',
  b.settings.depth === 4 && b.settings.moveTimeMs === 1000);

console.log('seat limit');
const carol = client();
const refusal = await carol.until((m) => m.type === 'error', 'carol refusal');
check('a third visitor is told the server is full', refusal.code === 'server_full');
check('...and is disconnected with "try again later"', (await carol.untilClosed('carol close')) === 1013);
bob.send({ type: 'make_move', uci: 'e2e4', positionId: b.positionId });
b = await bob.until((m) => state(m) && m.history.length === 2, 'bob game continues');
check('seated players are unaffected by the refusal', b.history[0].san === 'e4');

console.log('seats are freed');
alice.close();
await alice.untilClosed('alice close');
await new Promise((resolve) => setTimeout(resolve, 300));
const dave = client();
check('a new visitor is admitted once someone leaves', (await dave.until((m) => m.type === 'hello', 'dave hello')).protocol === 1);
const d = await dave.until(state, 'dave state');
check('the new visitor starts from a fresh game', d.history.length === 0);

console.log('idle timeout');
const idle = await dave.until((m) => m.type === 'error' && m.code === 'idle_timeout', 'idle notice', 10_000);
check('an idle visitor is told why they are being disconnected', idle.message.length > 10);
await dave.untilClosed('dave close');
await new Promise((resolve) => setTimeout(resolve, 300));
const erin = client();
check('the idle seat is available again', (await erin.until((m) => m.type === 'hello', 'erin hello')).players <= 2);

console.log('\nall session checks passed');
finish(0);
