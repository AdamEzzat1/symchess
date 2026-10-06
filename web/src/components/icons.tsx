// Small line icons, drawn here so the app ships no icon font or image set.

import type { ReactNode } from 'react';

export type IconName =
  | 'arrow'
  | 'link'
  | 'target'
  | 'shield'
  | 'grid'
  | 'plan'
  | 'files'
  | 'nodes'
  | 'layers'
  | 'braces'
  | 'coords'
  | 'bulb'
  | 'attack'
  | 'subtle'
  | 'play'
  | 'stop'
  | 'chevron'
  | 'clock';

const PATHS: Record<IconName, ReactNode> = {
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  link: (
    <>
      <path d="M10.5 13.5a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2" />
      <path d="M13.5 10.5a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2" />
    </>
  ),
  target: (
    <>
      <circle cx="12" cy="12" r="7" />
      <circle cx="12" cy="12" r="2.4" />
      <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
    </>
  ),
  shield: <path d="M12 3l7 3v5c0 4.6-2.9 8-7 10-4.1-2-7-5.4-7-10V6l7-3z" />,
  grid: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="1.5" />
      <path d="M12 4v16M4 12h16" />
    </>
  ),
  plan: <rect x="4.5" y="4.5" width="15" height="15" rx="1.5" strokeDasharray="3.2 2.6" />,
  files: <path d="M7 3v18M12 3v18M17 3v18" />,
  nodes: (
    <>
      <circle cx="12" cy="6" r="2.4" />
      <circle cx="6" cy="18" r="2.4" />
      <circle cx="18" cy="18" r="2.4" />
      <path d="M11 8.2L7.2 15.8M13 8.2l3.8 7.6M8.4 18h7.2" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3l9 5-9 5-9-5 9-5z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  braces: (
    <>
      <path d="M9 4c-2 0-3 1-3 3v2c0 1.5-.8 3-2 3 1.200 0 2 1.500 2 3v2c0 2 1 3 3 3" />
      <path d="M15 4c2 0 3 1 3 3v2c0 1.500.8 3 2 3-1.200 0-2 1.500-2 3v2c0 2-1 3-3 3" />
    </>
  ),
  coords: <path d="M4 18l4-11 4 11M5.500 14.500h5M15 12.500c0-1.500 1-2.500 2.500-2.500s2.500 1 2.500 2.500V18M20 15.500c-3-.5-5 .2-5 1.500s1.200 1.800 2.500 1.500c1.300-.3 2.500-1.300 2.500-3" />,
  bulb: (
    <>
      <path d="M9 17h6M10 20h4" />
      <path d="M12 3a6 6 0 0 0-3.500 10.900c.6.500 1 1.200 1 2.100h5c0-.9.400-1.600 1-2.100A6 6 0 0 0 12 3z" />
    </>
  ),
  attack: <path d="M4 20L18 6M11 6h7v7" />,
  subtle: <path d="M4 20L18 6M11 6h7v7" strokeDasharray="3 2.600" />,
  play: <path d="M8 5.500v13l11-6.500-11-6.500z" fill="currentColor" stroke="none" />,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.500" fill="currentColor" stroke="none" />,
  chevron: <path d="M9 5l7 7-7 7" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4.500l3 2" />
    </>
  ),
};

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
