// =============================================================================
// ui/pure.ts — pure, DOM-free logic for the HUD.
//
// Everything in this file is deliberately side-effect free and free of any
// `document` / `window` reference so that `tests/ui.spec.ts` can import it in
// the node environment. Hud.ts / BuyMenu.ts / Scoreboard.ts import from here;
// never the other way round.
// =============================================================================

import type { MapData, RoundPhase, Team, Vec3 } from '../core/types';
import { BUY_MENU, EQUIPMENT_PRICE, WEAPONS } from '../combat/weaponDefs';

// ---------------------------------------------------------------------------
// Public data shapes (also re-exported from Hud.ts for the engine)
// ---------------------------------------------------------------------------

export interface RadarBlip {
  id: number;
  pos: Vec3;
  team: Team;
  alive: boolean;
  isLocal: boolean;
  yaw: number;
  spotted: boolean;
  hasBomb?: boolean;
}

export interface HudFrameState {
  health: number;
  armor: number;
  helmet: boolean;
  hasDefuseKit: boolean;
  ammo: number;
  reserve: number;
  magazine: number;
  weaponName: string;
  weaponId: string;
  isReloading: boolean;
  money: number;
  team: Team;
  phase: RoundPhase;
  roundNumber: number;
  timeLeft: number;
  scoreT: number;
  scoreCT: number;
  bombPlanted: boolean;
  bombTimer: number;
  bombSite: 'A' | 'B' | null;
  defusing: boolean;
  defuseProgress: number;
  /**
   * Prompt for the gun lying within reach of the player, or '' for none, e.g.
   * 'Pick up AK-47' / 'Swap for AK-47'. The key that acts on it is the HUD's
   * own `E` badge, so this carries the label only.
   */
  pickupHint: string;
  /** Crosshair gap in screen units — grows with weapon inaccuracy + movement. */
  crosshairGap: number;
  crosshairLength: number;
  crosshairThickness: number;
  crosshairDot: boolean;
  /** White-flash overlay 0..1 (flashbang), and red damage flash 0..1. */
  flashAmount: number;
  damageFlash: number;
  /** Player is dead / spectating someone else. */
  dead: boolean;
  fps: number;
}

export interface ScoreRow {
  name: string;
  team: Team;
  kills: number;
  deaths: number;
  assists: number;
  money: number;
  alive: boolean;
  isLocal: boolean;
  ping: number;
}

export type AnnounceKind = 'info' | 'kill' | 'round' | 'money';

export interface KillFeedEntry {
  killer: string;
  victim: string;
  weapon: string;
  headshot: boolean;
  wallbang: boolean;
  killerTeam: Team;
  victimTeam: Team;
}

export interface HudOptions {
  /** Parent of the HUD root. Defaults to document.body. */
  root?: HTMLElement;
  /** Map data used to bake the radar base layer. */
  map: MapData;
  playerName?: string;
  onBuy?: (itemId: string) => void;
  onRequestPointerLock?: () => void;
  onMenuAction?: (action: string) => void;
}

export interface BuyCategory {
  category: string;
  items: string[];
}

// ---------------------------------------------------------------------------
// Radar projection
// ---------------------------------------------------------------------------

/**
 * World XZ -> radar UV (0..1) using the MapData contract:
 *   u = (x - originX) * scale
 *   v = (z - originZ) * scale
 *
 * THIS FUNCTION IS THE SINGLE PLACE TO ADJUST the projection if the map data
 * ever changes axis order, inverts an axis, or switches to a different scheme.
 * Nothing else in src/ui hardcodes the radar transform.
 *
 * Output is always finite (never NaN / Infinity) even for degenerate maps or
 * absurd inputs, and is NOT clamped — values outside 0..1 are legal and mean
 * "off the map". The radar renderer clamps/skips those itself.
 */
