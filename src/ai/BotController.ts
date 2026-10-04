// =============================================================================
// ai/BotController.ts — the stateful per-bot wrapper.
//
// `Bot.ts` is deliberately pure: every function takes all of its state as
// arguments, which is what makes the decision core replayable and testable. This
// file is the other half of that split — the small amount of state a live bot
// genuinely needs to own between ticks:
//
//   * the `BotMemory` blob (contacts, sounds, spray counter, goal hysteresis);
//   * the `BotSenses` record (perception results the HUD can also read);
//   * the path `PathFollower` (position along the current route);
//   * the difficulty's `BotSkill`, with the reaction-time jitter rolled ONCE at
//     construction so a bot is not a fixed reaction-time robot all round.
//
// It owns no simulation state and makes no decisions of its own: `update` fills in
// the seven context fields the controller is responsible for, then calls
// `perceive` -> `chooseGoal` -> `think` in that order. If you are looking for what
// a bot actually *does*, read `Bot.ts`; this file is bookkeeping.
// =============================================================================

import type { InputCommand, Team, ActorState } from '../core/types';
import { Rng } from '../core/rng';
import type { World } from '../world/world';
import type { NavGraph } from './navigation';

import {
  BOT_SKILLS,
  chooseGoal,
  createBotCommand,
  createBotMemory,
  createBotSenses,
  eyeHeight,
  perceive,
  think,
} from './Bot';
import type { BotContext, BotDifficulty, BotGoal, BotMemory, BotObjective, BotSenses, BotSkill } from './Bot';

/** Everything the game layer must supply to construct a bot controller. */
export interface BotControllerOptions {
  /** Unique actor id; the controller never changes it. */
  id: number;
  /** Which side the bot plays for. Immutable for the lifetime of the controller. */
  team: Team;
  /** Difficulty preset selected by the host (see `BOT_SKILLS`). */
  difficulty: BotDifficulty;
  /** Navigation graph for the current map. */
  nav: NavGraph;
  /** Collision world used for line-of-sight and aim verification. */
  world: World;
  /** Seed for this bot's own rng; defaults to a hash of `id` so bots differ. */
  seed?: number;
}

/**
 * The per-tick context the game layer must supply to `update`.
 *
 * Most fields come straight from `BotContext`; the controller owns `memory`,
 * `follower`, `cmd`, `team`, `nav` and `world`, so those are not the caller's to
 * supply. `self` is re-asserted explicitly because the caller passes a fresh actor
 * snapshot every tick, and `senses` is narrowed to just the perception inputs the
 * caller is responsible for deriving — the outputs (`visibleEnemies`, `targetId`,
 * `lastKnownEnemyPos`, `timeSinceSeen`) are computed by `perceive`.
 */
export interface BotControllerUpdate {
  /** The bot's actor snapshot for this tick. */
  self: ActorState;
  /** Every other actor in the match (both teams). */
  actors: readonly ActorState[];
  /** The weapon the bot is holding. */
  weapon: BotContext['weapon'];
  /** Ammo in the magazine; 0 triggers a reload request. */
  ammo: number;
  /** Rounds left in reserve; 0 with `ammo === 0` means the weapon cannot be reloaded. */
  reserve: number;
  /** True when the magazine is full (a reload would be wasted). */
  magazineFull: boolean;
  /** True while a reload animation is running. */
  reloading: boolean;
  /** True when the round is live and shooting is allowed. */
  canShoot: boolean;
  /** Current match time in seconds; monotonic. */
  now: number;
  /** Objective the bot's team is pursuing this round. */
  objective: BotObjective;
  /** Perception inputs derived by the game layer (damage direction, sounds, bomb). */
  senses: Pick<BotSenses, 'underFire' | 'heardAt' | 'bombPlanted' | 'bombPos'> & {
    /** Optional: the caller may not track site polygons, in which case it stays false. */
    insideSite?: boolean;
  };
  /** The caller-owned command object, mutated in place and returned. */
  cmd: InputCommand;
}

/**
 * A single bot: senses, memory, path following and difficulty in one object.
 *
 * Lifecycle is one instance per bot per match. `update` is called once per
 * simulation tick (see `TICK_RATE`); `repath` is called when the strategy layer
 * changes the objective. Nothing here needs a teardown.
 */
export class BotController {
  /** Unique actor id of the bot this controller drives. */
  readonly id: number;
  /** Which side the bot plays for. */
  readonly team: Team;
  /** The difficulty preset this bot was built with. */
  readonly difficulty: BotDifficulty;
  /** Persistent per-bot memory (contacts, sounds, shot burst, hysteresis). */
  readonly memory: BotMemory;
  /** Latest perception result; refreshed at the top of every `update`. */
  readonly senses: BotSenses;
  /** This bot's skill values, with its own reaction-time jitter already applied. */
  readonly skill: BotSkill;
  /** What the bot is currently trying to do, for debug HUDs and tests. */
  goal: BotGoal;

  private readonly nav: NavGraph;
  private readonly world: World;
  private readonly rng: Rng;

  /** Reused context handed to the pure functions; avoids one object per tick. */
  private readonly context: BotContext;
  /** The controller-owned command, used when the caller does not supply one. */
  private readonly fallbackCmd: InputCommand;
  /** Counts `update` calls, mirrored into `cmd.tick` only when the caller left it 0. */
  private tickCount = 0;

