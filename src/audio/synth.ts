// =============================================================================
// audio/synth.ts — procedural Web Audio synthesis. ZERO external assets.
//
// Two layers live here on purpose:
//
//   1. A hand-rolled DSP core (seeded noise, one-pole filters, a Chamberlin
//      state-variable band-pass, sine sweeps) that writes straight into a
//      Float32Array. It never touches the real Web Audio graph, so it also runs
//      under Node/vitest against a stub context.
//   2. Every generator is a thin wrapper that first calls a *pure parameter*
//      function (`gunshotEnvelope`, `footstepParams`, ...) and only then renders.
//      The parameter functions take an `Rng` and return plain data, which is what
//      the unit tests assert on — reproducibility is provable without a browser.
//
// Nothing here allocates an AudioContext: the module is import-safe anywhere.
// =============================================================================

import { Rng } from '../core/rng';
import type { SurfaceMaterial, WeaponDef } from '../core/types';

/** The only slice of the Web Audio API these generators need. */
export interface BufferLike {
  getChannelData(channel: number): Float32Array;
}

/** A context that can allocate (and report the rate of) an audio buffer. */
export interface RenderContext {
  readonly sampleRate: number;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): BufferLike;
}

// ---------------------------------------------------------------------------
// Spatialisation constants, exported so AudioEngine and the tests agree.
// The map is authored in CS units (1 u ~= 1.9 cm, ~52.5 u per metre), so the
// distances below are CS units, not metres.
// ---------------------------------------------------------------------------

/** ~3.8 m: inside this radius a source is at full volume. */
export const REF_DISTANCE = 200;
/** Beyond this a source stops getting quieter (EQ'd out long before). */
export const MAX_DISTANCE = 8000;
/** Inverse distance model exponent-ish factor; 1.0 matches CS' source falloff. */
export const ROLLOFF_FACTOR = 1;
/** Lowest air-absorption cutoff we ever apply (heavily muffled far shot). */
export const MIN_AIR_CUTOFF = 420;
/** Cutoff at the reference distance (i.e. effectively "no filtering"). */
export const MAX_AIR_CUTOFF = 20000;

const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Small numeric helpers
// ---------------------------------------------------------------------------

const clampNum = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Exponential decay over `decay` seconds: 1 at t=0, ~0.002 at t=decay. */
const expDecay = (t: number, decay: number): number => Math.exp((-6.2 * t) / Math.max(decay, 1e-4));

/** Attack ramp, exponential curve: 0 at t=0, 1 at t=attack. Never returns 0. */
const attackRamp = (t: number, attack: number): number =>
  attack <= 1e-5 ? 1 : 1 - Math.exp((-4.6 * t) / attack);

/** One-pole low-pass; coefficient cached because we run it per sample. */
class OnePole {
  private a = 0;
  private z = 0;

  constructor(cutoffHz: number, sampleRate: number) {
    this.setCutoff(cutoffHz, sampleRate);
  }

  setCutoff(cutoffHz: number, sampleRate: number): void {
    const nyq = sampleRate * 0.5;
    const f = clampNum(cutoffHz, 1, nyq * 0.98);
    // Bilinear-ish one-pole: no tan() needed at the cutoffs we use (<10 kHz).
    this.a = clampNum(1 - Math.exp((-TAU * f) / sampleRate), 0, 0.999999);
  }

  process(x: number): number {
    this.z += this.a * (x - this.z);
    return this.z;
  }
}

/**
 * White noise with a small amount of integration so it does not sound like
 * pure digital hash. `tilt` in (0,1]: low = darker, 1 = brighter.
 */
function white(rng: Rng, tilt = 1): number {
  const w = rng.float() * 2 - 1;
  return tilt >= 1 ? w : w * tilt + w * w * w * (1 - tilt);
}

/**
 * Band-pass noise burst: run white noise through a one-pole low-pass at the
 * upper edge and subtract a second one-pole at the lower edge. The difference
 * of two one-poles is a stable, resonant-free band-pass with a gentle slope —
 * exactly what a moving air column / generic impact needs, and it cannot blow
 * up the way a naive hand-written biquad can.
 */
function bandNoise(
  out: Float32Array,
  sampleRate: number,
  start: number,
  duration: number,
  centerHz: number,
  bandHz: number,
  decay: number,
  gain: number,
  rng: Rng,
  tilt = 1,
): void {
  if (gain <= 1e-5 || duration <= 1e-5) return;
  const total = out.length;
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(total - startSample, Math.ceil(duration * sampleRate));
  if (len <= 0) return;
  const lo = new OnePole(Math.max(40, centerHz - bandHz * 0.5), sampleRate);
  const hi = new OnePole(Math.max(60, centerHz + bandHz * 0.5), sampleRate);
  for (let i = 0; i < len; i++) {
    const n = white(rng, tilt);
    const band = hi.process(n) - lo.process(n);
    out[startSample + i] += band * gain * expDecay(i / sampleRate, decay) * 3.4;
  }
}

/** State-variable band-pass; used for the metallic resonances (stable by design). */
function svBand(
  out: Float32Array,
  sampleRate: number,
  start: number,
  duration: number,
  centerHz: number,
  q: number,
  gain: number,
  rng: Rng,
  sweepTo = 0,
): void {
  if (gain <= 1e-5 || duration <= 1e-5) return;
  const total = out.length;
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(total - startSample, Math.ceil(duration * sampleRate));
  if (len <= 0) return;
  const qq = clampNum(q, 0.5, 40);
  const f0 = clampNum(centerHz, 20, sampleRate * 0.45);
  const f1 = sweepTo > 0 ? clampNum(sweepTo, 20, sampleRate * 0.45) : f0;
  // Explicit Euler SVF on a unit-amplitude band output: |H| ~= 1 at the centre.
  const k = 1 / qq;
  let low = 0;
  let band = 0;
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const f = f0 + (f1 - f0) * t;
    const fNorm = clampNum((TAU * f) / sampleRate, 1e-4, 0.9);
    const high = white(rng) - low - k * band;
    band += fNorm * high;
    low += fNorm * band;
    out[startSample + i] += band * gain * expDecay(i / sampleRate, duration * 0.55);
  }
}

