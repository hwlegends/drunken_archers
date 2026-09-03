# Physics Ragdoll Archery Duel — React Implementation Specification

## 1. Purpose

Build a responsive browser game inspired by the behavior of *Drunken Archers Duel*. Two unstable ragdoll archers stand on separated elevated platforms and fire arrows at one another using a one-button charge-and-release mechanic.

This is a clean-room behavioral specification. Reproduce the interaction model and game structure, but use an original title, artwork, audio, characters, branding, and source code.

## 2. Target platform and technology

- React with TypeScript for application structure, menus, HUD, settings, and state transitions.
- A single imperative canvas renderer for active gameplay.
- Matter.js or an equivalent constraint-based 2D physics engine.
- Optional PixiJS renderer for sprites and effects.
- Desktop and mobile web browsers.
- Landscape-first 16:9 layout.
- Logical gameplay viewport of 1280 × 720.

React must not receive per-frame body transforms through component state. The canvas/physics layer owns high-frequency simulation data; React receives only low-frequency events such as score, health, pause state, and match results.

## 3. Game modes

### 3.1 One Player

- One human player competes against a CPU opponent.
- Both characters may charge and shoot simultaneously.
- Each defeated opponent awards one round point.
- The first player to five points wins the match.

### 3.2 Two Players

- Two players compete locally on one device.
- Both players may charge and shoot simultaneously.
- Desktop uses separate keyboard controls.
- Touch devices use left and right screen regions.
- The first player to five points wins the match.

### 3.3 Deathmatch

- One human player fights successive CPU opponents.
- Defeating an opponent increases the player's score by one.
- A defeated opponent is replaced and the next encounter may use a new arena, platform arrangement, skin, and difficulty level.
- Health is restored at the start of each new encounter.
- The run ends when the human player is defeated.
- Current and best scores are displayed.
- Best score is stored in `localStorage`.

## 4. Core gameplay loop

1. Player selects a mode.
2. The game selects an arena and valid platform arrangement.
3. Both archers spawn with full health and a nocked arrow.
4. A short `FIGHT!` overlay appears.
5. Characters continuously wobble under ragdoll physics.
6. Pressing and holding the action input draws the bow and increases power.
7. Releasing the input fires along the bow's current direction.
8. The arrow follows a gravity-driven ballistic arc.
9. A character hit causes location-based damage and physical knockback.
10. A headshot immediately defeats the target.
11. A defeated player's opponent receives one point.
12. In standard modes, a new round begins until one player reaches five points.
13. In Deathmatch, another opponent is generated until the human player loses.

## 5. State model

The application must support these states:

- `loading`
- `menu`
- `instructions`
- `roundIntro`
- `playing`
- `paused`
- `roundResult`
- `matchResult`
- `deathmatchResult`

Valid transitions:

- `loading` → `menu`
- `menu` → `instructions`, `roundIntro`, or `playing` for Deathmatch
- `roundIntro` → `playing`
- `playing` ↔ `paused`
- `playing` → `roundResult` after a standard-mode defeat
- `roundResult` → `roundIntro` when both scores are below five
- `roundResult` → `matchResult` when a score reaches five
- Deathmatch `playing` → new encounter after an enemy defeat
- Deathmatch `playing` → `deathmatchResult` after the human is defeated
- Any result screen → `menu` or a restarted game

## 6. Input requirements

### 6.1 Desktop defaults

| Mode | Player | Input |
| --- | --- | --- |
| One Player | Human | Hold/release `ArrowUp` |
| Two Players | Player 1 | Hold/release `W` |
| Two Players | Player 2 | Hold/release `ArrowUp` |
| Deathmatch | Human | Hold/release `ArrowUp` |
| All modes | Pause | `Escape` or pause button |

### 6.2 Pointer and touch

- In solo modes, holding anywhere in the gameplay region charges the shot; releasing fires it.
- In two-player mode, the left half controls Player 1 and the right half controls Player 2.
- Use Pointer Events and pointer capture.
- Support two simultaneous touch pointers.
- Prevent browser scrolling, zoom gestures, and text selection inside the game surface.

### 6.3 Input safety

- Ignore keyboard auto-repeat.
- Do not begin a second charge while a shot is already charging.
- Cancel or safely release input when the window loses focus.
- Clear all active input when entering pause or leaving gameplay.
- `W` and `ArrowUp` must work simultaneously.

## 7. Ragdoll requirements

Each archer consists of independent rigid bodies:

- Head
- Torso
- Two upper arms
- Two lower arms
- Two upper legs
- Two lower legs
- Bow

