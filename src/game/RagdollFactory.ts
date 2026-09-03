import Matter from 'matter-js';
import { CATEGORY, RAGDOLL, SKINS, type Skin } from '../config/constants';
import type { BodyRegion, RagdollHandle, Side, Vec2 } from '../types';
import type { PhysicsWorld } from './PhysicsWorld';

/** Extra data hung off each Matter body so the renderer can draw it. */
export interface PartPlugin {
  part: string;
  region: BodyRegion;
  /** Thickness across the limb. */
  w: number;
  /** Length along the limb (local +Y). */
  h: number;
  side: Side;
}

export const getPartPlugin = (body: Matter.Body): PartPlugin => body.plugin as PartPlugin;

/**
 * Builds one archer out of eleven rigid bodies plus a bow, joined with
 * rotational constraints. Limbs are authored with their long axis along local
 * +Y, so an angle of 0 points straight down and -PI/2 points along +X.
 */
export class RagdollFactory {
  constructor(private readonly physics: PhysicsWorld) {}

  create(side: Side, spawn: Vec2, facing: 1 | -1, skin: Skin = SKINS[side]): RagdollHandle {
    const f = facing;
    const { x, y } = spawn;
    const group = Matter.Body.nextGroup(true);
    const category = side === 'left' ? CATEGORY.ragdollLeft : CATEGORY.ragdollRight;
    const mask = CATEGORY.terrain | CATEGORY.arrowLeft | CATEGORY.arrowRight;

    const bodies: Matter.Body[] = [];
    const parts: Record<string, Matter.Body> = {};
    const regionOf = new Map<number, BodyRegion>();

    const limb = (
      name: string,
      region: BodyRegion,
      cx: number,
      cy: number,
      w: number,
      h: number,
      angle: number,
      density: number = RAGDOLL.density,
    ): Matter.Body => {
      const body = Matter.Bodies.rectangle(cx, cy, w, h, {
        label: side + ':' + name,
        angle,
        density,
        friction: RAGDOLL.friction,
        frictionAir: RAGDOLL.frictionAir,
        restitution: RAGDOLL.restitution,
        chamfer: { radius: Math.min(w, h) * 0.28 },
        collisionFilter: { group, category, mask },
      });
      body.plugin = { part: name, region, w, h, side } satisfies PartPlugin;
      parts[name] = body;
      bodies.push(body);
      regionOf.set(body.id, region);
      return body;
    };

    /* ---- core ---------------------------------------------------- */

    const torso = limb(
      'torso',
      'torso',
      x,
      y - RAGDOLL.torso.h / 2,
      RAGDOLL.torso.w,
      RAGDOLL.torso.h,
      0,
      RAGDOLL.density * 1.5,
    );

    const head = Matter.Bodies.circle(x, y - RAGDOLL.torso.h - RAGDOLL.head.r, RAGDOLL.head.r, {
      label: side + ':head',
      density: RAGDOLL.density * 0.85,
      friction: RAGDOLL.friction,
      frictionAir: RAGDOLL.frictionAir,
      restitution: RAGDOLL.restitution,
      collisionFilter: { group, category, mask },
    });
    head.plugin = {
      part: 'head',
      region: 'head',
      w: RAGDOLL.head.r * 2,
      h: RAGDOLL.head.r * 2,
      side,
    } satisfies PartPlugin;
    parts.head = head;
    bodies.push(head);
    regionOf.set(head.id, 'head');

    /* ---- legs ---------------------------------------------------- */

    const legSpread = 7;
    const upperLegY = y + RAGDOLL.upperLeg.h / 2;
    const lowerLegY = y + RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h / 2;

    const legFront = limb('upperLegFront', 'upperLeg', x + f * legSpread * 0.6, upperLegY, RAGDOLL.upperLeg.w, RAGDOLL.upperLeg.h, f * 0.14);
    const legBack = limb('upperLegBack', 'upperLeg', x - f * legSpread, upperLegY, RAGDOLL.upperLeg.w, RAGDOLL.upperLeg.h, -f * 0.14);
    const shinFront = limb('lowerLegFront', 'lowerLeg', x + f * legSpread * 0.9, lowerLegY, RAGDOLL.lowerLeg.w, RAGDOLL.lowerLeg.h, f * 0.05);
    const shinBack = limb('lowerLegBack', 'lowerLeg', x - f * legSpread * 1.2, lowerLegY, RAGDOLL.lowerLeg.w, RAGDOLL.lowerLeg.h, -f * 0.05);

    /* ---- arms ---------------------------------------------------- */

    const shoulderY = y - RAGDOLL.torso.h + 5;

    /**
     * A limb's long axis is local +Y, so an angle of `-f * (PI/2 + lift)` points
     * it forward and `lift` radians above horizontal. Raising the bow arm this
     * way carries the hand up to head height, which is what puts the bow in
     * front of the archer's face rather than down by the waist.
     */
    const armAngle = (lift: number) => -f * (Math.PI / 2 + lift);
    const along = (angle: number, distance: number) => ({
      x: -Math.sin(angle) * distance,
      y: Math.cos(angle) * distance,
    });

    const frontAngle = armAngle(RAGDOLL.armLift);
    const shoulderFront = { x: x + f * 3, y: shoulderY };
    const upperMid = along(frontAngle, RAGDOLL.upperArm.h / 2);
    const lowerMid = along(frontAngle, RAGDOLL.upperArm.h + RAGDOLL.lowerArm.h / 2);

    // Front arm holds the bow, raised toward the enemy.
    const armFrontUpper = limb('upperArmFront', 'upperArm', shoulderFront.x + upperMid.x, shoulderFront.y + upperMid.y, RAGDOLL.upperArm.w, RAGDOLL.upperArm.h, frontAngle);
    const armFrontLower = limb('lowerArmFront', 'lowerArm', shoulderFront.x + lowerMid.x, shoulderFront.y + lowerMid.y, RAGDOLL.lowerArm.w, RAGDOLL.lowerArm.h, frontAngle);

    // Back arm draws the string, bent back toward the jaw.
    const backAngle = armAngle(RAGDOLL.armLift * 0.7);
    const shoulderBack = { x: x - f * 2, y: shoulderY + 2 };
    const backUpperMid = along(backAngle, RAGDOLL.upperArm.h / 2);
    const armBackUpper = limb('upperArmBack', 'upperArm', shoulderBack.x + backUpperMid.x, shoulderBack.y + backUpperMid.y, RAGDOLL.upperArm.w, RAGDOLL.upperArm.h, backAngle);
    const armBackLower = limb('lowerArmBack', 'lowerArm', shoulderBack.x + f * (RAGDOLL.upperArm.h + 2), shoulderBack.y - RAGDOLL.lowerArm.h / 2 + 2, RAGDOLL.lowerArm.w, RAGDOLL.lowerArm.h, backAngle * 0.2);

    /* ---- bow ----------------------------------------------------- */

    // The bow's local +X axis is the shot direction; body.angle IS the aim.
    const bowHandPoint = this.limbEnd(armFrontLower, 1);
    const bow = Matter.Bodies.rectangle(bowHandPoint.x, bowHandPoint.y, 10, RAGDOLL.torso.h * 1.1, {
      label: side + ':bow',
      angle: f === 1 ? 0 : Math.PI,
      density: RAGDOLL.density * 0.35,
      frictionAir: RAGDOLL.frictionAir,
      // The bow is decorative geometry — it must never collide with anything.
      collisionFilter: { group, category, mask: 0 },
    });
    bow.plugin = {
      part: 'bow',
      region: 'lowerArm',
      w: 10,
      h: RAGDOLL.torso.h * 1.1,
      side,
    } satisfies PartPlugin;
    parts.bow = bow;
    bodies.push(bow);

    /* ---- joints -------------------------------------------------- */

    const constraints: Matter.Constraint[] = [];
    const joint = (
      a: Matter.Body,
      b: Matter.Body,
      pointA: Vec2,
      pointB: Vec2,
      stiffness: number = RAGDOLL.jointStiffness,
    ) => {
      const c = Matter.Constraint.create({
        bodyA: a,
        bodyB: b,
        pointA,
        pointB,
        length: 0,
        stiffness,
        damping: RAGDOLL.jointDamping,
        render: { visible: false },
      });
      constraints.push(c);
      return c;
    };

    const halfTorso = RAGDOLL.torso.h / 2;

    // Neck — two anchors so the head cannot spin freely on its socket.
    joint(torso, head, { x: 0, y: -halfTorso }, { x: 0, y: RAGDOLL.head.r * 0.7 }, 0.95);
    joint(torso, head, { x: 0, y: -halfTorso + 4 }, { x: 0, y: RAGDOLL.head.r * 0.95 }, 0.35);

    // Hips.
    joint(torso, legFront, { x: f * 4, y: halfTorso }, { x: 0, y: -RAGDOLL.upperLeg.h / 2 });
    joint(torso, legBack, { x: -f * 5, y: halfTorso }, { x: 0, y: -RAGDOLL.upperLeg.h / 2 });
    // Knees.
    joint(legFront, shinFront, { x: 0, y: RAGDOLL.upperLeg.h / 2 }, { x: 0, y: -RAGDOLL.lowerLeg.h / 2 });
    joint(legBack, shinBack, { x: 0, y: RAGDOLL.upperLeg.h / 2 }, { x: 0, y: -RAGDOLL.lowerLeg.h / 2 });

    // Shoulders.
    joint(torso, armFrontUpper, { x: f * 3, y: -halfTorso + 5 }, { x: 0, y: -RAGDOLL.upperArm.h / 2 });
    joint(torso, armBackUpper, { x: -f * 2, y: -halfTorso + 7 }, { x: 0, y: -RAGDOLL.upperArm.h / 2 });
    // Elbows.
    joint(armFrontUpper, armFrontLower, { x: 0, y: RAGDOLL.upperArm.h / 2 }, { x: 0, y: -RAGDOLL.lowerArm.h / 2 });
    joint(armBackUpper, armBackLower, { x: 0, y: RAGDOLL.upperArm.h / 2 }, { x: 0, y: -RAGDOLL.lowerArm.h / 2 });

    // Bow welded to the forward hand with two anchors, fixing its orientation
    // to the arm pose. Players never aim directly — this is what they fight.
    joint(armFrontLower, bow, { x: 0, y: RAGDOLL.lowerArm.h / 2 }, { x: 0, y: 0 }, 1);
    joint(armFrontLower, bow, { x: 0, y: RAGDOLL.lowerArm.h / 2 - 6 }, { x: -6, y: 0 }, 0.9);

    /* ---- footing ------------------------------------------------- */

    // Soft ground anchors under each foot. Stiff enough to keep the archer on
    // its platform, loose enough to allow a huge drunken sway.
    const footAnchorY = y + RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h;
    const feet: Array<[Matter.Body, number]> = [
      [shinFront, f * legSpread * 0.9],
      [shinBack, -f * legSpread * 1.2],
    ];
    for (const [shin, offset] of feet) {
      constraints.push(
        Matter.Constraint.create({
          pointA: { x: x + offset, y: footAnchorY },
          bodyB: shin,
          pointB: { x: 0, y: RAGDOLL.lowerLeg.h / 2 },
          length: 0,
          stiffness: RAGDOLL.footStiffness,
          damping: RAGDOLL.footDamping,
          render: { visible: false },
        }),
      );
    }

    /**
     * The aim link. Its anchor is a point in torso-local space out at arm's
     * length, and the bow hand is pulled to it; the elbow then resolves itself.
     * SwayController walks this anchor up and down an arc each step, which is
     * what sweeps the bow through its firing angles.
     */
    const aimAnchor = (distance: number, lift: number): Vec2 => ({
      x: f * (3 + distance * Math.cos(lift)),
      y: -halfTorso + 5 - distance * Math.sin(lift),
    });

    const aim = Matter.Constraint.create({
      bodyA: torso,
      pointA: aimAnchor(RAGDOLL.aimReach, RAGDOLL.armLift),
      bodyB: armFrontLower,
      pointB: { x: 0, y: RAGDOLL.lowerArm.h / 2 },
      length: 0,
      stiffness: RAGDOLL.aimStiffness,
      damping: RAGDOLL.aimDamping,
      render: { visible: false },
    });
    constraints.push(aim);

    // Targeting the elbow as well removes the elbow-up / elbow-down ambiguity
    // that a hand target alone leaves, which otherwise flips the forearm — and
    // with it the bow angle — from frame to frame.
    const aimElbow = Matter.Constraint.create({
      bodyA: torso,
      pointA: aimAnchor(RAGDOLL.upperArm.h, RAGDOLL.armLift),
      bodyB: armFrontUpper,
      pointB: { x: 0, y: RAGDOLL.upperArm.h / 2 },
      length: 0,
      stiffness: RAGDOLL.aimElbowStiffness,
      damping: RAGDOLL.aimDamping,
      render: { visible: false },
    });
    constraints.push(aimElbow);

    // The balance spring: a long, very soft link from the torso to a point high
    // above the spawn. It resists a full topple without stopping the wobble.
    const balanceAnchor = { x, y: y - 150 };
    const balance = Matter.Constraint.create({
      pointA: { x: balanceAnchor.x, y: balanceAnchor.y },
      bodyB: torso,
      pointB: { x: 0, y: -halfTorso },
      length: 150 - RAGDOLL.torso.h,
      stiffness: RAGDOLL.balanceStiffness,
      damping: RAGDOLL.balanceDamping,
      render: { visible: false },
    });
    constraints.push(balance);

    this.physics.add(Matter.Composite.create({ bodies, constraints }));

    return {
      side,
      skin,
      facing: f,
      parts,
      head,
      torso,
      bowHand: armFrontLower,
      drawHand: armBackLower,
      bow,
      bodies,
      constraints,
      balance,
      balanceAnchor,
      aim,
      aimElbow,
      collisionGroup: group,
      regionOf,
      wobblePhase: Math.random() * Math.PI * 2,
      armPhase: Math.random() * Math.PI * 2,
      wobbleSeed: Math.random() * 1000,
      dead: false,
    };
  }

  /** World position of a limb's tip. `dir` +1 = far end, -1 = near end. */
  limbEnd(body: Matter.Body, dir: 1 | -1): Vec2 {
    const { h } = getPartPlugin(body);
    const half = (h / 2) * dir;
    return {
      x: body.position.x - Math.sin(body.angle) * half,
      y: body.position.y + Math.cos(body.angle) * half,
    };
  }

  /** Releases every constraint and body belonging to a ragdoll. */
  destroy(handle: RagdollHandle): void {
    for (const c of handle.constraints) this.physics.remove(c);
    for (const b of handle.bodies) this.physics.remove(b);
    handle.constraints.length = 0;
    handle.bodies.length = 0;
    handle.balance = null;
  }
}

export const skinFor = (side: Side) => SKINS[side];
