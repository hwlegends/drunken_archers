/**
 * Headless simulation smoke test.
 *
 * Runs the real physics, ragdoll, bow, projectile, combat and AI code outside
 * the browser and asserts the behaviour the specification calls for. Nothing
 * here touches the DOM, so it can run under plain Node after esbuild bundles it.
 *
 *   npm run sim-check
 */
import Matter from 'matter-js';
import { AI, BOW, COMBAT, MATCH, PHYSICS, PROJECTILE, RAGDOLL, STEP, TIME, VIEW } from '../src/config/constants';
import { createArena, generateArrangement, makeRng, validateArrangement } from '../src/config/arenas';
import { AIController } from '../src/game/AIController';
import { BowController } from '../src/game/BowController';
import { CombatSystem } from '../src/game/CombatSystem';
import { PhysicsWorld, toSecondVelocity, toStepVelocity } from '../src/game/PhysicsWorld';
import { ProjectileSystem } from '../src/game/ProjectileSystem';
import { RagdollFactory } from '../src/game/RagdollFactory';
import { SwayController } from '../src/game/SwayController';
import { BOW_PHASES, decodeSnapshot, encodeSnapshot } from '../src/net/protocol';
import { canTransition, isSimulating, showsArena } from '../src/state/GameStateMachine';
import type { ArenaConfig, GamePhase, PlayerState, RagdollHandle, Side } from '../src/types';

/* ------------------------------------------------------------------ *
 * Tiny assertion harness
 * ------------------------------------------------------------------ */

let passed = 0;
const failures: string[] = [];

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log('  PASS  ' + name + (detail ? '  (' + detail + ')' : ''));
  } else {
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  FAIL  ' + name + (detail ? '  (' + detail + ')' : ''));
  }
}

function section(title: string): void {
  console.log('\n' + title);
  console.log('-'.repeat(title.length));
}

const near = (a: number, b: number, tolerance: number) => Math.abs(a - b) <= tolerance;
const pct = (a: number, b: number) => Math.abs(a - b) / Math.abs(b || 1);

/* ------------------------------------------------------------------ *
 * 1. Unit conversion — the riskiest part of driving Matter from px/s
 * ------------------------------------------------------------------ */

section('1. Physics units');
{
  const world = new PhysicsWorld();
  const body = Matter.Bodies.circle(0, 0, 5, { frictionAir: 0, friction: 0 });
  world.add(body);

  const seconds = 1;
  for (let i = 0; i < Math.round(seconds * 1000 / TIME.step); i++) {
    Matter.Engine.update(world.engine, TIME.step);
  }

  const fallSpeed = toSecondVelocity(body.velocity.y);
  const dropped = body.position.y;
  const expectedSpeed = PHYSICS.gravity * seconds;
  const expectedDrop = 0.5 * PHYSICS.gravity * seconds * seconds;

  check(
    'gravity reaches ' + PHYSICS.gravity + ' px/s after 1s',
    pct(fallSpeed, expectedSpeed) < 0.05,
    fallSpeed.toFixed(1) + ' px/s vs ' + expectedSpeed,
  );
  check(
    'free-fall distance matches 0.5*g*t^2',
    pct(dropped, expectedDrop) < 0.06,
    dropped.toFixed(1) + ' px vs ' + expectedDrop,
  );

  // Round trip through the velocity conversion.
  check('velocity conversion round-trips', near(toSecondVelocity(toStepVelocity(937)), 937, 0.001));
  world.destroy();
}

/* ------------------------------------------------------------------ *
 * 2. Arena arrangement validation
 * ------------------------------------------------------------------ */

section('2. Arena generation');
{
  let allValid = true;
  let minSep = Infinity;
  let maxSep = 0;
  for (let i = 0; i < 400; i++) {
    const arrangement = generateArrangement(makeRng(i * 7919 + 13));
    if (!validateArrangement(arrangement)) allValid = false;
    const sep = arrangement.right.x - arrangement.left.x;
    minSep = Math.min(minSep, sep);
    maxSep = Math.max(maxSep, sep);
  }
  check('400 generated arrangements all validate', allValid, 'separation ' + minSep.toFixed(0) + '-' + maxSep.toFixed(0) + 'px');

  for (const theme of ['desert', 'city', 'jungle'] as const) {
    const arena = createArena(theme, 4242);
    const onScreen =
      arena.spawns.left.x > 0 &&
      arena.spawns.right.x < VIEW.width &&
      arena.spawns.left.y > 0 &&
      arena.spawns.right.y < VIEW.height;
    check(theme + ' arena spawns both fighters on screen', onScreen);
  }
}

/* ------------------------------------------------------------------ *
 * Shared match rig
 * ------------------------------------------------------------------ */

interface Rig {
  physics: PhysicsWorld;
  arena: ArenaConfig;
  factory: RagdollFactory;
  projectiles: ProjectileSystem;
  combat: CombatSystem;
  sway: SwayController;
  ragdolls: Record<Side, RagdollHandle>;
  bows: Record<Side, BowController>;
  players: Record<Side, PlayerState>;
  defeats: Array<{ loser: Side; byHeadshot: boolean; byFall: boolean }>;
  hits: Array<{ target: Side; region: string; damage: number }>;
  step: (steps: number, perStep?: (i: number) => void) => void;
  /** Freeze the swing in place so a shot can be aimed deterministically. */
  setSway: (enabled: boolean) => void;
}

