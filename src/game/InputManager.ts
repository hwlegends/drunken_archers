import type { GameMode, Side } from '../types';

export interface InputHandlers {
  onPress: (side: Side) => void;
  onRelease: (side: Side) => void;
  /** One sidestep: -1 for left, +1 for right. Only when the option is on. */
  onStep: (side: Side, direction: -1 | 1) => void;
  onPauseToggle: () => void;
}

/**
 * Desktop key bindings from the specification, per mode.
 *
 * Online is absent on purpose: which archer the keys drive depends on whether
 * this computer hosts the match, so it resolves against `localSide` instead.
 */
const KEY_BINDINGS: Record<Exclude<GameMode, 'online'>, Record<string, Side>> = {
  onePlayer: { ArrowUp: 'left' },
  twoPlayers: { KeyW: 'left', ArrowUp: 'right' },
  deathmatch: { ArrowUp: 'left' },
};

/**
 * Online play only ever drives one archer from this keyboard, so every key a
 * local mode would use is accepted for it. Nobody should have to remember
 * whether the pairing handed them blue or orange.
 */
const ONLINE_KEYS = new Set(['ArrowUp', 'KeyW', 'Space']);

/**
 * Sidestep keys, when the option is on. They are kept clear of the draw keys so
 * that turning the option on cannot change how firing works.
 */
const STEP_BINDINGS: Record<Exclude<GameMode, 'online'>, Record<string, [Side, -1 | 1]>> = {
  onePlayer: { ArrowLeft: ['left', -1], ArrowRight: ['left', 1] },
  twoPlayers: {
    KeyA: ['left', -1],
    KeyD: ['left', 1],
    ArrowLeft: ['right', -1],
    ArrowRight: ['right', 1],
  },
  deathmatch: { ArrowLeft: ['left', -1], ArrowRight: ['left', 1] },
};

/** Online drives one archer, so either pair of keys steps it. */
const ONLINE_STEP_KEYS: Record<string, -1 | 1> = {
  ArrowLeft: -1,
  ArrowRight: 1,
  KeyA: -1,
  KeyD: 1,
};

const PAUSE_KEYS = new Set(['Escape', 'KeyP']);

/**
 * Translates keyboard, mouse and touch into charge/release calls. It also owns
 * input safety: auto-repeat is dropped, a side cannot start a second charge
 * while already drawing, and every held input is cleared on blur, page hide,
 * pause, or when gameplay ends.
 */
export class InputManager {
  private mode: GameMode = 'onePlayer';
  /** The archer this computer drives online. Ignored by the local modes. */
  private localSide: Side = 'left';
  private enabled = false;
  private surface: HTMLElement | null = null;

  /** Sides currently held down, and by which pointer id (or -1 for a key). */
  private held = new Map<Side, number>();
  private heldKeys = new Set<string>();

  constructor(private readonly handlers: InputHandlers) {}

  attach(surface: HTMLElement, mode: GameMode): void {
    this.detach();
    this.surface = surface;
    this.mode = mode;

    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('blur', this.onBlur);
    document.addEventListener('visibilitychange', this.onVisibility);

    surface.addEventListener('pointerdown', this.onPointerDown);
    surface.addEventListener('pointerup', this.onPointerUp);
    surface.addEventListener('pointercancel', this.onPointerUp);
    surface.addEventListener('pointerleave', this.onPointerUp);
    surface.addEventListener('contextmenu', this.preventDefault);
    // Stop the browser from scrolling, zooming or selecting inside the game.
    surface.addEventListener('touchstart', this.preventDefault, { passive: false });
    surface.addEventListener('touchmove', this.preventDefault, { passive: false });
    surface.addEventListener('dragstart', this.preventDefault);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('blur', this.onBlur);
    document.removeEventListener('visibilitychange', this.onVisibility);

    const surface = this.surface;
    if (surface) {
      surface.removeEventListener('pointerdown', this.onPointerDown);
      surface.removeEventListener('pointerup', this.onPointerUp);
      surface.removeEventListener('pointercancel', this.onPointerUp);
      surface.removeEventListener('pointerleave', this.onPointerUp);
      surface.removeEventListener('contextmenu', this.preventDefault);
      surface.removeEventListener('touchstart', this.preventDefault);
      surface.removeEventListener('touchmove', this.preventDefault);
      surface.removeEventListener('dragstart', this.preventDefault);
    }
    this.surface = null;
    this.held.clear();
    this.heldKeys.clear();
    this.enabled = false;
  }