/** Sine with an exponential frequency sweep (glide from `from` to `to`). */
function sineSweep(
  out: Float32Array,
  sampleRate: number,
  start: number,
  duration: number,
  fromHz: number,
  toHz: number,
  decay: number,
  gain: number,
  phase0 = 0,
): void {
  if (gain <= 1e-5 || duration <= 1e-5) return;
  const total = out.length;
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(total - startSample, Math.ceil(duration * sampleRate));
  if (len <= 0) return;
  const decayRate = 6.2 / Math.max(decay, 1e-4);
  const glide = Math.log(clampNum(toHz, 1, 20000) / clampNum(fromHz, 1, 20000));
  let phase = phase0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    const f = fromHz * Math.exp((glide * i) / len);
    phase += (TAU * f) / sampleRate;
    out[startSample + i] += Math.sin(phase) * gain * Math.exp(-decayRate * t) * attackRamp(t, 0.0006);
  }
}

/** Fixed-frequency sine with exponential decay; `attack` shapes clicks. */
function sineTone(
  out: Float32Array,
  sampleRate: number,
  start: number,
  duration: number,
  freqHz: number,
  decay: number,
  gain: number,
  phase0 = 0,
  attack = 0.001,
): void {
  if (gain <= 1e-5 || duration <= 1e-5) return;
  const total = out.length;
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(total - startSample, Math.ceil(duration * sampleRate));
  if (len <= 0) return;
  const decayRate = 6.2 / Math.max(decay, 1e-4);
  const step = (TAU * clampNum(freqHz, 1, sampleRate * 0.45)) / sampleRate;
  let phase = phase0;
  for (let i = 0; i < len; i++) {
    const t = i / sampleRate;
    phase += step;
    out[startSample + i] += Math.sin(phase) * gain * Math.exp(-decayRate * t) * attackRamp(t, attack);
  }
}

/**
 * Rising-envelope noise (splashes, whooshes): the amplitude *rises* to a peak
 * at `peakAt` of the duration before falling, which is what makes water read as
 * a splash rather than a click.
 */
function noiseSwell(
  out: Float32Array,
  sampleRate: number,
  start: number,
  duration: number,
  cutoffHz: number,
  gain: number,
  rng: Rng,
  peakAt = 0.35,
  tilt = 1,
): void {
  if (gain <= 1e-5 || duration <= 1e-5) return;
  const total = out.length;
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(total - startSample, Math.ceil(duration * sampleRate));
  if (len <= 0) return;
  const lp = new OnePole(cutoffHz, sampleRate);
  const pk = clampNum(peakAt, 0.05, 0.95);
  for (let i = 0; i < len; i++) {
    const t = i / len;
    const env = t < pk ? Math.pow(t / pk, 0.7) : Math.exp((-6.2 * (t - pk)) / (1 - pk));
    out[startSample + i] += lp.process(white(rng, tilt)) * gain * env * 2.2;
  }
}

/** Deterministic sample quantisation of a mechanical click (dry-fire, shell tick). */
function clickTrain(
  out: Float32Array,
  sampleRate: number,
  start: number,
  decay: number,
  gain: number,
  rng: Rng,
): void {
  const startSample = Math.max(0, Math.floor(start * sampleRate));
  const len = Math.min(out.length - startSample, Math.ceil(decay * 2.5 * sampleRate));
  if (len <= 0) return;
  const lp = new OnePole(5200, sampleRate);
  // Sample-and-hold on the noise source: a tiny bit of quantisation gets us the
  // "plastic against metal" edge without needing a sample library.
  let held = 0;
  for (let i = 0; i < len; i++) {
    if (i % 5 === 0) held = white(rng);
    out[startSample + i] += lp.process(held) * gain * expDecay(i / sampleRate, decay);
  }
}

/** Soft-clip to keep stacked layers inside [-1, 1] without hard clipping. */
function softClip(x: number): number {
  return Math.tanh(x);
}

