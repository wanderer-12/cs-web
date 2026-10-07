// =============================================================================
// audio/AudioEngine.ts — the Web Audio graph, spatialisation and event wiring.
//
// Design notes that are not obvious from the code:
//
//   * The constructor NEVER touches `AudioContext`. Browsers refuse to start an
//     audio clock without a user gesture, and a suspended (`state === 'suspended'`)
//     context that is created too early is a common source of "no sound on the
//     first shot". So the context is built lazily in `resume()`, which the
//     pointer-lock click handler calls.
//   * Everything is guarded by `if (!this.ac) return;`. That is what lets this
//     module be imported (and unit-tested) under Node/vitest without a browser.
//   * Spatialisation is three stages per voice:
//       source -> lowpass(distance, air absorption) -> lowpass(occlusion)
//              -> panner(HRTF, inverse) -> bus
//     A PannerNode alone only changes *level*; real distant gunfire is muffled,
//     which is the low-pass job.
// =============================================================================

import type { EventBus } from '../core/events';
import { Rng } from '../core/rng';
import type { GameEventMap, SurfaceMaterial, Vec3, WeaponDef } from '../core/types';
import { SfxCache } from './sfx';
import {
  MAX_DISTANCE,
  REF_DISTANCE,
  ROLLOFF_FACTOR,
  airCutoff,
  occlusionCutoff,
  occlusionGain,
  renderAnnounce,
  renderBombBeep,
  renderBombExplode,
  renderBombPlant,
  renderBuy,
  renderDeathThud,
  renderDefuseTick,
  renderDraw,
  renderExplosion,
  renderFleshImpact,
  renderFlashbangPop,
  renderFlashRing,
  renderFootstep,
  renderGunshot,
  renderHeadshotDing,
  renderHitMarker,
  renderImpact,
  renderJump,
  renderKnifeWhoosh,
  renderLand,
  renderReload,
  renderRoundEnd,
  renderRoundStart,
  renderShellDrop,
  renderUIClick,
  renderWhizz,
} from './synth';
import type { BufferLike, ReloadStage } from './synth';

/** Mixer buses. `master` is the only one wired straight to the destination. */
export type AudioBus = 'master' | 'sfx' | 'footstep' | 'ui' | 'ambience';

/** Buses a flashbang is allowed to duck. UI stays intelligible on purpose. */
const DUCKED_BUSES: readonly AudioBus[] = ['sfx', 'footstep', 'ambience'];

const DEFAULT_VOLUMES: Readonly<Record<AudioBus, number>> = {
  master: 1,
  sfx: 1,
  footstep: 0.85,
  ui: 0.7,
  ambience: 0.8,
};

/** Tinnitus decay after a flashbang; also the duck recovery window. */
const FLASH_RING_SECONDS = 4;
/** What the ducked buses fall to while the player is deafened. */
const FLASH_DUCK_LEVEL = 0.3;

/**
 * Mirrors `DEFAULT_WHIZZ_RADIUS` in `combat/ballistics.ts`: the band around the
 * listener inside which a bullet is reported as a near miss. Used only to scale the
 * cue's volume against that band (there is no cross-layer import here on purpose —
 * audio should not have to run the ballistics maths to play a sound).
 */
const WHIZZ_RADIUS_UNITS = 64;

/** Options for one positional cue. */
export interface Play3DOptions {
  /** Per-cue gain (weapon `sound.gain`, footstep volume, ...). Default 1. */
  volume?: number;
  /** Playback-rate multiplier; also shifts pitch. Default 1. */
  rate?: number;
  /** Fine delay in seconds; used to stagger multi-stage cues. Default 0. */
  delay?: number;
  /** Overrides the bus the cue would normally use. */
  bus?: AudioBus;
}

/** Non-event cues the game triggers directly (bomb beeps, shell drops, ...). */
export type SfxCue =
  | 'hitmarker'
  | 'headshot'
  | 'shellDrop'
  | 'whizz'
  | 'roundStart'
  | 'roundEnd'
  | 'uiClick'
  | 'bombPlant'
  | 'defuseTick'
  | 'bombExplode';

/**
 * The mixer + synthesiser front end.
 *
 * `play3D` takes a pre-rendered buffer, so callers that care about a specific
 * cue (everything under `play*` below) go through `cue()`/`shotBuffer()` which
 * handle caching. `play3D` itself stays the generic primitive.
 */
