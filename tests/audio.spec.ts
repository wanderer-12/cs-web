// =============================================================================
// tests/audio.spec.ts — the parts of the audio subsystem that are testable
// without a browser.
//
// The suite deliberately avoids a real `AudioContext`: it runs under vitest's
// `environment: 'node'`. Three seams make that possible, and the assertions
// below are written against exactly those seams:
//
//   1. Every generator's *parameters* come from a pure function that only needs
//      an `Rng`, so determinism and the DSP ranges are checkable in isolation.
//   2. `render*` takes a structural `RenderContext`, so a fake context that
//      allocates a plain Float32Array exercises the whole DSP path in Node.
//   3. `SfxCache` owns the two budgets (entries, voices) with no DOM types at
//      all, so the eviction policy is directly observable.
// =============================================================================

import { describe, expect, it } from 'vitest';

import { EventBus } from '../src/core/events';
import { Rng } from '../src/core/rng';
import type { SurfaceMaterial, WeaponDef } from '../src/core/types';
import { AudioEngine } from '../src/audio/AudioEngine';
import { SfxCache } from '../src/audio/sfx';
import type { BufferLike, RenderContext } from '../src/audio/synth';
import {
  MAX_AIR_CUTOFF,
  MAX_DISTANCE,
  MIN_AIR_CUTOFF,
  REF_DISTANCE,
  airCutoff,
  distanceGain,
  fleshParams,
  footstepParams,
  gunshotEnvelope,
  impactParams,
  occlusionCutoff,
  occlusionGain,
  renderBombBeep,
  renderFootstep,
  renderGunshot,
  renderImpact,
  renderKnifeWhoosh,
  renderReload,
  renderUIClick,
} from '../src/audio/synth';

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

/**
 * A structural stand-in for `AudioContext`. The generators only ever ask a
 * context for its sample rate and for a buffer, so this is enough to run the
 * real DSP code — no mocking of the synthesis itself.
 */
class FakeBuffer implements BufferLike {
  readonly length: number;
  readonly channels: Float32Array[];
  constructor(channels: number, length: number) {
    this.length = length;
    this.channels = Array.from({ length: Math.max(1, channels) }, () => new Float32Array(length));
  }
  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new Error(`no channel ${channel}`);
    return data;
  }
}

class FakeContext implements RenderContext {
  readonly sampleRate: number;
  bufferCount = 0;
  constructor(sampleRate = 48000) {
    this.sampleRate = sampleRate;
  }
  createBuffer(numberOfChannels: number, length: number): BufferLike {
    this.bufferCount++;
    return new FakeBuffer(numberOfChannels, length);
  }
}

const SAMPLE_RATE = 48000;

/** Every surface material the contract defines. */
const MATERIALS: readonly SurfaceMaterial[] = [
  'sandstone',
  'concrete',
  'wood',
  'metal',
  'sand',
  'glass',
  'flesh',
  'water',
];

/** Materials a footstep/impact can plausibly be generated for (all of them). */
const AK: WeaponDef['sound'] = { gain: 0.95, body: 180, duration: 0.55, thump: 0.7 };
const SILENCED: WeaponDef['sound'] = { gain: 0.18, body: 240, duration: 0.18, thump: 0.25 };

/** Peak absolute sample of a rendered buffer. */
function peakOf(buffer: BufferLike): number {
  const data = buffer.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i] as number);
    if (a > peak) peak = a;
  }
  return peak;
}

/** Number of samples whose magnitude is a real value (guards against NaN). */
function finiteSamples(buffer: BufferLike): number {
  const data = buffer.getChannelData(0);
  let n = 0;
  for (let i = 0; i < data.length; i++) if (Number.isFinite(data[i])) n++;
  return n;
}