Requirements:

- Join body parts with constrained rotational joints.
- Use collision groups to prevent unstable self-collision where appropriate.
- Use a soft balance or foot constraint so the character can sway substantially without immediately falling.
- Apply low-frequency alternating torque to the torso.
- Add small randomized impulses so the motion is not perfectly periodic.
- Allow arrow impacts and bow recoil to influence the ragdoll.
- Keep the bow attached to the forward hand.
- The bow angle follows the current arm pose; players do not directly aim with a cursor.
- Make blue and orange/red characters visually distinguishable.

## 8. Bow and charging behavior

- A new arrow begins nocked at the bow's launch point.
- Holding the input increases normalized charge from 0 to 1.
- Bow flex, arm pose, or string position must visually communicate charge.
- Charge stops increasing after reaching its maximum.
- Releasing converts charge to launch speed using an easing curve.
- Shot direction uses the current bow angle at release time.
- Apply recoil to the hands and torso.
- After a short reload delay, attach a new nocked arrow.
- Do not display a precision aiming reticle; timing the character's wobble is the primary skill.

## 9. Arrow physics

- Arrows are dynamic projectile bodies affected by gravity.
- Rotate an in-flight arrow so it points along its current velocity vector.
- Ignore collision with the shooter for a brief launch grace period.
- Require a minimum impact speed before applying character damage.
- An arrow may damage a character only once.
- On a valid hit, apply an impulse to the struck body part.
- Embed the arrow into the body or terrain using a temporary constraint.
- Terrain hits do not cause player damage.
- Remove embedded arrows after a configured lifetime.
- Immediately remove projectiles that leave the world bounds.

## 10. Damage and defeat

Use 100 maximum health.

Recommended initial damage values:

| Body region | Damage |
| --- | ---: |
| Head | 100 — immediate defeat |
| Torso | 34 |
| Upper/lower arm | 20 |
| Upper/lower leg | 20 |

Damage requirements:

1. Confirm that the arrow is active.
2. Confirm that the target is not the protected shooter.
3. Confirm minimum impact velocity.
4. Resolve the body region.
5. Apply damage and impact force.
6. Emit an impact or blood effect.
7. Show `HEADSHOT` for a fatal head hit.
8. Mark the arrow as spent.
9. Check defeat conditions.
10. Award at most one point.

A player is defeated when health reaches zero or the ragdoll falls below the arena's defeat boundary.

Include a reduced-blood setting that substitutes a non-blood impact effect.

## 11. Recommended tuning defaults

These values are starting points and must remain configurable:

| Setting | Initial value |
| --- | ---: |
| Logical viewport | 1280 × 720 |
| Fixed physics step | 16.67 ms |
| Maximum health | 100 |
| Time to maximum charge | 1.0 seconds |
| Minimum launch speed | 600 px/s |
| Maximum launch speed | 1,300 px/s |
| Gravity | 1,200 px/s² |
| Minimum damaging speed | 250 px/s |
| Shooter collision grace period | 100 ms |
| Reload delay | 350 ms |
| Round-result delay | 1.5 seconds |
| Standard match target | 5 points |
| Projectile cleanup lifetime | 5 seconds |
| Fixed-step catch-up cap | 5 simulation steps |

## 12. CPU opponent

- The CPU must fire through the same charge/release pathway used by a human.
- Estimate a ballistic solution using target position, distance, height difference, gravity, and available launch speed.
- Wait for the wobbling bow to approach a usable angle.
- Select charge duration based on the predicted trajectory.
- Add reaction delay, angle error, and power error.
- Occasionally take an imperfect shot.
- Do not teleport projectiles, directly set impact locations, or disable gravity.
- Avoid firing while the bow or launch point is obstructed.

Deathmatch difficulty increases gradually by reducing reaction delay and shot error. Difficulty must have upper and lower limits so the game remains fair.

## 13. Arenas

Provide at least three original arena themes:

1. Desert with rock pillars
2. City skyline with rooftop platforms
3. Tropical jungle with palm-tree platforms

Each `ArenaConfig` defines:

- Background and optional parallax layers
- Static platform bodies and collision polygons
- Left and right spawn points
- Camera center and zoom
- Projectile bounds
- Fall/defeat boundary
- Optional ambient particles

Platform arrangements may vary between rounds. Validate each generated arrangement so that players remain visible, do not overlap terrain, maintain adequate separation, and have viable trajectories to one another.

## 14. Screens and HUD

Required screens:

- Loading screen
- Main menu
- Instructions overlay
- One-player match
- Two-player match
- Deathmatch
- Pause overlay
- Match victory screen
- Deathmatch defeat screen

