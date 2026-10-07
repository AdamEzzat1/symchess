import type { CSSProperties } from 'react';
import { arrowShape, BOARD, CELL, FILES, squareCenter, squareOrigin } from '../geometry';
import type { Color, Viz } from '../protocol';

// The overlay language. Style names are chosen by the Prolog renderer
// (render.pl) or, for `pv`, by the search; the frontend decides only what a
// style looks like, never what gets drawn.
export const TONE = {
  pv: '#4aa8ff',
  pin: '#9b7cff',
  weak: '#d9a441',
  threat: '#ff6b5f',
  defend: '#3fd0b0',
  neutral: '#8f9aa7',
  inspect: '#e8edf2',
} as const;

interface StyleSpec {
  color: string;
  /** Line weight in board units (a square is 100). */
  width: number;
  dashed?: boolean;
  /** Pins and skewers are a beam of light through the line, with no arrowhead. */
  beam?: boolean;
}

const STYLES: Record<string, StyleSpec> = {
  pv: { color: TONE.pv, width: 6 },
  pin: { color: TONE.pin, width: 5, beam: true },
  skewer: { color: TONE.pin, width: 5, beam: true },
  threat: { color: TONE.threat, width: 4.5 },
  check: { color: TONE.threat, width: 4.5 },
  fork: { color: TONE.threat, width: 4.5 },
  hanging: { color: TONE.threat, width: 4.5 },
  king_danger: { color: TONE.threat, width: 4.5 },
  overloaded: { color: TONE.weak, width: 4.5 },
  defend: { color: TONE.defend, width: 4 },
  support: { color: TONE.defend, width: 4 },
  control_white: { color: TONE.defend, width: 4 },
  control_black: { color: TONE.neutral, width: 4 },
  passed: { color: TONE.defend, width: 4 },
  weak: { color: TONE.weak, width: 4 },
  weak_pawn: { color: TONE.weak, width: 4 },
  open: { color: TONE.pv, width: 4 },
  semi_open: { color: TONE.pv, width: 4 },
  plan: { color: TONE.pv, width: 4.5, dashed: true },
  inspect: { color: TONE.inspect, width: 3 },
  asked: { color: TONE.weak, width: 5, dashed: true },
};

const FALLBACK: StyleSpec = { color: TONE.neutral, width: 4.5 };

export function styleSpec(style: string): StyleSpec {
  return STYLES[style] ?? FALLBACK;
}

interface Props {
  viz: Viz[];
  orientation: Color;
  /**
   * `standing` is the normal layer set. `dimmed` is the same set while the
   * glass inspector isolates something else. `focus` is the isolated evidence.
   * `mini` is a thumbnail: heavier lines, no glow filters.
   */
  tone?: 'standing' | 'dimmed' | 'focus' | 'mini';
}

const glow = (color: string) => ({ '--glow': color }) as CSSProperties;

/** Draws visualization primitives over the board. Pointer events pass through. */
export function Overlays({ viz, orientation, tone = 'standing' }: Props) {
  // Fills first, then frames, then lines, so lines are never hidden.
  const order = { file: 0, square: 1, ring: 2, arrow: 3 } as const;
  const sorted = [...viz].sort((a, b) => order[a.type] - order[b.type]);
  const mini = tone === 'mini';
  const weight = mini ? 1.9 : tone === 'focus' ? 1.25 : 1;

  return (
    <g className={`overlays overlays-${tone}`} pointerEvents="none" aria-hidden="true">
      {sorted.map((v, i) => {
        const spec = styleSpec(v.style);
        const key = `${v.type}-${v.style}-${'square' in v ? v.square : 'file' in v ? v.file : v.from + v.to}-${i}`;
        switch (v.type) {
          case 'file': {
            const index = FILES.indexOf(v.file as (typeof FILES)[number]);
            const x = (orientation === 'white' ? index : 7 - index) * CELL;
            return spec.dashed ? (
              <rect
                key={key}
                className="viz viz-plan viz-glow"
                style={glow(spec.color)}
                data-viz="file"
                data-style={v.style}
                x={x + 5}
                y={5}
                width={CELL - 10}
                height={BOARD - 10}
                rx={8}
                fill="none"
                stroke={spec.color}
                strokeWidth={3 * weight}
                strokeDasharray="16 12"
              />
            ) : (
              <rect
                key={key}
                className="viz"
                data-viz="file"
                data-style={v.style}
                x={x}
                y={0}
                width={CELL}
                height={BOARD}
                fill={spec.color}
                opacity={v.style === 'semi_open' ? 0.08 : 0.14}
              />
            );
          }
          // Both a marked square and a marked piece are a lit frame on the
          // cell. `square` (a property of the square itself) is also filled.
          case 'square':
          case 'ring': {
            const o = squareOrigin(v.square, orientation);
            const filled = v.type === 'square';
            return (
              <rect
                key={key}
                className={`viz viz-frame viz-glow${spec.dashed ? ' viz-plan' : ''}`}
                style={glow(spec.color)}
                data-viz={v.type}
                data-style={v.style}
                x={o.x + 4}
                y={o.y + 4}
                width={CELL - 8}
                height={CELL - 8}
                rx={7}
                fill={spec.color}
                fillOpacity={spec.dashed ? 0.06 : filled ? 0.2 : 0.13}
                stroke={spec.color}
                strokeWidth={(v.style === 'inspect' ? 2.5 : 3.5) * weight}
                strokeDasharray={spec.dashed ? '13 9' : undefined}
              />
            );
          }
          case 'arrow': {
            const width = spec.width * weight;
            if (spec.beam) {
              // A beam runs centre to centre, straight through the pinned piece.
              const a = squareCenter(v.from, orientation);
              const b = squareCenter(v.to, orientation);
              return (
                <g key={key} className="viz viz-line viz-glow" style={glow(spec.color)} data-viz="arrow" data-style={v.style}>
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={spec.color} strokeWidth={width * 1.9} strokeLinecap="round" opacity={0.35} />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={spec.color} strokeWidth={width} strokeLinecap="round" />
                  <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#f1ecff" strokeWidth={width * 0.3} strokeLinecap="round" opacity={0.85} />
                </g>
              );
            }
            const a = arrowShape(v.from, v.to, orientation, Math.max(width * 1.5, 8.5));
            return (
              <g
                key={key}
                className={`viz viz-line viz-glow${spec.dashed ? ' viz-plan' : ''}`}
                style={glow(spec.color)}
                data-viz="arrow"
                data-style={v.style}
              >
                <line
                  x1={a.x1}
                  y1={a.y1}
                  x2={a.x2}
                  y2={a.y2}
                  stroke={spec.color}
                  strokeWidth={width}
                  strokeLinecap="round"
                  strokeDasharray={spec.dashed ? '15 11' : undefined}
                />
                <polygon points={a.head} fill={spec.color} />
              </g>
            );
          }
        }
      })}
    </g>
  );
}
