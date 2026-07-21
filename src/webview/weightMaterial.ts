import * as THREE from 'three';

/**
 * Skin-weight visualization modes. Mirrors the sub-modes offered by DCC tools
 * (Blender Weight Paint, Maya Paint Skin Weights):
 *  - 'off'       — feature disabled
 *  - 'isolate'   — color the mesh by one bone's per-vertex weight (cold→hot ramp)
 *  - 'all'       — per-bone palette colors blended by weight (rogue-weight hunting)
 *  - 'count'     — discrete bands by number of influences per vertex (1–4)
 *  - 'normalize' — flag vertices whose weights sum ≠ 1.0
 */
export type WeightMode = 'off' | 'isolate' | 'all' | 'count' | 'normalize';

/** Numeric codes handed to the shader's `uWeightMode` uniform. */
const MODE_CODE: Record<Exclude<WeightMode, 'off'>, number> = {
  isolate: 1,
  all: 2,
  count: 3,
  normalize: 4,
};

export interface WeightMaterialEntry {
  material: THREE.MeshBasicMaterial;
  /** Live uniform refs — mutate `.value` to update the display without a recompile. */
  uniforms: {
    uWeightMode: THREE.IUniform<number>;
    uSelectedBone: THREE.IUniform<number>;
    uNormTol: THREE.IUniform<number>;
  };
}

// Shared GLSL helpers injected before main(): a blue→cyan→green→yellow→red ramp
// (hue shift makes near-zero weights pop, unlike grayscale), an HSV→RGB helper,
// and a per-bone palette that spaces hues by the golden ratio for maximum
// contrast between adjacent bone indices.
const GLSL_HELPERS = /* glsl */ `
uniform int uWeightMode;
uniform float uSelectedBone;
uniform float uNormTol;
varying vec3 vWeightColor;

vec3 wv_hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

vec3 wv_ramp(float w) {
  w = clamp(w, 0.0, 1.0);
  if (w < 0.25) return mix(vec3(0.0, 0.0, 1.0), vec3(0.0, 1.0, 1.0), w / 0.25);
  if (w < 0.5)  return mix(vec3(0.0, 1.0, 1.0), vec3(0.0, 1.0, 0.0), (w - 0.25) / 0.25);
  if (w < 0.75) return mix(vec3(0.0, 1.0, 0.0), vec3(1.0, 1.0, 0.0), (w - 0.5) / 0.25);
  return mix(vec3(1.0, 1.0, 0.0), vec3(1.0, 0.0, 0.0), (w - 0.75) / 0.25);
}

vec3 wv_boneColor(float idx) {
  float h = fract(idx * 0.6180339887);
  return wv_hsv2rgb(vec3(h, 0.75, 1.0));
}
`;

// Per-vertex color computation. Injected right after <skinning_vertex> so
// skinIndex/skinWeight (declared by three under USE_SKINNING) are in scope.
// Note: skinWeight/skinIndex are vec4 — three caps influences at 4 per vertex,
// so 'count' tops out at 4 and vertices originally bound to >4 bones cannot be
// distinguished here (the extra influences were dropped at load time).
const GLSL_COMPUTE = /* glsl */ `
#ifdef USE_SKINNING
  if (uWeightMode == 1) { // isolate one bone
    float w = 0.0;
    w += (abs(skinIndex.x - uSelectedBone) < 0.5) ? skinWeight.x : 0.0;
    w += (abs(skinIndex.y - uSelectedBone) < 0.5) ? skinWeight.y : 0.0;
    w += (abs(skinIndex.z - uSelectedBone) < 0.5) ? skinWeight.z : 0.0;
    w += (abs(skinIndex.w - uSelectedBone) < 0.5) ? skinWeight.w : 0.0;
    vWeightColor = wv_ramp(w);
  } else if (uWeightMode == 2) { // all bones, palette-blended
    vec3 c = vec3(0.0);
    c += wv_boneColor(skinIndex.x) * skinWeight.x;
    c += wv_boneColor(skinIndex.y) * skinWeight.y;
    c += wv_boneColor(skinIndex.z) * skinWeight.z;
    c += wv_boneColor(skinIndex.w) * skinWeight.w;
    vWeightColor = c;
  } else if (uWeightMode == 3) { // influence count (discrete bands)
    int n = 0;
    if (skinWeight.x > 1e-4) n++;
    if (skinWeight.y > 1e-4) n++;
    if (skinWeight.z > 1e-4) n++;
    if (skinWeight.w > 1e-4) n++;
    if (n <= 1)      vWeightColor = vec3(0.1, 0.2, 1.0); // rigid
    else if (n == 2) vWeightColor = vec3(0.0, 1.0, 1.0);
    else if (n == 3) vWeightColor = vec3(0.0, 1.0, 0.0);
    else             vWeightColor = vec3(1.0, 1.0, 0.0); // 4 = max
  } else if (uWeightMode == 4) { // normalization error
    float s = dot(skinWeight, vec4(1.0));
    if (s > 1.0 + uNormTol)      vWeightColor = vec3(1.0, 0.0, 1.0); // over  → magenta
    else if (s < 1.0 - uNormTol) vWeightColor = vec3(0.0, 1.0, 1.0); // under → cyan
    else                         vWeightColor = vec3(0.15);          // ok    → dark grey
  } else {
    vWeightColor = vec3(0.8);
  }
#else
  vWeightColor = vec3(0.8);
#endif
`;

/**
 * Build an unlit debug material that colors a SkinnedMesh by its skin weights.
 *
 * Implemented as a MeshBasicMaterial + onBeforeCompile rather than a raw
 * ShaderMaterial: on three@0.184 skinning is injected automatically for any
 * built-in material rendered on a SkinnedMesh, so the weight colors deform with
 * the animation for free. We route the computed color into `diffuseColor` (via
 * the <color_fragment> hook) so it flows through the identical color-management
 * path as the rest of the pipeline.
 */
export function createWeightMaterial(): WeightMaterialEntry {
  const uniforms = {
    uWeightMode: { value: 0 },
    uSelectedBone: { value: 0 },
    uNormTol: { value: 0.01 },
  };

  const material = new THREE.MeshBasicMaterial({ toneMapped: false });

  material.onBeforeCompile = (shader) => {
    // Share our uniform objects so mutating uniforms.*.value updates the program
    // immediately, without waiting for (or forcing) a recompile.
    shader.uniforms.uWeightMode = uniforms.uWeightMode;
    shader.uniforms.uSelectedBone = uniforms.uSelectedBone;
    shader.uniforms.uNormTol = uniforms.uNormTol;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${GLSL_HELPERS}`)
      .replace('#include <skinning_vertex>', `#include <skinning_vertex>\n${GLSL_COMPUTE}`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWeightColor;')
      .replace(
        '#include <color_fragment>',
        '#include <color_fragment>\n\tdiffuseColor = vec4( vWeightColor, opacity );',
      );
  };

  return { material, uniforms };
}

/** Push a WeightMode + bone index into an existing material entry's uniforms. */
export function applyWeightUniforms(entry: WeightMaterialEntry, mode: WeightMode, boneIndex: number): void {
  entry.uniforms.uWeightMode.value = mode === 'off' ? 0 : MODE_CODE[mode];
  entry.uniforms.uSelectedBone.value = boneIndex;
}
