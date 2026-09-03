import type { GamePhase } from '../types';

/**
 * The authoritative transition table from the specification. Every phase change
 * routes through `canTransition`, so an illegal jump is a loud no-op rather than
 * a silently broken screen.
 */
const TRANSITIONS: Record<GamePhase, GamePhase[]> = {
  loading: ['menu'],
  // Deathmatch skips roundIntro and goes straight to playing.
  menu: ['instructions', 'roundIntro', 'playing'],
  instructions: ['menu'],
  roundIntro: ['playing', 'menu'],
  playing: ['paused', 'roundResult', 'deathmatchResult', 'menu'],
  paused: ['playing', 'menu'],
  roundResult: ['roundIntro', 'matchResult', 'menu'],
  matchResult: ['menu', 'roundIntro', 'playing'],
  deathmatchResult: ['menu', 'playing'],
};

export function canTransition(from: GamePhase, to: GamePhase): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

export function allowedTransitions(from: GamePhase): GamePhase[] {
  return TRANSITIONS[from] ?? [];
}

/** Phases in which the simulation should be advancing. */
export function isSimulating(phase: GamePhase): boolean {
  return phase === 'playing';
}

/** Phases in which the canvas should be visible behind any overlay. */
export function showsArena(phase: GamePhase): boolean {
  return (
    phase === 'roundIntro' ||
    phase === 'playing' ||
    phase === 'paused' ||
    phase === 'roundResult' ||
    phase === 'matchResult' ||
    phase === 'deathmatchResult'
  );
}
