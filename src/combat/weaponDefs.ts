// =============================================================================
// combat/weaponDefs.ts — the weapon table.
//
// Numbers are tuned to Counter-Strike: Global Offensive as closely as the
// browser budget allows. Distances are in Hammer units (1 unit ~ 1.9 cm), so
// "3000 units" is roughly 57 m —about the length of mid on Dust2.
//
// Damage model (implemented in ballistics.ts):
//   no armour : damage * falloff
//   armour    : damage * falloff * armorPenetration, then *0.5 absorption
//   hit group : head x4, chest x1, stomach x1.25, leg x0.75
// =============================================================================

import type { WeaponDef, WeaponKind } from '../core/types';
import { COMBAT } from '../core/config';
import { recoilFor } from './recoil';

const HEAD = 4.0;
const CHEST = 1.0;
const STOMACH = 1.25;
const LEG = 0.75;

const groupMul = { head: HEAD, chest: CHEST, stomach: STOMACH, leg: LEG };

function def(w: Partial<WeaponDef> & { id: string; name: string; kind: WeaponKind }): WeaponDef {
  const base: WeaponDef = {
    id: w.id,
    name: w.name,
    kind: w.kind,
    slot: w.slot ?? (w.kind === 'rifle' || w.kind === 'sniper' || w.kind === 'smg' || w.kind === 'shotgun' || w.kind === 'mg' ? 'primary' : 'secondary'),
    price: w.price ?? 0,
    killReward: w.killReward ?? COMBAT.defaultKillReward,
    damage: w.damage ?? 30,
    armorPenetration: w.armorPenetration ?? 0.7,
    rpm: w.rpm ?? 600,
    fireMode: w.fireMode ?? 'auto',
    magazine: w.magazine ?? 30,
    reserve: w.reserve ?? 90,
    reloadTime: w.reloadTime ?? 2.5,
    drawTime: w.drawTime ?? 0.6,
    moveSpeed: w.moveSpeed ?? 220,
    baseInaccuracy: w.baseInaccuracy ?? 0.5,
    moveInaccuracy: w.moveInaccuracy ?? 8,
    airInaccuracy: w.airInaccuracy ?? 30,
    crouchInaccuracy: w.crouchInaccuracy ?? 0.7,
    falloffStart: w.falloffStart ?? 3000,
    falloffEnd: w.falloffEnd ?? 6000,
    falloff: w.falloff ?? 0.6,
    effectiveRange: w.effectiveRange ?? 3000,
    pattern: w.pattern ?? recoilFor(w.id),
    hitGroupMul: w.hitGroupMul ?? groupMul,
    sound: w.sound ?? { gain: 1, body: 0.5, duration: 0.18, thump: 0.4 },
  };
  // Only carry optional keys when they are actually set, so `exactOptionalPropertyTypes`
  // style consumers and JSON dumps stay clean.
  if (w.zoomFov !== undefined) base.zoomFov = w.zoomFov;
  if (w.zoomTime !== undefined) base.zoomTime = w.zoomTime;
  if (w.silenced !== undefined) base.silenced = w.silenced;
  if (w.pellets !== undefined) base.pellets = w.pellets;
  return base;
}

// ---------------------------------------------------------------------------
// Pistols
// ---------------------------------------------------------------------------

export const GLOCK = def({
  id: 'glock', name: 'Glock-18', kind: 'pistol', slot: 'secondary', price: 200, killReward: 300,
  damage: 30, armorPenetration: 0.47, rpm: 400, fireMode: 'single', magazine: 20, reserve: 120,
  reloadTime: 2.2, drawTime: 0.5, moveSpeed: 240,
  baseInaccuracy: 0.9, moveInaccuracy: 9, airInaccuracy: 26, crouchInaccuracy: 1.0,
  falloffStart: 1200, falloffEnd: 2500, falloff: 0.55, effectiveRange: 1800,
  sound: { gain: 0.8, body: 0.42, duration: 0.13, thump: 0.3 },
});

export const USP = def({
  id: 'usp', name: 'USP-S', kind: 'pistol', slot: 'secondary', price: 200, killReward: 300,
  damage: 35, armorPenetration: 0.5, rpm: 352, fireMode: 'single', magazine: 12, reserve: 24,
  reloadTime: 2.2, drawTime: 0.5, moveSpeed: 240,
  baseInaccuracy: 0.5, moveInaccuracy: 7.5, airInaccuracy: 24, crouchInaccuracy: 0.6,
  falloffStart: 1500, falloffEnd: 3000, falloff: 0.55, effectiveRange: 2200,
  silenced: true,
  sound: { gain: 0.34, body: 0.3, duration: 0.1, thump: 0.18 },
});

