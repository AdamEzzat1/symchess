// The 3D board: the same position, drawn as glass statues that fight when one
// takes another. Presentation only. Legal moves still come from the engine's
// list, and after every animation the scene is reconciled against the
// engine's board, so what is on screen can never drift from the real position.

import { useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { FILES } from '../geometry';
import { activateSquare, targetsFrom } from '../moveInput';
import type { Color, GameState, LegalMove, PieceCode, Square } from '../protocol';
import { PromotionPicker } from './Board';
import { sculpture } from './statues';

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
  /** The weapon arm, hinged at the shoulder. */
  arm: THREE.Group;
  /** Shoulder angles for the wind-up and for the moment of the blow. */
  windup: number;
  hit: number;
  /** How far the body leans back before striking (a horse rears). */
  rear: number;
  /** A checkmated king: frosted over, and left alone by the idle animation. */
  frozen?: boolean;
}

interface Statue extends THREE.Group {
  userData: StatueData;
}

/** One statue: the shared sculpture for its piece type, in its side's glass. */
function buildStatue(code: PieceCode): Statue {
  const white = code[0] === 'w';
  const tone = white ? ICE : AMETHYST;
  const shape = sculpture(code[1]!);
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
    flatShading: true,
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
  group.userData = { code, material, facing, lift: 0, arm, windup: shape.windup, hit: shape.hit, rear: shape.rear };
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
    new THREE.BoxGeometry(8.5, 0.3, 8.5),
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
        statue = buildStatue(code);
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

  /**
   * Turn to face the enemy and close in; draw the weapon back; strike, fast;
   * then lower the weapon and take the square. A little over a second.
   */
  const fight = (mover: Statue, victim: Statue, from: THREE.Vector3, to: THREE.Vector3, game: GameState) => {
    const data = mover.userData;
    const along = to.clone().sub(from).normalize();
    const back = along.clone().negate();
    const reach = to.clone().addScaledVector(along, -0.7);
    const yaw = yawToward(along);
    const victimYaw = yawToward(back);
    const braced = victim.userData.facing;

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
          pose(mover, yaw, along, -data.rear * w);
          mover.position.copy(reach).addScaledVector(along, -0.07 * w);
        } else if (k < 0.8) {
          const h = ((k - 0.6) / 0.2) ** 2;
          data.arm.rotation.x = mix(data.windup, data.hit, h);
          pose(mover, yaw, along, mix(-data.rear, 0.34, h));
          mover.position.copy(reach).addScaledVector(along, mix(-0.07, 0.24, h));
          if (!struck && h > 0.7) {
            struck = true;
            shatter(victim, victimYaw, along);
          }
        } else {
          // Follow through.
          const f = (k - 0.8) / 0.2;
          data.arm.rotation.x = data.hit;
          pose(mover, yaw, along, mix(0.34, 0.2, f));
          mover.position.copy(reach).addScaledVector(along, 0.24);
          if (!struck) {
            struck = true;
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
        pose(mover, mixYaw(yaw, data.facing, e), along, 0.2 * (1 - e));
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
    const victim = statues.get(move.to);
    statues.delete(move.from);
    if (victim) statues.delete(move.to);
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
  const setBest = (move: { from: Square; to: Square } | null) => {
    if (bestArrow) {
      scene.remove(bestArrow);
      bestArrow.geometry.dispose();
      bestArrow = null;
    }
    if (!move) return;
    const a = squarePosition(move.from);
    const b = squarePosition(move.to);
    const length = a.distanceTo(b);
    if (length === 0) return;
    // An arrow along +x in the shape's own plane, from the centre of one square to the next.
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
    bestArrow = new THREE.Mesh(new THREE.ShapeGeometry(shape), bestMaterial);
    // Lay it flat, then turn it within the board plane to point at the target.
    bestArrow.rotation.set(-Math.PI / 2, 0, Math.atan2(-(b.z - a.z), b.x - a.x));
    bestArrow.position.copy(a).setY(0.014);
    bestArrow.renderOrder = 2;
    scene.add(bestArrow);
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

  const setCamera = (orientation: Color, width: number, height: number) => {
    const side = orientation === 'white' ? 1 : -1;
    camera.aspect = width / height;
    // Pull back on narrow frames so the whole board stays in view.
    const distance = Math.max(1, 4 / 3 / camera.aspect);
    cameraHome.set(0, 6.2 * distance, 10.0 * side * distance);
    camera.position.copy(cameraHome);
    camera.lookAt(0, -0.2, 0.75 * side);
    if (CLOSEUP) {
      // Stand on the board and look at white's back rank, from in front of it or behind.
      cameraHome.set(-1, 1.6, CLOSEUP === 'front' ? -1.6 : 8.6);
      camera.position.copy(cameraHome);
      camera.lookAt(-1, 0.55, 3.5);
    }
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    key.position.set(-5 * side, 10, 6 * side);
    rim.position.set(5 * side, 5, -7 * side);
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
        const rest = data.code[0] === 'w' ? ICE.rest : AMETHYST.rest;
        data.material.emissiveIntensity = rest + data.lift * (0.5 + 0.12 * Math.sin(now / 180));
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

export default function Board3D({
  game,
  orientation,
  interactive,
  thinking,
  showHints,
  minimal = false,
  bestMove = null,
  onMove,
  onSquareClick,
}: Props) {
  const frameRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useRef<ReturnType<typeof createWorld> | null>(null);
  const [selected, setSelected] = useState<Square | null>(null);
  const [promotion, setPromotion] = useState<LegalMove[] | null>(null);
  const [failed, setFailed] = useState(false);

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