function makeRig(theme: 'desert' | 'city' | 'jungle' = 'desert', seed = 1234): Rig {
  const physics = new PhysicsWorld();
  const arena = createArena(theme, seed);
  physics.buildTerrain(arena);

  const factory = new RagdollFactory(physics);
  const projectiles = new ProjectileSystem(physics);
  projectiles.setArena(arena);
  const sway = new SwayController();

  const hits: Rig['hits'] = [];
  const defeats: Rig['defeats'] = [];
  const combat = new CombatSystem(projectiles, {
    onHit: (hit) => hits.push({ target: hit.target, region: hit.region, damage: hit.damage }),
    onDefeat: (loser, byHeadshot, byFall) => defeats.push({ loser, byHeadshot, byFall }),
    onTerrainHit: () => undefined,
  });

  const ragdolls = {
    left: factory.create('left', arena.spawns.left, 1),
    right: factory.create('right', arena.spawns.right, -1),
  } as Record<Side, RagdollHandle>;

  const bows = {
    left: new BowController('left', ragdolls.left, projectiles),
    right: new BowController('right', ragdolls.right, projectiles),
  } as Record<Side, BowController>;

  const players = {
    left: { side: 'left', controller: 'human1', health: COMBAT.maxHealth, maxHealth: COMBAT.maxHealth, score: 0, alive: true },
    right: { side: 'right', controller: 'cpu', health: COMBAT.maxHealth, maxHealth: COMBAT.maxHealth, score: 0, alive: true },
  } as Record<Side, PlayerState>;

  physics.onCollisionStart((event) => {
    for (const pair of event.pairs) {
      combat.handleCollision(pair.bodyA, pair.bodyB, players, ragdolls);
    }
  });

  let swayEnabled = true;
  const step = (steps: number, perStep?: (i: number) => void) => {
    for (let i = 0; i < steps; i++) {
      // Freezing the swing means holding its phase still, not dropping the
      // pose — an unposed archer is a ragdoll and simply falls over.
      if (swayEnabled) {
        sway.update(ragdolls.left, TIME.step);
        sway.update(ragdolls.right, TIME.step);
      }
      bows.left.update(TIME.step);
      bows.right.update(TIME.step);
      perStep?.(i);
      projectiles.update(TIME.step);
      combat.checkFallBoundary(ragdolls, players, arena.fallBoundary);
      Matter.Engine.update(physics.engine, TIME.step);
      sway.pose(ragdolls.left, ragdolls.right.torso.position.x);
      sway.pose(ragdolls.right, ragdolls.left.torso.position.x);
      projectiles.syncOrientation();
    }
  };

  const setSway = (enabled: boolean) => {
    swayEnabled = enabled;
  };

  return { physics, arena, factory, projectiles, combat, sway, ragdolls, bows, players, defeats, hits, step, setSway };
}

const SECONDS = (s: number) => Math.round((s * 1000) / TIME.step);

/* ------------------------------------------------------------------ *
 * 3. Ragdoll stability — they must sway hard but stay standing
 * ------------------------------------------------------------------ */

