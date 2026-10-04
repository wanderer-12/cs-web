// =============================================================================
// core/events.ts — typed synchronous event bus.
// The simulation emits; UI, audio and VFX subscribe. No event ever mutates state.
// =============================================================================

import type { GameEventMap, GameEventName } from './types';

type Handler<K extends GameEventName> = (payload: GameEventMap[K]) => void;

export class EventBus {
  private handlers = new Map<GameEventName, Set<(p: never) => void>>();

  on<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    let set = this.handlers.get(name);
    if (!set) {
      set = new Set();
      this.handlers.set(name, set);
    }
    set.add(fn as (p: never) => void);
    return () => set!.delete(fn as (p: never) => void);
  }

  once<K extends GameEventName>(name: K, fn: Handler<K>): () => void {
    const off = this.on(name, (p) => {
      off();
      fn(p);
    });
    return off;
  }

  emit<K extends GameEventName>(name: K, payload: GameEventMap[K]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const fn of set) (fn as unknown as Handler<K>)(payload);
  }

  clear(): void {
    this.handlers.clear();
  }
}

/** Process-wide bus. Systems are constructed with this instance. */
export const bus = new EventBus();
