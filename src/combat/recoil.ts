// =============================================================================
// combat/recoil.ts — spray patterns.
//
// Counter-Strike weapons have DETERMINISTIC recoil: every player sees the same
// pattern, which is why "knowing the spray" is a skill. We reproduce that: the
// tables below are hand-authored offsets in DEGREES, converted to radians at
// module load. Index = shot number within a burst (clamped at the last entry).
//
// Sign convention (matches the camera):
//   +x = view pushed to the RIGHT  (bullet lands right of the crosshair)
//   +y = view pushed UP            (bullet lands above the crosshair)
// To find where a bullet goes, take the crosshair and add the pattern offset for
// that shot index. Players compensate by doing the opposite with the mouse.
// =============================================================================

import { deg } from '../core/math';
import type { RecoilPattern } from '../core/types';

/** Build a RecoilPattern from degree pairs plus per-shot inaccuracy (degrees). */
function pattern(
  punchDeg: readonly [number, number][],
  inaccuracyDeg: readonly number[],
): RecoilPattern {
  return {
    punch: punchDeg.map(([x, y]) => ({ x: deg(x), y: deg(y) })),
    inaccuracy: inaccuracyDeg.map((d) => deg(d)),
  };
}

/**
 * AK-47: the classic 30-round spray.
 *  1-4   : near vertical climb, a slight right drift
 *  5-10  : strong right sweep (the part everyone learns first)
 *  11-16 : hard left sweep, crossing the original point
 *  17-24 : returns right while climbing keeps slowing
 *  25-30 : wide, low-amplitude wander
 */
export const AK47_PATTERN = pattern(
  [
    [0.0, 0.55], [0.05, 1.15], [0.12, 1.75], [0.2, 2.3], [0.42, 2.7], [0.7, 3.0],
    [1.0, 3.15], [1.28, 3.2], [1.5, 3.15], [1.66, 3.0], [1.7, 2.75], [1.55, 2.5],
    [1.15, 2.25], [0.6, 2.05], [0.0, 1.9], [-0.6, 1.8], [-1.1, 1.72], [-1.45, 1.66],
    [-1.6, 1.6], [-1.5, 1.55], [-1.2, 1.5], [-0.75, 1.46], [-0.25, 1.42], [0.3, 1.38],
    [0.75, 1.34], [1.1, 1.3], [1.28, 1.26], [1.25, 1.22], [1.0, 1.18], [0.6, 1.14],
  ],
  [
    0.2, 0.3, 0.42, 0.55, 0.72, 0.9, 1.05, 1.2, 1.3, 1.4, 1.5, 1.6,
    1.7, 1.78, 1.85, 1.9, 1.95, 2.0, 2.05, 2.08, 2.1, 2.12, 2.14, 2.16,
    2.18, 2.2, 2.22, 2.24, 2.26, 2.28,
  ],
);

/**
 * M4A4: same shape as the AK but tighter — smaller horizontal excursions and a
 * slower climb, which is exactly why it is the "easier" spray of the two.
 */
export const M4A4_PATTERN = pattern(
  [
    [0.0, 0.45], [0.04, 0.95], [0.1, 1.45], [0.18, 1.9], [0.34, 2.25], [0.55, 2.5],
    [0.78, 2.62], [0.98, 2.66], [1.12, 2.6], [1.18, 2.5], [1.12, 2.35], [0.92, 2.2],
    [0.6, 2.05], [0.2, 1.95], [-0.25, 1.88], [-0.7, 1.82], [-1.05, 1.77], [-1.28, 1.73],
    [-1.35, 1.7], [-1.28, 1.67], [-1.05, 1.64], [-0.7, 1.61], [-0.3, 1.58], [0.1, 1.55],
    [0.45, 1.52], [0.7, 1.5], [0.85, 1.48], [0.85, 1.46], [0.7, 1.44], [0.45, 1.42],
  ],
  [
    0.16, 0.24, 0.34, 0.45, 0.58, 0.72, 0.85, 0.96, 1.05, 1.12, 1.2, 1.28,
    1.35, 1.42, 1.48, 1.52, 1.56, 1.6, 1.64, 1.66, 1.68, 1.7, 1.72, 1.74,
    1.75, 1.76, 1.78, 1.8, 1.82, 1.84,
  ],
);

/** M4A1-S: 20 rounds, tighter still, and heavier so it climbs a touch less. */
export const M4A1S_PATTERN = pattern(
  [
    [0.0, 0.4], [0.03, 0.85], [0.08, 1.3], [0.14, 1.7], [0.26, 2.0], [0.42, 2.2],
    [0.6, 2.3], [0.75, 2.32], [0.85, 2.28], [0.88, 2.2], [0.82, 2.08], [0.66, 1.96],
    [0.42, 1.86], [0.12, 1.78], [-0.2, 1.72], [-0.5, 1.68], [-0.72, 1.65], [-0.85, 1.63],
    [-0.88, 1.61], [-0.82, 1.59],
  ],
  [
    0.14, 0.2, 0.28, 0.36, 0.46, 0.56, 0.66, 0.74, 0.8, 0.84, 0.88, 0.92,
    0.96, 1.0, 1.04, 1.08, 1.12, 1.14, 1.16, 1.18,
  ],
);