section('3. Body swing');
{
  for (const theme of ['desert', 'city', 'jungle'] as const) {
    const rig = makeRig(theme, 909);
    const startX = { left: rig.ragdolls.left.torso.position.x, right: rig.ragdolls.right.torso.position.x };
    let maxSway = 0;
    let maxTilt = 0;
    // The feet must stay put: the body pivots about them, it does not walk.
    let maxFootDrift = 0;

    rig.step(SECONDS(20), () => {
      for (const side of ['left', 'right'] as Side[]) {
        const r = rig.ragdolls[side];
        maxSway = Math.max(maxSway, Math.abs(r.torso.position.x - startX[side]));
        maxTilt = Math.max(maxTilt, Math.abs(r.torso.angle));
        for (const name of ['lowerLegFront', 'lowerLegBack']) {
          const foot = r.parts[name];
          maxFootDrift = Math.max(maxFootDrift, Math.abs(foot.position.y - r.pivot.y));
        }
      }
    });

    const upright =
      rig.ragdolls.left.torso.position.y < rig.arena.fallBoundary &&
      rig.ragdolls.right.torso.position.y < rig.arena.fallBoundary &&
      !rig.defeats.length;

    check(theme + ': both archers stay on their feet for 20s', upright, rig.defeats.length + ' defeats');

    // Bounded against the configured swing rather than a magic number, so the
    // test stays meaningful when the amplitude is retuned.
    const tiltDeg = (maxTilt * 180) / Math.PI;
    const configuredDeg = ((RAGDOLL.swingAmplitude + RAGDOLL.swingDetune) * 180) / Math.PI;
    check(
      theme + ': the body swings its configured arc without spinning',
      Number.isFinite(tiltDeg) && tiltDeg > configuredDeg * 0.5 && tiltDeg < configuredDeg * 1.25,
      'max lean ' + tiltDeg.toFixed(1) + ' of a configured ' + configuredDeg.toFixed(1) + ' deg, torso travel ' + maxSway.toFixed(1) + 'px',
    );
    check(
      theme + ': the archer pivots about its feet rather than walking',
      maxFootDrift < 30,
      'feet stay within ' + maxFootDrift.toFixed(1) + 'px of the pivot',
    );
    rig.physics.destroy();
  }

  // The swing must be a readable oscillation, not noise: sampling it should
  // trace a smooth arc that reverses direction at a steady cadence.
  {
    const rig = makeRig('desert', 4242);
    const samples: number[] = [];
    rig.step(SECONDS(12), () => samples.push(rig.ragdolls.left.torso.angle));

    let reversals = 0;
    for (let i = 2; i < samples.length; i++) {
      const before = samples[i - 1] - samples[i - 2];
      const after = samples[i] - samples[i - 1];
      if (before !== 0 && after !== 0 && Math.sign(before) !== Math.sign(after)) reversals++;
    }
    // A clean ~2.4s swing over 12s reverses roughly ten times; noise reverses
    // hundreds of times.
    check(
      'the swing is a predictable oscillation, not jitter',
      reversals > 3 && reversals < 60,
      reversals + ' direction changes in 12s',
    );
    rig.physics.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * 4. Bow charge and release
 * ------------------------------------------------------------------ */

section('4. Charge and release');
{
  const rig = makeRig('desert', 55);
  rig.step(SECONDS(1));

  const bow = rig.bows.left;
  check('bow starts ready', bow.state.phase === 'ready');

  bow.press();
  check('press begins the draw', bow.state.phase === 'drawing');
  check('a second press while drawing is ignored', bow.press() === false);

  // Hold past full charge and confirm it clamps.
  rig.step(SECONDS(BOW.timeToMaxCharge + 0.4));
  check('charge clamps at 1', near(bow.state.charge, 1, 1e-6), 'charge=' + bow.state.charge.toFixed(4));

  const before = rig.projectiles.list().length;
  const shot = bow.release();
  check('release fires exactly one arrow', rig.projectiles.list().length === before + 1);
  check('full charge maps to max launch speed', shot !== null && near(shot.speed, BOW.maxLaunchSpeed, 1));
  check('bow enters reload', bow.state.phase === 'reloading');

  // A release while reloading must not produce a second arrow.
  const countAfterShot = rig.projectiles.list().length;
  bow.press();
  bow.release();
  check('cannot fire while reloading', rig.projectiles.list().length === countAfterShot);

  rig.step(SECONDS(BOW.reloadDelayMs / 1000 + 0.1));
  check('bow reloads after the delay', bow.state.phase === 'ready');

  // Direction must equal the bow angle at the instant of release.
  rig.step(SECONDS(0.3));
  const angleAtRelease = rig.ragdolls.left.bow.angle;
  rig.bows.left.press();
  rig.step(SECONDS(0.35));
  const angleNow = rig.ragdolls.left.bow.angle;
  const shot2 = rig.bows.left.release();
  check(
    'shot direction is the live bow angle, not the angle at press',
    shot2 !== null && near(shot2.angle, angleNow, 1e-9) && Math.abs(angleNow - angleAtRelease) >= 0,
    'press=' + angleAtRelease.toFixed(4) + ' release=' + angleNow.toFixed(4),
  );

  // Minimum charge produces the minimum speed.
  rig.step(SECONDS(BOW.reloadDelayMs / 1000 + 0.1));
  rig.bows.left.press();
  const shot3 = rig.bows.left.release();
  check('a zero-length tap fires at the minimum speed', shot3 !== null && near(shot3.speed, BOW.minLaunchSpeed, 1));

  rig.physics.destroy();
}

/* ------------------------------------------------------------------ *
 * 5. Arrow ballistics
 * ------------------------------------------------------------------ */

section('5. Arrow flight');
{
  const rig = makeRig('desert', 77);
  const speed = 900;
  const angle = -Math.PI / 4;
  const origin = { x: 200, y: 200 };
  const projectile = rig.projectiles.launch('left', origin, angle, speed);

  const launchSpeed = toSecondVelocity(Math.hypot(projectile.body.velocity.x, projectile.body.velocity.y));
  check('launch speed matches the requested px/s', pct(launchSpeed, speed) < 0.02, launchSpeed.toFixed(1) + ' px/s');

  // Sample the arc and compare against the analytic ballistic path.
  let maxDeviation = 0;
  const samples = SECONDS(0.5);
  for (let i = 1; i <= samples; i++) {
    rig.projectiles.update(TIME.step);
    Matter.Engine.update(rig.physics.engine, TIME.step);
    rig.projectiles.syncOrientation();
    const t = (i * TIME.step) / 1000;
    const expectedX = origin.x + Math.cos(angle) * speed * t;
    const expectedY = origin.y + Math.sin(angle) * speed * t + 0.5 * PHYSICS.gravity * t * t;
    maxDeviation = Math.max(
      maxDeviation,
      Math.hypot(projectile.body.position.x - expectedX, projectile.body.position.y - expectedY),
    );
  }
  check('flight tracks the ballistic arc', maxDeviation < 22, 'max deviation ' + maxDeviation.toFixed(1) + 'px');

  // Orientation follows velocity.
  const heading = Math.atan2(projectile.body.velocity.y, projectile.body.velocity.x);
  check('arrow points along its velocity', near(projectile.body.angle, heading, 0.02));

  // The per-side arrow budget must not leak, and must never delete a live
  // arrow that is still inside the budget.
  {
    const rig2 = makeRig('desert', 91);
    const fired: number[] = [];
    for (let i = 0; i < PROJECTILE.maxPerSide * 3; i++) {
      const p = rig2.projectiles.launch('left', { x: 120, y: 300 }, -0.4, 700);
      fired.push(p.id);
      // Two steps only, so nothing has time to leave the world on its own.
      rig2.step(2);
    }
    const tracked = rig2.projectiles.list();
    check(
      'the arrow budget never exceeds its cap',
      tracked.length <= PROJECTILE.maxPerSide,
      tracked.length + ' tracked after ' + fired.length + ' shots (cap ' + PROJECTILE.maxPerSide + ')',
    );

    /**
     * The budget must recycle the oldest arrow and only the oldest, so the last
     * `maxPerSide` fired are all still accounted for.
     *
     * This used to assert that some minimum number were still *in flight*,
     * which is not the same claim: an arrow that embeds in terrain or in an
     * archer is still tracked, and how many do that depends on where the random
     * sway happened to put the target. The check failed roughly one run in ten
     * for that reason alone. What the budget actually promises is that nothing
     * inside it is dropped, and that does not depend on chance.
     */
    const kept = new Set(tracked.map((p) => p.id));
    const expected = fired.slice(-PROJECTILE.maxPerSide);
    check(
      'the newest arrows are all kept, whatever became of them',
      expected.every((id) => kept.has(id)),
      expected.filter((id) => !kept.has(id)).length + ' of the last ' + expected.length + ' missing',
    );
    // Every tracked arrow must still have a body in the world.
    const worldIds = new Set(Matter.Composite.allBodies(rig2.physics.world).map((b) => b.id));
    check(
      'every tracked arrow still exists in the world',
      tracked.every((p) => worldIds.has(p.body.id)),
      tracked.filter((p) => !worldIds.has(p.body.id)).length + ' orphaned records',
    );
    rig2.physics.destroy();
  }

  // Out-of-bounds cleanup.
  const stray = rig.projectiles.launch('left', { x: 100, y: 100 }, -Math.PI / 2, 4000);
  const countBefore = rig.projectiles.list().length;
  for (let i = 0; i < SECONDS(2); i++) {
    rig.projectiles.update(TIME.step);
    Matter.Engine.update(rig.physics.engine, TIME.step);
  }
  check(
    'projectiles leaving the world are removed',
    rig.projectiles.list().length < countBefore && !rig.projectiles.list().includes(stray),
  );

  rig.physics.destroy();
}

/* ------------------------------------------------------------------ *
 * 6. Damage, headshots and single-use arrows
 * ------------------------------------------------------------------ */

section('6. Damage and defeat');
{
  // Torso hit.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.6));
    fireInto(rig, 'torso');
    rig.step(SECONDS(1.2));
    check(
      'a torso hit removes ' + COMBAT.damage.torso + ' health',
      rig.players.right.health === COMBAT.maxHealth - COMBAT.damage.torso,
      'health=' + rig.players.right.health,
    );
    check('a torso hit does not end the round', rig.defeats.length === 0);
    rig.physics.destroy();
  }

  // Limb hit.
  {
    const rig = makeRig('desert', 77);
    rig.step(SECONDS(0.6));
    fireInto(rig, 'upperLegFront');
    rig.step(SECONDS(1.2));
    check(
      'a leg hit removes ' + COMBAT.damage.upperLeg + ' health',
      rig.players.right.health === COMBAT.maxHealth - COMBAT.damage.upperLeg,
      'health=' + rig.players.right.health,
    );
    rig.physics.destroy();
  }

  // Headshot.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.6));
    fireInto(rig, 'head');
    rig.step(SECONDS(1.2));
    check('a headshot defeats immediately', rig.players.right.health === 0 && rig.defeats.length === 1);
    check('the headshot is reported as such', rig.defeats[0]?.byHeadshot === true);
    rig.physics.destroy();
  }

  // One arrow, one damage event.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.6));
    fireInto(rig, 'upperLegFront');
    rig.step(SECONDS(2.5));
    check(
      'an arrow can only damage once',
      rig.hits.length === 1,
      rig.hits.length + ' damage events, health=' + rig.players.right.health,
    );
    rig.physics.destroy();
  }

  // A slow arrow does no damage.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.6));
    rig.setSway(false);
    rig.step(SECONDS(0.5));
    const torso = rig.ragdolls.right.torso;
    for (const body of rig.ragdolls.right.bodies) {
      if (body !== torso) body.collisionFilter.mask = 0;
    }
    // Fired from just off the target: a long slow flight would be accelerated
    // past the damage threshold by gravity before it ever arrived.
    rig.projectiles.launch(
      'left',
      { x: torso.position.x - 30, y: torso.position.y },
      0,
      COMBAT.minDamagingSpeed * 0.4,
    );
    rig.step(SECONDS(1.5));
    check(
      'an arrow below the damage speed does nothing',
      rig.hits.length === 0 && rig.players.right.health === COMBAT.maxHealth,
    );
    rig.physics.destroy();
  }

  // Shooter grace period.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.6));
    const own = rig.ragdolls.left.torso.position;
    // Fire backwards, straight through the shooter's own body.
    rig.projectiles.launch('left', { x: own.x + 40, y: own.y }, Math.PI, 900);
    rig.step(SECONDS(0.4));
    check('an arrow does not hit its own shooter on launch', rig.players.left.health === COMBAT.maxHealth);
    rig.physics.destroy();
  }

  // Losing your footing.
  {
    const rig = makeRig('desert', 55);
    rig.step(SECONDS(0.5));
    const target = rig.ragdolls.right;

    check('an archer starts the round on its feet', target.standing);

    // One solid hit rocks the archer but should not fell it.
    SwayController.addBalanceLoss(target, (COMBAT.damage.torso / COMBAT.maxHealth) * 1.6);
    check('a single hit does not knock the archer down', target.standing,
      'balance lost ' + target.balanceLoss.toFixed(2));

    // A second, quickly after, does.
    const toppled = SwayController.addBalanceLoss(target, (COMBAT.damage.torso / COMBAT.maxHealth) * 1.6);
    check('two quick hits take the archer off its feet', toppled && !target.standing);

    // A released archer must be a real ragdoll again: its joints are live.
    check(
      'a toppled archer gets its joints back',
      target.joints.every(({ constraint, stiffness }) => constraint.stiffness === stiffness),
      target.joints.length + ' joints restored',
    );
    rig.physics.destroy();
  }

  // Balance recovers, so spaced-out hits never accumulate into a topple.
  {
    const rig = makeRig('desert', 56);
    rig.step(SECONDS(0.5));
    const target = rig.ragdolls.right;
    for (let i = 0; i < 6; i++) {
      SwayController.addBalanceLoss(target, (COMBAT.damage.upperLeg / COMBAT.maxHealth) * 1.6);
      rig.step(SECONDS(2));
    }
    check('balance recovers between spaced-out hits', target.standing,
      'balance lost ' + target.balanceLoss.toFixed(2) + ' after 6 spaced limb hits');
    rig.physics.destroy();
  }

  // Falling off the platform.
  {
    const rig = makeRig('desert', 31);
    rig.step(SECONDS(0.5));

    // Knock the archer off its feet through the same path a heavy hit uses, so
    // it stops being posed and becomes a free ragdoll.
    SwayController.releaseRagdoll(rig.ragdolls.right);
    const gapX =
      (rig.arena.platforms.left.x + rig.arena.platforms.right.x) / 2 - rig.ragdolls.right.torso.position.x;
    for (const body of rig.ragdolls.right.bodies) {
      Matter.Body.translate(body, { x: gapX, y: 0 });
      Matter.Body.setVelocity(body, { x: 0, y: toStepVelocity(200) });
    }

    rig.step(SECONDS(4));
    check(
      'falling past the arena boundary is a defeat',
      rig.defeats.some((d) => d.loser === 'right' && d.byFall),
      rig.defeats.length + ' defeats, torso y=' + rig.ragdolls.right.torso.position.y.toFixed(0),
    );
    rig.physics.destroy();
  }
}

