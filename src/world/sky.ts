// =============================================================================
// world/sky.ts — Dust2-looking sky dome, sun and fill lighting.
//
// The de_dust2 look is "blown-out hazy noon": a bright, nearly white-blue zenith
// that washes out into warm dust haze at the horizon, with a hard sun high enough
// to throw long shadows across mid. None of it is an asset — the dome is a single
// 2-D canvas painted at runtime and mapped equirectangularly onto an inside-out
// sphere, so `u` is azimuth and `v` runs from the zenith (v=0) to the nadir (v=1).
//
// Sun direction: this module views the world from the +Z side (the Sun is at +X,
// +Y, -Z), so the sun sits up-and-to-the-right and shadows fall to the left and
// towards the camera. Elevation is atan2(0.602, sqrt(0.528² + 0.602²)) ≈ 37°, the
// classic late-morning angle that keeps the map readable and the shadows long
// without the whole play space going dark. It is fixed on purpose: CS maps have
// static sun, and the baked shadow cache depends on it.
// =============================================================================

import * as THREE from 'three';
import { mulberry32 } from '../core/rng';
import { PERF } from '../core/config';

export interface SkyOptions {
  /** Direction FROM the world TOWARDS the sun (normalised here if needed). */
  sunDirection?: THREE.Vector3;
  /** 1 = crisp sky, >1 = hazier and warmer. Clamped to [0.5, 4]. */
  turbidity?: number;
}

export interface SkyRig {
  group: THREE.Group;
  sunLight: THREE.DirectionalLight;
  hemiLight: THREE.HemisphereLight;
  fog: THREE.Fog;
  dispose(): void;
}

/** Dust2's high, slightly right-of-centre sun; see the header note. */
export const DEFAULT_SUN_DIRECTION = new THREE.Vector3(0.528, 0.602, -0.602).normalize();

/** Camera far plane is 12000 (`CAMERA.far`); 9000 keeps the dome comfortably inside. */
export const SKY_DOME_RADIUS = 9000;
/** Radial exponent of the dome gradient; a bit above 1 keeps the horizon tight. */
export const SKY_GRADIENT_POWER = 1.35;

const FOG_COLOR = 0xcfc3a8;
const FOG_NEAR = 2600;
const FOG_FAR = 11000;

const SUN_LIGHT_COLOR = 0xfff2d6;
const SUN_LIGHT_INTENSITY = 1.15;
const SUN_SHADOW_EXTENT = 3200; // half-extent of the ortho shadow frustum
const SUN_SHADOW_FAR = 14000;

const HEMI_SKY_COLOR = 0xbcd6ff;
const HEMI_GROUND_COLOR = 0x9a8560;
const HEMI_INTENSITY = 0.55;

const DEFAULT_SKY_SEED = 20240607;

// ---------------------------------------------------------------------------
// Canvas access (mirrors the guard in textures.ts: tests run headless)
// ---------------------------------------------------------------------------