/** Allocate a mono buffer and hand back both the AudioBuffer and its samples. */
function makeBuffer(ctx: RenderContext, duration: number): { buffer: BufferLike; data: Float32Array } {
  const length = Math.max(1, Math.ceil(duration * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  return { buffer, data: buffer.getChannelData(0) };
}

/** Normalise to a target peak only when we overshoot; never boosts quiet cues. */
function tamePeak(data: Float32Array, target = 0.99): void {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const a = Math.abs(data[i]);
    if (a > peak) peak = a;
  }
  if (peak <= 1e-6) return;
  const scale = peak > target ? target / peak : 1;
  for (let i = 0; i < data.length; i++) data[i] = softClip(data[i] * scale);
}

// =============================================================================
// Pure parameter computation. These are the unit-test surface: no buffers, no
// context, just numbers derived deterministically from an Rng.
// =============================================================================

/** One metallic resonance in a gunshot crack. */
export interface CrackPeak {
  /** Resonant frequency in Hz. */
  freq: number;
  /** Relative level before the overall crack gain. */
  gain: number;
  /** Exponential decay time in seconds. */
  decay: number;
}

/** Fully-resolved synthesis parameters for one gunshot. */
export interface GunshotParams {
  /** Duration of the whole shot in seconds. */
  duration: number;
  /** Noise-burst attack (seconds); a real muzzle blast is essentially instant. */
  attack: number;
  /** Noise-burst exponential decay (seconds). */
  decay: number;
  /** Band centre of the muzzle blast (Hz) — the weapon's `sound.body`. */
  body: number;
  /** Bandwidth of the muffled blast layer (Hz). */
  bodyBand: number;
  /** Bandwidth of the bright "bite" layer (Hz). */
  air: number;
  /** Overall level scaled from `sound.gain`. */
  bodyGain: number;
  /** Peak level of the thump layer. */
  thump: number;
  /** Thump start frequency (Hz). */
  thumpFrom: number;
  /** Thump end frequency (Hz). */
  thumpTo: number;
  /** Thump decay (seconds) — deliberately longer than the blast. */
  thumpDecay: number;
  /** Metallic resonances layered on top of the blast. */
  crack: CrackPeak[];
  /** Level of the resonant crack layer. */
  crackGain: number;
  /** Reflection tail level (0 when the weapon is silenced). */
  tail: number;
  /** Reflection tail decay (seconds). */
  tailDecay: number;
}

/** Pure percussion parameters for a footstep on a given surface. */
export interface FootstepParams {
  material: SurfaceMaterial;
  duration: number;
  attack: number;
  decay: number;
  /** Noise band centre (Hz) for the "scuff". */
  noiseFreq: number;
  /** Noise band width (Hz). */
  noiseBand: number;
  noiseGain: number;
  /** Panel/ground resonances. */
  peaks: CrackPeak[];
  toneGain: number;
  /** Level of the rising splash layer (water only). */
  swell: number;
  /** Overall level of the cue. */
  gain: number;
}

/** Pure parameters for a bullet impact on a static surface. */
export interface ImpactParams {
  material: SurfaceMaterial;
  duration: number;
  attack: number;
  decay: number;
  noiseFreq: number;
  noiseBand: number;
  noiseGain: number;
  peaks: CrackPeak[];
  toneGain: number;
  /** Low-frequency body level (dust puff / wood thud). */
  body: number;
  bodyFreq: number;
  /** Fragment/shard clicks for glass. */
  shards: number;
  gain: number;
}

function clampPeaks(peaks: CrackPeak[]): CrackPeak[] {
  return peaks.map((p) => ({
    freq: clampNum(p.freq, 60, 16000),
    gain: clampNum(p.gain, 0, 1),
    decay: clampNum(p.decay, 0.005, 1.2),
  }));
}

/**
 * Resolve a `WeaponDef['sound']` block into concrete synthesis parameters.
 *
 * Why randomise here: two AK shots with identical parameters sum coherently and
 * phase-align into an obviously fake "machine gun clone". Jittering the body
 * centre by a few percent and the decay by ~10% guarantees that repeated shots
 * never line up. Silenced weapons keep most of the tonal parts but lose the
 * tail, which is what makes a silencer read as "thwip" rather than "bang".
 */
export function gunshotEnvelope(sound: WeaponDef['sound'], rng: Rng): GunshotParams {
  const gain = clampNum(sound.gain, 0.01, 1);
  const duration = clampNum(sound.duration, 0.04, 1.5);
  const body = clampNum(sound.body, 60, 12000);
  const thumpAmt = clampNum(sound.thump, 0, 1);
  const silenced = gain < 0.3;
  return {
    duration,
    // Attack is a tiny fraction of the body: 0.12 ms reads as instantaneous,
    // while still keeping the first sample at zero (no DC step click).
    attack: clampNum(duration * 0.004, 0.00008, 0.002),
    decay: duration * rng.range(0.16, 0.23),
    // Clamp *after* the jitter: `body * 0.93` can dip below the 60 Hz floor, and
    // a sub-audible "body" would leave the blast with no low end at all.
    body: clampNum(body * rng.range(0.93, 1.08), 60, 12000),
    bodyBand: body * rng.range(0.7, 1.2),
    air: body * rng.range(2.4, 3.4),
    bodyGain: gain * rng.range(0.5, 0.6),
    thump: gain * thumpAmt * rng.range(0.5, 0.62),
    // The boom is a pitch *drop*: the volume of hot gas behind the bullet
    // expands, so the resonance falls from ~110 Hz to ~45 Hz over the shot.
    thumpFrom: 110 * rng.range(0.94, 1.08),
    thumpTo: 45 * rng.range(0.9, 1.1),
    thumpDecay: duration * rng.range(0.75, 0.95),
    crackGain: gain * (silenced ? 0.35 : 0.55) * rng.range(0.85, 1.15),
    crack: clampPeaks([
      { freq: body * rng.range(3.05, 3.35), gain: 1, decay: duration * rng.range(0.24, 0.32) },
      { freq: body * rng.range(5.4, 6.1), gain: 0.68, decay: duration * rng.range(0.15, 0.2) },
      { freq: body * rng.range(8.6, 9.9), gain: 0.44, decay: duration * rng.range(0.09, 0.13) },
      { freq: body * rng.range(12.5, 14.5), gain: 0.26, decay: duration * rng.range(0.05, 0.08) },
    ]),
    // The tail is the outdoor reflection of the blast; hostile-sounding and it
    // is exactly what a silencer removes.
    tail: silenced ? 0 : gain * rng.range(0.16, 0.22),
    tailDecay: duration * rng.range(1.15, 1.5),
  };
}

/**
 * Footstep parameters per surface. Timbre is the game's only "what am I walking
 * on" cue, so every material gets a distinct spectral centre and a distinct set
 * of panel resonances; `sandstone` deliberately shares concrete's profile (dust2
 * floors) and anything unknown falls back to concrete as well.
 */
export function footstepParams(material: SurfaceMaterial, rng: Rng): FootstepParams {
  const jitter = rng.range(0.9, 1.12);
  const pick = (m: FootstepParams['material']): FootstepParams => {
    switch (m) {
      case 'sand':
        return {
          material: 'sand',
          duration: 0.07,
          attack: 0.002,
          decay: 0.022,
          noiseFreq: 2600 * jitter,
          noiseBand: 3400,
          noiseGain: 0.3,
          peaks: [{ freq: 130, gain: 0.4, decay: 0.05 }],
          toneGain: 0.22,
          swell: 0,
          gain: 0.5,
        };
      case 'wood':
        return {
          material: 'wood',
          duration: 0.14,
          attack: 0.002,
          decay: 0.05,
          noiseFreq: 1800 * jitter,
          noiseBand: 2600,
          noiseGain: 0.3,
          // Wood is a panel: one strong ~200 Hz body plus two weak overtones.
          peaks: [
            { freq: 200 * rng.range(0.9, 1.1), gain: 0.85, decay: 0.07 },
            { freq: 640 * rng.range(0.92, 1.08), gain: 0.32, decay: 0.045 },
            { freq: 1450 * rng.range(0.9, 1.1), gain: 0.16, decay: 0.03 },
          ],
          toneGain: 0.7,
          swell: 0,
          gain: 0.62,
        };
      case 'metal':
        return {
          material: 'metal',
          duration: 0.18,
          attack: 0.001,
          decay: 0.06,
          noiseFreq: 4200 * jitter,
          noiseBand: 6000,
          noiseGain: 0.26,
          // Inharmonic ratios (not 2:3:4) are what make metal read as metal
          // instead of as a musical note.
          peaks: [
            { freq: 880 * rng.range(0.96, 1.05), gain: 1, decay: 0.09 },
            { freq: 2210 * rng.range(0.96, 1.05), gain: 0.5, decay: 0.05 },
          ],
          toneGain: 0.75,
          swell: 0,
          gain: 0.66,
        };
      case 'water':
        return {
          material: 'water',
          duration: 0.18,
          attack: 0.018,
          decay: 0.09,
          noiseFreq: 1500 * jitter,
          noiseBand: 3200,
          noiseGain: 0.34,
          peaks: [{ freq: 320 * rng.range(0.85, 1.25), gain: 0.35, decay: 0.05 }],
          toneGain: 0.3,
          swell: 0.6,
          gain: 0.6,
        };
      case 'glass':
        return {
          material: 'glass',
          duration: 0.15,
          attack: 0.001,
          decay: 0.05,
          noiseFreq: 6200 * jitter,
          noiseBand: 7000,
          noiseGain: 0.32,
          peaks: [
            { freq: 3400 * rng.range(0.95, 1.06), gain: 0.8, decay: 0.06 },
            { freq: 5200 * rng.range(0.95, 1.06), gain: 0.5, decay: 0.04 },
          ],
          toneGain: 0.6,
          swell: 0,
          gain: 0.58,
        };
      case 'flesh':
        return {
          material: 'flesh',
          duration: 0.1,
          attack: 0.004,
          decay: 0.04,
          noiseFreq: 500 * jitter,
          noiseBand: 900,
          noiseGain: 0.38,
          peaks: [{ freq: 150 * rng.range(0.9, 1.15), gain: 0.4, decay: 0.05 }],
          toneGain: 0.3,
          swell: 0,
          gain: 0.55,
        };
      default:
        // Bright, short click plus a small dead-room tail: the CS "hard floor".
        // 'sandstone' shares this profile (dust2 floors) and so does any unknown
        // material — a missing footstep sound is worse than a generic one.
        return {
          material: 'concrete',
          duration: 0.09,
          attack: 0.001,
          decay: 0.03,
          noiseFreq: 3600 * jitter,
          noiseBand: 5200,
          noiseGain: 0.34,
          peaks: [{ freq: 1800 * rng.range(0.92, 1.08), gain: 0.5, decay: 0.03 }],
          toneGain: 0.4,
          swell: 0,
          gain: 0.58,
        };
    }
  };
  const base = pick(material);
  // 60-180 ms window the design asks for; keep every profile inside it.
  base.duration = clampNum(base.duration * rng.range(0.9, 1.1), 0.06, 0.18);
  base.peaks = clampPeaks(base.peaks);
  return base;
}

/**
 * Bullet impact parameters. Impacts are *dry* by design (no tail): they are the
 * sound the shooter uses to confirm a hit, so they must be short enough to read
 * as discrete at 600 RPM.
 */
export function impactParams(material: SurfaceMaterial, rng: Rng): ImpactParams {
  const jitter = rng.range(0.92, 1.1);
  const pick = (m: SurfaceMaterial): ImpactParams => {
    switch (m) {
      case 'metal':
        return {
          material: 'metal',
          duration: 0.22,
          attack: 0.001,
          decay: 0.03,
          noiseFreq: 5200 * jitter,
          noiseBand: 7000,
          noiseGain: 0.3,
          peaks: [
            { freq: 1850 * rng.range(0.95, 1.06), gain: 1, decay: 0.12 },
            { freq: 3150 * rng.range(0.95, 1.06), gain: 0.55, decay: 0.08 },
            { freq: 1300 * rng.range(0.95, 1.06), gain: 0.3, decay: 0.16 },
          ],
          toneGain: 0.5,
          body: 0.2,
          bodyFreq: 220,
          shards: 0,
          gain: 0.62,
        };
      case 'wood':
        return {
          material: 'wood',
          duration: 0.14,
          attack: 0.001,
          decay: 0.028,
          noiseFreq: 2200 * jitter,
          noiseBand: 3200,
          noiseGain: 0.3,
          peaks: [
            { freq: 320 * rng.range(0.9, 1.1), gain: 0.85, decay: 0.05 },
            { freq: 900 * rng.range(0.9, 1.1), gain: 0.3, decay: 0.03 },
          ],
          toneGain: 0.45,
          body: 0.45,
          bodyFreq: 150,
          shards: 0.25,
          gain: 0.6,
        };
      case 'glass':
        return {
          material: 'glass',
          duration: 0.3,
          attack: 0.001,
          decay: 0.03,
          noiseFreq: 7000 * jitter,
          noiseBand: 8000,
          noiseGain: 0.34,
          peaks: [
            { freq: 3800 * rng.range(0.94, 1.07), gain: 0.9, decay: 0.09 },
            { freq: 5600 * rng.range(0.94, 1.07), gain: 0.55, decay: 0.06 },
            { freq: 2600 * rng.range(0.94, 1.07), gain: 0.35, decay: 0.12 },
          ],
          toneGain: 0.55,
          body: 0.1,
          bodyFreq: 400,
          shards: 0.9,
          gain: 0.6,
        };
      case 'sand':
      case 'water':
        return {
          material: m,
          duration: 0.1,
          attack: 0.002,
          decay: 0.035,
          noiseFreq: 900 * jitter,
          noiseBand: 1600,
          noiseGain: 0.4,
          peaks: [{ freq: 200 * rng.range(0.9, 1.1), gain: 0.25, decay: 0.05 }],
          toneGain: 0.2,
          body: 0.3,
          bodyFreq: 130,
          shards: 0,
          gain: 0.5,
        };
      case 'flesh':
        return {
          material: 'flesh',
          duration: 0.1,
          attack: 0.002,
          decay: 0.032,
          noiseFreq: 620 * jitter,
          noiseBand: 1100,
          noiseGain: 0.45,
          peaks: [{ freq: 180 * rng.range(0.9, 1.1), gain: 0.3, decay: 0.05 }],
          toneGain: 0.25,
          body: 0.35,
          bodyFreq: 120,
          shards: 0,
          gain: 0.55,
        };
      default:
        // Concrete / sandstone: a dust puff. Almost all noise, no ring at all.
        return {
          material: 'concrete',
          duration: 0.11,
          attack: 0.001,
          decay: 0.028,
          noiseFreq: 3000 * jitter,
          noiseBand: 4600,
          noiseGain: 0.42,
          peaks: [{ freq: 1100 * rng.range(0.85, 1.15), gain: 0.18, decay: 0.02 }],
          toneGain: 0.12,
          body: 0.28,
          bodyFreq: 160,
          shards: 0.12,
          gain: 0.55,
        };
    }
  };
  const p = pick(material);
  p.peaks = clampPeaks(p.peaks);
  return p;
}

/** Parameters for the short "thwack" of a bullet entering a body. */
export interface FleshParams {
  duration: number;
  attack: number;
  decay: number;
  noiseFreq: number;
  noiseBand: number;
  noiseGain: number;
  bodyFreq: number;
  bodyGain: number;
  gain: number;
}

export function fleshParams(rng: Rng): FleshParams {
  return {
    duration: 0.13,
    attack: 0.002,
    decay: 0.026,
    // Wet, low, no ring whatsoever: band-limited noise around 450 Hz plus a
    // short 120 Hz body is what reads as "hit a person" rather than "hit a wall".
    noiseFreq: 450 * rng.range(0.9, 1.15),
    noiseBand: 800,
    noiseGain: 0.5,
    bodyFreq: 120 * rng.range(0.9, 1.15),
    bodyGain: 0.4,
    gain: 0.52,
  };
}

/** Reload stage cue names. */
export type ReloadStage = 'magout' | 'magin' | 'bolt' | 'dryfire';

// =============================================================================
// Buffer-producing generators
// =============================================================================

/** Muzzle blast: body + air bite + thump sweep + resonance crack + open-air tail. */
export function renderGunshot(ctx: RenderContext, sound: WeaponDef['sound'], rng: Rng): BufferLike {
  const p = gunshotEnvelope(sound, rng);
  const { buffer, data } = makeBuffer(ctx, p.duration);
  const sr = ctx.sampleRate;
  // Layer 1+2: the blast itself. A tight band gives the "thud", a much wider
  // band up at ~3x the body gives the crack that carries across the map.
  bandNoise(data, sr, 0, p.duration * 0.55, p.body, p.bodyBand, p.decay, p.bodyGain, rng, 0.6);
  bandNoise(data, sr, 0, p.duration * 0.35, p.air, p.air * 1.4, p.decay * 0.55, p.bodyGain * 0.55, rng, 1);
  // Layer 3: low-frequency thump, swept down (barrel/gas resonance).
  sineSweep(data, sr, 0, p.thumpDecay, p.thumpFrom, p.thumpTo, p.thumpDecay, p.thump);
  // Layer 4: metallic resonances — the receiver/barrel ringing after the blast.
  for (const peak of p.crack) {
    svBand(data, sr, 0.0005, peak.decay * 2.2, peak.freq, 14, p.crackGain * peak.gain * 0.5, rng);
  }
  // Layer 5: decaying tail so the shot is not gated off at `duration`.
  if (p.tail > 0) {
    bandNoise(data, sr, p.duration * 0.08, p.duration, p.body * 0.8, p.bodyBand * 1.6, p.tailDecay, p.tail, rng, 0.5);
    bandNoise(data, sr, p.duration * 0.12, p.duration, 1200, 2400, p.tailDecay * 0.8, p.tail * 0.35, rng, 0.8);
  }
  tamePeak(data);
  return buffer;
}

/** One footstep on the given surface. */
export function renderFootstep(ctx: RenderContext, material: SurfaceMaterial, rng: Rng): BufferLike {
  const p = footstepParams(material, rng);
  const { buffer, data } = makeBuffer(ctx, p.duration);
  const sr = ctx.sampleRate;
  bandNoise(data, sr, 0, p.duration * 0.7, p.noiseFreq, p.noiseBand, p.decay, p.noiseGain, rng, 0.85);
  for (const peak of p.peaks) {
    sineTone(data, sr, 0, peak.decay * 2.2, peak.freq, peak.decay, p.toneGain * peak.gain * (p.material === 'metal' ? 0.55 : 0.45), 0, p.attack);
  }
  if (p.swell > 0) {
    noiseSwell(data, sr, 0, p.duration, p.noiseFreq * 1.4, p.swell * p.noiseGain, rng, 0.35, 0.8);
  }
  tamePeak(data);
  return buffer;
}

/** One bullet impact on a static surface. */
export function renderImpact(ctx: RenderContext, material: SurfaceMaterial, rng: Rng): BufferLike {
  const p = impactParams(material, rng);
  const { buffer, data } = makeBuffer(ctx, p.duration);
  const sr = ctx.sampleRate;
  bandNoise(data, sr, 0, p.duration * 0.6, p.noiseFreq, p.noiseBand, p.decay, p.noiseGain, rng, 1);
  for (const peak of p.peaks) {
    // Only metal/glass get a real ring; concrete/wood peaks are short enough to
    // act as resonances rather than pitched tones.
    svBand(data, sr, 0, peak.decay * 2.4, peak.freq, material === 'metal' || material === 'glass' ? 18 : 8, p.toneGain * peak.gain * 0.5, rng);
  }
  if (p.body > 0) sineSweep(data, sr, 0, p.decay * 3, p.bodyFreq, p.bodyFreq * 0.65, p.decay * 2.4, p.body * 0.5);
  if (p.shards > 0) {
    // Fragments land slightly late; that delay is what sells "shattered".
    for (let i = 0; i < 5; i++) {
      const at = rng.range(0.01, p.duration * 0.6);
      sineTone(data, sr, at, 0.03, rng.range(2600, 7200), 0.012, p.shards * rng.range(0.12, 0.3), 0, 0.001);
    }
  }
  tamePeak(data);
  return buffer;
}

/** Bullet entering a body (hit feedback for the shooter). */
export function renderFleshImpact(ctx: RenderContext, rng: Rng): BufferLike {
  const p = fleshParams(rng);
  const { buffer, data } = makeBuffer(ctx, p.duration);
  bandNoise(data, ctx.sampleRate, 0, p.duration, p.noiseFreq, p.noiseBand, p.decay, p.noiseGain, rng, 0.7);
  sineSweep(data, ctx.sampleRate, 0, p.decay * 3, p.bodyFreq, p.bodyFreq * 0.6, p.decay * 2.6, p.bodyGain);
  tamePeak(data);
  return buffer;
}

/** Crosshair hit marker: two very short, high, dry ticks. */
export function renderHitMarker(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.07);
  sineTone(data, ctx.sampleRate, 0, 0.05, 2650, 0.012, 0.5);
  sineTone(data, ctx.sampleRate, 0.012, 0.04, 3520, 0.01, 0.32);
  tamePeak(data);
  return buffer;
}

