// =============================================================================
// tests/scope.spec.ts — the sniper scope.
//
// The user asked for a working sniper scope. Nothing wrote `WeaponState.scoped`
// before this change, so nothing could draw the scope, hide the crosshair or
// hide the view model. These guards pin the whole chain: right-click steps up
// the weapon's zoom levels and wraps back to the bare eye, the scope only counts
// as settled once the zoom transition finished, and a scoped shot drops out.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import { CAMERA, TICK_DT } from '../src/core/config';
import { EMPTY_BUTTONS, type InputCommand } from '../src/core/types';

function cmd(tick: number, buttons: Partial<InputCommand['buttons']> = {}): InputCommand {
  return { tick, buttons: { ...EMPTY_BUTTONS, ...buttons }, yaw: 0, pitch: 0, mouseDX: 0, mouseDY: 0 };
}

function scopeMatch(weaponId: string): Match {
  const map = buildDust2Lite();
  const match = new Match({
    world: new World(map),
    bus: new EventBus(),
    map,
    rng: new Rng(0x5c09),
    skipWarmup: true,
  });
  match.local.giveWeapon(weaponId, true);
  return match;
}

function weaponState(match: Match, weaponId: string) {
  const st = match.local.ammo.get(weaponId);
  if (!st) throw new Error(`no weapon state for ${weaponId}`);
  return st;
}

/** Play `seconds` of game time with `buttons` held. Returns the next tick. */
function play(match: Match, tick0: number, seconds: number, buttons: Partial<InputCommand['buttons']>): number {
  const ticks = Math.max(1, Math.round(seconds / TICK_DT));
  for (let i = 0; i < ticks; i += 1) match.tick(cmd(tick0 + i, buttons), TICK_DT);
  return tick0 + ticks;
}

describe('sniper scope', () => {
  it('steps up the zoom levels on each press and wraps back to the bare eye', () => {
    const match = scopeMatch('awp');
    const st = weaponState(match, 'awp');
    const rig = match.local.rig;
    let tick = 0;

    expect(st.scoped).toBe(false);
    expect(rig.viewFov).toBe(CAMERA.fov);

    // Press and hold: exactly one step, and the scope settles once the zoom
    // transition (0.35 s) is over.
    tick = play(match, tick, 1, { attack2: true });
    expect(st.scoped).toBe(true);
    expect(st.zoomLevel).toBe(1);
    expect(rig.viewFov).toBe(40);

    // Releasing the button does NOT drop the scope: tap, tap, hip.
    tick = play(match, tick, 0.3, {});
    expect(st.scoped).toBe(true);
    expect(st.zoomLevel).toBe(1);

    // A second press steps to the tight level of the same scope.
    tick = play(match, tick, 1, { attack2: true });
    expect(st.zoomLevel).toBe(2);
    expect(rig.viewFov).toBe(15);

    // ...but only on a fresh press: the button has to come up in between.
    tick = play(match, tick, 2, { attack2: true });
    expect(st.zoomLevel).toBe(2);

    // A third press wraps past the last level back to the naked eye.
    tick = play(match, tick, 0.2, {});
    tick = play(match, tick, 1, { attack2: true });
    expect(st.zoomLevel).toBe(0);
    expect(st.scoped).toBe(false);
    expect(rig.viewFov).toBe(CAMERA.fov);

    // Still held: no further step, and the wrap holds.
    play(match, tick, 2, { attack2: true });
    expect(st.zoomLevel).toBe(0);
    expect(st.scoped).toBe(false);
  });

  it('is not scoped while the zoom transition is still running', () => {
    const match = scopeMatch('awp');
    const st = weaponState(match, 'awp');

    // One tick into the press: the level is chosen but the scope is not settled.
    match.tick(cmd(0, { attack2: true }), TICK_DT);
    expect(st.zoomLevel).toBe(1);
    expect(st.scoped).toBe(false);

    // After the zoom time it is settled.
    play(match, 1, 0.6, { attack2: true });
    expect(st.scoped).toBe(true);
  });

  it('drops out of the scope when a scoped shot goes off', () => {
    const match = scopeMatch('awp');
    const st = weaponState(match, 'awp');
    let tick = play(match, 0, 1, { attack2: true });
    expect(st.scoped).toBe(true);

    const before = st.ammo;
    tick = play(match, tick, 0.2, { attack: true });
    expect(st.ammo).toBeLessThan(before); // the shot really fired
    expect(st.scoped).toBe(false);
    expect(match.local.rig.viewFov).toBe(CAMERA.fov);
  });

  it('never scopes a weapon that defines no zoom level', () => {
    const match = scopeMatch('ak47');
    const st = weaponState(match, 'ak47');
    play(match, 0, 1.5, { attack2: true });
    expect(st.zoomLevel).toBe(0);
    expect(st.scoped).toBe(false);
    expect(match.local.rig.viewFov).toBe(CAMERA.fov);
  });
});