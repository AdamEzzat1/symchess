// Screenshots of the views worth showing, taken from the running app.
//
//   1. start the engine:     sbcl --script engine/run.lisp
//   2. start the dev server: npm run dev            (from web/)
//   3. run:                  npm run screenshots    (from web/)
//
// Writes docs/screenshots/*.png. Drives a headless Chrome over its debugging
// port and waits in real time for each view, because the engine answers over
// a WebSocket and a search takes as long as it takes. After each wait it
// checks that the thing the picture is meant to show is on the page, and
// fails if it is not, so a picture of an empty panel is never saved quietly.
//
// Needs Node >= 22 and Chrome. Set CHROME to its path if it is not found.

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.env.APP_URL ?? 'http://localhost:5173';
const OUT = fileURLToPath(new URL('../../docs/screenshots/', import.meta.url));
const PORT = 9333;
const CHROME =
  process.env.CHROME ??
  [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].find((path) => existsSync(path));

const enc = encodeURIComponent;
const position = (fen, rest) => `${APP}/?fen=${enc(fen)}&${rest}`;

/** name, address, a page expression that must become true, and what it shows. */
const VIEWS = [
  ['analysis', position('r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', 'analyse=1&layers=all'),
    `document.querySelectorAll('.cards .card').length > 0 && /d6/.test(document.body.innerText)`,
    'the flat board in analysis: a pinned knight, the best line, the fact cards'],
  ['trace', position('4k3/8/8/4n3/8/8/4R3/4K3 w - - 0 1', 'analyse=1&trace=hanging&layers=all'),
    `document.querySelectorAll('.chain-step').length === 6 && !!document.querySelector('.chain .explain-item')`,
    'the reasoning debugger: a fact followed back to its rule and forward to the search’s verdict'],
  ['why-not', position('4k3/8/4p3/3p4/8/8/3Q4/4K3 w - - 0 1', 'whynot=d2d5&layers=all'),
    `!!document.querySelector('.whynot .summary') && !!document.querySelector('.caution')`,
    '“why not this move?”: the comparison, worded as a depth-6 preference, with its caution'],
  ['review', `${APP}/?review=sample&ply=20`,
    `document.querySelectorAll('[class*=replay-step]').length > 20`,
    'a reviewed game: the evaluation graph and what one move changed'],
  ['results', `${APP}/?results=1`,
    `document.querySelectorAll('.sheet-run').length >= 5`,
    'the results page: recorded tables, each with the run it came from'],
  ['board-3d', position('r1bqkbnr/ppp2ppp/2np4/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4', 'analyse=1&pieces=3d'),
    `!!document.querySelector('canvas')`,
    'the 3D board'],
];

if (!CHROME) {
  console.error('Chrome was not found. Set CHROME to its path.');
  process.exit(1);
}

const profile = mkdtempSync(join(tmpdir(), 'symchess-shots-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--hide-scrollbars', '--window-size=1500,1000', '--force-device-scale-factor=1',
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function debuggerUrl() {
  for (let i = 0; i < 50; i++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = pages.find((p) => p.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // not listening yet
    }
    await sleep(200);
  }
  throw new Error('Chrome did not open its debugging port');
}

let failed = 0;
try {
  const socket = new WebSocket(await debuggerUrl());
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const pending = new Map();
  socket.onmessage = (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  const call = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  const truthy = async (expression) =>
    (await call('Runtime.evaluate', { expression: `Boolean(${expression})`, returnByValue: true })).result?.result?.value === true;

  await call('Page.enable');
  mkdirSync(OUT, { recursive: true });
  for (const [name, url, ready, shows] of VIEWS) {
    await call('Page.navigate', { url });
    let ok = false;
    for (let waited = 0; waited < 45_000 && !ok; waited += 500) {
      await sleep(500);
      ok = await truthy(ready);
    }
    if (!ok) {
      failed += 1;
      console.error(`FAIL  ${name}: the page never showed ${shows}`);
      continue;
    }
    await sleep(1200); // let arrows and pieces finish moving
    const shot = await call('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.result.data, 'base64'));
    console.log(`  ok    ${name}.png  ${shows}`);
  }
  socket.close();
} finally {
  // On Windows, killing the launcher leaves Chrome's own processes running.
  if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(chrome.pid)], { stdio: 'ignore' });
  else chrome.kill();
  await sleep(1500);
  // Chrome can still be letting go of its profile; a leftover temp folder is not a failure.
  try {
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    console.error(`  note  could not remove ${profile}`);
  }
}
process.exit(failed === 0 ? 0 : 1);
