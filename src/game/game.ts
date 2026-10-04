// =============================================================================
// game/game.ts — the match.
//
// Owns everything a player cannot know about itself: who is on which team, who is
// allowed to shoot whom, the round clock, the economy, the bomb, and the bot
// brains. One instance is one 5v5 match against bots.
//
// Layering contract (do not invert it):
//   World / NavGraph / EventBus  <- built by the engine and handed in
//   Match                        <- this file: pure simulation, no rendering
//   Engine                       <- renderer, HUD, audio, VFX. It READS the Match
//                                   and reacts to bus events; it never reaches in
//                                   to mutate a player.
// A Match never touches `document`, `window` or `performance.now()`: the tick
// clock arrives as an argument, so a whole match is deterministic and testable.
// =============================================================================

import { createBotCommand, type BotDifficulty, type BotObjective } from '../ai/Bot';
import { BotController } from '../ai/BotController';
import { NavGraph } from '../ai/navigation';
import { CombatSystem } from '../combat/CombatSystem';
import { buildAllHitboxes } from '../combat/hitbox';
import { EQUIPMENT_PRICE, weaponById } from '../combat/weaponDefs';
import { COMBAT, MATCH, PLAYER, RULES } from '../core/config';
import type { EventBus } from '../core/events';
import { v3 } from '../core/math';
import { Rng } from '../core/rng';
import {
  EMPTY_BUTTONS,
  type ActorState,
  type GroundWeapon,
  type InputCommand,
  type MapData,
  type RoundPhase,
  type Team,
  type Vec3,
  type WeaponSlot,
} from '../core/types';
import { boxOverlapsWorld } from '../world/trace';
import type { ActorHitbox, World } from '../world/world';
import type { CameraRig } from '../player/cameraRig';
import { playerExtents } from '../player/movement';
import { Player, type PlayerShotContext } from '../player/player';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

/** Seconds of holding `use` needed to plant the C4 (CS: 3.2 s). */
const PLANT_TIME = 3.2;
/** Range at which the bomb can be defused or picked up (units). */
const BOMB_INTERACT_RANGE = 72;
/** Vertical tolerance when testing "is this actor standing on the site". */
const SITE_Y_TOLERANCE = 96;
/** Speed (u/s) above which planting / defusing is cancelled. */
const BOMB_STILL_SPEED = 30;
/** Seconds until a player killed during warmup respawns. */
const WARMUP_RESPAWN_DELAY = 2;
/** How far a gunshot can be heard by a bot (units). */
const GUNSHOT_HEARING_RANGE = 3000;
/** Range at which a weapon on the floor can be picked up (units). */
const WEAPON_PICKUP_RANGE = 72;
/** Slots that leave a gun behind when their owner dies, swaps or presses `G`. */
const DROPPABLE_SLOTS: readonly WeaponSlot[] = ['primary', 'secondary'];
/** Most guns the floor may hold at once; the oldest one is dropped out. */
const GROUND_WEAPON_CAP = 24;
/**
 * Seconds a gun must lie undisturbed before anyone can pick it up. Without this
 * `G` would look broken: the owner is still standing on the drop, so an empty
 * slot would vacuum it straight back up on the next tick.
 */
const WEAPON_SETTLE_TIME = 1.5;

/**
 * Two bodies closer than this (centre distance, on the same floor) push each
 * other apart. Two player radii, i.e. exactly touching.
 */
const SEPARATION_DISTANCE = PLAYER.radius * 2;
/**
 * Most one body can be pushed in a single tick, so a separation never reads as a
 * teleport. A full overlap therefore resolves over a few ticks.
 */
const SEPARATION_MAX_PUSH = PLAYER.radius * 0.5;

/** Buy-eligible equipment ids, in the order the buy menu lists them. */
export const EQUIPMENT_IDS = ['kevlar', 'kevlarhelmet', 'defusekit'] as const;
export type EquipmentId = (typeof EQUIPMENT_IDS)[number];

/** Anything the buy menu can sell: a weapon id or an equipment id. */
export type BuyableId = string;

export interface BuyOutcome {
  ok: boolean;
  reason?: 'money' | 'already-owned' | 'not-buy-time' | 'not-buy-zone' | 'dead' | 'unknown';
  price?: number;
}

export interface PlayerStats {
  kills: number;
  deaths: number;
  /** Scoreboard sort key: kills dominate, bomb plants/defuses add. */
  score: number;
  plants: number;
  defuses: number;
}

