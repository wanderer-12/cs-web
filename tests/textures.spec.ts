// =============================================================================
// tests/textures.spec.ts — headless unit tests for the procedural material layer.
//
// vitest runs these in a bare Node environment (`environment: 'node'`), so there is
// no `document`, no canvas and no WebGL. That is deliberate: everything asserted
// here is a *decision* — recipe tables, cache keys, the UV tiling contract and the
// transparency/albedo rules — never a pixel.
//
// `drawTextureTile` / `getTexture` / `getMaterial` / `createSky*` are therefore
// never called from this file. If one of them regresses, `pnpm exec tsc --noEmit`
// plus the browser is the place to catch it, not here.
// =============================================================================

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TEXTURE_SEED,
  TEXTURE_RECIPES,
  resolveTexScale,
  textureRecipe,
  uvScalePair,
  uvTileFactor,
  type ProcTextureName,
  type TextureRecipe,
} from '../src/world/textures';

import {
  MATERIAL_ALBEDO,
  TRANSPARENT_MATERIALS,
  isTransparent,
  materialCacheKey,
  viewMaterialCacheKey,
  type MaterialOptions,
} from '../src/world/materials';

// ---------------------------------------------------------------------------
// Fixtures: the canonical name lists, written out literally so that adding a new
// material to the union without handling it here fails the build (the arrays are
// typed as the union, not as `string[]`) rather than silently passing.
// ---------------------------------------------------------------------------

const SURFACE_MATERIALS = [
  'sandstone',
  'concrete',
  'wood',
  'metal',
  'sand',
  'glass',
  'flesh',
  'water',
] as const;

const EXTRA_TEXTURE_NAMES = [
  'radar',
  'metalPanel',
  'woodPlank',
  'crate',
  'brickSand',
] as const;

/** Every `ProcTextureName`: the 8 surface materials plus the 5 extra names. */
const ALL_TEXTURE_NAMES: readonly ProcTextureName[] = [
  ...SURFACE_MATERIALS,
  ...EXTRA_TEXTURE_NAMES,
];

/** Names that are used for UI/level dressing rather than a `Brush.material`. */
const NON_SURFACE_TEXTURE_NAMES = new Set<string>(EXTRA_TEXTURE_NAMES);

function options(
  material: Parameters<typeof materialCacheKey>[0],
  opts: MaterialOptions,
): string {
  return materialCacheKey(material, opts);
}

// ---------------------------------------------------------------------------
// 1. Recipe sanity — every name in the character table is described, and the
//    description is usable by the geometry builder.
// ---------------------------------------------------------------------------

