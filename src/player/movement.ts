// =============================================================================
// player/movement.ts — the CS/Quake movement integrator. THIS IS THE FEEL.
//
// Constants live in core/config.ts (MOVE). Every number below is deliberate:
//   maxSpeed 250, walk 130, duck 85, accelerate 5.5, friction 5.2, airaccel 12,
//   air wishspeed cap 30, gravity 800, jump 301.99.
// Fixed 128 Hz step, so handling is identical on 60/144/240 Hz displays.
// =============================================================================

import { MOVE, PLAYER } from '../core/config';
import {
  addScaled,
  copy,
  normalize,
  set,
  v3,
  yawToForward,
  yawToRight,
} from '../core/math';
import type { InputCommand, Vec3 } from '../core/types';
import {
  createSweepResult,
  type CollisionWorld,
  type SweepResult,
  boxOverlapsWorld,
  sweepBox,
} from '../world/trace';

export interface MoveState {
  /** Feet position. */
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  crouching: boolean;
  /** 0 = standing, 1 = fully ducked. Drives view height + hitbox. */
  duckAmount: number;
  /** Legacy jump-stamina, kept for feel parity with older CS builds. */
  jumpStamina: number;
  /** True while the player is standing on a slope steep enough to slide. */
  onSlope: boolean;
}

export function createMoveState(pos: Vec3): MoveState {
  return {
    pos: copy(v3(), pos),
    vel: v3(),
    onGround: false,
    crouching: false,
    duckAmount: 0,
    jumpStamina: 1,
    onSlope: false,
  };
}

export interface MoveResult {
  /** Distance travelled horizontally this tick (for footstep cadence). */
  horizontalSpeed: number;
  /** Vertical speed at the moment of landing (pre-clamp), 0 when airborne. */
  landingSpeed: number;
  jumped: boolean;
  /** Set on the tick ground contact was (re)established. */
  landed: boolean;
  /** Set when the player left the ground this tick. */
  tookOff: boolean;
  /** Highest material the feet touched this tick. */
  groundMaterial: string;
}

const tmpWish = v3();
const tmpForward = v3();
const tmpRight = v3();
const tmpMove = v3();
const tmpStep = v3();
const tmpEnd = v3();
const tmpUp = v3();
const tmpCenter = v3();
const sweepA = createSweepResult();
const sweepB = createSweepResult();
const sweepUp = createSweepResult();
const sweepFwd = createSweepResult();
const sweepDown = createSweepResult();

/**
 * Push-off applied when a sweep starts already flush with a surface.
 *
 * A sweep that begins exactly touching a face reports the same zero-fraction
 * contact on every iteration, so the projected slide never lands and the player
 * sticks to the wall. Nudging a hair off the surface lets the slide actually
 * move (it is re-absorbed by the ground snap on floor contacts).
 */
const SURFACE_EPS = 0.02;

/**
 * Contact normals collected during a slide. Preallocated because stepMovement
 * runs 10 actors x 128 ticks per second: any allocation here is pure GC churn.
 * NOT reentrant, which is fine because the simulation is single-threaded.
 */
const contactNormals: Vec3[] = [];
for (let i = 0; i < 6; i++) contactNormals.push(v3());

const GROUND_EPS = 0.7;

/**
 * How far above the feet the top face of a "landed on" brush may be before the
 * ground snap refuses to move the player onto it. A real support face is at the
 * feet (the box rests on it, within a hair of sub-stepping), so anything higher
 * is a brush the sweep started inside of - a ceiling, a lintel, a stair
 * underside - and snapping to it would teleport the player onto its roof.
 */
const GROUND_SNAP_MAX_RISE = 1.0;

/** Half extents of the player box given the current duck amount. */
export function playerExtents(duckAmount: number, out: { ex: number; ey: number; ez: number }): void {
  const h = PLAYER.standHeight + (PLAYER.crouchHeight - PLAYER.standHeight) * duckAmount;
  out.ex = PLAYER.radius;
  out.ey = h * 0.5;
  out.ez = PLAYER.radius;
}

export function playerHeight(duckAmount: number): number {
  return PLAYER.standHeight + (PLAYER.crouchHeight - PLAYER.standHeight) * duckAmount;
}

export function playerEyeHeight(duckAmount: number): number {
  return PLAYER.standEye + (PLAYER.crouchEye - PLAYER.standEye) * duckAmount;
}