export class AudioEngine {
  private readonly weaponLookup: (id: string) => WeaponDef | undefined;
  private readonly cache = new SfxCache(96, 4, 32);

  private ac: AudioContext | null = null;
  private busNodes: Record<AudioBus, GainNode> | null = null;
  /** Buses currently ducked by a flashbang (null = none). */
  private duckStart: number | null = null;
  private duckUntil = 0;
  private readonly volumes: Record<AudioBus, number> = { ...DEFAULT_VOLUMES };
  /** Master mute is tracked separately from the stored master volume so that
   *  unmuting restores the user's setting instead of a hard-coded 1. */
  private masterMuted = false;

  private actorPositionProvider: ((actorId: number) => Vec3 | null) | null = null;
  private occlusionTest: ((from: Vec3, to: Vec3) => number) | null = null;
  private localActorId = -1;
  private listenerPos: Vec3 = { x: 0, y: 0, z: 0 };

  /** Unsubscribe functions returned by `EventBus.on`, kept for `detach()`. */
  private readonly detachers: (() => void)[] = [];
  private attached: EventBus | null = null;

  /** Seed source for per-cue jitter; keeps a run reproducible for replays. */
  private cueSeed = 0x51ed270b;

  constructor(weaponLookup: (id: string) => WeaponDef | undefined) {
    this.weaponLookup = weaponLookup;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** True once `resume()` has successfully built the graph. */
  get ready(): boolean {
    return this.ac !== null;
  }

  /**
   * Lazily create and resume the AudioContext. Safe to call repeatedly (every
   * pointer-lock click does); resolves immediately when audio is unavailable so
   * callers never need a try/catch.
   */
  async resume(): Promise<void> {
    if (!this.ac) {
      const Ctor = typeof AudioContext === 'undefined' ? undefined : AudioContext;
      if (!Ctor) return;
      const ac = new Ctor();
      const master = ac.createGain();
      master.gain.value = this.effectiveGain('master');
      master.connect(ac.destination);
      const sfx = ac.createGain();
      sfx.gain.value = this.volumes.sfx;
      sfx.connect(master);
      const footstep = ac.createGain();
      footstep.gain.value = this.volumes.footstep;
      footstep.connect(master);
      const ui = ac.createGain();
      ui.gain.value = this.volumes.ui;
      ui.connect(master);
      const ambience = ac.createGain();
      ambience.gain.value = this.volumes.ambience;
      ambience.connect(master);
      this.busNodes = { master, sfx, footstep, ui, ambience };
      this.ac = ac;
    }
    if (this.ac.state === 'suspended') await this.ac.resume();
  }

  /** Tear the graph down: stop every voice, drop every buffer, free the clock. */
  dispose(): void {
    this.detach();
    this.cache.stopAllVoices();
    this.cache.clear();
    const ac = this.ac;
    this.ac = null;
    this.busNodes = null;
    this.duckStart = null;
    if (!ac) return;
    void ac.close().catch(() => {
      // Closing an already-closed context rejects; nothing left to clean up.
      return;
    });
  }

  // -------------------------------------------------------------------------
  // Mixer
  // -------------------------------------------------------------------------

  setVolume(bus: AudioBus, value: number): void {
    const v = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    this.volumes[bus] = v;
    const nodes = this.busNodes;
    const ac = this.ac;
    if (!nodes || !ac) return;
    const ducked = this.duckStart !== null && bus !== 'master' && bus !== 'ui';
    if (ducked) return; // the flash duck owns this bus until it finishes
    nodes[bus].gain.setTargetAtTime(this.effectiveGain(bus), ac.currentTime, 0.02);
  }

  getVolume(bus: AudioBus): number {
    return this.volumes[bus];
  }

  /**
   * Mute/unmute the whole mix. The per-bus volumes are kept, so unmuting
   * restores exactly what the player (or the game's localStorage) had set.
   */
  setMasterMuted(muted: boolean): void {
    this.masterMuted = muted;
    this.setVolume('master', this.volumes.master);
  }

  /** Stored volume with the master mute folded in; what the graph should use. */
  private effectiveGain(bus: AudioBus): number {
    return this.masterMuted ? 0 : this.volumes[bus];
  }

  // -------------------------------------------------------------------------
  // Listener + occlusion
  // -------------------------------------------------------------------------

  /**
   * Move the listener. Called once per rendered frame, so it must not allocate
   * per-call objects beyond the audio params it writes.
   *
   * `setTargetAtTime` smooths the per-frame updates; where those params do not
   * exist (Safari < 14.1) we fall back to the deprecated `setPosition` /
   * `setOrientation` vector API.
   */
  updateListener(pos: Vec3, forward: Vec3, up: Vec3): void {
    this.listenerPos = { x: pos.x, y: pos.y, z: pos.z };
    const ac = this.ac;
    if (!ac) return;
    const l = ac.listener;
    const t = ac.currentTime;
    const smooth = 0.02;
    // Feature-detect the AudioParam form rather than the browser: the params are
    // the modern (and only non-deprecated) API.
    const px = l.positionX as AudioParam | undefined;
    if (px && typeof l.forwardX?.setTargetAtTime === 'function') {
      px.setTargetAtTime(pos.x, t, smooth);
      l.positionY.setTargetAtTime(pos.y, t, smooth);
      l.positionZ.setTargetAtTime(pos.z, t, smooth);
      l.forwardX.setTargetAtTime(forward.x, t, smooth);
      l.forwardY.setTargetAtTime(forward.y, t, smooth);
      l.forwardZ.setTargetAtTime(forward.z, t, smooth);
      l.upX.setTargetAtTime(up.x, t, smooth);
      l.upY.setTargetAtTime(up.y, t, smooth);
      l.upZ.setTargetAtTime(up.z, t, smooth);
      return;
    }
    const legacy = l as unknown as {
      setPosition?(x: number, y: number, z: number): void;
      setOrientation?(fx: number, fy: number, fz: number, ux: number, uy: number, uz: number): void;
    };
    legacy.setPosition?.(pos.x, pos.y, pos.z);
    legacy.setOrientation?.(forward.x, forward.y, forward.z, up.x, up.y, up.z);
  }

  /**
   * Install the raycast-driven occlusion query. `fn(from, to)` must return 0..1
   * (1 = fully blocked). Typically implemented with a `world.trace()` against
   * brushes only, so it costs one ray per sounding voice per frame at most.
   */
  setOcclusionTest(fn: ((from: Vec3, to: Vec3) => number) | null): void {
    this.occlusionTest = fn;
  }

  /** Supplies a position for events that only carry actor ids. */
  setActorPositionProvider(fn: ((actorId: number) => Vec3 | null) | null): void {
    this.actorPositionProvider = fn;
  }

  /**
   * The local player's actor id. Footsteps are skipped for this actor (the game
   * mixes its own first-person steps) and `hit` only chirps when *this* actor
   * was the shooter.
   */
  setLocalActorId(id: number): void {
    this.localActorId = id;
  }

  // -------------------------------------------------------------------------
  // Playback primitives
  // -------------------------------------------------------------------------

  /**
   * Play a pre-rendered buffer through a positional voice.
   *
   * Returns a voice token (usable with `cache.updateVoice`/`releaseVoice`) or
   * -1 when there is no context yet — callers should not have to null-check.
   */
  play3D(buffer: BufferLike, position: Vec3, opts: Play3DOptions = {}): number {
    const ac = this.ac;
    const nodes = this.busNodes;
    if (!ac || !nodes) return -1;

    const bus = opts.bus ?? 'sfx';
    const volume = clamp01(opts.volume ?? 1);
    const distance = Math.hypot(
      position.x - this.listenerPos.x,
      position.y - this.listenerPos.y,
      position.z - this.listenerPos.z,
    );

    // Occlusion: the game's raycast tells us how much wall is in the way. We
    // apply it as an extra gain reduction AND a much stronger low-pass, because
    // a blocked shot is not just quieter — it is duller.
    let occlusion = 0;
    if (this.occlusionTest) {
      const raw = this.occlusionTest(position, this.listenerPos);
      occlusion = Number.isFinite(raw) ? clamp01(raw) : 0;
    }

    const startAt = ac.currentTime + Math.max(0, opts.delay ?? 0);

    const source = ac.createBufferSource();
    source.buffer = buffer as AudioBuffer;
    source.playbackRate.value = Number.isFinite(opts.rate) && (opts.rate ?? 0) > 0 ? (opts.rate as number) : 1;

    const air = ac.createBiquadFilter();
    air.type = 'lowpass';
    // Distance air absorption and wall occlusion both cut highs; cascading two
    // first-order-ish filters keeps each curve independently tunable.
    air.frequency.value = airCutoff(distance);
    air.Q.value = 0.7;

    const muffled = ac.createBiquadFilter();
    muffled.type = 'lowpass';
    muffled.frequency.value = occlusionCutoff(occlusion);
    muffled.Q.value = 0.5;

    const voiceGain = ac.createGain();
    voiceGain.gain.value = volume * occlusionGain(occlusion);

    const panner = ac.createPanner();
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = REF_DISTANCE;
    panner.maxDistance = MAX_DISTANCE;
    panner.rolloffFactor = ROLLOFF_FACTOR;
    panner.coneInnerAngle = 360;
    positionPanner(panner, position);

    source.connect(air);
    air.connect(muffled);
    muffled.connect(voiceGain);
    voiceGain.connect(panner);
    panner.connect(nodes[bus]);

    let token = -1;
    let stopped = false;
    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      try {
        source.stop();
      } catch {
        // stop() on an already-finished source throws InvalidStateError; the
        // node is garbage either way, so this is not an error worth surfacing.
      }
      try {
        source.disconnect();
        air.disconnect();
        muffled.disconnect();
        voiceGain.disconnect();
        panner.disconnect();
      } catch {
        // Disconnect on a node that was never connected is a no-op in Chrome
        // but throws in some engines; ignore.
      }
      this.cache.releaseVoice(token);
    };

    // The voice is registered with its real stop() already in place, so the cap
    // can cut this sound mid-flight without leaking any of the five nodes above.
    const handle = this.cache.registerVoice(volume * falloffApprox(distance) * occlusionGain(occlusion), stop);
    token = handle.token;

    source.onended = (): void => {
      stopped = true;
      this.cache.releaseVoice(token);
    };

    source.start(startAt);
    return token;
  }