/** MP9: fast, wide, short effective range — a hose, not a rifle. */
const SMG_PATTERN = pattern(
  [
    [0.0, 0.5], [0.12, 1.0], [0.3, 1.45], [0.52, 1.8], [0.75, 2.0], [0.95, 2.1],
    [1.05, 2.12], [1.02, 2.06], [0.85, 1.96], [0.6, 1.88], [0.28, 1.82], [-0.05, 1.78],
    [-0.35, 1.75], [-0.6, 1.73], [-0.75, 1.72], [-0.78, 1.72], [-0.7, 1.73], [-0.52, 1.74],
    [-0.3, 1.76], [-0.05, 1.78], [0.18, 1.8], [0.36, 1.82], [0.48, 1.84], [0.52, 1.86],
    [0.48, 1.88], [0.36, 1.9], [0.2, 1.92], [0.02, 1.94], [-0.15, 1.96], [-0.28, 1.98],
  ],
  [
    0.5, 0.7, 0.95, 1.2, 1.5, 1.8, 2.1, 2.3, 2.5, 2.65, 2.8, 2.9,
    3.0, 3.1, 3.2, 3.3, 3.4, 3.45, 3.5, 3.55, 3.6, 3.65, 3.7, 3.72,
    3.74, 3.76, 3.78, 3.8, 3.82, 3.84,
  ],
);

/** Pistols: one hard kick then a slow settle; inaccuracy spikes hard on spam. */
const PISTOL_PATTERN = pattern(
  [
    [0.0, 1.1], [0.25, 1.7], [0.55, 1.9], [0.8, 1.85], [0.95, 1.6], [1.0, 1.3],
    [0.95, 1.0], [0.8, 0.8], [0.6, 0.65], [0.4, 0.55], [0.22, 0.5], [0.1, 0.48],
    [0.02, 0.5], [-0.04, 0.55], [-0.06, 0.6], [-0.04, 0.62], [0.0, 0.62], [0.05, 0.6],
    [0.08, 0.56], [0.08, 0.52],
  ],
  [
    0.8, 1.6, 2.6, 3.6, 4.6, 5.6, 6.4, 7.0, 7.6, 8.0, 8.4, 8.8,
    9.2, 9.6, 9.9, 10.2, 10.5, 10.8, 11.0, 11.2,
  ],
);

/** Desert Eagle: brutal single kick, 7 rounds, must be paced. */
const DEAGLE_PATTERN = pattern(
  [
    [0.0, 2.4], [0.4, 3.4], [0.9, 3.6], [1.2, 3.2], [1.3, 2.6], [1.2, 2.0],
    [1.0, 1.6],
  ],
  [1.5, 6.0, 9.0, 12.0, 14.0, 15.5, 16.5],
);

/** MAC-10: bigger kick than the MP9, faster recovery is impossible. */
const MAC10_PATTERN = pattern(
  [
    [0.0, 0.6], [0.15, 1.2], [0.38, 1.75], [0.65, 2.15], [0.95, 2.4], [1.2, 2.5],
    [1.35, 2.5], [1.32, 2.42], [1.12, 2.3], [0.8, 2.2], [0.42, 2.12], [0.02, 2.07],
    [-0.35, 2.04], [-0.66, 2.02], [-0.88, 2.02], [-0.98, 2.03], [-0.94, 2.05], [-0.78, 2.08],
    [-0.52, 2.11], [-0.22, 2.14], [0.08, 2.17], [0.34, 2.2], [0.52, 2.23], [0.58, 2.26],
    [0.52, 2.29], [0.36, 2.32], [0.14, 2.35], [-0.1, 2.38], [-0.3, 2.41], [-0.42, 2.44],
  ],
  [
    0.6, 0.9, 1.2, 1.55, 1.9, 2.25, 2.55, 2.8, 3.0, 3.2, 3.35, 3.5,
    3.6, 3.7, 3.8, 3.9, 4.0, 4.05, 4.1, 4.15, 4.2, 4.25, 4.3, 4.32,
    4.34, 4.36, 4.38, 4.4, 4.42, 4.44,
  ],
);

/** Sniper rifles barely move; their cost is the scope-in delay, not recoil. */
const SNIPER_PATTERN = pattern(
  [[0.0, 3.2], [0.2, 4.0], [0.3, 4.4], [0.3, 4.4], [0.25, 4.3], [0.2, 4.2], [0.15, 4.1], [0.1, 4.0], [0.05, 3.9], [0.0, 3.8]],
  [0.5, 5.0, 8.0, 10.0, 11.5, 12.5, 13.2, 13.8, 14.2, 14.5],
);

export const PATTERNS: Record<string, RecoilPattern> = {
  ak47: AK47_PATTERN,
  m4a4: M4A4_PATTERN,
  m4a1s: M4A1S_PATTERN,
  mp9: SMG_PATTERN,
  mac10: MAC10_PATTERN,
  p90: SMG_PATTERN,
  glock: PISTOL_PATTERN,
  usp: PISTOL_PATTERN,
  p250: PISTOL_PATTERN,
  fiveseven: PISTOL_PATTERN,
  deagle: DEAGLE_PATTERN,
  awp: SNIPER_PATTERN,
  ssg08: SNIPER_PATTERN,
  scout: SNIPER_PATTERN,
  nova: PISTOL_PATTERN,
  knife: pattern([[0, 0]], [0]),
  c4: pattern([[0, 0]], [0]),
};

/** Look up the pattern for a weapon id, falling back to a generic pistol table. */
export function recoilFor(weaponId: string): RecoilPattern {
  return PATTERNS[weaponId] ?? PISTOL_PATTERN;
}

/** Sample the pattern at a given shot index (0-based), clamped. */
export function patternAt(p: RecoilPattern, shotIndex: number): { x: number; y: number; inaccuracy: number } {
  const i = Math.max(0, Math.min(shotIndex, p.punch.length - 1));
  const punch = p.punch[i];
  const inaccuracy = p.inaccuracy[Math.max(0, Math.min(shotIndex, p.inaccuracy.length - 1))];
  return { x: punch.x, y: punch.y, inaccuracy };
}
