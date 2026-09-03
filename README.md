# Drunken Archers

A physics ragdoll archery duel, built in React + TypeScript from the behavioral
specification in [REQUIREMENTS.md](REQUIREMENTS.md).

Two unstable archers stand on separated platforms and lob arrows at each other.
You never aim — you hold one button to draw, and the shot leaves along whatever
direction the bow happens to point at the instant you let go. Reading the
drunken wobble is the whole game.

- **One Player** — first to five points against the CPU.
- **Two Players** — local duel, `W` versus `↑`, or the two halves of a
  touchscreen.
- **Deathmatch** — endless successive opponents; health is restored each
  encounter, difficulty ramps, and the best run is saved.

Headshots are instantly fatal, body and limb hits chip away at 100 health, and
falling off the arena is just as deadly.

## Running it

```bash
npm install
npm run dev        # dev server
npm run build      # production build to dist/
npm run preview    # serve the production build
```

## Controls

| Context | Input |
| --- | --- |
| One Player / Deathmatch | Hold and release `↑`, or press and hold anywhere on the arena |
| Two Players | `W` for blue, `↑` for orange; on touch, the left and right halves (both at once) |
| Pause | `Esc` or `P`, or the pause button |

## Architecture

The rule in [REQUIREMENTS.md §2](REQUIREMENTS.md) is that React never sees a
per-frame body transform. The canvas layer owns the simulation and pushes only
low-frequency events — score, health, round results, phase changes — up to the
store.

```
src/
  config/       constants.ts   every tunable number, centralised
                arenas.ts      three themes + platform generation and validation
  game/         PhysicsWorld   Matter engine, fixed timestep, px/s <-> px/step units
                RagdollFactory eleven jointed bodies plus a bow, per fighter
                SwayController the drunkenness: body swing, topples, bow-arm sweep
                BowController  draw, charge, release, recoil, reload
                ProjectileSystem arrow flight, embedding, cleanup
                CombatSystem   the damage pipeline, defeat and scoring
                AIController   ballistic solving; fires the same bow a human does
                InputManager   keyboard, pointer, touch, focus safety
                ArenaManager   arena selection and spawns
                CameraController, ParticleSystem, AudioManager, Renderer
                GameEngine     orchestrates the above and owns the frame loop
  state/        GameStateMachine  the phase transition table
                gameStore.ts      low-frequency UI state (zustand) + persistence
  components/   GameCanvas, HUD, and one component per screen
```

A few details worth knowing:

- **Units.** Matter.js works in pixels-per-step; the spec states everything in
  px/s and px/s². All conversion is funnelled through `PhysicsWorld`, so no
  other module touches Matter's raw units.
- **The bow is welded to the forward hand.** Its angle follows the arm pose, and
  that angle *is* the shot direction. There is no aiming input.
- **A standing archer is posed, not solved for.** The body swings as one rigid
  piece about a pivot between its feet, through a wide ~124 degree arc, and the
  bow arm sweeps on top of that. The swing waveform is shaped rather than a plain
  sine (`swingShape`): a sine dwells near its peaks, which at this amplitude
  would leave the archer lying at full lean most of the time instead of
  staggering through it. Keeping the body rigid is a gameplay decision: a player can
  watch the swing and anticipate where the target will be, which loose
  independently-wobbling limbs never allowed. It is also what finally made the
  motion stable — three solver-driven attempts failed first. A torque servo on a
  wrapped angle error has an unstable equilibrium at 180 degrees and winds a limb
  into a permanent spin; constraining two points of a two-degree-of-freedom chain
  over-constrains it until the solver pumps in energy. Posing cannot wind up or
  blow up. Every joint is held inert while the archer stands, and `CombatSystem`
  restores them the moment it topples or dies, so the ragdoll takes over intact.
- **Hits cost balance.** Damage feeds a `balanceLoss` counter that recovers over
  time; cross the threshold — roughly two solid hits in quick succession — and
  the archer loses its footing, becomes a free ragdoll, and can be knocked clean
  off the arena. That is what keeps a fall a real way to lose a round now that a
  standing archer is posed rather than balanced by the solver.
- **Damping coefficients have a hard stability ceiling.** Matter integrates
  `angularVelocity += torque / inertia * dt^2`, and `dt^2` is about 278 at a
  60Hz step, so an inertia-scaled damping coefficient at or above `2 / 278`
  overshoots past zero and diverges instead of damping. Every such coefficient in
  `constants.ts` is set well inside that limit.
- **The CPU plays by the same rules.** It solves a ballistic launch angle for
  its current charge, waits for the wobble to line up, and releases the string.
  It never teleports a projectile or sets an impact point.
- **Every asset is generated.** Characters, arenas, effects and interface art are
  drawn procedurally on canvas or as inline SVG; all audio is synthesised at
  runtime with the Web Audio API. There are no image or audio files in the
  build.

## Verification

```bash
npm run sim-check          # 72 headless physics/combat/AI assertions
npm run visual-check       # drives the built game in Chrome, writes shots/
npm run match-flow-check   # plays a full match to 5 and a deathmatch run (~6 min)
npm run typecheck
```

`sim-check` runs the real physics, ragdoll, bow, projectile, combat and AI code
under Node with no DOM, and asserts the behaviour the specification calls for —
gravity really is 1200 px/s², a headshot really is fatal, an arrow can only
damage once, pausing cannot jump the clock, and a teardown leaves no stale
bodies or constraints.

## About the reference material

This is an original implementation written from a clean-room behavioral
specification. [IMAGE_SOURCES.md](IMAGE_SOURCES.md) documents the reference
screenshots in `images/`, which are for visual research only — they are not part
of the build and must not be redistributed. All artwork, audio, characters,
naming and code here are original.
