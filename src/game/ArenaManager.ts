import { ARENA_IDS, createArena, pickArenaTheme, validateArrangement } from '../config/arenas';
import type { ArenaConfig, ArenaThemeId, Side, Vec2 } from '../types';

/**
 * Chooses an arena and a validated platform arrangement for each round, and
 * hands out the spawn points the ragdolls are built at.
 */
export class ArenaManager {
  private current: ArenaConfig | null = null;
  private lastTheme: ArenaThemeId | null = null;
  private lastSeed = 0;

  /**
   * Builds the next arena. A round in a standard match keeps the same theme and
   * only re-rolls the platforms; a new deathmatch encounter may switch theme
   * entirely.
   */
  next(options: { newTheme: boolean; theme?: ArenaThemeId; seed?: number }): ArenaConfig {
    const theme = options.theme
      ? options.theme
      : options.newTheme || !this.lastTheme
        ? pickArenaTheme(this.lastTheme ?? undefined)
        : this.lastTheme;

    let seed = options.seed ?? (Math.random() * 0xffffffff) >>> 0;
    let arena = createArena(theme, seed);

    // createArena already validates internally, but re-checking here keeps the
    // guarantee local to whoever consumes the arena.
    if (!validateArrangement(arena.platforms)) {
      seed = 12345;
      arena = createArena(theme, seed);
    }

    this.current = arena;
    this.lastTheme = theme;
    this.lastSeed = seed;
    return arena;
  }

  get arena(): ArenaConfig | null {
    return this.current;
  }

  /**
   * Theme and seed of the arena in play. Generation is a pure function of the
   * two, so an online guest is handed these and rebuilds a byte-identical arena
   * instead of being sent the whole config every round.
   */
  get recipe(): { theme: ArenaThemeId; seed: number } {
    return { theme: this.lastTheme ?? 'desert', seed: this.lastSeed };
  }

  spawnFor(side: Side): Vec2 {
    if (!this.current) throw new Error('ArenaManager: no arena selected');
    return this.current.spawns[side];
  }

  /** The direction each archer faces: they always turn toward one another. */
  facingFor(side: Side): 1 | -1 {
    return side === 'left' ? 1 : -1;
  }

  themes(): ArenaThemeId[] {
    return ARENA_IDS;
  }

  reset(): void {
    this.current = null;
    this.lastTheme = null;
    this.lastSeed = 0;
  }
}
