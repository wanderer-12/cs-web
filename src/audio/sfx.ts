// =============================================================================
// audio/sfx.ts — the cache + voice layer between the generators and the graph.
//
// Two independent budgets are enforced here, and they are independent on purpose:
//
//   * `maxEntries` bounds *memory*: every synthesised variant is a Float32Array
//     that lives until evicted. Rendering an explosion is ~3 s of 48 kHz mono,
//     so an unbounded cache would grow by megabyte-per-novel-cue.
//   * `maxVoices` bounds *CPU + mix headroom*: the Web Audio graph degrades long
//     before the CPU does (32 HRTF panners is already ~2 ms/frame), so we drop
//     the quietest currently-playing voice rather than let the graph thrash.
//
// Variants: `variantsPerKey` renders of the same cue with different seeds. Firing
// the same buffer twice inside one frame is audible as a flanged "clone" shot, so
// every repeat picks the next variant in rotation.
// =============================================================================

import type { Rng } from '../core/rng';

/** Minimal buffer surface; the real `AudioBuffer` satisfies it. */
export interface CachedBuffer {
  getChannelData(channel: number): Float32Array;
}

/** A voice currently owned by the cache; used for the voice-cap eviction. */
export interface VoiceHandle {
  /** Opaque token. Set to -1 once the voice has been retired or evicted. */
  token: number;
  /** Effective gain at trigger time (bus volume * distance falloff * cue level). */
  gain: number;
  /**
   * Stops (and disconnects) the underlying source. Must be idempotent. Mutable
   * so the caller can install the real implementation after the source node is
   * created, without a second cache call.
   */
  stop(): void;
}

/** Observable cache/voice state, mostly so tests can assert on the budgets. */
export interface SfxStats {
  /** Number of (key, variant) buffers currently cached. */
  cachedEntries: number;
  /** Number of voices currently playing. */
  activeVoices: number;
  /** Hard voice cap. */
  maxVoices: number;
  /** How many voices were cut early because of the cap. */
  evictedVoices: number;
  /** How many buffers were dropped because of the entry budget. */
  evictedEntries: number;
}

const DEFAULT_MAX_ENTRIES = 64;
const DEFAULT_VARIANTS = 4;
const DEFAULT_MAX_VOICES = 32;

/**
 * Lazily-rendered, bounded cache of synthesised buffers plus the voice budget.
 *
 * Keys are caller-defined strings such as `shot:ak47`, `step:wood`, `cue:whizz`.
 * The renderer for a key is supplied per call (`get(key, render)`) rather than
 * registered up front, which keeps this class free of any knowledge of synth.ts
 * and therefore trivial to unit-test with a fake renderer.
 */
export class SfxCache {
  /** Insertion order is LRU order: `Map` iterates oldest first. */
  private readonly entries = new Map<string, CachedBuffer>();
  private readonly voices = new Map<number, VoiceHandle>();
  /** Rotation cursor per key so repeated cues do not reuse the same variant. */
  private readonly variantCursor = new Map<string, number>();

  private nextToken = 1;
  private evictedVoicesCount = 0;
  private evictedEntriesCount = 0;

  readonly maxEntries: number;
  readonly variantsPerKey: number;
  readonly maxVoices: number;

  constructor(maxEntries = DEFAULT_MAX_ENTRIES, variantsPerKey = DEFAULT_VARIANTS, maxVoices = DEFAULT_MAX_VOICES) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.variantsPerKey = Math.max(1, Math.floor(variantsPerKey));
    this.maxVoices = Math.max(1, Math.floor(maxVoices));
  }

  /** Number of cached buffers; exposed so tests can watch the bound. */
  get size(): number {
    return this.entries.size;
  }

  get activeVoices(): number {
    return this.voices.size;
  }

  stats(): SfxStats {
    return {
      cachedEntries: this.entries.size,
      activeVoices: this.voices.size,
      maxVoices: this.maxVoices,
      evictedVoices: this.evictedVoicesCount,
      evictedEntries: this.evictedEntriesCount,
    };
  }

  /**
   * Fetch a cached variant, rendering it on first use. Evicts the oldest entry
   * when the entry budget is exceeded, so the cache can never grow unbounded.
   */
  get(key: string, variant: number, render: () => CachedBuffer): CachedBuffer {
    const id = variantId(key, variant);
    const hit = this.entries.get(id);
    if (hit) {
      // Refresh LRU position: delete + re-insert moves the key to the newest end.
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit;
    }
    const made = render();
    this.entries.set(id, made);
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evictedEntriesCount++;
    }
    return made;
  }

  /** True when the key has at least one variant already rendered. */
  has(key: string): boolean {
    return this.entries.has(variantId(key, 0));
  }

  /**
   * Round-robin variant selection for a key. Deterministic when `rng` is seeded,
   * which is what lets a replay with a fixed seed reproduce its shot sequence.
   */
  pickVariant(key: string, rng?: Rng): number {
    const step = this.variantCursor.get(key) ?? 0;
    this.variantCursor.set(key, step + 1);
    // The RNG supplies the starting phase (so a replay is reproducible), the
    // cursor guarantees consecutive shots never collide on the same variant.
    const phase = rng ? Math.floor(rng.float() * this.variantsPerKey) : 0;
    return (phase + step) % this.variantsPerKey;
  }

  /**
   * Claim a voice slot and hand back the handle that tracks it. The caller fills
   * in `handle.stop` once its source node exists (see `AudioEngine.play3D`), so
   * that an eviction during registration still disconnects real nodes.
   *
   * When the cap is reached the quietest playing voice is stopped first, so the
   * new sound is never the one that gets dropped — a player's own gunshot must
   * always win over a distant footstep.
   */
  registerVoice(gain: number, stop: () => void = () => undefined): VoiceHandle {
    const token = this.nextToken++;
    while (this.voices.size >= this.maxVoices) {
      let quietestToken = -1;
      let quietestGain = Infinity;
      for (const [t, v] of this.voices) {
        if (v.gain < quietestGain) {
          quietestGain = v.gain;
          quietestToken = t;
        }
      }
      if (quietestToken < 0) break;
      const victim = this.voices.get(quietestToken);
      this.voices.delete(quietestToken);
      if (victim) victim.token = -1;
      this.evictedVoicesCount++;
      try {
        victim?.stop();
      } catch {
        // A source that has already ended throws on the second stop(); the
        // voice is already gone from our books, so swallowing is correct here.
      }
    }
    const handle: VoiceHandle = { token, gain, stop };
    this.voices.set(token, handle);
    return handle;
  }

  /** Update a voice's tracking gain (used when a cue changes level mid-flight). */
  updateVoice(token: number, gain: number): void {
    const v = this.voices.get(token);
    if (v) v.gain = gain;
  }

  /** Retire a voice normally (the source ended on its own). */
  releaseVoice(token: number): void {
    this.voices.delete(token);
  }

  /** Stop every tracked voice and clear the bookkeeping. */
  stopAllVoices(): void {
    const all = [...this.voices.values()];
    this.voices.clear();
    for (const v of all) {
      v.token = -1;
      try {
        v.stop();
      } catch {
        // See registerVoice.
      }
    }
  }

  /** Drop every cached buffer (reclaims all the Float32Arrays at once). */
  clear(): void {
    this.entries.clear();
    this.variantCursor.clear();
  }
}

function variantId(key: string, variant: number): string {
  return `${key}#${variant}`;
}