  /**
   * Play a cue on a bus with no spatialisation (UI, announcer, tinnitus). UI
   * cues must not be panned: a buy-menu click coming from behind the player is
   * disorienting, not immersive.
   */
  private play2D(buffer: BufferLike, bus: AudioBus, volume = 1, rate = 1, delay = 0, node?: AudioNode): number {
    const ac = this.ac;
    const nodes = this.busNodes;
    if (!ac || !nodes) return -1;
    const target = node ?? nodes[bus];
    const source = ac.createBufferSource();
    source.buffer = buffer as AudioBuffer;
    source.playbackRate.value = rate > 0 ? rate : 1;
    const gain = ac.createGain();
    gain.gain.value = clamp01(volume);
    source.connect(gain);
    gain.connect(target);

    const token = this.cache.registerVoice(clamp01(volume), () => {
      try {
        source.stop();
      } catch {
        // See play3D.stop.
      }
      source.disconnect();
      gain.disconnect();
    }).token;
    source.onended = (): void => {
      this.cache.releaseVoice(token);
    };
    source.start(ac.currentTime + Math.max(0, delay));
    return token;
  }

  /** Render (or reuse) one variant of a cue and return it. */
  private variant(key: string, render: (ctx: AudioContext, rng: Rng) => BufferLike): BufferLike | null {
    const ac = this.ac;
    if (!ac) return null;
    const rng = new Rng(this.nextCueSeed());
    const variantIndex = this.cache.pickVariant(key, rng);
    return this.cache.get(key, variantIndex, () => render(ac, rng));
  }

