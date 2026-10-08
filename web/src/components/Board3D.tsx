// The 3D board: the same position, drawn as glass statues that fight when one
// takes another. Presentation only. Legal moves still come from the engine's
// list, and after every animation the scene is reconciled against the
// engine's board, so what is on screen can never drift from the real position.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FILES } from '../geometry';
import { activateSquare, targetsFrom } from '../moveInput';
import type { Color, GameState, LegalMove, PieceCode, Square, Viz } from '../protocol';
import { PromotionPicker } from './Board';
import { styleSpec } from './Overlays';
import { loadStatueSet, type StatueSet } from '../models/load';
import { sculpture, type Sculpture } from './statues';

interface Props {
  game: GameState;
  orientation: Color;
  interactive: boolean;
  thinking: boolean;
  showHints: boolean;
  /** Short glides and fades instead of fights and effects. */
  minimal?: boolean;
  /** The search's best move, drawn as an arrow lying on the board. */
  bestMove?: { from: Square; to: Square } | null;
  /**
   * The drawing primitives of the fact or plan under inspection, exactly as
   * the engine supplied them. The same selection the flat board isolates.
   */
  focus?: readonly Viz[] | null;
  /** Squares the Focus camera frames: those of the selected fact or plan. */
  frameSquares?: readonly Square[];
  showCoords?: boolean;
  /**
   * Address of a model set's manifest. Its sculpted pieces replace the
   * built-in statues, piece by piece, wherever a model loads.
   */
  models?: string | null;
  onMove: (uci: string) => void;
  onSquareClick?: (square: Square) => void;
}

const ICE = { color: 0xcdeaf6, emissive: 0x2f8fb0, glow: 0x39d5ff, rest: 0.07 };
const AMETHYST = { color: 0x3b2d74, emissive: 0x5b40b4, glow: 0xd3bcff, rest: 0.14 };
const ICE_GEM = new THREE.MeshBasicMaterial({ color: ICE.glow });
const AMETHYST_GEM = new THREE.MeshBasicMaterial({ color: AMETHYST.glow });

/** Development aid: `?slow=6` stretches every animation so it can be inspected. */
const SLOW = Math.max(1, Number(new URLSearchParams(window.location.search).get('slow')) || 1);

/** Development aid: `?closeup=front` or `?closeup=back` puts the camera beside white's back rank, to inspect the statues. */
const CLOSEUP = new URLSearchParams(window.location.search).get('closeup');

function squarePosition(square: Square): THREE.Vector3 {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square[1]) - 1;
  return new THREE.Vector3(file - 3.5, 0, 3.5 - rank);
}

