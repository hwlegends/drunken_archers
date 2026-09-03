import { CAMERA, VIEW } from '../config/constants';
import type { ArenaConfig, Vec2 } from '../types';

/**
 * Frames the duel. The camera stays close to the arena centre and only drifts
 * enough to keep both fighters comfortably in shot, plus a decaying shake on
 * impacts. Kept intentionally gentle — an aggressive camera makes timing the
 * wobble much harder to read.
 */
export class CameraController {
  x = VIEW.width / 2;
  y = VIEW.height / 2;
  zoom = 1;

  private targetX = VIEW.width / 2;
  private targetY = VIEW.height / 2;
  private targetZoom = 1;
  private shake = 0;
  private shakeX = 0;
  private shakeY = 0;

  setArena(arena: ArenaConfig): void {
    this.targetX = arena.camera.center.x;
    this.targetY = arena.camera.center.y;
    this.targetZoom = arena.camera.zoom;
    this.x = this.targetX;
    this.y = this.targetY;
    this.zoom = this.targetZoom;
    this.shake = 0;
  }

  /** Aims at the midpoint of the two fighters, damped toward the arena centre. */
  follow(left: Vec2, right: Vec2, arena: ArenaConfig): void {
    const midX = (left.x + right.x) / 2;
    const midY = (left.y + right.y) / 2;
    // Blend heavily toward the configured centre so the frame stays stable.
    this.targetX = arena.camera.center.x * 0.75 + midX * 0.25;
    this.targetY = arena.camera.center.y * 0.8 + midY * 0.2;
  }

  addShake(amount: number): void {
    this.shake = Math.min(CAMERA.maxShake, this.shake + amount);
  }

  update(dtSeconds: number): void {
    const t = 1 - Math.exp(-CAMERA.followLerp * dtSeconds);
    this.x += (this.targetX - this.x) * t;
    this.y += (this.targetY - this.y) * t;

    const tz = 1 - Math.exp(-CAMERA.zoomLerp * dtSeconds);
    this.zoom += (this.targetZoom - this.zoom) * tz;

    if (this.shake > 0.05) {
      this.shakeX = (Math.random() * 2 - 1) * this.shake;
      this.shakeY = (Math.random() * 2 - 1) * this.shake;
      this.shake *= Math.exp(-CAMERA.shakeDecay * dtSeconds);
    } else {
      this.shake = 0;
      this.shakeX = 0;
      this.shakeY = 0;
    }
  }

  /** Applies the camera transform to a context already scaled to logical units. */
  apply(ctx: CanvasRenderingContext2D): void {
    ctx.translate(VIEW.width / 2, VIEW.height / 2);
    ctx.scale(this.zoom, this.zoom);
    ctx.translate(-this.x + this.shakeX, -this.y + this.shakeY);
  }

  /** World point to logical screen point — used to place in-world HUD pieces. */
  worldToScreen(p: Vec2): Vec2 {
    return {
      x: (p.x - this.x + this.shakeX) * this.zoom + VIEW.width / 2,
      y: (p.y - this.y + this.shakeY) * this.zoom + VIEW.height / 2,
    };
  }

  reset(): void {
    this.shake = 0;
    this.shakeX = 0;
    this.shakeY = 0;
  }
}