/** Headshot-kill confirmation: a bright ascending two-tone. */
export function renderHeadshotDing(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.28);
  const sr = ctx.sampleRate;
  sineTone(data, sr, 0, 0.26, 2350, 0.09, 0.42);
  sineTone(data, sr, 0.055, 0.22, 3520, 0.11, 0.38);
  // A shimmer partial keeps the second note from sounding like a pure sine.
  sineTone(data, sr, 0.055, 0.2, 5280, 0.14, 0.16);
  tamePeak(data);
  return buffer;
}

/** Mechanical reload clicks, one rendering per stage. */
export function renderReload(ctx: RenderContext, stage: ReloadStage, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.24);
  const sr = ctx.sampleRate;
  switch (stage) {
    case 'magout':
      // Magazine catch release (sharp) + magazine sliding out (low scrape).
      clickTrain(data, sr, 0.002, 0.016, 0.5, rng);
      bandNoise(data, sr, 0.012, 0.07, 900, 1500, 0.02, 0.22, rng, 0.5);
      break;
    case 'magin':
      // Magazine seats with a hollow clack and a short spring ring.
      clickTrain(data, sr, 0.004, 0.022, 0.55, rng);
      sineTone(data, sr, 0.004, 0.05, 260 * rng.range(0.95, 1.08), 0.03, 0.3, 0, 0.001);
      bandNoise(data, sr, 0.02, 0.06, 1600, 2200, 0.018, 0.2, rng, 0.9);
      break;
    case 'bolt':
      // Charging handle: two-stage ratchet then a hard stop.
      clickTrain(data, sr, 0.002, 0.012, 0.45, rng);
      clickTrain(data, sr, 0.022, 0.01, 0.5, rng);
      clickTrain(data, sr, 0.05, 0.018, 0.62, rng);
      svBand(data, sr, 0.05, 0.07, 2100, 12, 0.3, rng);
      break;
    case 'dryfire':
      // Empty chamber: a single dry, dead click — no resonance at all.
      clickTrain(data, sr, 0.002, 0.008, 0.42, rng);
      bandNoise(data, sr, 0.002, 0.02, 3000, 4000, 0.006, 0.24, rng, 1);
      break;
    default:
      break;
  }
  tamePeak(data, 0.85);
  return buffer;
}