Main-menu controls:

- One Player
- Two Players
- Deathmatch
- How to Play
- Music toggle
- Sound-effects toggle
- Fullscreen

Gameplay HUD:

- Blue-versus-orange score at the top center
- Screen-aligned health bar above each archer
- Pause button
- Short `FIGHT`, point-awarded, and `HEADSHOT` overlays

Result-screen controls:

- Rematch/retry
- Home
- Current score where relevant
- Best Deathmatch score
- Optional screenshot/share control using original UI artwork

## 15. Audio requirements

Use original or properly licensed audio for:

- Background music
- Bow draw
- Bow release
- Arrow flight
- Character/body impact
- Headshot
- Character reaction
- Round point
- Match victory and defeat
- Interface buttons

Music and sound effects must have separate toggles. Persist settings locally. Unlock audio only after a user gesture to comply with browser autoplay rules.

## 16. Recommended application modules

- `GameCanvas` — canvas creation, rendering, and resize handling
- `GameStateMachine` — valid application and match transitions
- `PhysicsWorld` — engine initialization and fixed-step simulation
- `RagdollFactory` — body, joint, collision-group, and skin creation
- `BowController` — draw state, charge, reload, and release
- `ProjectileSystem` — arrow creation, flight, collision, embedding, and cleanup
- `CombatSystem` — damage, headshots, defeat, and scoring
- `InputManager` — keyboard, pointer, touch, focus, and pause behavior
- `AIController` — CPU trajectory estimation and decisions
- `ArenaManager` — arena selection, validation, and spawning
- `CameraController` — framing and optional zoom
- `AudioManager` — music, effects, mute, and browser audio lifecycle
- `GameStore` — mode, scores, health, settings, and low-frequency UI state

## 17. Data models

At minimum, define:

- `GameMode`
- `GamePhase`
- `MatchConfig`
- `ArenaConfig`
- `PlayerState`
- `RagdollHandle`
- `BowState`
- `ProjectileState`
- `HitEvent`
- `RoundResult`
- `GameSettings`
- `PersistentStats`

All tunable physics, combat, AI, camera, and timing constants must be centralized rather than embedded in components.

## 18. Performance and responsive behavior

- Target 60 FPS on desktop and at least 30 FPS on supported mobile devices.
- Use a fixed physics timestep with render interpolation when necessary.
- Cap device pixel ratio at 2.
- Scale the 16:9 gameplay viewport using `contain`; letterbox rather than stretching.
- Show a rotate-device prompt when a narrow phone is in portrait orientation.
- Pause automatically when the page becomes hidden.
- Prevent a large simulation jump after returning to the page.
- Pool particles where useful.
- Destroy all constraints, bodies, listeners, timers, and audio handles when restarting or leaving a match.

## 19. Out of MVP scope

- Online multiplayer
- Y8 account integration
- Y8 achievements or leaderboard integration
- Monetization and advertising
- Copying or extracting the original game's source code, logo, sprites, sound, or music

A later phase may add original local achievements, online leaderboards, gamepads, replay capture, additional arenas, and cosmetic customization.

## 20. Acceptance criteria

1. All three game modes can be started from the menu.
2. Holding increases shot power; releasing fires exactly one arrow.
3. Arrow direction matches the bow's current direction at release.
4. Two local players can charge and release simultaneously.
5. Mobile two-player mode recognizes two simultaneous touch pointers.
6. Arrows follow gravity and rotate along their velocity.
7. A body hit applies damage and physical knockback.
8. A headshot immediately defeats the target.
9. One arrow cannot apply duplicate damage.
10. A standard match ends only when one player reaches five points.
11. Defeated players and projectiles are completely reset for a new round.
12. Deathmatch creates successive opponents and persists the best score.
13. Falling below the arena boundary causes defeat.
14. Pausing freezes physics, AI, projectiles, input, and timers.
15. Resuming does not cause a physics time jump.
16. Restarting creates a clean match with no stale bodies or event listeners.
17. Music, sound, and reduced-blood preferences persist across sessions.
18. The game remains fully playable at common desktop, tablet, and phone landscape sizes.
19. The physics loop avoids per-frame React re-renders.
20. A production build contains only original or properly licensed visual and audio assets.

## 21. Research references

- Y8 game page: https://www.y8.com/games/drunken_archers_duel
- Y8 walkthrough: https://www.y8.com/animation/drunken_archers_duel_walkthrough
- Gameplay and mode description: https://appleworm.io/drunken-archers-duel

