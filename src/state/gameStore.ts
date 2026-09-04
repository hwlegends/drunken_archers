import { create } from 'zustand';
import { MATCH, STORAGE_KEYS } from '../config/constants';
import type {
  Announcement,
  AnnouncementKind,
  GameMode,
  GamePhase,
  GameSettings,
  PersistentStats,
  RoundResult,
  Side,
} from '../types';
import { canTransition } from './GameStateMachine';

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS: GameSettings = {
  music: true,
  sfx: true,
  reducedBlood: false,
  sidestep: false,
};
const DEFAULT_STATS: PersistentStats = { bestDeathmatchScore: 0, matchesPlayed: 0 };

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return { ...fallback, ...(JSON.parse(raw) as Partial<T>) };
  } catch {
    return fallback;
  }
}

function save<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable (private mode / quota) — settings simply do not persist */
  }
}

/* ------------------------------------------------------------------ *
 * Store
 * ------------------------------------------------------------------ */

let announcementId = 0;

interface GameStoreState {
  phase: GamePhase;
  mode: GameMode;
  /** Round points in standard modes. */
  scores: Record<Side, number>;
  /** Live health, pushed by the engine only when it actually changes. */
  health: Record<Side, number>;
  /** Deathmatch run score (opponents defeated). */
  deathmatchScore: number;
  /** Deathmatch encounter index, used to label opponents. */
  encounter: number;
  lastRound: RoundResult | null;
  matchWinner: Side | null;
  announcements: Announcement[];
  settings: GameSettings;
  stats: PersistentStats;
  /** True once the audio context has been unlocked by a user gesture. */
  audioUnlocked: boolean;
  loadProgress: number;

  setPhase: (phase: GamePhase) => boolean;
  forcePhase: (phase: GamePhase) => void;
  startMatch: (mode: GameMode) => void;
  setScores: (scores: Record<Side, number>) => void;
  setHealth: (side: Side, value: number) => void;
  setBothHealth: (left: number, right: number) => void;
  recordRound: (result: RoundResult) => void;
  setMatchWinner: (side: Side | null) => void;
  setDeathmatchScore: (value: number) => void;
  setEncounter: (value: number) => void;
  announce: (kind: AnnouncementKind, text: string, duration?: number, side?: Side) => void;
  dismissAnnouncement: (id: number) => void;
  clearAnnouncements: () => void;
  toggleSetting: (key: keyof GameSettings) => void;
  markAudioUnlocked: () => void;
  setLoadProgress: (value: number) => void;
  resetMatchState: () => void;
}

export const useGameStore = create<GameStoreState>((set, get) => ({
  phase: 'loading',
  mode: 'onePlayer',
  scores: { left: 0, right: 0 },
  health: { left: 100, right: 100 },
  deathmatchScore: 0,
  encounter: 0,
  lastRound: null,
  matchWinner: null,
  announcements: [],
  settings: load(STORAGE_KEYS.settings, DEFAULT_SETTINGS),
  stats: load(STORAGE_KEYS.stats, DEFAULT_STATS),
  audioUnlocked: false,
  loadProgress: 0,

  setPhase: (phase) => {
    const current = get().phase;
    if (current === phase) return true;
    if (!canTransition(current, phase)) {
      if (import.meta.env.DEV) {
        console.warn(`[GameStateMachine] blocked ${current} -> ${phase}`);
      }
      return false;
    }
    set({ phase });
    return true;
  },

  forcePhase: (phase) => set({ phase }),

  startMatch: (mode) =>
    set({
      mode,
      scores: { left: 0, right: 0 },
      health: { left: 100, right: 100 },
      deathmatchScore: 0,
      encounter: 0,
      lastRound: null,
      matchWinner: null,
      announcements: [],
    }),

  setScores: (scores) => set({ scores }),

  setHealth: (side, value) =>
    set((s) => (s.health[side] === value ? s : { health: { ...s.health, [side]: value } })),

  setBothHealth: (left, right) =>
    set((s) =>
      s.health.left === left && s.health.right === right ? s : { health: { left, right } },
    ),

  recordRound: (result) => set({ lastRound: result, scores: result.scores }),

  setMatchWinner: (side) => {
    if (side) {
      const stats = { ...get().stats, matchesPlayed: get().stats.matchesPlayed + 1 };
      save(STORAGE_KEYS.stats, stats);
      set({ matchWinner: side, stats });
    } else {
      set({ matchWinner: null });
    }
  },

  setDeathmatchScore: (value) => {
    const stats = get().stats;
    if (value > stats.bestDeathmatchScore) {
      const next = { ...stats, bestDeathmatchScore: value };
      save(STORAGE_KEYS.stats, next);
      set({ deathmatchScore: value, stats: next });
    } else {
      set({ deathmatchScore: value });
    }
  },

  setEncounter: (value) => set({ encounter: value }),

  announce: (kind, text, duration = 1200, side) =>
    set((s) => ({
      announcements: [...s.announcements, { id: ++announcementId, kind, text, duration, side }],
    })),

  dismissAnnouncement: (id) =>
    set((s) => ({ announcements: s.announcements.filter((a) => a.id !== id) })),

  clearAnnouncements: () => set({ announcements: [] }),

  toggleSetting: (key) => {
    const settings = { ...get().settings, [key]: !get().settings[key] };
    save(STORAGE_KEYS.settings, settings);
    set({ settings });
  },

  markAudioUnlocked: () => set({ audioUnlocked: true }),

  setLoadProgress: (value) => set({ loadProgress: value }),

  resetMatchState: () =>
    set({
      scores: { left: 0, right: 0 },
      health: { left: 100, right: 100 },
      deathmatchScore: 0,
      encounter: 0,
      lastRound: null,
      matchWinner: null,
      announcements: [],
    }),
}));

export const MATCH_TARGET = MATCH.targetScore;