export const P250 = def({
  id: 'p250', name: 'P250', kind: 'pistol', slot: 'secondary', price: 300, killReward: 300,
  damage: 38, armorPenetration: 0.64, rpm: 400, fireMode: 'single', magazine: 13, reserve: 26,
  reloadTime: 2.2, drawTime: 0.5, moveSpeed: 240,
  baseInaccuracy: 0.6, moveInaccuracy: 8, airInaccuracy: 26, crouchInaccuracy: 0.7,
  falloffStart: 1400, falloffEnd: 2800, falloff: 0.55, effectiveRange: 2000,
  sound: { gain: 0.85, body: 0.45, duration: 0.14, thump: 0.34 },
});

export const FIVESEVEN = def({
  id: 'fiveseven', name: 'Five-SeveN', kind: 'pistol', slot: 'secondary', price: 500, killReward: 300,
  damage: 32, armorPenetration: 0.77, rpm: 400, fireMode: 'single', magazine: 20, reserve: 100,
  reloadTime: 2.2, drawTime: 0.5, moveSpeed: 240,
  baseInaccuracy: 0.6, moveInaccuracy: 8, airInaccuracy: 26, crouchInaccuracy: 0.7,
  falloffStart: 1500, falloffEnd: 3200, falloff: 0.6, effectiveRange: 2200,
  sound: { gain: 0.8, body: 0.4, duration: 0.12, thump: 0.3 },
});

export const DEAGLE = def({
  id: 'deagle', name: 'Desert Eagle', kind: 'pistol', slot: 'secondary', price: 700, killReward: 300,
  damage: 63, armorPenetration: 0.93, rpm: 267, fireMode: 'single', magazine: 7, reserve: 35,
  reloadTime: 2.2, drawTime: 0.65, moveSpeed: 230,
  baseInaccuracy: 0.8, moveInaccuracy: 14, airInaccuracy: 40, crouchInaccuracy: 0.9,
  falloffStart: 5000, falloffEnd: 8000, falloff: 0.7, effectiveRange: 4500,
  sound: { gain: 1.15, body: 0.6, duration: 0.26, thump: 0.62 },
});

// ---------------------------------------------------------------------------
// SMGs
// ---------------------------------------------------------------------------

export const MP9 = def({
  id: 'mp9', name: 'MP9', kind: 'smg', slot: 'primary', price: 1250, killReward: 600,
  damage: 26, armorPenetration: 0.6, rpm: 857, fireMode: 'auto', magazine: 30, reserve: 120,
  reloadTime: 2.4, drawTime: 0.6, moveSpeed: 240,
  baseInaccuracy: 0.6, moveInaccuracy: 4.2, airInaccuracy: 18, crouchInaccuracy: 0.7,
  falloffStart: 1200, falloffEnd: 2500, falloff: 0.6, effectiveRange: 1600,
  sound: { gain: 0.75, body: 0.36, duration: 0.1, thump: 0.24 },
});

export const MAC10 = def({
  id: 'mac10', name: 'MAC-10', kind: 'smg', slot: 'primary', price: 1050, killReward: 600,
  damage: 29, armorPenetration: 0.575, rpm: 800, fireMode: 'auto', magazine: 30, reserve: 100,
  reloadTime: 2.6, drawTime: 0.6, moveSpeed: 240,
  baseInaccuracy: 0.7, moveInaccuracy: 4.6, airInaccuracy: 20, crouchInaccuracy: 0.8,
  falloffStart: 1100, falloffEnd: 2400, falloff: 0.6, effectiveRange: 1500,
  sound: { gain: 0.8, body: 0.4, duration: 0.11, thump: 0.28 },
});

export const P90 = def({
  id: 'p90', name: 'P90', kind: 'smg', slot: 'primary', price: 2350, killReward: 300,
  damage: 26, armorPenetration: 0.69, rpm: 857, fireMode: 'auto', magazine: 50, reserve: 100,
  reloadTime: 3.4, drawTime: 0.7, moveSpeed: 230,
  baseInaccuracy: 0.7, moveInaccuracy: 4.0, airInaccuracy: 16, crouchInaccuracy: 0.75,
  falloffStart: 1400, falloffEnd: 3000, falloff: 0.6, effectiveRange: 1900,
  sound: { gain: 0.78, body: 0.38, duration: 0.1, thump: 0.26 },
});

