// =============================================================================
// tests/render.spec.ts — the actor bodies and the first-person weapon.
//
// These two layers are the answer to "I cannot see the enemies and I cannot see a
// gun": nothing in the sim ever created a mesh. They are pure geometry and
// transform code, so node can check them without a WebGL context (same trick as
// tests/vfx.spec.ts): build the objects, read back matrices and bounding boxes.
//
// The contract that matters most is the first describe block: the visible body is
// derived from the four damage bands of `combat/hitbox.ts`, so what a player sees
// is what a bullet can hit.
// =============================================================================

import { describe, expect, it } from 'vitest';
import { Color, InstancedMesh, Matrix4, Scene, PerspectiveCamera, Vector3, type BufferGeometry, type Mesh } from 'three';
import { HEAD_HALF_WIDTH, HITBOX_BANDS } from '../src/combat/hitbox';
import { CAMERA, PLAYER } from '../src/core/config';
import type { ActorState, GroundWeapon, Team, WeaponKind } from '../src/core/types';
import {
  CharacterRenderer,
  MATE_RIM_DIM,
  TEAM_BODY_COLOR,
  buildActorGeometry,
  buildCorpseGeometry,
} from '../src/render/Characters';
import { MAX_SHADE, MIN_SHADE, mergeParts, shadedBox } from '../src/render/parts';
import {
  GROUND_LIFT,
  GROUND_SHAPE,
  GROUND_SLOTS_PER_KIND,
  GroundWeaponRenderer,
  buildGroundWeaponGeometry,
} from '../src/render/GroundWeapons';
import {
  SIGN_CALLOUT_SIZE,
  SIGN_LIFT,
  SIGN_RAY_RANGE,
  SIGN_SITE_SIZE,
  SIGN_SPAWN_MAX_PLACARDS,
  SIGN_SPAWN_SIZE,
  SIGN_TILE_CAPACITY,
  SIGN_WALL_OFFSET,
  SIGN_WALL_RAY_HEIGHT,
  SIGN_ZONES,
  buildSignGeometry,
  planSignTiles,
  planSigns,
  rayBrushDistance,
  signQuad,
  tileUv,
} from '../src/render/Signs';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { buildAimDuelLite } from '../src/world/maps/aim_duel_lite';
import { calloutLabel } from '../src/ui/pure';
import {
  VIEW_NEAR_LIMIT,
  ViewModel,
  buildWeaponModel,
  type ViewModelPose,
} from '../src/render/ViewModel';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function box(g: BufferGeometry): { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number } {
  g.computeBoundingBox();
  const b = g.boundingBox;
  if (!b) throw new Error('geometry has no bounding box');
  return { minX: b.min.x, maxX: b.max.x, minY: b.min.y, maxY: b.max.y, minZ: b.min.z, maxZ: b.max.z };
}