export interface MatchOptions {
  world: World;
  bus: EventBus;
  map: MapData;
  /** Shared deterministic RNG; a fresh one is created when omitted. */
  rng?: Rng;
  /** Name shown on the scoreboard for the human player. */
  humanName?: string;
  /** Team the human joins. Defaults to CT, the bomb-defence side. */
  humanTeam?: Team;
  difficulty?: BotDifficulty;
  /** Bots per team, excluding the human. Default 4 (so both sides field five). */
  botsPerTeam?: number;
  /** Skip the warmup phase and go straight to round 1 (used by tests). */
  skipWarmup?: boolean;
  /**
   * Camera rig the human player must use. The engine passes its own rig so the
   * render camera, the VFX layer and the audio listener keep pointing at one
   * stable object across match restarts.
   */
  rig?: CameraRig;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/**
 * The two sides that can actually play: `Team` also has a spectating member, and
 * a spectator is never on a team, never scripted and never spawned.
 */
type Side = 'T' | 'CT';

function otherTeam(team: Team): Team {
  return team === 'T' ? 'CT' : team === 'CT' ? 'T' : 'SPEC';
}

function distanceXZ(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}

/** Even-odd point-in-polygon test on the XZ plane. */
function pointInPoly(poly: readonly [number, number][], x: number, z: number): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i];
    const [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

interface PendingDeath {
  victimId: number;
  killerId: number;
  weaponId: string;
  headshot: boolean;
  wallbang: boolean;
}

// ---------------------------------------------------------------------------
// Match
// ---------------------------------------------------------------------------

export class Match {
  readonly bus: EventBus;
  readonly world: World;
  readonly map: MapData;
  readonly nav: NavGraph;
  readonly rng: Rng;
  readonly combat: CombatSystem;
  readonly difficulty: BotDifficulty;

  readonly players: Player[] = [];
  readonly byId = new Map<number, Player>();
  /** The human-controlled player. */
  readonly local: Player;
  readonly humanTeam: Side;

  // --- round state ---------------------------------------------------------
  phase: RoundPhase = 'warmup';
  /** Seconds left in the current phase (round clock, freeze, fuse, delay). */
  timeLeft: number = RULES.warmupTime;
  roundNumber = 0;
  scoreT = 0;
  scoreCT = 0;
  matchOver = false;
  winner: Team | null = null;
  /** The site the T side is attacking this round. */
  targetSite: 'A' | 'B' = 'A';
  /** Simulation clock; advanced only by `tick`. */
  now = 0;

  // --- bomb ----------------------------------------------------------------
  bombState: 'carried' | 'dropped' | 'planted' | 'defused' | 'exploded' = 'carried';
  bombCarrierId = -1;
  bombPos: Vec3 = { x: 0, y: 0, z: 0 };
  bombTimer = 0;
  bombSite: 'A' | 'B' = 'A';
  /** CT currently defusing, or -1. */
  defuserId = -1;
  defuseProgress = 0;

  // --- weapons on the floor -------------------------------------------------
  /**
   * Guns lying around after a death, a `G` drop or a swap.
   *
   * A gun is an entity of its own here, not a property of a slot: it carries the
   * magazine it was dropped with, so a team-mate who picks it up inherits a
   * half-spent AK-47 rather than a fresh one. The renderer reads this array; the
   * match never keeps a second copy of it.
   */
  readonly groundWeapons: GroundWeapon[] = [];
  private nextGroundWeaponId = 1;
  /** Previous `use` / `drop` button state per actor, to detect fresh presses. */
  private readonly useDown = new Map<number, boolean>();
  private readonly dropDown = new Map<number, boolean>();

  // --- bookkeeping ---------------------------------------------------------
  private readonly money = new Map<number, number>();
  private readonly stats = new Map<number, PlayerStats>();
  private readonly lastHitAt = new Map<number, number>();
  private readonly heardAt = new Map<number, Vec3>();
  private readonly lossStreak: Record<'T' | 'CT', number> = { T: 0, CT: 0 };
  /** Victim ids whose death has already been scored this round. */
  private readonly accounted = new Set<number>();
  private controllers = new Map<number, BotController>();
  /**
   * One command buffer per bot, keyed by actor id.
   *
   * This MUST be per-player: `BotController.update` mutates the command object it
   * is handed (button fields one by one, then yaw/pitch). A single shared object
   * made every bot overwrite its team-mates' inputs, so the last writer in the
   * tick decided everyone's buttons and every bot then measured its aim against
   * another bot's yaw — which silently froze most of them (`shouldFire` compares
   * the desired angle to `cmd.yaw`) and cross-wired their trigger state.
   */
  private readonly botCmds = new Map<number, InputCommand>();
  private readonly objective: BotObjective = { kind: 'attack', goalNode: -1, site: null };
  private readonly deaths: PendingDeath[] = [];
  /** Bus unsubscribers, so `dispose()` can hand the shared bus back clean. */
  private readonly offs: (() => void)[] = [];
  private readonly perShooter = new Map<number, ActorHitbox[]>();
  /** Hitboxes of every live actor: rebuilt once per tick, filtered per shooter. */
  private hitboxes: ActorHitbox[] = [];
  private roundEndTimer = 0;
  private warmupRespawnAt = 0;
  private plantProgress = 0;
  private plantActorId = -1;
  /** Rotated once per round so a bot team does not always stack one spot. */
  private siteIndex = 0;
  /** Scratch for the body-vs-body separation pass; see `separatePlayers`. */
  private readonly pushProbe = v3();
  private readonly pushExtents = { ex: 0, ey: 0, ez: 0 };

  constructor(options: MatchOptions) {
    this.bus = options.bus;
    this.world = options.world;
    this.map = options.map;
    this.rng = options.rng ?? new Rng(0x5eed117e);
    this.difficulty = options.difficulty ?? 'normal';
    this.humanTeam = options.humanTeam === 'T' ? 'T' : 'CT';

    this.nav = new NavGraph(this.map);
    this.nav.attachWorld(this.world);

    this.combat = new CombatSystem({
      world: this.world,
      bus: this.bus,
      getActor: (id) => this.byId.get(id)?.combatRef,
      rng: this.rng,
    });

    this.local = this.createTeams(options);
    // Only the human hears a round snap past; bots all share the same bullets.
    this.combat.setListener(this.local.id);
    this.installShotContext();
    this.wireEvents();

    if (options.skipWarmup) this.beginRound(1);
  }

  // ---------------------------------------------------------------------------
  // setup
  // ---------------------------------------------------------------------------

  private createTeams(options: MatchOptions): Player {
    const botsPerTeam = options.botsPerTeam ?? RULES.botsPerTeam;
    const spawnsOf = (team: Team) =>
      this.map.spawns.filter((s) => s.team === team).sort((a, b) => a.index - b.index);
    const tSpawns = spawnsOf('T');
    const ctSpawns = spawnsOf('CT');
    const names: Record<Side, readonly string[]> = { T: MATCH.botNamesT, CT: MATCH.botNamesCT };

    let nextId = 1;
    let human: Player | null = null;

    const build = (team: Side, count: number, spawns: typeof tSpawns) => {
      for (let i = 0; i < count; i++) {
        const spawn = spawns[i % Math.max(1, spawns.length)];
        const isHuman = team === this.humanTeam && human === null;
        const id = nextId++;
        const name = isHuman
          ? options.humanName ?? MATCH.playerName
          : names[team][i % names[team].length];
        const player = new Player(
          {
            id,
            name,
            team,
            isBot: !isHuman,
            pos: spawn ? spawn.pos : { x: 0, y: 64, z: 0 },
            displayName: name,
          },
          this.world,
          this.combat,
          this.bus,
          isHuman ? options.rig : undefined,
        );
        if (spawn) player.state.yaw = spawn.yaw;
        this.register(player);
        if (isHuman) human = player;
        else this.spawnController(player);
      }
    };

    // The human's team fields the human plus `botsPerTeam` bots; the enemy team
    // gets one more so both sides end up five strong.
    const humanSideCount = Math.max(1, botsPerTeam + 1);
    const enemyCount = Math.max(1, botsPerTeam + 1);
    if (this.humanTeam === 'T') {
      build('T', humanSideCount, tSpawns);
      build('CT', enemyCount, ctSpawns);
    } else {
      build('CT', humanSideCount, ctSpawns);
      build('T', enemyCount, tSpawns);
    }
    if (!human) throw new Error('Match: failed to create the human player');
    return human;
  }

  private spawnController(player: Player): void {
    this.controllers.set(
      player.id,
      new BotController({
        id: player.id,
        team: player.team,
        difficulty: this.difficulty,
        nav: this.nav,
        world: this.world,
        seed: player.id * 7919 + 13,
      }),
    );
  }

  private register(player: Player): void {
    this.players.push(player);
    this.byId.set(player.id, player);
    this.money.set(player.id, RULES.startMoney);
    this.stats.set(player.id, { kills: 0, deaths: 0, score: 0, plants: 0, defuses: 0 });
  }

  /**
   * Hand every shooter the list of actors it may hit. The ballistics layer does
   * NOT filter by team (by contract it receives opponents only), so filtering
   * lives here — built once per tick and filtered per shooter.
   */
  private installShotContext(): void {
    const context: PlayerShotContext = {
      targetsFor: (shooterId, team) => {
        let list = this.perShooter.get(shooterId);
        if (!list) {
          list = [];
          this.perShooter.set(shooterId, list);
        }
        list.length = 0;
        for (let i = 0; i < this.hitboxes.length; i++) {
          const hitbox = this.hitboxes[i];
          const actor = this.byId.get(hitbox.entityId);
          if (!actor || actor.id === shooterId || actor.team === team) continue;
          list.push(hitbox);
        }
        return list;
      },
      rng: this.rng,
    };
    for (const player of this.players) player.setShotContext(context);
  }

  /**
   * Kill credit, hit feedback and gunshot hearing all arrive as events. Kills are
   * read off the bus rather than from `combat.onDamage` so a fall or a bomb gets
   * the same treatment as a rifle.
   */
  private wireEvents(): void {
    this.offs.push(
      this.bus.on('death', (e) => {
        if (this.accounted.has(e.victimId)) return;
        this.accounted.add(e.victimId);
        this.deaths.push({
          victimId: e.victimId,
          killerId: e.killerId,
          weaponId: e.weaponId,
          headshot: e.headshot,
          wallbang: e.wallbang,
        });
      }),
    );

    this.offs.push(
      this.bus.on('hit', (e) => {
        this.lastHitAt.set(e.targetId, this.now);
      }),
    );

    this.offs.push(
      this.bus.on('shot', (e) => {
        if (e.silenced) return;
        for (const player of this.players) {
          if (!player.isBot || !player.state.alive) continue;
          if (player.team === this.byId.get(e.shooterId)?.team) continue;
          if (distanceXZ(player.state.pos, e.origin) > GUNSHOT_HEARING_RANGE) continue;
          this.heardAt.set(player.id, { x: e.origin.x, y: e.origin.y, z: e.origin.z });
        }
      }),
    );
  }

  // ---------------------------------------------------------------------------
  // accessors for the engine / HUD
  // ---------------------------------------------------------------------------

  moneyOf(id: number): number {
    return this.money.get(id) ?? 0;
  }

  statsOf(id: number): PlayerStats {
    return this.stats.get(id) ?? { kills: 0, deaths: 0, score: 0, plants: 0, defuses: 0 };
  }

  playersOf(team: Team): Player[] {
    return this.players.filter((p) => p.team === team);
  }

  aliveOf(team: Team): Player[] {
    return this.players.filter((p) => p.team === team && p.state.alive);
  }

  /** True while the buy menu may be used (freeze time + the early live round). */
  get buyWindowOpen(): boolean {
    if (this.matchOver) return false;
    if (this.phase === 'warmup' || this.phase === 'freeze') return true;
    if (this.phase === 'live' || this.phase === 'bomb') {
      const elapsed = RULES.roundTime - Math.max(0, this.timeLeft);
      return elapsed <= Math.max(0, RULES.buyTime - RULES.freezeTime);
    }
    return false;
  }

  isInsideBuyZone(pos: Vec3, team: Team): boolean {
    for (const zone of this.map.buyZones) {
      if (zone.team !== team) continue;
      const minX = Math.min(zone.min.x, zone.max.x);
      const maxX = Math.max(zone.min.x, zone.max.x);
      const minY = Math.min(zone.min.y, zone.max.y) - SITE_Y_TOLERANCE;
      const maxY = Math.max(zone.min.y, zone.max.y) + SITE_Y_TOLERANCE;
      const minZ = Math.min(zone.min.z, zone.max.z);
      const maxZ = Math.max(zone.min.z, zone.max.z);
      if (pos.x >= minX && pos.x <= maxX && pos.y >= minY && pos.y <= maxY && pos.z >= minZ && pos.z <= maxZ) {
        return true;
      }
    }
    return false;
  }

  private siteAt(pos: Vec3): 'A' | 'B' | null {
    for (const region of this.map.sites) {
      if (Math.abs(pos.y - region.y) > SITE_Y_TOLERANCE) continue;
      if (pointInPoly(region.poly, pos.x, pos.z)) return region.site;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // the tick
  // ---------------------------------------------------------------------------

  /**
   * Advance the whole match one fixed tick.
   *
   * @param humanCmd command sampled from the human's input for this exact tick.
   * @param dt       tick length in seconds (TICK_DT).
   */
  tick(humanCmd: InputCommand, dt: number): void {
    this.now += dt;
    this.updateRoundClock(dt);
    this.refreshHitboxes();

    for (const player of this.players) {
      const cmd = player === this.local ? humanCmd : this.botCommandFor(player);
      player.canBuyNow = this.canBuy(player);
      player.step(cmd, dt, this.now, this.moneyOf(player.id));
      this.updateWeaponsOnGround(player, cmd);
    }

    this.separatePlayers();
    this.resolveDeaths();
    this.updateBomb(dt);
    this.checkRoundEnd();
  }

  /**
   * Keep bodies from occupying the same spot.
   *
   * Bots steer towards shared goal nodes, so without this an entire team ends up
   * standing in one coordinate and reads as a single bot. CS players block each
   * other, so the honest fix is physical: overlapping bodies are pushed apart.
   * Two rules keep it safe:
   *
   *  - the human is never pushed. A team-mate's elbow must not shove the player's
   *    camera around, and the player must never be denied a duel by it.
   *  - a push that would put a body inside a wall is dropped whole, so nobody is
   *    ever squeezed through a doorway by the pass.
   *
   * Only horizontal offsets are applied and the floor is never written, so the
   * next movement tick re-solves gravity and the ground snap as usual.
   */
  private separatePlayers(): void {
    const actors = this.players;
    for (let i = 0; i < actors.length; i += 1) {
      const a = actors[i];
      if (!a.state.alive) continue;
      for (let j = i + 1; j < actors.length; j += 1) {
        const b = actors[j];
        if (!b.state.alive) continue;
        // Bodies on different floors (a crate, a stair) never push each other.
        if (Math.abs(a.state.pos.y - b.state.pos.y) > PLAYER.standHeight) continue;

        let dx = b.state.pos.x - a.state.pos.x;
        let dz = b.state.pos.z - a.state.pos.z;
        let dist = Math.sqrt(dx * dx + dz * dz);
        if (dist >= SEPARATION_DISTANCE) continue;
        if (dist < 1e-4) {
          // Exactly co-located: split along a stable, id-derived axis instead of
          // dividing by zero, so the pair separates deterministically.
          const angle = a.id * 2.399963 + b.id * 0.7;
          dx = Math.cos(angle);
          dz = Math.sin(angle);
          dist = 1;
        }
        const nx = dx / dist;
        const nz = dz / dist;
        const push = Math.min(SEPARATION_DISTANCE - dist, SEPARATION_MAX_PUSH);

        const aIsHuman = a === this.local;
        const bIsHuman = b === this.local;
        if (aIsHuman && bIsHuman) continue;
        const aShare = aIsHuman ? 0 : bIsHuman ? 1 : 0.5;
        const bShare = bIsHuman ? 0 : aIsHuman ? 1 : 0.5;
        if (aShare > 0) this.tryPush(a, -nx * push * aShare, -nz * push * aShare);
        if (bShare > 0) this.tryPush(b, nx * push * bShare, nz * push * bShare);
      }
    }
  }

  /**
   * Offset one body by (dx, dz) unless the result would put it inside a wall.
   * Dropping the push entirely is deliberate: two bots standing close is a far
   * smaller defect than a bot pushed through the level.
   */
  private tryPush(player: Player, dx: number, dz: number): void {
    const state = player.state;
    const fromX = state.pos.x;
    const fromZ = state.pos.z;
    playerExtents(state.duckAmount, this.pushExtents);
    state.pos.x = fromX + dx;
    state.pos.z = fromZ + dz;
    this.pushProbe.x = state.pos.x;
    this.pushProbe.y = state.pos.y + this.pushExtents.ey;
    this.pushProbe.z = state.pos.z;
    const blocked = boxOverlapsWorld(
      this.world,
      this.pushProbe,
      this.pushExtents.ex - 0.5,
      this.pushExtents.ey - 0.5,
      this.pushExtents.ez - 0.5,
    );
    if (blocked) {
      state.pos.x = fromX;
      state.pos.z = fromZ;
    }
  }

  private botCommandFor(player: Player): InputCommand {
    const controller = this.controllers.get(player.id);
    if (!controller) return this.idleCommand(player);
    const def = player.weapon;
    const state = this.combat.getWeaponState(player.id, def.id, def);
    const lastHit = this.lastHitAt.get(player.id) ?? -Infinity;
    this.updateTeamObjective(player.team);
    return controller.update({
      self: player.state,
      actors: this.actorStates(),
      weapon: def,
      ammo: state.ammo,
      reserve: state.reserve,
      magazineFull: state.ammo >= def.magazine,
      reloading: state.reloadTimer > 0,
      canShoot:
        state.ammo > 0 && state.reloadTimer <= 0 && player.pendingSlot === null && player.scopeTimer <= 0,
      now: this.now,
      objective: this.objective,
      senses: {
        underFire: this.now - lastHit < 3,
        heardAt: this.heardAt.get(player.id) ?? null,
        bombPlanted: this.bombState === 'planted',
        bombPos: this.bombState === 'planted' ? this.bombPos : null,
        // Exact polygon test: `tryPlant`/`tryDefuse` use the same predicate, so the
        // brain's idea of "standing on the site" can never disagree with the rule that
        // actually completes the plant.
        insideSite: this.objective.site !== null && this.siteAt(player.state.pos) === this.objective.site,
      },
      cmd: this.botCommand(player),
    });
  }

  /**
   * The persistent command buffer for one bot, seeded from its current view.
   *
   * The controller owns `buttons`/`yaw`/`pitch` for the rest of the tick; the
   * caller owns the tick stamp and the raw mouse deltas (bots have none). The
   * view is re-seeded from the actor every tick so the brain's turn-rate
   * integrator picks up exactly where the last tick left off (and cannot be
   * thrown off by a respawn resetting the actor's yaw).
   */
  private botCommand(player: Player): InputCommand {
    let cmd = this.botCmds.get(player.id);
    if (!cmd) {
      cmd = createBotCommand();
      this.botCmds.set(player.id, cmd);
    }
    cmd.tick = 0;
    cmd.yaw = player.state.yaw;
    cmd.pitch = player.state.pitch;
    cmd.mouseDX = 0;
    cmd.mouseDY = 0;
    return cmd;
  }

  /** A command that holds the actor still. Only used for a controller-less bot. */
  private idleCommand(player: Player): InputCommand {
    return {
      tick: 0,
      buttons: { ...EMPTY_BUTTONS },
      yaw: player.state.yaw,
      pitch: player.state.pitch,
      mouseDX: 0,
      mouseDY: 0,
    };
  }

  private actorStates(): ActorState[] {
    const out: ActorState[] = [];
    for (const p of this.players) out.push(p.state);
    return out;
  }

  private refreshHitboxes(): void {
    const live: ActorState[] = [];
    for (const p of this.players) if (p.state.alive) live.push(p.state);
    this.hitboxes = buildAllHitboxes(live, this.hitboxes);
    this.world.registerActors(this.hitboxes);
  }

  /** What the team is trying to do this tick, for the bot brains. */
  private updateTeamObjective(team: Team): void {
    const planted = this.bombState === 'planted';
    if (team === 'T') {
      if (planted) {
        this.objective.kind = 'post_plant';
        this.objective.site = this.bombSite;
        this.objective.goalNode = this.nodeNear(this.bombSite, this.bombPos);
      } else {
        this.objective.kind = 'attack';
        this.objective.site = this.targetSite;
        this.objective.goalNode = this.siteGoalNode(this.targetSite);
      }
      return;
    }
    if (planted) {
      this.objective.kind = 'retake';
      this.objective.site = this.bombSite;
      this.objective.goalNode = this.nodeNear(this.bombSite, this.bombPos);
    } else {
      this.objective.kind = 'defend';
      this.objective.site = this.targetSite;
      this.objective.goalNode = this.siteGoalNode(this.targetSite);
    }
  }

  private siteGoalNode(site: 'A' | 'B'): number {
    const nodes = this.nav.siteNodes(site);
    if (nodes.length === 0) return -1;
    return nodes[Math.abs(this.siteIndex) % nodes.length];
  }

  private nodeNear(site: 'A' | 'B', pos: Vec3): number {
    const nodes = this.nav.siteNodes(site);
    if (nodes.length === 0) return this.nav.nearestNode(pos);
    let best = nodes[0];
    let bestDist = Infinity;
    for (const id of nodes) {
      const node = this.nav.nodes[id];
      if (!node) continue;
      const d = distanceXZ(node.pos, pos);
      if (d < bestDist) {
        bestDist = d;
        best = id;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------------------
  // round clock
  // ---------------------------------------------------------------------------

  private updateRoundClock(dt: number): void {
    switch (this.phase) {
      case 'warmup':
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) this.beginRound(1);
        break;
      case 'freeze':
        this.timeLeft -= dt;
        if (this.timeLeft <= 0) {
          this.phase = 'live';
          this.timeLeft = RULES.roundTime;
          this.bus.emit('roundPhase', {
            phase: 'live',
            timeLeft: this.timeLeft,
            roundNumber: this.roundNumber,
          });
          this.bus.emit('announce', { text: `Round ${this.roundNumber} — go!`, kind: 'round' });
        }
        break;
      case 'live':
      case 'bomb':
        this.timeLeft -= dt;
        break;
      case 'over':
        if (this.matchOver) break;
        this.roundEndTimer -= dt;
        if (this.roundEndTimer <= 0) this.beginRound(this.roundNumber + 1);
        break;
      default:
        break;
    }
  }

  /** Reset everyone, hand out the bomb, let the bots shop, and freeze. */
  private beginRound(roundNumber: number): void {
    this.roundNumber = roundNumber;
    // MR12: the sides switch after round 12.
    if (roundNumber > 1 && roundNumber - 1 === RULES.maxRounds / 2) this.swapSides();

    this.phase = 'freeze';
    this.timeLeft = RULES.freezeTime;
    this.roundEndTimer = 0;
    this.targetSite = this.rng.bool(0.5) ? 'A' : 'B';
    this.siteIndex = this.rng.int(0, 8);
    this.plantProgress = 0;
    this.plantActorId = -1;
    this.defuserId = -1;
    this.defuseProgress = 0;
    this.bombTimer = 0;
    this.bombState = 'carried';
    this.accounted.clear();
    // Every round starts on clean ground: the losers of the last round are
    // re-pistolled here, and a field of 24 inherited rifles would quietly turn
    // the buy menu into a suggestion.
    this.groundWeapons.length = 0;

    const spawnsOf = (team: Team) => this.map.spawns.filter((s) => s.team === team);
    let slot = 0;
    for (const player of this.players) {
      const spawns = spawnsOf(player.team);
      const spawn = spawns.length > 0 ? spawns[slot++ % spawns.length] : null;
      // Losing armour with the round is a deliberate simplification: kevlar is a
      // per-round purchase here, and bots rebuy it, so the economy still bites.
      player.respawn(spawn ? spawn.pos : { x: 0, y: 64, z: 0 }, 100, 0, false);
      if (spawn) player.state.yaw = spawn.yaw;
      player.resetRoundLoadout(player.team === 'T' ? 'glock' : 'usp');
      player.refillAllAmmo();
      this.bus.emit('spawn', { actorId: player.id, team: player.team });
    }

    const ts = this.aliveOf('T');
    if (ts.length > 0) {
      const carrier = this.rng.pick(ts);
      carrier.giveWeapon('c4');
      this.bombCarrierId = carrier.id;
    }

    for (const player of this.players) {
      if (!player.isBot) continue;
      this.controllers.get(player.id)?.resetForRound();
      this.botBuy(player);
    }
    this.refreshHitboxes();
    this.bus.emit('roundPhase', { phase: 'freeze', timeLeft: this.timeLeft, roundNumber });
  }

  /** MR12 half time: swap every player's side and rebuild the bot brains. */
  private swapSides(): void {
    for (const player of this.players) {
      const team = otherTeam(player.team);
      player.team = team;
      player.state.team = team;
      if (!player.isBot) continue;
      this.controllers.get(player.id)?.resetForRound();
    }
    this.controllers = new Map();
    for (const player of this.players) if (player.isBot) this.spawnController(player);
    this.bus.emit('announce', { text: 'Halftime — sides switched', kind: 'round' });
  }

  // ---------------------------------------------------------------------------
  // deaths and economy
  // ---------------------------------------------------------------------------

  private resolveDeaths(): void {
    if (this.deaths.length === 0) return;
    for (const death of this.deaths) {
      const victim = this.byId.get(death.victimId);
      const killer = this.byId.get(death.killerId);
      const vs = this.statsOf(death.victimId);
      this.stats.set(death.victimId, { ...vs, deaths: vs.deaths + 1 });

      if (killer && killer.id !== death.victimId) {
        const ks = this.statsOf(killer.id);
        this.stats.set(killer.id, {
          ...ks,
          kills: ks.kills + 1,
          score: ks.score + (death.headshot ? 2 : 1),
        });
        const reward = weaponById(death.weaponId)?.killReward ?? COMBAT.defaultKillReward;
        this.addMoney(killer.id, reward);
      }
      // Tells the Player its death was accounted for exactly once (this also
      // re-emits `death`, which the guard above swallows).
      victim?.reportDeath(death.killerId, death.weaponId, death.headshot, death.wallbang);
      if (victim?.hasBomb) this.dropBomb(victim.state.pos);
      if (victim) this.dropAllWeapons(victim, victim.state.pos);
      if (victim && victim.id === this.defuserId) {
        this.defuserId = -1;
        this.defuseProgress = 0;
      }
      if (this.phase === 'warmup') this.warmupRespawnAt = this.now + WARMUP_RESPAWN_DELAY;
    }
    this.deaths.length = 0;

    if (this.phase === 'warmup' && this.now >= this.warmupRespawnAt) {
      for (const player of this.players) {
        if (player.state.alive) continue;
        const spawns = this.map.spawns.filter((s) => s.team === player.team);
        const spawn = spawns[0] ?? null;
        player.respawn(spawn ? spawn.pos : { x: 0, y: 64, z: 0 }, 100, 0, false);
      }
    }
  }

  addMoney(id: number, amount: number): void {
    const next = Math.max(0, Math.min(RULES.maxMoney, this.moneyOf(id) + amount));
    this.money.set(id, next);
  }

  /**
   * Round-end awards. `reason` decides the special cases: a bomb win pays more,
   * and a T side that planted but still lost keeps its plant bonus.
   */
  private rewardTeams(winner: Team, reason: string): void {
    const plantedButLost = reason === 'defused';
    for (const team of ['T', 'CT'] as const) {
      if (team === winner) {
        const win = reason === 'bomb' ? RULES.winRewardBombPlant : RULES.winReward;
        this.lossStreak[team] = 0;
        for (const player of this.playersOf(team)) this.addMoney(player.id, win);
        continue;
      }
      const streak = Math.min(this.lossStreak[team], 4);
      let loss = Math.min(RULES.lossRewardMax, RULES.lossRewardBase + streak * RULES.lossRewardStep);
      if (team === 'T' && plantedButLost) loss += RULES.bombPlantTeamReward;
      this.lossStreak[team] = streak + 1;
      for (const player of this.playersOf(team)) this.addMoney(player.id, loss);
    }
  }

  // ---------------------------------------------------------------------------
  // buying
  // ---------------------------------------------------------------------------

  canBuy(player: Player): boolean {
    if (!player.state.alive || this.matchOver) return false;
    if (!this.buyWindowOpen) return false;
    return this.isInsideBuyZone(player.state.pos, player.team);
  }

  /** Buy a weapon or equipment item. The result tells the UI which sound to play. */
  buy(id: number, itemId: BuyableId): BuyOutcome {
    const player = this.byId.get(id);
    if (!player) return { ok: false, reason: 'unknown' };
    if (!player.state.alive) return { ok: false, reason: 'dead' };
    if (!this.buyWindowOpen) return { ok: false, reason: 'not-buy-time' };
    if (!this.isInsideBuyZone(player.state.pos, player.team)) return { ok: false, reason: 'not-buy-zone' };

    const equipmentPrice = EQUIPMENT_PRICE[itemId];
    if (equipmentPrice !== undefined) {
      return this.buyEquipment(player, itemId as EquipmentId, equipmentPrice);
    }

    const def = weaponById(itemId);
    if (!def) return { ok: false, reason: 'unknown' };
    const price = def.price;
    if (this.moneyOf(id) < price) return { ok: false, reason: 'money' };
    if (def.slot !== 'grenade' && player.weaponIdForSlot(def.slot) === def.id) {
      return { ok: false, reason: 'already-owned' };
    }
    if (!player.giveWeapon(def.id, true)) return { ok: false, reason: 'unknown' };
    this.addMoney(id, -price);
    this.bus.emit('buy', { actorId: id, weaponId: def.id, price });
    return { ok: true, price };
  }

  private buyEquipment(player: Player, item: EquipmentId, price: number): BuyOutcome {
    if (this.moneyOf(player.id) < price) return { ok: false, reason: 'money' };
    if (item === 'defusekit') {
      if (player.team !== 'CT') return { ok: false, reason: 'unknown' };
      if (player.hasDefuseKit) return { ok: false, reason: 'already-owned' };
      player.hasDefuseKit = true;
      player.state.hasDefuseKit = true;
    } else {
      const withHelmet = item === 'kevlarhelmet';
      if (player.state.armor >= 100 && (!withHelmet || player.state.helmet)) {
        return { ok: false, reason: 'already-owned' };
      }
      player.state.armor = 100;
      if (withHelmet) player.state.helmet = true;
    }
    this.addMoney(player.id, -price);
    this.bus.emit('buy', { actorId: player.id, weaponId: item, price });
    return { ok: true, price };
  }

  /**
   * A deliberately simple, CS-shaped bot buy: armour first, then the best gun the
   * money allows. Bots never buy grenades (there is no grenade table in the
   * weapon registry, so there is no grenade economy to spend on).
   */
  private botBuy(player: Player): void {
    const money = this.moneyOf(player.id);
    const rifle = player.team === 'T' ? 'ak47' : this.rng.bool(0.5) ? 'm4a4' : 'm4a1s';
    const smg = player.team === 'T' ? 'mac10' : 'mp9';
    const tryBuy = (item: string): boolean => this.buy(player.id, item).ok;

    if (money >= 6000 && this.rng.bool(0.12) && tryBuy('awp')) {
      tryBuy('kevlarhelmet');
      return;
    }
    if (money >= 3700 && tryBuy(rifle)) {
      tryBuy('kevlarhelmet');
      if (player.team === 'CT' && this.moneyOf(player.id) >= EQUIPMENT_PRICE.defusekit) {
        tryBuy('defusekit');
      }
      return;
    }
    if (money >= 2400 && tryBuy(rifle)) {
      tryBuy('kevlar');
      return;
    }
    if (money >= 2000 && tryBuy(smg) && tryBuy('kevlar')) return;
    if (money >= 1000 && tryBuy('kevlarhelmet')) return;
    if (money >= 700) tryBuy(player.team === 'T' ? 'deagle' : 'p250');
  }

  // ---------------------------------------------------------------------------
  // weapons on the floor
  // ---------------------------------------------------------------------------

  /**
   * Put the gun in `slot` on the floor at `pos` and take it off its owner.
   *
   * The magazine travels with the gun: whoever picks it up next inherits the
   * rounds that were in it. Combat keeps ammo per (actor, weapon) and that state
   * survives a round, so the drop has to read it out here and the pickup has to
   * write it back - otherwise the new owner gets whatever was in their own last
   * copy of that weapon.
   *
   * @returns the entity that was created, or null when the slot was empty.
   */
  private dropWeapon(player: Player, slot: WeaponSlot, pos: Vec3): GroundWeapon | null {
    const weaponId = player.weaponIdForSlot(slot);
    if (!weaponId) return null;
    const def = weaponById(weaponId);
    if (!def) return null;

    const st = this.combat.getWeaponState(player.id, def.id, def);
    const dropped: GroundWeapon = {
      id: this.nextGroundWeaponId,
      weaponId: def.id,
      kind: def.kind,
      ammo: st.ammo,
      reserve: st.reserve,
      pos: { x: pos.x, y: pos.y, z: pos.z },
      droppedAt: this.now,
    };
    this.nextGroundWeaponId += 1;
    player.removeWeapon(def.id);
    this.groundWeapons.push(dropped);
    // The floor is not a warehouse: the oldest gun falls out of the world.
    while (this.groundWeapons.length > GROUND_WEAPON_CAP) this.groundWeapons.shift();
    this.bus.emit('weaponDropped', { actorId: player.id, weaponId: def.id, pos: dropped.pos });
    return dropped;
  }

  /** Everything a body leaves behind: its primary and its secondary. */
  private dropAllWeapons(player: Player, pos: Vec3): void {
    for (const slot of DROPPABLE_SLOTS) this.dropWeapon(player, slot, pos);
  }

  /**
   * Drop and pick up, driven by each player's own command once per tick.
   *
   *  - `G` (a fresh press) drops the gun in hand, or the primary when the knife
   *    or a grenade is out.
   *  - walking over a gun picks it up while its slot is empty. That is how the
   *    bomb behaves here and how CS behaves: a free hand just grabs.
   *  - `E` (a fresh press) swaps: the gun that was in the slot falls at the
   *    player's feet carrying its own magazine.
   *
   * Nothing can be picked up for `WEAPON_SETTLE_TIME` after it lands, otherwise
   * `G` would look broken - its owner is standing on the drop.
   */
  private updateWeaponsOnGround(player: Player, cmd: InputCommand): void {
    const use = cmd.buttons.use;
    const drop = cmd.buttons.drop;
    const usePressed = use && !this.useDown.get(player.id);
    const dropPressed = drop && !this.dropDown.get(player.id);
    this.useDown.set(player.id, use);
    this.dropDown.set(player.id, drop);

    if (!player.state.alive) return;
    if (this.phase === 'warmup' || this.phase === 'over') return;

    if (dropPressed) {
      const held = player.weapon.slot;
      const slot: WeaponSlot = held === 'primary' || held === 'secondary' ? held : 'primary';
      this.dropWeapon(player, slot, player.state.pos);
    }

    const gun = this.nearestGroundWeapon(player);
    if (!gun) return;
    // A gun that just landed is still in the air as far as the automatic grab is
    // concerned, but a deliberate `E` may take it right away.
    const settled = this.now - gun.droppedAt >= WEAPON_SETTLE_TIME;
    if (!settled && !usePressed) return;
    const def = weaponById(gun.weaponId);
    if (!def) return;

    const occupied = player.weaponIdForSlot(def.slot) !== null;
    if (occupied && !usePressed) return;
    if (occupied) this.dropWeapon(player, def.slot, player.state.pos);

    player.giveWeapon(def.id);
    const st = this.combat.getWeaponState(player.id, def.id, def);
    st.ammo = gun.ammo;
    st.reserve = gun.reserve;
    st.reloadTimer = 0;
    // Consume the press that grabbed the gun, so the trigger it was held down
    // with cannot fire the first shot of an inherited magazine by surprise.
    st.triggerPressed = true;
    this.removeGroundWeapon(gun.id);
    this.bus.emit('weaponPickup', { actorId: player.id, weaponId: def.id, swapped: occupied });
  }

  /**
   * Closest gun on the floor within reach of `player`, or null.
   *
   * Distance is the main rule, but a body drops its primary and its secondary on
   * the same spot, so a pile of two guns sits at exactly distance 0 from the player
   * standing on it. Those ties are broken by usefulness: a gun that would fill an
   * empty slot wins first (that is the one a walk-over grab will take), then one
   * matching the slot in hand (so `E` swaps like for like), and finally the freshest
   * drop — the one the player just watched land.
   */
  nearestGroundWeapon(player: Player): GroundWeapon | null {
    const pos = player.state.pos;
    const held = player.weapon.slot;
    let best: GroundWeapon | null = null;
    let bestDist = WEAPON_PICKUP_RANGE;
    let bestRank = -1;
    for (const gun of this.groundWeapons) {
      const d = distanceXZ(gun.pos, pos);
      if (d > bestDist) continue;
      const def = weaponById(gun.weaponId);
      if (!def) continue;
      const rank = player.weaponIdForSlot(def.slot) === null ? 2 : def.slot === held ? 1 : 0;
      const better =
        best === null ||
        d < bestDist ||
        (d === bestDist && (rank > bestRank || (rank === bestRank && gun.droppedAt > best.droppedAt)));
      if (!better) continue;
      best = gun;
      bestDist = d;
      bestRank = rank;
    }
    return best;
  }

  private removeGroundWeapon(id: number): void {
    const i = this.groundWeapons.findIndex((g) => g.id === id);
    if (i >= 0) this.groundWeapons.splice(i, 1);
  }

  // ---------------------------------------------------------------------------
  // the bomb
  // ---------------------------------------------------------------------------

  private updateBomb(dt: number): void {
    if (this.phase === 'warmup' || this.phase === 'over') return;

    if (this.bombState === 'carried') {
      const carrier = this.byId.get(this.bombCarrierId);
      if (!carrier || !carrier.state.alive) {
        if (carrier) this.dropBomb(carrier.state.pos);
        return;
      }
      this.tryPlant(carrier, dt);
      return;
    }

    if (this.bombState === 'dropped') {
      for (const t of this.aliveOf('T')) {
        if (distanceXZ(t.state.pos, this.bombPos) > BOMB_INTERACT_RANGE) continue;
        t.giveWeapon('c4');
        this.bombCarrierId = t.id;
        this.bombState = 'carried';
        this.bus.emit('bombPickup', { actorId: t.id, dropped: true });
        return;
      }
      return;
    }

    if (this.bombState !== 'planted') return;

    this.bombTimer -= dt;
    this.tryDefuse(dt);
    if (this.bombTimer <= 0) {
      this.bombTimer = 0;
      this.bombState = 'exploded';
      this.bus.emit('bombExploded', { site: this.bombSite });
      this.endRound('T', 'bomb');
    }
  }

  private dropBomb(pos: Vec3): void {
    const carrier = this.byId.get(this.bombCarrierId);
    if (carrier) {
      carrier.hasBomb = false;
      carrier.state.hasBomb = false;
      carrier.removeWeapon('c4');
    }
    this.bombPos = { x: pos.x, y: pos.y, z: pos.z };
    this.bombCarrierId = -1;
    this.bombState = 'dropped';
    this.bus.emit('bombPickup', { actorId: -1, dropped: true });
  }

  private tryPlant(carrier: Player, dt: number): void {
    const site = this.siteAt(carrier.state.pos);
    const standingStill = Math.hypot(carrier.state.vel.x, carrier.state.vel.z) <= BOMB_STILL_SPEED;
    if (!site || !carrier.useHeld || !standingStill) {
      this.plantProgress = 0;
      this.plantActorId = -1;
      return;
    }
    if (this.plantActorId !== carrier.id) {
      this.plantActorId = carrier.id;
      this.plantProgress = 0;
    }
    this.plantProgress += dt;
    if (this.plantProgress < PLANT_TIME) return;

    this.plantProgress = 0;
    this.plantActorId = -1;
    this.bombState = 'planted';
    this.bombSite = site;
    this.bombPos = { x: carrier.state.pos.x, y: carrier.state.pos.y, z: carrier.state.pos.z };
    this.bombTimer = RULES.bombTimer;
    carrier.hasBomb = false;
    carrier.state.hasBomb = false;
    carrier.removeWeapon('c4');
    this.phase = 'bomb';

    const stats = this.statsOf(carrier.id);
    this.stats.set(carrier.id, { ...stats, plants: stats.plants + 1, score: stats.score + 2 });
    this.addMoney(carrier.id, RULES.bombPlantReward);
    this.bus.emit('bombPlanted', { site, pos: this.bombPos, actorId: carrier.id });
  }

  private tryDefuse(dt: number): void {
    if (this.defuserId < 0) {
      for (const ct of this.aliveOf('CT')) {
        if (distanceXZ(ct.state.pos, this.bombPos) > BOMB_INTERACT_RANGE) continue;
        if (!ct.useHeld) continue;
        this.defuserId = ct.id;
        this.defuseProgress = 0;
        break;
      }
      if (this.defuserId < 0) return;
    }
    const ct = this.byId.get(this.defuserId);
    const stillClose = ct ? distanceXZ(ct.state.pos, this.bombPos) <= BOMB_INTERACT_RANGE : false;
    const standingStill = ct ? Math.hypot(ct.state.vel.x, ct.state.vel.z) <= BOMB_STILL_SPEED : false;
    if (!ct || !ct.state.alive || !stillClose || !standingStill || !ct.useHeld) {
      this.defuserId = -1;
      this.defuseProgress = 0;
      return;
    }
    const duration = ct.hasDefuseKit ? RULES.defuseTime : RULES.defuseTimeNoKit;
    this.defuseProgress += dt / duration;
    if (this.defuseProgress < 1) return;

    this.defuseProgress = 1;
    this.bombState = 'defused';
    const stats = this.statsOf(ct.id);
    this.stats.set(ct.id, { ...stats, defuses: stats.defuses + 1, score: stats.score + 2 });
    this.addMoney(ct.id, RULES.defuseReward);
    this.bus.emit('bombDefused', { actorId: ct.id });
    this.endRound('CT', 'defused');
  }

  // ---------------------------------------------------------------------------
  // round end
  // ---------------------------------------------------------------------------

  private checkRoundEnd(): void {
    if (this.phase === 'warmup' || this.phase === 'over' || this.phase === 'freeze') return;

    const planted = this.bombState === 'planted';
    const tAlive = this.aliveOf('T').length;
    const ctAlive = this.aliveOf('CT').length;

    // Wiping the defenders always wins, planted or not: with the bomb down there
    // is nobody left to defuse it.
    if (ctAlive === 0) {
      this.endRound('T', planted ? 'bomb' : 'elimination');
      return;
    }
    if (tAlive === 0) {
      this.endRound('CT', planted ? 'defused' : 'elimination');
      return;
    }
    if (!planted && this.timeLeft <= 0) this.endRound('CT', 'time');
  }

  private endRound(winner: Team, reason: string): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.roundEndTimer = RULES.roundEndDelay;
    this.defuserId = -1;
    this.defuseProgress = 0;
    this.rewardTeams(winner, reason);

    if (winner === 'T') this.scoreT++;
    else this.scoreCT++;

    this.bus.emit('roundEnd', { winner, reason, scoreT: this.scoreT, scoreCT: this.scoreCT });
    this.bus.emit('announce', { text: `${winner} win — ${describeReason(reason)}`, kind: 'round' });

    if (this.scoreT >= RULES.roundsToWin || this.scoreCT >= RULES.roundsToWin) {
      this.matchOver = true;
      this.winner = this.scoreT > this.scoreCT ? 'T' : 'CT';
    }
  }

  dispose(): void {
    for (const off of this.offs) {
      try {
        off();
      } catch {
        /* the bus may already be cleared */
      }
    }
    this.offs.length = 0;
    this.controllers.clear();
    this.perShooter.clear();
    this.deaths.length = 0;
    this.hitboxes = [];
    this.players.length = 0;
    this.byId.clear();
  }
}

function describeReason(reason: string): string {
  switch (reason) {
    case 'bomb':
      return 'the bomb went off';
    case 'defused':
      return 'the bomb was defused';
    case 'time':
      return 'time expired';
    default:
      return 'enemy eliminated';
  }
}