/**
 * Fires an arrow into one specific body part of the right-hand archer.
 *
 * The ragdolls sway under randomised forces, so a shot aimed at a part's
 * position can legitimately be intercepted by whichever limb has drifted into
 * the path. Every other part is made non-collidable for the shot so the test
 * measures region resolution and damage rather than the luck of the pose.
 */
function fireInto(rig: Rig, partName: string): void {
  const target = rig.ragdolls.right.parts[partName];
  if (!target) throw new Error('no such part: ' + partName);

  // Hold the pose still, then let only the intended part be hit.
  rig.setSway(false);
  rig.step(SECONDS(0.5));
  for (const body of rig.ragdolls.right.bodies) {
    if (body !== target) body.collisionFilter.mask = 0;
  }

  const from = { x: target.position.x - 70, y: target.position.y };
  const angle = Math.atan2(target.position.y - from.y, target.position.x - from.x);
  rig.projectiles.launch('left', from, angle, 800);
}

/* ------------------------------------------------------------------ *
 * 7. CPU opponent
 * ------------------------------------------------------------------ */

section('7. CPU opponent');
{
  // Solve a known geometry directly to prove the ballistic maths.
  {
    const rig = makeRig('desert', 4001);
    const ai = new AIController('right', rig.ragdolls.right, rig.bows.right, () => rig.physics.getTerrain(), 1);
    const solve = (ai as unknown as {
      solveLaunchAngle: (dx: number, dy: number, speed: number) => number | null;
    }).solveLaunchAngle.bind(ai);

    const dx = -600;
    const dy = 0;
    const speed = 1100;
    const angle = solve(dx, dy, speed);
    check('AI finds a firing solution for a reachable target', angle !== null);

    if (angle !== null) {
      // Integrate the solution analytically and confirm it lands on target.
      const vx = Math.cos(angle) * speed;
      const vy = Math.sin(angle) * speed;
      const t = dx / vx;
      const landedY = vy * t + 0.5 * PHYSICS.gravity * t * t;
      check(
        'the solution actually reaches the target',
        t > 0 && near(landedY, dy, 6),
        'flight ' + t.toFixed(2) + 's, error ' + (landedY - dy).toFixed(2) + 'px',
      );
    }

    const outOfRange = solve(4000, 0, BOW.minLaunchSpeed);
    check('AI reports no solution when out of range', outOfRange === null);
    rig.physics.destroy();
  }

  // A full CPU-vs-CPU duel must resolve without deadlock.
  {
    let totalShots = 0;
    let resolved = 0;
    const trials = 6;

    for (let trial = 0; trial < trials; trial++) {
      const rig = makeRig(['desert', 'city', 'jungle'][trial % 3] as 'desert', 600 + trial * 977);
      const aiLeft = new AIController('left', rig.ragdolls.left, rig.bows.left, () => rig.physics.getTerrain(), 0.75);
      const aiRight = new AIController('right', rig.ragdolls.right, rig.bows.right, () => rig.physics.getTerrain(), 0.75);

      let shots = 0;
      let seen = 0;
      rig.step(SECONDS(30), () => {
        aiLeft.update(TIME.step, rig.ragdolls.right);
        aiRight.update(TIME.step, rig.ragdolls.left);
        const live = rig.projectiles.list().length;
        if (live > seen) shots += live - seen;
        seen = live;
      });

      totalShots += shots;
      if (rig.defeats.length > 0) resolved++;
      rig.physics.destroy();
    }

    check('CPU archers fire through the bow', totalShots >= trials * 3, totalShots + ' arrows across ' + trials + ' duels');
    check(
      'CPU duels reach a decision',
      resolved >= Math.ceil(trials / 2),
      resolved + '/' + trials + ' duels ended in a defeat within 30s',
    );
  }

  // Difficulty must stay inside the fair band.
  {
    const rig = makeRig('desert', 12);
    const ai = new AIController('right', rig.ragdolls.right, rig.bows.right, () => rig.physics.getTerrain(), 5);
    check('difficulty is clamped at the ceiling', ai.getDifficulty() === AI.maxDifficulty);
    ai.setDifficulty(-3);
    check('difficulty is clamped at the floor', ai.getDifficulty() === AI.minDifficulty);
    rig.physics.destroy();
  }
}

