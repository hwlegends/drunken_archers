/**
 * All audio is synthesised at runtime with the Web Audio API — there are no
 * sampled assets in the build, so everything here is original by construction.
 * Music and effects have independent gain buses so each toggle is real muting
 * rather than a skipped playback call.
 */

export type SfxName =
  | 'bowDraw'
  | 'bowRelease'
  | 'arrowFlight'
  | 'impact'
  | 'headshot'
  | 'reaction'
  | 'point'
  | 'victory'
  | 'defeat'
  | 'uiClick';

export class AudioManager {
  private ctx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;

  private musicTimer: number | null = null;
  private musicStep = 0;
  private drawSource: { osc: OscillatorNode; gain: GainNode; filter: BiquadFilterNode } | null = null;

  private musicEnabled = true;
  private sfxEnabled = true;
  private unlocked = false;
  private musicWanted = false;

  /** Must be called from a real user gesture to satisfy autoplay policy. */
  async unlock(): Promise<boolean> {
    if (this.unlocked && this.ctx?.state === 'running') return true;
    try {
      if (!this.ctx) {
        const Ctor: typeof AudioContext =
          window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
        if (!Ctor) return false;
        this.ctx = new Ctor();

        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 0.9;
        this.masterGain.connect(this.ctx.destination);

        this.musicGain = this.ctx.createGain();
        this.musicGain.gain.value = this.musicEnabled ? 0.16 : 0;
        this.musicGain.connect(this.masterGain);

        this.sfxGain = this.ctx.createGain();
        this.sfxGain.gain.value = this.sfxEnabled ? 0.65 : 0;
        this.sfxGain.connect(this.masterGain);
      }
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      this.unlocked = this.ctx.state === 'running';
      if (this.unlocked && this.musicWanted) this.startMusic();
      return this.unlocked;
    } catch {
      return false;
    }
  }

  setMusicEnabled(enabled: boolean): void {
    this.musicEnabled = enabled;
    if (this.musicGain && this.ctx) {
      this.musicGain.gain.setTargetAtTime(enabled ? 0.16 : 0, this.ctx.currentTime, 0.1);
    }
    if (!enabled) this.stopMusic();
    else if (this.musicWanted) this.startMusic();
  }

  setSfxEnabled(enabled: boolean): void {
    this.sfxEnabled = enabled;
    if (this.sfxGain && this.ctx) {
      this.sfxGain.gain.setTargetAtTime(enabled ? 0.65 : 0, this.ctx.currentTime, 0.05);
    }
    if (!enabled) this.stopDraw();
  }

  /* ---------------------------------------------------------------- *
   * Effects
   * ---------------------------------------------------------------- */