export function projectToRadar(map: MapData, pos: Vec3): { u: number; v: number } {
  const x = toFinite(pos?.x, 0);
  const z = toFinite(pos?.z, 0);
  let ox = toFinite(map?.radar?.originX, 0);
  let oz = toFinite(map?.radar?.originZ, 0);
  let scale = toFinite(map?.radar?.scale, 1);

  // A zero / missing scale would collapse the whole radar onto one point; fall
  // back to fitting the playable bounds into the unit square instead.
  if (!(Math.abs(scale) > 1e-9)) {
    const b = map?.bounds;
    const bx = Math.abs(toFinite(b?.max?.x, 1) - toFinite(b?.min?.x, 0));
    const bz = Math.abs(toFinite(b?.max?.z, 1) - toFinite(b?.min?.z, 0));
    const span = Math.max(bx, bz);
    scale = span > 1e-9 ? 1 / span : 1;
    const minX = toFinite(b?.min?.x, 0);
    const minZ = toFinite(b?.min?.z, 0);
    ox = minX - (span - bx) / 2;
    oz = minZ - (span - bz) / 2;
  }

  return { u: clamp(toFinite((x - ox) * scale, 0.5), -8, 9), v: clamp(toFinite((z - oz) * scale, 0.5), -8, 9) };
}