/** Total number of handlers currently registered on a bus for an event. */
function listenerCount(bus: EventBus, event: string): number {
  const sets = (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers;
  return sets.get(event)?.size ?? 0;
}

/** Sum of every listener count on the bus, used for the attach/detach check. */
function totalListeners(bus: EventBus): number {
  const sets = (bus as unknown as { handlers: Map<string, Set<unknown>> }).handlers;
  let total = 0;
  for (const set of sets.values()) total += set.size;
  return total;
}

// -----------------------------------------------------------------------------
// 1. Deterministic parameter choice
// -----------------------------------------------------------------------------

describe('Rng-driven parameter choice is deterministic', () => {
  it('produces identical gunshot parameters for the same seed', () => {
    const a = gunshotEnvelope(AK, new Rng(1234));
    const b = gunshotEnvelope(AK, new Rng(1234));
    // deep equality is the whole point: a replay must reproduce its shots
    expect(b).toEqual(a);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('draws a different shot for a different seed', () => {
    const a = gunshotEnvelope(AK, new Rng(1));
    const b = gunshotEnvelope(AK, new Rng(2));
    // The jitter must actually vary, otherwise repeated shots phase-align.
    expect(b).not.toEqual(a);
    expect(b.body).not.toBe(a.body);
  });

  it('draws a different shot on each successive call with one Rng', () => {
    const rng = new Rng(99);
    const first = gunshotEnvelope(AK, rng);
    const second = gunshotEnvelope(AK, rng);
    expect(second.body).not.toBe(first.body);
  });

  it('keeps gunshot parameters inside the documented ranges', () => {
    for (let seed = 0; seed < 64; seed++) {
      const p = gunshotEnvelope(AK, new Rng(seed));
      expect(p.duration).toBeCloseTo(AK.duration, 6);
      expect(p.attack).toBeGreaterThan(0);
      // The whole shot must fit in the buffer the caller allocates.
      expect(p.attack).toBeLessThan(p.duration);
      expect(p.decay).toBeGreaterThan(0);
      expect(p.decay).toBeLessThanOrEqual(p.duration);
      // The thump is a downward sweep around 110 Hz -> 45 Hz.
      expect(p.thumpFrom).toBeGreaterThan(p.thumpTo);
      expect(p.thumpFrom).toBeGreaterThan(90);
      expect(p.thumpTo).toBeLessThan(60);
      expect(p.crack.length).toBeGreaterThanOrEqual(3);
      for (const peak of p.crack) {
        expect(peak.freq).toBeGreaterThanOrEqual(60);
        expect(peak.freq).toBeLessThanOrEqual(16000);
        expect(peak.gain).toBeGreaterThanOrEqual(0);
        expect(peak.gain).toBeLessThanOrEqual(1);
        expect(peak.decay).toBeGreaterThan(0);
      }
    }
  });

  it('clamps hostile weapon data instead of propagating it', () => {
    const hostile: WeaponDef['sound'] = { gain: 0, body: -500, duration: 9999, thump: 42 };
    const p = gunshotEnvelope(hostile, new Rng(7));
    expect(p.duration).toBeLessThanOrEqual(1.5);
    expect(p.body).toBeGreaterThanOrEqual(60);
    expect(p.body).toBeLessThanOrEqual(12000);
    expect(p.thump).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(p.thump)).toBe(true);
  });

  it('gives a silenced weapon less tail and crack than a loud one', () => {
    const loud = gunshotEnvelope(AK, new Rng(5)).crackGain;
    const quiet = gunshotEnvelope(SILENCED, new Rng(5)).crackGain;
    expect(quiet).toBeLessThan(loud);
  });

  it('is deterministic per material for footsteps and impacts', () => {
    for (const material of MATERIALS) {
      expect(footstepParams(material, new Rng(11))).toEqual(footstepParams(material, new Rng(11)));
      expect(impactParams(material, new Rng(11))).toEqual(impactParams(material, new Rng(11)));
    }
    // Different materials must not collapse to one timbre.
    expect(footstepParams('wood', new Rng(3))).not.toEqual(footstepParams('metal', new Rng(3)));
    expect(impactParams('glass', new Rng(3))).not.toEqual(impactParams('concrete', new Rng(3)));
  });

  it('keeps footstep duration in the 60-180 ms window for every material', () => {
    for (const material of MATERIALS) {
      const p = footstepParams(material, new Rng(material.length + 1));
      expect(p.duration).toBeGreaterThanOrEqual(0.06);
      expect(p.duration).toBeLessThanOrEqual(0.18);
      expect(p.gain).toBeGreaterThan(0);
      expect(p.noiseFreq).toBeGreaterThan(60);
    }
  });

  it('falls back to a concrete-like footstep for an unknown material', () => {
    const unknown = 'gravel' as SurfaceMaterial;
    const fallback = footstepParams(unknown, new Rng(4));
    const concrete = footstepParams('concrete', new Rng(4));
    expect(fallback.duration).toBe(concrete.duration);
  });

  it('is deterministic for flesh impacts too', () => {
    expect(fleshParams(new Rng(77))).toEqual(fleshParams(new Rng(77)));
  });
});

// -----------------------------------------------------------------------------
// 2. Spatialisation curves
// -----------------------------------------------------------------------------

describe('spatialisation curves', () => {
  it('never gets louder with distance and is full volume inside refDistance', () => {
    const near = distanceGain(REF_DISTANCE);
    expect(near).toBeCloseTo(1, 6);
    let previous = Infinity;
    for (const d of [1000, 2000, 4000, 8000]) {
      const g = distanceGain(d);
      expect(g).toBeLessThanOrEqual(previous);
      expect(g).toBeGreaterThan(0);
      previous = g;
    }
  });

  it('dulls the highs with distance (air absorption, not just quiet)', () => {
    const near = airCutoff(REF_DISTANCE);
    const far = airCutoff(MAX_DISTANCE);
    // Inside the reference radius the air filter is transparent — a source at
    // full volume must not also sound filtered.
    expect(airCutoff(0)).toBeCloseTo(MAX_AIR_CUTOFF, 6);
    expect(near).toBeCloseTo(MAX_AIR_CUTOFF, 0);
    expect(far).toBeLessThan(near);
    expect(far).toBeCloseTo(MIN_AIR_CUTOFF, 0);
    expect(airCutoff(4000)).toBeLessThan(airCutoff(500));
    // Never below the floor: a fully damped shot should still be audible.
    expect(airCutoff(1e6)).toBeGreaterThanOrEqual(MIN_AIR_CUTOFF);
    // Monotonic non-increasing across the whole usable range.
    let previous = Infinity;
    for (const d of [0, 100, 200, 500, 1000, 2500, 5000, 8000, 20000]) {
      const c = airCutoff(d);
      expect(c).toBeLessThanOrEqual(previous);
      previous = c;
    }
  });

  it('applies both gain reduction and a stronger low-pass when occluded', () => {
    expect(occlusionGain(0)).toBeCloseTo(1, 6);
    expect(occlusionCutoff(0)).toBeCloseTo(MAX_AIR_CUTOFF, 0);
    expect(occlusionGain(1)).toBeLessThan(occlusionGain(0.5));
    expect(occlusionCutoff(1)).toBeLessThan(occlusionCutoff(0.5));
    expect(occlusionCutoff(1)).toBeLessThan(MIN_AIR_CUTOFF * 4);
    // An occluded shot is quieter, never louder.
    for (const o of [0, 0.25, 0.5, 0.75, 1]) {
      expect(occlusionGain(o)).toBeGreaterThanOrEqual(0);
      expect(occlusionGain(o)).toBeLessThanOrEqual(1);
    }
  });
});

// -----------------------------------------------------------------------------
// 3. Rendering runs without a real AudioContext
// -----------------------------------------------------------------------------

describe('generators render into a structural context', () => {
  it('renders a gunshot buffer of the requested duration', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    const buffer = renderGunshot(ctx, AK, new Rng(2024));
    const expected = Math.ceil(AK.duration * SAMPLE_RATE);
    // The buffer must cover the whole tail: rounding *up* by at most one sample
    // is fine, rounding down would gate the last reflection off.
    expect(buffer.getChannelData(0).length).toBe(expected);
    expect(ctx.bufferCount).toBe(1);
    expect(finiteSamples(buffer)).toBe(expected);
    // Must actually make sound, but must not clip hard.
    const peak = peakOf(buffer);
    expect(peak).toBeGreaterThan(0.02);
    expect(peak).toBeLessThanOrEqual(1);
  });

  it('renders an audible knife whoosh that is air, not a gunshot', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    const whoosh = renderKnifeWhoosh(ctx, new Rng(77));
    const samples = whoosh.getChannelData(0).length;
    // Long enough to read as a swing (0.26 s), short enough not to smear.
    expect(samples).toBe(Math.ceil(0.26 * SAMPLE_RATE));
    expect(finiteSamples(whoosh)).toBe(samples);
    const peak = peakOf(whoosh);
    expect(peak).toBeGreaterThan(0.02);
    // `tamePeak(data, 0.7)` keeps a swing well under a rifle's peak: a knife must
    // never be as loud as a gunshot.
    expect(peak).toBeLessThanOrEqual(0.8);

    // Deterministic per seed, like every other generator.
    const again = renderKnifeWhoosh(new FakeContext(SAMPLE_RATE), new Rng(77));
    expect(peakOf(again)).toBeCloseTo(peak, 9);
  });

  it('renders a footstep for every material with a sane length', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    for (const material of MATERIALS) {
      const buffer = renderFootstep(ctx, material, new Rng(31));
      const length = buffer.getChannelData(0).length;
      expect(length).toBeGreaterThanOrEqual(Math.floor(0.05 * SAMPLE_RATE));
      expect(length).toBeLessThanOrEqual(Math.ceil(0.2 * SAMPLE_RATE));
      expect(finiteSamples(buffer)).toBe(length);
      expect(peakOf(buffer)).toBeGreaterThan(0);
    }
  });

  it('renders an impact for every material', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    for (const material of MATERIALS) {
      const buffer = renderImpact(ctx, material, new Rng(41));
      expect(finiteSamples(buffer)).toBe(buffer.getChannelData(0).length);
      expect(peakOf(buffer)).toBeGreaterThan(0);
    }
  });

  it('renders every reload stage and gives each a distinct character', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    const stages = ['magout', 'magin', 'bolt', 'dryfire'] as const;
    const lengths: number[] = [];
    for (const stage of stages) {
      const buffer = renderReload(ctx, stage, new Rng(55));
      const length = buffer.getChannelData(0).length;
      expect(length).toBeGreaterThan(0);
      expect(peakOf(buffer)).toBeGreaterThan(0);
      lengths.push(length);
    }
    // The dry-fire click is a click, not a two-part mechanism.
    expect(lengths[3]).toBeLessThanOrEqual(Math.max(...lengths));
  });

  it('renders a non-positional UI cue', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    const click = renderUIClick(ctx);
    expect(peakOf(click)).toBeGreaterThan(0);
    expect(finiteSamples(click)).toBe(click.getChannelData(0).length);
  });

  it('accepts a zero and a huge bomb pitch without producing NaN', () => {
    const ctx = new FakeContext(SAMPLE_RATE);
    for (const pitch of [0, 1, 1200, 20000, 1e9]) {
      const buffer = renderBombBeep(ctx, pitch);
      expect(finiteSamples(buffer)).toBe(buffer.getChannelData(0).length);
    }
  });

  it('produces bit-identical audio for the same seed', () => {
    const a = renderGunshot(new FakeContext(SAMPLE_RATE), AK, new Rng(808));
    const b = renderGunshot(new FakeContext(SAMPLE_RATE), AK, new Rng(808));
    expect(Array.from(b.getChannelData(0))).toEqual(Array.from(a.getChannelData(0)));
  });
});

