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
- **Online** — the panel on the right lists everyone who has the game open.
  Challenge one of them and the match starts when they accept.

Headshots are instantly fatal, body and limb hits chip away at 100 health, and
falling off the arena is just as deadly.

## Running it

```bash
npm install
npm run dev        # dev server
npm run build      # production build to dist/
npm run preview    # serve the production build
```

## Playing from two computers

```bash
npm run host       # builds, then serves the game and the lobby on port 8787
```

It prints a `http://<address>:8787` line for every network interface. Open one
of those on the other computer — both machines land in the same lobby, see each
other in the right-hand panel, and either can challenge the other. Nothing else
has to be configured: the page talks to whatever address it was loaded from.

During development, run `npm run dev` and `npm run lobby` side by side; the dev
page reaches across to the lobby's own port. Any other arrangement — a
different port, a tunnel, a reverse proxy — goes in the **Server** field at the
bottom of the panel, or in a `?lobby=ws://…` query parameter.

The challenger's browser hosts: it runs the simulation and the other one
replays it. Two things follow from that.

A browser gives no animation frames to a hidden tab, so if the host minimises
the window or switches tabs the match stalls for both players until they come
back. The other screen says so rather than appearing to have crashed, and play
resumes where it left off.

And **run the lobby on one of the two computers playing**, which is what
`npm run host` does. Every message goes through it, so a lobby on some third
machine puts two internet hops in each direction instead of one; a lobby on
either player's machine is already as direct as a peer-to-peer connection would
be, in both directions and whoever ends up hosting. If the two machines differ,
challenge *from* the better-connected one — the host is the side that simulates
and the side that uploads.

## Controls

| Context | Input |
| --- | --- |
| One Player / Deathmatch | Hold and release `↑`, or press and hold anywhere on the arena |
| Two Players | `W` for blue, `↑` for orange; on touch, the left and right halves (both at once) |
| Online | `↑`, `W` or `Space` — all three drive your archer, whichever side you were given |
| Pause | `Esc` or `P`, or the pause button. Online has no pause; the button leaves the match |

## Architecture

The rule in [REQUIREMENTS.md §2](REQUIREMENTS.md) is that React never sees a
per-frame body transform. The canvas layer owns the simulation and pushes only
low-frequency events — score, health, round results, phase changes — up to the
store.

