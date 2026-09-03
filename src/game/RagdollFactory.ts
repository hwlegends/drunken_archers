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

    const head = Matter.Bodies.circle(x, y - RAGDOLL.torso.h - RAGDOLL.neckGap - RAGDOLL.head.r, RAGDOLL.head.r, {
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

    // Back arm draws the string, tucked up to the jaw.
    const backAngle = armAngle(RAGDOLL.armLift * 0.7);
    const shoulderBack = { x: x - f * 2, y: shoulderY + 2 };
    const backUpperMid = along(backAngle, RAGDOLL.upperArm.h / 2);
    const armBackUpper = limb('upperArmBack', 'upperArm', shoulderBack.x + backUpperMid.x, shoulderBack.y + backUpperMid.y, RAGDOLL.upperArm.w, RAGDOLL.upperArm.h, backAngle);

    /**
     * The draw forearm angles up and slightly forward so the hand finishes at
     * the jaw, which is where an archer's string hand actually sits. It used to
     * be planted well out in front of the chest, where it stood between every
     * incoming arrow and the head and took a fifth of all hits.
     */
    const drawAngle = -f * (Math.PI - 0.5);
    const drawMid = along(drawAngle, RAGDOLL.lowerArm.h / 2);
    const armBackLower = limb('lowerArmBack', 'lowerArm', shoulderBack.x + drawMid.x, shoulderBack.y + drawMid.y, RAGDOLL.lowerArm.w, RAGDOLL.lowerArm.h, drawAngle);

    /**
     * Arrows pass straight through the whole bow arm, the way they pass through
     * the bow itself — it is all one assembly held out in front of the face.
     *
     * Measured over 60 duels, the bow arm was catching 24% of every body hit,
     * about as many as the head, and because it sits right beside the bow it
     * reads to a player as the bow shielding the head. On point-blank shots
     * aimed at the head, clearing this arm takes the head's share from roughly
     * half to about two thirds. The other arm stays solid, so `upperArm` and
     * `lowerArm` remain live damage regions.
     *
     * Terrain collision is kept, so the arm still comes to rest on the ground
     * once the ragdoll is released.
     */
    armFrontUpper.collisionFilter.mask = CATEGORY.terrain;
    armFrontLower.collisionFilter.mask = CATEGORY.terrain;

    /* ---- bow ----------------------------------------------------- */

    // The bow's local +X axis is the shot direction; body.angle IS the aim.
    // The weld below freezes whatever bow-to-forearm offset exists at build
    // time, so the bow must start at the orientation that offset should have:
    // a quarter turn from the forearm. Hard-coding 0 and PI here instead would
    // bake in a different, mirrored error on each side once the arm is lifted.
    const bowHandPoint = this.limbEnd(armFrontLower, 1);
    const bow = Matter.Bodies.rectangle(bowHandPoint.x, bowHandPoint.y, 10, RAGDOLL.torso.h * 1.1, {
      label: side + ':bow',
      angle: frontAngle + Math.PI / 2,
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
    joint(torso, head, { x: 0, y: -halfTorso }, { x: 0, y: RAGDOLL.head.r + RAGDOLL.neckGap }, 0.95);
    joint(torso, head, { x: 0, y: -halfTorso + 4 }, { x: 0, y: RAGDOLL.head.r + RAGDOLL.neckGap + 4 }, 0.35);

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


    /* ---- standing pose ------------------------------------------- */

    /**
     * A standing archer is posed directly, so none of these joints should act
     * while it is on its feet — left live they fight the placement and pump the
     * ragdoll full of energy. They are stored with their intended values and
     * switched back on the instant the archer topples or dies.
     */
    const joints = constraints.map((constraint) => ({
      constraint,
      stiffness: constraint.stiffness,
      damping: constraint.damping,
    }));
    for (const { constraint } of joints) {
      constraint.stiffness = 0;
      constraint.damping = 0;
    }

    // The body swings about a point between the feet, so every part's rest
    // placement is recorded relative to it.
    const pivot: Vec2 = { x, y: y + RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h };
    // The hips are one leg-length above the pivot. The legs lean about the
    // pivot, the upper body about the hips, so the archer bends a little rather
    // than tipping as one plank.
    const hipOffset: Vec2 = { x: 0, y: -(RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h) };
    const restPose = bodies.map((body) => ({
      body,
      offset: { x: body.position.x - pivot.x, y: body.position.y - pivot.y },
      angle: body.angle,
      isLeg: getPartPlugin(body).part.includes('Leg'),
    }));

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
      joints,
      pivot,
      restPose,
      hipOffset,
      standing: true,
      balanceLoss: 0,
      collisionGroup: group,
      regionOf,
      wobblePhase: Math.random() * Math.PI * 2,
      armPhase: Math.random() * Math.PI * 2,
      swingRate: 1,
      swingRateTarget: 1,
      swingRateTimer: 0,
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
    handle.joints.length = 0;
    handle.restPose.length = 0;
  }
}

export const skinFor = (side: Side) => SKINS[side];
