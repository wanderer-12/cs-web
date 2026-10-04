// =============================================================================
// core/engine.ts — the shell that turns the simulation into a running game.
//
// Everything the simulation deliberately does NOT know about lives here: WebGL,
// the DOM, pointer lock, the audio graph and the frame clock. The split is the
// point — `Match` / `Player` / `Bot` are deterministic and headless (and unit
// tested), while this file is the only place that touches `window`, `document`,
// `requestAnimationFrame` or a WebGL context.
//
// Wiring contract:
//   * the camera belongs to the ENGINE (one `CameraRig`, injected into the human
//     player) so the render camera, the VFX layer and the audio listener keep
//     pointing at the same object across match restarts;
//   * the bus is created here, not the module singleton, so a restart cannot
//     leak a finished match's handlers into the new one;
//   * `GameLoop` owns the fixed-step accumulator: `step()` advances the match at
//     exactly 128 Hz, `render()` only composes the camera and draws.
// =============================================================================

import * as THREE from 'three';
import { AudioEngine } from '../audio/AudioEngine';
import type { BotDifficulty } from '../ai/Bot';
import { computeInaccuracy } from '../combat/ballistics';
import { weaponById } from '../combat/weaponDefs';
import { Match } from '../game/game';
import { CameraRig } from '../player/cameraRig';
import { InputSystem } from '../player/input';
import type { Player } from '../player/player';
import { CharacterRenderer } from '../render/Characters';
import { ViewModel } from '../render/ViewModel';
import { SignLayer } from '../render/Signs';
import { Hud, createHud } from '../ui/Hud';
import { sortedScoreRows, type HudFrameState, type RadarBlip, type ScoreRow } from '../ui/pure';
import { buildMapMeshes, type MapMeshes } from '../world/MapGeometry';
import { buildDust2Lite } from '../world/maps/de_dust2_lite';
import { createSky, type SkyRig } from '../world/sky';
import { World } from '../world/world';
import { createVfx, type VfxSystem } from '../vfx/VfxSystem';
import { CAMERA, MATCH, MOVE, PERF, TICK_DT } from './config';
import { EventBus } from './events';
import { GameLoop } from './loop';
import { clamp01, distance, normalize, sub, v3 } from './math';
import { Rng } from './rng';
import { EMPTY_BUTTONS, type ActorState, type InputCommand, type MapData, type Team, type Vec3 } from './types';

// ---------------------------------------------------------------------------
// tuning constants that only matter to the shell
// ---------------------------------------------------------------------------

/** Muzzle flash light: colour, reach, offset ahead of the eye and peak gain. */
const MUZZLE_LIGHT_COLOR = 0xffd2a0;
const MUZZLE_LIGHT_DISTANCE = 900;
const MUZZLE_LIGHT_FORWARD = 26;
const MUZZLE_LIGHT_GAIN = 140;

/** Longest distance at which an enemy is drawn on the radar with line of sight. */
const RADAR_SPOT_RANGE = 3600;
/** An enemy that fired this recently is on the radar even without line of sight. */
const RADAR_HEAR_SHOT_TIME = 1.5;
/** cos(75°): enemies outside this cone around the view direction are not spotted. */
const RADAR_SPOT_COS = Math.cos((75 * Math.PI) / 180);
/** Gain multiplier applied to a sound with something solid between it and the ear. */
const OCCLUDED_GAIN = 0.32;
/** Seconds the red damage flash takes to fade out. */
const DAMAGE_FLASH_TIME = 0.45;
/** Seconds between roster pushes into the TAB scoreboard while it is open. */
const SCORE_REFRESH_INTERVAL = 0.25;
/** Crosshair geometry: base gap in px, arm length, arm thickness. */
const CROSSHAIR_BASE = 4;
const CROSSHAIR_LENGTH = 7;
const CROSSHAIR_THICKNESS = 2;

/** Seconds the camera takes to fly between spectated teammates. */
const UP = { x: 0, y: 1, z: 0 };

