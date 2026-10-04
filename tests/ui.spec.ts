// =============================================================================
// tests/ui.spec.ts — pure-logic tests for the HUD module.
//
// Deliberately DOM-free: only `src/ui/pure.ts` (side-effect free by design) and
// `src/ui/styles.ts` (which merely builds a CSS string) are imported. Hud.ts,
// BuyMenu.ts and Scoreboard.ts touch `document` at construction time and are
// therefore never imported here, so this suite runs in the plain node
// environment configured in vite.config.ts.
// =============================================================================

import { describe, expect, it } from 'vitest';

import type { MapData, Vec3 } from '../src/core/types';
import { BUY_MENU, EQUIPMENT_PRICE, WEAPONS } from '../src/combat/weaponDefs';
import {
  affordabilityNote,
  announceAlpha,
  announceColor,
  arrowPoints,
  blipRadius,
  buyCategoryLabel,
  buyItemCount,
  buyKeyIndex,
  canAfford,
  clamp,
  compareScoreRows,
  crosshairPixels,
  crosshairScale,
  damageIndicatorState,
  equipmentLabel,
  feedAlpha,
  flashEnvelope,
  formatBombClock,
  formatClock,
  formatMatchClock,
  formatMoney,
  healthColor,
  hitMarkerAlpha,
  hitMarkerScale,
  itemPrice,
  mapLabel,
  phaseClockColor,
  prettifyId,
  projectToRadar,
  radarInBounds,
  scoreLine,
  sortedScoreRows,
  teamColor,
  teamRank,
  teamRows,
  teamTotals,
  toFinite,
  weaponLabel,
  winnerLabel,
  winnerShort,
  type ScoreRow,
} from '../src/ui/pure';
import { CSS, ROOT_CLASS, STYLE_ID } from '../src/ui/styles';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function vec(x: number, y: number, z: number): Vec3 {
  return { x, y, z };
}

/** Minimal map: 2000x2000 units of playable space, centred on the origin. */
function makeMap(overrides: Partial<MapData['radar']> = {}): MapData {
  return {
    name: 'de_dust2_lite',
    bounds: { min: vec(-1000, 0, -1000), max: vec(1000, 400, 1000) },
    brushes: [],
    spawns: [],
    nav: [],
    sites: [],
    callouts: {},
    radar: { originX: -1000, originZ: -1000, scale: 0.0005, ...overrides },
    buyZones: [],
  } as MapData;
}

function row(partial: Partial<ScoreRow> & { name: string }): ScoreRow {
  return {
    team: 'T',
    kills: 0,
    deaths: 0,
    assists: 0,
    money: 0,
    alive: true,
    isLocal: false,
    ping: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// formatClock
// ---------------------------------------------------------------------------

describe('formatClock', () => {
  it('formats the required examples', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(65)).toBe('1:05');
    expect(formatClock(125)).toBe('2:05');
    expect(formatClock(-3)).toBe('0:00');
    expect(formatClock(3599)).toBe('59:59');
  });

  it('pads seconds and floors fractions', () => {
    expect(formatClock(9)).toBe('0:09');
    expect(formatClock(59.99)).toBe('0:59');
    expect(formatClock(60)).toBe('1:00');
    expect(formatClock(600)).toBe('10:00');
  });

  it('never produces a negative or NaN clock', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1, -1e9]) {
      expect(formatClock(bad)).toBe('0:00');
    }
    expect(formatClock(1e12)).toMatch(/^\d+:\d\d$/);
  });

  it('treats non-numeric input as zero', () => {
    expect(formatClock(undefined as unknown as number)).toBe('0:00');
    expect(formatClock('125' as unknown as number)).toBe('0:00');
  });

  it('always renders two second digits', () => {
    for (let s = 0; s < 400; s++) expect(formatClock(s)).toMatch(/^\d+:[0-5]\d$/);
  });
});

// ---------------------------------------------------------------------------
// formatBombClock
// ---------------------------------------------------------------------------