/** A brass casing landing on the floor: tiny metal tick. */
export function renderShellDrop(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.1);
  const sr = ctx.sampleRate;
  svBand(data, sr, 0, 0.05, 4200 * rng.range(0.9, 1.15), 16, 0.4, rng);
  sineTone(data, sr, 0.004, 0.04, 2200 * rng.range(0.9, 1.15), 0.02, 0.16, 0, 0.0008);
  tamePeak(data, 0.6);
  return buffer;
}

/** A bullet passing close to the camera: short pitch-swept sawtooth. */
export function renderWhizz(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.13);
  const sr = ctx.sampleRate;
  // Air past a spinning bullet: the sweep goes up then the decay eats it, which
  // is why this is a *sweep* and not a fixed tone.
  sineSweep(data, sr, 0, 0.12, rng.range(620, 900), rng.range(1900, 2600), 0.055, 0.34);
  sineSweep(data, sr, 0, 0.12, rng.range(1240, 1800), rng.range(3800, 5200), 0.04, 0.12);
  bandNoise(data, sr, 0, 0.12, 2400, 3000, 0.05, 0.2, rng, 0.9);
  tamePeak(data);
  return buffer;
}

/**
 * A knife cutting air: a narrow band of noise sweeps upward (the swish of the
 * edge) over a wider, lower band (the air being pushed) and a soft click where
 * the swing starts. Deliberately short and quiet — steel moving nearby is
 * information for the player's ear, not a gunshot report.
 */