export interface EngineOptions {
  /** Canvas the WebGL context and pointer lock attach to. */
  canvas: HTMLCanvasElement;
  /** Element the HUD mounts itself in. Defaults to `document.body`. */
  hudRoot?: HTMLElement;
  humanName?: string;
  humanTeam?: Team;
  difficulty?: BotDifficulty;
  /** Deterministic seed for the whole match. */
  seed?: number;
}

/** Counters the perf report quotes; all of them are read, never estimated. */
export interface EngineStats {
  fps: number;
  simMs: number;
  renderMs: number;
  droppedSteps: number;
  drawCalls: number;
  triangles: number;
  programs: number;
  textures: number;
  geometries: number;
  mapDrawCalls: number;
  mapTriangles: number;
  players: number;
}

function emptyCommand(tick = 0): InputCommand {
  return {
    tick,
    buttons: { ...EMPTY_BUTTONS },
    yaw: 0,
    pitch: 0,
    mouseDX: 0,
    mouseDY: 0,
  };
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly bus = new EventBus();
  readonly map: MapData;
  readonly world: World;
  /** The one camera rig: render camera, VFX camera and audio listener anchor. */
  readonly rig: CameraRig;
  readonly camera: THREE.PerspectiveCamera;
  readonly input: InputSystem;
  readonly hud: Hud;
  readonly audio: AudioEngine;
  readonly vfx: VfxSystem;
  /** Actor bodies: one InstancedMesh layer for the whole match. */
  readonly characters: CharacterRenderer;
  /** The first-person weapon, drawn in its own scene and pass. */
  readonly viewModel: ViewModel;
  /** Floor labels / spawn placards: the world's own nametags (1 draw call). */
  readonly signs: SignLayer;
  readonly loop: GameLoop;
  /** Rebuilt by `restart()`, hence not readonly. */
  match: Match;

  private readonly canvas: HTMLCanvasElement;
  private readonly options: EngineOptions;
  private readonly seed: number;
  private readonly sky: SkyRig;
  private readonly mapMeshes: MapMeshes;
  private readonly muzzleLight: THREE.PointLight;
  private readonly offs: (() => void)[] = [];
  private readonly resizeHandler: () => void;
  /** Reused actor list for the character layer (keeps the frame loop alloc-free). */
  private readonly actorScratch: ActorState[] = [];

  // scratch, so the frame loop never allocates
  private readonly tmpCamDir = new THREE.Vector3();
  private readonly tmpA: Vec3 = v3();
  private readonly tmpDir: Vec3 = v3();
  private readonly lastShotAt = new Map<number, number>();

  private cmd: InputCommand = emptyCommand();
  private frameDt = TICK_DT;
  private lastDamageAt = -100;
  private spectateId = -1;
  private scoreTimer = 0;
  private matchEndShown = false;
  private disposed = false;

  constructor(options: EngineOptions) {
    this.options = options;
    this.canvas = options.canvas;
    this.seed = options.seed ?? 0x1a2b3c4d;

    // --- renderer ----------------------------------------------------------
    this.renderer = new THREE.WebGLRenderer({
      canvas: options.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, PERF.maxPixelRatio));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setClearColor(0x10131a, 1);
    // The frame is two `render()` calls (world, then the view model), so the
    // counters must be reset by hand: otherwise `EngineStats.drawCalls` would
    // report the weapon pass alone, and with auto-reset the second call would
    // silently wipe the world's numbers too.
    this.renderer.info.autoReset = false;

    // --- world -------------------------------------------------------------
    this.map = buildDust2Lite();
    this.world = new World(this.map);
    this.sky = createSky(this.scene);
    this.mapMeshes = buildMapMeshes(this.map, { shadows: true });
    this.scene.add(this.mapMeshes.group);

    // --- simulation --------------------------------------------------------
    this.rig = new CameraRig(16 / 9);
    this.camera = this.rig.camera;
    this.match = this.createMatch();

    // --- presentation layers (all driven by the one bus) -------------------
    this.vfx = createVfx({
      scene: this.scene,
      camera: this.camera,
      world: this.world,
      maxPixelRatio: PERF.maxPixelRatio,
    });
    this.vfx.attach(this.bus);

    this.muzzleLight = new THREE.PointLight(
      MUZZLE_LIGHT_COLOR,
      0,
      MUZZLE_LIGHT_DISTANCE,
      2,
    );
    this.muzzleLight.name = 'muzzle-light';
    this.scene.add(this.muzzleLight);

    // The bodies of the ten actors. Before this layer existed an enemy was only
    // ever a muzzle spark and a tracer: nothing in the sim creates a mesh.
    this.characters = new CharacterRenderer(this.scene);
    // The gun in the player's hands, drawn in its own scene and pass (see
    // render/ViewModel.ts for why it cannot live in the world scene).
    this.viewModel = new ViewModel(this.camera);
    // Readability pass: the audit of de_dust2_lite measured 12 of 18 named areas
    // sharing one floor tint and 4 of 5 spawns facing a blank wall, so the world
    // now labels itself. One merged atlas mesh, no lighting, 1 draw call.
    this.signs = new SignLayer(this.scene, this.map);

    this.audio = new AudioEngine((id) => weaponById(id));
    this.audio.attach(this.bus);
    this.audio.setActorPositionProvider((id) => {
      const actor = this.match.byId.get(id);
      return actor ? actor.state.pos : null;
    });
    this.audio.setOcclusionTest((from, to) => this.occlusion(from, to));

    this.watchBus();

    // --- input + UI --------------------------------------------------------
    this.input = new InputSystem(options.canvas, {
      onLockChange: (locked) => this.onLockChange(locked),
    });
    this.hud = createHud({
      root: options.hudRoot,
      map: this.map,
      playerName: options.humanName ?? MATCH.playerName,
      onBuy: (itemId) => this.tryBuy(itemId),
      onRequestPointerLock: () => this.beginPlay(),
      onMenuAction: (action) => this.onMenuAction(action),
    });
    this.hud.attach(this.bus);
    this.hud.showMainMenu(true);

    // --- frame loop --------------------------------------------------------
    this.loop = new GameLoop({
      step: (tick, dt) => this.step(tick, dt),
      render: (_alpha, frameDt) => this.render(frameDt),
    });
    this.loop.paused = true;

    this.resizeHandler = () => this.resize();
    window.addEventListener('resize', this.resizeHandler);
    this.resize();
    this.bindMatch();
    this.hud.showMainMenu(true);
  }

  // -------------------------------------------------------------------------
  // lifecycle
  // -------------------------------------------------------------------------

  /** Start the render loop (the simulation still waits for pointer lock). */
  start(): void {
    this.loop.start();
  }

  /** Stop ticking and rendering. Idempotent. */
  stop(): void {
    this.loop.stop();
  }

  /** Throw the current match away and start a fresh one. */
  restart(): void {
    if (this.disposed) return;
    this.hud.clearResults();
    this.match.dispose();
    this.match = this.createMatch();
    this.bindMatch();
    this.hud.setScoreboardOpen(false);
    this.hud.setBuyMenuOpen(false);
    this.beginPlay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.loop.stop();
    window.removeEventListener('resize', this.resizeHandler);
    for (const off of this.offs) off();
    this.offs.length = 0;
    this.match.dispose();
    this.hud.detach();
    this.hud.dispose();
    this.input.dispose();
    this.audio.detach?.();
    this.audio.dispose();
    this.vfx.dispose();
    this.characters.dispose();
    this.viewModel.dispose();
    this.signs.dispose();
    this.sky.dispose();
    this.scene.remove(this.mapMeshes.group);
    this.renderer.dispose();
  }

  /** Fresh counters for the perf report / on-screen overlay. */
  stats(): EngineStats {
    const info = this.renderer.info;
    return {
      fps: this.loop.fps,
      simMs: this.loop.simMs,
      renderMs: this.loop.renderMs,
      droppedSteps: this.loop.droppedSteps,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      textures: info.memory.textures,
      geometries: info.memory.geometries,
      mapDrawCalls: this.mapMeshes.stats.drawCalls,
      mapTriangles: this.mapMeshes.stats.triangles,
      players: this.match.players.length,
    };
  }

  // -------------------------------------------------------------------------
  // match wiring
  // -------------------------------------------------------------------------

  private createMatch(): Match {
    return new Match({
      world: this.world,
      bus: this.bus,
      map: this.map,
      rng: new Rng(this.seed),
      humanName: this.options.humanName,
      humanTeam: this.options.humanTeam,
      difficulty: this.options.difficulty,
      rig: this.rig,
    });
  }

  /** Point the presentation layers at the (possibly brand new) match. */
  private bindMatch(): void {
    this.audio.setLocalActorId(this.match.local.id);
    this.match.local.setInputSystem(this.input);
    this.lastShotAt.clear();
    this.spectateId = -1;
    this.matchEndShown = false;
    this.scoreTimer = 0;
    this.cmd = emptyCommand();
    this.resize();
  }

  /**
   * Engine-owned bus taps. These reference `this.match` at call time, so they
   * survive a restart without re-subscribing.
   */
  private watchBus(): void {
    this.offs.push(
      this.bus.on('shot', (e) => {
        this.lastShotAt.set(e.shooterId, this.match.now);
      }),
    );
    this.offs.push(
      this.bus.on('hit', (e) => {
        if (e.targetId === this.match.local.id) this.lastDamageAt = this.match.now;
      }),
    );
    this.offs.push(
      this.bus.on('death', (e) => {
        if (e.victimId === this.match.local.id) this.lastDamageAt = this.match.now;
      }),
    );
  }

  // -------------------------------------------------------------------------
  // input plumbing
  // -------------------------------------------------------------------------

  private beginPlay(): void {
    void this.audio.resume();
    this.input.requestLock();
    this.hud.showMainMenu(false);
    this.loop.paused = false;
  }

  private onLockChange(locked: boolean): void {
    if (this.disposed) return;
    if (locked) {
      this.hud.showMainMenu(false);
      this.loop.paused = false;
      void this.audio.resume();
      return;
    }
    // Unlocked: keyboard-only play stops, and the menu comes back unless the
    // match is over (in that case the match-end board is what we want to see).
    this.loop.paused = true;
    if (!this.match.matchOver) this.hud.showMainMenu(true);
  }

  private onMenuAction(action: string): void {
    switch (action) {
      case 'restart':
        this.restart();
        break;
      case 'pause':
        this.loop.paused = true;
        this.input.releaseLock();
        break;
      case 'settings':
        // No options panel in the prototype; the menu stays open.
        break;
      case 'quit':
        this.stop();
        break;
      default:
        break;
    }
  }

  private tryBuy(itemId: string): void {
    const outcome = this.match.buy(this.match.local.id, itemId);
    if (outcome.ok) this.audio.playCue('uiClick', null, { bus: 'ui' });
  }

  // -------------------------------------------------------------------------
  // per-frame
  // -------------------------------------------------------------------------

  private step(tick: number, dt: number): void {
    if (this.disposed) return;
    const match = this.match;
    if (match.matchOver) return; // the round is decided: freeze the world
    const cmd = this.input.sample(tick);
    this.cmd = cmd;
    match.tick(cmd, dt);
    if (match.matchOver) this.finishMatch();
  }

  private finishMatch(): void {
    if (this.matchEndShown) return;
    this.matchEndShown = true;
    const match = this.match;
    this.hud.showMatchEnd({
      winner: match.winner ?? match.local.team,
      scoreT: match.scoreT,
      scoreCT: match.scoreCT,
      scoreboard: this.scoreRows(),
    });
    // Give the mouse back for the "Play again" button. The lock handler keeps
    // the menu closed because the match is over.
    this.input.releaseLock();
  }

  private render(frameDt: number): void {
    if (this.disposed) return;

    // Two passes draw this frame (world + weapon), and autoReset is off, so the
    // counter bucket is emptied here by hand: see the constructor.
    this.renderer.info.reset();

    this.frameDt = frameDt;
    const local = this.match.local;
    const view = this.viewPlayer();

    if (view === local) {
      local.updateCamera(frameDt, this.cmd.mouseDX, this.cmd.mouseDY);
    } else {
      // Spectating: drive the engine's rig from the watched actor's pose.
      this.rig.update(
        view.state.yaw,
        view.state.pitch,
        view.state.pos,
        view.state.duckAmount,
        view.state.vel,
        view.state.onGround,
        frameDt,
        0,
        0,
      );
    }
    this.camera.updateMatrixWorld();

    // Bodies and weapon both follow the camera that was just composed; the actor
    // the camera sits inside is the one the character layer hides.
    this.syncCharacters(view, frameDt);
    this.updateViewModel(view, frameDt);

    // Muzzle light rides the view direction; the VFX layer owns the envelope.
    this.camera.getWorldDirection(this.tmpCamDir);
    this.tmpDir.x = this.tmpCamDir.x;
    this.tmpDir.y = this.tmpCamDir.y;
    this.tmpDir.z = this.tmpCamDir.z;
    this.muzzleLight.position.set(
      this.camera.position.x + this.tmpCamDir.x * MUZZLE_LIGHT_FORWARD,
      this.camera.position.y + this.tmpCamDir.y * MUZZLE_LIGHT_FORWARD,
      this.camera.position.z + this.tmpCamDir.z * MUZZLE_LIGHT_FORWARD,
    );
    this.muzzleLight.intensity = this.vfx.flashlightIntensity * MUZZLE_LIGHT_GAIN;

    this.audio.updateListener(this.camera.position, this.tmpDir, UP);

    // VFX reads `camera.matrixWorld`, so it must run after the compose above.
    this.vfx.update(frameDt, this.camera);

    const blips = this.buildBlips(view);
    this.hud.setActors(blips);
    this.hud.setSpotted(this.spottedIds(local));
    this.hud.setState(this.frameState(view, frameDt));

    this.scoreTimer += frameDt;
    if (this.hud.getScoreboardOpen() && this.scoreTimer >= SCORE_REFRESH_INTERVAL) {
      this.scoreTimer = 0;
      this.hud.setScoreRows(this.scoreRows());
    }

    if (this.canvas.style.cursor !== 'default' && this.hud.wantsCursor()) {
      this.canvas.style.cursor = 'default';
    } else if (this.canvas.style.cursor !== 'none' && this.input.locked) {
      this.canvas.style.cursor = 'none';
    }

    this.renderer.render(this.scene, this.camera);

    // Second pass: the weapon on top of a cleared depth buffer, so the barrel can
    // never clip through a wall the player is standing against. Same camera object,
    // so it is already in step with the world pass; nothing is cleared in colour.
    if (this.viewModel.visible) {
      this.renderer.autoClear = false;
      this.renderer.clearDepth();
      this.renderer.render(this.viewModel.scene, this.viewModel.renderCamera);
      this.renderer.autoClear = true;
    }
  }

  /**
   * Hand the ten actors to the character layer. `actorScratch` is reused so the
   * frame path allocates nothing, and slot i always means `players[i]`, which is
   * what lets the colour cache in `CharacterRenderer` skip unchanged writes.
   */
  private syncCharacters(view: Player, frameDt: number): void {
    const scratch = this.actorScratch;
    scratch.length = 0;
    for (const p of this.match.players) scratch.push(p.state);
    this.characters.sync(scratch, {
      hiddenId: view.id,
      viewerTeam: view.team,
      dt: frameDt,
    });
  }

  /**
   * Compose the first-person weapon from the rig pose the camera just used. The
   * muzzle offset goes straight to the VFX layer so flash, tracer and muzzle
   * light all leave the visible barrel instead of the eye.
   */
  private updateViewModel(view: Player, frameDt: number): void {
    const local = this.match.local;
    const def = local.weapon;
    const state = local.state;
    if (view === local) this.viewModel.setWeapon(def.kind);
    const pose = this.rig.viewPose;
    const weaponState = local.ammo.get(def.id);
    this.viewModel.update({
      bobX: pose.bobX,
      bobY: pose.bobY,
      dip: pose.dip,
      punchYaw: pose.punchYaw,
      punchPitch: pose.punchPitch,
      swayYaw: pose.swayYaw,
      swayPitch: pose.swayPitch,
      speedNorm: Math.min(1, Math.hypot(state.vel.x, state.vel.z) / MOVE.maxSpeed),
      alive: view === local && state.alive,
      scoped: !!weaponState?.scoped,
      reloading: local.isReloading,
      reloadTime: def.reloadTime,
      drawTime: def.drawTime,
      dt: frameDt,
    });
    const muzzle = this.viewModel.muzzleOffset;
    this.vfx.setMuzzleOffset(muzzle.forward, muzzle.right, muzzle.down);
  }

  private resize(): void {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    this.renderer.setSize(w, h, false);
    this.rig.setAspect(w / h);
  }

  /** Whose eyes the camera is behind: the local player, else a live teammate. */
  private viewPlayer(): Player {
    const local = this.match.local;
    if (local.state.alive) return local;
    return this.spectateTarget() ?? local;
  }

  private spectateTarget(): Player | null {
    const local = this.match.local;
    const current = this.spectateId >= 0 ? this.match.byId.get(this.spectateId) : undefined;
    if (current && current !== local && current.state.alive && current.team === local.team) {
      return current;
    }
    const mate = this.match.players.find(
      (p) => p !== local && p.team === local.team && p.state.alive,
    );
    this.spectateId = mate ? mate.id : -1;
    return mate ?? null;
  }

  // -------------------------------------------------------------------------
  // HUD data
  // -------------------------------------------------------------------------

  private frameState(view: Player, frameDt: number): HudFrameState {
    const match = this.match;
    const local = match.local;
    const state = local.state;
    const def = local.weapon;
    const weaponState = local.ammo.get(def.id);
    const speed = Math.hypot(state.vel.x, state.vel.z);
    const dead = !state.alive;

    // Crosshair: the same cone the bullets use, projected to pixels.
    const inaccuracy = computeInaccuracy({
      weapon: def,
      horizontalSpeed: speed,
      duckAmount: state.duckAmount,
      onGround: state.onGround,
      shotIndex: weaponState?.shotIndex ?? 0,
    });
    const halfHeight = Math.max(1, this.renderer.domElement.height) * 0.5;
    const tanHalfFov = Math.tan(((this.rig.fov * 0.5) * Math.PI) / 180);
    const scoped = !!weaponState?.scoped;
    const gap = scoped || dead ? 0 : (Math.tan(inaccuracy) / tanHalfFov) * halfHeight;
    const damageFlash = clamp01(1 - (match.now - this.lastDamageAt) / DAMAGE_FLASH_TIME);

    const defusing = match.defuserId === local.id && match.defuseProgress > 0;

    return {
      health: state.health,
      armor: state.armor,
      helmet: state.helmet,
      hasDefuseKit: state.hasDefuseKit,
      ammo: local.magazineAmmo,
      reserve: local.reserveAmmo,
      magazine: def.magazine,
      weaponName: def.name,
      weaponId: def.id,
      isReloading: local.isReloading,
      money: match.moneyOf(local.id),
      team: local.team,
      phase: match.phase,
      roundNumber: match.roundNumber,
      timeLeft: match.timeLeft,
      scoreT: match.scoreT,
      scoreCT: match.scoreCT,
      bombPlanted: match.bombState === 'planted',
      bombTimer: match.bombState === 'planted' ? match.bombTimer : 0,
      bombSite: match.bombState === 'planted' ? match.bombSite : null,
      defusing,
      defuseProgress: defusing ? match.defuseProgress : 0,
      crosshairGap: gap,
      crosshairLength: CROSSHAIR_LENGTH,
      crosshairThickness: CROSSHAIR_THICKNESS,
      crosshairDot: !scoped && !dead && def.kind === 'sniper',
      flashAmount: this.vfx.flashAmount,
      damageFlash,
      dead,
      fps: frameDt > 0 ? 1 / frameDt : this.loop.fps,
    };
  }

  private buildBlips(view: Player): RadarBlip[] {
    const local = this.match.local;
    const out: RadarBlip[] = [];
    for (const p of this.match.players) {
      out.push({
        id: p.id,
        pos: { x: p.state.pos.x, y: p.state.pos.y, z: p.state.pos.z },
        team: p.team,
        alive: p.state.alive,
        isLocal: p === local,
        yaw: p.state.yaw,
        // The radar shows teammates and spotted enemies; unseen enemies are
        // filtered by `spottedIds`, which the HUD intersects with this list.
        spotted: p.team === local.team || this.spectateId === p.id || this.enemySpotted(p, view),
        hasBomb: p.state.hasBomb,
      });
    }
    return out;
  }

  private spottedIds(local: Player): number[] {
    const ids: number[] = [local.id];
    for (const p of this.match.players) {
      if (p === local) continue;
      if (p.team === local.team) ids.push(p.id);
      else if (this.enemySpotted(p, local)) ids.push(p.id);
    }
    return ids;
  }

  /** Visible = fresh gunfire, or inside the view cone with a clear line of sight. */
  private enemySpotted(enemy: Player, viewer: Player): boolean {
    if (!enemy.state.alive) return false;
    const local = this.match.local;
    if (enemy.team === local.team) return true;
    const shotAt = this.lastShotAt.get(enemy.id) ?? -Infinity;
    if (this.match.now - shotAt <= RADAR_HEAR_SHOT_TIME) return true;

    this.camera.getWorldDirection(this.tmpCamDir);
    sub(this.tmpA, enemy.state.pos, viewer.state.pos);
    const dist = Math.hypot(this.tmpA.x, this.tmpA.y, this.tmpA.z);
    if (dist > RADAR_SPOT_RANGE || dist < 1e-3) return dist < 1e-3;
    const dot = (this.tmpA.x * this.tmpCamDir.x + this.tmpA.y * this.tmpCamDir.y + this.tmpA.z * this.tmpCamDir.z) / dist;
    if (dot < RADAR_SPOT_COS) return false;
    return this.hasLineOfSight(viewer.eyePosition(), enemy.state.pos);
  }

  private hasLineOfSight(from: Vec3, to: Vec3): boolean {
    sub(this.tmpA, to, from);
    const dist = Math.hypot(this.tmpA.x, this.tmpA.y, this.tmpA.z);
    if (dist < 1e-3) return true;
    normalize(this.tmpDir, this.tmpA);
    const hit = this.world.raycast(from, this.tmpDir, dist, { includeClip: false });
    if (!hit.hit) return true;
    if (hit.material === 'glass') return true;
    return hit.distance >= dist - 2;
  }

  /** Gain multiplier for a sound travelling `from` -> `to`. */
  private occlusion(from: Vec3, to: Vec3): number {
    return this.hasLineOfSight(from, to) ? 1 : OCCLUDED_GAIN;
  }

  private scoreRows(): ScoreRow[] {
    const local = this.match.local;
    const rows: ScoreRow[] = this.match.players.map((p) => {
      const stats = this.match.statsOf(p.id);
      return {
        name: p.state.name,
        team: p.team,
        kills: stats.kills,
        deaths: stats.deaths,
        assists: 0,
        money: this.match.moneyOf(p.id),
        alive: p.state.alive,
        isLocal: p === local,
        ping: 0,
      };
    });
    return sortedScoreRows(rows);
  }

  // -------------------------------------------------------------------------
  // debug helpers used by the perf harness
  // -------------------------------------------------------------------------

  /** Teleport the local player (perf runs and manual testing). */
  placeLocal(pos: Vec3, yaw = 0, pitch = 0): void {
    const local = this.match.local;
    local.state.pos.x = pos.x;
    local.state.pos.y = pos.y;
    local.state.pos.z = pos.z;
    local.state.vel.x = 0;
    local.state.vel.y = 0;
    local.state.vel.z = 0;
    local.state.yaw = yaw;
    local.state.pitch = pitch;
  }

  /** Straight-line distance from the local player to another actor (radar debug). */
  distanceTo(actorId: number): number {
    const other = this.match.byId.get(actorId);
    if (!other) return Infinity;
    const local = this.match.local;
    return distance(local.state.pos, other.state.pos);
  }

  /** Exposed for the tests: the engine's fixed simulation step in seconds. */
  static get tickDt(): number {
    return TICK_DT;
  }

  /** Player-shaped constants the HUD/report quote (kept in one place). */
  static get referenceSpeed(): number {
    return MOVE.maxSpeed;
  }

  /** Camera field of view used for the crosshair projection. */
  static get baseFov(): number {
    return CAMERA.fov;
  }
}