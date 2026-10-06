import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseServerMessage, type ServerMessageType } from './protocol';
import { allSquares, arrowShape, formatClock, squareAt, squareCenter } from './geometry';

const SAMPLES = fileURLToPath(new URL('../../protocol/engine-messages.jsonl', import.meta.url));

describe('parseServerMessage', () => {
  it('accepts a well-formed message', () => {
    const raw = JSON.stringify({ type: 'error', seq: 4, code: 'illegal_move', message: 'no', inReplyTo: 2 });
    expect(parseServerMessage(raw)?.type).toBe('error');
  });

  it.each([
    ['not json', '{oops'],
    ['no type', JSON.stringify({ seq: 1 })],
    ['no seq', JSON.stringify({ type: 'error', code: 'x', message: 'y', inReplyTo: null })],
    ['unknown type', JSON.stringify({ type: 'telepathy', seq: 1 })],
    ['missing field', JSON.stringify({ type: 'error', seq: 1, code: 'x' })],
    [
      'overlay on a square that does not exist',
      JSON.stringify({
        type: 'inspection',
        seq: 1,
        positionId: 1,
        square: 'e4',
        piece: null,
        white: [],
        black: [],
        attacks: [],
        lines: [],
        viz: [{ type: 'ring', square: 'z9', style: 'pin' }],
      }),
    ],
  ])('rejects %s', (_name, raw) => {
    expect(parseServerMessage(raw)).toBeNull();
  });
});

// Contract test: messages captured from the real Lisp engine by
// `npm run e2e` must all pass the frontend's validator. If the engine's
// output shape drifts, this fails before a user ever sees a blank panel.
describe.skipIf(!existsSync(SAMPLES))('contract with the real engine', () => {
  const lines = existsSync(SAMPLES) ? readFileSync(SAMPLES, 'utf8').split('\n').filter(Boolean) : [];

  it('every captured engine message validates', () => {
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(parseServerMessage(line), line.slice(0, 160)).not.toBeNull();
    }
  });

  it('the capture covers every message type in the protocol', () => {
    const seen = new Set(lines.map((l) => (JSON.parse(l) as { type: ServerMessageType }).type));
    const all: ServerMessageType[] = [
      'hello',
      'game_state',
      'move_played',
      'search_started',
      'search_update',
      'search_complete',
      'symbolic_analysis',
      'explanation',
      'inspection',
      'error',
    ];
    expect(all.filter((t) => !seen.has(t))).toEqual([]);
  });
});

describe('geometry', () => {
  it('squareAt inverts squareCenter in both orientations', () => {
    for (const orientation of ['white', 'black'] as const) {
      for (const square of allSquares()) {
        expect(squareAt(squareCenter(square, orientation), orientation)).toBe(square);
      }
    }
  });

  it('puts a1 bottom-left for White and top-right for Black', () => {
    expect(squareCenter('a1', 'white')).toEqual({ x: 50, y: 750 });
    expect(squareCenter('a1', 'black')).toEqual({ x: 750, y: 50 });
    expect(squareAt({ x: -1, y: 10 }, 'white')).toBeNull();
  });

  it('arrow heads point at the destination square', () => {
    const a = arrowShape('e2', 'e4', 'white');
    const tipY = Number(a.head.split(' ')[0]!.split(',')[1]);
    expect(tipY).toBeLessThan(a.y2); // tip is further up the board than the shaft end
    expect(Number.isFinite(a.x1 + a.y1 + a.x2 + a.y2)).toBe(true);
  });

  it('formats clocks', () => {
    expect(formatClock(305_000)).toBe('5:05');
    expect(formatClock(9_400)).toBe('0:09.4');
    expect(formatClock(-5)).toBe('0:00.0');
  });
});