const extents = { ex: PLAYER.radius, ey: PLAYER.standHeight * 0.5, ez: PLAYER.radius };

/** The player box centre is the feet position plus the half height. */
function centerOf(feet: Vec3, ey: number, out: Vec3): Vec3 {
  return set(out, feet.x, feet.y + ey, feet.z);
}

function friction(state: MoveState, dt: number): void {
  const speed = Math.hypot(state.vel.x, state.vel.z);
  if (speed < 0.1) {
    state.vel.x = 0;
    state.vel.z = 0;
    return;
  }
  const control = speed < MOVE.stopSpeed ? MOVE.stopSpeed : speed;
  let drop = control * MOVE.friction * dt;
  let newSpeed = speed - drop;
  if (newSpeed < 0) newSpeed = 0;
  if (newSpeed !== speed) {
    newSpeed /= speed;
    state.vel.x *= newSpeed;
    state.vel.z *= newSpeed;
  }
}

function accelerate(state: MoveState, wishDir: Vec3, wishSpeed: number, accel: number, dt: number): void {
  const current = state.vel.x * wishDir.x + state.vel.z * wishDir.z;
  const addSpeed = wishSpeed - current;
  if (addSpeed <= 0) return;
  let accelSpeed = accel * wishSpeed * dt;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;
  state.vel.x += wishDir.x * accelSpeed;
  state.vel.z += wishDir.z * accelSpeed;
}

/** Air acceleration: wishspeed is capped (the classic "30 unit" rule). */
function airAccelerate(state: MoveState, wishDir: Vec3, wishSpeed: number, dt: number): void {
  const capped = Math.min(wishSpeed, MOVE.airWishSpeedCap);
  const current = state.vel.x * wishDir.x + state.vel.z * wishDir.z;
  const addSpeed = capped - current;
  if (addSpeed <= 0) return;
  let accelSpeed = MOVE.airAccelerate * capped * dt;
  if (accelSpeed > addSpeed) accelSpeed = addSpeed;
  state.vel.x += wishDir.x * accelSpeed;
  state.vel.z += wishDir.z * accelSpeed;
}

/**
 * Move the player box from `state.pos` by `delta`, sliding along surfaces.
 * Mutates state.pos and reports every contact normal in `outNormals`.
 * Returns the number of contacts.
 */
function slideMove(
  world: CollisionWorld,
  state: MoveState,
  delta: Vec3,
  outNormals: Vec3[],
): number {
  let contacts = 0;
  playerExtents(state.duckAmount, extents);
  const center = tmpCenter;

  for (let iter = 0; iter < 4; iter++) {
    if (Math.abs(delta.x) < 1e-4 && Math.abs(delta.y) < 1e-4 && Math.abs(delta.z) < 1e-4) break;

    centerOf(state.pos, extents.ey, center);
    tmpEnd.x = center.x + delta.x;
    tmpEnd.y = center.y + delta.y;
    tmpEnd.z = center.z + delta.z;
    sweepBox(world, center, tmpEnd, extents.ex, extents.ey, extents.ez, sweepA);

    if (!sweepA.hit) {
      state.pos.x += delta.x;
      state.pos.y += delta.y;
      state.pos.z += delta.z;
      break;
    }

    // Advance to just before the contact.
    const t = Math.max(0, sweepA.fraction - 1e-4);
    state.pos.x += delta.x * t;
    state.pos.y += delta.y * t;
    state.pos.z += delta.z * t;
    outNormals[contacts] = copy(outNormals[contacts] ?? v3(), sweepA.normal);
    contacts++;

    const remaining: Vec3 = {
      x: delta.x * (1 - t),
      y: delta.y * (1 - t),
      z: delta.z * (1 - t),
    };
    const n = sweepA.normal;

    if (n.y < -0.7) {
      // Pure floor: everything below is consumed by the ground.
      if (remaining.y < 0) remaining.y = 0;
    }
    if (n.y > 0.7) {
      // Ceiling: kill the upward remainder.
      if (remaining.y > 0) remaining.y = 0;
    }

    // Project the remainder onto the plane so we slide instead of stopping.
    const d = remaining.x * n.x + remaining.y * n.y + remaining.z * n.z;
    if (d < 0) {
      delta.x = remaining.x - n.x * d;
      delta.y = remaining.y - n.y * d;
      delta.z = remaining.z - n.z * d;
    } else {
      delta.x = remaining.x;
      delta.y = remaining.y;
      delta.z = remaining.z;
    }

    // If only the vertical part was clipped we are done; avoids jitter on stairs.
    if (Math.abs(delta.x) < 1e-4 && Math.abs(delta.z) < 1e-4 && contacts > 0) {
      if (n.y < -0.7) break;
    }
  }
  return contacts;
}