  /** Deterministic-but-varied seed for one cue instance. */
  private nextCueSeed(): number {
    this.cueSeed = (Math.imul(this.cueSeed, 1664525) + 1013904223) >>> 0;
    return this.cueSeed;
  }

  // -------------------------------------------------------------------------
  // Cue helpers (also the public API the game calls outside the event bus)
  // -------------------------------------------------------------------------

  /** A gunshot from a real `WeaponDef`; `sound.body` etc. come from the table. */
  playShot(def: WeaponDef, position: Vec3, volume = 1): number {
    const buffer = this.variant(`shot:${def.id}`, (ac, rng) => renderGunshot(ac, def.sound, rng));
    if (!buffer) return -1;
    return this.play3D(buffer, position, { volume: clamp01(def.sound.gain) * volume, bus: 'sfx' });
  }

  /** One cue the game triggers directly (bomb beeps, shell drops, ...). */
  playCue(cue: SfxCue, position: Vec3 | null, opts: Play3DOptions = {}): number {
    const buffer = this.cueBuffer(cue);
    if (!buffer) return -1;
    if (position === null) return this.play2D(buffer, opts.bus ?? cueBus(cue), opts.volume ?? 1, opts.rate ?? 1, opts.delay ?? 0);
    return this.play3D(buffer, position, opts);
  }