  constructor(options: BotControllerOptions) {
    this.id = options.id;
    this.team = options.team;
    this.difficulty = options.difficulty;
    this.nav = options.nav;
    this.world = options.world;
    this.rng = new Rng(options.seed ?? (0x9e3779b9 ^ (options.id * 2654435761)) >>> 0);

    const base = BOT_SKILLS[options.difficulty] ?? BOT_SKILLS.normal;
    // Reaction-time jitter: +/-20%, rolled exactly once per spawn from this bot's
    // own rng. Rolling per tick would give a bot an average reaction time but a
    // wildly inconsistent one; a fixed per-spawn offset makes bots feel like
    // individuals without making them unpredictable.
    const jitter = 0.8 + this.rng.float() * 0.4;
    this.skill = {
      reactionTime: base.reactionTime * jitter,
      aimError: base.aimError,
      sprayControl: base.sprayControl,
      preaimQuality: base.preaimQuality,
    };

    this.memory = createBotMemory();
    this.senses = createBotSenses();
    this.fallbackCmd = createBotCommand();
    this.goal = 'idle';

    this.context = {
      self: undefined as unknown as ActorState,
      actors: [],
      team: this.team,
      weapon: undefined as unknown as BotContext['weapon'],
      ammo: 0,
      reserve: 0,
      magazineFull: false,
      reloading: false,
      canShoot: false,
      now: 0,
      nav: this.nav,
      world: this.world,
      memory: this.memory,
      follower: null,
      objective: { kind: 'defend', goalNode: -1, site: null },
      cmd: this.fallbackCmd,
    };
  }

  /**
   * Per-tick entry point. Writes into `cmd` (which the caller owns and reuses) and
   * returns it.
   *
   * The caller passes everything that is genuinely per-tick (its actor snapshot, the
   * weapon in hand, ammo, clocks, the team objective) and the controller merges in
   * the state it owns. Perceive -> chooseGoal -> think, in that fixed order.
   */
  update(next: BotControllerUpdate): InputCommand {
    const ctx = this.context;
    const cmd = next.cmd ?? this.fallbackCmd;

    ctx.self = next.self;
    ctx.actors = next.actors;
    ctx.weapon = next.weapon;
    ctx.ammo = next.ammo;
    ctx.reserve = next.reserve;
    ctx.magazineFull = next.magazineFull;
    ctx.reloading = next.reloading;
    ctx.canShoot = next.canShoot;
    ctx.now = next.now;
    ctx.objective = next.objective;
    ctx.cmd = cmd;
    // `team`, `nav`, `world`, `memory` and `follower` are owned here and already set.

    // The senses record is `readonly` on the controller, so reset it field by field
    // rather than allocating. The caller-supplied perception inputs are copied first;
    // `perceive` then overwrites every field it computes.
    const senses = this.senses;
    senses.underFire = next.senses.underFire;
    senses.heardAt = next.senses.heardAt;
    senses.bombPlanted = next.senses.bombPlanted;
    senses.bombPos = next.senses.bombPos;
    senses.insideSite = next.senses.insideSite === true;

    perceive(ctx, senses, this.skill, this.rng);
    this.goal = chooseGoal(ctx, senses, this.skill, this.rng);
    think(ctx, senses, this.skill, this.rng);

    this.tickCount += 1;
    // The caller owns `cmd.tick`; only fill it when the caller has not.
    if (!Number.isFinite(cmd.tick) || cmd.tick === 0) cmd.tick = this.tickCount;

    return cmd;
  }

  /**
   * Force a repath (called when the objective changes or a teammate calls a
   * rotation).
   *
   * The context argument exists for interface compatibility with the frozen
   * signature and for callers that want to seed the new path immediately; the
   * controller only needs to drop the stale follower, and the next `update`
   * rebuilds it against the new objective.
   */
  repath(ctx: BotContext): void {
    void ctx;
    this.memory.pathGoalNode = -1;
    this.context.follower = null;
  }

  /** The most recent full context this controller decided with (debug/HUD use). */
  get lastContext(): Readonly<BotContext> {
    return this.context;
  }

  /** Clear round-scoped state (call at freeze-time / round start). */
  resetForRound(): void {
    this.memory.contacts.clear();
    this.memory.sounds.length = 0;
    this.memory.shotBurstCount = 0;
    this.memory.lastShotAt = Number.NEGATIVE_INFINITY;
    this.memory.lastSeenAt = Number.NEGATIVE_INFINITY;
    this.memory.currentGoal = 'idle';
    this.memory.lastGoalChange = Number.NEGATIVE_INFINITY;
    this.memory.pathGoalNode = -1;
    this.memory.retreatNode = -1;
    this.memory.retreatComputedAt = Number.NEGATIVE_INFINITY;
    this.memory.peekIndex = 0;
    this.memory.peekChangedAt = Number.NEGATIVE_INFINITY;
    this.context.follower = null;
    this.goal = 'idle';
  }

  /** Eye height of this bot's current pose (convenience for HUDs and aiming helpers). */
  eyeHeight(): number {
    return eyeHeight(this.context.self ? this.context.self.duckAmount : 0);
  }

  /** The objective currently in force (debug/HUD use). */
  get objective(): BotObjective {
    return this.context.objective;
  }
}
