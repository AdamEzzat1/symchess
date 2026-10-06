// Board geometry only: where a named square sits on screen. No chess rules.

import type { Color, Square } from './protocol';

export const CELL = 100;
export const BOARD = CELL * 8;
export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;

export interface Point {
  x: number;
  y: number;
}

/** Top-left corner of a square in SVG units, for the given orientation. */
export function squareOrigin(square: Square, orientation: Color): Point {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return orientation === 'white'
    ? { x: file * CELL, y: (7 - rank) * CELL }
    : { x: (7 - file) * CELL, y: rank * CELL };
}

export function squareCenter(square: Square, orientation: Color): Point {
  const o = squareOrigin(square, orientation);
  return { x: o.x + CELL / 2, y: o.y + CELL / 2 };
}

/** The square under an SVG-space point, or null when off the board. */
export function squareAt(p: Point, orientation: Color): Square | null {
  if (p.x < 0 || p.y < 0 || p.x >= BOARD || p.y >= BOARD) return null;
  const col = Math.floor(p.x / CELL);
  const row = Math.floor(p.y / CELL);
  const file = orientation === 'white' ? col : 7 - col;
  const rank = orientation === 'white' ? 7 - row : row;
  return `${FILES[file]}${rank + 1}`;
}

export function isLightSquare(square: Square): boolean {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return (file + rank) % 2 === 1;
}

export function allSquares(): Square[] {
  const out: Square[] = [];
  for (let rank = 8; rank >= 1; rank--) for (const file of FILES) out.push(`${file}${rank}`);
  return out;
}

export interface ArrowShape {
  /** Shaft end points; the shaft stops where the head begins. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Arrow head as an SVG polygon `points` string. */
  head: string;
}

/** A straight arrow between two square centres, shortened at both ends. */
export function arrowShape(from: Square, to: Square, orientation: Color, width = 14): ArrowShape {
  const a = squareCenter(from, orientation);
  const b = squareCenter(to, orientation);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const headLength = width * 2.4;
  const headHalf = width * 1.4;
  const start = { x: a.x + ux * CELL * 0.28, y: a.y + uy * CELL * 0.28 };
  const tip = { x: b.x - ux * CELL * 0.12, y: b.y - uy * CELL * 0.12 };
  const base = { x: tip.x - ux * headLength, y: tip.y - uy * headLength };
  const left = { x: base.x - uy * headHalf, y: base.y + ux * headHalf };
  const right = { x: base.x + uy * headHalf, y: base.y - ux * headHalf };
  const f = (n: number) => n.toFixed(1);
  return {
    x1: start.x,
    y1: start.y,
    x2: base.x,
    y2: base.y,
    head: `${f(tip.x)},${f(tip.y)} ${f(left.x)},${f(left.y)} ${f(right.x)},${f(right.y)}`,
  };
}

export function formatClock(ms: number): string {
  const total = Math.max(0, ms);
  const minutes = Math.floor(total / 60000);
  const seconds = Math.floor((total % 60000) / 1000);
  if (total < 20000) {
    const tenths = Math.floor((total % 1000) / 100);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
