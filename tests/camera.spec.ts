// =============================================================================
// tests/camera.spec.ts — view bob and the melee swing.
//
// Two user-visible bugs live here:
//   * the weapon bob ran at ~14 Hz because `CAMERA.bobFreq` was treated as an
//     angular frequency while the accumulator counted cycles — walking looked
//     like a permanent shake rather than footsteps;
//   * a knife swing had no view feedback at all (flat recoil pattern, and the
//     knife never reaches the muzzle-flash branch), so hitting with it felt dead.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { CAMERA, MOVE } from '../src/core/config';
import { CameraRig } from '../src/player/cameraRig';

const FEET = { x: 0, y: 0, z: 0 };
const STILL = { x: 0, y: 0, z: 0 };
/** Full run speed: `speedNorm` 1, i.e. full bob. */
const SPRINT = { x: MOVE.maxSpeed, y: 0, z: 0 };

const FRAME = 1 / 128;

function run(
  rig: CameraRig,
  frames: number,
  vel: { x: number; y: number; z: number },
): number[] {
  const out: number[] = [];
  for (let i = 0; i < frames; i++) {
    rig.update(0, 0, FEET, 0, vel, true, FRAME, 0, 0);
    out.push(rig.viewPose.bobY);
  }
  return out;
}

/** Zero crossings in a sample series: half the number of bob cycles. */
function crossings(samples: number[]): number {
  let n = 0;
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] ?? 0;
    const b = samples[i] ?? 0;
    if (a !== 0 && b !== 0 && Math.sign(a) !== Math.sign(b)) n++;
  }
  return n;
}

describe('view bob', () => {
  it('bobs at a step rate, not at an angular frequency', () => {
    const rig = new CameraRig(16 / 9);
    const ys = run(rig, 256, SPRINT); // 2 s at 128 Hz
    // Full-speed step rate is `bobFreq * (0.55 + 1)` = 2.95 Hz, so two seconds
    // hold ~6 up/down cycles (~12 crossings). The old code — bobFreq 9.2 fed
    // straight into a phase that was then multiplied by 2*PI — reached ~14 Hz
    // and ~57 crossings.
    const expected = 2 * 2 * CAMERA.bobFreq * 1.55;
    const n = crossings(ys);
    expect(n).toBeGreaterThan(expected * 0.6);
    expect(n).toBeLessThan(expected * 1.4);
    // ...and it is a real bob, not a frozen one: the full-speed amplitude is
    // CAMERA.bobAmount (0.62 u).
    expect(Math.max(...ys.map(Math.abs))).toBeGreaterThan(0.4);
  });

  it('ramps the bob amplitude in and out instead of popping', () => {
    const rig = new CameraRig(16 / 9);
    expect(rig.bobAmountSmooth).toBe(0);

    rig.update(0, 0, FEET, 0, SPRINT, true, FRAME, 0, 0);
    const firstFrame = rig.bobAmountSmooth;
    expect(firstFrame).toBeGreaterThan(0);
    // One 128 Hz frame is nowhere near full amplitude.
    expect(firstFrame).toBeLessThan(CAMERA.bobAmount * 0.3);

    run(rig, 128, SPRINT);
    expect(rig.bobAmountSmooth).toBeCloseTo(CAMERA.bobAmount, 2);

    // Stopping decays the bob rather than cutting it off mid-step.
    run(rig, 16, STILL);
    expect(rig.bobAmountSmooth).toBeLessThan(CAMERA.bobAmount * 0.5);
  });
});

describe('melee swing', () => {
  it('rolls the camera through the swing and back to level', () => {
    const rig = new CameraRig(16 / 9);
    rig.update(0, 0, FEET, 0, STILL, true, FRAME, 0, 0);
    expect(rig.viewPose.swing).toBe(0);
    expect(rig.camera.rotation.z).toBe(0);

    rig.startSwing();
    rig.update(0, 0, FEET, 0, STILL, true, FRAME, 0, 0);
    expect(rig.viewPose.swing).toBeGreaterThan(0.9);

    // Half way through, the roll peaks: that is the whole feedback of a swing.
    const half = Math.ceil((CAMERA.meleeSwingTime / 2) * 128);
    for (let i = 0; i < half; i++) rig.update(0, 0, FEET, 0, STILL, true, FRAME, 0, 0);
    expect(Math.abs(rig.camera.rotation.z)).toBeGreaterThan(0.01);
    expect(Math.abs(rig.camera.rotation.z)).toBeLessThanOrEqual(CAMERA.meleeSwingRoll);

    for (let i = 0; i < 128; i++) rig.update(0, 0, FEET, 0, STILL, true, FRAME, 0, 0);
    expect(rig.viewPose.swing).toBe(0);
    expect(rig.camera.rotation.z).toBe(0);
  });
});