describe('formatBombClock', () => {
  it('renders tenths of a second', () => {
    expect(formatBombClock(40)).toBe('0:40.0');
    expect(formatBombClock(39.95)).toBe('0:40.0');
    expect(formatBombClock(7.31)).toBe('0:07.4');
    expect(formatBombClock(0)).toBe('0:00.0');
    expect(formatBombClock(-5)).toBe('0:00.0');
  });

  it('never renders a negative fuse', () => {
    for (const bad of [Number.NaN, -1, -1000, Number.NEGATIVE_INFINITY]) {
      expect(formatBombClock(bad)).toBe('0:00.0');
    }
  });
});

// ---------------------------------------------------------------------------
// formatMoney
// ---------------------------------------------------------------------------

describe('formatMoney', () => {
  it('formats the required examples', () => {
    expect(formatMoney(0)).toBe('$0');
    expect(formatMoney(800)).toBe('$800');
    expect(formatMoney(16000)).toBe('$16,000');
  });

  it('groups thousands', () => {
    expect(formatMoney(1000)).toBe('$1,000');
    expect(formatMoney(999)).toBe('$999');
    expect(formatMoney(1234567)).toBe('$1,234,567');
  });

  it('rounds toward zero and marks negatives', () => {
    expect(formatMoney(799.9)).toBe('$799');
    expect(formatMoney(-2500)).toBe('-$2,500');
  });

  it('never emits NaN / Infinity / injected markup', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(formatMoney(bad)).toBe('$0');
    }
    const evil = formatMoney('<img src=x onerror=alert(1)>' as unknown as number);
    expect(evil).not.toContain('<');
    expect(evil).toMatch(/^-?\$[\d,]+$/);
  });
});

// ---------------------------------------------------------------------------
// projectToRadar — the single radar transform
// ---------------------------------------------------------------------------