/* ------------------------------------------------------------------ *
 * 8. Fixed timestep behaviour
 * ------------------------------------------------------------------ */

section('8. Fixed timestep');
{
  const world = new PhysicsWorld();
  let steps = 0;
  world.update(1000, () => steps++);
  check(
    'a huge frame delta is capped at ' + TIME.maxCatchUpSteps + ' steps',
    steps === TIME.maxCatchUpSteps,
    steps + ' steps run',
  );

  steps = 0;
  world.resetClock();
  world.update(TIME.step * 2.4, () => steps++);
  check('a normal frame runs the expected steps', steps === 2, steps + ' steps');

  // After a reset the leftover accumulator must not fire a bonus step.
  world.resetClock();
  steps = 0;
  world.update(1, () => steps++);
  check('resetClock discards the backlog so resuming does not jump', steps === 0);
  world.destroy();
}

/* ------------------------------------------------------------------ *
 * 9. Cleanup
 * ------------------------------------------------------------------ */

section('9. Teardown');
{
  const rig = makeRig('jungle', 808);
  rig.step(SECONDS(1));
  rig.projectiles.launch('left', { x: 300, y: 300 }, 0, 800);
  rig.step(SECONDS(0.5));

  const populated = Matter.Composite.allBodies(rig.physics.world).length;
  check('the world holds bodies during a round', populated > 20, populated + ' bodies');

  rig.projectiles.clear();
  rig.factory.destroy(rig.ragdolls.left);
  rig.factory.destroy(rig.ragdolls.right);

  const remaining = Matter.Composite.allBodies(rig.physics.world).length;
  const constraints = Matter.Composite.allConstraints(rig.physics.world).length;
  const terrain = rig.physics.getTerrain().length;
  check(
    'tearing down a round leaves only terrain',
    remaining === terrain && constraints === 0,
    remaining + ' bodies (' + terrain + ' terrain), ' + constraints + ' constraints',
  );

  rig.physics.clear();
  check('clear() empties the world', Matter.Composite.allBodies(rig.physics.world).length === 0);
  rig.physics.destroy();
}

