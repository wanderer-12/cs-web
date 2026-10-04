// =============================================================================
// vfx/ShaderPatches.ts — the few GLSL injections the VFX layer needs.
//
// Everything repeating is an InstancedMesh or a Points cloud sharing ONE
// material. three's stock shaders cannot express per-instance alpha or
// per-instance atlas tiles, so we splice two lines into the built-in chunks
// instead of multiplying materials (a material per decal would explode the
// program cache and the memory budget on a firing range).
//
// The chunks are three r186's; a missing chunk degrades to "no per-instance
// value" rather than to a shader compile error.
// =============================================================================

import type { Material } from 'three';

/** The slice of three's program parameters a patch is allowed to touch. */
export interface ShaderLike {
  vertexShader: string;
  fragmentShader: string;
}

export type ShaderPatch = (shader: ShaderLike) => void;

/** Queue patches on a material (one assignment: onBeforeCompile is a single slot). */
export function applyPatches(material: Material, ...patches: ShaderPatch[]): void {
  material.onBeforeCompile = (shader) => {
    for (const patch of patches) patch(shader);
  };
}

/** Append `code` right after `#include <chunk>`, when that chunk is present. */
function afterChunk(src: string, chunk: string, code: string): string {
  const needle = `#include <${chunk}>`;
  if (!src.includes(needle)) return src;
  return src.replace(needle, `${needle}\n${code}`);
}

/** Declare `code` at the top of a stage (after three's own #define prefix). */
function declare(src: string, code: string): string {
  return `${code}\n${src}`;
}

/**
 * Per-instance decal atlas selection: `aUvRect = (u0, v0, du, dv)` remaps the
 * plane's 0..1 UVs into its atlas tile.
 */
export function instancedUvPatch(attribute = 'aUvRect'): ShaderPatch {
  return (shader) => {
    shader.vertexShader = declare(shader.vertexShader, `attribute vec4 ${attribute};`);
    shader.vertexShader = afterChunk(
      shader.vertexShader,
      'uv_vertex',
      `\tvMapUv = ${attribute}.xy + vMapUv * ${attribute}.zw;`,
    );
  };
}

/**
 * Per-instance opacity: decals fade out and smoke puffs dissipate, and neither
 * is expressible through instanceColor (which multiplies RGB only).
 */
export function instancedAlphaPatch(attribute = 'aAlpha'): ShaderPatch {
  return (shader) => {
    shader.vertexShader = declare(
      shader.vertexShader,
      `attribute float ${attribute};\nvarying float vInstAlpha;`,
    );
    shader.vertexShader = afterChunk(shader.vertexShader, 'begin_vertex', `\tvInstAlpha = ${attribute};`);
    shader.fragmentShader = declare(shader.fragmentShader, 'varying float vInstAlpha;');
    shader.fragmentShader = afterChunk(
      shader.fragmentShader,
      'map_fragment',
      '\tdiffuseColor.a *= vInstAlpha;',
    );
  };
}

/**
 * Per-particle world-space size for THREE.Points. `material.size` stays the
 * uniform base (three already multiplies it by the pixel ratio); `aSize` is the
 * particle's own radius in world units, which is what makes sparks tiny and
 * dust puffs large from the same Points cloud.
 */
export function pointSizePatch(attribute = 'aSize'): ShaderPatch {
  return (shader) => {
    shader.vertexShader = declare(shader.vertexShader, `attribute float ${attribute};`);
    if (shader.vertexShader.includes('gl_PointSize = size;')) {
      shader.vertexShader = shader.vertexShader.replace(
        'gl_PointSize = size;',
        `gl_PointSize = size * ${attribute};`,
      );
    }
  };
}
