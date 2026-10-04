# World materials, textures & sky — integration notes

Owner module: `src/world/textures.ts`, `src/world/materials.ts`, `src/world/sky.ts`.
This file is the contract the map/geometry workstream (`MapGeometry.ts`, `maps/de_dust2_lite.ts`) codes against.
Nothing here loads a file from disk: every pixel is painted into a canvas at runtime.

## 1. The texture tiling contract (read this before writing UVs)

The map renderer merges hundreds of brushes into **one mesh per material**, so a single
`THREE.Texture` is shared by brushes of very different sizes. Three.js stores exactly one
`map.repeat` per texture, which therefore *cannot* express per-brush tiling.

Resolution: **the geometry builder owns tiling and bakes it into the vertex UVs.**
`map.repeat` is pinned to `(1, 1)` forever and `map.offset` to `(0, 0)`.

```ts
import { getTexture, textureRecipe, uvTileFactor, uvScalePair } from './textures';

// per brush face, before building/merging geometry:
const recipe = textureRecipe(brush.material);
const [su, sv] = uvScalePair(faceSizeU, faceSizeV, brush.texScale, recipe);
for (const uv of faceUVs) {
  uv[0] = (uv[0] * su) % 1;   // optional: keep numbers small, tiling is exact
  uv[1] = (uv[1] * sv) % 1;
}
```

`uvTileFactor(brushSize, texScale, recipe)` returns *the number of times the texture repeats
across that axis*, i.e. `brushSize / resolveTexScale(texScale, recipe)`.
`resolveTexScale` maps the per-brush hint to world units per tile:

| `brush.texScale` | result |
| --- | --- |
| a finite number `> 0` | that value (world units per tile) |
| `0`, `undefined`, `NaN`, `±Infinity`, negative | `recipe.repeatUnits` (the material default) |

`Brush.texScale` in `src/core/types.ts` documents `0 = derive from material default`, so leaving
the field out of a brush literal is correct and common.

**Why this matters:** if anyone sets `map.repeat` to `1 / texScale` "to fix tiling", every mesh
sharing that material stretches by the ratio of their sizes. That is the single most likely way to
make the whole map look wrong. `applyMaterialToMesh` re-asserts `(1, 1)` on every call as a guard.

## 2. Drawing a tile / getting a texture

```ts
import { drawTextureTile, getTexture, disposeTextures, DEFAULT_TEXTURE_SEED } from './textures';

const canvas = drawTextureTile('sandstone', 256, 1337); // fresh canvas, deterministic pixels
const tex    = getTexture('sandstone');                 // cached THREE.CanvasTexture, seed 1337
const noisy  = getTexture('concrete', 99);              // a second cached variant
```

* Same `(name, size, seed)` always paints identical pixels: the RNG is `mulberry32` from
  `src/core/rng.ts`, never `Math.random()`.
* `getTexture` sets `wrapS = wrapT = RepeatWrapping`, `colorSpace = SRGBColorSpace`,
  `anisotropy = 4`, and pins `repeat = (1, 1)`.
* Both `drawTextureTile` and `getTexture` need a `document`; in a headless/Node context
  `drawTextureTile` throws a clear `[textures] cannot draw "<name>" ...` error. The pure helpers
  (`textureRecipe`, `resolveTexScale`, `uvTileFactor`, `uvScalePair`) never touch a canvas and are
  what the unit tests exercise.

### Seamlessness

No texture may show a tile seam. Two techniques are used and commented in `textures.ts`:

1. **Periodic value noise** — the noise lattice is sampled with coordinates wrapped modulo the
   lattice size, so the field itself is periodic over the tile (`makePeriodicNoise`).
2. **Wrapped stamping** — every vector feature (a pit, a knot, a crack, a rivet) is drawn up to
   four times at the wrapped offsets `(0,0)`, `(+size,0)`, `(0,+size)`, `(+size,+size)` about its
   modulo-wrapped centre (`paintWrapped`, `strokeWrapped`, `strokeLineWrapped`), so a feature
   straddling an edge reappears on the opposite edge.
   Border-aligned shapes (crate frame, panel seam, plank gaps, brick mortar) are placed *on* the
   border so they read as continuous across tiles.

## 3. Materials

```ts
import { getMaterial, applyMaterialToMesh, disposeMaterials, MATERIAL_ALBEDO } from './materials';

const mat = getMaterial(brush.material, { tint: brush.tint, texScale: brush.texScale });
applyMaterialToMesh(mesh, brush.material, { tint: brush.tint, texScale: brush.texScale });
```

* Cache key: `` `${material}|${tint ?? 'none'}|${texScale ?? 0}` ``, so the ~600 brushes in
  `de_dust2_lite` collapse to roughly ten materials. **Never build a material per brush** — the
  ≤ 14 draw-call budget depends on this. `getViewMaterial` uses the same shape under a `view:` prefix.
