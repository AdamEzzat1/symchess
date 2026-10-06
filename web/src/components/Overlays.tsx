import { arrowShape, BOARD, CELL, FILES, squareCenter, squareOrigin } from '../geometry';
import type { Color, Viz } from '../protocol';

/**
 * Style name -> colour. Styles are chosen by the Prolog renderer (render.pl);
 * the frontend only decides what a style looks like, never what gets drawn.
 */
export const STYLE_COLORS: Record<string, string> = {
  pin: '#a855f7',
  skewer: '#d946ef',
  fork: '#f97316',
  check: '#ef4444',
  threat: '#ef4444',
  hanging: '#ef4444',
  king_danger: '#ef4444',
  overloaded: '#f59e0b',
  defend: '#22c55e',
  support: '#14b8a6',
  passed: '#22c55e',
  weak: '#eab308',
  weak_pawn: '#f97316',
  open: '#38bdf8',
  semi_open: '#7dd3fc',
  plan: '#3b82f6',
  inspect: '#f8fafc',
  control_white: '#e2e8f0',
  control_black: '#334155',
  pv: '#2563eb',
};

const FALLBACK = '#94a3b8';

export function styleColor(style: string): string {
  return STYLE_COLORS[style] ?? FALLBACK;
}

interface Props {
  viz: Viz[];
  orientation: Color;
}

/** Draws visualization primitives over the board. Pointer events pass through. */
export function Overlays({ viz, orientation }: Props) {
  // Fills first, then rings, then arrows, so arrows are never hidden.
  const order = { file: 0, square: 1, ring: 2, arrow: 3 } as const;
  const sorted = [...viz].sort((a, b) => order[a.type] - order[b.type]);

  return (
    <g className="overlays" pointerEvents="none" aria-hidden="true">
      {sorted.map((v, i) => {
        const color = styleColor(v.style);
        switch (v.type) {
          case 'file': {
            const index = FILES.indexOf(v.file as (typeof FILES)[number]);
            const x = (orientation === 'white' ? index : 7 - index) * CELL;
            return (
              <rect
                key={i}
                data-viz="file"
                data-style={v.style}
                x={x}
                y={0}
                width={CELL}
                height={BOARD}
                fill={color}
                opacity={0.22}
              />
            );
          }
          case 'square': {
            const o = squareOrigin(v.square, orientation);
            return (
              <rect
                key={i}
                data-viz="square"
                data-style={v.style}
                x={o.x}
                y={o.y}
                width={CELL}
                height={CELL}
                fill={color}
                opacity={0.45}
              />
            );
          }
          case 'ring': {
            const c = squareCenter(v.square, orientation);
            return (
              <circle
                key={i}
                data-viz="ring"
                data-style={v.style}
                cx={c.x}
                cy={c.y}
                r={CELL * 0.44}
                fill="none"
                stroke={color}
                strokeWidth={7}
                strokeDasharray={v.style === 'plan' ? '14 9' : undefined}
                opacity={0.9}
              />
            );
          }
          case 'arrow': {
            const a = arrowShape(v.from, v.to, orientation);
            return (
              <g key={i} data-viz="arrow" data-style={v.style} opacity={0.8}>
                <line
                  x1={a.x1}
                  y1={a.y1}
                  x2={a.x2}
                  y2={a.y2}
                  stroke={color}
                  strokeWidth={14}
                  strokeLinecap="round"
                  strokeDasharray={v.style === 'plan' ? '18 14' : undefined}
                />
                <polygon points={a.head} fill={color} />
              </g>
            );
          }
        }
      })}
    </g>
  );
}