function squareFromPoint(p: THREE.Vector3): Square | null {
  const file = Math.floor(p.x + 4);
  const rank = Math.floor(4 - p.z);
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${rank + 1}`;
}

const UP = new THREE.Vector3(0, 1, 0);
const mix = (a: number, b: number, k: number) => a + (b - a) * k;
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

/** The yaw that turns a statue's front (-z) toward `toward`. */
const yawToward = (toward: THREE.Vector3) => Math.atan2(-toward.x, -toward.z);

/** Interpolate between two headings the short way round. */
function mixYaw(a: number, b: number, k: number) {
  const turn = ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  return a + turn * k;
}

/** Stand a statue at heading `yaw`, tipped toward `toward` by `angle`. */
function pose(statue: THREE.Object3D, yaw: number, toward: THREE.Vector3, angle: number) {
  const axis = new THREE.Vector3().crossVectors(UP, toward).normalize();
  statue.quaternion.setFromAxisAngle(axis, angle).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
}

/** Play: the angled view. Analyze: from high up, so pieces hide little of the board. Focus: close on the selected fact. */
export type CameraView = 'play' | 'analyze' | 'focus';
const VIEWS: { id: CameraView; label: string; hint: string }[] = [
  { id: 'play', label: 'Play', hint: 'The angled view' },
  { id: 'analyze', label: 'Analyze', hint: 'From high up, so pieces hide little of the board' },
  { id: 'focus', label: 'Focus', hint: 'Close on the selected fact or plan. Select one in the panel first.' },
];

interface Tween {
  start: number;
  duration: number;
  step: (k: number) => void;
  done?: () => void;
}

interface StatueData {
  code: PieceCode;
  material: THREE.MeshPhysicalMaterial;
  /** Resting heading: white faces up the board, black faces down it. */
  facing: number;
  lift: number;
  /** How brightly it is lit as part of the fact under inspection, 0 to 1. */
  shine: number;
  /** The weapon arm, hinged at the shoulder. */
  arm: THREE.Group;
  /** Shoulder angles for the wind-up and for the moment of the blow. */
  windup: number;
  hit: number;
  /** How far the body leans back before striking (a horse rears). */
  rear: number;
  /** "sweep": no arm to swing, so the whole figure turns into the blow. "bolt": it strikes from a distance. */
  strike: 'arm' | 'sweep' | 'bolt' | 'arrow';
  /** Where a bolt leaves the statue, in its own coordinates. */
  emitter: THREE.Vector3;
  /** A checkmated king: frosted over, and left alone by the idle animation. */
  frozen?: boolean;
}

interface Statue extends THREE.Group {
  userData: StatueData;
}

/** One statue: the shared sculpture for its piece type, in its side's glass. */
function buildStatue(code: PieceCode, shape: Sculpture): Statue {
  const white = code[0] === 'w';
  const tone = white ? ICE : AMETHYST;
  // Flat shading leaves every facet showing, which is what makes it read as carved.
  const material = new THREE.MeshPhysicalMaterial({
    color: tone.color,
    emissive: tone.emissive,
    emissiveIntensity: tone.rest,
    roughness: 0.4,
    metalness: 0.05,
    clearcoat: 0.7,
    clearcoatRoughness: 0.35,
    transparent: true,
    opacity: 0.94,
    flatShading: !shape.smooth,
    side: THREE.DoubleSide,
  });
  const gem = white ? ICE_GEM : AMETHYST_GEM;
  const group = new THREE.Group() as Statue;
  const add = (parent: THREE.Object3D, geometry: THREE.BufferGeometry | null, mat: THREE.Material) => {
    if (!geometry) return;
    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = mat === material;
    parent.add(mesh);
  };
  add(group, shape.body, material);
  add(group, shape.gems, gem);
  const arm = new THREE.Group();
  arm.position.copy(shape.shoulder);
  add(arm, shape.arm, material);
  add(arm, shape.armGems, gem);
  group.add(arm);

  const facing = white ? 0 : Math.PI;
  group.rotation.y = facing;
  group.userData = { code, material, facing, lift: 0, shine: 0, arm, windup: shape.windup, hit: shape.hit, rear: shape.rear, strike: shape.strike ?? 'arm', emitter: shape.emitter ?? new THREE.Vector3(0, 1.2, -0.15) };
  return group;
}

/** Everything Three.js: built once, then told about each new game state. */
function createWorld(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 4 / 3, 0.1, 100);
  const cameraHome = new THREE.Vector3();
  const cameraLook = new THREE.Vector3();
  let view: CameraView = 'play';
  let framed: readonly Square[] = [];
  let side = 1;
  let shake = 0;

  scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x10151c, 1.15));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(-5, 10, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = key.shadow.camera.bottom = -6;
  key.shadow.camera.right = key.shadow.camera.top = 6;
  scene.add(key);
  const rim = new THREE.PointLight(0x4aa8ff, 30, 30);
  rim.position.set(5, 5, -7);
  scene.add(rim);

  // The board: 64 slabs on a dark base.
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(8.7, 0.3, 8.7),
    new THREE.MeshStandardMaterial({ color: 0x0c131b, roughness: 0.7 }),
  );
  base.position.y = -0.17;
  base.receiveShadow = true;
  scene.add(base);
  const slab = new THREE.BoxGeometry(1, 0.04, 1);
  const light = new THREE.MeshStandardMaterial({ color: 0x56626f, roughness: 0.45, metalness: 0.15 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x252d36, roughness: 0.45, metalness: 0.15 });
  for (let file = 0; file < 8; file++) {
    for (let rank = 0; rank < 8; rank++) {
      const mesh = new THREE.Mesh(slab, (file + rank) % 2 === 1 ? light : dark);
      mesh.position.set(file - 3.5, -0.02, 3.5 - rank);
      mesh.receiveShadow = true;
      scene.add(mesh);
    }
  }

  // Square markers, all flat on the board.
  const flat = (geometry: THREE.BufferGeometry, color: number, opacity: number) => {
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false }),
    );
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.y = 0.006;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  };
  const tile = new THREE.PlaneGeometry(0.96, 0.96);
  const lastMarks = [flat(tile, 0x4aa8ff, 0.2), flat(tile, 0x4aa8ff, 0.2)];
  const selectedMark = flat(tile, 0x4aa8ff, 0.4);
  const checkMark = flat(new THREE.CircleGeometry(0.46, 32), 0xff5b4f, 0.55);
  const dot = new THREE.CircleGeometry(0.14, 24);
  const ring = new THREE.RingGeometry(0.36, 0.45, 32);
  const hints: THREE.Mesh[] = [];

  // The search's best move: an arrow lying on the board.
  const bestMaterial = new THREE.MeshBasicMaterial({ color: 0x4aa8ff, transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide });
  let bestArrow: THREE.Mesh | null = null;

  // Checkmate: lines that run in from the edges of the board to the king.
  const rayMaterial = new THREE.MeshBasicMaterial({ color: 0xbfe9ff, transparent: true, opacity: 0, depthWrite: false });
  const rays = new THREE.Group();
  for (let i = 0; i < 8; i++) {
    const pivot = new THREE.Group();
    pivot.rotation.y = (i / 8) * Math.PI * 2 + Math.PI / 8;
    const ray = new THREE.Mesh(new THREE.PlaneGeometry(1, 0.05), rayMaterial);
    ray.rotation.x = -Math.PI / 2;
    pivot.add(ray);
    rays.add(pivot);
  }
  rays.visible = false;
  scene.add(rays);
  let mated: { statue: Statue; positionId: number } | null = null;

  const statues = new Map<Square, Statue>();
  // Where a piece's shape comes from: the built-in statues, or a loaded model set.
  let shapeOf: (kind: string) => Sculpture = sculpture;
  let shapesWaiting: ((kind: string) => Sculpture) | null = null;
  let tweens: Tween[] = [];
  // The draw loop runs only while something is moving (see `frame`).
  let looping = false;
  let awakeUntil = 0;
  const wake = () => {
    awakeUntil = performance.now() + 1500;
    if (!looping && !disposed) {
      looping = true;
      requestAnimationFrame((now) => frame(now));
    }
  };
  let busy = false;
  let shown: GameState | null = null;
  let waiting: GameState | null = null;
  let selected: Square | null = null;
  let disposed = false;
  let calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  let minimal = false;

  const tween = (duration: number, step: (k: number) => void, done?: () => void, delay = 0) => {
    tweens.push({ start: performance.now() + delay * SLOW, duration: duration * SLOW, step, done });
    wake();
  };

  const place = (statue: Statue, square: Square) => {
    statue.position.copy(squarePosition(square));
    statue.rotation.set(0, statue.userData.facing, 0);
    statue.userData.arm.rotation.x = 0;
    statue.scale.setScalar(1);
  };

  /** Make the scene match the engine's board exactly. */
  const reconcile = (board: Record<Square, PieceCode>) => {
    for (const [square, statue] of statues) {
      if (board[square] !== statue.userData.code) {
        scene.remove(statue);
        statues.delete(square);
      }
    }
    for (const square of Object.keys(board)) {
      const code = board[square]!;
      let statue = statues.get(square);
      if (!statue) {
        statue = buildStatue(code, shapeOf(code[1]!));
        statues.set(square, statue);
        scene.add(statue);
      }
      place(statue, square);
    }
  };

  /** Lay the rays out so each runs from `outer` squares away to just short of the king. */
  const setRays = (reach: number, opacity: number) => {
    for (const pivot of rays.children) {
      const ray = pivot.children[0]!;
      // Each ray starts where its direction leaves the board.
      const dx = Math.cos(pivot.rotation.y);
      const dz = -Math.sin(pivot.rotation.y);
      const toEdge = (at: number, d: number) => (d > 1e-6 ? (4 - at) / d : d < -1e-6 ? (-4 - at) / d : Infinity);
      const outer = Math.max(0.5, Math.min(toEdge(rays.position.x, dx), toEdge(rays.position.z, dz)));
      const inner = outer - (outer - 0.5) * reach;
      ray.scale.x = Math.max(0.001, outer - inner);
      ray.position.x = (outer + inner) / 2;
    }
    rayMaterial.opacity = opacity;
  };

  const FROST = new THREE.Color(0xa9bcc8);

  /**
   * Checkmate, where the engine says the checked king stands: lines converge
   * on it, and it frosts over and dims. Anything left from an earlier mate is
   * undone first, so taking a move back thaws the king.
   */
  const mate = (game: GameState) => {
    const square = game.status === 'checkmate' ? game.check : null;
    const king = square ? statues.get(square) : undefined;
    if (mated && mated.statue === king && mated.positionId === game.positionId) return;
    if (mated) {
      const data = mated.statue.userData;
      const tone = data.code[0] === 'w' ? ICE : AMETHYST;
      data.frozen = false;
      data.material.color.setHex(tone.color);
      data.material.emissive.setHex(tone.emissive);
      mated = null;
    }
    rays.visible = false;
    if (!king || !square) return;
    mated = { statue: king, positionId: game.positionId };
    const data = king.userData;
    const tone = data.code[0] === 'w' ? ICE : AMETHYST;
    const from = new THREE.Color(tone.color);
    data.frozen = true;
    const frost = (k: number) => {
      // A later state may have thawed it while this was still running.
      if (!data.frozen) return;
      data.material.color.copy(from).lerp(FROST, 0.75 * k);
      data.material.emissiveIntensity = tone.rest * (1 - k);
      king.position.y = 0;
    };
    if (calm || minimal) {
      tween(calm ? 1 : 400, frost);
      return;
    }
    rays.position.copy(squarePosition(square)).setY(0.012);
    rays.visible = true;
    setRays(0, 0);
    tween(700, (k) => setRays(ease(k), 0.9));
    tween(600, (k) => setRays(1, mix(0.9, 0.22, k)), undefined, 700);
    tween(900, frost, undefined, 500);
  };

  /** Promotion: the new piece gathers out of a burst of its own light. */
  const form = (statue: Statue) => {
    const glow = statue.userData.code[0] === 'w' ? ICE.glow : AMETHYST.glow;
    const lightMaterial = new THREE.MeshBasicMaterial({ color: glow, transparent: true, depthWrite: false });
    const light = new THREE.Mesh(new THREE.SphereGeometry(0.36, 16, 12), lightMaterial);
    light.position.copy(statue.position).setY(0.5);
    scene.add(light);
    tween(
      560,
      (k) => {
        statue.scale.set(mix(0.6, 1, ease(k)), mix(0.15, 1, ease(k)), mix(0.6, 1, ease(k)));
        light.scale.setScalar(0.4 + k * 1.3);
        lightMaterial.opacity = 0.8 * (1 - k);
      },
      () => {
        statue.scale.setScalar(1);
        scene.remove(light);
      },
    );
  };

  const markers = (game: GameState) => {
    lastMarks.forEach((mark, i) => {
      const square = game.lastMove ? (i === 0 ? game.lastMove.from : game.lastMove.to) : null;
      mark.visible = square !== null;
      if (square) mark.position.copy(squarePosition(square)).setY(0.006);
    });
    checkMark.visible = game.check !== null;
    if (game.check) checkMark.position.copy(squarePosition(game.check)).setY(0.008);
  };

  /** The blow lands: a flash, a jolt, and the loser is thrown back and breaks apart. */
  const shatter = (victim: Statue, yaw: number, away: THREE.Vector3) => {
    const material = victim.userData.material;
    const from = victim.position.clone();
    const glow = victim.userData.code[0] === 'w' ? ICE.glow : AMETHYST.glow;
    shake = 1;

    const flashMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    const flash = new THREE.Mesh(new THREE.SphereGeometry(0.3, 16, 12), flashMaterial);
    flash.position.copy(from).setY(0.5);
    scene.add(flash);
    tween(
      200,
      (k) => {
        flash.scale.setScalar(0.3 + k * 1.5);
        flashMaterial.opacity = 0.9 * (1 - k);
      },
      () => scene.remove(flash),
    );

    tween(
      520,
      (k) => {
        // Knocked back and toppling, then gone.
        const fall = 1 - (1 - k) ** 2;
        victim.position.copy(from).addScaledVector(away, 0.4 * fall).setY(-0.12 * k * k);
        pose(victim, yaw, away, 1.25 * fall);
        victim.scale.setScalar(1 - 0.6 * k * k);
        material.opacity = 0.94 * (1 - k * k);
      },
      () => scene.remove(victim),
    );

    const shard = new THREE.TetrahedronGeometry(0.065);
    const shardMaterial = new THREE.MeshBasicMaterial({ color: glow, transparent: true });
    for (let i = 0; i < 22; i++) {
      const mesh = new THREE.Mesh(shard, shardMaterial);
      const angle = (i / 22) * Math.PI * 2;
      const speed = 0.6 + (i % 4) * 0.3;
      // Most of the debris is thrown the way the blow travelled.
      const velocity = new THREE.Vector3(Math.cos(angle) * speed, 1.3 + (i % 3) * 0.6, Math.sin(angle) * speed).addScaledVector(away, 1.6);
      const origin = from.clone().setY(0.25 + (i % 6) * 0.1);
      mesh.position.copy(origin);
      mesh.scale.setScalar(0.6 + (i % 3) * 0.4);
      scene.add(mesh);
      tween(
        760,
        (k) => {
          const t = k * 0.76;
          mesh.position.set(origin.x + velocity.x * t, Math.max(0.03, origin.y + velocity.y * t - 4.6 * t * t), origin.z + velocity.z * t);
          mesh.rotation.set(k * 7, k * 5, 0);
          shardMaterial.opacity = 1 - k * k;
        },
        () => scene.remove(mesh),
      );
    }
  };

  /** A taken piece in the minimal style: no blow, it just fades into a few shards. */
  const fade = (victim: Statue) => {
    const material = victim.userData.material;
    const from = victim.position.clone();
    const glow = victim.userData.code[0] === 'w' ? ICE.glow : AMETHYST.glow;
    tween(
      320,
      (k) => {
        material.opacity = 0.94 * (1 - k);
      },
      () => scene.remove(victim),
    );
    const shard = new THREE.TetrahedronGeometry(0.05);
    const shardMaterial = new THREE.MeshBasicMaterial({ color: glow, transparent: true });
    for (let i = 0; i < 8; i++) {
      const mesh = new THREE.Mesh(shard, shardMaterial);
      const angle = (i / 8) * Math.PI * 2;
      const origin = from.clone().setY(0.2 + (i % 4) * 0.12);
      mesh.position.copy(origin);
      scene.add(mesh);
      tween(
        420,
        (k) => {
          mesh.position.set(origin.x + Math.cos(angle) * 0.35 * k, origin.y - 0.15 * k, origin.z + Math.sin(angle) * 0.35 * k);
          shardMaterial.opacity = 1 - k;
        },
        () => scene.remove(mesh),
      );
    }
  };

  const finish = (game: GameState) => {
    if (shapesWaiting) {
      // A model set arrived during the animation: change over now that it is done.
      shapeOf = shapesWaiting;
      shapesWaiting = null;
      for (const statue of statues.values()) scene.remove(statue);
      statues.clear();
      mated = null;
    }
    reconcile(game.board);
    markers(game);
    mate(game);
    shown = game;
    busy = false;
    if (waiting) {
      const next = waiting;
      waiting = null;
      show(next);
    }
  };

  /** The bright arc a sweeping blow leaves in the air, in the striker's own light. */
  const slash = (at: THREE.Vector3, along: THREE.Vector3, glow: number) => {
    const material = new THREE.MeshBasicMaterial({ color: glow, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    // From the striker's right, across the front, to its left: the path of the weapon.
    const arc = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.74, 32, 1, 0, 2.3), material);
    const heading = Math.atan2(-along.z, along.x);
    arc.rotation.set(-Math.PI / 2, 0, heading - Math.PI / 2 - 0.35);
    arc.position.copy(at).setY(0.78);
    arc.renderOrder = 4;
    scene.add(arc);
    tween(
      300,
      (k) => {
        arc.scale.setScalar(0.85 + 0.35 * k);
        arc.position.y = 0.78 - 0.12 * k;
        material.opacity = 0.9 * (1 - k * k);
      },
      () => {
        scene.remove(arc);
        arc.geometry.dispose();
        material.dispose();
      },
    );
  };

  /** A bolt of light from one point to another. `onHit` runs when it arrives. */
  const bolt = (start: THREE.Vector3, end: THREE.Vector3, glow: number, onHit: () => void) => {
    const span = end.clone().sub(start);
    const length = span.length();
    const ray = new THREE.Group();
    ray.position.copy(start);
    ray.quaternion.setFromUnitVectors(UP, span.normalize());
    const paint = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    // A white-hot core inside a sheath of the striker's own colour. Both grow from the staff.
    const core = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 1, 8).translate(0, 0.5, 0), paint(0xffffff, 0.95));
    const sheath = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 10).translate(0, 0.5, 0), paint(glow, 0.55));
    ray.add(sheath, core);
    ray.renderOrder = 4;
    scene.add(ray);
    const done = () => {
      scene.remove(ray);
      for (const mesh of [core, sheath]) {
        mesh.geometry.dispose();
        mesh.material.dispose();
      }
    };
    tween(
      90,
      (k) => ray.scale.set(1, Math.max(0.001, length * k), 1),
      () => {
        onHit();
        tween(
          240,
          (k) => {
            // It thins and fades, as if spent.
            ray.scale.set(1 - 0.8 * k, length, 1 - 0.8 * k);
            core.material.opacity = 0.95 * (1 - k);
            sheath.material.opacity = 0.55 * (1 - k * k);
          },
          done,
        );
      },
    );
  };

  /**
   * A bow of light with an arrow on the string, both pointing along +Z.
   * `draw(w)` pulls the arrow back; `loose` sends it to `end` and runs
   * `onHit` when it lands; `fade(k)` lets the bow go.
   */
  const longbow = (glow: number) => {
    const paint = (color: number, opacity: number) =>
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending });
    const wood = paint(glow, 0);
    const bright = paint(0xffffff, 0);
    const arc = Math.PI * 0.9;
    const bow = new THREE.Group();
    const limbs = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.011, 6, 22, arc).rotateZ(-arc / 2).rotateY(-Math.PI / 2).translate(0, 0, -0.1), wood);
    const string = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.39, 4).translate(0, 0, -0.07), wood);
    const arrow = new THREE.Group();
    arrow.add(
      new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 0.36, 6).rotateX(Math.PI / 2), bright),
      new THREE.Mesh(new THREE.ConeGeometry(0.03, 0.09, 8).rotateX(Math.PI / 2).translate(0, 0, 0.22), wood),
    );
    bow.add(limbs, string, arrow);
    bow.renderOrder = 4;
    scene.add(bow);
    const clear = () => {
      scene.remove(bow, arrow);
      for (const part of [limbs, string, ...arrow.children] as THREE.Mesh[]) part.geometry.dispose();
      wood.dispose();
      bright.dispose();
    };
    return {
      bow,
      draw: (w: number) => {
        wood.opacity = 0.9 * w;
        bright.opacity = 0.95 * w;
        arrow.position.z = 0.04 - 0.11 * w;
      },
      fade: (k: number) => {
        bow.scale.setScalar(1 - 0.3 * k);
        limbs.visible = string.visible = k < 1;
      },
      loose: (end: THREE.Vector3, onHit: () => void) => {
        const start = arrow.getWorldPosition(new THREE.Vector3());
        scene.add(arrow);
        // Placed now, not on the next frame: it has just left the bow's own frame of reference.
        arrow.position.copy(start);
        arrow.lookAt(end);
        tween(
          130,
          (k) => {
            // A flat shot with the slightest rise, so it reads as thrown weight and not a ray.
            arrow.position.lerpVectors(start, end, k).setY(mix(start.y, end.y, k) + 0.05 * Math.sin(k * Math.PI));
            arrow.lookAt(end);
          },
          () => {
            onHit();
            tween(260, (k) => (wood.opacity = bright.opacity = 0.9 * (1 - k)), clear);
          },
        );
      },
    };
  };

  /**
   * A strike from a distance. The statue turns to its enemy, comes no nearer
   * than it must, gathers light at its staff, lets it go, and only then
   * walks to the square it has cleared. It takes as long as any other attack.
   */
  const cast = (mover: Statue, victim: Statue, from: THREE.Vector3, to: THREE.Vector3, game: GameState) => {
    const data = mover.userData;
    // It faces the enemy, which en passant puts beside the way it will walk.
    const along = victim.position.clone().sub(from).setY(0).normalize();
    const yaw = yawToward(along);
    const victimYaw = yawToward(along.clone().negate());
    const braced = victim.userData.facing;
    const tone = data.code[0] === 'w' ? ICE : AMETHYST;
    // Near enough that the bolt is short and plainly from this piece; an adjacent enemy is struck from where it stands.
    const stand = from.clone().addScaledVector(to.clone().sub(from).normalize(), Math.max(0, from.distanceTo(to) - 2.4));
    const staff = () => {
      mover.updateMatrixWorld();
      return mover.localToWorld(data.emitter.clone());
    };
    // An archer draws a bow where a caster gathers an orb. The enemy itself is the mark: en passant takes a pawn that is not on the square moved to.
    const archer = data.strike === 'arrow' ? longbow(tone.glow) : null;
    const mark = victim.position.clone().setY(archer ? 0.45 : 0.55);
    const hold = () => {
      if (!archer) return;
      archer.bow.position.copy(staff());
      archer.bow.rotation.set(0, mover.rotation.y + Math.PI, 0);
    };
    const charge = new THREE.MeshBasicMaterial({ color: tone.glow, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending });
    const orb = new THREE.Mesh(new THREE.SphereGeometry(0.11, 16, 12), charge);
    orb.renderOrder = 4;
    orb.visible = !archer;
    scene.add(orb);

    // 1. Turn to face it. The defender turns to meet the blow.
    tween(400, (k) => {
      const e = ease(k);
      mover.position.lerpVectors(from, stand, e);
      mover.rotation.set(0, mixYaw(data.facing, yaw, Math.min(1, k * 1.6)), 0);
      victim.rotation.set(0, mixYaw(braced, victimYaw, e), 0);
    });

    // 2. Gather the light slowly, then loose it at once.
    let loosed = false;
    tween(
      480,
      (k) => {
        if (k < 0.66) {
          const w = ease(k / 0.66);
          pose(mover, yaw, along, -0.13 * w);
          mover.position.copy(stand).setY(0.09 * w);
          data.material.emissiveIntensity = tone.rest + 0.55 * w;
          orb.position.copy(staff());
          orb.scale.setScalar(0.25 + 1.05 * w + 0.07 * Math.sin(k * 60));
          charge.opacity = 0.95 * w;
          hold();
          archer?.draw(w);
        } else {
          const h = (k - 0.66) / 0.34;
          // The recoil: thrown forward into the cast, then settling.
          pose(mover, yaw, along, mix(-0.13, 0.12, Math.min(1, h * 4)) * (1 - 0.5 * h));
          mover.position.copy(stand).setY(0.09 * (1 - h));
          if (!loosed) {
            loosed = true;
            const hit = () => shatter(victim, victimYaw, along);
            hold();
            if (archer) archer.loose(mark, hit);
            else bolt(staff(), mark, tone.glow, hit);
          }
          hold();
          archer?.fade(h);
          orb.position.copy(staff());
          orb.scale.setScalar(Math.max(0.01, 1.3 * (1 - h)));
          charge.opacity = 0.95 * (1 - h);
          data.material.emissiveIntensity = tone.rest + 0.55 * (1 - h);
        }
      },
      () => {
        scene.remove(orb);
        orb.geometry.dispose();
        charge.dispose();
      },
      400,
    );

    // 3. Walk to the square.
    tween(
      380,
      (k) => {
        const e = ease(k);
        mover.position.lerpVectors(stand, to, e).setY(Math.abs(Math.sin(k * Math.PI * 3)) * 0.03);
        pose(mover, mixYaw(yaw, data.facing, e), along, 0);
      },
      () => finish(game),
      880,
    );
  };

  /**
   * Turn to face the enemy and close in; draw the weapon back; strike, fast;
   * then lower the weapon and take the square. A little over a second.
   */
  const fight = (mover: Statue, victim: Statue, from: THREE.Vector3, to: THREE.Vector3, game: GameState) => {
    const data = mover.userData;
    if (data.strike === 'bolt' || data.strike === 'arrow') {
      cast(mover, victim, from, to, game);
      return;
    }
    const along = to.clone().sub(from).normalize();
    const back = along.clone().negate();
    const reach = to.clone().addScaledVector(along, -0.7);
    const yaw = yawToward(along);
    const victimYaw = yawToward(back);
    const braced = victim.userData.facing;
    // A figure with no arm to swing strikes with its whole body: it twists its
    // weapon side away, rises a little, then whips round and through.
    const sweep = data.strike === 'sweep';
    const BACK = -1.25;
    const THROUGH = 1.0;
    const lean = sweep ? 0.16 : 0.34;
    const glow = data.code[0] === 'w' ? ICE.glow : AMETHYST.glow;

    // 1. Close in. The defender turns to meet it.
    tween(400, (k) => {
      const e = ease(k);
      mover.position.lerpVectors(from, reach, e).setY(Math.abs(Math.sin(k * Math.PI * 3)) * 0.035);
      mover.rotation.set(0, mixYaw(data.facing, yaw, Math.min(1, k * 2)), 0);
      victim.rotation.set(0, mixYaw(braced, victimYaw, e), 0);
    });

    // 2. Wind up slowly, then strike in a fraction of the time.
    let struck = false;
    tween(
      460,
      (k) => {
        if (k < 0.6) {
          const w = ease(k / 0.6);
          data.arm.rotation.x = mix(0, data.windup, w);
          pose(mover, yaw + (sweep ? BACK * w : 0), along, -data.rear * w);
          mover.position.copy(reach).addScaledVector(along, -0.07 * w);
          if (sweep) mover.position.y = 0.07 * w;
        } else if (k < 0.8) {
          const h = ((k - 0.6) / 0.2) ** 2;
          data.arm.rotation.x = mix(data.windup, data.hit, h);
          pose(mover, yaw + (sweep ? mix(BACK, THROUGH, h) : 0), along, mix(-data.rear, lean, h));
          mover.position.copy(reach).addScaledVector(along, mix(-0.07, 0.24, h));
          if (sweep) mover.position.y = 0.07 * (1 - h);
          if (!struck && h > (sweep ? 0.45 : 0.7)) {
            struck = true;
            if (sweep) slash(mover.position, along, glow);
            shatter(victim, victimYaw, along);
          }
        } else {
          // Follow through.
          const f = (k - 0.8) / 0.2;
          data.arm.rotation.x = data.hit;
          pose(mover, yaw + (sweep ? mix(THROUGH, THROUGH + 0.25, f) : 0), along, mix(lean, sweep ? 0.1 : 0.2, f));
          mover.position.copy(reach).addScaledVector(along, 0.24);
          if (!struck) {
            struck = true;
            if (sweep) slash(mover.position, along, glow);
            shatter(victim, victimYaw, along);
          }
        }
      },
      undefined,
      400,
    );

    // 3. Lower the weapon, square up, and take the square.
    const lunge = reach.clone().addScaledVector(along, 0.24);
    tween(
      380,
      (k) => {
        const e = ease(k);
        data.arm.rotation.x = mix(data.hit, 0, e);
        mover.position.lerpVectors(lunge, to, e);
        pose(mover, mixYaw(yaw + (sweep ? THROUGH + 0.25 : 0), data.facing, e), along, (sweep ? 0.1 : 0.2) * (1 - e));
      },
      () => finish(game),
      880,
    );
  };

  const show = (game: GameState) => {
    if (busy) {
      waiting = game;
      return;
    }
    const before = shown;
    const move = game.lastMove;
    const mover = move ? statues.get(move.from) : undefined;
    // Animate only a single step on from what is on screen.
    const continues =
      before !== null &&
      move !== null &&
      mover !== undefined &&
      game.positionId !== before.positionId &&
      before.board[move.from] !== undefined &&
      game.board[move.from] === undefined &&
      game.board[move.to] !== undefined;
    if (!continues || !move || !mover) {
      reconcile(game.board);
      markers(game);
      mate(game);
      shown = game;
      return;
    }
    busy = true;
    markers(game);
    const from = squarePosition(move.from);
    const to = squarePosition(move.to);
    // En passant: the pawn taken stands beside the mover, not on the square moved to. A piece that strikes from a distance can shoot it where it stands.
    const ranged = mover.userData.strike === 'arrow' || mover.userData.strike === 'bolt';
    const beside = `${move.to[0]}${move.from[1]}` as Square;
    const passed = ranged && mover.userData.code[1] === 'P' && move.from[0] !== move.to[0] && !statues.has(move.to) && statues.has(beside);
    const victimAt = passed ? beside : move.to;
    const victim = statues.get(victimAt);
    statues.delete(move.from);
    if (victim) statues.delete(victimAt);
    statues.set(move.to, mover);
    // The statue keeps its old identity until the engine's board says otherwise
    // (a promotion is swapped in by `reconcile` when the move ends).
    const taken = victim !== undefined && victim.userData.code[0] !== mover.userData.code[0];
    // A pawn that arrives as something else has been promoted. `reconcile`
    // swaps the statue; the expressive style dresses the swap up.
    const promoted = mover.userData.code[1] === 'P' && game.board[move.to] !== mover.userData.code;
    const arrived = () => {
      if (!promoted || calm || minimal) {
        finish(game);
        return;
      }
      // The pawn dissolves upward, then the new piece forms where it stood.
      const material = mover.userData.material;
      tween(
        380,
        (k) => {
          mover.position.copy(to).setY(0.7 * k * k);
          mover.scale.set(1 - 0.4 * k, 1 + 0.5 * k, 1 - 0.4 * k);
          material.opacity = 0.94 * (1 - k);
        },
        () => {
          finish(game);
          const piece = statues.get(move.to);
          if (piece) form(piece);
        },
      );
    };
    if (taken && !calm && !minimal && !promoted) {
      fight(mover, victim, from, to, game);
    } else {
      if (victim) {
        if (calm) scene.remove(victim);
        else fade(victim);
      }
      const quick = calm || minimal;
      tween(
        calm ? 160 : minimal ? 240 : 420,
        (k) => {
          mover.position.lerpVectors(from, to, ease(k)).setY(quick ? 0 : Math.sin(k * Math.PI) * 0.1);
        },
        arrived,
      );
    }
  };

  /** Draw (or clear) the best-move arrow: a flat shape on the board from one square to another. */
  /** A flat arrow lying on the board from the centre of one square toward another. */
  const arrowMesh = (from: Square, to: Square, material: THREE.Material, y: number) => {
    const a = squarePosition(from);
    const b = squarePosition(to);
    const length = a.distanceTo(b);
    if (length === 0) return null;
    // An arrow along +x in the shape's own plane.
    const start = 0.32;
    const neck = length - 0.42;
    const shape = new THREE.Shape();
    shape.moveTo(start, -0.07);
    shape.lineTo(neck, -0.07);
    shape.lineTo(neck, -0.2);
    shape.lineTo(length - 0.08, 0);
    shape.lineTo(neck, 0.2);
    shape.lineTo(neck, 0.07);
    shape.lineTo(start, 0.07);
    shape.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), material);
    // Lay it flat, then turn it within the board plane to point at the target.
    mesh.rotation.set(-Math.PI / 2, 0, Math.atan2(-(b.z - a.z), b.x - a.x));
    mesh.position.copy(a).setY(y);
    mesh.renderOrder = 2;
    return mesh;
  };

  const setBest = (move: { from: Square; to: Square } | null) => {
    if (bestArrow) {
      scene.remove(bestArrow);
      bestArrow.geometry.dispose();
      bestArrow = null;
    }
    if (!move) return;
    bestArrow = arrowMesh(move.from, move.to, bestMaterial, 0.014);
    if (bestArrow) scene.add(bestArrow);
  };

  // The fact under inspection: its own primitives, laid on the board, and the
  // statues it names lit up. Nothing here is worked out from the position;
  // every arrow, ring, square and file is one the engine supplied.
  const focusGroup = new THREE.Group();
  scene.add(focusGroup);
  let lit = new Set<Square>();
  const setFocus = (viz: readonly Viz[]) => {
    for (const child of [...focusGroup.children] as THREE.Mesh[]) {
      focusGroup.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    lit = new Set();
    const lay = (geometry: THREE.BufferGeometry, material: THREE.Material, at: THREE.Vector3, y: number) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(at).setY(y);
      mesh.renderOrder = 3;
      focusGroup.add(mesh);
    };
    for (const v of viz) {
      const spec = styleSpec(v.style);
      const paint = (opacity: number) =>
        new THREE.MeshBasicMaterial({ color: spec.color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide });
      if (v.type === 'arrow') {
        lit.add(v.from).add(v.to);
        const arrow = arrowMesh(v.from, v.to, paint(spec.dashed ? 0.6 : 0.9), 0.018);
        if (arrow) focusGroup.add(arrow);
        if (spec.beam) {
          // A pin or skewer is a line through pieces: show it at their height too.
          const a = squarePosition(v.from).setY(0.62);
          const b = squarePosition(v.to).setY(0.62);
          const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, a.distanceTo(b), 8), paint(0.55));
          beam.position.copy(a).add(b).multiplyScalar(0.5);
          beam.quaternion.setFromUnitVectors(UP, b.clone().sub(a).normalize());
          focusGroup.add(beam);
        }
      } else if (v.type === 'ring') {
        lit.add(v.square);
        lay(new THREE.RingGeometry(0.4, 0.485, 40), paint(0.95), squarePosition(v.square), 0.016);
      } else if (v.type === 'square') {
        lay(new THREE.PlaneGeometry(0.96, 0.96), paint(0.34), squarePosition(v.square), 0.012);
      } else {
        const x = v.file.charCodeAt(0) - 97 - 3.5;
        lay(new THREE.PlaneGeometry(0.96, 7.96), paint(0.16), new THREE.Vector3(x, 0, 0), 0.01);
      }
    }
  };

  // File letters and rank numbers on the rim, along the near and left edges.
  const labels = new THREE.Group();
  labels.visible = false;
  scene.add(labels);
  const label = (text: string) => {
    const size = 64;
    const paper = document.createElement('canvas');
    paper.width = paper.height = size;
    const pen = paper.getContext('2d');
    if (pen) {
      pen.font = '600 46px Georgia, serif';
      pen.textAlign = 'center';
      pen.textBaseline = 'middle';
      pen.fillStyle = '#b4c2d0';
      pen.fillText(text, size / 2, size / 2 + 3);
    }
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.3, 0.3),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(paper), transparent: true, opacity: 0.7, depthWrite: false }),
    );
    labels.add(mesh);
    return mesh;
  };
  const fileLabels = [...FILES].map(label);
  const rankLabels = ['1', '2', '3', '4', '5', '6', '7', '8'].map(label);
  const layLabels = () => {
    const spin = side === 1 ? 0 : Math.PI;
    fileLabels.forEach((mesh, i) => {
      mesh.position.set(i - 3.5, -0.012, 4.175 * side);
      mesh.rotation.set(-Math.PI / 2, 0, spin);
    });
    rankLabels.forEach((mesh, i) => {
      mesh.position.set(-4.175 * side, -0.012, 3.5 - i);
      mesh.rotation.set(-Math.PI / 2, 0, spin);
    });
  };

  const select = (square: Square | null, targets: readonly LegalMove[], showHints: boolean) => {
    selected = square;
    selectedMark.visible = square !== null;
    if (square) selectedMark.position.copy(squarePosition(square)).setY(0.007);
    hints.forEach((hint) => scene.remove(hint));
    hints.length = 0;
    if (!showHints) return;
    for (const move of targets) {
      const mesh = new THREE.Mesh(
        move.capture ? ring : dot,
        new THREE.MeshBasicMaterial({ color: move.capture ? 0xff6b5f : 0xcfe6ff, transparent: true, opacity: 0.8, depthWrite: false }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.copy(squarePosition(move.to)).setY(0.009);
      scene.add(mesh);
      hints.push(mesh);
    }
  };

  /** Put the camera where the chosen view wants it, gliding there unless motion is reduced. */
  const moveCamera = (glide: boolean) => {
    // Pull back on narrow frames so the whole board stays in view.
    const distance = Math.max(1, 4 / 3 / camera.aspect);
    const to = new THREE.Vector3();
    const look = new THREE.Vector3();
    if (CLOSEUP) {
      // Stand on the board and look at white's back rank, from in front of it or behind.
      to.set(-1, 1.6, CLOSEUP === 'front' ? -1.6 : 8.6);
      look.set(-1, 0.55, 3.5);
    } else if (view === 'focus' && framed.length > 0) {
      const points = framed.map(squarePosition);
      const centre = points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).multiplyScalar(1 / points.length);
      const reach = Math.max(...points.map((p) => p.distanceTo(centre)));
      look.copy(centre).setY(0.3);
      to.set(centre.x, (2.7 + 1.5 * reach) * distance, centre.z + (3.7 + 1.9 * reach) * side * distance);
    } else if (view === 'play') {
      to.set(0, 6.2 * distance, 10 * side * distance);
      look.set(0, -0.2, 0.75 * side);
    } else {
      to.set(0, 10.4 * distance, 6.3 * side * distance);
      look.set(0, 0, 0.45 * side);
    }
    if (!glide || calm || minimal) {
      cameraHome.copy(to);
      cameraLook.copy(look);
      camera.position.copy(to);
      camera.lookAt(look);
      return;
    }
    const from = cameraHome.clone();
    const fromLook = cameraLook.clone();
    tween(420, (k) => {
      const e = ease(k);
      cameraHome.lerpVectors(from, to, e);
      cameraLook.lerpVectors(fromLook, look, e);
      camera.position.copy(cameraHome);
      camera.lookAt(cameraLook);
    });
  };

  const setCamera = (orientation: Color, width: number, height: number) => {
    side = orientation === 'white' ? 1 : -1;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    key.position.set(-5 * side, 10, 6 * side);
    rim.position.set(5 * side, 5, -7 * side);
    layLabels();
    moveCamera(false);
  };
  const setView = (next: CameraView) => {
    if (next === view) return;
    view = next;
    moveCamera(true);
  };
  const setFrame = (squares: readonly Square[]) => {
    framed = squares;
    if (view === 'focus') moveCamera(true);
  };

  const raycaster = new THREE.Raycaster();
  const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  const squareUnder = (clientX: number, clientY: number): Square | null => {
    const rect = canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    raycaster.setFromCamera(pointer, camera);
    const point = new THREE.Vector3();
    return raycaster.ray.intersectPlane(ground, point) ? squareFromPoint(point) : null;
  };

  const frame = (now: number) => {
    if (disposed) return;
    // Keep drawing while anything is moving: an animation, a selected piece
    // (it pulses), the tremor of a blow, or a change in the last second and a
    // half (which lets a raised piece settle). Otherwise draw this one frame
    // and stop until something wakes the loop.
    const moving = tweens.length > 0 || busy || selected !== null || shake !== 0 || now < awakeUntil;
    if (moving) requestAnimationFrame(frame);
    else looping = false;
    const running = tweens;
    tweens = [];
    for (const item of running) {
      const k = Math.min(1, Math.max(0, (now - item.start) / item.duration));
      if (now >= item.start) item.step(k);
      if (k < 1) tweens.push(item);
      else item.done?.();
    }
    // A selected statue rises and brightens; the rest settle back.
    if (!busy) {
      for (const [square, statue] of statues) {
        const data = statue.userData;
        if (data.frozen) continue;
        const awake = square === selected ? 1 : 0;
        data.lift += (awake - data.lift) * 0.2;
        statue.position.y = data.lift * 0.16;
        // Awake, it half-raises its weapon, ready.
        data.arm.rotation.x = Math.sign(data.hit) * 0.35 * data.lift;
        data.shine += ((lit.has(square) ? 1 : 0) - data.shine) * 0.2;
        const rest = data.code[0] === 'w' ? ICE.rest : AMETHYST.rest;
        data.material.emissiveIntensity = rest + data.lift * (0.5 + 0.12 * Math.sin(now / 180)) + data.shine * 0.6;
      }
    }
    // The jolt of a blow: a quick, dying tremor.
    if (shake > 0.01) {
      camera.position.set(
        cameraHome.x + Math.sin(now / 13) * 0.07 * shake,
        cameraHome.y + Math.cos(now / 17) * 0.05 * shake,
        cameraHome.z,
      );
      shake *= 0.86;
    } else if (shake !== 0) {
      shake = 0;
      camera.position.copy(cameraHome);
    }
    renderer.render(scene, camera);
  };
  wake();

  /** Every way the scene can be changed from outside goes through here. */
  const waking = <A extends unknown[], T>(fn: (...args: A) => T) =>
    (...args: A): T => {
      const result = fn(...args);
      wake();
      return result;
    };

  return {
    show: waking(show),
    select: waking(select),
    setCamera: waking(setCamera),
    squareUnder,
    setBest: waking(setBest),
    setFocus: waking(setFocus),
    setView: waking(setView),
    setFrame: waking(setFrame),
    /** Rebuild every statue from another source of shapes. Null: the built-in ones. */
    setShapes: waking((lookup: ((kind: string) => Sculpture) | null) => {
      const next = lookup ?? sculpture;
      if (busy) {
        shapesWaiting = next;
        return;
      }
      shapeOf = next;
      for (const statue of statues.values()) scene.remove(statue);
      statues.clear();
      mated = null;
      if (shown) {
        reconcile(shown.board);
        mate(shown);
      }
    }),
    setCoords: waking((value: boolean) => {
      labels.visible = value;
    }),
    setCalm: waking((value: boolean) => {
      calm = value;
    }),
    setMinimal: waking((value: boolean) => {
      minimal = value;
    }),
    /** True while the draw loop is running. For tests and for the curious. */
    drawing: () => looping,
    dispose() {
      disposed = true;
      renderer.dispose();
    },
  };
}

/** One line saying what a loaded model set actually put on the board. */
function modelReport(set: StatueSet): string {
  const kept = [...set.failed.map((f) => f.piece), ...set.missing];
  const parts = [`${set.name}: ${set.loaded.length} of 6 pieces from models, ${set.triangles.toLocaleString('en-US')} triangles across those shapes`];
  if (kept.length > 0) parts.push(`built-in statue kept for ${kept.join(', ')}`);
  if (set.note) parts.push(set.note);
  return parts.join(' · ');
}

export default function Board3D({
  game,
  orientation,
  interactive,
  thinking,
  showHints,
  minimal = false,
  bestMove = null,
  focus = null,
  frameSquares,
  showCoords = false,
  models = null,
  onMove,
  onSquareClick,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useRef<ReturnType<typeof createWorld> | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<LegalMove[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [view, setView] = useState<CameraView>('play');
  // What became of the model set asked for: nothing asked, loading, loaded, or unusable.
  const [modelSet, setModelSet] = useState<StatueSet | 'loading' | 'failed' | null>(null);
  const canFocus = (frameSquares?.length ?? 0) > 0;

  const legal = useMemo(() => (interactive ? game.legalMoves : []), [game.legalMoves, interactive]);
  const targets = useMemo(() => targetsFrom(legal, selected), [legal, selected]);

  useEffect(() => {
    try {
      world.current = createWorld(canvasRef.current!);
    } catch {
      setFailed(true);
      return;
    }
    return () => {
      world.current?.dispose();
      world.current = null;
    };
  }, []);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !world.current) return;
    const fit = () => world.current?.setCamera(orientation, frame.clientWidth, frame.clientHeight);
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [orientation, failed]);

  useEffect(() => {
    setSelected(null);
    setPromotion(null);
  }, [game.positionId]);

  useEffect(() => {
    world.current?.setMinimal(minimal);
  }, [minimal, failed]);

  useEffect(() => {
    world.current?.show(game);
  }, [game]);

  const bestFrom = bestMove?.from ?? null;
  const bestTo = bestMove?.to ?? null;
  useEffect(() => {
    world.current?.setBest(bestFrom && bestTo ? { from: bestFrom, to: bestTo } : null);
  }, [bestFrom, bestTo, failed]);

  useEffect(() => {
    world.current?.select(selected, targets, showHints);
  }, [selected, targets, showHints]);

  useEffect(() => {
    world.current?.setFocus(focus ?? []);
  }, [focus, failed]);
  useEffect(() => {
    world.current?.setFrame(frameSquares ?? []);
  }, [frameSquares, failed]);
  useEffect(() => {
    world.current?.setView(view);
  }, [view, failed]);
  useEffect(() => {
    world.current?.setCoords(showCoords);
  }, [showCoords, failed]);

  useEffect(() => {
    if (!models) {
      setModelSet(null);
      world.current?.setShapes(null);
      return;
    }
    let current = true;
    setModelSet('loading');
    loadStatueSet(models).then(
      (set) => {
        if (!current) return;
        setModelSet(set);
        world.current?.setShapes(set.lookup);
      },
      () => {
        // No manifest, or an unreadable one: the built-in statues stay.
        if (!current) return;
        setModelSet('failed');
        world.current?.setShapes(null);
      },
    );
    return () => {
      current = false;
    };
  }, [models, failed]);

  const press = (clientX: number, clientY: number) => {
    const square = world.current?.squareUnder(clientX, clientY);
    if (!square || promotion) return;
    onSquareClick?.(square);
    const action = activateSquare(legal, selected, square);
    switch (action.kind) {
      case 'move':
        onMove(action.uci);
        setSelected(null);
        break;
      case 'promotion':
        setPromotion(action.options);
        setSelected(null);
        break;
      case 'select':
        setSelected(action.square);
        break;
      default:
        setSelected(null);
    }
  };

  if (failed) {
    return (
      <div className="board-frame board-3d-failed" role="status">
        This browser could not start 3D graphics. Choose Classic or Figures under Pieces.
      </div>
    );
  }

  return (
    <div className={`board-frame board-3d${thinking ? ' board-thinking' : ''}`}>
      <div ref={frameRef} className="board-3d-view">
        <canvas
          ref={canvasRef}
          className={`board-3d-canvas${interactive ? '' : ' board-locked'}`}
          role="img"
          aria-label={`Chess board in 3D, ${game.turn} to move. Use Classic or Figures for keyboard play.`}
          onClick={(event) => press(event.clientX, event.clientY)}
        />
      </div>
      <div className="board-3d-views" role="group" aria-label="Camera">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            className={`btn-toggle${view === v.id ? ' btn-toggle-on' : ''}`}
            aria-pressed={view === v.id}
            title={v.hint}
            disabled={v.id === 'focus' && !canFocus && view !== 'focus'}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </div>
      {modelSet !== null && (
        <p className="board-3d-models" role="status" data-models={typeof modelSet === 'string' ? modelSet : 'loaded'}>
          {modelSet === 'loading'
            ? 'Loading models…'
            : modelSet === 'failed'
              ? 'No model set could be loaded. Showing the built-in statues.'
              : modelReport(modelSet)}
        </p>
      )}
      {promotion && (
        <PromotionPicker
          options={promotion}
          turn={game.turn}
          onChoose={(uci) => {
            onMove(uci);
            setPromotion(null);
          }}
          onCancel={() => setPromotion(null)}
        />
      )}
    </div>
  );
}