/** Cast downward to find the ground under the player's centre. */
function groundCheck(world: CollisionWorld, state: MoveState, distance: number): SweepResult {
  playerExtents(state.duckAmount, extents);
  const center = tmpCenter;
  centerOf(state.pos, extents.ey, center);
  const end = tmpEnd;
  end.x = center.x;
  end.y = center.y - distance;
  end.z = center.z;
  const res = sweepB;
  sweepBox(world, center, end, extents.ex, extents.ey - 0.01, extents.ez, res);
  return res;
}

export interface MoveConfigOverride {
  maxSpeed?: number;
  autoHop?: boolean;
}

/**
 * One fixed-rate movement step. `wishSpeedMul` comes from the equipped weapon.
 */
export function stepMovement(
  world: CollisionWorld,
  state: MoveState,
  cmd: InputCommand,
  dt: number,
  wishSpeedMul = 1,
  overrides: MoveConfigOverride = {},
): MoveResult {
  const result: MoveResult = {
    horizontalSpeed: 0,
    landingSpeed: 0,
    jumped: false,
    landed: false,
    tookOff: false,
    groundMaterial: 'sand',
  };

  const maxSpeed = (overrides.maxSpeed ?? MOVE.maxSpeed) * wishSpeedMul;

  // --- crouch state -------------------------------------------------------
  const wantCrouch = cmd.buttons.crouch;
  const prevDuck = state.duckAmount;
  if (wantCrouch) {
    state.duckAmount = Math.min(1, state.duckAmount + (MOVE.duckSpeed / PLAYER.standHeight) * dt);
  } else {
    // Only stand up when there is headroom.
    const target = Math.max(0, state.duckAmount - (MOVE.duckSpeed / PLAYER.standHeight) * dt);
    if (target < state.duckAmount) {
      const needed = playerHeight(target);
      const ex = PLAYER.radius;
      const centerY = state.pos.y + needed * 0.5;
      const blocked = boxOverlapsWorld(
        world,
        v3(state.pos.x, centerY, state.pos.z),
        ex - 0.5,
        needed * 0.5 - 0.5,
        ex - 0.5,
      );
      if (!blocked) state.duckAmount = target;
    }
  }
  state.crouching = state.duckAmount > 0.5;

  // --- friction / acceleration -------------------------------------------
  const wasGround = state.onGround;
  const jumpPressed = cmd.buttons.jump;
  const willJump = wasGround && jumpPressed && state.jumpStamina > 0.02;

  if (wasGround) {
    // Friction is applied once per hop - on the single tick the player is
    // grounded - exactly as it is when running. That balance is what makes CS
    // bunny hopping *preserve* speed rather than gain it: at 250 u/s the per-tick
    // drop here (250 * 5.2 * dt = 10.2) is almost exactly what the ground
    // acceleration hands back on the next tick (5.5 * 250 * dt = 10.7), and
    // `accelerate` clamps at maxSpeed, so a hopping player just sits at 250.
    // We deliberately do NOT zero friction: that produces the runaway 400+ u/s
    // speeds of surf maps. An extra per-landing multiplier bleeds ~15 u/s per hop
    // instead, which measurably decays a hopping player to walking speed (52 u/s
    // after three seconds of jump+forward), so `hopFriction` is 1.
    const hop = (overrides.autoHop ?? MOVE.autoHop) && jumpPressed;
    friction(state, dt * (hop ? MOVE.hopFriction : 1));
  }

  // Wish direction in world space.
  yawToForward(tmpForward, cmd.yaw);
  yawToRight(tmpRight, cmd.yaw);
  let fwd = 0;
  let side = 0;
  if (cmd.buttons.forward) fwd += 1;
  if (cmd.buttons.back) fwd -= 1;
  if (cmd.buttons.right) side += 1;
  if (cmd.buttons.left) side -= 1;

  set(tmpWish, 0, 0, 0);
  if (fwd !== 0) addScaled(tmpWish, tmpWish, tmpForward, fwd);
  if (side !== 0) addScaled(tmpWish, tmpWish, tmpRight, side);

  let wishSpeed = maxSpeed;
  if (fwd < 0) wishSpeed *= MOVE.backSpeedMul;
  if (side !== 0 && fwd === 0) wishSpeed *= MOVE.sideSpeedMul;

  if (cmd.buttons.walk) wishSpeed = Math.min(wishSpeed, MOVE.walkSpeed * wishSpeedMul);
  if (wantCrouch) wishSpeed = Math.min(wishSpeed, MOVE.crouchSpeed * wishSpeedMul);

  normalize(tmpWish, tmpWish);

  if (wasGround) {
    accelerate(state, tmpWish, wishSpeed, MOVE.accelerate, dt);
  } else {
    airAccelerate(state, tmpWish, wishSpeed, dt);
  }

  // --- jump ---------------------------------------------------------------
  if (willJump) {
    state.vel.y = MOVE.jumpImpulse;
    state.onGround = false;
    state.jumpStamina = Math.max(0, state.jumpStamina - 0.28);
    result.jumped = true;
    result.tookOff = true;
  }

  // --- gravity ------------------------------------------------------------
  if (!state.onGround) {
    state.vel.y -= MOVE.gravity * dt;
    if (state.vel.y < -MOVE.maxFallSpeed) state.vel.y = -MOVE.maxFallSpeed;
  }

  // --- integrate ----------------------------------------------------------
  playerExtents(state.duckAmount, extents);
  set(tmpMove, state.vel.x * dt, state.vel.y * dt, state.vel.z * dt);
  const normals = contactNormals;
  const contacts = slideMove(world, state, tmpMove, normals);

  // --- step up (automatic 18-unit stairs, CS style) ----------------------
  // The probe must use the WISH delta, not the post-collision one. Once a player is
  // pressed against a step face, `slideMove` has already cancelled the velocity into
  // it, so the measured delta is ~0 (2 u/s in practice) and the up-then-forward probe
  // never carries the box far enough over the tread to find its top face: the player
  // grinds on the edge forever instead of climbing. Measured: three bots pinned on the
  // catwalk mouth at X 204 for a whole round, so the catwalk route was unusable for
  // them (and for the human, who shares this code). The wish delta advances ~2 units
  // per tick, enough to overlap a tread and let the downward sweep land on its top.
  if (state.onGround || wasGround) {
    set(tmpStep, tmpWish.x * wishSpeed * dt, tmpMove.y, tmpWish.z * wishSpeed * dt);
    tryStepUp(world, state, tmpStep);
  }

  // --- ground resolution --------------------------------------------------
  const ground = groundCheck(world, state, state.onGround ? GROUND_EPS + 2 : 2);
  const hitGround = ground.hit && ground.normal.y > 0.7;
  if (hitGround && state.vel.y <= 0.001) {
    if (!state.onGround) {
      result.landed = true;
      result.landingSpeed = -state.vel.y;
    }
    state.onGround = true;
    // Snap the feet onto the top face of the brush we landed on. The sweep
    // contact point lies on the expanded (Minkowski) box, so the true support
    // height is the brush's own top face - but only when that face really is at
    // our feet. When the expanded box already overlaps a brush at the start of
    // the sweep (a ceiling we just grew into while standing up, a door lintel, a
    // stair underside) `sweepExpanded` reports `hit, fraction 0, normal (0,1,0)`,
    // and snapping to *that* brush's top face teleports the player onto its roof:
    // measured, standing up under a 58-unit ceiling moved the feet from y=0 to
    // y=400. `onGround` stays true in that case - the player is genuinely
    // supported, just also under something.
    const landedBrush = world.brushAabbs[ground.brushId];
    if (landedBrush && landedBrush.max.y <= state.pos.y + GROUND_SNAP_MAX_RISE) {
      state.pos.y = landedBrush.max.y + 0.0001;
    }
    if (state.vel.y < 0) state.vel.y = 0;
    result.groundMaterial = ground.material;
    state.jumpStamina = Math.min(1, state.jumpStamina + 0.4 * dt * 4);
  } else {
    if (state.onGround && !willJump) {
      // Walked off a ledge.
      result.tookOff = true;
    }
    state.onGround = false;
  }

  // Resolve remaining wall contacts by removing the velocity into the wall.
  for (let i = 0; i < contacts; i++) {
    const n = normals[i];
    const d = state.vel.x * n.x + state.vel.y * n.y + state.vel.z * n.z;
    if (d < 0) {
      state.vel.x -= n.x * d;
      state.vel.y -= n.y * d;
      state.vel.z -= n.z * d;
    }
  }

  // --- safety clamp -------------------------------------------------------
  const hs = Math.hypot(state.vel.x, state.vel.z);
  if (hs > MOVE.hardSpeedCap) {
    const s = MOVE.hardSpeedCap / hs;
    state.vel.x *= s;
    state.vel.z *= s;
  }
  result.horizontalSpeed = Math.hypot(state.vel.x, state.vel.z);
  if (prevDuck < 0.5 && state.duckAmount >= 0.5) {
    // Crouched this tick; nothing extra to do, view height is driven by duckAmount.
  }
  return result;
}