function canvasFactory(): HTMLCanvasElement {
  if (typeof document === 'undefined' || typeof document.createElement !== 'function') {
    throw new Error('[sky] createSkyDome needs a document; there is no canvas in this environment.');
  }
  return document.createElement('canvas');
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

// ---------------------------------------------------------------------------
// Dome painting
// ---------------------------------------------------------------------------

/** Very cheap value noise, only used to break up cloud blobs. */
function blobNoise(seed: number): (x: number, y: number) => number {
  const rnd = mulberry32(seed);
  const grid = 32;
  const v = new Float32Array(grid * grid);
  for (let i = 0; i < v.length; i++) v[i] = rnd();
  const at = (x: number, y: number): number => {
    const ix = ((x % grid) + grid) % grid;
    const iy = ((y % grid) + grid) % grid;
    return v[iy * grid + ix];
  };
  return (x, y) => {
    const x0 = Math.floor(x);
    const y0 = Math.floor(y);
    const tx = x - x0;
    const ty = y - y0;
    return (
      at(x0, y0) * (1 - tx) * (1 - ty) +
      at(x0 + 1, y0) * tx * (1 - ty) +
      at(x0, y0 + 1) * (1 - tx) * ty +
      at(x0 + 1, y0 + 1) * tx * ty
    );
  };
}

/**
 * Paints the equirectangular dome tile.
 *
 * Exported for reuse (e.g. a loading-screen backdrop). The `u` axis wraps at the
 * equirect seam (180°), and every cloud blob is therefore drawn at both u and
 * u+width so nothing is cut in half along the wrap.
 */
export function drawSkyCanvas(
  width: number,
  height: number,
  sunDirection: THREE.Vector3,
  turbidity: number,
  seed = DEFAULT_SKY_SEED,
): HTMLCanvasElement {
  const canvas = canvasFactory();
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[sky] 2D canvas context unavailable');

  const turb = clamp(turbidity, 0.5, 4);
  const horizonShift = clamp((turb - 1) * 0.06, -0.03, 0.2);

  // --- vertical gradient: zenith blue -> pale mid -> warm dust haze ----------
  const grad = ctx.createLinearGradient(0, 0, 0, height);
  grad.addColorStop(0.0, '#4f86c6');
  grad.addColorStop(0.22, '#7db2e0');
  grad.addColorStop(clamp(0.42 + horizonShift, 0.3, 0.62), '#bcd6ec');
  grad.addColorStop(clamp(0.5 + horizonShift, 0.4, 0.7), '#e6e2cf');
  grad.addColorStop(clamp(0.62 + horizonShift * 0.5, 0.5, 0.85), '#e9d9b4');
  grad.addColorStop(1.0, '#d8c49a');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, height);

  // --- cloud blobs, concentrated in the upper half --------------------------
  const uat = (u: number): number => ((u % 1) + 1) % 1;
  const rnd = mulberry32(seed ^ 0x51ed270b);
  const noise = blobNoise(seed ^ 0x7feb352d);
  const azimuth = Math.atan2(sunDirection.x, -sunDirection.z);
  const elevation = Math.asin(clamp(sunDirection.y, -1, 1));
  const sunU = uat(0.5 + azimuth / (2 * Math.PI));
  const sunV = clamp(0.5 - elevation / Math.PI, 0, 1);
  const sunPx = sunU * width;
  const sunPy = sunV * height;

  for (let i = 0; i < 26; i++) {
    const u = rnd();
    const v = 0.08 + rnd() * 0.36; // upper band only
    const rx = width * (0.05 + rnd() * 0.11);
    const ry = height * (0.02 + rnd() * 0.05);
    const brightness = noise(u * 18, v * 18);
    const alpha = 0.1 + brightness * 0.26;
    const px = u * width;
    const py = v * height;
    // Cloud blobs thin out near the sun so the disc stays dominant.
    const distToSun = Math.hypot(((px - sunPx + width * 1.5) % width) - width * 0.5, py - sunPy);
    const sunFade = clamp(distToSun / (width * 0.3), 0, 1);
    const blob = (cx: number, cy: number): void => {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, 1);
      const a = alpha * sunFade;
      g.addColorStop(0, `rgba(255,255,255,${a.toFixed(3)})`);
      g.addColorStop(0.55, `rgba(255,253,246,${(a * 0.5).toFixed(3)})`);
      g.addColorStop(1, 'rgba(255,253,246,0)');
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(rx, ry);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, 1, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    };
    // Drawn at u and u+1 so the equirect seam never slices a cloud.
    blob(px, py);
    blob(px + width, py);
  }

  // --- sun haze: a broad warm wash plus a tight disc ------------------------
  const hazeR = Math.max(1, width * 0.3);
  const haze = ctx.createRadialGradient(sunPx, sunPy, 0, sunPx, sunPy, hazeR);
  haze.addColorStop(0, 'rgba(255,244,214,0.85)');
  haze.addColorStop(0.35, 'rgba(255,238,203,0.34)');
  haze.addColorStop(1, 'rgba(255,238,203,0)');
  const hazeBlob = (cx: number): void => {
    ctx.fillStyle = haze;
    ctx.fillRect(cx - hazeR, sunPy - hazeR, hazeR * 2, hazeR * 2);
  };
  hazeBlob(sunPx);
  hazeBlob(sunPx + width);

  const coreR = Math.max(1, width * 0.035);
  const core = ctx.createRadialGradient(sunPx, sunPy, 0, sunPx, sunPy, coreR);
  core.addColorStop(0, 'rgba(255,255,250,1)');
  core.addColorStop(0.45, 'rgba(255,247,222,0.85)');
  core.addColorStop(1, 'rgba(255,240,205,0)');
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(sunPx, sunPy, coreR, 0, Math.PI * 2);
  ctx.fill();

  // --- ground half: dust, so looking down never shows a pool of bright sky ---
  const groundTop = height * 0.5;
  const ground = ctx.createLinearGradient(0, groundTop, 0, height);
  ground.addColorStop(0, 'rgba(180,160,124,0.0)');
  ground.addColorStop(0.4, 'rgba(170,150,116,0.55)');
  ground.addColorStop(1, 'rgba(126,108,82,0.95)');
  ctx.fillStyle = ground;
  ctx.fillRect(0, groundTop, width, height - groundTop);

  return canvas;
}

/**
 * A large inside-out sphere with the procedurally drawn gradient/cloud canvas.
 * `seed` makes the cloud layout reproducible.
 */
export function createSkyDome(radius: number, seed = DEFAULT_SKY_SEED): THREE.Mesh {
  const width = 2048;
  const height = 1024;
  const canvas = drawSkyCanvas(width, height, DEFAULT_SUN_DIRECTION, 1, seed);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = THREE.RepeatWrapping; // azimuth wraps
  tex.wrapT = THREE.ClampToEdgeWrapping; // zenith/nadir do not
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;

  const geo = new THREE.SphereGeometry(Math.max(1, radius), 48, 24);
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false, // the fog must not eat the sky
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'sky-dome';
  mesh.frustumCulled = false; // the camera is always inside it
  mesh.matrixAutoUpdate = false;
  mesh.renderOrder = -1000;
  mesh.updateMatrix();
  return mesh;
}