/** True when a projected radar point is inside the drawable unit square. */
export function radarInBounds(u: number, v: number, pad = 0): boolean {
  return u >= -pad && u <= 1 + pad && v >= -pad && v <= 1 + pad;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** Seconds -> `M:SS` (CS round clock). Negative -> `0:00`, capped at `59:59`. */
export function formatClock(seconds: number): string {
  const s = Math.floor(toFinite(seconds, 0));
  if (!Number.isFinite(s) || s <= 0) return '0:00';
  const capped = Math.min(s, 3599);
  const m = Math.floor(capped / 60);
  const r = capped % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Seconds -> `M:SS.d` (C4 fuse — tenths, never rounds down past the fuse). */
export function formatBombClock(seconds: number): string {
  const raw = toFinite(seconds, 0);
  if (raw <= 0) return '0:00.0';
  const tenths = Math.ceil(Math.min(raw, 5999) * 10);
  const whole = Math.floor(tenths / 10);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}.${tenths % 10}`;
}

/**
 * Integer dollars -> `$1,234`. Handles negatives as `-$1,234`. Rounds toward
 * zero so a fractional input never invents money.
 */
export function formatMoney(n: number): string {
  const v = toFinite(n, 0);
  const negative = v < 0;
  const rounded = Math.floor(Math.abs(v));
  const digits = String(rounded);
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return `${negative ? '-' : ''}$${out}`;
}

/** `de_dust2_lite` -> `DE DUST2 LITE` (radar / scoreboard headings). */
export function mapLabel(name: string): string {
  return String(name ?? '').replace(/[_-]+/g, ' ').trim().toUpperCase();
}

/**
 * CamelCase callout key -> screen label: `MidDoors` -> `MID DOORS`,
 * `TSpawn` -> `T SPAWN`, `LongA` -> `LONG A`, `BTunnels` -> `B TUNNELS`.
 * Used by both the radar labels and the world's floor signage.
 */
export function calloutLabel(name: string): string {
  return String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .trim()
    .toUpperCase();
}

/**
 * Weapon id -> display label. Prefers the authoritative `WEAPONS` name, then
 * prettifies the id, and only falls back to the raw id when it has no letters.
 */
export function weaponLabel(id: string): string {
  if (!id) return '';
  const def = WEAPONS[id];
  if (def && def.name) return def.name;
  const pretty = prettifyId(id);
  return pretty || id;
}

/** `kevlarhelmet` -> `Kevlarhelmet`, `m4a1_s` -> `M4A1 S`. Never empty for real ids. */
export function prettifyId(id: string): string {
  const cleaned = String(id ?? '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** `KEVLARHELMET` -> `Kevlar Helmet` (buy-menu equipment labels). */
export function equipmentLabel(id: string): string {
  const known: Record<string, string> = {
    kevlar: 'Kevlar Vest',
    kevlarhelmet: 'Kevlar + Helmet',
    defusekit: 'Defuse Kit',
  };
  return known[id] ?? prettifyId(id);
}

export function equipmentDescription(id: string): string {
  const known: Record<string, string> = {
    kevlar: 'Absorbs 50% of bullet damage',
    kevlarhelmet: 'Body armour plus head protection',
    defusekit: 'Halves the C4 defuse time (5s)',
  };
  return known[id] ?? 'Equipment';
}

/** Shop price of any purchasable id: weapon table first, then equipment. */
export function itemPrice(id: string): number {
  const eq = EQUIPMENT_PRICE[id];
  if (typeof eq === 'number') return eq;
  const weapon = WEAPONS[id];
  if (weapon && typeof weapon.price === 'number') return weapon.price;
  return 0;
}

export function canAfford(itemId: string, money: number): boolean {
  const m = toFinite(money, 0);
  if (m <= 0) return false;
  return m >= itemPrice(itemId);
}

/** Flat index of a buy-menu item across all categories (-1 when unknown). */
const ITEM_INDEX: Map<string, number> = (() => {
  const m = new Map<string, number>();
  let i = 0;
  for (const cat of BUY_MENU as BuyCategory[]) for (const item of cat.items) m.set(item, i++);
  return m;
})();

/**
 * Best-effort 1-based keybind/ID number for any purchasable id. Prefers the
 * item's position inside its own buy-menu category; falls back to a stable
 * global index so even ids outside BUY_MENU get a deterministic, tested value.
 */
export function buyKeyIndex(itemId: string): number {
  for (const cat of BUY_MENU as BuyCategory[]) {
    const local = cat.items.indexOf(itemId);
    if (local >= 0) return local + 1;
  }
  const global = ITEM_INDEX.get(itemId);
  return global === undefined ? 0 : global + 1;
}

export function buyCategoryLabel(index: number): string {
  const list = BUY_MENU as BuyCategory[];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return '';
  return list[index].category;
}

export function buyItemCount(index: number): number {
  const list = BUY_MENU as BuyCategory[];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return 0;
  return list[index].items.length;
}

// ---------------------------------------------------------------------------
// Scoreboard ordering
// ---------------------------------------------------------------------------

/**
 * Scoreboard order: T rows before CT rows / SPEC, then kills desc, then deaths
 * asc, then name asc. Returns a new array — the input is never mutated.
 */
export function sortedScoreRows(rows: readonly ScoreRow[]): ScoreRow[] {
  return rows.slice().sort(compareScoreRows);
}

/** The comparison used by `sortedScoreRows`, exported for ad-hoc sorting. */
export function compareScoreRows(a: ScoreRow, b: ScoreRow): number {
  const ta = teamRank(a.team);
  const tb = teamRank(b.team);
  if (ta !== tb) return ta - tb;
  if (a.kills !== b.kills) return b.kills - a.kills;
  if (a.deaths !== b.deaths) return a.deaths - b.deaths;
  return String(a.name).localeCompare(String(b.name));
}

export function teamRank(team: Team): number {
  return team === 'T' ? 0 : team === 'CT' ? 1 : 2;
}

export function teamRows(rows: readonly ScoreRow[], team: Team): ScoreRow[] {
  return sortedScoreRows(rows).filter((r) => r.team === team);
}

export function teamTotals(rows: readonly ScoreRow[], team: Team): { kills: number; deaths: number; assists: number } {
  let kills = 0;
  let deaths = 0;
  let assists = 0;
  for (const r of rows) {
    if (r.team !== team) continue;
    kills += toFinite(r.kills, 0);
    deaths += toFinite(r.deaths, 0);
    assists += toFinite(r.assists, 0);
  }
  return { kills, deaths, assists };
}

// ---------------------------------------------------------------------------
// Crosshair + indicator maths
// ---------------------------------------------------------------------------

export interface CrosshairPixels {
  /** Length of each of the four arms, in CSS pixels. */
  length: number;
  /** Arm thickness, in CSS pixels. */
  thickness: number;
  /** Distance from the centre to the inner tip of each arm. */
  gap: number;
  /** 1px dark outline offset (box-shadow spread) used for contrast. */
  outline: number;
}

/**
 * Clamp crosshair geometry so it can never degenerate to zero / negative size,
 * while scaling monotonically with the requested gap.
 */
export function crosshairPixels(gap: number, length: number, thickness: number): CrosshairPixels {
  const g = Math.max(0, Math.min(toFinite(gap, 0), 256));
  const l = Math.max(4, Math.min(toFinite(length, 8), 256));
  const t = Math.max(1, Math.min(toFinite(thickness, 2), 32));
  return { length: l, thickness: t, gap: g, outline: t >= 3 ? 2 : 1 };
}

/** Uniform scale for the crosshair arms; 1 = canonical size. */
export function crosshairScale(length: number, canonical = 8): number {
  const l = Math.max(4, Math.min(toFinite(length, canonical), 256));
  return Math.max(0.35, l / Math.max(1, canonical));
}

/** Hit-marker pop envelope: 0 -> 1 instantly, then eased to 0 at `duration`. */
export function hitMarkerAlpha(elapsed: number, duration = 0.25): number {
  const t = toFinite(elapsed, 0) / Math.max(1e-3, duration);
  if (t <= 0) return 1;
  if (t >= 1) return 0;
  const eased = 1 - t;
  return eased * eased;
}

export function hitMarkerScale(elapsed: number, duration = 0.25): number {
  const t = Math.max(0, Math.min(1, toFinite(elapsed, 0) / Math.max(1e-3, duration)));
  return 1 + 0.9 * (1 - t) * (1 - t);
}

export interface DamageIndicatorState {
  opacity: number;
  /** 0 = just appeared, 1 = fully faded. */
  progress: number;
}

export function damageIndicatorState(elapsed: number, duration = 1.5): DamageIndicatorState {
  const d = Math.max(1e-3, toFinite(duration, 1.5));
  const t = Math.max(0, Math.min(1, toFinite(elapsed, 0) / d));
  return { opacity: (1 - t) * (1 - t), progress: t };
}

/** Announcement banner alpha: flat while visible, linear fade out at the end. */
export function announceAlpha(age: number, lifetime = 2.5, fade = 0.55): number {
  const a = toFinite(age, 0);
  const life = Math.max(0.01, toFinite(lifetime, 2.5));
  if (a <= 0) return 1;
  if (a >= life) return 0;
  const tail = Math.max(0.01, toFinite(fade, 0.55));
  const start = Math.max(0, life - tail);
  if (a <= start) return 1;
  return 1 - (a - start) / tail;
}

/** Kill-feed alpha: solid, then a linear fade over the last `fade` seconds. */
export function feedAlpha(age: number, lifetime = 6, fade = 1.3): number {
  const a = toFinite(age, 0);
  const life = Math.max(0.01, toFinite(lifetime, 6));
  if (a <= 0) return 1;
  if (a >= life) return 0;
  const tail = Math.max(0.01, toFinite(fade, 1.3));
  const start = Math.max(0, life - tail);
  if (a <= start) return 1;
  return 1 - (a - start) / tail;
}

export interface FlashState {
  /** Opacity to apply to the white overlay, 0..1. */
  opacity: number;
  /** Small additive black frame right after a flash lands (0..1). */
  blackout: number;
}

/**
 * Flashbang envelope with a fast attack and a slow decay. `amount` is the raw
 * 0..1 intensity supplied by the simulation; `elapsed` starts when it lands.
 */
export function flashEnvelope(amount: number, elapsed: number): FlashState {
  const a = Math.max(0, Math.min(1, toFinite(amount, 0)));
  if (a <= 0) return { opacity: 0, blackout: 0 };
  const t = Math.max(0, toFinite(elapsed, 0));
  const attack = 0.06;
  const decay = 1.6;
  if (t < attack) {
    const k = t / attack;
    return { opacity: a * k, blackout: a * k };
  }
  const k = Math.max(0, 1 - (t - attack) / decay);
  return { opacity: a * k * k, blackout: 0 };
}

/** Radar blip radius in backing-store pixels for a given canvas size. */
export function blipRadius(canvasSize: number): number {
  return Math.max(2, Math.min(9, (toFinite(canvasSize, 512) / 512) * 5));
}

/** Points along an upward arrow of the given radius, for radar blips. */
export function arrowPoints(cx: number, cy: number, r: number): [number, number][] {
  return [
    [cx, cy - r * 1.15],
    [cx - r * 0.86, cy + r * 0.86],
    [cx, cy + r * 0.36],
    [cx + r * 0.86, cy + r * 0.86],
  ];
}

/** Match-clock minutes for the scoreboard header (`MR12 · 14:32`). */
export function formatMatchClock(elapsedSeconds: number): string {
  const s = Math.max(0, Math.floor(toFinite(elapsedSeconds, 0)));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r < 10 ? '0' : ''}${r}`;
}

/** Plural-free score line used by both round-end and match-end screens. */
export function scoreLine(scoreT: number, scoreCT: number): string {
  return `${Math.floor(toFinite(scoreT, 0))} — ${Math.floor(toFinite(scoreCT, 0))}`;
}

export function winnerLabel(winner: Team): string {
  if (winner === 'T') return 'Terrorists win';
  if (winner === 'CT') return 'Counter-Terrorists win';
  return 'Round over';
}

export function winnerShort(winner: Team): string {
  if (winner === 'T') return 'TERRORISTS';
  if (winner === 'CT') return 'COUNTER-TERRORISTS';
  return 'NO TEAM';
}

/** `$800` affordability text for a buy-menu row (`$2,700` / `needs $1,900`). */
export function affordabilityNote(itemId: string, money: number): string {
  const price = itemPrice(itemId);
  const m = toFinite(money, 0);
  if (m >= price) return formatMoney(price);
  return `need ${formatMoney(price - m)}`;
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

/** Coerce to a finite number, else `fallback`. */
export function toFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function clamp(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value)) return lo;
  return value < lo ? lo : value > hi ? hi : value;
}

/** Deterministic CSS colour for an announcement kind. */
export function announceColor(kind: AnnounceKind): string {
  switch (kind) {
    case 'kill':
      return '#ff5c4d';
    case 'round':
      return '#ffd166';
    case 'money':
      return '#4dff9d';
    default:
      return '#e8eef7';
  }
}

/** Team accent colour used by the scoreboard, radar and kill feed. */
export function teamColor(team: Team): string {
  switch (team) {
    case 'T':
      return '#ffb14d';
    case 'CT':
      return '#5aa9ff';
    default:
      return '#9aa4b2';
  }
}

/** Colour of the round timer for the current phase. */
export function phaseClockColor(phase: RoundPhase, bombPlanted: boolean): string {
  if (bombPlanted || phase === 'bomb') return '#ff4d4d';
  switch (phase) {
    case 'freeze':
      return '#8fa3bf';
    case 'over':
      return '#ffd166';
    case 'warmup':
      return '#9aa4b2';
    default:
      return '#ffffff';
  }
}

/** Low-health / low-armour accent. */
export function healthColor(value: number): string {
  const v = toFinite(value, 0);
  if (v <= 25) return '#ff4d4d';
  if (v <= 60) return '#ffd166';
  return '#ffffff';
}