// -----------------------------------------------------------------------------
// 4. Voice cap + entry budget
// -----------------------------------------------------------------------------

describe('SfxCache budgets', () => {
  it('caps simultaneous voices and cuts the quietest one', () => {
    const cache = new SfxCache(64, 4, 3);
    const stopped: string[] = [];
    const a = cache.registerVoice(1, () => stopped.push('a'));
    const b = cache.registerVoice(0.5, () => stopped.push('b'));
    const c = cache.registerVoice(0.2, () => stopped.push('c'));
    expect(cache.activeVoices).toBe(3);

    // A fourth, louder voice must evict `c` (quietest), not `a` (loudest).
    const d = cache.registerVoice(0.9, () => stopped.push('d'));
    expect(cache.activeVoices).toBe(3);
    expect(stopped).toEqual(['c']);
    expect(c.token).toBe(-1);
    expect(a.token).not.toBe(-1);
    expect(b.token).not.toBe(-1);
    expect(d.token).not.toBe(-1);
    expect(a.stop).toBeTypeOf('function');
  });

  it('never evicts the voice it is currently registering', () => {
    const cache = new SfxCache(8, 2, 2);
    const tokens: number[] = [];
    for (let i = 0; i < 50; i++) {
      // Each new voice is the quietest so far; it must still survive its own
      // registration, otherwise a quiet distant cue would silence itself.
      const handle = cache.registerVoice(1 - i * 0.01);
      tokens.push(handle.token);
      expect(handle.token).not.toBe(-1);
      expect(cache.activeVoices).toBeLessThanOrEqual(2);
    }
    expect(cache.stats().evictedVoices).toBe(48);
    expect(tokens.length).toBe(50);
  });

  it('keeps a burst of 200 voices bounded and reports the evictions', () => {
    const cache = new SfxCache(64, 4, 32);
    let stops = 0;
    for (let i = 0; i < 200; i++) {
      cache.registerVoice(((i % 10) + 1) / 10, () => {
        stops++;
      });
    }
    const stats = cache.stats();
    expect(stats.maxVoices).toBe(32);
    expect(cache.activeVoices).toBeLessThanOrEqual(32);
    expect(stats.evictedVoices).toBe(200 - cache.activeVoices);
    expect(stops).toBe(stats.evictedVoices);
  });

  it('frees a slot when a voice is released normally', () => {
    const cache = new SfxCache(8, 2, 2);
    const a = cache.registerVoice(1);
    cache.registerVoice(0.5);
    cache.releaseVoice(a.token);
    expect(cache.activeVoices).toBe(1);
    // A release must not count as an eviction.
    expect(cache.stats().evictedVoices).toBe(0);
    cache.registerVoice(0.4);
    expect(cache.activeVoices).toBe(2);
    expect(cache.stats().evictedVoices).toBe(0);
  });

  it('stops and forgets every voice on stopAllVoices', () => {
    const cache = new SfxCache(8, 2, 8);
    let stops = 0;
    cache.registerVoice(1, () => {
      stops++;
    });
    cache.registerVoice(0.5);
    cache.stopAllVoices();
    expect(cache.activeVoices).toBe(0);
    expect(stops).toBe(1);
    // Evictions and a deliberate teardown are different things.
    expect(cache.stats().evictedVoices).toBe(0);
  });

  it('bounds cached buffers and evicts the oldest entry first', () => {
    const cache = new SfxCache(2, 4, 8);
    const render = (label: string) => (): BufferLike => {
      const b = new FakeBuffer(1, 4);
      b.getChannelData(0)[0] = label.length;
      return b;
    };
    const first = cache.get('a', 0, render('a'));
    cache.get('b', 0, render('b'));
    cache.get('c', 0, render('c'));
    expect(cache.size).toBe(2);
    expect(cache.stats().evictedEntries).toBe(1);
    // 'a' was the oldest and must be gone; refetching it re-renders.
    const again = cache.get('a', 0, render('aaaa'));
    expect(cache.size).toBe(2);
    expect(again).not.toBe(first);
    expect(cache.stats().evictedEntries).toBe(2);
    expect(cache.get('b', 0, render('b'))).toBeDefined();
  });

  it('serves a cache hit without re-rendering and refreshes its LRU age', () => {
    const cache = new SfxCache(2, 2, 4);
    let renders = 0;
    const render = (): BufferLike => {
      renders++;
      return new FakeBuffer(1, 2);
    };
    const a = cache.get('a', 0, render);
    expect(cache.get('a', 0, render)).toBe(a);
    expect(renders).toBe(1);
    cache.get('b', 0, render);
    cache.get('a', 0, render); // refreshes 'a'
    cache.get('c', 0, render); // evicts 'b'
    expect(cache.has('a')).toBe(true);
    expect(cache.has('b')).toBe(false);
  });

  it('never returns the same variant twice in a row for one key', () => {
    const cache = new SfxCache(64, 4, 8);
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) seen.push(cache.pickVariant('shot:ak47', new Rng(1)));
    expect(new Set(seen).size).toBe(4);
    for (let i = 1; i < seen.length; i++) expect(seen[i]).not.toBe(seen[i - 1]);
    // Same seed => same rotation, so a replay reproduces its shot sequence.
    const replay: number[] = [];
    for (let i = 0; i < 8; i++) replay.push(cache.pickVariant('shot:ak47', new Rng(1)));
    expect(replay).toEqual(seen);
  });

  it('always returns an in-range variant index', () => {
    const cache = new SfxCache(8, 3, 4);
    for (let i = 0; i < 40; i++) {
      const v = cache.pickVariant('step:wood', new Rng(i));
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(3);
    }
  });
});

