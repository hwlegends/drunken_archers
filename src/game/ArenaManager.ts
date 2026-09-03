import { ARENA_IDS, createArena, pickArenaTheme, validateArrangement } from '../config/arenas';
import type { ArenaConfig, ArenaThemeId, Side, Vec2 } from '../types';

/**
 * Chooses an arena and a validated platform arrangement for each round, and
 * hands out the spawn points the ragdolls are built at.
 */
export class ArenaManager {
  private current: ArenaConfig | null = null;
  private lastTheme: ArenaThemeId | null = null;

  /**
   * Builds the next arena. A round in a standard match keeps the same theme and
   * only re-rolls the platforms; a new deathmatch encounter may switch theme
   * entirely.
   */
  next(options: { newTheme: boolean; theme?: ArenaThemeId }): ArenaConfig {
    const theme = options.theme
      ? options.theme
      : options.newTheme || !this.lastTheme
        ? pickArenaTheme(this.lastTheme ?? undefined)
        : this.lastTheme;

    let arena = createArena(theme, (Math.random() * 0xffffffff) >>> 0);

    // createArena already validates internally, but re-checking here keeps the
    // guarantee local to whoever consumes the arena.
    if (!validateArrangement(arena.platforms)) {
      arena = createArena(theme, 12345);
    }

    this.current = arena;
    this.lastTheme = theme;
    return arena;
  }

  get arena(): ArenaConfig | null {
    return this.current;
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
  }
}