// ---------------------------------------------------------------------------
// Rifles
// ---------------------------------------------------------------------------

export const AK47 = def({
  id: 'ak47', name: 'AK-47', kind: 'rifle', slot: 'primary', price: 2700, killReward: 300,
  damage: 36, armorPenetration: 0.775, rpm: 600, fireMode: 'auto', magazine: 30, reserve: 90,
  reloadTime: 2.5, drawTime: 0.7, moveSpeed: 215,
  baseInaccuracy: 0.42, moveInaccuracy: 9.6, airInaccuracy: 34, crouchInaccuracy: 0.5,
  falloffStart: 4500, falloffEnd: 9000, falloff: 0.72, effectiveRange: 6000,
  sound: { gain: 1.2, body: 0.62, duration: 0.24, thump: 0.6 },
});

export const M4A4 = def({
  id: 'm4a4', name: 'M4A4', kind: 'rifle', slot: 'primary', price: 3100, killReward: 300,
  damage: 33, armorPenetration: 0.7, rpm: 666, fireMode: 'auto', magazine: 30, reserve: 90,
  reloadTime: 2.6, drawTime: 0.7, moveSpeed: 225,
  baseInaccuracy: 0.38, moveInaccuracy: 8.4, airInaccuracy: 30, crouchInaccuracy: 0.45,
  falloffStart: 4500, falloffEnd: 9000, falloff: 0.7, effectiveRange: 5500,
  sound: { gain: 1.0, body: 0.52, duration: 0.18, thump: 0.44 },
});

export const M4A1S = def({
  id: 'm4a1s', name: 'M4A1-S', kind: 'rifle', slot: 'primary', price: 2900, killReward: 300,
  damage: 38, armorPenetration: 0.7, rpm: 600, fireMode: 'auto', magazine: 20, reserve: 80,
  reloadTime: 2.6, drawTime: 0.7, moveSpeed: 225,
  baseInaccuracy: 0.34, moveInaccuracy: 7.8, airInaccuracy: 28, crouchInaccuracy: 0.4,
  falloffStart: 4000, falloffEnd: 8000, falloff: 0.68, effectiveRange: 5000,
  silenced: true,
  sound: { gain: 0.42, body: 0.34, duration: 0.12, thump: 0.2 },
});

export const GALIL = def({
  id: 'galil', name: 'Galil AR', kind: 'rifle', slot: 'primary', price: 1800, killReward: 300,
  damage: 30, armorPenetration: 0.775, rpm: 666, fireMode: 'auto', magazine: 35, reserve: 90,
  reloadTime: 3.0, drawTime: 0.7, moveSpeed: 215,
  baseInaccuracy: 0.6, moveInaccuracy: 10.5, airInaccuracy: 34, crouchInaccuracy: 0.6,
  falloffStart: 4000, falloffEnd: 8000, falloff: 0.7, effectiveRange: 5000,
  sound: { gain: 1.05, body: 0.55, duration: 0.19, thump: 0.5 },
});

// ---------------------------------------------------------------------------
// Snipers
// ---------------------------------------------------------------------------

export const AWP = def({
  id: 'awp', name: 'AWP', kind: 'sniper', slot: 'primary', price: 4750, killReward: 100,
  damage: 115, armorPenetration: 0.975, rpm: 41, fireMode: 'single', magazine: 10, reserve: 30,
  reloadTime: 3.7, drawTime: 1.2, moveSpeed: 200,
  baseInaccuracy: 0.02, moveInaccuracy: 140, airInaccuracy: 300, crouchInaccuracy: 0.02,
  falloffStart: 6000, falloffEnd: 9000, falloff: 0.95, effectiveRange: 8000,
  zoomFov: [40], zoomTime: 0.35,
  sound: { gain: 1.35, body: 0.7, duration: 0.34, thump: 0.75 },
});