export function renderKnifeWhoosh(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.26);
  const sr = ctx.sampleRate;
  svBand(data, sr, 0, 0.2, rng.range(600, 780), 1.4, 0.5, rng, rng.range(2300, 2900));
  bandNoise(data, sr, 0, 0.24, 1000 * rng.range(0.92, 1.1), 900, 0.14, 0.3, rng, 0.7);
  sineTone(data, sr, 0, 0.05, 190 * rng.range(0.9, 1.15), 0.03, 0.06, 0, 0.002);
  tamePeak(data, 0.7);
  return buffer;
}

/** HE grenade: a deep initial blast plus a long debris tail. */
export function renderExplosion(ctx: RenderContext, rng: Rng): BufferLike {
  const duration = 2.4;
  const { buffer, data } = makeBuffer(ctx, duration);
  const sr = ctx.sampleRate;
  // The thump of an explosion is much lower and much longer than a gunshot:
  // 90 Hz -> 28 Hz over ~1.4 s of decaying sine.
  sineSweep(data, sr, 0, 1.4, 90 * rng.range(0.95, 1.08), 28, 1.1, 0.85);
  sineSweep(data, sr, 0, 0.5, 190, 70, 0.35, 0.4);
  bandNoise(data, sr, 0, 0.9, 220 * rng.range(0.9, 1.1), 520, 0.45, 0.6, rng, 0.4);
  bandNoise(data, sr, 0, 1.6, 2400, 5200, 0.5, 0.35, rng, 1);
  // Debris: discrete late ticks give the blast a space to happen in.
  for (let i = 0; i < 22; i++) {
    const at = rng.range(0.1, duration * 0.85);
    sineTone(data, sr, at, (duration - at) * 0.6, rng.range(700, 4800), 0.05, rng.range(0.03, 0.11), 0, 0.001);
  }
  tamePeak(data);
  return buffer;
}

