// =============================================================================
// core/types.ts — FROZEN CROSS-MODULE CONTRACT
// Every module in src/ depends on these shapes. Do not change without updating
// all consumers. Units: 1 unit ~= 1.9 cm (CS units). Time in seconds unless the
// name says `Tick`. Angles in radians.
// =============================================================================

/** Mutable 3-component vector. Plain data, no class identity required. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type Team = 'T' | 'CT' | 'SPEC';

/** Discrete physical region of an actor, used for damage multipliers. */
export type HitGroup = 'head' | 'chest' | 'stomach' | 'arm' | 'leg' | 'generic';

export type SurfaceMaterial = 'sandstone' | 'concrete' | 'wood' | 'metal' | 'sand' | 'glass' | 'flesh' | 'water';

/** Axis-aligned box in world space. `min`/`max` inclusive corners. */
export interface AABB {
  min: Vec3;
  max: Vec3;
}

/** One static world brush: an oriented box (yaw-only rotation, CS style). */
export interface Brush {
  id: number;
  /** Center of the box. */
  pos: Vec3;
  /** Full extents (width, height, depth) before rotation. */
  size: Vec3;
  /** Rotation around Y in radians. */
  yaw: number;
  material: SurfaceMaterial;
  /** Texture repeat hint in units per tile (0 = derive from material default). */
  texScale?: number;
  /**
   * Marker volume: never collided against — not by player movement, not by the
   * navigation bake, not by bullets — and not drawn either, so it costs nothing at
   * runtime. Everything that touches brushes must skip it, or an invisible, inert
   * volume silently becomes an invisible wall.
   */
  nonSolid?: boolean;
  /** Optional tint (0xRRGGBB) applied to the generated material. */
  tint?: number;
  /** Skip rendering (invisible collision volume / clip brush). */
  clip?: boolean;
}

export interface SpawnPoint {
  pos: Vec3;
  yaw: number;
  team: Team;
  /** Priority index for deterministic ordering. */
  index: number;
}

export interface NavNode {
  id: number;
  pos: Vec3;
  /** Neighbour node ids (bidirectional). */
  links: number[];
  /** Coarse region label used by bot tactics ('LongA', 'Mid', 'BSite', ...). */
  area: string;
  /** True when the node is a bomb-plantable spot (bomb site polygons). */
  site?: 'A' | 'B' | null;
  /** True when the node is inside a chokepoint (bots like to hold these). */
  choke?: boolean;
}

export interface BombSiteRegion {
  site: 'A' | 'B';
  /** Convex-ish polygon footprint (XZ), minimum 3 points. */
  poly: [number, number][];
  /** Ground height used to sanity-check the plant. */
  y: number;
  /** Suggested plant spots. */
  spots: Vec3[];
}

/**
 * A whole-area floor wash: one district of the map painted in its own hue so the
 * floor is not a single flat tint (see `render/Signs.ts` for the quads). Purely
 * decorative — paint touches no brush, no collision volume and no nav node.
 */
export interface PaintZone {
  name: string;
  minX: number;
  minZ: number;
  maxX: number;
  maxZ: number;
  /** Floor height of that district (a raised deck sits on a 128 u plate). */
  floorY: number;
  color: number;
}

/** Map data: consumed by renderer, collision, navigation and bot tactics. */
export interface MapData {
  name: string;
  /** Bounds of the playable volume (used for fog, minimap, grid sizing). */
  bounds: { min: Vec3; max: Vec3 };
  brushes: Brush[];
  spawns: SpawnPoint[];
  nav: NavNode[];
  sites: BombSiteRegion[];
  /** Named callouts -> representative point (radar labels, kill feed context). */
  callouts: Record<string, Vec3>;
  /** Radar transform: world XZ -> radar 0..1 UV space. */
  radar: { originX: number; originZ: number; scale: number };
  /** Optional T/CT spawn facing boxes for buy-zone checks. */
  buyZones: { team: Team; min: Vec3; max: Vec3 }[];
  /**
   * Optional district paint. A map that leaves this empty falls back to the
   * legacy `SIGN_ZONES` table, which is authored for de_dust2_lite's areas.
   */
  paint?: readonly PaintZone[];
}

/** Result of a world raycast. */
export interface RayHit {
  hit: boolean;
  /** Distance along the ray direction. */
  distance: number;
  point: Vec3;
  normal: Vec3;
  material: SurfaceMaterial;
  /** Entity id when an actor was hit, otherwise -1. */
  entityId: number;
  hitGroup: HitGroup;
  /** Brush id when static geometry was hit, otherwise -1. */
  brushId: number;
}