  /** Variant renderer for the named non-event cue. */
  private cueBuffer(cue: SfxCue): BufferLike | null {
    switch (cue) {
      case 'hitmarker':
        return this.variant('cue:hitmarker', (ac) => renderHitMarker(ac));
      case 'headshot':
        return this.variant('cue:headshot', (ac) => renderHeadshotDing(ac));
      case 'shellDrop':
        return this.variant('cue:shell', (ac, rng) => renderShellDrop(ac, rng));
      case 'whizz':
        return this.variant('cue:whizz', (ac, rng) => renderWhizz(ac, rng));
      case 'roundStart':
        return this.variant('cue:roundstart', (ac) => renderRoundStart(ac));
      case 'roundEnd':
        return this.variant('cue:roundend', (ac) => renderRoundEnd(ac));
      case 'uiClick':
        return this.variant('cue:uiclick', (ac) => renderUIClick(ac));
      case 'bombPlant':
        return this.variant('cue:bombplant', (ac, rng) => renderBombPlant(ac, rng));
      case 'defuseTick':
        return this.variant('cue:defusetick', (ac, rng) => renderDefuseTick(ac, rng));
      case 'bombExplode':
        return this.variant('cue:bombexplode', (ac, rng) => renderBombExplode(ac, rng));
      default:
        return null;
    }
  }

  /**
   * C4 beeper. The game owns the cadence; it just asks for a pitch that rises as
   * the fuse burns down, so the beep gets more urgent without a second asset.
   */
  playBombBeep(position: Vec3 | null, pitch = 1200): number {
    const buffer = this.variant(`cue:beep:${Math.round(pitch)}`, (ac) => renderBombBeep(ac, pitch));
    if (!buffer) return -1;
    return position === null
      ? this.play2D(buffer, 'ui', 0.5)
      : this.play3D(buffer, position, { volume: 0.5, bus: 'sfx' });
  }

  // -------------------------------------------------------------------------
  // Event wiring
  // -------------------------------------------------------------------------

  /**
   * Subscribe every gameplay event audio cares about. Idempotent: attaching to a
   * second bus detaches from the first, and re-attaching to the same bus is a
   * no-op so a resize/re-init cannot double up the handlers.
   */
  attach(bus: EventBus): void {
    if (this.attached === bus) return;
    this.detach();
    this.attached = bus;
    const on = <K extends keyof GameEventMap>(name: K, fn: (e: GameEventMap[K]) => void): void => {
      this.detachers.push(bus.on(name, fn));
    };
    on('shot', (e) => this.onShot(e));
    on('hit', (e) => this.onHit(e));
    on('impact', (e) => this.onImpact(e));
    on('whizz', (e) => this.onWhizz(e));
    on('footstep', (e) => this.onFootstep(e));
    on('reload', (e) => this.onReload(e));
    on('draw', (e) => this.onDraw(e));
    on('jump', (e) => this.onJump(e));
    on('land', (e) => this.onLand(e));
    on('death', (e) => this.onDeath(e));
    on('buy', (e) => this.onBuy(e));
    on('roundPhase', (e) => this.onRoundPhase(e));
    on('roundEnd', (e) => this.onRoundEnd(e));
    on('bombPlanted', (e) => this.onBombPlanted(e));
    on('bombExploded', (e) => this.onBombExploded(e));
    on('bombDefused', (e) => this.onBombDefused(e));
    on('grenadeExplode', (e) => this.onGrenadeExplode(e));
    on('flash', (e) => this.onFlash(e));
    on('announce', (e) => this.onAnnounce(e));
  }

  /** Number of live subscriptions; used by tests and by the game's teardown. */
  get subscriptionCount(): number {
    return this.detachers.length;
  }

  detach(): void {
    for (const off of this.detachers) off();
    this.detachers.length = 0;
    this.attached = null;
  }

  // -------------------------------------------------------------------------
  // Individual event handlers. Each is small; the interesting decisions are in
  // which bus/position is used and which cues are layered.
  // -------------------------------------------------------------------------