/**
 * If the player is blocked horizontally but there is standable ground within
 * stepHeight above the obstruction, lift them up and forward (stairs / kerbs).
 */
function tryStepUp(world: CollisionWorld, state: MoveState, moveDelta: Vec3): boolean {
  const horiz = Math.hypot(moveDelta.x, moveDelta.z);
  if (horiz < 0.01) return false;

  playerExtents(state.duckAmount, extents);
  const center = tmpCenter;
  centerOf(state.pos, extents.ey, center);

  // 1. Up by stepHeight.
  tmpUp.x = center.x;
  tmpUp.y = center.y + PLAYER.stepHeight;
  tmpUp.z = center.z;
  const upRes = sweepUp;
  sweepBox(world, center, tmpUp, extents.ex, extents.ey, extents.ez, upRes);
  if (upRes.hit) return false; // not enough headroom to step

  // 2. Forward at the raised height.
  const raisedX = center.x;
  const raisedY = center.y + PLAYER.stepHeight;
  const raisedZ = center.z;
  const fwd = tmpEnd;
  fwd.x = raisedX + moveDelta.x;
  fwd.y = raisedY;
  fwd.z = raisedZ + moveDelta.z;
  const fwdRes = sweepFwd;
  sweepBox(world, tmpUp, fwd, extents.ex, extents.ey, extents.ez, fwdRes);
  if (fwdRes.hit && fwdRes.fraction < 0.5) return false;

  const landedX = raisedX + moveDelta.x * fwdRes.fraction * 0.98;
  const landedZ = raisedZ + moveDelta.z * fwdRes.fraction * 0.98;

  // 3. Down onto the step.
  const from = tmpUp;
  const to = tmpForward;
  from.x = landedX;
  from.y = raisedY;
  from.z = landedZ;
  to.x = landedX;
  to.y = raisedY - PLAYER.stepHeight - 4;
  to.z = landedZ;
  const downRes = sweepDown;
  sweepBox(world, from, to, extents.ex, extents.ey - 0.01, extents.ez, downRes);
  if (!downRes.hit || downRes.normal.y <= 0.7) return false;
  if (downRes.fraction >= 0.999) return false;
  if (downRes.material === 'glass') return false;

  // Only step up when the destination is actually a new, higher floor.
  const newFeetY = state.pos.y + PLAYER.stepHeight - (PLAYER.stepHeight + 4) * downRes.fraction;
  if (newFeetY <= state.pos.y + 0.6) return false;
  if (newFeetY > state.pos.y + PLAYER.stepHeight + 0.6) return false;

  state.pos.x = landedX;
  state.pos.z = landedZ;
  state.pos.y = newFeetY;
  state.onGround = true;
  if (state.vel.y < 0) state.vel.y = 0;
  return true;
}

/** Check whether the player's feet are inside a solid (used after teleports). */
export function unstuck(world: CollisionWorld, state: MoveState): boolean {
  playerExtents(state.duckAmount, extents);
  for (let i = 0; i < 24; i++) {
    const center = tmpCenter;
    centerOf(state.pos, extents.ey, center);
    if (!boxOverlapsWorld(world, center, extents.ex, extents.ey, extents.ez)) return true;
    state.pos.y += 4;
  }
  return false;
}

/** Speed at which a player can be pushed away from walls; used for actor push. */
export function pushAway(state: MoveState, normal: Vec3, amount: number): void {
  state.pos.x += normal.x * amount;
  state.pos.y += normal.y * amount;
  state.pos.z += normal.z * amount;
}
