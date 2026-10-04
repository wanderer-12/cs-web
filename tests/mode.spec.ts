// =============================================================================
// tests/mode.spec.ts — the mode layer: team composition, round stages, buying.
//
// The classic entry of MODES has to mirror the old RULES block exactly, or the
// 5v5 game would change behind the player's back. The duel entry is the one the
// user asked for: one human alone against three bots (or a LAN peer), no bomb,
// three stages of 8/15/10 rounds, and first to 17 wins.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { Match } from '../src/game/game';
import { World } from '../src/world/world';
import { buildAimDuelLite } from '../src/world/maps/aim_duel_lite';
import { buildDust2Lite } from '../src/world/maps/de_dust2_lite';
import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import {
  LAN_DUEL_TEAMS,
  MODES,
  RULES,
  TICK_DT,
  modeById,
  phaseAllowsKind,
  phaseForRound,
  phaseIndexForRound,
  type MatchModeId,
  type TeamComposition,
} from '../src/core/config';
import { weaponById } from '../src/combat/weaponDefs';
import { EMPTY_BUTTONS, type InputCommand } from '../src/core/types';

function idle(tick: number): InputCommand {
  return {
    tick,
    buttons: { ...EMPTY_BUTTONS },
    yaw: 0,
    pitch: 0,
    mouseDX: 0,
    mouseDY: 0,
  };
}

function walk(tick: number, yaw = 0): InputCommand {
  const cmd = idle(tick);
  cmd.buttons.forward = true;
  cmd.yaw = yaw;
  return cmd;
}

interface MakeOptions {
  mode?: MatchModeId;
  teams?: Partial<TeamComposition>;
  botsPerTeam?: number;
  remoteNames?: readonly string[];
  mirror?: boolean;
}

function makeMatch(opts: MakeOptions = {}) {
  const map = opts.mode === 'duel' ? buildAimDuelLite() : buildDust2Lite();
  const world = new World(map);
  const bus = new EventBus();
  const match = new Match({
    world,
    bus,
    map,
    rng: new Rng(0x7e57),
    skipWarmup: true,
    mode: opts.mode,
    teams: opts.teams,
    botsPerTeam: opts.botsPerTeam,
    remoteNames: opts.remoteNames,
    mirror: opts.mirror,
  });
  return { map, world, bus, match };
}

function run(match: Match, seconds: number, cmdFor: (tick: number) => InputCommand = idle): void {
  const ticks = Math.round(seconds / TICK_DT);
  for (let i = 0; i < ticks; i += 1) match.tick(cmdFor(i), TICK_DT);
}

/** Park the human inside their own buy zone, whatever map they are on. */
function standInBuyZone(match: Match): void {
  const player = match.local;
  const zone = match.map.buyZones.find((z) => z.team === player.team);
  if (!zone) return;
  player.state.pos.x = (zone.min.x + zone.max.x) / 2;
  player.state.pos.z = (zone.min.z + zone.max.z) / 2;
  player.state.pos.y = zone.min.y;
}

/**
 * A round cannot be decided while the clock is frozen (`checkRoundEnd` ignores
 * the freeze), so every helper below kills the doomed side before the round's
 * first tick and then plays the freeze out. Bounded, so a broken clock fails
 * loudly instead of hanging the suite.
 */
function playOutRound(match: Match): void {
  for (let i = 0; i < 1200 && match.phase === 'freeze'; i += 1) match.tick(idle(i), TICK_DT);
  run(match, TICK_DT * 2);
  for (let i = 0; i < 1200 && match.phase === 'over' && !match.matchOver; i += 1) {
    match.tick(idle(i), TICK_DT);
  }
  if (!match.matchOver) expect(match.phase).toBe('freeze');
}

/** Win one duel round for the human: the enemies die before the round's first tick. */
function winOneRound(match: Match): void {
  const local = match.local;
  for (const player of match.players) {
    if (player.team === local.team || !player.state.alive) continue;
    match.combat.applyDirectDamage(player.id, local.id, 500, 'chest');
  }
  playOutRound(match);
}

/** Throw one duel round: the human's whole side dies, so the far side takes it. */
function loseOneRound(match: Match): void {
  const local = match.local;
  const enemy = match.players.find((p) => p.team !== local.team);
  if (!enemy) throw new Error('loseOneRound: no enemy to attribute the kill to');
  for (const player of match.players) {
    if (player.team !== local.team || !player.state.alive) continue;
    match.combat.applyDirectDamage(player.id, enemy.id, 500, 'chest');
  }
  playOutRound(match);
}