  play(name: SfxName): void {
    if (!this.ready()) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime;

    switch (name) {
      case 'bowRelease':
        this.stopDraw();
        this.noiseBurst(t, 0.09, 2400, 0.5);
        this.tone(t, 'triangle', 220, 90, 0.16, 0.09);
        break;
      case 'arrowFlight':
        this.noiseBurst(t, 0.26, 1500, 0.12, 3200);
        break;
      case 'impact':
        this.tone(t, 'sine', 150, 55, 0.3, 0.14);
        this.noiseBurst(t, 0.08, 900, 0.28);
        break;
      case 'headshot':
        this.noiseBurst(t, 0.14, 700, 0.5);
        this.tone(t, 'sawtooth', 110, 42, 0.34, 0.22);
        this.tone(t + 0.1, 'square', 880, 1200, 0.12, 0.22);
        break;
      case 'reaction':
        this.tone(t, 'sawtooth', 190 + Math.random() * 70, 120, 0.16, 0.2, 620);
        break;
      case 'point':
        this.tone(t, 'triangle', 660, 660, 0.14, 0.1);
        this.tone(t + 0.09, 'triangle', 990, 990, 0.14, 0.16);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(t + i * 0.12, 'triangle', f, f, 0.16, 0.3));
        break;
      case 'defeat':
        [392, 349, 294, 233].forEach((f, i) => this.tone(t + i * 0.15, 'sawtooth', f, f * 0.98, 0.14, 0.34, 900));
        break;
      case 'uiClick':
        this.tone(t, 'square', 520, 700, 0.07, 0.05);
        break;
      case 'bowDraw':
        this.startDraw();
        break;
    }
  }

  /** A continuous creak whose pitch rises with the draw. */
  startDraw(): void {
    if (!this.ready() || this.drawSource) return;
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    const filter = ctx.createBiquadFilter();

    osc.type = 'sawtooth';
    osc.frequency.value = 90;
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 6;
    gain.gain.value = 0;
    gain.gain.setTargetAtTime(0.12, ctx.currentTime, 0.08);

    osc.connect(filter).connect(gain).connect(this.sfxGain!);
    osc.start();
    this.drawSource = { osc, gain, filter };
  }

  /** Feeds live charge (0..1) into the draw sound. */
  setDrawCharge(charge: number): void {
    if (!this.drawSource || !this.ctx) return;
    const t = this.ctx.currentTime;
    this.drawSource.osc.frequency.setTargetAtTime(90 + charge * 130, t, 0.06);
    this.drawSource.filter.frequency.setTargetAtTime(420 + charge * 900, t, 0.06);
  }

  stopDraw(): void {
    const source = this.drawSource;
    if (!source || !this.ctx) return;
    this.drawSource = null;
    const t = this.ctx.currentTime;
    source.gain.gain.cancelScheduledValues(t);
    source.gain.gain.setTargetAtTime(0, t, 0.03);
    source.osc.stop(t + 0.2);
    source.osc.onended = () => {
      source.osc.disconnect();
      source.gain.disconnect();
      source.filter.disconnect();
    };
  }

  /* ---------------------------------------------------------------- *
   * Music
   * ---------------------------------------------------------------- */

  /** A slow, slightly detuned loop that suits an unsteady duel. */
  startMusic(): void {
    this.musicWanted = true;
    if (!this.ready() || !this.musicEnabled || this.musicTimer !== null) return;

    const bass = [55, 55, 73.42, 65.41];
    const lead = [220, 261.63, 329.63, 293.66, 246.94, 329.63, 392, 293.66];

    const tick = () => {
      if (!this.ctx || !this.musicEnabled) return;
      const t = this.ctx.currentTime + 0.02;
      const step = this.musicStep++;

      if (step % 2 === 0) {
        this.tone(t, 'triangle', bass[(step / 2) % bass.length], bass[(step / 2) % bass.length], 0.7, 0.5, 400, this.musicGain!);
      }
      const note = lead[step % lead.length];
      this.tone(t, 'sine', note, note, 0.42, 0.22, 2600, this.musicGain!);
      // A touch of detune so it never sounds mechanical.
      this.tone(t + 0.01, 'sine', note * 1.006, note * 1.006, 0.42, 0.12, 2600, this.musicGain!);
    };

    tick();
    this.musicTimer = window.setInterval(tick, 420);
  }

  stopMusic(): void {
    if (this.musicTimer !== null) {
      clearInterval(this.musicTimer);
      this.musicTimer = null;
    }
  }

  /** Music keeps its "wanted" flag so resuming restores it. */
  pauseMusic(): void {
    this.stopMusic();
  }

  resumeMusic(): void {
    if (this.musicWanted) this.startMusic();
  }

  disableMusicIntent(): void {
    this.musicWanted = false;
    this.stopMusic();
  }

  /* ---------------------------------------------------------------- *
   * Synthesis helpers
   * ---------------------------------------------------------------- */

  private ready(): boolean {
    return this.unlocked && !!this.ctx && this.ctx.state === 'running';
  }

  private tone(
    at: number,
    type: OscillatorType,
    fromHz: number,
    toHz: number,
    duration: number,
    peak: number,
    lowpass?: number,
    destination?: GainNode,
  ): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(fromHz, at);
    if (toHz !== fromHz) osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), at + duration);

    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(peak, at + Math.min(0.02, duration * 0.2));
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    let node: AudioNode = osc;
    if (lowpass) {
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = lowpass;
      node = osc.connect(filter);
    }
    node.connect(gain).connect(destination ?? this.sfxGain!);
    osc.start(at);
    osc.stop(at + duration + 0.05);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
  }

  private noiseBurst(at: number, duration: number, cutoff: number, peak: number, highpass?: number): void {
    const ctx = this.ctx!;
    const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

    let chain: AudioNode = source.connect(filter);
    if (highpass) {
      const hp = ctx.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = highpass;
      chain = chain.connect(hp);
    }
    chain.connect(gain).connect(this.sfxGain!);
    source.start(at);
    source.onended = () => {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    };
  }

  /** Releases every audio handle. Safe to call more than once. */
  destroy(): void {
    this.stopMusic();
    this.stopDraw();
    this.musicWanted = false;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.masterGain = null;
    this.musicGain = null;
    this.sfxGain = null;
    this.unlocked = false;
  }
}

export const audioManager = new AudioManager();