/** Camera-facing sun glare billboard matching the baked dome sun. */
function createSunGlow(radius: number): THREE.Mesh {
  const canvas = canvasFactory();
  const size = 256;
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('[sky] 2D canvas context unavailable (glow)');
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,252,240,0.9)');
  g.addColorStop(0.25, 'rgba(255,241,205,0.42)');
  g.addColorStop(0.6, 'rgba(255,232,186,0.12)');
  g.addColorStop(1, 'rgba(255,232,186,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.needsUpdate = true;

  const size3d = radius * 0.5;
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    depthTest: false,
    fog: false,
    toneMapped: false,
  });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(size3d, size3d), mat);
  mesh.name = 'sky-sun-glow';
  mesh.frustumCulled = false;
  mesh.renderOrder = -999;
  return mesh;
}

// ---------------------------------------------------------------------------
// Rig
// ---------------------------------------------------------------------------

/**
 * Builds the sky, sun and fill light and adds them to `scene`.
 *
 * Side effects on the scene: `scene.fog` is replaced with the warm dust fog and
 * `scene.background` is left alone (the dome covers everything). `dispose()`
 * detaches exactly what was added; it is idempotent.
 */
export function createSky(scene: THREE.Scene, opts: SkyOptions = {}): SkyRig {
  const turbidity = opts.turbidity ?? 1;
  const sunDirection = (opts.sunDirection ?? DEFAULT_SUN_DIRECTION).clone();
  if (sunDirection.lengthSq() < 1e-9) sunDirection.copy(DEFAULT_SUN_DIRECTION);
  sunDirection.normalize();

  const group = new THREE.Group();
  group.name = 'sky-rig';

  // --- dome --------------------------------------------------------------
  const width = 2048;
  const height = 1024;
  const canvas = drawSkyCanvas(width, height, sunDirection, turbidity);
  const domeTex = new THREE.CanvasTexture(canvas);
  domeTex.colorSpace = THREE.SRGBColorSpace;
  domeTex.wrapS = THREE.RepeatWrapping;
  domeTex.wrapT = THREE.ClampToEdgeWrapping;
  domeTex.magFilter = THREE.LinearFilter;
  domeTex.minFilter = THREE.LinearMipmapLinearFilter;
  domeTex.generateMipmaps = true;
  domeTex.needsUpdate = true;

  const domeGeo = new THREE.SphereGeometry(SKY_DOME_RADIUS, 48, 24);
  const domeMat = new THREE.MeshBasicMaterial({
    map: domeTex,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  const dome = new THREE.Mesh(domeGeo, domeMat);
  dome.name = 'sky-dome';
  dome.frustumCulled = false;
  dome.matrixAutoUpdate = false;
  dome.renderOrder = -1000;
  dome.updateMatrix();
  group.add(dome);

  // --- sun glare ---------------------------------------------------------
  const glow = createSunGlow(SKY_DOME_RADIUS);
  const glowDistance = SKY_DOME_RADIUS * 0.5;
  glow.position.copy(sunDirection).multiplyScalar(glowDistance);
  glow.lookAt(0, 0, 0);
  glow.updateMatrix();
  group.add(glow);

  scene.add(group);

  // --- fog ---------------------------------------------------------------
  const fog = new THREE.Fog(FOG_COLOR, FOG_NEAR, FOG_FAR);
  scene.fog = fog;

  // --- sun ---------------------------------------------------------------
  const sunLight = new THREE.DirectionalLight(SUN_LIGHT_COLOR, SUN_LIGHT_INTENSITY);
  sunLight.name = 'sun';
  sunLight.position.copy(sunDirection).multiplyScalar(4000);
  sunLight.castShadow = true;
  const shadow = sunLight.shadow;
  shadow.mapSize.set(PERF.shadowMapSize, PERF.shadowMapSize);
  shadow.camera.left = -SUN_SHADOW_EXTENT;
  shadow.camera.right = SUN_SHADOW_EXTENT;
  shadow.camera.top = SUN_SHADOW_EXTENT;
  shadow.camera.bottom = -SUN_SHADOW_EXTENT;
  shadow.camera.near = 1;
  shadow.camera.far = SUN_SHADOW_FAR;
  shadow.bias = -0.0008;
  shadow.normalBias = 0.02;
  shadow.camera.updateProjectionMatrix();
  scene.add(sunLight);

  // --- fill --------------------------------------------------------------
  const hemiLight = new THREE.HemisphereLight(HEMI_SKY_COLOR, HEMI_GROUND_COLOR, HEMI_INTENSITY);
  hemiLight.name = 'sky-fill';
  scene.add(hemiLight);

  let disposed = false;
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    group.remove(dome);
    group.remove(glow);
    scene.remove(group);
    scene.remove(sunLight);
    scene.remove(hemiLight);
    domeGeo.dispose();
    domeMat.dispose();
    domeTex.dispose();
    glow.geometry.dispose();
    const glowMat = glow.material as THREE.MeshBasicMaterial;
    if (glowMat.map) glowMat.map.dispose();
    glowMat.dispose();
    if (scene.fog === fog) scene.fog = null;
  }

  return { group, sunLight, hemiLight, fog, dispose };
}