function advanceRounds(match: Match, rounds: number): void {
  for (let i = 0; i < rounds && !match.matchOver; i += 1) winOneRound(match);
}

function loseRounds(match: Match, rounds: number): void {
  for (let i = 0; i < rounds && !match.matchOver; i += 1) loseOneRound(match);
}

describe('MODES — the table', () => {
  it('keeps classic identical to the RULES block it replaced', () => {
    const classic = MODES.classic;
    expect(classic.roundsToWin).toBe(RULES.roundsToWin);
    expect(classic.maxRounds).toBe(RULES.maxRounds);
    expect(classic.freezeTime).toBe(RULES.freezeTime);
    expect(classic.roundTime).toBe(RULES.roundTime);
    expect(classic.buyTime).toBe(RULES.buyTime);
    expect(classic.warmupTime).toBe(RULES.warmupTime);
    expect(classic.roundEndDelay).toBe(RULES.roundEndDelay);
    expect(classic.startMoney).toBe(RULES.startMoney);
    expect(classic.maxMoney).toBe(RULES.maxMoney);
    expect(classic.solo.ownBots).toBe(RULES.botsPerTeam);
    expect(classic.solo.enemyBots).toBe(RULES.botsPerTeam + 1);
    expect(classic.bomb).toBe(true);
    expect(classic.halfTimeSwap).toBe(true);
    expect(classic.pistols).toEqual({ T: 'glock', CT: 'usp' });
  });

  it('is first to 17 over exactly 33 duel rounds', () => {
    const duel = MODES.duel;
    const total = duel.phases.reduce((sum, p) => sum + p.rounds, 0);
    expect(total).toBe(33);
    expect(duel.maxRounds).toBe(33);
    expect(duel.roundsToWin).toBe(17);
    // A majority of 33, which is what the player asked for.
    expect(duel.roundsToWin).toBe(Math.floor(total / 2) + 1);
    expect(duel.bomb).toBe(false);
    expect(duel.halfTimeSwap).toBe(false);
    expect(duel.solo).toEqual({ ownHumans: 1, ownBots: 0, enemyHumans: 0, enemyBots: 3 });
  });

  it('splits the duel into 8 pistol, 15 rifle and 10 sniper rounds', () => {
    expect(MODES.duel.phases.map((p) => p.rounds)).toEqual([8, 15, 10]);
    expect(MODES.duel.phases.map((p) => p.label)).toEqual(['手枪局', '步枪局', '狙击局']);

    expect(phaseForRound(MODES.duel, 1).label).toBe('手枪局');
    expect(phaseForRound(MODES.duel, 8).label).toBe('手枪局');
    expect(phaseForRound(MODES.duel, 9).label).toBe('步枪局');
    expect(phaseForRound(MODES.duel, 23).label).toBe('步枪局');
    expect(phaseForRound(MODES.duel, 24).label).toBe('狙击局');
    expect(phaseForRound(MODES.duel, 33).label).toBe('狙击局');
    // A round past the end clamps to the last stage instead of returning undefined.
    expect(phaseForRound(MODES.duel, 40).label).toBe('狙击局');
    expect(phaseIndexForRound(MODES.duel, 1)).toBe(0);
    expect(phaseIndexForRound(MODES.duel, 9)).toBe(1);
    expect(phaseIndexForRound(MODES.duel, 24)).toBe(2);
  });

  it('whitelists what each duel stage may buy', () => {
    expect(phaseAllowsKind(MODES.duel, 3, 'pistol')).toBe(true);
    expect(phaseAllowsKind(MODES.duel, 3, 'rifle')).toBe(false);
    expect(phaseAllowsKind(MODES.duel, 3, 'sniper')).toBe(false);

    expect(phaseAllowsKind(MODES.duel, 12, 'pistol')).toBe(true);
    expect(phaseAllowsKind(MODES.duel, 12, 'rifle')).toBe(true);
    expect(phaseAllowsKind(MODES.duel, 12, 'sniper')).toBe(false);

    expect(phaseAllowsKind(MODES.duel, 30, 'sniper')).toBe(true);
    expect(phaseAllowsKind(MODES.duel, 30, 'rifle')).toBe(false);

    // Classic never restricts a kind.
    expect(phaseAllowsKind(MODES.classic, 20, 'sniper')).toBe(true);
    expect(phaseAllowsKind(MODES.classic, 20, 'mg')).toBe(true);
  });

  it('resolves a mode id defensively', () => {
    expect(modeById('duel').id).toBe('duel');
    expect(modeById('classic').id).toBe('classic');
    expect(modeById(undefined).id).toBe('classic');
    expect(modeById('nonsense').id).toBe('classic');
  });
});