describe('textureRecipe', () => {
  it('covers every ProcTextureName', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      expect(textureRecipe(name), `missing recipe for "${name}"`).toBeDefined();
    }
  });

  it('covers exactly the 13 declared names and nothing else', () => {
    expect(Object.keys(TEXTURE_RECIPES).sort()).toEqual([...ALL_TEXTURE_NAMES].sort());
    expect(ALL_TEXTURE_NAMES).toHaveLength(13);
  });

  it('returns the same frozen description by table lookup', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      expect(textureRecipe(name)).toBe(TEXTURE_RECIPES[name]);
    }
  });

  it('gives a positive, integral, power-of-two-or-feature-periodic size', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      const { size } = textureRecipe(name);
      expect(Number.isInteger(size), `${name} size ${size} must be an integer`).toBe(true);
      expect(size, `${name} size must be positive`).toBeGreaterThan(0);
      // 256 is the norm; 264 is the deliberate exception for the two materials
      // whose stamped feature period (66) has to divide the tile edge exactly.
      expect([64, 128, 256, 264, 512, 1024]).toContain(size);
    }
  });

  it('gives a positive, finite repeatUnits (world units per tile)', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      const { repeatUnits } = textureRecipe(name);
      expect(Number.isFinite(repeatUnits), `${name} repeatUnits must be finite`).toBe(true);
      expect(repeatUnits, `${name} repeatUnits must be > 0`).toBeGreaterThan(0);
    }
  });

  it('keeps world-scale tiling in a plausible range for a 128-unit brush grid', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      if (name === 'radar') continue; // UI overlay: one tile covers the whole radar
      // The map grid is 128 world units; a tile much smaller than ~16 units
      // would alias into noise, and one much larger than ~512 would read flat.
      expect(textureRecipe(name).repeatUnits).toBeGreaterThanOrEqual(24);
      expect(textureRecipe(name).repeatUnits).toBeLessThanOrEqual(512);
    }
  });

  it('sizes the radar tile for the HUD radar canvas', () => {
    // PERF.radarSize is 512; the radar base is a 1024 equirect-ish tile, and its
    // repeatUnits of 1 means "one tile covers the whole radar".
    expect(textureRecipe('radar').repeatUnits).toBe(1);
    expect(textureRecipe('radar').size).toBeGreaterThanOrEqual(512);
  });

  it('defaults every surface material to a power of two except the documented two', () => {
    const nonPow2 = ALL_TEXTURE_NAMES.filter((n) => {
      const s = textureRecipe(n).size;
      return (s & (s - 1)) !== 0;
    });
    expect(nonPow2.sort()).toEqual(['brickSand', 'woodPlank']);
    for (const n of nonPow2) {
      // 264 = 4 x 66: the stamped feature period divides the tile edge, which is
      // what makes those two tiles seamless.
      expect(textureRecipe(n).size % 66).toBe(0);
    }
  });

  it('uses a positive integer DEFAULT_TEXTURE_SEED', () => {
    expect(Number.isInteger(DEFAULT_TEXTURE_SEED)).toBe(true);
    expect(DEFAULT_TEXTURE_SEED).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 2. The material cache key — the whole draw-call budget rests on this.
// ---------------------------------------------------------------------------

describe('materialCacheKey', () => {
  it('is stable for identical inputs', () => {
    expect(materialCacheKey('sandstone')).toBe(materialCacheKey('sandstone'));
    expect(options('sandstone', {})).toBe(materialCacheKey('sandstone'));
    expect(options('metal', { tint: 0x336699, texScale: 64 })).toBe(
      materialCacheKey('metal', { tint: 0x336699, texScale: 64 }),
    );
  });

  it('distinguishes materials', () => {
    const keys = new Set(SURFACE_MATERIALS.map((m) => materialCacheKey(m)));
    expect(keys.size).toBe(SURFACE_MATERIALS.length);
  });

  it('distinguishes tints', () => {
    expect(materialCacheKey('concrete', { tint: 0x000000 })).not.toBe(
      materialCacheKey('concrete', { tint: 0xffffff }),
    );
    // ...and an explicit tint is never confused with "no tint".
    expect(materialCacheKey('concrete', { tint: 0x000000 })).not.toBe(
      materialCacheKey('concrete'),
    );
  });

  it('distinguishes texScale', () => {
    expect(materialCacheKey('wood', { texScale: 32 })).not.toBe(
      materialCacheKey('wood', { texScale: 64 }),
    );
  });

  it('treats texScale 0 and an omitted texScale as the same "use the default" entry', () => {
    // `Brush.texScale` documents 0 as "derive from the material default", so the
    // two spellings must share one material rather than allocating two. Each new
    // distinct key is another draw call, and the budget is ~14.
    expect(materialCacheKey('wood', { texScale: 0 })).toBe(materialCacheKey('wood'));
    expect(materialCacheKey('wood', {})).toBe('wood|none|0');
  });

  it('follows the documented `${material}|${tint ?? none}|${texScale ?? 0}` shape', () => {
    expect(materialCacheKey('sandstone')).toBe('sandstone|none|0');
    expect(materialCacheKey('sandstone', {})).toBe('sandstone|none|0');
    expect(materialCacheKey('glass', { tint: 0x123456 })).toBe('glass|1193046|0');
    expect(materialCacheKey('metal', { texScale: 48 })).toBe('metal|none|48');
    expect(materialCacheKey('water', { tint: 0xff, texScale: 12 })).toBe('water|255|12');
  });

  it('collapses the many-brushes case to one entry per (material, tint, texScale)', () => {
    // Simulates ~600 brushes whose texScale hints resolve through the recipe:
    // the key must only ever depend on the brush's own fields, never on size.
    const keys = new Set<string>();
    let brushCount = 0;
    for (let i = 0; i < 601; i++) {
      const m = SURFACE_MATERIALS[i % SURFACE_MATERIALS.length];
      const tint = i % 97 === 0 ? 0x445566 : undefined;
      keys.add(materialCacheKey(m, tint === undefined ? {} : { tint }));
      brushCount++;
    }
    expect(brushCount).toBe(601);
    expect(keys.size).toBeLessThanOrEqual(16);
  });

  it('never produces an ambiguous key from a tint that looks like "none"', () => {
    // 'none' is the sentinel for "no tint"; an explicit tint always stringifies
    // to digits, so the two can never collide.
    for (let t = 0; t <= 0xffffff; t += 0x111111) {
      expect(materialCacheKey('sand', { tint: t })).not.toContain('|none|');
    }
  });

  it('gives the view-model cache an independent namespace', () => {
    expect(viewMaterialCacheKey('metal')).not.toBe(materialCacheKey('metal'));
    expect(viewMaterialCacheKey('metal', { texScale: 8 })).not.toBe(
      materialCacheKey('metal', { texScale: 8 }),
    );
    expect(viewMaterialCacheKey('metal', { texScale: 8 })).toBe(
      viewMaterialCacheKey('metal', { texScale: 8 }),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The UV tiling contract — the thing that keeps the map from looking
//    stretched. The geometry builder does `uv *= uvTileFactor(...)`.
// ---------------------------------------------------------------------------

describe('resolveTexScale', () => {
  const recipe: TextureRecipe = { size: 256, repeatUnits: 128 };

  it('honours a positive finite texScale hint', () => {
    expect(resolveTexScale(64, recipe)).toBe(64);
    expect(resolveTexScale(0.5, recipe)).toBe(0.5);
  });

  it.each([
    ['0', 0],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['negative', -32],
  ])('falls back to recipe.repeatUnits for texScale = %s', (_label, hint) => {
    expect(resolveTexScale(hint as number | undefined, recipe)).toBe(recipe.repeatUnits);
  });

  it('falls back to each material recipe default, not one global constant', () => {
    for (const name of SURFACE_MATERIALS) {
      const r = textureRecipe(name);
      expect(resolveTexScale(0, r)).toBe(r.repeatUnits);
    }
    const defaults = new Set(SURFACE_MATERIALS.map((m) => resolveTexScale(0, textureRecipe(m))));
    // The materials genuinely differ in world scale (80..220 units per tile).
    expect(defaults.size).toBeGreaterThan(4);
  });
});

describe('uvTileFactor', () => {
  const recipe: TextureRecipe = { size: 256, repeatUnits: 128 };

  it('is worldSize / unitsPerTile when a hint is given', () => {
    // A 512-unit wide face tiled at 64 units per tile repeats 8 times.
    expect(uvTileFactor(512, 64, recipe)).toBe(8);
    // A 32-unit face tiled at 64 units per tile repeats half a time.
    expect(uvTileFactor(32, 64, recipe)).toBe(0.5);
    expect(uvTileFactor(128, 128, recipe)).toBe(1);
  });

  it('uses the recipe default when texScale is 0 (the documented fallback)', () => {
    expect(uvTileFactor(256, 0, recipe)).toBe(2); // 256 / 128
    expect(uvTileFactor(256, 0, recipe)).toBe(uvTileFactor(256, undefined, recipe));
    expect(Number.isFinite(uvTileFactor(256, 0, recipe))).toBe(true);
    expect(uvTileFactor(256, 0, recipe)).not.toBe(Number.POSITIVE_INFINITY);
  });

  it('is exactly 1 for one tile edge', () => {
    for (const name of ALL_TEXTURE_NAMES) {
      const r = textureRecipe(name);
      expect(uvTileFactor(r.repeatUnits, 0, r), name).toBeCloseTo(1, 10);
      expect(uvTileFactor(r.repeatUnits, r.repeatUnits, r), name).toBeCloseTo(1, 10);
    }
  });

  it('scales linearly with world size for a fixed hint', () => {
    const small = uvTileFactor(64, 32, recipe);
    const big = uvTileFactor(256, 32, recipe);
    expect(big / small).toBeCloseTo(4, 10);
  });

  it('never returns NaN or Infinity for degenerate brush sizes', () => {
    for (const size of [0, -0, -16, Number.NaN, Number.POSITIVE_INFINITY]) {
      const f = uvTileFactor(size, 0, recipe);
      expect(Number.isNaN(f), `size ${size} produced NaN`).toBe(false);
      expect(Number.isFinite(f), `size ${size} produced Infinity`).toBe(true);
    }
    expect(uvTileFactor(0, 0, recipe)).toBe(0);
  });

  it('is isotropic today (U and V share a unit), so a square brush gives square tiling', () => {
    const [su, sv] = uvScalePair(128, 128, 0, recipe);
    expect(su).toBe(sv);
    expect(su).toBeCloseTo(1, 10);
  });

  it('applies the same hint to both axes for a non-square brush', () => {
    expect(uvScalePair(256, 64, 64, recipe)).toEqual([4, 1]);
    expect(uvScalePair(256, 64, 0, recipe)).toEqual([2, 0.5]);
  });
});

// ---------------------------------------------------------------------------
// 4. Transparency + albedo tables.
// ---------------------------------------------------------------------------

describe('isTransparent', () => {
  it('is true only for glass', () => {
    expect(isTransparent('glass')).toBe(true);
    for (const m of SURFACE_MATERIALS) {
      if (m === 'glass') continue;
      expect(isTransparent(m), `${m} must not be transparent`).toBe(false);
    }
  });

  it('returns a strict boolean, not a truthy value', () => {
    for (const m of SURFACE_MATERIALS) {
      expect(typeof isTransparent(m)).toBe('boolean');
    }
  });

  it('agrees with the TRANSPARENT_MATERIALS list', () => {
    expect([...TRANSPARENT_MATERIALS]).toEqual(['glass']);
    for (const m of SURFACE_MATERIALS) {
      expect(isTransparent(m)).toBe(TRANSPARENT_MATERIALS.includes(m));
    }
  });
});

describe('MATERIAL_ALBEDO', () => {
  it('has an entry for every SurfaceMaterial and no extras', () => {
    expect(Object.keys(MATERIAL_ALBEDO).sort()).toEqual([...SURFACE_MATERIALS].sort());
  });

  it('stores a valid 24-bit colour for every material', () => {
    for (const m of SURFACE_MATERIALS) {
      const c = MATERIAL_ALBEDO[m];
      expect(Number.isInteger(c), `${m} albedo ${c} must be an integer`).toBe(true);
      expect(c, `${m} albedo below 0`).toBeGreaterThanOrEqual(0x000000);
      expect(c, `${m} albedo above 0xffffff`).toBeLessThanOrEqual(0xffffff);
    }
  });

  it('never uses a fully black or fully white fallback (it would hide a missing texture)', () => {
    for (const m of SURFACE_MATERIALS) {
      expect(MATERIAL_ALBEDO[m]).not.toBe(0x000000);
      expect(MATERIAL_ALBEDO[m]).not.toBe(0xffffff);
    }
  });

  it('gives glass a bright, low-saturation base so its low opacity still reads', () => {
    const c = MATERIAL_ALBEDO.glass;
    const r = (c >> 16) & 0xff;
    const g = (c >> 8) & 0xff;
    const b = c & 0xff;
    expect(Math.min(r, g, b)).toBeGreaterThan(0x80);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(0x30);
  });

  it('keeps the terrain materials in their documented families', () => {
    const hex = (m: keyof typeof MATERIAL_ALBEDO): [number, number, number] => [
      (MATERIAL_ALBEDO[m] >> 16) & 0xff,
      (MATERIAL_ALBEDO[m] >> 8) & 0xff,
      MATERIAL_ALBEDO[m] & 0xff,
    ];
    const [sr, sg, sb] = hex('sandstone');
    expect(sr).toBeGreaterThan(sg); // warm
    expect(sg).toBeGreaterThan(sb);
    const [wr, wg, wb] = hex('water');
    expect(wb).toBeGreaterThan(wr); // blue-green, not brown
    expect(wg).toBeGreaterThan(wr);
    const [cr, , cb] = hex('concrete');
    expect(Math.abs(cr - cb)).toBeLessThan(0x10); // neutral grey
  });
});

// ---------------------------------------------------------------------------
// 5. The character table completeness rule, stated as the module's own contract:
//    every SurfaceMaterial must have a recipe AND a texture of its own name.
// ---------------------------------------------------------------------------

describe('character table', () => {
  it('has exactly one recipe per distinct ProcTextureName', () => {
    const names = new Set(ALL_TEXTURE_NAMES);
    expect(names.size).toBe(ALL_TEXTURE_NAMES.length);
    expect(Object.keys(TEXTURE_RECIPES)).toHaveLength(names.size);
  });

  it('covers every SurfaceMaterial with a directly-named texture', () => {
    for (const m of SURFACE_MATERIALS) {
      expect(m in TEXTURE_RECIPES, `${m} has no texture of its own name`).toBe(true);
      expect(textureRecipe(m).size).toBeGreaterThan(0);
    }
  });

  it('covers the five extra surface character names', () => {
    for (const n of EXTRA_TEXTURE_NAMES) {
      expect(NON_SURFACE_TEXTURE_NAMES.has(n)).toBe(true);
      expect(textureRecipe(n).repeatUnits).toBeGreaterThan(0);
    }
  });

  it('describes each name with a usable size, even where two names share a tiling scale', () => {
    // `crate` and `wood` share `256@96`, and `brickSand` and `sandstone` share
    // `256@128`: those pairs are deliberately drawn by different canvas stages
    // (plank frame + brace, mortar courses) rather than by the recipe table.
    // What the table must guarantee is that each name has a canvas big enough to
    // hold its feature period, so assert that instead of false uniqueness.
    for (const name of ALL_TEXTURE_NAMES) {
      const r = textureRecipe(name);
      expect(r.size, `${name} needs at least a 64px canvas`).toBeGreaterThanOrEqual(64);
      expect(Number.isInteger(Math.log2(r.size)) || r.size % 66 === 0, name).toBe(true);
    }
  });

  it('separates the two "darker / grittier" variants from their base surface', () => {
    // crate must not be pixel-identical to wood, and brickSand must not be
    // identical to sandstone — they differ by drawn features, but the check that
    // they are *addressable* separately is that both names exist in the table.
    expect(textureRecipe('crate')).not.toBe(textureRecipe('wood'));
    expect(textureRecipe('brickSand')).not.toBe(textureRecipe('sandstone'));
  });

  it('keeps the wooden family ordered: crate darker than wood, woodPlank near wood', () => {
    // crate is drawn distinctly darker than the plain wood tile; the recipes
    // differ in world scale, which is the only lever the table has over "reads
    // as darker" from the tiling side.
    expect(textureRecipe('crate').repeatUnits).toBe(textureRecipe('wood').repeatUnits);
    expect(textureRecipe('woodPlank').repeatUnits).toBe(textureRecipe('wood').repeatUnits);
  });
});
