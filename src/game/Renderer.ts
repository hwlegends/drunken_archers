import Matter from 'matter-js';
import { BOW, COMBAT, PROJECTILE, RAGDOLL, SKINS, VIEW, type Skin } from '../config/constants';
import type { ArenaConfig, BowState, PlayerState, ProjectileState, RagdollHandle, Side, Vec2 } from '../types';
import { makeRng } from '../config/arenas';
import type { CameraController } from './CameraController';
import { getPartPlugin } from './RagdollFactory';
import type { ParticleSystem } from './ParticleSystem';

/**
 * Every pixel here is drawn from code — there are no image assets in the build.
 * The renderer reads directly from the physics bodies each frame, which is why
 * React never sees a body transform.
 */
export class Renderer {
  private skyCache: { key: string; gradient: CanvasGradient } | null = null;

  constructor(private readonly camera: CameraController) {}

  /* ---------------------------------------------------------------- *
   * Frame
   * ---------------------------------------------------------------- */

  render(
    ctx: CanvasRenderingContext2D,
    arena: ArenaConfig,
    ragdolls: Partial<Record<Side, RagdollHandle>>,
    bows: Partial<Record<Side, BowState>>,
    players: Record<Side, PlayerState>,
    projectiles: readonly ProjectileState[],
    particles: ParticleSystem,
    timeMs: number,
  ): void {
    ctx.save();
    this.drawSky(ctx, arena);

    ctx.save();
    this.camera.apply(ctx);

    this.drawParallax(ctx, arena, timeMs);
    this.drawPlatforms(ctx, arena, timeMs);

    for (const p of projectiles) {
      this.drawArrow(ctx, p, ragdolls[p.owner]?.skin ?? SKINS[p.owner]);
    }

    for (const side of ['left', 'right'] as Side[]) {
      const ragdoll = ragdolls[side];
      if (ragdoll) this.drawArcher(ctx, ragdoll, bows[side]);
    }

    particles.render(ctx);
    ctx.restore();

    // Health bars sit above each archer but are drawn screen-aligned, so they
    // never rotate or scale with the world.
    for (const side of ['left', 'right'] as Side[]) {
      const ragdoll = ragdolls[side];
      if (ragdoll && !ragdoll.dead) this.drawHealthBar(ctx, ragdoll, players[side]);
    }

    for (const side of ['left', 'right'] as Side[]) {
      const bow = bows[side];
      const ragdoll = ragdolls[side];
      if (bow && ragdoll && !ragdoll.dead && bow.phase === 'drawing') {
        this.drawChargeMeter(ctx, ragdoll, bow);
      }
    }

    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Backdrop
   * ---------------------------------------------------------------- */

  private drawSky(ctx: CanvasRenderingContext2D, arena: ArenaConfig): void {
    const key = arena.sky.join('|');
    if (!this.skyCache || this.skyCache.key !== key) {
      const gradient = ctx.createLinearGradient(0, 0, 0, VIEW.height);
      gradient.addColorStop(0, arena.sky[0]);
      gradient.addColorStop(1, arena.sky[1]);
      this.skyCache = { key, gradient };
    }
    ctx.fillStyle = this.skyCache.gradient;
    ctx.fillRect(0, 0, VIEW.width, VIEW.height);

    if (arena.sun) {
      const { x, y, radius, color } = arena.sun;
      const glow = ctx.createRadialGradient(x, y, 0, x, y, radius * 4.5);
      glow.addColorStop(0, color);
      glow.addColorStop(0.18, color);
      glow.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.globalAlpha = 0.85;
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, radius * 4.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  private drawParallax(ctx: CanvasRenderingContext2D, arena: ArenaConfig, timeMs: number): void {
    for (const layer of arena.layers) {
      // Depth 0 sticks to the camera, depth 1 moves fully with the world.
      const shift = (this.camera.x - VIEW.width / 2) * (1 - layer.depth) * -1;
      ctx.save();
      ctx.translate(shift, 0);
      ctx.fillStyle = layer.color;

      switch (layer.kind) {
        case 'dunes':
          this.drawDunes(ctx, layer.y, layer.depth);
          break;
        case 'skyline':
          this.drawSkyline(ctx, layer.y, layer.depth);
          break;
        case 'canopy':
          this.drawCanopy(ctx, layer.y, layer.depth, timeMs);
          break;
        case 'haze':
          ctx.fillRect(-400, layer.y, VIEW.width + 800, VIEW.height - layer.y + 300);
          break;
      }
      ctx.restore();
    }
  }

  private drawDunes(ctx: CanvasRenderingContext2D, baseY: number, depth: number): void {
    const rng = makeRng(Math.floor(depth * 1000) + 7);
    ctx.beginPath();
    ctx.moveTo(-400, VIEW.height + 300);
    ctx.lineTo(-400, baseY);
    for (let x = -400; x <= VIEW.width + 400; x += 90) {
      const h = baseY - 26 - rng() * 62;
      ctx.quadraticCurveTo(x + 45, h, x + 90, baseY - 10 - rng() * 30);
    }
    ctx.lineTo(VIEW.width + 400, VIEW.height + 300);
    ctx.closePath();
    ctx.fill();
  }

  private drawSkyline(ctx: CanvasRenderingContext2D, baseY: number, depth: number): void {
    const rng = makeRng(Math.floor(depth * 1000) + 31);
    let x = -400;
    ctx.beginPath();
    ctx.moveTo(-400, VIEW.height + 300);
    while (x < VIEW.width + 400) {
      const w = 48 + rng() * 80;
      const h = 60 + rng() * 190;
      ctx.lineTo(x, baseY - h);
      ctx.lineTo(x + w, baseY - h);
      x += w;
    }
    ctx.lineTo(VIEW.width + 400, VIEW.height + 300);
    ctx.closePath();
    ctx.fill();

    // Scattered lit windows.
    const wr = makeRng(Math.floor(depth * 1000) + 91);
    ctx.fillStyle = 'rgba(255,214,140,0.42)';
    for (let i = 0; i < 90; i++) {
      const wx = -400 + wr() * (VIEW.width + 800);
      const wy = baseY - 20 - wr() * 180;
      if (wr() > 0.55) ctx.fillRect(wx, wy, 4, 6);
    }
  }

  private drawCanopy(ctx: CanvasRenderingContext2D, baseY: number, depth: number, timeMs: number): void {
    const rng = makeRng(Math.floor(depth * 1000) + 53);
    const sway = Math.sin(timeMs / 2200) * 6 * (1 - depth);
    for (let i = 0; i < 16; i++) {
      const x = -300 + rng() * (VIEW.width + 600);
      const y = baseY + rng() * 90;
      const r = 60 + rng() * 90;
      ctx.beginPath();
      ctx.ellipse(x + sway, y, r, r * 0.5, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* ---------------------------------------------------------------- *
   * Platforms — one silhouette per theme
   * ---------------------------------------------------------------- */

  private drawPlatforms(ctx: CanvasRenderingContext2D, arena: ArenaConfig, timeMs: number): void {
    for (const key of ['left', 'right'] as const) {
      const p = arena.platforms[key];
      const bottom = VIEW.height + 200;
      switch (arena.id) {
        case 'desert':
          this.drawRockPillar(ctx, arena, p.x, p.topY, p.width, bottom, p.seed);
          break;
        case 'city':
          this.drawRooftop(ctx, arena, p.x, p.topY, p.width, bottom, p.seed);
          break;
        case 'jungle':
          this.drawPalm(ctx, arena, p.x, p.topY, p.width, bottom, p.seed, timeMs);
          break;
      }
    }
  }

  private drawRockPillar(
    ctx: CanvasRenderingContext2D,
    arena: ArenaConfig,
    x: number,
    topY: number,
    width: number,
    bottom: number,
    seed: number,
  ): void {
    const rng = makeRng(seed || 1);
    const [light, dark] = arena.platformColors;
    const halfTop = width / 2;

    // Stacked, slightly offset slabs give the eroded-spire silhouette.
    let y = topY;
    let half = halfTop;
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(x - half, y);
    while (y < bottom) {
      const stepH = 34 + rng() * 30;
      const nextHalf = half * (0.9 + rng() * 0.26);
      ctx.lineTo(x - half, y + stepH);
      ctx.lineTo(x - nextHalf, y + stepH);
      y += stepH;
      half = Math.max(20, Math.min(halfTop * 1.25, nextHalf));
    }
    ctx.lineTo(x - half, bottom);
    ctx.lineTo(x + half, bottom);

    const rng2 = makeRng(seed || 1);
    y = topY;
    half = halfTop;
    const rightPoints: Vec2[] = [];
    while (y < bottom) {
      const stepH = 34 + rng2() * 30;
      const nextHalf = half * (0.9 + rng2() * 0.26);
      rightPoints.push({ x: x + half, y: y + stepH });
      rightPoints.push({ x: x + nextHalf, y: y + stepH });
      y += stepH;
      half = Math.max(20, Math.min(halfTop * 1.25, nextHalf));
    }
    for (let i = rightPoints.length - 1; i >= 0; i--) ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
    ctx.lineTo(x + halfTop, topY);
    ctx.closePath();
    ctx.fill();

    // Lit cap.
    ctx.fillStyle = light;
    this.roundedRect(ctx, x - halfTop, topY - 4, width, 22, 8);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    this.roundedRect(ctx, x - halfTop + 6, topY - 2, width - 12, 7, 4);
    ctx.fill();
  }

  private drawRooftop(
    ctx: CanvasRenderingContext2D,
    arena: ArenaConfig,
    x: number,
    topY: number,
    width: number,
    bottom: number,
    seed: number,
  ): void {
    const rng = makeRng(seed || 1);
    const [light, dark] = arena.platformColors;
    const half = width / 2;

    ctx.fillStyle = dark;
    ctx.fillRect(x - half, topY, width, bottom - topY);

    // Window grid.
    ctx.fillStyle = 'rgba(255,208,140,0.35)';
    for (let wy = topY + 34; wy < VIEW.height + 40; wy += 30) {
      for (let wx = x - half + 14; wx < x + half - 12; wx += 26) {
        if (rng() > 0.42) ctx.fillRect(wx, wy, 12, 15);
      }
    }

    // Parapet.
    ctx.fillStyle = light;
    ctx.fillRect(x - half - 6, topY - 8, width + 12, 20);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(x - half - 6, topY - 8, width + 12, 5);

    // A vent box for silhouette interest.
    ctx.fillStyle = dark;
    ctx.fillRect(x - half + 12, topY - 26, 26, 20);
  }

  private drawPalm(
    ctx: CanvasRenderingContext2D,
    arena: ArenaConfig,
    x: number,
    topY: number,
    width: number,
    bottom: number,
    seed: number,
    timeMs: number,
  ): void {
    const rng = makeRng(seed || 1);
    const [light, dark] = arena.platformColors;
    const sway = Math.sin(timeMs / 1800 + seed) * 3;

    // Trunk.
    const trunkW = Math.max(26, width * 0.24);
    ctx.fillStyle = '#a97142';
    ctx.beginPath();
    ctx.moveTo(x - trunkW / 2, topY + 10);
    ctx.quadraticCurveTo(x - trunkW / 2 + sway * 2, (topY + bottom) / 2, x - trunkW * 0.75, bottom);
    ctx.lineTo(x + trunkW * 0.75, bottom);
    ctx.quadraticCurveTo(x + trunkW / 2 + sway * 2, (topY + bottom) / 2, x + trunkW / 2, topY + 10);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = 'rgba(0,0,0,0.14)';
    for (let ty = topY + 30; ty < bottom; ty += 26) {
      ctx.fillRect(x - trunkW * 0.55, ty, trunkW * 1.1, 5);
    }

    // Fronds fan out below the standing surface.
    const half = width / 2;
    for (let i = 0; i < 9; i++) {
      const t = i / 8;
      const angle = -Math.PI * 0.92 + t * Math.PI * 0.84;
      const len = half * (1.15 + rng() * 0.5);
      ctx.save();
      ctx.translate(x, topY + 14);
      ctx.rotate(angle + Math.PI / 2 + sway * 0.01);
      ctx.fillStyle = i % 2 === 0 ? light : dark;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.quadraticCurveTo(len * 0.5, -22, len, 6);
      ctx.quadraticCurveTo(len * 0.5, 16, 0, 12);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }

    // The flat standing crown.
    ctx.fillStyle = light;
    this.roundedRect(ctx, x - half, topY - 2, width, 20, 10);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.2)';
    this.roundedRect(ctx, x - half + 8, topY, width - 16, 6, 3);
    ctx.fill();
  }

  /* ---------------------------------------------------------------- *
   * Archer
   * ---------------------------------------------------------------- */

  private drawArcher(ctx: CanvasRenderingContext2D, r: RagdollHandle, bow?: BowState): void {
    const skin = r.skin;
    const order = [
      'upperArmBack',
      'lowerArmBack',
      'upperLegBack',
      'lowerLegBack',
      'upperLegFront',
      'lowerLegFront',
      'torso',
      'upperArmFront',
      'lowerArmFront',
    ];

    ctx.save();
    ctx.globalAlpha = r.dead ? 0.92 : 1;

    // Ground shadow.
    ctx.globalAlpha *= 0.18;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    // The feet sit a leg-and-a-half below the torso centre, whatever the build.
    const groundY = RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h + RAGDOLL.torso.h / 2;
    ctx.ellipse(r.torso.position.x, r.torso.position.y + groundY, 28, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = r.dead ? 0.92 : 1;

    for (const name of order) {
      const body = r.parts[name];
      if (!body) continue;
      const plugin = getPartPlugin(body);
      const isCloth = name === 'torso' || name.startsWith('upperLeg') || name.startsWith('lowerLeg');
      const isBack = name.includes('Back');

      let fill: string;
      if (isCloth) fill = isBack ? skin.clothShade : skin.cloth;
      else fill = isBack ? skin.skinShade : skin.skin;

      this.drawLimb(ctx, body, plugin.w, plugin.h, fill);
    }

    this.drawBelt(ctx, r, skin);
    this.drawNeck(ctx, r, skin);
    this.drawHead(ctx, r, skin);
    this.drawBow(ctx, r, skin, bow);
    ctx.restore();
  }

  private drawLimb(
    ctx: CanvasRenderingContext2D,
    body: Matter.Body,
    w: number,
    h: number,
    fill: string,
  ): void {
    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    ctx.rotate(body.angle);
    ctx.fillStyle = fill;
    this.roundedRect(ctx, -w / 2, -h / 2, w, h, Math.min(w, h) * 0.45);
    ctx.fill();
    ctx.restore();
  }

  /** The sash at the waist, drawn across the lower torso. */
  private drawBelt(ctx: CanvasRenderingContext2D, r: RagdollHandle, skin: Skin): void {
    const torso = r.torso;
    ctx.save();
    ctx.translate(torso.position.x, torso.position.y);
    ctx.rotate(torso.angle);
    ctx.fillStyle = skin.accent;
    const w = RAGDOLL.torso.w * 1.04;
    this.roundedRect(ctx, -w / 2, RAGDOLL.torso.h * 0.22, w, RAGDOLL.torso.h * 0.15, 2.5);
    ctx.fill();
    ctx.restore();
  }

  /** Bridges the gap that holds the head clear of the raised bow arm. */
  private drawNeck(ctx: CanvasRenderingContext2D, r: RagdollHandle, skin: Skin): void {
    const torso = r.torso;
    const half = RAGDOLL.torso.h / 2;
    const cos = Math.cos(torso.angle);
    const sin = Math.sin(torso.angle);
    const base = {
      x: torso.position.x + half * sin,
      y: torso.position.y - half * cos,
    };

    ctx.save();
    ctx.strokeStyle = skin.skinShade;
    ctx.lineWidth = RAGDOLL.torso.w * 0.42;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(base.x, base.y);
    ctx.lineTo(r.head.position.x, r.head.position.y);
    ctx.stroke();
    ctx.restore();
  }

  private drawHead(ctx: CanvasRenderingContext2D, r: RagdollHandle, skin: Skin): void {
    const head = r.head;
    const rad = RAGDOLL.head.r;

    ctx.save();
    ctx.translate(head.position.x, head.position.y);
    ctx.rotate(head.angle);
    // Mirror in the head's own frame so everything below can be drawn as if the
    // archer faces right.
    ctx.scale(r.facing, 1);

    // Face.
    ctx.fillStyle = skin.face;
    ctx.beginPath();
    ctx.arc(0, 0, rad, 0, Math.PI * 2);
    ctx.fill();

    /**
     * Hair: a heavy cap over the crown that sweeps back into long spikes.
     *
     * Angles here are canvas angles with the archer facing +X, so 0 is forward,
     * -PI/2 is straight up and -PI is behind. The fan is deliberately bounded to
     * the crown and the back — running it any further round wraps the spikes
     * across the face and the head reads as a spiky ball with no features.
     */
    const FRONT = -Math.PI * 0.32;
    const BACK = -Math.PI * 1.16;

    ctx.fillStyle = skin.hair;
    ctx.beginPath();
    ctx.arc(-rad * 0.12, -rad * 0.12, rad * 1.04, BACK, FRONT);
    ctx.closePath();
    ctx.fill();

    const spikes = 8;
    ctx.beginPath();
    for (let i = 0; i < spikes; i++) {
      const t = i / (spikes - 1);
      const a = FRONT + (BACK - FRONT) * t;
      // Spikes lengthen toward the back, with shorter ones alternating between.
      const reach = rad * (1.2 + t * 1.25 + (i % 2 === 0 ? 0.28 : 0));
      const spread = 0.19;
      ctx.moveTo(Math.cos(a - spread) * rad * 0.92, Math.sin(a - spread) * rad * 0.92);
      ctx.lineTo(Math.cos(a) * reach, Math.sin(a) * reach);
      ctx.lineTo(Math.cos(a + spread) * rad * 0.92, Math.sin(a + spread) * rad * 0.92);
    }
    ctx.fill();

    // A single eye reads clearly at this size.
    ctx.fillStyle = '#12203a';
    if (r.dead) {
      ctx.strokeStyle = '#12203a';
      ctx.lineWidth = 2.2;
      const ex = rad * 0.38;
      ctx.beginPath();
      ctx.moveTo(ex - 3.5, -3.5);
      ctx.lineTo(ex + 3.5, 3.5);
      ctx.moveTo(ex + 3.5, -3.5);
      ctx.lineTo(ex - 3.5, 3.5);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.ellipse(rad * 0.38, 0.5, 2.4, 3.6, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  /** The bow, its string, and the nocked arrow with a visible draw. */
  private drawBow(
    ctx: CanvasRenderingContext2D,
    r: RagdollHandle,
    skin: Skin,
    bow?: BowState,
  ): void {
    const body = r.bow;
    const charge = bow?.phase === 'drawing' ? bow.charge : 0;
    const pull = charge * BOW.maxStringPull;
    const limb = BOW.limbLength;

    ctx.save();
    ctx.translate(body.position.x, body.position.y);
    // The bow's local +X is the shot direction.
    ctx.rotate(body.angle);

    // Limbs — a C flexing away from the archer as the draw deepens.
    const flex = 1 + charge * 0.28;
    ctx.strokeStyle = skin.bow;
    ctx.lineWidth = 5.4;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(-2, -limb);
    ctx.quadraticCurveTo(9 * flex, -limb * 0.5, 10 * flex, 0);
    ctx.quadraticCurveTo(9 * flex, limb * 0.5, -2, limb);
    ctx.stroke();

    // Grip.
    ctx.strokeStyle = skin.accent;
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(9.4 * flex, -7);
    ctx.lineTo(9.4 * flex, 7);
    ctx.stroke();

    // String, pulled back toward the draw hand.
    const nockX = -2 - pull;
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.moveTo(-2, -limb);
    ctx.lineTo(nockX, 0);
    ctx.lineTo(-2, limb);
    ctx.stroke();

    // The nocked arrow, only while loaded.
    if (bow && bow.phase !== 'reloading' && !r.dead) {
      this.drawArrowShape(ctx, nockX, 0, PROJECTILE.length, skin.accent);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Projectiles
   * ---------------------------------------------------------------- */

  private drawArrow(ctx: CanvasRenderingContext2D, p: ProjectileState, skin: Skin): void {
    ctx.save();
    ctx.translate(p.body.position.x, p.body.position.y);
    ctx.rotate(p.body.angle);
    this.drawArrowShape(ctx, -PROJECTILE.length / 2, 0, PROJECTILE.length, skin.accent);
    ctx.restore();
  }

  /** Draws an arrow whose tail sits at (x, y) pointing along +X. */
  private drawArrowShape(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    length: number,
    fletchColor: string,
  ): void {
    ctx.save();
    ctx.translate(x, y);

    ctx.strokeStyle = '#c9a06a';
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(length, 0);
    ctx.stroke();

    // Head and fletching are proportional to the shaft, so an arrow of any
    // length keeps its silhouette.
    const tip = length * 0.2;
    const barb = length * 0.11;

    ctx.fillStyle = '#dfe6ee';
    ctx.beginPath();
    ctx.moveTo(length + tip * 0.85, 0);
    ctx.lineTo(length - tip * 0.35, -barb);
    ctx.lineTo(length - tip * 0.35, barb);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = fletchColor;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(tip * 1.3, -barb * 1.3);
    ctx.lineTo(tip * 0.85, 0);
    ctx.lineTo(tip * 1.3, barb * 1.3);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * In-world HUD
   * ---------------------------------------------------------------- */

  private drawHealthBar(ctx: CanvasRenderingContext2D, r: RagdollHandle, player: PlayerState): void {
    const anchor = this.camera.worldToScreen({
      x: r.torso.position.x,
      y: r.head.position.y - (RAGDOLL.head.r * 2 + 22),
    });

    const w = 104;
    const h = 13;
    const x = Math.max(8, Math.min(VIEW.width - w - 8, anchor.x - w / 2));
    const y = Math.max(46, anchor.y);
    const ratio = Math.max(0, Math.min(1, player.health / COMBAT.maxHealth));

    ctx.save();
    ctx.fillStyle = 'rgba(8,14,26,0.62)';
    this.roundedRect(ctx, x - 2, y - 2, w + 4, h + 4, 7);
    ctx.fill();

    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    this.roundedRect(ctx, x, y, w, h, 5);
    ctx.fill();

    // Green through amber to red as the fighter is worn down.
    const hue = 120 * ratio;
    ctx.fillStyle = 'hsl(' + hue.toFixed(0) + ', 78%, 48%)';
    if (ratio > 0.02) {
      this.roundedRect(ctx, x, y, Math.max(6, w * ratio), h, 5);
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    this.roundedRect(ctx, x + 2, y + 2, Math.max(2, w * ratio - 4), 3.5, 2);
    ctx.fill();
    ctx.restore();
  }

  /** A charge ring under the drawing archer, the only shot feedback given. */
  private drawChargeMeter(ctx: CanvasRenderingContext2D, r: RagdollHandle, bow: BowState): void {
    const anchor = this.camera.worldToScreen({
      x: r.torso.position.x,
      y: r.torso.position.y + RAGDOLL.upperLeg.h + RAGDOLL.lowerLeg.h + RAGDOLL.torso.h / 2 + 14,
    });
    const w = 72;
    const h = 8;
    const x = anchor.x - w / 2;
    const y = anchor.y;

    ctx.save();
    ctx.fillStyle = 'rgba(8,14,26,0.55)';
    this.roundedRect(ctx, x - 2, y - 2, w + 4, h + 4, 5);
    ctx.fill();
    ctx.fillStyle = r.skin.hud;
    this.roundedRect(ctx, x, y, Math.max(3, w * bow.charge), h, 4);
    ctx.fill();
    if (bow.charge >= 0.999) {
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 1.5;
      this.roundedRect(ctx, x - 2, y - 2, w + 4, h + 4, 5);
      ctx.stroke();
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------------- *
   * Utilities
   * ---------------------------------------------------------------- */

  private roundedRect(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    w: number,
    h: number,
    r: number,
  ): void {
    const radius = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + radius, y);
    ctx.arcTo(x + w, y, x + w, y + h, radius);
    ctx.arcTo(x + w, y + h, x, y + h, radius);
    ctx.arcTo(x, y + h, x, y, radius);
    ctx.arcTo(x, y, x + w, y, radius);
    ctx.closePath();
  }
}