describe('team composition', () => {
  it('still fields ten players in classic', () => {
    const { match } = makeMatch();
    expect(match.mode.id).toBe('classic');
    expect(match.players).toHaveLength(10);
    expect(match.players.filter((p) => p.isBot)).toHaveLength(9);
    expect(match.local.isBot).toBe(false);
    // The human is the only one on their side that is not a bot.
    expect(match.players.filter((p) => p.team === match.local.team)).toHaveLength(5);
  });

  it('keeps the older botsPerTeam knob working', () => {
    const { match } = makeMatch({ botsPerTeam: 0 });
    expect(match.players).toHaveLength(2);
    expect(match.players.filter((p) => p.team === match.local.team)).toHaveLength(1);
    expect(match.players.filter((p) => p.team !== match.local.team && p.isBot)).toHaveLength(1);
  });

  it('puts one human alone against three bots in an offline duel', () => {
    const { match } = makeMatch({ mode: 'duel' });
    expect(match.mode.id).toBe('duel');
    expect(match.players).toHaveLength(4);
    expect(match.players.filter((p) => p.team === match.local.team)).toHaveLength(1);
    expect(match.players.filter((p) => p.team !== match.local.team)).toHaveLength(3);
    expect(match.players.filter((p) => !p.isBot)).toHaveLength(1);
    expect(match.remoteHumans).toHaveLength(0);
    expect(match.players.every((p) => Number.isFinite(p.state.pos.x))).toBe(true);
  });

  it('puts one human on each side in a LAN duel and drives the peer from the wire', () => {
    const { match } = makeMatch({
      mode: 'duel',
      teams: LAN_DUEL_TEAMS,
      remoteNames: ['访客'],
    });
    expect(match.players).toHaveLength(2);
    expect(match.remoteHumans).toHaveLength(1);
    const peer = match.remoteHumans[0];
    expect(peer.state.name).toBe('访客');
    expect(peer.team).not.toBe(match.local.team);
    expect(match.players.filter((p) => p.isBot)).toHaveLength(0);

    // Without input the peer stands still.
    const before = { x: peer.state.pos.x, z: peer.state.pos.z };
    run(match, 0.4);
    expect(peer.state.pos.x).toBeCloseTo(before.x, 2);
    expect(peer.state.pos.z).toBeCloseTo(before.z, 2);

    // With input it moves, and the ground under it stays sane.
    match.setRemoteCommand(peer.id, walk(0, 0));
    run(match, 0.5, (tick) => {
      match.setRemoteCommand(peer.id, walk(tick, 0));
      return idle(tick);
    });
    const moved = Math.hypot(peer.state.pos.x - before.x, peer.state.pos.z - before.z);
    expect(moved).toBeGreaterThan(20);
    expect(Number.isFinite(peer.state.pos.y)).toBe(true);
  });

  it('remembers that it is a client mirror', () => {
    const { match } = makeMatch({ mode: 'duel', teams: LAN_DUEL_TEAMS, mirror: true });
    expect(match.mirror).toBe(true);
    expect(makeMatch().match.mirror).toBe(false);
  });
});

