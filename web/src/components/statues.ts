// The shapes of the 3D pieces: carved figures on stone plinths. Shape only;
// colour and material belong to the board that draws them.
//
// Each piece type is built once from simple solids and baked into a few merged
// geometries, so a statue costs a handful of draw calls however detailed it
// is. A statue's front is -z. Every statue has a weapon arm hinged at the
// shoulder, kept as separate geometry, which is what swings in a fight.

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface Sculpture {
  body: THREE.BufferGeometry;
  /** The small glowing details: eyes, windows, jewels. */
  gems: THREE.BufferGeometry | null;
  /** The weapon arm, in coordinates relative to `shoulder`. */
  arm: THREE.BufferGeometry | null;
  armGems: THREE.BufferGeometry | null;
  shoulder: THREE.Vector3;
  /** Shoulder angles for the wind-up and for the moment of the blow. */
  windup: number;
  hit: number;
  /** How far the body leans back before striking. */
  rear: number;
  /**
   * How it delivers a blow. "arm" swings the weapon arm (the default). "sweep"
   * is for a statue with no arm to swing: the whole figure twists away and
   * whips round, weapon side leading, and a bright arc follows the swing.
   * "arrow" also strikes from a distance: a bow of light is drawn at `emitter`
   * and an arrow flies to the enemy.
   * "bolt" strikes from a distance: light gathers at `emitter` and a bolt of
   * it flies to the enemy.
   */
  strike?: 'arm' | 'sweep' | 'bolt' | 'arrow';
  /** Where a bolt leaves the statue (the head of a staff, say), in the statue's own coordinates. */
  emitter?: THREE.Vector3;
  /** Shade with the model's own normals, not facet by facet. Sculpted models set this. */
  smooth?: boolean;
}