  private onShot(e: GameEventMap['shot']): void {
    // A knife swing is not a gunshot: it gets its own air-cutting whoosh, which
    // is what tells the player (and the bots' ears) that steel moved nearby.
    if (e.melee === true) {
      const whoosh = this.variant('cue:knifewhoosh', (ac, rng) => renderKnifeWhoosh(ac, rng));
      if (whoosh) this.play3D(whoosh, e.origin, { volume: 0.7, bus: 'sfx' });
      return;
    }
    const def = this.weaponLookup(e.weaponId);
    // `origin` is the muzzle position, which is what we want to spatialise.
    if (!def) return;
    const gain = e.silenced ? def.sound.gain * 0.55 : def.sound.gain;
    const buffer = this.variant(`shot:${def.id}`, (ac, rng) => renderGunshot(ac, def.sound, rng));
    if (!buffer) return;
    this.play3D(buffer, e.origin, { volume: clamp01(gain), bus: 'sfx' });
  }

  private onHit(e: GameEventMap['hit']): void {
    const local = e.shooterId === this.localActorId && this.localActorId >= 0;
    if (local) {
      // First-person feedback must be immediate and non-positional: the player's
      // own hit marker is a HUD sound, not a world sound.
      const marker = this.variant('cue:hitmarker', (ac) => renderHitMarker(ac));
      if (marker) this.play2D(marker, 'ui', 0.55);
      if (e.killed && e.hitGroup === 'head') {
        const ding = this.variant('cue:headshot', (ac) => renderHeadshotDing(ac));
        if (ding) this.play2D(ding, 'ui', 0.7);
      }
      return;
    }
    // Someone else's hit: positional so the player can hear where the fight is.
    const flesh = this.variant('flesh', (ac, rng) => renderFleshImpact(ac, rng));
    if (flesh) this.play3D(flesh, e.point, { volume: 0.7, bus: 'sfx' });
  }

  private onImpact(e: GameEventMap['impact']): void {
    // `dustOnly` impacts (a bullet grazing a wall without leaving a mark) are
    // visual-only; giving them a full hit sound would double every wall shot.
    if (e.dustOnly) return;
    const material = e.material;
    const buffer = this.variant(`impact:${material}`, (ac, rng) => renderImpact(ac, material, rng));
    if (buffer) this.play3D(buffer, e.point, { volume: 0.75, bus: 'sfx' });
  }

  /**
   * A bullet snapped past the player's ear.
   *
   * The combat layer already gated this to the near-miss band (`whizzBy` reports a
   * closest approach at most one radius from the ear, and refuses the bullet that
   * actually hit), so the only thing left to express is closeness: a round that
   * clips a shoulder is loud, one that passes a body length away is a whisper.
   */
  private onWhizz(e: GameEventMap['whizz']): void {
    const closeness = clamp01(1 - e.distance / WHIZZ_RADIUS_UNITS);
    this.playCue('whizz', e.pos, { volume: 0.25 + 0.75 * closeness, bus: 'sfx' });
  }

  private onFootstep(e: GameEventMap['footstep']): void {
    // The local player's own steps are mixed by the game (different bus and a
    // speed-dependent level), so playing them here too would double them.
    if (e.actorId === this.localActorId) return;
    const material = e.material;
    const buffer = this.variant(`step:${material}`, (ac, rng) => renderFootstep(ac, material, rng));
    if (buffer) this.play3D(buffer, e.pos, { volume: clamp01(e.volume), bus: 'footstep' });
  }

  private onReload(e: GameEventMap['reload']): void {
    const def = this.weaponLookup(e.weaponId);
    const position = this.actorPosition(e.actorId);
    const duration = Math.max(0.25, e.duration || def?.reloadTime || 2.2);
    // Real reloads have a rhythm: the magazine drops early, the new one seats
    // around the middle, and the bolt/charging handle is the last thing to move.
    const stages: { stage: ReloadStage; at: number }[] = [
      { stage: 'magout', at: 0 },
      { stage: 'magin', at: duration * 0.46 },
      { stage: 'bolt', at: duration * 0.84 },
    ];
    for (const s of stages) {
      const buffer = this.variant(`reload:${s.stage}`, (ac, rng) => renderReload(ac, s.stage, rng));
      if (!buffer) continue;
      if (position) this.play3D(buffer, position, { volume: 0.5, bus: 'sfx', delay: s.at });
      else this.play2D(buffer, 'sfx', 0.5, 1, s.at);
    }
  }