describe('duel rounds', () => {
  it('starts in the pistol stage with no bomb anywhere', () => {
    const { match } = makeMatch({ mode: 'duel' });
    expect(match.phase).toBe('freeze');
    expect(match.roundNumber).toBe(1);
    expect(match.phaseRule.label).toBe('手枪局');
    expect(match.timeLeft).toBe(MODES.duel.freezeTime);
    expect(match.players.every((p) => p.weaponIdForSlot('c4') === null)).toBe(true);
    expect(match.players.every((p) => p.state.hasBomb === false)).toBe(true);
    expect(match.allowedBuyKinds()).toEqual(['pistol']);
  });

  it('still hands the C4 out in classic', () => {
    const { match } = makeMatch();
    expect(match.players.some((p) => p.weaponIdForSlot('c4') === 'c4')).toBe(true);
  });

  it('prices the duel out of the economy and gates the buy menu by stage', () => {
    const { match } = makeMatch({ mode: 'duel' });
    expect(match.moneyOf(match.local.id)).toBe(MODES.duel.startMoney);
    standInBuyZone(match);
    expect(match.canBuy(match.local)).toBe(true);

    // A pistol in a pistol round: fine. A rifle: phase-locked.
    expect(match.buy(match.local.id, 'deagle')).toEqual({ ok: true, price: expect.any(Number) });
    expect(match.buy(match.local.id, 'ak47')).toEqual({ ok: false, reason: 'phase-locked' });
    // Armour is always fair game, a defuse kit is meaningless without bombs.
    expect(match.buy(match.local.id, 'kevlar')).toEqual({ ok: true, price: expect.any(Number) });
    expect(match.buy(match.local.id, 'defusekit')).toEqual({ ok: false, reason: 'phase-locked' });
  });

  it('escalates the free gun as the stages turn over', () => {
    const { match } = makeMatch({ mode: 'duel' });
    const local = match.local;
    const side = local.team === 'T' ? 'T' : 'CT';

    expect(local.weaponIdForSlot('primary')).toBeNull();
    expect(local.weaponIdForSlot('secondary')).toBe(MODES.duel.pistols[side]);

    // Rounds 1..8 are pistols; round 9 opens the rifle stage with a free rifle.
    advanceRounds(match, 8);
    expect(match.roundNumber).toBe(9);
    expect(match.phaseRule.label).toBe('步枪局');
    const rifle = MODES.duel.phases[1].starter![side];
    expect(local.weaponIdForSlot('primary')).toBe(rifle);
    const rifleDef = weaponById(rifle)!;
    const rifleState = match.combat.getWeaponState(local.id, rifle, rifleDef);
    expect(rifleState.ammo).toBe(rifleDef.magazine);
    expect(rifleState.reserve).toBe(rifleDef.reserve);
    // Sidearm survives the whole match.
    expect(local.weaponIdForSlot('secondary')).toBe(MODES.duel.pistols[side]);

    // Round 24 is the sniper stage, but 17 wins would already have ended the
    // duel, so the human throws every rifle round to get there: 8 wins, 15
    // losses, nobody at 17, round 24 opens the AWP stage.
    loseRounds(match, 15);
    expect(match.matchOver).toBe(false);
    expect(match.roundNumber).toBe(24);
    expect(match.phaseRule.label).toBe('狙击局');
    const sniper = MODES.duel.phases[2].starter![side];
    expect(local.weaponIdForSlot('primary')).toBe(sniper);
    expect(match.allowedBuyKinds()).toEqual(['pistol', 'sniper']);
  });

  it('ends the duel at 17 round wins, not at 33 rounds', () => {
    const { match } = makeMatch({ mode: 'duel' });
    const team = match.local.team;
    advanceRounds(match, 17);
    expect(match.matchOver).toBe(true);
    expect(match.winner).toBe(team);
    expect(team === 'T' ? match.scoreT : match.scoreCT).toBe(17);
    expect(team === 'T' ? match.scoreCT : match.scoreT).toBe(0);
    expect(match.roundNumber).toBe(17);
    // The lone human really did the killing through the combat system.
    expect(match.statsOf(match.local.id).kills).toBeGreaterThanOrEqual(17);
  });

  it('plays the duel without a clock favouring the defenders', () => {
    const { match } = makeMatch({ mode: 'duel' });
    // One human against three bots: on a timeout, more bodies standing wins, so
    // the far side takes it. (Classic would hand it to CT no matter what.)
    match.phase = 'live';
    match.timeLeft = TICK_DT;
    const reasons: string[] = [];
    match.bus.on('roundEnd', (e) => reasons.push(e.reason));
    match.tick(idle(0), TICK_DT);
    expect(match.phase).toBe('over');
    expect(reasons).toEqual(['time']);
    const far = match.local.team === 'T' ? 'CT' : 'T';
    expect(far === 'T' ? match.scoreT : match.scoreCT).toBe(1);
  });

  it('still hands a classic timeout to CT', () => {
    const { match } = makeMatch({ botsPerTeam: 0 });
    match.phase = 'live';
    match.timeLeft = TICK_DT;
    match.tick(idle(0), TICK_DT);
    expect(match.phase).toBe('over');
    expect(match.scoreCT).toBe(1);
    expect(match.scoreT).toBe(0);
  });

  it('keeps every body finite and the human on one side for a whole duel round', () => {
    const { match } = makeMatch({ mode: 'duel' });
    const team = match.local.team;
    run(match, 6, (tick) => walk(tick, 0));
    expect(match.players.every((p) => Number.isFinite(p.state.pos.y))).toBe(true);
    expect(match.local.team).toBe(team);
    // The bots got moving: the arena's nav mesh reaches them.
    const far = match.players.filter((p) => p.team !== team);
    expect(far.every((p) => p.state.vel.x !== 0 || p.state.vel.z !== 0 || !p.state.alive)).toBe(true);
  });
});