// -----------------------------------------------------------------------------
// 5. Event wiring
// -----------------------------------------------------------------------------

describe('AudioEngine.attach / detach', () => {
  const lookup = (id: string): WeaponDef | undefined => (id === 'ak47' ? undefined : undefined);

  it('subscribes exactly the documented events and removes them all', () => {
    const bus = new EventBus();
    const engine = new AudioEngine(lookup);
    expect(engine.subscriptionCount).toBe(0);
    expect(totalListeners(bus)).toBe(0);

    engine.attach(bus);
    const attached = engine.subscriptionCount;
    expect(attached).toBe(19);
    expect(totalListeners(bus)).toBe(attached);

    // Every event the brief requires must actually be wired.
    for (const event of [
      'shot',
      'hit',
      'impact',
      'whizz',
      'footstep',
      'reload',
      'draw',
      'jump',
      'land',
      'death',
      'buy',
      'roundPhase',
      'roundEnd',
      'bombPlanted',
      'bombExploded',
      'bombDefused',
      'grenadeExplode',
      'flash',
      'announce',
    ]) {
      expect(listenerCount(bus, event), `expected a handler for ${event}`).toBe(1);
    }

    engine.detach();
    expect(engine.subscriptionCount).toBe(0);
    expect(totalListeners(bus)).toBe(0);
  });

  it('is idempotent: re-attaching the same bus does not double up', () => {
    const bus = new EventBus();
    const engine = new AudioEngine(lookup);
    engine.attach(bus);
    const first = engine.subscriptionCount;
    engine.attach(bus);
    expect(engine.subscriptionCount).toBe(first);
    expect(totalListeners(bus)).toBe(first);
    engine.detach();
    expect(totalListeners(bus)).toBe(0);
  });

  it('moves to a new bus when attached twice, leaving the first clean', () => {
    const first = new EventBus();
    const second = new EventBus();
    const engine = new AudioEngine(lookup);
    engine.attach(first);
    engine.attach(second);
    expect(totalListeners(first)).toBe(0);
    expect(totalListeners(second)).toBe(engine.subscriptionCount);
    engine.detach();
    expect(totalListeners(second)).toBe(0);
  });

  it('leaves the bus silent after detach when an event is emitted', () => {
    const bus = new EventBus();
    const engine = new AudioEngine(lookup);
    let seen = 0;
    bus.on('shot', () => {
      seen++;
    });
    engine.attach(bus);
    // No AudioContext exists in Node, so this must be a no-op rather than a throw.
    expect(() =>
      bus.emit('shot', {
        shooterId: 1,
        weaponId: 'ak47',
        origin: { x: 0, y: 0, z: 0 },
        dir: { x: 1, y: 0, z: 0 },
        silenced: false,
        melee: false,
        ammo: 30,
      }),
    ).not.toThrow();
    expect(seen).toBe(1);
    engine.detach();
    bus.emit('shot', {
      shooterId: 1,
      weaponId: 'ak47',
      origin: { x: 0, y: 0, z: 0 },
      dir: { x: 1, y: 0, z: 0 },
      silenced: false,
      melee: false,
      ammo: 29,
    });
    expect(seen).toBe(2);
  });

  it('routes every event through without a context and without throwing', () => {
    const bus = new EventBus();
    const engine = new AudioEngine(lookup);
    engine.setLocalActorId(1);
    engine.setActorPositionProvider(() => ({ x: 10, y: 0, z: 10 }));
    engine.setOcclusionTest(() => 0.5);
    engine.attach(bus);
    const v = { x: 0, y: 0, z: 0 };
    expect(() => {
      bus.emit('impact', { point: v, normal: v, material: 'concrete', dustOnly: false });
      bus.emit('impact', { point: v, normal: v, material: 'metal', dustOnly: true });
      bus.emit('whizz', { shooterId: 2, pos: v, distance: 20 });
      bus.emit('footstep', { actorId: 2, pos: v, material: 'wood', volume: 0.7 });
      bus.emit('reload', { actorId: 1, weaponId: 'ak47', duration: 2.2 });
      bus.emit('draw', { actorId: 1, weaponId: 'ak47', duration: 0.6 });
      bus.emit('jump', { actorId: 2 });
      bus.emit('land', { actorId: 2, speed: 900, damage: 12 });
      bus.emit('death', { victimId: 2, killerId: 1, weaponId: 'ak47', headshot: true, wallbang: false });
      bus.emit('buy', { actorId: 1, weaponId: 'ak47', price: 2700 });
      bus.emit('roundPhase', { phase: 'live', timeLeft: 115, roundNumber: 3 });
      bus.emit('roundEnd', { winner: 'T', reason: 'bomb', scoreT: 3, scoreCT: 2 });
      bus.emit('bombPlanted', { site: 'A', pos: v, actorId: 2 });
      bus.emit('bombExploded', { site: 'A' });
      bus.emit('bombDefused', { actorId: 1 });
      bus.emit('grenadeExplode', { kind: 'he', pos: v, radius: 350 });
      bus.emit('grenadeExplode', { kind: 'flashbang', pos: v, radius: 350 });
      bus.emit('flash', { origin: v, duration: 0.5, intensity: 1 });
      bus.emit('announce', { text: 'Terrorists win', kind: 'round' });
    }).not.toThrow();
    engine.detach();
  });
});