* `tint` (0xRRGGBB) multiplies `material.color`; without it the material uses `MATERIAL_ALBEDO`.
* `applyMaterialToMesh(mesh, material, opts)` is in-place and idempotent. It sets
  `mesh.name = 'mt-<material>'` and `mesh.userData.material` / `.tint` / `.texScale`, then
  `castShadow = receiveShadow = true` and `matrixAutoUpdate = false` + `updateMatrix()`
  (world brushes are static; re-enable `matrixAutoUpdate` if a mesh ever moves).
* `isTransparent(m)` is true only for `glass` (opacity 0.28, `transparent: true`). Transparent
  brushes should be excluded from occlusion/`world.ts` solidity if that is not already the case.
* **Shared materials are never disposed per mesh.** `disposeMaterials()` is the only teardown and
  it locks the cache: any later `getMaterial` throws, deliberately.
  `disposeTextures()` is separate (the texture cache owns texture lifetime).
* `materialCacheSize()` reports how many distinct materials exist — assert it stays small.

| material | recipe size | world units per tile | albedo |
| --- | --- | --- | --- |
| `sandstone` | 256 | 128 | `0xc2a678` |
| `concrete` | 256 | 160 | `0x9a9a97` |
| `wood` | 256 | 96 | `0x8a5f38` |
| `metal` | 256 | 80 | `0xa9adb3` |
| `sand` | 256 | 180 | `0xd8c98a` |
| `glass` | 128 | 96 | `0xdfeaf2` |
| `flesh` | 64 | 24 | `0xa94a44` |
| `water` | 256 | 220 | `0x22454a` |

Extra (non-`SurfaceMaterial`) texture names: `crate` (96 u/tile), `brickSand` (132), `metalPanel`
(112), `woodPlank` (96), `radar` (1024 px, 1 u/tile, authored transparent for HUD overlay).

`brickSand` and `woodPlank` use a 264 px tile instead of 256: 264 is an exact multiple of their
feature periods (4 brick courses of 66, 4 plank gaps of 66), which is what keeps the stamped layout
periodic — i.e. seamless. They are the only two non-power-of-two recipes, and neither is used where
mipmap-sensitive (both are `NearestMipmap`-safe under WebGL2/ES3, which is what Three.js targets).

## 4. Sky and lighting

```ts
import { createSky } from './sky';

const rig = createSky(scene, { turbidity: 1 });   // adds dome + glow + sun + fill, sets scene.fog
// ... game loop ...
rig.dispose();                                    // idempotent: removes and disposes everything
```

* Dome radius `SKY_DOME_RADIUS = 9000`, inside `CAMERA.far = 12000`. Do not raise the camera far
  plane below ~9500 without changing this.
* `scene.fog = new THREE.Fog(0xcfc3a8, 2600, 11000)` — warm dust haze. `dispose()` nulls
  `scene.fog` only while it still points at this rig's fog object, so a replacement fog survives.
* Sun: `DirectionalLight`, colour `0xfff2d6`, intensity 1.15, positioned at
  `DEFAULT_SUN_DIRECTION * 4000` where `DEFAULT_SUN_DIRECTION = (0.528, 0.602, -0.602).normalize()`
  — roughly 37° elevation, sun up and to the right, so long shadows fall left and towards the
  camera across mid. It is deliberately fixed: the map's mood and any baked shadow expectations
  assume one static sun.
* Shadows: `shadow.mapSize = PERF.shadowMapSize` (2048), orthographic camera covering ±3200 world
  units, `near = 1`, `far = 14000`, `bias = -0.0008`, `normalBias = 0.02`. The renderer must set
  `renderer.shadowMap.enabled = true` and pick a type; the light is already `castShadow = true`.
  Keep the playable map inside ±3200 of the origin or shadows will clip.
* Fill: `HemisphereLight(0xbcd6ff, 0x9a8560, 0.55)` — cool sky bounce over warm sand bounce, which
  is what keeps shadowed sandstone from going black.
* `dispose()` intentionally does **not** dispose `sunLight.shadow.map`: the renderer owns that.

## 5. Canvas-free surface (what the tests may touch)

`textureRecipe`, `TEXTURE_RECIPES`, `resolveTexScale`, `uvTileFactor`, `uvScalePair`,
`materialCacheKey`, `viewMaterialCacheKey`, `MATERIAL_ALBEDO`, `isTransparent`,
`TRANSPARENT_MATERIALS` are all pure data/functions with no DOM and no WebGL. Every function that
needs a canvas (`drawTextureTile`, `getTexture`, `getMaterial`, `createSkyDome`, `createSky`) either
throws a clear error or is excluded from the headless test file (`tests/textures.spec.ts`).