/** Flashbang: a hard transient plus a narrow high band (the "crack" of light). */
export function renderFlashbangPop(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 1.2);
  const sr = ctx.sampleRate;
  bandNoise(data, sr, 0, 0.14, 1800 * rng.range(0.95, 1.06), 4200, 0.035, 0.8, rng, 1);
  sineSweep(data, sr, 0, 0.35, 130, 50, 0.22, 0.55);
  bandNoise(data, sr, 0, 0.9, 5200, 7000, 0.35, 0.28, rng, 1);
  tamePeak(data);
  return buffer;
}

/** High-pitched 4 kHz-ish ring left in the ears after a flash. */
export function renderFlashRing(ctx: RenderContext): BufferLike {
  const duration = 4;
  const { buffer, data } = makeBuffer(ctx, duration);
  const sr = ctx.sampleRate;
  // 4 kHz is the classic tinnitus band; two close partials beat against each
  // other so the ring sounds alive instead of like a test tone.
  sineTone(data, sr, 0, duration, 3980, duration * 0.42, 0.34, 0, 0.012);
  sineTone(data, sr, 0, duration, 4120, duration * 0.36, 0.22, 0, 0.012);
  bandNoise(data, sr, 0, duration * 0.5, 3800, 2600, duration * 0.3, 0.16, new Rng(7), 1);
  tamePeak(data, 0.75);
  return buffer;
}

/** C4 beeper: a short two-partial blip; `pitch` scales the tone with urgency. */
export function renderBombBeep(ctx: RenderContext, pitch: number): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.16);
  const sr = ctx.sampleRate;
  const f = clampNum(pitch, 300, 4000);
  sineTone(data, sr, 0, 0.11, f, 0.02, 0.42, 0, 0.002);
  sineTone(data, sr, 0, 0.1, f * 2.02, 0.016, 0.14, 0, 0.002);
  tamePeak(data, 0.7);
  return buffer;
}

/** Bomb plant: the keypad/arming sequence, rendered as one cue. */
export function renderBombPlant(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 1.1);
  const sr = ctx.sampleRate;
  // Five button presses, accelerating like a real arming sequence.
  let at = 0;
  for (let i = 0; i < 5; i++) {
    sineTone(data, sr, at, 0.06, 1400 + i * 80, 0.02, 0.3, 0, 0.001);
    clickTrain(data, sr, at, 0.008, 0.22, rng);
    at += 0.12 - i * 0.012;
  }
  // Final arm: a rising two-note confirmation.
  sineTone(data, sr, at + 0.05, 0.3, 880, 0.12, 0.3, 0, 0.004);
  sineTone(data, sr, at + 0.24, 0.4, 1320, 0.16, 0.28, 0, 0.004);
  tamePeak(data);
  return buffer;
}

/** Defuse kit tick: dry, mechanical, one per progress step. */
export function renderDefuseTick(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.09);
  clickTrain(data, ctx.sampleRate, 0.002, 0.01, 0.42, rng);
  sineTone(data, ctx.sampleRate, 0.002, 0.05, 900 * rng.range(0.94, 1.07), 0.02, 0.2, 0, 0.001);
  tamePeak(data, 0.7);
  return buffer;
}

/** Round-start sting: a short, tense two-note UI cue. */
export function renderRoundStart(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.7);
  const sr = ctx.sampleRate;
  sineTone(data, sr, 0, 0.4, 330, 0.16, 0.34, 0, 0.008);
  sineTone(data, sr, 0.14, 0.5, 495, 0.22, 0.3, 0, 0.008);
  sineTone(data, sr, 0.14, 0.5, 660, 0.24, 0.16, 0, 0.01);
  tamePeak(data, 0.8);
  return buffer;
}

/** Generic UI click. */
export function renderUIClick(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.05);
  sineTone(data, ctx.sampleRate, 0, 0.04, 1450, 0.011, 0.36, 0, 0.0008);
  tamePeak(data, 0.7);
  return buffer;
}