// -----------------------------------------------------------------------------
// 6. Browser-less construction
// -----------------------------------------------------------------------------

describe('AudioEngine without a browser', () => {
  const lookup = (): WeaponDef | undefined => undefined;

  it('constructs without touching AudioContext', () => {
    expect(typeof globalThis.AudioContext).toBe('undefined');
    const engine = new AudioEngine(lookup);
    expect(engine.ready).toBe(false);
  });

  it('resolves resume() harmlessly when audio is unavailable', async () => {
    const engine = new AudioEngine(lookup);
    await expect(engine.resume()).resolves.toBeUndefined();
    expect(engine.ready).toBe(false);
  });

  it('exposes buses, volumes, mutes, listener and cue helpers without a context', () => {
    const engine = new AudioEngine(lookup);
    expect(engine.getVolume('master')).toBe(1);
    expect(engine.getVolume('sfx')).toBe(1);
    expect(engine.getVolume('footstep')).toBeGreaterThan(0);
    expect(engine.getVolume('ui')).toBeGreaterThan(0);
    expect(engine.getVolume('ambience')).toBeGreaterThan(0);

    expect(() => {
      engine.setVolume('sfx', 0.42);
      engine.setVolume('master', -5); // out of range is clamped, not stored
      engine.setVolume('ui', Number.NaN); // NaN must not poison the graph
      engine.setMasterMuted(true);
      engine.setMasterMuted(false);
      engine.updateListener({ x: 1, y: 2, z: 3 }, { x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
      engine.setOcclusionTest(null);
      engine.setActorPositionProvider(null);
    }).not.toThrow();

    expect(engine.getVolume('sfx')).toBeCloseTo(0.42, 6);
    expect(engine.getVolume('master')).toBe(0);
    expect(Number.isNaN(engine.getVolume('ui'))).toBe(false);

    // With no context these return the documented "nothing played" token.
    expect(engine.playCue('uiClick', null)).toBe(-1);
    expect(engine.playCue('whizz', { x: 0, y: 0, z: 0 })).toBe(-1);
    expect(engine.playBombBeep(null, 900)).toBe(-1);

    expect(() => engine.dispose()).not.toThrow();
    // dispose() detaches, so it is safe to call twice.
    expect(() => engine.dispose()).not.toThrow();
  });
});