describe('projectToRadar', () => {
  it('maps the map centre near (0.5, 0.5)', () => {
    const map = makeMap(); // origin -1000 / -1000, scale 0.0005, 2000 units wide
    const p = projectToRadar(map, vec(0, 0, 0));
    expect(p.u).toBeCloseTo(0.5, 6);
    expect(p.v).toBeCloseTo(0.5, 6);
  });

  it('uses u = (x - originX) * scale and v = (z - originZ) * scale', () => {
    const map = makeMap();
    const origin = projectToRadar(map, vec(-1000, 0, -1000));
    expect(origin.u).toBeCloseTo(0, 6);
    expect(origin.v).toBeCloseTo(0, 6);
    const far = projectToRadar(map, vec(1000, 0, 1000));
    expect(far.u).toBeCloseTo(1, 6);
    expect(far.v).toBeCloseTo(1, 6);
  });

  it('gives two points 1000 units apart on X a scale*1000 delta on u', () => {
    const map = makeMap();
    const a = projectToRadar(map, vec(0, 0, 0));
    const b = projectToRadar(map, vec(1000, 0, 0));
    expect(b.u - a.u).toBeCloseTo(map.radar.scale * 1000, 9);
    expect(b.v - a.v).toBeCloseTo(0, 9);
  });

  it('works for a second, differently scaled map', () => {
    const map = makeMap({ originX: 0, originZ: 0, scale: 0.001 });
    const p = projectToRadar(map, vec(250, 0, -500));
    expect(p.u).toBeCloseTo(0.25, 9);
    expect(p.v).toBeCloseTo(-0.5, 9);
  });

  it('ignores the Y axis entirely', () => {
    const map = makeMap();
    const low = projectToRadar(map, vec(100, -5000, 250));
    const high = projectToRadar(map, vec(100, 5000, 250));
    expect(low).toEqual(high);
  });

  it('always returns finite numbers, never NaN', () => {
    const maps: MapData[] = [
      makeMap(),
      makeMap({ scale: 0 }),
      makeMap({ originX: Number.NaN, originZ: Number.NaN, scale: Number.NaN }),
      makeMap({ scale: Number.POSITIVE_INFINITY }),
      { ...makeMap(), bounds: { min: vec(0, 0, 0), max: vec(0, 0, 0) } },
    ];
    const positions: Vec3[] = [
      vec(0, 0, 0),
      vec(Number.NaN, 0, Number.NaN),
      vec(Number.POSITIVE_INFINITY, 0, Number.NEGATIVE_INFINITY),
      vec(-1e12, 1e9, 1e12),
      vec(0.1, -0.2, 0.3),
    ];
    for (const map of maps) {
      for (const pos of positions) {
        const p = projectToRadar(map, pos);
        expect(Number.isFinite(p.u)).toBe(true);
        expect(Number.isFinite(p.v)).toBe(true);
      }
    }
  });

  it('falls back to the bounds fit when scale is missing or zero', () => {
    const map = makeMap({ scale: 0 });
    const centre = projectToRadar(map, vec(0, 0, 0));
    expect(centre.u).toBeCloseTo(0.5, 6);
    expect(centre.v).toBeCloseTo(0.5, 6);
    expect(projectToRadar({} as MapData, vec(0, 0, 0)).u).toBeGreaterThanOrEqual(0);
  });

  it('agrees with radarInBounds', () => {
    const map = makeMap();
    expect(radarInBounds(projectToRadar(map, vec(0, 0, 0)).u, 0.5)).toBe(true);
    expect(radarInBounds(projectToRadar(map, vec(5000, 0, 0)).u, 0.5)).toBe(false);
    expect(radarInBounds(1.05, 1.05, 0.1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sortedScoreRows
// ---------------------------------------------------------------------------

describe('sortedScoreRows', () => {
  it('sorts by kills desc, then deaths asc, then name asc', () => {
    const rows = [
      row({ name: 'cara', kills: 5, deaths: 9 }),
      row({ name: 'abe', kills: 5, deaths: 9 }),
      row({ name: 'bob', kills: 5, deaths: 3 }),
      row({ name: 'dan', kills: 11, deaths: 20 }),
    ];
    expect(sortedScoreRows(rows).map((r) => r.name)).toEqual(['dan', 'bob', 'abe', 'cara']);
  });

  it('keeps T rows before CT rows and preserves team grouping', () => {
    const rows = [
      row({ name: 'ct1', team: 'CT', kills: 99 }),
      row({ name: 't2', team: 'T', kills: 1 }),
      row({ name: 't1', team: 'T', kills: 7 }),
      row({ name: 'ct2', team: 'CT', kills: 2 }),
    ];
    const sorted = sortedScoreRows(rows);
    expect(sorted.map((r) => r.name)).toEqual(['t1', 't2', 'ct1', 'ct2']);
    expect(teamRows(rows, 'T').map((r) => r.name)).toEqual(['t1', 't2']);
    expect(teamRows(rows, 'CT').map((r) => r.name)).toEqual(['ct1', 'ct2']);
  });

  it('is stable and never mutates its input', () => {
    const rows = [
      row({ name: 'a', kills: 3, deaths: 1 }),
      row({ name: 'b', kills: 3, deaths: 1 }),
      row({ name: 'c', kills: 3, deaths: 1 }),
      row({ name: 'd', kills: 3, deaths: 1 }),
    ];
    const order = rows.map((r) => r.name);
    const sorted = sortedScoreRows(rows);
    expect(sorted.map((r) => r.name)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((r) => r.name)).toEqual(order);
    // sorting twice is idempotent
    expect(sortedScoreRows(sorted).map((r) => r.name)).toEqual(sorted.map((r) => r.name));
  });

  it('handles empty input and SPEC players', () => {
    expect(sortedScoreRows([])).toEqual([]);
    const spec = row({ name: 'ghost', team: 'SPEC' });
    expect(sortedScoreRows([spec, row({ name: 't' })])[1]).toBe(spec);
    expect(teamRank('T')).toBe(0);
    expect(teamRank('CT')).toBe(1);
    expect(teamRank('SPEC')).toBe(2);
  });

  it('exposes the same comparison through compareScoreRows', () => {
    const a = row({ name: 'a', kills: 1 });
    const b = row({ name: 'b', kills: 2 });
    expect(compareScoreRows(a, b)).toBeGreaterThan(0);
    expect(compareScoreRows(b, a)).toBeLessThan(0);
  });

  it('totals per team', () => {
    const rows = [
      row({ name: 'a', team: 'T', kills: 4, deaths: 2, assists: 1 }),
      row({ name: 'b', team: 'T', kills: 3, deaths: 5, assists: 2 }),
      row({ name: 'c', team: 'CT', kills: 9, deaths: 1, assists: 0 }),
    ];
    expect(teamTotals(rows, 'T')).toEqual({ kills: 7, deaths: 7, assists: 3 });
    expect(teamTotals(rows, 'CT')).toEqual({ kills: 9, deaths: 1, assists: 0 });
    expect(teamTotals(rows, 'SPEC')).toEqual({ kills: 0, deaths: 0, assists: 0 });
  });
});

// ---------------------------------------------------------------------------
// buy menu economy
// ---------------------------------------------------------------------------

describe('canAfford / itemPrice / buyKeyIndex', () => {
  it('honours WEAPONS prices', () => {
    expect(canAfford('ak47', 2700)).toBe(true);
    expect(canAfford('ak47', 2699)).toBe(false);
    expect(canAfford('awp', 4750)).toBe(true);
    expect(canAfford('awp', 4749)).toBe(false);
    expect(canAfford('glock', 200)).toBe(true);
    expect(itemPrice('ak47')).toBe(2700);
    expect(itemPrice('awp')).toBe(4750);
    expect(itemPrice('knife')).toBe(0);
  });

  it('honours EQUIPMENT_PRICE', () => {
    expect(itemPrice('kevlar')).toBe(EQUIPMENT_PRICE['kevlar']);
    expect(itemPrice('kevlarhelmet')).toBe(EQUIPMENT_PRICE['kevlarhelmet']);
    expect(itemPrice('defusekit')).toBe(EQUIPMENT_PRICE['defusekit']);
    expect(canAfford('kevlarhelmet', 1000)).toBe(true);
    expect(canAfford('kevlarhelmet', 999)).toBe(false);
    expect(canAfford('defusekit', 400)).toBe(true);
    expect(canAfford('defusekit', 399)).toBe(false);
  });

  it('rejects unknown items and non-positive money', () => {
    expect(itemPrice('does-not-exist')).toBe(0);
    expect(canAfford('ak47', 0)).toBe(false);
    expect(canAfford('ak47', -100)).toBe(false);
    expect(canAfford('ak47', Number.NaN)).toBe(false);
    expect(canAfford('kevlar', 649)).toBe(false);
    expect(canAfford('kevlar', 650)).toBe(true);
  });

  it('numbers every buy-menu item 1..9 within its category', () => {
    let checked = 0;
    for (const cat of BUY_MENU) {
      cat.items.forEach((id, i) => {
        expect(buyKeyIndex(id)).toBe(i + 1);
        expect(buyKeyIndex(id)).toBeGreaterThanOrEqual(1);
        expect(buyKeyIndex(id)).toBeLessThanOrEqual(9);
        checked++;
      });
    }
    expect(checked).toBeGreaterThan(10);
    expect(buyKeyIndex('nonsense')).toBe(0);
    expect(buyCategoryLabel(0)).toBe(BUY_MENU[0].category);
    expect(buyItemCount(0)).toBe(BUY_MENU[0].items.length);
    expect(buyCategoryLabel(-1)).toBe('');
    expect(buyItemCount(999)).toBe(0);
  });

  it('writes affordability notes the player can act on', () => {
    expect(affordabilityNote('ak47', 3000)).toBe('$2,700');
    expect(affordabilityNote('ak47', 1200)).toBe('need $1,500');
    expect(affordabilityNote('ak47', 0)).toBe('need $2,700');
  });
});

// ---------------------------------------------------------------------------
// weaponLabel
// ---------------------------------------------------------------------------

describe('weaponLabel', () => {
  it('maps the required ids', () => {
    expect(weaponLabel('ak47')).toBe('AK-47');
    expect(weaponLabel('m4a4')).toBe(WEAPONS['m4a4'].name);
    expect(weaponLabel('awp')).toBe(WEAPONS['awp'].name);
    expect(weaponLabel('deagle')).toBe(WEAPONS['deagle'].name);
  });

  it('falls back to the raw id for unknown ids', () => {
    expect(weaponLabel('zzz')).toBe('Zzz');
    expect(weaponLabel('')).toBe('');
    expect(weaponLabel(undefined as unknown as string)).toBe('');
    // An id with no letters (or markup) must not be prettified into something
    // that looks like halfway-parsed HTML — it is rendered with textContent,
    // but the label itself should still be the raw id.
    expect(weaponLabel('<_script>')).toBe('< script>');
    expect(weaponLabel('<_script>')).not.toContain('<script');
    expect(weaponLabel('1234')).toBe('1234');
  });

  it('prettifies ids and equipment', () => {
    expect(prettifyId('m4a1_s')).toBe('M4a1 s');
    expect(prettifyId('')).toBe('');
    expect(equipmentLabel('kevlarhelmet')).toBe('Kevlar + Helmet');
    expect(equipmentLabel('defusekit')).toBe('Defuse Kit');
    expect(equipmentLabel('unknown-thing')).toBe('Unknown thing');
  });

  it('labels maps', () => {
    expect(mapLabel('de_dust2_lite')).toBe('DE DUST2 LITE');
    expect(mapLabel('')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// crosshairPixels
// ---------------------------------------------------------------------------

describe('crosshairPixels', () => {
  it('clamps to sane minimums so the crosshair can never vanish', () => {
    const p = crosshairPixels(0, 0, 0);
    expect(p.length).toBeGreaterThanOrEqual(4);
    expect(p.thickness).toBeGreaterThanOrEqual(1);
    expect(p.gap).toBeGreaterThanOrEqual(0);
    expect(p.outline).toBeGreaterThanOrEqual(1);
  });

  it('never returns zero, negative or non-finite geometry', () => {
    const inputs: [number, number, number][] = [
      [Number.NaN, Number.NaN, Number.NaN],
      [-50, -50, -50],
      [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
      [1e9, 1e9, 1e9],
    ];
    for (const [g, l, t] of inputs) {
      const p = crosshairPixels(g, l, t);
      // length / thickness / outline must always be strictly positive: a zero
      // sized arm or outline would make the crosshair invisible.
      for (const v of [p.length, p.thickness, p.outline]) {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThan(0);
      }
      // gap 0 is legal (arms meeting in the middle) but must never be negative.
      expect(Number.isFinite(p.gap)).toBe(true);
      expect(p.gap).toBeGreaterThanOrEqual(0);
    }
  });

  it('scales monotonically with the gap', () => {
    let prev = -1;
    for (const gap of [0, 1, 2, 4, 8, 16, 32, 64]) {
      const p = crosshairPixels(gap, 8, 2);
      expect(p.gap).toBeGreaterThan(prev);
      prev = p.gap;
    }
    expect(crosshairPixels(64, 8, 2).gap).toBeGreaterThan(crosshairPixels(4, 8, 2).gap);
  });

  it('scales monotonically with length and survives absurd values', () => {
    expect(crosshairPixels(4, 12, 2).length).toBeGreaterThan(crosshairPixels(4, 8, 2).length);
    expect(crosshairPixels(4, 1e9, 2).length).toBeLessThanOrEqual(256);
    expect(crosshairPixels(1e9, 8, 2).gap).toBeLessThanOrEqual(256);
    expect(crosshairScale(8)).toBe(1);
    expect(crosshairScale(16)).toBeGreaterThan(crosshairScale(8));
    expect(crosshairScale(0)).toBeGreaterThanOrEqual(0.35);
  });
});

// ---------------------------------------------------------------------------
// HUD effect envelopes
// ---------------------------------------------------------------------------

describe('effect envelopes', () => {
  it('hit marker fades to nothing in ~0.25s', () => {
    expect(hitMarkerAlpha(0, 0.25)).toBe(1);
    expect(hitMarkerAlpha(0.125, 0.25)).toBeCloseTo(0.25, 6);
    expect(hitMarkerAlpha(0.25, 0.25)).toBe(0);
    expect(hitMarkerAlpha(9, 0.25)).toBe(0);
    expect(hitMarkerAlpha(Number.NaN, 0.25)).toBe(1);
    expect(hitMarkerScale(0)).toBeGreaterThan(hitMarkerScale(0.25));
  });

  it('damage indicators fade over 1.5s', () => {
    expect(damageIndicatorState(0).opacity).toBe(1);
    expect(damageIndicatorState(0).progress).toBe(0);
    expect(damageIndicatorState(1.5).progress).toBe(1);
    expect(damageIndicatorState(1.5).opacity).toBe(0);
    expect(damageIndicatorState(99).progress).toBe(1);
  });

  it('announcements last ~2.5s', () => {
    expect(announceAlpha(0)).toBe(1);
    expect(announceAlpha(1)).toBe(1);
    expect(announceAlpha(2.5)).toBe(0);
    expect(announceAlpha(99)).toBe(0);
    expect(announceAlpha(2.4)).toBeLessThan(1);
    expect(announceAlpha(2.4)).toBeGreaterThan(0);
  });

  it('kill feed entries fade after ~6s', () => {
    expect(feedAlpha(0)).toBe(1);
    expect(feedAlpha(4)).toBe(1);
    expect(feedAlpha(6)).toBe(0);
    expect(feedAlpha(99)).toBe(0);
    expect(feedAlpha(5.5)).toBeGreaterThan(0);
    expect(feedAlpha(5.5)).toBeLessThan(1);
  });

  it('flash envelope attacks fast then decays slowly to zero', () => {
    expect(flashEnvelope(0, 0).opacity).toBe(0);
    expect(flashEnvelope(1, 0).opacity).toBe(0);
    expect(flashEnvelope(1, 0.03).opacity).toBeGreaterThan(0.4);
    expect(flashEnvelope(1, 0.1).opacity).toBeGreaterThan(0.4);
    const mid = flashEnvelope(1, 0.5).opacity;
    const late = flashEnvelope(1, 1.4).opacity;
    expect(mid).toBeGreaterThan(late);
    expect(late).toBeGreaterThanOrEqual(0);
    expect(flashEnvelope(1, 99).opacity).toBe(0);
    expect(flashEnvelope(Number.NaN, 0).opacity).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Radar blips
// ---------------------------------------------------------------------------

describe('radar blip helpers', () => {
  it('sizes blips for the backing store, clamped', () => {
    expect(blipRadius(512)).toBe(5);
    expect(blipRadius(1024)).toBe(9);
    expect(blipRadius(64)).toBeGreaterThanOrEqual(2);
    expect(blipRadius(Number.NaN)).toBeGreaterThanOrEqual(2);
    expect(blipRadius(-1)).toBeGreaterThanOrEqual(2);
  });

  it('builds an upward arrow of four points', () => {
    const pts = arrowPoints(0, 0, 5);
    expect(pts).toHaveLength(4);
    for (const [x, y] of pts) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
    expect(pts[0][1]).toBeLessThan(pts[1][1]); // tip above the base
  });
});

// ---------------------------------------------------------------------------
// colours / labels / misc
// ---------------------------------------------------------------------------

describe('colours and labels', () => {
  it('reflects the round phase in the clock colour', () => {
    expect(phaseClockColor('bomb', false)).toBe('#ff4d4d');
    expect(phaseClockColor('live', true)).toBe('#ff4d4d');
    expect(phaseClockColor('freeze', false)).toBe('#8fa3bf');
    expect(phaseClockColor('live', false)).toBe('#ffffff');
    expect(phaseClockColor('over', false)).toBe('#ffd166');
  });

  it('greys and reddens low health', () => {
    expect(healthColor(100)).toBe('#ffffff');
    expect(healthColor(25)).toBe('#ff4d4d');
    expect(healthColor(0)).toBe('#ff4d4d');
    expect(healthColor(40)).toBe('#ffd166');
    expect(healthColor(Number.NaN)).toBe('#ff4d4d');
  });

  it('colours teams, announcements and the score line', () => {
    expect(teamColor('T')).toBe('#ffb14d');
    expect(teamColor('CT')).toBe('#5aa9ff');
    expect(teamColor('SPEC')).toBe('#9aa4b2');
    expect(announceColor('kill')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(announceColor('round')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(announceColor('info')).toMatch(/^#[0-9a-f]{6}$/i);
    expect(scoreLine(13, 7)).toBe('13 — 7');
    expect(scoreLine(Number.NaN, 2)).toBe('0 — 2');
    expect(scoreLine(3.9, 4.1)).toBe('3 — 4');
  });

  it('names winners', () => {
    expect(winnerLabel('T')).toBe('Terrorists win');
    expect(winnerLabel('CT')).toBe('Counter-Terrorists win');
    expect(winnerShort('CT')).toBe('COUNTER-TERRORISTS');
    expect(formatMatchClock(125)).toBe('2:05');
    expect(formatMatchClock(-1)).toBe('0:00');
  });

  it('coerces numbers safely', () => {
    expect(toFinite(3, 0)).toBe(3);
    expect(toFinite(Number.NaN, 7)).toBe(7);
    expect(toFinite('3' as unknown as number, 7)).toBe(7);
    expect(toFinite(Number.POSITIVE_INFINITY, 7)).toBe(7);
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// styles.ts — the sheet must be a plain string and cover the classes Hud uses
// ---------------------------------------------------------------------------

describe('styles', () => {
  it('exports a single non-empty CSS template', () => {
    expect(typeof CSS).toBe('string');
    expect(CSS.length).toBeGreaterThan(1000);
    expect(ROOT_CLASS).toBe('hud-root');
    expect(STYLE_ID).toBe('hud-styles');
  });

  it('keeps the HUD click-through and the crosshair centred', () => {
    expect(CSS).toMatch(/\.hud-root\s*\{[^}]*pointer-events:\s*none/s);
    expect(CSS).toMatch(/\.hud-interactive\s*\{[^}]*pointer-events:\s*auto/s);
    // The crosshair sits at the exact viewport centre. It is a zero-sized
    // origin at left/top 50% (equivalently translate(-50%,-50%)), and its arms
    // are positioned relative to that origin, so it can never drift with
    // resolution or with the arm length coming from the spread model.
    const rule = CSS.slice(CSS.indexOf('.hud-xh{'), CSS.indexOf('}', CSS.indexOf('.hud-xh{')));
    expect(rule).toContain('left:50%');
    expect(rule).toContain('top:50%');
    expect(rule).toMatch(/width:\s*0/);
    expect(rule).toMatch(/height:\s*0/);
    expect(rule).not.toMatch(/:\s*-?\d+(\.\d+)?(px|rem|em|vh|vw)/);
    // ...and the arms themselves are transformed about that origin.
    expect(CSS).toMatch(/\.hud-xh-line\s*\{[^}]*transform-origin/s);
  });

  it('defines every class the Hud markup relies on', () => {
    const required = [
      'hud-root',
      'hud-hidden',
      'hud-radar',
      'hud-money',
      'hud-top',
      'hud-clock',
      'hud-score',
      'hud-round-no',
      'hud-bomb',
      'hud-defuse',
      'hud-announce',
      'hud-feed',
      'hud-feed-row',
      'hud-xh',
      'hud-xh-line',
      'hud-xh-dot',
      'hud-hitmarker',
      'hud-dmg',
      'hud-flash',
      'hud-dmgflash',
      'hud-dead',
      'hud-left',
      'hud-right',
      'hud-weapon',
      'hud-ammo',
      'hud-reload',
      'hud-debug',
      'hud-buy',
      'hud-scoreboard-wrap',
      'hud-result',
      'hud-matchend',
      'hud-menu',
    ];
    for (const cls of required) expect(CSS).toContain(`.${cls}`);
  });

  it('keeps the main bands resolution independent', () => {
    // The HUD bands may only use rem/em/vh/vw/% — pixel values are reserved for
    // the crosshair arms (driven by the spread model) and 1px outlines.
    for (const cls of ['hud-radar', 'hud-money', 'hud-top', 'hud-left', 'hud-right', 'hud-feed', 'hud-dead']) {
      const start = CSS.indexOf(`.${cls}{`);
      if (start < 0) continue;
      const rule = CSS.slice(start, CSS.indexOf('}', start));
      expect(rule).not.toMatch(/:\s*-?\d+(\.\d+)?px/);
    }
  });
});