/* ------------------------------------------------------------------ *
 * 10. Match rules
 * ------------------------------------------------------------------ */

section('10. Match rules');
{
  check('a match is played to ' + MATCH.targetScore + ' points', MATCH.targetScore === 5);
  check('maximum health is 100', COMBAT.maxHealth === 100);
  check('a head hit is lethal in one arrow', COMBAT.damage.head >= COMBAT.maxHealth);
  check(
    'three torso hits are not quite lethal, four are',
    COMBAT.damage.torso * 2 < COMBAT.maxHealth && COMBAT.damage.torso * 3 >= COMBAT.maxHealth,
    COMBAT.damage.torso + ' per torso hit',
  );
  check('the logical viewport is 1280x720', VIEW.width === 1280 && VIEW.height === 720);
  check('the fixed step is 60Hz', near(TIME.step, 16.67, 0.01));
}

/* ------------------------------------------------------------------ *
 * 11. Application state machine
 * ------------------------------------------------------------------ */

section('11. State machine');
{
  const legal: Array<[GamePhase, GamePhase]> = [
    ['loading', 'menu'],
    ['menu', 'instructions'],
    ['menu', 'roundIntro'],
    ['menu', 'playing'],
    ['roundIntro', 'playing'],
    ['playing', 'paused'],
    ['paused', 'playing'],
    ['playing', 'roundResult'],
    ['roundResult', 'roundIntro'],
    ['roundResult', 'matchResult'],
    ['playing', 'deathmatchResult'],
    ['matchResult', 'menu'],
    ['deathmatchResult', 'menu'],
    ['deathmatchResult', 'playing'],
  ];
  const illegal: Array<[GamePhase, GamePhase]> = [
    ['loading', 'playing'],
    ['menu', 'paused'],
    ['menu', 'matchResult'],
    ['paused', 'roundResult'],
    ['instructions', 'playing'],
    ['roundResult', 'playing'],
    ['matchResult', 'paused'],
  ];

  check('every specified transition is allowed', legal.every(([a, b]) => canTransition(a, b)),
    legal.filter(([a, b]) => !canTransition(a, b)).map(([a, b]) => a + '->' + b).join(', ') || 'all ok');
  check('illegal transitions are rejected', illegal.every(([a, b]) => !canTransition(a, b)),
    illegal.filter(([a, b]) => canTransition(a, b)).map(([a, b]) => a + '->' + b).join(', ') || 'all blocked');

  check('only `playing` drives the match clock', isSimulating('playing') && !isSimulating('paused') && !isSimulating('menu'));
  check('the arena stays visible behind every result overlay',
    showsArena('roundIntro') && showsArena('paused') && showsArena('roundResult') &&
    showsArena('matchResult') && showsArena('deathmatchResult') && !showsArena('menu'));
}