  setMode(mode: GameMode): void {
    this.releaseAll();
    this.mode = mode;
  }

  /** Points every online input at one archer, whichever side it was given. */
  setLocalSide(side: Side): void {
    this.releaseAll();
    this.localSide = side;
  }

  /** The archer a key drives, or undefined if the key is unbound in this mode. */
  private sideForKey(code: string): Side | undefined {
    if (this.mode === 'online') return ONLINE_KEYS.has(code) ? this.localSide : undefined;
    return KEY_BINDINGS[this.mode][code];
  }

  /** The archer and direction a key steps, if it is a step key here. */
  private stepForKey(code: string): [Side, -1 | 1] | undefined {
    if (this.mode === 'online') {
      const direction = ONLINE_STEP_KEYS[code];
      return direction ? [this.localSide, direction] : undefined;
    }
    return STEP_BINDINGS[this.mode][code];
  }

  /** Gameplay-only gate. Disabling also drops anything currently held. */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    if (!enabled) this.releaseAll();
  }

  /** Safely releases every held input without firing a shot. */
  releaseAll(): void {
    for (const side of this.held.keys()) this.handlers.onRelease(side);
    this.held.clear();
    this.heldKeys.clear();
  }

  /* ---------------------------------------------------------------- *
   * Keyboard
   * ---------------------------------------------------------------- */

  private onKeyDown = (event: KeyboardEvent): void => {
    if (PAUSE_KEYS.has(event.code)) {
      event.preventDefault();
      this.handlers.onPauseToggle();
      return;
    }
    if (!this.enabled) return;
    // Ignore auto-repeat: a held key must not restart the draw every tick, and
    // a held step key must not walk the archer across the platform.
    if (event.repeat || this.heldKeys.has(event.code)) return;

    // A step is one discrete move per press, so it never enters `held`.
    const step = this.stepForKey(event.code);
    if (step) {
      event.preventDefault();
      this.handlers.onStep(step[0], step[1]);
      return;
    }

    const side = this.sideForKey(event.code);
    if (!side) return;
    event.preventDefault();

    this.heldKeys.add(event.code);
    this.press(side, -1);
  };

  private onKeyUp = (event: KeyboardEvent): void => {
    if (!this.heldKeys.delete(event.code)) return;
    const side = this.sideForKey(event.code);
    if (!side) return;
    event.preventDefault();
    this.release(side, -1);
  };

  /* ---------------------------------------------------------------- *
   * Pointer / touch
   * ---------------------------------------------------------------- */

  private onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled || !this.surface) return;
    // Ignore taps on the HUD buttons layered above the canvas.
    if ((event.target as HTMLElement)?.closest('[data-ui-control]')) return;

    event.preventDefault();
    const side = this.sideForPointer(event);
    try {
      this.surface.setPointerCapture(event.pointerId);
    } catch {
      /* capture is best-effort; input still works without it */
    }
    this.press(side, event.pointerId);
  };

  private onPointerUp = (event: PointerEvent): void => {
    for (const [side, pointerId] of this.held) {
      if (pointerId === event.pointerId) {
        this.release(side, event.pointerId);
        break;
      }
    }
    if (this.surface?.hasPointerCapture?.(event.pointerId)) {
      this.surface.releasePointerCapture(event.pointerId);
    }
  };

  /**
   * Solo and online modes charge from anywhere in the gameplay area — online
   * has only one archer on this screen. Two-player splits the surface down the
   * middle, and both halves accept a simultaneous touch.
   */
  private sideForPointer(event: PointerEvent): Side {
    if (this.mode === 'online') return this.localSide;
    if (this.mode !== 'twoPlayers') return 'left';
    const rect = this.surface!.getBoundingClientRect();
    return event.clientX - rect.left < rect.width / 2 ? 'left' : 'right';
  }

  /* ---------------------------------------------------------------- *
   * Shared
   * ---------------------------------------------------------------- */

  private press(side: Side, pointerId: number): void {
    // A side already charging cannot begin a second draw.
    if (this.held.has(side)) return;
    this.held.set(side, pointerId);
    this.handlers.onPress(side);
  }

  private release(side: Side, pointerId: number): void {
    const active = this.held.get(side);
    if (active === undefined || active !== pointerId) return;
    this.held.delete(side);
    this.handlers.onRelease(side);
  }

  private onBlur = (): void => {
    this.releaseAll();
  };

  private onVisibility = (): void => {
    if (document.hidden) this.releaseAll();
  };

  private preventDefault = (event: Event): void => {
    event.preventDefault();
  };
}