/** Trace options. `mask` filters what the trace may hit. */
export interface TraceDesc {
  start: Vec3;
  end: Vec3;
  /** Trace against static world geometry. Default true. */
  world?: boolean;
  /** Trace against actor hitboxes. Default false. */
  actors?: boolean;
  /** Actor to ignore (the shooter). Default -1. */
  ignoreEntity?: number;
  /** Ignore these entity ids as well. */
  ignoreList?: number[];
  /** Max wall thickness (units) a bullet may penetrate. 0 disables penetration. */
  penetration?: number;
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export interface InputButtons {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  crouch: boolean;
  walk: boolean; // shift: slow, silent, accurate
  attack: boolean;
  attack2: boolean; // right mouse: scope / silencer
  reload: boolean;
  use: boolean;
  drop: boolean;
  slot1: boolean;
  slot2: boolean;
  slot3: boolean;
  slot4: boolean;
  slot5: boolean;
}

/** One input sample, stamped with the simulation tick it belongs to. */
export interface InputCommand {
  tick: number;
  buttons: InputButtons;
  /** Absolute view angles (radians) after mouse delta was applied. */
  yaw: number;
  pitch: number;
  /** Raw mouse delta for this tick, used by view punch / sway. */
  mouseDX: number;
  mouseDY: number;
}

export const EMPTY_BUTTONS: Readonly<InputButtons> = Object.freeze({
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  crouch: false,
  walk: false,
  attack: false,
  attack2: false,
  reload: false,
  use: false,
  drop: false,
  slot1: false,
  slot2: false,
  slot3: false,
  slot4: false,
  slot5: false,
});

// ---------------------------------------------------------------------------
// Actors
// ---------------------------------------------------------------------------

export interface ActorState {
  id: number;
  name: string;
  team: Team;
  isBot: boolean;
  /** Feet position (bottom-center of the collision box). */
  pos: Vec3;
  /** Velocity in units/second. */
  vel: Vec3;
  yaw: number;
  pitch: number;
  onGround: boolean;
  crouching: boolean;
  duckAmount: number; // 0 = standing, 1 = fully crouched
  health: number;
  armor: number;
  helmet: boolean;
  alive: boolean;
  /** True while the actor has the bomb (T side only). */
  hasBomb: boolean;
  /** Reserved for defuse kits. */
  hasDefuseKit: boolean;
  /** Movement speed penalty multiplier from the equipped weapon. */
  speedFactor: number;
}

// ---------------------------------------------------------------------------
// Weapons
// ---------------------------------------------------------------------------

export type WeaponSlot = 'primary' | 'secondary' | 'knife' | 'grenade' | 'bomb' | 'c4';
export type FireMode = 'auto' | 'single' | 'burst';
export type WeaponKind = 'rifle' | 'smg' | 'pistol' | 'sniper' | 'shotgun' | 'mg' | 'knife' | 'grenade' | 'c4';

export interface RecoilPattern {
  /** Angular kick applied to the view per shot, index = shot number (clamped). */
  punch: { x: number; y: number }[];
  /** Extra inaccuracy (radians) added to the cone per shot. */
  inaccuracy: number[];
}

export interface WeaponDef {
  id: string;
  name: string;
  kind: WeaponKind;
  slot: WeaponSlot;
  price: number;
  /** Kill reward in dollars. */
  killReward: number;
  damage: number;
  armorPenetration: number; // 0..1
  /** Rounds per minute. */
  rpm: number;
  fireMode: FireMode;
  /** Burst count when fireMode === 'burst'. */
  burstCount?: number;
  magazine: number;
  reserve: number;
  /** Reload duration in seconds. */
  reloadTime: number;
  /** Draw (equip) duration in seconds. */
  drawTime: number;
  /** Movement speed multiplier while equipped (1 = full speed). */
  moveSpeed: number;
  /** Base inaccuracy cone half-angle in radians while standing still. */
  baseInaccuracy: number;
  /** Added inaccuracy per unit of horizontal speed (rad / (u/s)). */
  moveInaccuracy: number;
  /** Inaccuracy while airborne. */
  airInaccuracy: number;
  /** Inaccuracy while crouched (replaces base when crouched). */
  crouchInaccuracy: number;
  /** Range (units) over which damage falls to `falloff` fraction. */
  falloffStart: number;
  falloffEnd: number;
  falloff: number; // 0..1 damage multiplier at falloffEnd and beyond
  /** Effective range used by bot AI for target selection. */
  effectiveRange: number;
  /** Horizontal recoil pattern; may be generated procedurally for repeats. */
  pattern: RecoilPattern;
  /** Scope FOVs (degrees). Empty = no scope. */
  zoomFov?: number[];
  /** Zoom in/out duration. */
  zoomTime?: number;
  /** Silenced weapons show no muzzle flash cone on radar / quieter sound. */
  silenced?: boolean;
  /** Multipliers applied to base damage per hit group. */
  hitGroupMul: Partial<Record<HitGroup, number>>;
  /** Number of pellets per shot (shotguns). */
  pellets?: number;
  /** Sound signature for procedural gun audio. */
  sound: {
    /** Peak loudness 0..1 at 1m. */
    gain: number;
    /** Body resonance frequency in Hz. */
    body: number;
    /** Noise burst duration in seconds. */
    duration: number;
    /** Low-frequency thump amount. */
    thump: number;
  };
}

// ---------------------------------------------------------------------------
// Game flow
// ---------------------------------------------------------------------------

export type RoundPhase = 'warmup' | 'freeze' | 'live' | 'bomb' | 'over';

/**
 * A weapon lying on the ground after a drop, a death or a swap. The magazine
 * travels with the gun: whoever picks it up inherits exactly what was in it,
 * which is the rule that makes "my team-mate's gun" worth walking over for.
 */
export interface GroundWeapon {
  /** Match-unique instance id: two AK-47s on the floor are two guns. */
  id: number;
  weaponId: string;
  kind: WeaponKind;
  /** Rounds in the magazine when it hit the floor. */
  ammo: number;
  reserve: number;
  pos: Vec3;
  /** Match time (seconds) it was dropped at, for the renderer's settle. */
  droppedAt: number;
}
export type GamePhase = 'menu' | 'buy' | 'playing' | 'roundend' | 'matchend' | 'spectating';

export interface RoundState {
  roundNumber: number;
  phase: RoundPhase;
  /** Seconds remaining in the current phase. */
  timeLeft: number;
  scoreT: number;
  scoreCT: number;
  /** Team that survived / won the round, if settled. */
  winner: Team | null;
  /** Why the round ended (kill all, bomb exploded, defused, time). */
  reason: string;
  bombPlanted: boolean;
  bombTimer: number;
  bombSite: 'A' | 'B' | null;
  /** True when a CT is currently defusing. */
  defusing: boolean;
  defuseProgress: number;
}

/** Events emitted by the simulation; consumed by UI/audio/VFX. */
export interface GameEventMap {
  /**
   * A weapon was swung/fired. `melee` marks a knife swing: it is a real swing
   * (the swing clock, the RPM gate and the noise for bots all read this event),
   * but the presentation layers must not draw a muzzle flash, a tracer, a
   * casing or a gunshot report for it.
   */
  shot: {
    shooterId: number;
    weaponId: string;
    origin: Vec3;
    dir: Vec3;
    silenced: boolean;
    ammo: number;
    melee: boolean;
  };
  hit: {
    shooterId: number;
    targetId: number;
    hitGroup: HitGroup;
    damage: number;
    armorDamage: number;
    point: Vec3;
    normal: Vec3;
    killed: boolean;
    weaponId: string;
  };
  impact: { point: Vec3; normal: Vec3; material: SurfaceMaterial; dustOnly: boolean };
  /**
   * A bullet passed close enough to the listening player's ear to snap past it.
   * `distance` is the closest approach of the bullet's path to the ear (units).
   */
  whizz: { shooterId: number; pos: Vec3; distance: number };
  reload: { actorId: number; weaponId: string; duration: number };
  draw: { actorId: number; weaponId: string; duration: number };
  footstep: { actorId: number; pos: Vec3; material: SurfaceMaterial; volume: number };
  jump: { actorId: number };
  land: { actorId: number; speed: number; damage: number };
  death: { victimId: number; killerId: number; weaponId: string; headshot: boolean; wallbang: boolean };
  spawn: { actorId: number; team: Team };
  buy: { actorId: number; weaponId: string; price: number };
  roundPhase: { phase: RoundPhase; timeLeft: number; roundNumber: number };
  roundEnd: { winner: Team; reason: string; scoreT: number; scoreCT: number };
  bombPlanted: { site: 'A' | 'B'; pos: Vec3; actorId: number };
  bombExploded: { site: 'A' | 'B' };
  bombDefused: { actorId: number };
  bombPickup: { actorId: number; dropped: boolean };
  weaponDropped: { actorId: number; weaponId: string; pos: Vec3 };
  weaponPickup: { actorId: number; weaponId: string; swapped: boolean };
  grenadeThrow: { actorId: number; kind: string };
  grenadeExplode: { kind: string; pos: Vec3; radius: number };
  flash: { origin: Vec3; duration: number; intensity: number };
  announce: { text: string; kind: 'info' | 'kill' | 'round' | 'money' };
}

export type GameEventName = keyof GameEventMap;