export const SSG08 = def({
  id: 'ssg08', name: 'SSG 08', kind: 'sniper', slot: 'primary', price: 1700, killReward: 300,
  damage: 88, armorPenetration: 0.85, rpm: 48, fireMode: 'single', magazine: 10, reserve: 90,
  reloadTime: 3.7, drawTime: 1.0, moveSpeed: 230,
  baseInaccuracy: 0.02, moveInaccuracy: 120, airInaccuracy: 280, crouchInaccuracy: 0.02,
  falloffStart: 5000, falloffEnd: 9000, falloff: 0.9, effectiveRange: 7000,
  zoomFov: [50], zoomTime: 0.3,
  sound: { gain: 1.15, body: 0.62, duration: 0.3, thump: 0.6 },
});

// ---------------------------------------------------------------------------
// Shotgun —pellets make it a real close-range threat.
// ---------------------------------------------------------------------------

export const NOVA = def({
  id: 'nova', name: 'Nova', kind: 'shotgun', slot: 'primary', price: 1050, killReward: 900,
  damage: 26, armorPenetration: 0.5, rpm: 68, fireMode: 'single', magazine: 8, reserve: 32,
  reloadTime: 0.5, drawTime: 0.7, moveSpeed: 220,
  baseInaccuracy: 0, moveInaccuracy: 6, airInaccuracy: 20, crouchInaccuracy: 0,
  falloffStart: 600, falloffEnd: 1800, falloff: 0.35, effectiveRange: 900,
  pellets: 9,
  sound: { gain: 1.25, body: 0.6, duration: 0.3, thump: 0.7 },
});

// ---------------------------------------------------------------------------
// Melee & objective
// ---------------------------------------------------------------------------

export const KNIFE = def({
  id: 'knife', name: 'Knife', kind: 'knife', slot: 'knife', price: 0, killReward: 1500,
  damage: 40, armorPenetration: 0.85, rpm: 240, fireMode: 'single', magazine: 1, reserve: 0,
  reloadTime: 0, drawTime: 0.3, moveSpeed: 250,
  baseInaccuracy: 0, moveInaccuracy: 0, airInaccuracy: 0, crouchInaccuracy: 0,
  falloffStart: 99999, falloffEnd: 99999, falloff: 1, effectiveRange: 96,
  sound: { gain: 0.6, body: 0.3, duration: 0.1, thump: 0.2 },
});

export const C4 = def({
  id: 'c4', name: 'C4 Explosive', kind: 'c4', slot: 'c4', price: 0, killReward: 0,
  damage: 0, armorPenetration: 1, rpm: 60, fireMode: 'single', magazine: 1, reserve: 0,
  reloadTime: 0, drawTime: 0.6, moveSpeed: 250,
  baseInaccuracy: 0, moveInaccuracy: 0, airInaccuracy: 0, crouchInaccuracy: 0,
  falloffStart: 99999, falloffEnd: 99999, falloff: 1, effectiveRange: 64,
  sound: { gain: 0.5, body: 0.3, duration: 0.2, thump: 0.3 },
});

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const WEAPONS: Record<string, WeaponDef> = {
  glock: GLOCK,
  usp: USP,
  p250: P250,
  fiveseven: FIVESEVEN,
  deagle: DEAGLE,
  mp9: MP9,
  mac10: MAC10,
  p90: P90,
  ak47: AK47,
  m4a4: M4A4,
  m4a1s: M4A1S,
  galil: GALIL,
  awp: AWP,
  ssg08: SSG08,
  nova: NOVA,
  knife: KNIFE,
  c4: C4,
};

export function weaponById(id: string): WeaponDef | undefined {
  return WEAPONS[id];
}

/** Everything the buy menu can sell, in menu order. */
export const BUY_MENU: { category: string; items: string[] }[] = [
  { category: 'Pistols', items: ['glock', 'usp', 'p250', 'fiveseven', 'deagle'] },
  { category: 'SMGs', items: ['mac10', 'mp9', 'p90'] },
  { category: 'Rifles', items: ['galil', 'ak47', 'm4a4', 'm4a1s'] },
  { category: 'Snipers', items: ['ssg08', 'awp'] },
  { category: 'Heavy', items: ['nova'] },
  { category: 'Equipment', items: ['kevlar', 'kevlarhelmet', 'defusekit'] },
];

/** Equipment is not a WeaponDef; the economy layer prices it separately. */
export const EQUIPMENT_PRICE: Record<string, number> = {
  kevlar: 650,
  kevlarhelmet: 1000,
  defusekit: 400,
};
