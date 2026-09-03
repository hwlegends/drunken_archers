import { FX } from '../config/constants';
import type { AmbientParticleSpec, Vec2 } from '../types';
import { VIEW } from '../config/constants';

interface Particle {
  active: boolean;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
  gravity: number;
  /** Ambient particles wrap around the viewport instead of dying. */
  ambient: boolean;
  drift: number;
}

/**
 * A fixed-size particle pool shared by impact effects and arena ambience.
 * Nothing is allocated per hit — the pool is filled once and recycled.
 */
export class ParticleSystem {
  private pool: Particle[] = [];
  private cursor = 0;
  private ambientCount = 0;

  constructor() {
    for (let i = 0; i < FX.particlePoolSize; i++) {
      this.pool.push({
        active: false,
        x: 0,
        y: 0,
        vx: 0,
        vy: 0,
        life: 0,
        maxLife: 1,
        size: 2,
        color: '#fff',
        gravity: FX.gravity,
        ambient: false,
        drift: 0,
      });
    }
  }

  private take(): Particle {
    // Ambient particles occupy the head of the pool and are never evicted.
    for (let i = 0; i < this.pool.length - this.ambientCount; i++) {
      const index = (this.cursor + i) % (this.pool.length - this.ambientCount);
      const p = this.pool[this.ambientCount + index];
      if (!p.active) {
        this.cursor = (index + 1) % (this.pool.length - this.ambientCount);
        return p;
      }
    }
    // All busy: steal the oldest.
    const p = this.pool[this.ambientCount + this.cursor];
    this.cursor = (this.cursor + 1) % (this.pool.length - this.ambientCount);
    return p;
  }

  /** Blood spray, or a neutral dust puff when the reduced-blood setting is on. */
  impact(at: Vec2, direction: number, reducedBlood: boolean): void {
    const count = reducedBlood ? FX.dustParticles : FX.bloodParticles;
    for (let i = 0; i < count; i++) {
      const p = this.take();
      const spread = (Math.random() - 0.5) * 1.9;
      const speed = 90 + Math.random() * (reducedBlood ? 150 : 260);
      p.active = true;
      p.ambient = false;
      p.x = at.x;
      p.y = at.y;
      p.vx = Math.cos(direction + spread) * speed;
      p.vy = Math.sin(direction + spread) * speed - 60;
      p.maxLife = FX.particleLife * (0.5 + Math.random() * 0.8);
      p.life = p.maxLife;
      p.size = reducedBlood ? 2 + Math.random() * 3.5 : 1.8 + Math.random() * 3.2;
      p.gravity = reducedBlood ? FX.gravity * 0.35 : FX.gravity;
      p.color = reducedBlood
        ? 'rgba(226,214,196,' + (0.5 + Math.random() * 0.4).toFixed(2) + ')'
        : 'rgba(' + (168 + Math.floor(Math.random() * 50)) + ',26,34,0.92)';
    }
  }

  /** Dust kicked up where an arrow bites into terrain. */
  terrainPuff(at: Vec2, color: string): void {
    for (let i = 0; i < 7; i++) {
      const p = this.take();
      p.active = true;
      p.ambient = false;
      p.x = at.x;
      p.y = at.y;
      p.vx = (Math.random() - 0.5) * 120;
      p.vy = -Math.random() * 130;
      p.maxLife = FX.particleLife * 0.7;
      p.life = p.maxLife;
      p.size = 2 + Math.random() * 3;
      p.gravity = FX.gravity * 0.5;
      p.color = color;
    }
  }

  /** Seeds the drifting ambience for an arena. Replaces any previous set. */
  setAmbient(spec: AmbientParticleSpec): void {
    for (const p of this.pool) {
      if (p.ambient) p.active = false;
      p.ambient = false;
    }
    this.ambientCount = 0;
    if (spec.kind === 'none' || spec.count <= 0) return;

    const count = Math.min(spec.count, Math.floor(this.pool.length * 0.4));
    for (let i = 0; i < count; i++) {
      const p = this.pool[i];
      p.active = true;
      p.ambient = true;
      p.x = Math.random() * VIEW.width;
      p.y = Math.random() * VIEW.height;
      p.vx = spec.drift.x * (0.5 + Math.random());
      p.vy = spec.drift.y * (0.5 + Math.random());
      p.life = 1;
      p.maxLife = 1;
      p.size = spec.kind === 'leaf' ? 3 + Math.random() * 4 : 1.5 + Math.random() * 2.5;
      p.gravity = 0;
      p.color = spec.color;
      p.drift = Math.random() * Math.PI * 2;
    }
    this.ambientCount = count;
  }

  update(dtSeconds: number): void {
    for (const p of this.pool) {
      if (!p.active) continue;

      if (p.ambient) {
        p.drift += dtSeconds * 1.4;
        p.x += (p.vx + Math.sin(p.drift) * 14) * dtSeconds;
        p.y += (p.vy + Math.cos(p.drift * 0.7) * 8) * dtSeconds;
        // Wrap around the logical viewport with a margin.
        if (p.x < -40) p.x = VIEW.width + 40;
        if (p.x > VIEW.width + 40) p.x = -40;
        if (p.y < -40) p.y = VIEW.height + 40;
        if (p.y > VIEW.height + 40) p.y = -40;
        continue;
      }

      p.life -= dtSeconds * 1000;
      if (p.life <= 0) {
        p.active = false;
        continue;
      }
      p.vy += p.gravity * dtSeconds;
      p.x += p.vx * dtSeconds;
      p.y += p.vy * dtSeconds;
      p.vx *= 1 - 1.1 * dtSeconds;
    }
  }

  render(ctx: CanvasRenderingContext2D): void {
    for (const p of this.pool) {
      if (!p.active) continue;
      const alpha = p.ambient ? 1 : Math.min(1, p.life / (p.maxLife * 0.5));
      ctx.globalAlpha = alpha;
      ctx.fillStyle = p.color;
      if (p.ambient && p.size > 3) {
        // Leaves read better as small rotated blades.
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.drift);
        ctx.beginPath();
        ctx.ellipse(0, 0, p.size, p.size * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  /** Clears impact particles but leaves the arena ambience running. */
  clearTransient(): void {
    for (const p of this.pool) {
      if (!p.ambient) p.active = false;
    }
  }

  clear(): void {
    for (const p of this.pool) {
      p.active = false;
      p.ambient = false;
    }
    this.ambientCount = 0;
  }
}