const UP = new THREE.Vector3(0, 1, 0);
const ONE = new THREE.Vector3(1, 1, 1);
const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
const turn = (x: number, y: number, z: number) => new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z));
const along = (direction: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(UP, direction.clone().normalize());
const frame = (at: THREE.Vector3, q = new THREE.Quaternion(), scale = ONE) => new THREE.Matrix4().compose(at, q, scale);

/** The top of the plinth: where a figure's feet are. */
const F = 0.13;

function sculpt(kind: string): Sculpture {
  const bins = { body: [], gems: [], arm: [], armGems: [] } as Record<'body' | 'gems' | 'arm' | 'armGems', THREE.BufferGeometry[]>;
  let matrix = new THREE.Matrix4();
  let onArm = false;
  let asGem = false;

  const push = (geometry: THREE.BufferGeometry, local?: THREE.Matrix4) => {
    const g = geometry.index ? geometry.toNonIndexed() : geometry;
    if (local) g.applyMatrix4(local);
    g.applyMatrix4(matrix);
    bins[onArm ? (asGem ? 'armGems' : 'arm') : asGem ? 'gems' : 'body'].push(g);
  };
  /** Build `fn`'s solids inside a moved, turned or scaled frame. */
  const within = (m: THREE.Matrix4, fn: () => void) => {
    const saved = matrix;
    matrix = saved.clone().multiply(m);
    fn();
    matrix = saved;
  };
  /** Where a point of the current frame ends up on the finished statue. */
  const placed = (p: THREE.Vector3) => p.clone().applyMatrix4(matrix);
  const gem = (fn: () => void) => {
    asGem = true;
    fn();
    asGem = false;
  };
  /** Build the weapon arm, in coordinates relative to its shoulder. */
  const armed = (fn: () => void) => {
    const saved = matrix;
    matrix = new THREE.Matrix4();
    onArm = true;
    fn();
    onArm = false;
    matrix = saved;
  };

  const rod = (a: THREE.Vector3, b: THREE.Vector3, ra: number, rb = ra, sides = 8) => {
    const d = b.clone().sub(a);
    push(new THREE.CylinderGeometry(rb, ra, d.length(), sides), frame(a.clone().add(b).multiplyScalar(0.5), along(d)));
  };
  const thorn = (base: THREE.Vector3, tip: THREE.Vector3, r: number, sides = 5) => {
    const d = tip.clone().sub(base);
    push(new THREE.ConeGeometry(r, d.length(), sides), frame(base.clone().add(tip).multiplyScalar(0.5), along(d)));
  };
  const orb = (c: THREE.Vector3, r: number, sx = 1, sy = 1, sz = 1) =>
    push(new THREE.SphereGeometry(r, 10, 7), frame(c, undefined, V(sx, sy, sz)));
  const slab = (c: THREE.Vector3, w: number, h: number, d: number, q?: THREE.Quaternion) =>
    push(new THREE.BoxGeometry(w, h, d), frame(c, q));
  const chip = (c: THREE.Vector3, r: number, spin: number) =>
    push(new THREE.TetrahedronGeometry(r), frame(c, turn(spin, spin * 2.3, spin * 1.7)));

  /**
   * A turned solid from a profile of [radius, height] pairs, its foot at `y`.
   * `folds` pleats it like hanging cloth, deepest at the hem; `squash` flattens
   * it front to back; `start` and `sweep` leave it open, for a cloak.
   */
  const turned = (
    profile: [number, number][],
    y: number,
    o: { sides?: number; folds?: number; amp?: number; squash?: number; start?: number; sweep?: number } = {},
  ) => {
    const sides = o.folds ? o.folds * 2 : (o.sides ?? 12);
    const sweep = o.sweep ?? Math.PI * 2;
    const g = new THREE.LatheGeometry(
      profile.map(([r, h]) => new THREE.Vector2(r, h)),
      Math.max(3, Math.round((sides * sweep) / (Math.PI * 2))),
      o.start ?? 0,
      sweep,
    );
    if (o.folds) {
      const p = g.attributes.position!;
      const top = profile[profile.length - 1]![1];
      for (let i = 0; i < p.count; i++) {
        const fall = Math.max(0, 1 - p.getY(i) / top) ** 1.5;
        const k = 1 + (o.amp ?? 0.1) * fall * Math.cos(o.folds * Math.atan2(p.getX(i), p.getZ(i)));
        p.setX(i, p.getX(i) * k);
        p.setZ(i, p.getZ(i) * k);
      }
    }
    push(g, frame(V(0, y, 0), undefined, V(1, 1, o.squash ?? 1)));
  };

  // What figures are made of.
  const head = (c: THREE.Vector3, r: number) => {
    orb(c, r, 0.92, 1.08, 0.98);
    thorn(V(c.x, c.y, c.z - r * 0.8), V(c.x, c.y - r * 0.25, c.z - r * 1.22), r * 0.2, 4); // the nose
    slab(V(c.x, c.y + r * 0.22, c.z - r * 0.86), r * 1.1, r * 0.14, r * 0.2); // the brow
  };
  const limb = (a: THREE.Vector3, joint: THREE.Vector3, b: THREE.Vector3, r: number) => {
    orb(a, r * 1.2);
    rod(a, joint, r, r * 0.9);
    orb(joint, r * 0.98);
    rod(joint, b, r * 0.9, r * 0.74);
  };
  const arm = (shoulder: THREE.Vector3, elbow: THREE.Vector3, hand: THREE.Vector3, r = 0.034) => {
    limb(shoulder, elbow, hand, r);
    orb(hand, r * 1.05);
  };
  const leg = (hip: THREE.Vector3, knee: THREE.Vector3, foot: THREE.Vector3, r: number) => {
    limb(hip, knee, V(foot.x, foot.y + 0.03, foot.z), r);
    slab(V(foot.x, foot.y + 0.022, foot.z - r * 0.7), r * 1.8, 0.044, r * 3.4);
  };
  /** A sword whose grip is at `hand` and whose blade runs toward `direction`. */
  const sword = (hand: THREE.Vector3, direction: THREE.Vector3, length: number, width = 0.036) => {
    const d = direction.clone().normalize();
    const q = along(d);
    const out = (k: number) => hand.clone().addScaledVector(d, k);
    slab(out(0.035 + length / 2), width, length, 0.013, q);
    thorn(out(0.035 + length), out(0.035 + length + width * 1.4), width * 0.5, 4);
    slab(out(0.028), width * 3.8, 0.022, 0.03, q);
    rod(out(-0.075), out(0.02), 0.013);
    gem(() => orb(out(-0.09), 0.021));
  };

  // The plinth every statue stands on: two rough courses of stone and some rubble.
  push(new THREE.CylinderGeometry(0.385, 0.42, 0.07, 14), frame(V(0, 0.035, 0)));
  push(new THREE.CylinderGeometry(0.33, 0.36, 0.06, 11), frame(V(0, 0.1, 0), turn(0, 0.3, 0)));
  for (let i = 0; i < 7; i++) {
    const a = i * 2.4 + 0.5;
    const r = i % 2 ? 0.3 : 0.37;
    chip(V(Math.cos(a) * r, (i % 2 ? F : 0.07) + 0.012, Math.sin(a) * r), 0.022 + (i % 3) * 0.008, a);
  }

  let shoulder = V(0, F + 0.5, 0);
  let windup = 3.3;
  let hit = 1.25;
  let rear = 0.18;

  switch (kind) {
    // A foot soldier caught mid-stride: hood, kite shield, short sword held low.
    case 'P': {
      within(frame(V(0, F, 0), undefined, V(1.2, 1.2, 1.2)), () => {
        leg(V(-0.055, 0.25, 0), V(-0.078, 0.13, -0.09), V(-0.08, 0, -0.07), 0.046);
        leg(V(0.055, 0.25, 0), V(0.075, 0.13, 0.05), V(0.09, 0, 0.13), 0.046);
        turned([[0.14, 0], [0.105, 0.1], [0.088, 0.15], [0.108, 0.25], [0.1, 0.3], [0.045, 0.33]], 0.16, { folds: 8, amp: 0.14, squash: 0.8 });
        slab(V(0, 0.315, 0), 0.19, 0.03, 0.15); // the belt
        const top = 0.56;
        rod(V(0, 0.47, 0), V(0, top - 0.04, 0), 0.04, 0.034);
        head(V(0, top, -0.008), 0.066);
        orb(V(0, top + 0.012, 0.016), 0.076); // the hood
        turned([[0.115, 0], [0.05, 0.07]], 0.43, { sides: 9, squash: 0.85 });
        arm(V(-0.12, 0.45, 0), V(-0.175, 0.34, -0.02), V(-0.155, 0.33, -0.11));
        const kite = new THREE.Shape();
        kite.moveTo(-0.095, 0.12);
        kite.lineTo(0.095, 0.12);
        kite.lineTo(0.105, 0.02);
        kite.lineTo(0, -0.17);
        kite.lineTo(-0.105, 0.02);
        kite.closePath();
        const face = frame(V(-0.17, 0.32, -0.15), turn(0.1, 0.5, 0));
        push(new THREE.ExtrudeGeometry(kite, { depth: 0.024, bevelEnabled: false }), face);
        within(face, () => gem(() => orb(V(0, 0.03, -0.006), 0.03)));
        shoulder = placed(V(0.12, 0.45, 0));
      });
      armed(() => {
        arm(V(0, 0, 0), V(0.06, -0.12, 0.035), V(0.085, -0.2, -0.06), 0.04);
        sword(V(0.085, -0.2, -0.06), V(0.25, -0.55, -0.8), 0.3, 0.042);
      });
      break;
    }
    // A stone tower: courses of masonry, lit windows, a corbelled parapet.
    case 'R': {
      turned([[0.31, 0], [0.31, 0.05], [0.25, 0.12]], F, { sides: 12 });
      const courses = 7;
      const height = 0.5;
      const radius = (k: number) => 0.245 - 0.03 * k;
      rod(V(0, F + 0.1, 0), V(0, F + 0.12 + height, 0), radius(0) - 0.012, radius(1) - 0.012, 12); // the mortar behind the stones
      for (let i = 0; i < courses; i++) {
        const y = F + 0.12 + (i * height) / courses;
        push(
          new THREE.CylinderGeometry(radius((i + 1) / courses), radius(i / courses), height / courses - 0.012, 12),
          frame(V(0, y + height / courses / 2, 0), turn(0, i % 2 ? Math.PI / 12 : 0, 0)),
        );
      }
      const crown = F + 0.12 + height;
      turned([[0.21, 0], [0.285, 0.06], [0.285, 0.12], [0.24, 0.12]], crown, { sides: 12 });
      for (let i = 0; i < 8; i++) {
        const a = (i * Math.PI) / 4;
        slab(V(Math.sin(a) * 0.25, crown + 0.165, Math.cos(a) * 0.25), 0.11, 0.09, 0.075, turn(0, a, 0));
      }
      gem(() => {
        for (const [a, y] of [[Math.PI, 0.38], [Math.PI, 0.18], [Math.PI / 2, 0.3], [-Math.PI / 2, 0.3]] as const) {
          const r = radius(y / height) + 0.002;
          const q = turn(0, a, 0);
          slab(V(Math.sin(a) * r, F + 0.12 + y, Math.cos(a) * r), 0.05, 0.09, 0.02, q);
          push(new THREE.CylinderGeometry(0.025, 0.025, 0.02, 8, 1, false, 0, Math.PI), frame(V(Math.sin(a) * r, F + 0.165 + y, Math.cos(a) * r), q.multiply(turn(Math.PI / 2, 0, Math.PI / 2))));
        }
      });
      chip(V(0.27, F + 0.02, -0.16), 0.04, 1.3);
      chip(V(-0.25, F + 0.02, 0.2), 0.035, 2.9);
      // A tower has no arm to swing: it leans back and falls on what it takes.
      shoulder = V(0, crown, 0);
      rear = 0.3;
      break;
    }
    // A knight in a great helm on a rearing war horse.
    case 'N': {
      const stance = frame(V(0, F, 0), turn(0, 0.6, 0));
      const rearing = frame(V(0, 0, -0.1), turn(0.6, 0, 0), V(1.18, 1.18, 1.18));
      within(stance, () => {
      within(rearing, () => {
        const barrel = new THREE.CapsuleGeometry(0.118, 0.24, 3, 10);
        push(barrel, frame(V(0, 0.36, -0.2), turn(Math.PI / 2, 0, 0)));
        orb(V(0, 0.37, -0.38), 0.132, 0.95, 1.05, 1); // the chest
        orb(V(0, 0.375, -0.03), 0.135, 1, 1, 1); // the quarters
        slab(V(0, 0.38, -0.2), 0.255, 0.16, 0.2); // the saddle cloth
        // Forelegs pawing the air.
        limb(V(-0.085, 0.3, -0.4), V(-0.085, 0.26, -0.6), V(-0.085, 0.12, -0.58), 0.04);
        orb(V(-0.085, 0.1, -0.58), 0.04);
        limb(V(0.085, 0.3, -0.4), V(0.085, 0.36, -0.6), V(0.085, 0.22, -0.66), 0.04);
        orb(V(0.085, 0.2, -0.665), 0.04);
        // Neck, mane and head.
        rod(V(0, 0.4, -0.4), V(0, 0.7, -0.5), 0.105, 0.062, 9);
        for (let i = 0; i < 5; i++) slab(V(0, 0.46 + i * 0.062, -0.345 - i * 0.022), 0.03, 0.06, 0.06, turn(-0.3, 0, 0));
        orb(V(0, 0.71, -0.51), 0.068);
        rod(V(0, 0.71, -0.51), V(0, 0.57, -0.69), 0.066, 0.04, 8);
        orb(V(0, 0.565, -0.695), 0.042);
        thorn(V(-0.04, 0.75, -0.48), V(-0.05, 0.83, -0.47), 0.02);
        thorn(V(0.04, 0.75, -0.48), V(0.05, 0.83, -0.47), 0.02);
        gem(() => {
          orb(V(-0.055, 0.69, -0.55), 0.017);
          orb(V(0.055, 0.69, -0.55), 0.017);
        });
        rod(V(0, 0.44, 0.08), V(0, 0.3, 0.2), 0.036, 0.03, 6); // the tail
        thorn(V(0, 0.3, 0.2), V(0, 0.06, 0.24), 0.034, 6);
        // The rider sits upright while the horse rears under him.
        within(frame(V(0, 0.47, -0.2), turn(-0.45, 0, 0)), () => {
          turned([[0.09, 0], [0.085, 0.06], [0.11, 0.2], [0.1, 0.25], [0.045, 0.28]], 0, { sides: 9, squash: 0.78 });
          orb(V(-0.125, 0.24, 0), 0.052, 1, 0.8, 1);
          orb(V(0.125, 0.24, 0), 0.052, 1, 0.8, 1);
          rod(V(0, 0.29, 0), V(0, 0.43, 0), 0.062, 0.066, 9); // the great helm
          rod(V(0, 0.43, 0), V(0, 0.445, 0), 0.066, 0.04, 9);
          gem(() => slab(V(0, 0.38, -0.062), 0.085, 0.014, 0.02));
          slab(V(0, 0.36, -0.066), 0.014, 0.1, 0.012);
          limb(V(-0.07, 0.03, 0), V(-0.15, -0.08, -0.12), V(-0.15, -0.24, -0.06), 0.04);
          limb(V(0.07, 0.03, 0), V(0.15, -0.08, -0.12), V(0.15, -0.24, -0.06), 0.04);
          arm(V(-0.125, 0.23, 0), V(-0.15, 0.12, -0.06), V(-0.08, 0.1, -0.17), 0.03);
          slab(V(-0.165, 0.12, -0.02), 0.022, 0.21, 0.15, turn(0, 0, 0.12)); // the shield
          shoulder = placed(V(0.125, 0.23, 0));
        });
      });
      // Hind legs planted on the plinth.
      for (const side of [-1, 1]) {
        const hip = V(side * 0.09, 0.3, -0.01).applyMatrix4(rearing);
        limb(hip, V(side * 0.1, 0.19, hip.z + 0.1), V(side * 0.1, 0.03, hip.z + 0.02), 0.047);
        orb(V(side * 0.1, 0.03, hip.z + 0.015), 0.047, 1, 0.8, 1.15);
      }
      });
      armed(() => {
        arm(V(0, 0, 0), V(0.05, -0.1, 0.02), V(0.07, -0.18, -0.03), 0.03);
        sword(V(0.07, -0.18, -0.03), V(0.12, -1, -0.1), 0.34);
      });
      rear = 0.14; // the horse is rearing already
      break;
    }
    // A stooped bishop: pleated robe, mitre, one hand reaching, crozier in the other.
    case 'B': {
      turned([[0.27, 0], [0.25, 0.04], [0.17, 0.3], [0.125, 0.5]], F, { folds: 10, amp: 0.15 });
      for (const x of [-0.035, 0.035]) slab(V(x, F + 0.25, -0.175), 0.04, 0.42, 0.014, turn(0.2, 0, 0)); // the stole
      gem(() => {
        slab(V(0, F + 0.42, -0.137), 0.022, 0.1, 0.012, turn(0.2, 0, 0));
        slab(V(0, F + 0.44, -0.134), 0.07, 0.022, 0.012, turn(0.2, 0, 0));
      });
      const waist = F + 0.5;
      within(frame(V(0, waist, 0), turn(-0.22, 0, 0)), () => {
        turned([[0.125, 0], [0.135, 0.1], [0.125, 0.2], [0.06, 0.27]], 0, { sides: 10, squash: 0.82 });
        turned([[0.2, 0], [0.16, 0.1], [0.07, 0.19]], 0.09, { folds: 7, amp: 0.1, squash: 0.9 }); // the cope
        rod(V(0, 0.26, -0.01), V(0, 0.31, -0.03), 0.04, 0.036);
        head(V(0, 0.36, -0.04), 0.07);
        const arch = new THREE.Shape();
        arch.moveTo(-0.07, 0);
        arch.lineTo(-0.078, 0.08);
        arch.quadraticCurveTo(-0.06, 0.17, 0, 0.23);
        arch.quadraticCurveTo(0.06, 0.17, 0.078, 0.08);
        arch.lineTo(0.07, 0);
        arch.closePath();
        push(new THREE.ExtrudeGeometry(arch, { depth: 0.1, bevelEnabled: false, curveSegments: 3 }), frame(V(0, 0.405, -0.09)));
        rod(V(0, 0.4, -0.04), V(0, 0.425, -0.04), 0.08, 0.08, 10);
        for (const x of [-0.03, 0.03]) slab(V(x, 0.3, 0.045), 0.03, 0.16, 0.012, turn(-0.15, 0, 0)); // the lappets
        // The reaching hand, out of a wide sleeve.
        orb(V(-0.135, 0.19, 0), 0.05);
        rod(V(-0.135, 0.19, 0), V(-0.17, 0.08, -0.11), 0.04, 0.05);
        rod(V(-0.17, 0.08, -0.11), V(-0.14, 0.11, -0.25), 0.072, 0.03, 7);
        orb(V(-0.135, 0.115, -0.27), 0.03);
        for (const dx of [-0.025, 0, 0.025]) thorn(V(-0.135 + dx, 0.115, -0.28), V(-0.135 + dx * 2.2, 0.1, -0.345), 0.009, 4);
        shoulder = placed(V(0.135, 0.19, 0));
      });
      const foot = F - shoulder.y;
      armed(() => {
        orb(V(0, 0, 0), 0.05);
        rod(V(0, 0, 0), V(0.05, -0.11, -0.05), 0.04, 0.05);
        rod(V(0.05, -0.11, -0.05), V(0.075, -0.1, -0.15), 0.07, 0.03, 7);
        orb(V(0.08, -0.1, -0.16), 0.032);
        rod(V(0.08, foot, -0.16), V(0.08, 0.5, -0.16), 0.014);
        rod(V(0.08, 0.44, -0.16), V(0.08, 0.47, -0.16), 0.024);
        push(new THREE.TorusGeometry(0.055, 0.014, 6, 12, Math.PI * 1.5), frame(V(0.08, 0.555, -0.16), turn(0, Math.PI / 2, 0)));
        gem(() => orb(V(0.08, 0.555, -0.16), 0.02));
      });
      windup = 0.55; // the staff is swung over the top and brought down
      hit = -1.35;
      break;
    }
    // A warrior queen: spiked crown and shoulders, armoured gown, long hair, a war staff.
    case 'Q': {
      turned([[0.23, 0], [0.21, 0.05], [0.135, 0.35], [0.09, 0.6]], F, { folds: 9, amp: 0.12 });
      const waist = F + 0.6;
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + Math.PI;
        const out = V(Math.sin(a), 0, Math.cos(a));
        thorn(V(out.x * 0.1, waist - 0.02, out.z * 0.085), V(out.x * 0.165, waist - 0.27, out.z * 0.15), 0.05, 4); // the tassets
      }
      turned([[0.09, 0], [0.078, 0.06], [0.112, 0.2], [0.1, 0.26], [0.042, 0.3]], waist, { sides: 9, squash: 0.76 });
      slab(V(0, waist + 0.005, 0), 0.165, 0.026, 0.13);
      gem(() => orb(V(0, waist + 0.19, -0.088), 0.024));
      const sh = waist + 0.255;
      for (const side of [-1, 1]) {
        orb(V(side * 0.135, sh, 0), 0.062, 1.1, 0.8, 1);
        thorn(V(side * 0.14, sh, 0), V(side * 0.25, sh + 0.11, 0.01), 0.026);
        thorn(V(side * 0.15, sh, -0.02), V(side * 0.24, sh + 0.02, -0.05), 0.022);
        thorn(V(side * 0.15, sh, 0.02), V(side * 0.23, sh + 0.04, 0.07), 0.022);
      }
      rod(V(0, waist + 0.29, 0), V(0, waist + 0.34, 0), 0.036, 0.032);
      const top = waist + 0.4;
      head(V(0, top, -0.005), 0.066);
      rod(V(0, top + 0.01, 0.025), V(0, top - 0.3, 0.09), 0.066, 0.045, 7); // her hair
      rod(V(0, top + 0.03, 0), V(0, top + 0.065, 0), 0.066, 0.072, 10);
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + Math.PI;
        const tall = i === 0 ? 0.19 : i % 2 ? 0.15 : 0.11;
        thorn(V(Math.sin(a) * 0.064, top + 0.06, Math.cos(a) * 0.064), V(Math.sin(a) * 0.085, top + 0.06 + tall, Math.cos(a) * 0.085), 0.017, 4);
      }
      gem(() => orb(V(0, top + 0.05, -0.07), 0.018));
      turned([[0.2, 0], [0.19, 0.3], [0.15, 0.62], [0.11, 0.72]], F + 0.13, { folds: 9, amp: 0.12, start: -1.2, sweep: 2.4 }); // the cloak
      arm(V(-0.135, sh - 0.01, 0), V(-0.175, sh - 0.15, 0.02), V(-0.15, sh - 0.27, -0.05), 0.03);
      shoulder = V(0.135, sh - 0.01, 0);
      const foot = F - shoulder.y;
      armed(() => {
        arm(V(0, 0, 0), V(0.05, -0.12, 0), V(0.085, -0.16, -0.09), 0.03);
        rod(V(0.085, foot, -0.09), V(0.085, 0.44, -0.09), 0.015);
        gem(() => push(new THREE.OctahedronGeometry(0.05), frame(V(0.085, 0.46, -0.09), undefined, V(1, 1.5, 1))));
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2 + Math.PI / 4;
          thorn(V(0.085, 0.46, -0.09), V(0.085 + Math.cos(a) * 0.095, 0.5, -0.09 + Math.sin(a) * 0.095), 0.018, 4);
        }
        thorn(V(0.085, 0.5, -0.09), V(0.085, 0.63, -0.09), 0.02, 4);
        rod(V(0.085, 0.36, -0.09), V(0.085, 0.39, -0.09), 0.026);
      });
      windup = 0.55;
      hit = -1.35;
      break;
    }
    // A king in plate: broad, bearded, crowned, both hands on a great sword.
    default: {
      within(frame(V(0, F, 0), undefined, V(1.08, 1.08, 1.08)), () => {
        leg(V(-0.085, 0.46, 0), V(-0.1, 0.24, -0.03), V(-0.11, 0, 0), 0.066);
        leg(V(0.085, 0.46, 0), V(0.1, 0.24, -0.03), V(0.11, 0, 0), 0.066);
        orb(V(-0.1, 0.25, -0.05), 0.058);
        orb(V(0.1, 0.25, -0.05), 0.058);
        turned([[0.2, 0], [0.15, 0.2]], 0.3, { folds: 9, amp: 0.07, squash: 0.85 }); // the skirt of mail
        turned([[0.15, 0], [0.142, 0.06], [0.185, 0.2], [0.17, 0.28], [0.06, 0.33]], 0.47, { sides: 10, squash: 0.74 });
        slab(V(0, 0.485, 0), 0.31, 0.04, 0.23);
        gem(() => orb(V(0, 0.485, -0.118), 0.026));
        const sh = 0.75;
        for (const side of [-1, 1]) {
          orb(V(side * 0.205, sh, 0), 0.088, 1.1, 0.75, 1.05);
          orb(V(side * 0.235, sh - 0.045, 0), 0.07, 1, 0.7, 1);
        }
        rod(V(0, 0.79, 0), V(0, 0.84, 0), 0.046, 0.04);
        head(V(0, 0.9, -0.005), 0.074);
        thorn(V(0, 0.885, -0.045), V(0, 0.76, -0.085), 0.058, 6); // the beard
        rod(V(0, 0.92, 0.03), V(0, 0.8, 0.06), 0.07, 0.055, 7); // his hair
        rod(V(0, 0.935, 0), V(0, 0.985, 0), 0.074, 0.084, 10);
        for (let i = 0; i < 8; i++) {
          const a = (i * Math.PI) / 4;
          thorn(V(Math.sin(a) * 0.074, 0.98, Math.cos(a) * 0.074), V(Math.sin(a) * 0.088, i % 2 ? 1.03 : 1.06, Math.cos(a) * 0.088), 0.02, 4);
        }
        gem(() => {
          slab(V(0, 1.085, 0), 0.024, 0.11, 0.024);
          slab(V(0, 1.095, 0), 0.075, 0.024, 0.024);
          orb(V(0, 0.96, -0.08), 0.017);
        });
        turned([[0.21, 0.03], [0.2, 0.3], [0.18, 0.66], [0.12, 0.78]], 0, { folds: 7, amp: 0.14, start: -1.2, sweep: 2.4 }); // the cloak
        turned([[0.2, 0], [0.11, 0.07]], 0.74, { sides: 10, squash: 0.8 }); // its fur collar
        shoulder = placed(V(0, sh, 0));
      });
      const tip = F + 0.015 - shoulder.y;
      armed(() => {
        // Both arms come down to the pommel, so the whole frame swings as one.
        for (const side of [-1, 1]) arm(V(side * 0.2, -0.02, 0), V(side * 0.2, -0.22, -0.1), V(side * 0.025, -0.3, -0.19), 0.042);
        sword(V(0, -0.3, -0.19), V(0, -1, 0), -tip - 0.3 - 0.09, 0.05);
      });
      break;
    }
  }

  const merged = (list: THREE.BufferGeometry[]) => (list.length === 0 ? null : mergeGeometries(list));
  return {
    body: merged(bins.body)!,
    gems: merged(bins.gems),
    arm: merged(bins.arm),
    armGems: merged(bins.armGems),
    shoulder,
    windup,
    hit,
    rear,
  };
}

const made = new Map<string, Sculpture>();

/** The sculpture for a piece letter (P N B R Q K). Built once, then shared. */
export function sculpture(kind: string): Sculpture {
  let s = made.get(kind);
  if (!s) {
    s = sculpt(kind);
    made.set(kind, s);
  }
  return s;
}