  private onDraw(e: GameEventMap['draw']): void {
    const position = this.actorPosition(e.actorId);
    const buffer = this.variant('cue:draw', (ac, rng) => renderDraw(ac, rng));
    if (!buffer) return;
    if (position) this.play3D(buffer, position, { volume: 0.45, bus: 'sfx' });
    else this.play2D(buffer, 'sfx', 0.45);
  }

  private onJump(e: GameEventMap['jump']): void {
    if (e.actorId === this.localActorId) return; // the game mixes local movement
    const position = this.actorPosition(e.actorId);
    const buffer = this.variant('cue:jump', (ac, rng) => renderJump(ac, rng));
    if (buffer && position) this.play3D(buffer, position, { volume: 0.4, bus: 'footstep' });
  }

  private onLand(e: GameEventMap['land']): void {
    if (e.actorId === this.localActorId) return;
    const position = this.actorPosition(e.actorId);
    if (!position) return;
    // Landing harder than the fall-damage threshold is the loudest possible land.
    const strength = clamp01((e.speed - 200) / 600);
    const buffer = this.variant('cue:land', (ac, rng) => renderLand(ac, strength, rng));
    if (buffer) this.play3D(buffer, position, { volume: 0.35 + strength * 0.45, bus: 'footstep' });
  }

  private onDeath(e: GameEventMap['death']): void {
    const position = this.actorPosition(e.victimId) ?? this.actorPosition(e.killerId);
    const buffer = this.variant('cue:death', (ac, rng) => renderDeathThud(ac, rng));
    if (!buffer) return;
    if (position) this.play3D(buffer, position, { volume: 0.6, bus: 'sfx' });
    else this.play2D(buffer, 'ui', 0.5);
  }

  private onBuy(_e: GameEventMap['buy']): void {
    const buffer = this.variant('cue:buy', (ac) => renderBuy(ac));
    if (buffer) this.play2D(buffer, 'ui', 0.5);
  }

  private onRoundPhase(e: GameEventMap['roundPhase']): void {
    // Only the transition into the live phase is a moment worth a sting; freeze
    // and bomb phases would otherwise retrigger it every frame they are emitted.
    if (e.phase !== 'live') return;
    const buffer = this.variant('cue:roundstart', (ac) => renderRoundStart(ac));
    if (buffer) this.play2D(buffer, 'ui', 0.55);
  }

  private onRoundEnd(_e: GameEventMap['roundEnd']): void {
    const buffer = this.variant('cue:roundend', (ac) => renderRoundEnd(ac));
    if (buffer) this.play2D(buffer, 'ui', 0.5);
  }

  private onBombPlanted(e: GameEventMap['bombPlanted']): void {
    const buffer = this.variant('cue:bombplant', (ac, rng) => renderBombPlant(ac, rng));
    if (buffer) this.play3D(buffer, e.pos, { volume: 0.7, bus: 'sfx' });
  }

  private onBombExploded(_e: GameEventMap['bombExploded']): void {
    const buffer = this.variant('cue:bombexplode', (ac, rng) => renderBombExplode(ac, rng));
    if (buffer) this.play2D(buffer, 'sfx', 0.9);
  }

  private onBombDefused(e: GameEventMap['bombDefused']): void {
    const buffer = this.variant('cue:defuseTick', (ac, rng) => renderDefuseTick(ac, rng));
    if (!buffer) return;
    // The defuser is usually the local player, and the "you finished" click has
    // to be unmistakably first-person; other actors get a positional version.
    if (e.actorId === this.localActorId) {
      this.play2D(buffer, 'ui', 0.6);
      return;
    }
    const position = this.actorPosition(e.actorId);
    if (position) this.play3D(buffer, position, { volume: 0.5, bus: 'sfx' });
  }

  private onGrenadeExplode(e: GameEventMap['grenadeExplode']): void {
    const kind = e.kind.toLowerCase();
    if (kind.includes('flash')) {
      const pop = this.variant('cue:flashpop', (ac, rng) => renderFlashbangPop(ac, rng));
      if (pop) this.play3D(pop, e.pos, { volume: 0.9, bus: 'sfx' });
      this.startTinnitus(0.6);
      return;
    }
    const buffer = this.variant('cue:explosion', (ac, rng) => renderExplosion(ac, rng));
    if (buffer) this.play3D(buffer, e.pos, { volume: 0.95, bus: 'sfx' });
  }