function actor(id: number, team: Team, over: Partial<ActorState> = {}): ActorState {
  return {
    id,
    name: `actor${id}`,
    team,
    isBot: true,
    pos: { x: id * 100, y: 0, z: -id * 50 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    onGround: true,
    crouching: false,
    duckAmount: 0,
    health: 100,
    armor: 0,
    helmet: false,
    alive: true,
    hasBomb: false,
    hasDefuseKit: false,
    speedFactor: 1,
    ...over,
  };
}

function pose(over: Partial<ViewModelPose> = {}): ViewModelPose {
  return {
    bobX: 0,
    bobY: 0,
    dip: 0,
    punchYaw: 0,
    punchPitch: 0,
    swayYaw: 0,
    swayPitch: 0,
    swing: 0,
    speedNorm: 0,
    alive: true,
    scoped: false,
    reloading: false,
    reloadTime: 2.2,
    drawTime: 0.5,
    dt: 1 / 60,
    ...over,
  };
}

const WEAPON_KINDS: WeaponKind[] = [
  'rifle',
  'smg',
  'pistol',
  'sniper',
  'shotgun',
  'mg',
  'knife',
  'grenade',
  'c4',
];

// ---------------------------------------------------------------------------
// body geometry = damage geometry
// ---------------------------------------------------------------------------

describe('actor geometry', () => {
  it('fits inside the damage hitbox on every axis', () => {
    const b = box(buildActorGeometry());
    expect(b.minY).toBeGreaterThanOrEqual(-0.001);
    expect(b.maxY).toBeLessThanOrEqual(PLAYER.standHeight + 0.001);
    expect(Math.abs(b.minX)).toBeLessThanOrEqual(PLAYER.radius + 0.001);
    expect(Math.abs(b.maxX)).toBeLessThanOrEqual(PLAYER.radius + 0.001);
    expect(Math.abs(b.minZ)).toBeLessThanOrEqual(PLAYER.radius + 0.001);
    expect(Math.abs(b.maxZ)).toBeLessThanOrEqual(PLAYER.radius + 0.001);
  });

  it('reaches the head band so a headshot is a head the player can see', () => {
    const b = box(buildActorGeometry());
    const headBottom = PLAYER.standHeight * HITBOX_BANDS.head;
    expect(b.maxY).toBeGreaterThan(PLAYER.standHeight - 1);
    // The head box is authored 13 wide, i.e. exactly the 2 * 6.5 hitbox width.
    expect(HEAD_HALF_WIDTH * 2).toBe(13);
    expect(headBottom).toBeGreaterThan(PLAYER.standHeight * HITBOX_BANDS.chest);
  });

  it('lies flat on the ground as a corpse, extending along its facing axis', () => {
    const b = box(buildCorpseGeometry());
    expect(b.minY).toBeGreaterThanOrEqual(-0.001);
    expect(b.minY).toBeLessThan(1);
    expect(b.maxY).toBeLessThan(PLAYER.standHeight * 0.5);
    expect(b.maxZ - b.minZ).toBeGreaterThan(PLAYER.standHeight * 0.75);
  });

  it('authors the front toward -Z, which is what rotation.y = yaw means', () => {
    // The chest plate is the frontmost part; it must sit at a negative z.
    const b = box(buildActorGeometry());
    expect(b.minZ).toBeLessThan(0);
    expect(b.maxZ).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// part builder
// ---------------------------------------------------------------------------

describe('part builder', () => {
  it('merges shaded boxes into a single geometry', () => {
    const merged = mergeParts([shadedBox(2, 2, 2, 0, 0, 0, 1), shadedBox(2, 2, 2, 0, 4, 0, 0.5)], 'test');
    expect(merged.getAttribute('position')?.count).toBe(48);
    expect(merged.getAttribute('color')?.count).toBe(48);
    expect(merged.index?.count).toBe(72);
    merged.dispose();
  });

  it('tints vertices by shade and clamps the extreme values', () => {
    const dark = shadedBox(1, 1, 1, 0, 0, 0, -3);
    const bright = shadedBox(1, 1, 1, 0, 0, 0, 99);
    const darkColor = dark.getAttribute('color');
    const brightColor = bright.getAttribute('color');
    expect(darkColor?.getX(0)).toBeCloseTo(MIN_SHADE, 5);
    expect(brightColor?.getX(0)).toBeCloseTo(MAX_SHADE, 5);
    dark.dispose();
    bright.dispose();
  });

  it('refuses to merge parts that disagree on attributes', () => {
    const plain = shadedBox(1, 1, 1, 0, 0, 0);
    plain.deleteAttribute('color');
    expect(() => mergeParts([shadedBox(1, 1, 1, 0, 0, 0), plain], 'broken')).toThrow(
      /mergeParts failed/,
    );
    plain.dispose();
  });
});

// ---------------------------------------------------------------------------
// character layer
// ---------------------------------------------------------------------------

describe('CharacterRenderer', () => {
  it('draws one body per living actor and parks the actor the camera is inside', () => {
    const scene = new Scene();
    const layer = new CharacterRenderer(scene);
    const actors = [actor(0, 'T'), actor(1, 'CT'), actor(2, 'CT', { alive: false })];

    layer.sync(actors, { hiddenId: 0, viewerTeam: 'T', dt: 1 / 60 });

    expect(layer.drawnBodies).toBe(1);
    expect(layer.drawnCorpses).toBe(1);
    expect(scene.getObjectByName('render.characters')).toBeTruthy();

    const bodies = scene.getObjectByName('render.actor-bodies') as InstancedMesh;
    const corpses = scene.getObjectByName('render.actor-corpses') as InstancedMesh;
    const m = new Matrix4();
    bodies.getMatrixAt(0, m);
    expect(m.determinant()).toBeCloseTo(0, 5); // viewer hidden by a zero scale
    bodies.getMatrixAt(1, m);
    expect(Math.abs(m.determinant())).toBeGreaterThan(0); // the enemy is placed
    corpses.getMatrixAt(2, m);
    expect(Math.abs(m.determinant())).toBeGreaterThan(0); // the corpse is placed
    layer.dispose();
  });

  it('places a body at its feet position and paints it in the team colour', () => {
    const scene = new Scene();
    const layer = new CharacterRenderer(scene);
    const enemy = actor(7, 'CT');
    layer.sync([enemy], { hiddenId: 99, viewerTeam: 'T', dt: 1 / 60 });

    const bodies = scene.getObjectByName('render.actor-bodies') as InstancedMesh;
    const m = new Matrix4();
    bodies.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(enemy.pos.x, 5);
    expect(m.elements[13]).toBeCloseTo(enemy.pos.y, 5);
    expect(m.elements[14]).toBeCloseTo(enemy.pos.z, 5);

    const hex = TEAM_BODY_COLOR.CT;
    const color = bodies.instanceColor;
    expect(color).toBeTruthy();
    // InstancedMesh colours are stored in the renderer's linear working space,
    // so compare against three's own sRGB -> linear conversion of the same hex.
    const expected = new Color().setHex(hex);
    expect(color?.getX(0)).toBeCloseTo(expected.r, 4);
    expect(color?.getY(0)).toBeCloseTo(expected.g, 4);
    expect(color?.getZ(0)).toBeCloseTo(expected.b, 4);
    layer.dispose();
  });

  it('dims a teammate rim instead of adding a fourth mesh', () => {
    const scene = new Scene();
    const layer = new CharacterRenderer(scene);
    const mate = actor(1, 'CT');
    layer.sync([mate], { hiddenId: 99, viewerTeam: 'CT', dt: 1 / 60 });
    const rims = scene.getObjectByName('render.actor-rims') as InstancedMesh;
    const dim = rims.instanceColor?.getX(0) ?? 0;
    layer.sync([mate], { hiddenId: 99, viewerTeam: 'T', dt: 1 / 60 });
    const full = rims.instanceColor?.getX(0) ?? 0;
    expect(dim).toBeLessThan(full);
    expect(full).toBeGreaterThan(0);
    expect(dim / full).toBeCloseTo(MATE_RIM_DIM, 2);
    // Only three meshes exist, whatever the roster size.
    expect(layer.group.children.length).toBe(3);
    layer.dispose();
  });

  it('survives a roster larger than its slot capacity', () => {
    const scene = new Scene();
    const layer = new CharacterRenderer(scene, 2);
    const many = [actor(0, 'T'), actor(1, 'T'), actor(2, 'T'), actor(3, 'T')];
    expect(() => layer.sync(many, { hiddenId: -1, viewerTeam: 'T', dt: 1 / 60 })).not.toThrow();
    expect(layer.drawnBodies).toBe(2);
    layer.dispose();
  });
});

// ---------------------------------------------------------------------------
// view model
// ---------------------------------------------------------------------------

describe('ViewModel', () => {
  it('puts every part in front of the near plane for all nine weapon kinds', () => {
    for (const kind of WEAPON_KINDS) {
      const { group, muzzle } = buildWeaponModel(kind);
      const mesh = group.children[0] as InstancedMesh;
      const b = box(mesh.geometry);
      expect(b.maxZ, `${kind} parts must sit past the near plane`).toBeLessThanOrEqual(
        -VIEW_NEAR_LIMIT,
      );
      expect(b.minZ, `${kind} must reach forward`).toBeLessThan(-VIEW_NEAR_LIMIT * 2);
      expect(muzzle.forward, `${kind} muzzle`).toBeGreaterThan(CAMERA.near);
      expect(muzzle.down).toBeGreaterThan(0);
      expect(muzzle.right).toBeGreaterThan(0);
      group.removeFromParent();
      mesh.geometry.dispose();
    }
  });

  it('hides itself when dead or scoped and shows itself otherwise', () => {
    const vm = new ViewModel(new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far));
    vm.setWeapon('rifle');
    vm.update(pose());
    expect(vm.visible).toBe(true);
    vm.update(pose({ scoped: true }));
    expect(vm.visible).toBe(false);
    vm.update(pose({ alive: false }));
    expect(vm.visible).toBe(false);
    vm.dispose();
    expect(vm.scene.children.length).toBe(0);
  });

  it('follows the recoil punch, the bob and the reload wave', () => {
    const vm = new ViewModel(new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far));
    vm.setWeapon('rifle');
    const root = () => vm.scene.getObjectByName('view-model.root') as unknown as {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
    };

    vm.update(pose({ drawTime: 0.0001 }));
    const rest = root().rotation.x;
    vm.update(pose({ punchPitch: 0.4, drawTime: 0.0001 }));
    expect(root().rotation.x).toBeGreaterThan(rest);
    vm.update(pose({ bobX: 3, bobY: -2, drawTime: 0.0001 }));
    expect(root().position.x).toBeGreaterThan(0);
    expect(root().position.y).toBeLessThan(0);
    vm.update(pose({ reloading: true, reloadTime: 1, dt: 0.5, drawTime: 0.0001 }));
    expect(root().position.y).toBeLessThan(0);
    expect(root().rotation.z).not.toBe(0);
    vm.dispose();
  });

  it('sweeps the view model through a knife swing', () => {
    const vm = new ViewModel(new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far));
    vm.setWeapon('knife');
    const root = () => vm.scene.getObjectByName('view-model.root') as unknown as {
      position: { x: number; y: number; z: number };
      rotation: { x: number; y: number; z: number };
    };
    // `speedNorm: 1` kills the idle breathing so the pose is exactly the swing.
    const at = (swing: number) => {
      vm.update(pose({ swing, speedNorm: 1, drawTime: 0.0001 }));
      return { ...root().position, yaw: root().rotation.y, roll: root().rotation.z };
    };

    // The first frames still carry slices of the raise animation: warm it out.
    for (let i = 0; i < 4; i++) at(0);
    const rest = at(0);
    const start = at(1); // pulled back to the right, before the sweep
    const mid = at(0.5); // blade crossing the middle, thrust forward
    const late = at(0.2); // followed through to the left

    expect(start.x).toBeGreaterThan(rest.x);
    expect(start.yaw).toBeLessThan(rest.yaw);
    expect(start.roll).toBeGreaterThan(rest.roll);

    expect(mid.z).toBeLessThan(rest.z);
    expect(mid.y).toBeLessThan(rest.y);

    expect(late.x).toBeLessThan(rest.x);
    expect(late.roll).toBeLessThan(rest.roll);

    // At phase 0 the model is exactly back at rest: no leftover offset.
    const done = at(0);
    expect(done.x).toBeCloseTo(rest.x, 6);
    expect(done.y).toBeCloseTo(rest.y, 6);
    expect(done.z).toBeCloseTo(rest.z, 6);
    expect(done.yaw).toBeCloseTo(rest.yaw, 6);
    expect(done.roll).toBeCloseTo(rest.roll, 6);
    vm.dispose();
  });

  it('draws the weapon in camera space, not in map coordinates', () => {
    // The models are authored around x ≈ +7 (right), y ≈ -6 (down), z ≈ -14
    // (forward). Rendering that scene with the world camera would drop the gun
    // back into map coordinates near the origin, where the player can never see
    // it — which is exactly what happened before this test existed.
    const world = new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far);
    world.position.set(1200, 68, -2400);
    world.rotation.set(0, Math.PI / 3, 0);
    world.updateMatrixWorld(true);

    const vm = new ViewModel(world);
    const cam = vm.renderCamera;
    expect(cam).not.toBe(world);
    expect(cam.position.length()).toBe(0);
    expect(cam.fov).toBe(world.fov);
    expect(cam.aspect).toBe(world.aspect);
    expect(cam.near).toBe(world.near);
    expect(cam.far).toBe(world.far);

    // A zoom (scope fov, resize) must still reach the view pass.
    world.fov = 40;
    world.aspect = 4 / 3;
    world.updateProjectionMatrix();
    expect(vm.renderCamera.fov).toBe(40);
    expect(vm.renderCamera.aspect).toBeCloseTo(4 / 3, 6);

    vm.setWeapon('rifle');
    vm.update(pose({ drawTime: 0.0001 }));
    expect(vm.visible).toBe(true);

    let mesh: Mesh | null = null;
    vm.scene.traverse((object) => {
      const candidate = object as Mesh;
      if (!mesh && candidate.isMesh) mesh = candidate;
    });
    expect(mesh).not.toBeNull();
    const geometry = (mesh as unknown as Mesh).geometry;
    geometry.computeBoundingBox();
    const box = geometry.boundingBox;
    expect(box).not.toBeNull();
    const center = box?.getCenter(new Vector3()) ?? new Vector3();
    // In camera space the gun is a few units right/down and well in front.
    expect(center.z).toBeLessThan(-CAMERA.near);
    expect(Math.abs(center.x)).toBeLessThan(20);
    // And it really lands on screen with this camera.
    const ndc = center.clone().project(cam);
    expect(Math.abs(ndc.x)).toBeLessThan(1);
    expect(Math.abs(ndc.y)).toBeLessThan(1);
    expect(ndc.z).toBeLessThan(1);
    vm.dispose();
  });

  it('switches models without leaking a second one into the scene', () => {
    const vm = new ViewModel(new PerspectiveCamera(CAMERA.fov, 16 / 9, CAMERA.near, CAMERA.far));
    vm.setWeapon('rifle');
    vm.setWeapon('pistol');
    vm.setWeapon('pistol');
    expect(vm.weapon).toBe('pistol');
    expect(vm.scene.getObjectByName('view-model.root')?.children.length).toBe(2);
    vm.setWeapon('rifle');
    expect(vm.muzzleOffset.forward).toBeGreaterThan(30); // rifle reach, not pistol
    vm.dispose();
  });
});

// ---------------------------------------------------------------------------
// World signage: the labels that make the map legible
// ---------------------------------------------------------------------------

describe('world signs', () => {
  const map = buildDust2Lite();
  const plan = planSigns(map);
  const tiles = planSignTiles(plan);
  const tileIndex = new Map(tiles.map((t, i) => [t.key, i] as const));

  it('names every callout in the world, not just on the radar', () => {
    const callouts = plan.filter((p) => p.kind === 'callout');
    const names = Object.keys(map.callouts);
    // ASite / BSite become the big letters instead of a floor label.
    expect(callouts.length).toBe(names.length - map.sites.length);
    const labels = callouts.map((c) => c.label);
    expect(labels).toContain('MID DOORS');
    expect(labels).toContain('LONG A');
    expect(labels).toContain('UPPER TUNNEL');
    expect(labels).toContain('CT MID');
    for (const label of labels) expect(label).toBe(label.toUpperCase());
    for (const label of labels) expect(label).not.toContain('_');
    for (const entry of callouts) {
      expect(entry.upright).toBe(false);
      expect(entry.size).toBe(SIGN_CALLOUT_SIZE);
      // A floor label reads for a viewer walking out of the T spawn (-Z).
      expect(entry.yaw).toBe(0);
      // It floats SIGN_LIFT above its own callout height (the Pit is at -48).
      const key = entry.key.replace('callout:', '');
      expect(entry.y).toBeCloseTo((map.callouts[key]?.y ?? 0) + SIGN_LIFT, 6);
    }
  });

  it('puts the callout text where the callout data says it is', () => {
    const mid = plan.find((p) => p.key === 'callout:Mid');
    expect(mid).toBeDefined();
    expect(mid?.x).toBe(map.callouts['Mid']?.x);
    expect(mid?.z).toBe(map.callouts['Mid']?.z);
    const catwalk = plan.find((p) => p.key === 'callout:Catwalk');
    expect(catwalk?.y).toBe((map.callouts['Catwalk']?.y ?? 0) + SIGN_LIFT);
  });

  it('marks both bomb sites with a big letter on the floor', () => {
    const sites = plan.filter((p) => p.kind === 'site');
    expect(sites.map((s) => s.label).sort()).toEqual(['A', 'B']);
    for (const site of sites) {
      expect(site.size).toBe(SIGN_SITE_SIZE);
      expect(site.upright).toBe(false);
      const region = map.sites.find((r) => r.site === site.label);
      expect(region).toBeDefined();
      const xs = (region?.poly ?? []).map((p) => p[0]);
      const zs = (region?.poly ?? []).map((p) => p[1]);
      expect(site.x).toBeGreaterThanOrEqual(Math.min(...xs));
      expect(site.x).toBeLessThanOrEqual(Math.max(...xs));
      expect(site.z).toBeGreaterThanOrEqual(Math.min(...zs));
      expect(site.z).toBeLessThanOrEqual(Math.max(...zs));
      expect(site.y).toBe((region?.y ?? 0) + SIGN_LIFT);
    }
  });

  it('hangs a placard on the blank wall each spawn faces', () => {
    const spawnSigns = plan.filter((p) => p.kind === 'spawn');
    for (const team of ['T', 'CT'] as const) {
      const mine = spawnSigns.filter((s) => s.label === (team === 'T' ? 'T SPAWN' : 'CT SPAWN'));
      // Spawns stand in pairs, so each team gets a placard per wall, not one.
      expect(mine.length).toBeGreaterThan(1);
      expect(mine.length).toBeLessThanOrEqual(SIGN_SPAWN_MAX_PLACARDS);
      const points = mine.map((s) => `${s.x.toFixed(0)},${s.z.toFixed(0)}`);
      expect(new Set(points).size).toBe(points.length);
    }

    for (const sign of spawnSigns) {
      expect(sign.upright).toBe(true);
      expect(sign.size).toBe(SIGN_SPAWN_SIZE);
      const team = sign.label.startsWith('T') ? 'T' : 'CT';
      const spawns = map.spawns.filter((s) => s.team === team);
      // Same facing as the spawn, so the placard's +Z normal looks back at it.
      const facing = spawns.filter((s) => Math.abs(s.yaw - sign.yaw) < 1e-9);
      expect(facing.length).toBeGreaterThan(0);

      // The placard sits on the spawn's own aim line, a few units in front of
      // the wall that line hits (never floating in mid air, never in the wall).
      const dx = -Math.sin(sign.yaw);
      const dz = -Math.cos(sign.yaw);
      let ok = false;
      for (const spawn of facing) {
        const along = (sign.x - spawn.pos.x) * dx + (sign.z - spawn.pos.z) * dz;
        const across = Math.abs((sign.x - spawn.pos.x) * dz - (sign.z - spawn.pos.z) * dx);
        const hit = rayBrushDistance(
          map,
          { x: spawn.pos.x, y: spawn.pos.y + SIGN_WALL_RAY_HEIGHT, z: spawn.pos.z },
          dx,
          dz,
          SIGN_RAY_RANGE,
        );
        if (hit === null) continue;
        if (across < 1 && along > 20 && along <= hit && hit - along < SIGN_WALL_OFFSET * 2) ok = true;
      }
      expect(ok).toBe(true);
      expect(sign.y).toBeGreaterThan(0);
    }

    // The wall is really there: a ray from a real T spawn forward stops on it.
    const tSpawn = map.spawns.filter((s) => s.team === 'T')[0];
    const eye = { x: tSpawn.pos.x, y: tSpawn.pos.y + SIGN_WALL_RAY_HEIGHT, z: tSpawn.pos.z };
    const hit = rayBrushDistance(map, eye, 0, -1, SIGN_RAY_RANGE);
    expect(hit).not.toBeNull();
    expect(hit ?? 0).toBeGreaterThan(0);
    // Nothing behind the spawn -> null, so no floating placard is ever placed.
    expect(rayBrushDistance(map, eye, 0, 1, 1)).toBeNull();
  });

  it('washes every district in its own hue without touching geometry', () => {
    const paint = plan.filter((p) => p.kind === 'paint');
    expect(paint.length).toBe(SIGN_ZONES.length);
    // Paint first: labels must blend on top of their own wash.
    expect(plan.slice(0, paint.length).every((p) => p.kind === 'paint')).toBe(true);
    for (const entry of paint) {
      expect(entry.stretch).toBeGreaterThan(entry.size * 0.5);
      expect(entry.upright).toBe(false);
      const zone = SIGN_ZONES.find((z) => z.name === (entry.label || ''));
      expect(zone).toBeUndefined(); // paint carries no text at all
    }
    // A site sits on a 128 u plate, so its wash must not sink into it.
    const aSite = paint.find((p) => p.x > 1000 && p.z < -1000);
    expect(aSite?.y).toBeGreaterThan(128);

    // The wash is a decal: no brush of the map gained anything.
    expect(map.brushes.length).toBe(136);
  });

  it('paints the districts the map itself declares, not dust2 ones', () => {
    const duel = buildAimDuelLite();
    const zones = duel.paint ?? [];
    // Every walkable area of the arena carries its own wash — except the two
    // staircases: paint is one flat quad at one floor height, so it cannot
    // follow 8 treads, and a wash there would just be a rectangle floating
    // through the steps.
    const areas = new Set(duel.nav.map((n) => n.area));
    areas.delete('TRamp');
    areas.delete('CTRamp');
    expect(new Set(zones.map((z) => z.name))).toEqual(areas);
    expect(zones.length).toBeGreaterThan(0);

    const duelPaint = planSigns(duel).filter((p) => p.kind === 'paint');
    expect(duelPaint.length).toBe(zones.length);
    for (const entry of duelPaint) {
      expect(entry.upright).toBe(false);
      // Dust2's zones run out to x 2145 / z 2855: the arena is half that, so a
      // stale table painted onto it would immediately stick out past the shell.
      expect(Math.abs(entry.x) + entry.size * 0.5).toBeLessThanOrEqual(1024);
      expect(Math.abs(entry.z) + (entry.stretch ?? 0) * 0.5).toBeLessThanOrEqual(1440);
      expect(entry.y).toBeGreaterThan(0);
    }
    // The deck washes sit on top of the 128 u plate, not inside it.
    expect(Math.max(...duelPaint.map((p) => p.y))).toBeGreaterThan(128);
  });

  it('packs every label into an atlas that fits the grid', () => {
    expect(tiles.length).toBeLessThanOrEqual(SIGN_TILE_CAPACITY);
    // One tile per distinct label (the two placards of a team share theirs), plus
    // the single soft-edge tile every district wash uses.
    const labelKeys = new Set(plan.filter((p) => p.kind !== 'paint').map((p) => p.key));
    expect(tiles.length).toBe(labelKeys.size + 1);
    expect(new Set(tiles.map((t) => t.key)).size).toBe(tiles.length);
    expect(tiles.filter((t) => t.kind === 'paint').length).toBe(1);
    const labels = tiles.filter((t) => t.kind !== 'paint').map((t) => t.label);
    expect(labels.every((label) => label.length > 0)).toBe(true);
  });

  it('maps a tile to UV corners without bleeding into its neighbours', () => {
    const cols = 4;
    const rows = 7;
    const [u0, v0, u1, v1] = tileUv(0, cols, rows);
    expect(u0).toBe(0);
    expect(u1).toBe(0.25);
    // Canvas row 0 is the top row and a CanvasTexture flips Y.
    expect(v1).toBe(1);
    expect(v0).toBeCloseTo(6 / 7, 10);
    const [u2, , , v2] = tileUv(cols, cols, rows);
    expect(u2).toBe(0);
    expect(v2).toBeCloseTo(6 / 7, 10);
    for (let i = 0; i < cols * rows; i++) {
      const [a0, b0, a1, b1] = tileUv(i, cols, rows);
      expect(a0).toBeGreaterThanOrEqual(0);
      expect(b0).toBeGreaterThanOrEqual(0);
      expect(a1).toBeLessThanOrEqual(1);
      expect(b1).toBeLessThanOrEqual(1);
      expect(a1 - a0).toBeCloseTo(1 / cols, 10);
      expect(b1 - b0).toBeCloseTo(1 / rows, 10);
    }
  });

  it('merges one mesh worth of quads with the right orientation', () => {
    const geometry = buildSignGeometry(plan, tileIndex, 4, 7);
    expect(geometry).not.toBeNull();
    const g = geometry as BufferGeometry;
    const position = g.getAttribute('position');
    // One 4-vertex quad per plan entry.
    expect(position.count).toBe(plan.length * 4);
    const uv = g.getAttribute('uv');
    for (let i = 0; i < uv.count; i++) {
      expect(uv.getX(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getX(i)).toBeLessThanOrEqual(1);
      expect(uv.getY(i)).toBeGreaterThanOrEqual(0);
      expect(uv.getY(i)).toBeLessThanOrEqual(1);
    }
    const color = g.getAttribute('color');
    expect(color.count).toBe(position.count);
    const bounds = box(g);
    // The whole map is covered; the only sign below y 0 is the Pit label (-48).
    expect(bounds.minY).toBeGreaterThan(-49);
    expect(bounds.minY).toBeLessThan(0);
    expect(bounds.maxX - bounds.minX).toBeGreaterThan(4000);
  });

  it('lays flat signs down and stands placards up', () => {
    const flat = plan.find((p) => p.kind === 'callout') as (typeof plan)[number];
    const flatQuad = signQuad(flat, 0, 4, 7);
    const flatBox = box(flatQuad);
    // Rotated flat: a 300 u label is 300 u wide, but only ~0 u tall.
    expect(flatBox.maxY - flatBox.minY).toBeLessThan(flat.size * 0.01);
    expect(flatBox.maxX - flatBox.minX).toBeCloseTo(flat.size, 6);

    const upright = plan.find((p) => p.kind === 'spawn') as (typeof plan)[number];
    const upQuad = signQuad(upright, 0, 4, 7);
    const upBox = box(upQuad);
    expect(upBox.maxY - upBox.minY).toBeCloseTo(upright.size, 6);
    expect(upBox.maxZ - upBox.minZ).toBeLessThan(upright.size * 0.01);
  });

  it('formats callout keys the way the radar and the signs both need', () => {
    expect(calloutLabel('MidDoors')).toBe('MID DOORS');
    expect(calloutLabel('TSpawn')).toBe('T SPAWN');
    expect(calloutLabel('LongA')).toBe('LONG A');
    expect(calloutLabel('BTunnels')).toBe('B TUNNELS');
    expect(calloutLabel('CTMid')).toBe('CT MID');
    expect(calloutLabel('')).toBe('');
  });
});

describe('ground weapons', () => {
  const gun = (id: number, kind: WeaponKind, x = 0, z = 0): GroundWeapon => ({
    id,
    weaponId: kind === 'rifle' ? 'ak47' : kind === 'pistol' ? 'usp' : 'nova',
    kind,
    ammo: 17,
    reserve: 34,
    pos: { x, y: 0, z },
    droppedAt: 0,
  });

  it('draws one instance per gun and one draw call per kind on the floor', () => {
    const scene = new Scene();
    const layer = new GroundWeaponRenderer(scene);
    expect(layer.drawn).toBe(0);
    expect(layer.drawCalls).toBe(0);
    expect(layer.kinds).toBe(0);
    expect(scene.getObjectByName('render.ground-weapons')).toBeTruthy();

    layer.sync([gun(1, 'rifle'), gun(2, 'rifle', 40, 20), gun(3, 'pistol', -30, 5)]);
    expect(layer.drawn).toBe(3);
    expect(layer.drawCalls).toBe(2);
    expect(layer.kinds).toBe(2);

    const rifles = scene.getObjectByName('render.ground-rifle') as InstancedMesh;
    expect(rifles).toBeInstanceOf(InstancedMesh);
    expect(rifles.count).toBe(2);
    // Instanced and spread over the whole map: its own bounds would cull it.
    expect(rifles.frustumCulled).toBe(false);
    expect(rifles.matrixAutoUpdate).toBe(false);
    expect((scene.getObjectByName('render.ground-pistol') as InstancedMesh).count).toBe(1);

    // A gun lies at its own half thickness above the floor, and the drop id scatters
    // the yaw so a pile of two is never perfectly parallel.
    const a = new Matrix4();
    const b = new Matrix4();
    rifles.getMatrixAt(0, a);
    rifles.getMatrixAt(1, b);
    const pa = new Vector3().setFromMatrixPosition(a);
    const pb = new Vector3().setFromMatrixPosition(b);
    expect(pa.y).toBeCloseTo(GROUND_LIFT + GROUND_SHAPE.rifle.thick * 0.5, 6);
    expect(pb.x).toBeCloseTo(40, 6);
    expect(pb.z).toBeCloseTo(20, 6);
    expect(Math.abs(a.elements[0] - b.elements[0])).toBeGreaterThan(0.01);

    layer.dispose();
  });

  it('parks a kind that left the floor instead of paying a draw call for it', () => {
    const scene = new Scene();
    const layer = new GroundWeaponRenderer(scene);

    layer.sync([gun(1, 'rifle'), gun(3, 'pistol')]);
    expect(layer.drawCalls).toBe(2);

    layer.sync([gun(1, 'rifle')]);
    expect(layer.drawn).toBe(1);
    expect(layer.drawCalls).toBe(1);
    // The mesh is kept for the round; only its instance count is parked at zero.
    expect(layer.kinds).toBe(2);
    expect((scene.getObjectByName('render.ground-pistol') as InstancedMesh).count).toBe(0);

    layer.clear();
    expect(layer.drawn).toBe(0);
    expect(layer.drawCalls).toBe(0);
    expect((scene.getObjectByName('render.ground-rifle') as InstancedMesh).count).toBe(0);

    layer.dispose();
  });

  it('caps one kind at its instanced capacity', () => {
    const scene = new Scene();
    const layer = new GroundWeaponRenderer(scene);
    const many: GroundWeapon[] = [];
    for (let i = 0; i < GROUND_SLOTS_PER_KIND + 5; i += 1) many.push(gun(i + 1, 'rifle', i * 3, 0));

    layer.sync(many);

    expect(layer.drawn).toBe(GROUND_SLOTS_PER_KIND);
    expect((scene.getObjectByName('render.ground-rifle') as InstancedMesh).count).toBe(
      GROUND_SLOTS_PER_KIND,
    );
    layer.dispose();
  });

  it('frees every mesh and geometry on dispose', () => {
    const scene = new Scene();
    const layer = new GroundWeaponRenderer(scene);
    layer.sync([gun(1, 'rifle'), gun(2, 'grenade')]);
    expect(layer.kinds).toBe(2);

    layer.dispose();

    expect(layer.kinds).toBe(0);
    expect(layer.drawn).toBe(0);
    expect(layer.group.children).toHaveLength(0);
    expect(scene.getObjectByName('render.ground-rifle')).toBeUndefined();
    // The group itself is the scene's problem; the layer only empties it.
    expect(scene.getObjectByName('render.ground-weapons')).toBeTruthy();
  });

  it('builds one merged body per kind, sized from its table entry', () => {
    const rifle = buildGroundWeaponGeometry('rifle');
    rifle.computeBoundingBox();
    const rbox = rifle.boundingBox!;
    const span = (b: typeof rbox) => ({ x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z });
    const r = span(rbox);

    // Body plus a stock and a muzzle stub, so taller than the bare `length` but not
    // twice it, and as wide as the table says.
    expect(r.z).toBeGreaterThan(GROUND_SHAPE.rifle.length);
    expect(r.z).toBeLessThan(GROUND_SHAPE.rifle.length * 1.5);
    // As wide as the body, give or take the magazine bulging out of one side.
    expect(r.x).toBeGreaterThanOrEqual(GROUND_SHAPE.rifle.wide);
    expect(r.x).toBeLessThan(GROUND_SHAPE.rifle.wide * 1.2);
    expect(rifle.getAttribute('position').count).toBeGreaterThan(0);

    const knife = buildGroundWeaponGeometry('knife');
    knife.computeBoundingBox();
    expect(span(knife.boundingBox!).z).toBeLessThan(r.z * 0.5);
  });
});