/** UI sting used when a round is won/lost. */
export function renderRoundEnd(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.6);
  const sr = ctx.sampleRate;
  sineTone(data, sr, 0, 0.35, 392, 0.14, 0.3, 0, 0.006);
  sineTone(data, sr, 0.1, 0.45, 294, 0.2, 0.3, 0, 0.006);
  tamePeak(data, 0.8);
  return buffer;
}

/** Body-fall / death thud plus gear rattle. */
export function renderDeathThud(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.5);
  const sr = ctx.sampleRate;
  sineSweep(data, sr, 0, 0.3, 150, 55, 0.16, 0.5);
  bandNoise(data, sr, 0, 0.35, 700, 1400, 0.12, 0.34, rng, 0.5);
  for (let i = 0; i < 4; i++) {
    sineTone(data, sr, rng.range(0.05, 0.32), 0.06, rng.range(1800, 4200), 0.02, 0.1, 0, 0.001);
  }
  tamePeak(data);
  return buffer;
}

/** Jump: a cloth/gear rustle, almost subliminal. */
export function renderJump(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.12);
  bandNoise(data, ctx.sampleRate, 0, 0.1, 800, 1400, 0.035, 0.22, rng, 0.6);
  tamePeak(data, 0.55);
  return buffer;
}

/** Landing thud; level scales with the landing speed. */
export function renderLand(ctx: RenderContext, strength: number, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.3);
  const sr = ctx.sampleRate;
  const s = clampNum(strength, 0, 1);
  sineSweep(data, sr, 0, 0.16 + s * 0.14, 120, 60, 0.09 + s * 0.08, 0.14 + s * 0.4);
  bandNoise(data, sr, 0, 0.18, 900, 1800, 0.055, 0.14 + s * 0.22, rng, 0.6);
  tamePeak(data);
  return buffer;
}

/** Buy/equip click: two-tone confirmation. */
export function renderBuy(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.16);
  sineTone(data, ctx.sampleRate, 0, 0.07, 880, 0.02, 0.28, 0, 0.002);
  sineTone(data, ctx.sampleRate, 0.06, 0.09, 1320, 0.028, 0.26, 0, 0.002);
  tamePeak(data, 0.7);
  return buffer;
}

/** Weapon draw/equip: cloth slide plus one mechanical click. */
export function renderDraw(ctx: RenderContext, rng: Rng): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.22);
  bandNoise(data, ctx.sampleRate, 0, 0.09, 1100, 1800, 0.025, 0.24, rng, 0.7);
  clickTrain(data, ctx.sampleRate, 0.08, 0.012, 0.32, rng);
  tamePeak(data, 0.7);
  return buffer;
}

/** Announcer cue: a neutral, short UI blip (text is shown by the HUD). */
export function renderAnnounce(ctx: RenderContext): BufferLike {
  const { buffer, data } = makeBuffer(ctx, 0.22);
  sineTone(data, ctx.sampleRate, 0, 0.16, 620, 0.05, 0.26, 0, 0.004);
  sineTone(data, ctx.sampleRate, 0.03, 0.14, 930, 0.05, 0.16, 0, 0.004);
  tamePeak(data, 0.7);
  return buffer;
}

/** Bomb explosion: near-identical to the HE blast but longer and deeper. */
export function renderBombExplode(ctx: RenderContext, rng: Rng): BufferLike {
  const duration = 3.2;
  const { buffer, data } = makeBuffer(ctx, duration);
  const sr = ctx.sampleRate;
  sineSweep(data, sr, 0, 2, 70, 24, 1.6, 0.9);
  sineSweep(data, sr, 0, 0.6, 160, 60, 0.4, 0.45);
  bandNoise(data, sr, 0, 1.2, 180, 460, 0.6, 0.65, rng, 0.35);
  bandNoise(data, sr, 0, 2.4, 2200, 5000, 0.8, 0.35, rng, 1);
  for (let i = 0; i < 30; i++) {
    const at = rng.range(0.15, duration * 0.9);
    sineTone(data, sr, at, (duration - at) * 0.7, rng.range(500, 4200), 0.06, rng.range(0.03, 0.12), 0, 0.001);
  }
  tamePeak(data);
  return buffer;
}

// ---------------------------------------------------------------------------
// Spatial curves — shared by AudioEngine so distance handling is testable here.
// ---------------------------------------------------------------------------

/**
 * Air absorption: linear in distance, logarithmic in frequency. A shot at 4000
 * units has lost almost everything above ~1 kHz, which is why distant gunfire
 * in CS sounds like a dull "pop" — and why implementing this and not just a
 * volume falloff is the difference between "far away" and "quiet".
 */
export function airCutoff(distance: number): number {
  const d = Math.max(0, distance);
  // Air absorption is only worth modelling past the reference radius: inside it
  // a source is at full volume, and filtering it would make near shots sound
  // "underwater" for no perceptual gain. Hence the flat shelf up to REF_DISTANCE
  // and an exponential roll-off spread over the remaining audible range.
  const span = MAX_DISTANCE - REF_DISTANCE;
  const norm = span > 0 ? Math.min(1, Math.max(0, d - REF_DISTANCE) / span) : 0;
  return clampNum(MAX_AIR_CUTOFF * Math.pow(MIN_AIR_CUTOFF / MAX_AIR_CUTOFF, norm), MIN_AIR_CUTOFF, MAX_AIR_CUTOFF);
}

/** Cutoff used when a wall sits between the listener and the source. */
export function occlusionCutoff(occlusion: number): number {
  const o = clampNum(occlusion, 0, 1);
  return 20000 + (650 - 20000) * o;
}

/** Gain multiplier used when a wall sits between the listener and the source. */
export function occlusionGain(occlusion: number): number {
  return 1 + (0.3 - 1) * clampNum(occlusion, 0, 1);
}

/** Inverse-distance model, matching PannerNode's `distanceModel: 'inverse'`. */
export function distanceGain(distance: number): number {
  const d = Math.max(0, distance);
  return REF_DISTANCE / (REF_DISTANCE + ROLLOFF_FACTOR * Math.max(0, d - REF_DISTANCE));
}