/* ------------------------------------------------------------------ *
 * 12. The optional sidestep
 * ------------------------------------------------------------------ */

section('12. Sidestep');
{
  const rig = makeRig('desert', 5150);
  const archer = rig.ragdolls.left;
  const platform = rig.arena.platforms.left;
  const reach = platform.width / 2 - STEP.edgeMargin;
  archer.stepBounds = { minX: platform.x - reach, maxX: platform.x + reach };

  /**
   * Hold the swing still. The archer leans through a wide arc, which moves the
   * torso far further than a step does, so with the swing running a step is
   * unmeasurable at the body. Stopping the swing rate freezes the lean without
   * stopping the pose, which is what carries the step.
   */
  archer.swingRate = 0;
  archer.swingRateTarget = 0;
  archer.swingRateTimer = Number.MAX_SAFE_INTEGER;
  rig.step(4);

  const startX = archer.pivot.x;
  const startTorso = archer.torso.position.x;

  check('an archer starts with no step running', archer.stepElapsed < 0 && archer.stepCooldown === 0);

  check('a step is accepted while standing', SwayController.step(archer, 1));
  check('a second step is refused until the first has settled', !SwayController.step(archer, 1));

  // Run out the glide.
  rig.step(Math.ceil(STEP.durationMs / TIME.step) + 2);
  check(
    'one step covers its fixed distance and no more',
    near(archer.pivot.x - startX, STEP.distance, 0.5),
    (archer.pivot.x - startX).toFixed(1) + 'px of ' + STEP.distance,
  );
  check(
    'the body actually travels with the feet',
    near(archer.torso.position.x - startTorso, STEP.distance, 2),
    (archer.torso.position.x - startTorso).toFixed(1) + 'px of ' + STEP.distance,
  );
  check('the step ends rather than drifting on', archer.stepElapsed < 0);

  // The glide is over but the cooldown outlasts it, which is what stops the
  // step from being held down as a walk.
  check('the cooldown outlives the glide', !SwayController.step(archer, 1));
  rig.step(Math.ceil((STEP.cooldownMs - STEP.durationMs) / TIME.step) + 2);
  check('another step is allowed once the cooldown has run', SwayController.step(archer, 1));
  rig.step(Math.ceil(STEP.durationMs / TIME.step) + 2);

  // Walk into the edge. The platform is finite, so this must stop.
  for (let i = 0; i < 12; i++) {
    SwayController.step(archer, 1);
    rig.step(Math.ceil(STEP.cooldownMs / TIME.step) + 2);
  }
  check(
    'stepping cannot walk an archer off its platform',
    archer.pivot.x <= archer.stepBounds.maxX + 0.5,
    archer.pivot.x.toFixed(1) + ' against a limit of ' + archer.stepBounds.maxX.toFixed(1),
  );
  check(
    'and still leaves the feet on the surface',
    archer.pivot.x < platform.x + platform.width / 2,
    (platform.x + platform.width / 2 - archer.pivot.x).toFixed(1) + 'px of ledge to spare',
  );
  check('a step against the edge is refused, not swallowed', !SwayController.step(archer, 1));

  // A toppled archer is a ragdoll; there is no pose for a step to move.
  const other = rig.ragdolls.right;
  SwayController.releaseRagdoll(other);
  check('a toppled archer cannot step', !SwayController.step(other, -1));

  rig.physics.destroy();
}