  /**
   * Flashbang: a loud transient, then ~4 s of 4 kHz tinnitus while the rest of
   * the mix ducks to 30%. The ring is routed to `master` (not a ducked bus) so
   * it stays audible while everything else is suppressed — that contrast is
   * exactly what being flashed feels like.
   */
  private onFlash(e: GameEventMap['flash']): void {
    const pop = this.variant('cue:flashpop', (ac, rng) => renderFlashbangPop(ac, rng));
    if (pop) this.play3D(pop, e.origin, { volume: clamp01(e.intensity) * 0.9, bus: 'sfx' });
    this.startTinnitus(clamp01(e.intensity));
  }

  /** Begin (or restart) the tinnitus ring + mix duck. */
  private startTinnitus(intensity: number): void {
    const ac = this.ac;
    const nodes = this.busNodes;
    if (!ac || !nodes) return;
    const ring = this.variant('cue:flashring', (ctx) => renderFlashRing(ctx));
    if (!ring) return;
    this.play2D(ring, 'master', 0.35 + intensity * 0.35);
    this.duckStart = ac.currentTime;
    this.duckUntil = ac.currentTime + FLASH_RING_SECONDS;
    for (const bus of DUCKED_BUSES) {
      const g = nodes[bus].gain;
      // Fast duck (8 ms) then a slow linear-ish recovery through the ring's
      // decay, so hearing "comes back" instead of snapping.
      g.cancelScheduledValues(ac.currentTime);
      g.setValueAtTime(g.value, ac.currentTime);
      g.linearRampToValueAtTime(this.effectiveGain(bus) * FLASH_DUCK_LEVEL, ac.currentTime + 0.008);
      g.setTargetAtTime(this.effectiveGain(bus), this.duckUntil - 0.6, 0.5);
    }
    // Restore nominal control of the ducked buses once the ring is over.
    const window = FLASH_RING_SECONDS * 1000;
    const startedAt = this.duckStart;
    setTimeout(() => {
      if (this.duckStart !== startedAt || !this.busNodes || !this.ac) return;
      this.duckStart = null;
      for (const bus of DUCKED_BUSES) {
        this.busNodes[bus].gain.setTargetAtTime(this.effectiveGain(bus), this.ac.currentTime, 0.2);
      }
    }, window);
  }

  private onAnnounce(e: GameEventMap['announce']): void {
    const buffer = this.variant('cue:announce', (ac) => renderAnnounce(ac));
    if (!buffer) return;
    // Money/round announcements are stings, not clicks; kill notices are subtler.
    const volume = e.kind === 'kill' ? 0.35 : 0.5;
    this.play2D(buffer, 'ui', volume);
  }

  /** Resolve an actor id to a world position, or null when unknown. */
  private actorPosition(actorId: number): Vec3 | null {
    return this.actorPositionProvider ? this.actorPositionProvider(actorId) : null;
  }
}

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Cheap client-side copy of the panner's inverse-distance curve (for the cap). */
function falloffApprox(distance: number): number {
  const d = Math.max(0, distance);
  return REF_DISTANCE / (REF_DISTANCE + ROLLOFF_FACTOR * Math.max(0, d - REF_DISTANCE));
}

/** Write a position into a PannerNode with feature detection. */
function positionPanner(panner: PannerNode, position: Vec3): void {
  const px = panner.positionX as AudioParam | undefined;
  if (px && typeof panner.positionY?.setValueAtTime === 'function') {
    panner.positionX.setValueAtTime(position.x, 0);
    panner.positionY.setValueAtTime(position.y, 0);
    panner.positionZ.setValueAtTime(position.z, 0);
    return;
  }
  const legacy = panner as unknown as { setPosition?(x: number, y: number, z: number): void };
  legacy.setPosition?.(position.x, position.y, position.z);
}

/** Which bus a non-positional cue belongs on by default. */
function cueBus(cue: SfxCue): AudioBus {
  switch (cue) {
    case 'bombExplode':
      return 'sfx';
    case 'hitmarker':
    case 'headshot':
    case 'uiClick':
    case 'roundStart':
    case 'roundEnd':
      return 'ui';
    default:
      return 'sfx';
  }
}

/** Re-exported so the game can type its own `setVolume` calls. */
export type { SurfaceMaterial };