```
server/         lobby-server.mjs  serves dist/, lists who is online, relays a match
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
                RemoteView     the guest's copy of the host's world
                CameraController, ParticleSystem, AudioManager, Renderer
                GameEngine     orchestrates the above and owns the frame loop
  net/          protocol.ts    the wire format, lobby and match
                NetClient      one socket, with its own reconnect
                netStore.ts    lobby state (zustand); match traffic bypasses it
  state/        GameStateMachine  the phase transition table
                gameStore.ts      low-frequency UI state (zustand) + persistence
  components/   GameCanvas, HUD, LobbyPanel, and one component per screen
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
  staggering through it. Its speed also drifts randomly and occasionally runs
  backwards for a moment, so the cadence cannot be memorised — full leans come
  1.7 to 7.2 seconds apart around a nominal 3.8. The legs take slightly less of
  the lean than the upper body (`legShare`), so the archer folds a little at the
  hips instead of tipping like a plank.
- **The head clears the bow arm on purpose.** `neckGap` lifts the head above the
  raised bow arm. Without it the forearm sits straight across the face and
  intercepts arrows aimed at the head — measured, it took 10% of head-bound shots
  and dropped the head-hit share to 82%; with the gap that is 99%. The bow itself
  never collides with anything, so arrows always pass through it. Keeping the body rigid is a gameplay decision: a player can
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
- **Online is one browser hosting, not two simulating.** Two Matter worlds
  stepping the same inputs would have to agree exactly and forever, and the
  moment they did not there would be no way back. Instead the challenger's
  browser is the only authority: it owns the physics, the damage and the score,
  and ships a flattened frame of transforms 30 times a second. The guest runs no
  solver at all — it rebuilds the same arena from the same seed, writes those
  transforms into its own bodies, and renders them with the ordinary renderer.
  A round can never end differently on the two screens because only one of them
  ever decides anything.
- **A frame of the world is 184 bytes.** Snapshots are the only traffic that
  never stops, so they are packed into fixed-width integers — quarter-pixel
  positions, ten-thousandth-radian angles — rather than written as JSON, which
  cost about 650 bytes a frame for the same information. The relay forwards them
  as raw bytes without decoding. The figure that matters is the host's *upload*,
  because a saturated uplink does not drop frames politely: it delays them, and
  that delay arrives as jitter the guest has to buffer against.
- **Frames are played back late, on purpose — but only as late as the link
  requires.** `RemoteView` interpolates towards the newest frame rather than
  drawing it on arrival, because drawing on arrival turns ordinary jitter into
  visible stutter. Every millisecond of that buffer is a millisecond of lag on
  everything you see, so its size is one frame interval plus the jitter this
  particular connection has actually shown, measured continuously. A steady link
  pays about 40ms where a flat multiple of the frame rate charged 60ms, and a
  bad link now widens the buffer instead of stuttering through it.
- **A remote release is rewound to what that player could see.** The shot
  direction is the bow angle at the instant of release, so two delays stand
  between the two screens: the round trip, and the guest's own playback buffer.
  Both come off. Rewinding by half a trip — which is what this did first — left
  about a tenth of a second uncorrected, and a tenth of a second is several
  degrees of bow sweep, which across an arena is most of an archer. It read as
  the game ignoring where you aimed. The host keeps 500ms of bow poses and the
  guest reports its own buffer with every button; the correction is capped at
  250ms, past which favouring the shooter costs the other player more than it is
  worth.
- **The guest draws its own bow before the host confirms it.** A button that
  produces no feedback for a round trip feels like a slow game even when the
  match is healthy. A charge is only elapsed time, and the press and the release
  are delayed equally, so the duration the host measures is the duration held
  locally — predicting it is not an estimate that might be wrong, it is the same
  number arrived at sooner. The opponent's bow is still drawn and heard off the
  frames, so it stays in step with the picture.
- **The lobby relays, it does not arbitrate.** `server/lobby-server.mjs` tracks
  who is connected and who is challenging whom, and forwards match messages to
  the one socket paired with the sender. It never reads them.
- **Every asset is generated.** Characters, arenas, effects and interface art are
  drawn procedurally on canvas or as inline SVG; all audio is synthesised at
  runtime with the Web Audio API. There are no image or audio files in the
  build.

## Verification

```bash
npm run sim-check          # 80 headless physics/combat/AI/codec assertions
npm run visual-check       # drives the built game in Chrome, writes shots/
npm run online-check       # two browsers play a real match through the real lobby
npm run wire-check         # measures what a match costs on the wire, twice
npm run match-flow-check   # plays a full match to 5 and a deathmatch run (~6 min)
npm run typecheck
```

`sim-check` runs the real physics, ragdoll, bow, projectile, combat and AI code
under Node with no DOM, and asserts the behaviour the specification calls for —
gravity really is 1200 px/s², a headshot really is fatal, an arrow can only
damage once, pausing cannot jump the clock, and a teardown leaves no stale
bodies or constraints.

`online-check` starts the lobby, opens two independent browsers, and has them
find each other, challenge, accept and play. Its last assertion is that both
screens show the same score after a point — which is only true if the guest's
button reached the host, the host's world reached the guest, and neither drifted
in between. It uses two browsers rather than two tabs because a background tab
gets no animation frames, and the host's animation frame is the match.

`wire-check` plays the same match twice and counts bytes, holding the host to an
upload budget and a frame to 320 bytes, so a change that quietly triples the
traffic fails rather than merely feeling worse. The second run goes through a
relay holding every frame 120ms each way.

Two computers on a desk share a link fast enough that none of the lag
compensation matters, which is exactly the condition under which it cannot be
tested. `LOBBY_DELAY_MS` makes the relay hold every frame for a set delay, so
the same two computers behave like two cities:

```bash
LOBBY_DELAY_MS=120 npm run lobby
```

## About the reference material

This is an original implementation written from a clean-room behavioral
specification. [IMAGE_SOURCES.md](IMAGE_SOURCES.md) documents the reference
screenshots in `images/`, which are for visual research only — they are not part
of the build and must not be redistributed. All artwork, audio, characters,
naming and code here are original.