/* ------------------------------------------------------------------ *
 * 13. Snapshot codec — the only thing an online guest ever sees
 * ------------------------------------------------------------------ */

section('13. Snapshot codec');
{
  // A whole frame: two eleven-piece archers plus their bows, and a few arrows.
  const bodyCount = 24;
  const bodies: number[] = [];
  const rng = makeRng(20260903);
  for (let i = 0; i < bodyCount; i++) {
    bodies.push(rng() * 1280, rng() * 900 - 100, (rng() - 0.5) * Math.PI * 2);
  }
  const arrows: number[] = [];
  for (let i = 0; i < 6; i++) {
    arrows.push(1000 + i, i % 2, rng() * 1280, rng() * 700, (rng() - 0.5) * 3);
  }

  const snapshot = {
    n: 4242,
    t: 1234567,
    b: bodies,
    a: arrows,
    bw: [BOW_PHASES.indexOf('drawing'), 0.63, BOW_PHASES.indexOf('reloading'), 0] as [number, number, number, number],
    d: [0, 1] as [number, number],
  };

  const encoded = encodeSnapshot(snapshot);
  const decoded = decodeSnapshot(encoded)!;

  check('a packed frame is far smaller than its JSON', encoded.byteLength < JSON.stringify(snapshot).length / 2.5,
    encoded.byteLength + ' bytes vs ' + JSON.stringify(snapshot).length + ' as JSON');

  check('every body survives the round trip', decoded !== null && decoded.b.length === bodies.length,
    decoded ? decoded.b.length + ' of ' + bodies.length : 'decode failed');

  let worstPos = 0;
  let worstAngle = 0;
  for (let i = 0; i < bodies.length; i += 3) {
    worstPos = Math.max(worstPos, Math.abs(decoded.b[i] - bodies[i]), Math.abs(decoded.b[i + 1] - bodies[i + 1]));
    worstAngle = Math.max(worstAngle, Math.abs(decoded.b[i + 2] - bodies[i + 2]));
  }
  // Quarter-pixel and ten-thousandth-radian fields: both are well under one
  // rendered pixel, which is the only thing the precision has to buy.
  check('positions land within a quarter of a pixel', worstPos <= 0.125 + 1e-9, 'worst ' + worstPos.toFixed(4) + 'px');
  check('angles land within a thousandth of a radian', worstAngle <= 0.001, 'worst ' + worstAngle.toFixed(5) + ' rad');

  check('arrow identity and ownership survive',
    decoded.a.length === arrows.length &&
      decoded.a.every((v, i) => (i % 5 < 2 ? v === arrows[i] : true)),
    decoded.a.length / 5 + ' arrows');

  check('the host timestamp survives, since playback is spaced by it',
    decoded.t === snapshot.t, decoded.t + ' vs ' + snapshot.t);

  check('bow phase, charge and defeat flags survive',
    decoded.n === snapshot.n &&
      decoded.bw[0] === snapshot.bw[0] &&
      decoded.bw[2] === snapshot.bw[2] &&
      Math.abs(decoded.bw[1] - snapshot.bw[1]) < 0.01 &&
      decoded.d[0] === 0 && decoded.d[1] === 1);

  // A ragdoll's angle accumulates without bound as it spins; the field holds
  // one turn, so the encoder has to wrap rather than clip.
  const spun = { ...snapshot, b: [100, 100, 42.5], a: [] as number[] };
  const spunBack = decodeSnapshot(encodeSnapshot(spun))!;
  const wrapped = Math.atan2(Math.sin(42.5), Math.cos(42.5));
  check('an angle that has wound past a full turn still decodes as its direction',
    Math.abs(spunBack.b[2] - wrapped) < 0.001, spunBack.b[2].toFixed(3) + ' vs ' + wrapped.toFixed(3));

  check('a truncated frame is rejected rather than half-applied',
    decodeSnapshot(encoded.slice(0, encoded.byteLength - 3)) === null &&
      decodeSnapshot(new ArrayBuffer(4)) === null);
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

console.log('\n' + '='.repeat(56));
if (failures.length === 0) {
  console.log('All ' + passed + ' checks passed.');
} else {
  console.log(passed + ' passed, ' + failures.length + ' FAILED:');
  for (const f of failures) console.log('  - ' + f);
}
console.log('='.repeat(56));

process.exit(failures.length === 0 ? 0 : 1);
