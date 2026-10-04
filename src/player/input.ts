// =============================================================================
// player/input.ts — pointer lock, key binding and per-tick input sampling.
//
// Two details matter for feel:
//  1. Mouse input is accumulated from raw pointer-lock deltas and consumed once
//     per SIMULATION tick, not per animation frame. Otherwise sensitivity changes
//     with frame rate, which is the single most common "feels wrong" complaint.
//  2. Keyboard state is sampled at the tick boundary too, so a 2 ms tap of `+`
//     at 300 fps is not swallowed and a double-tap of `W` is not merged.
// =============================================================================

import { CAMERA } from '../core/config';
import { clamp } from '../core/math';
import type { InputButtons, InputCommand } from '../core/types';

export type ActionName = keyof InputButtons;

interface KeyBinding {
  code: string;
  alt?: string[];
}

/**
 * Keys the browser would otherwise act on while the game owns the keyboard:
 * `Tab` walks the focus ring (and then `Space` "clicks" whatever it landed on),
 * `Space` / arrows scroll, F1 opens help, `/` and `'` open quick-find (Firefox).
 *
 * `F5`, `F11` and `F12` are deliberately absent: they are reserved by the
 * browser and `preventDefault()` cannot stop them. Ctrl combinations are absent
 * for the same reason — which is why no action is bound to Ctrl any more
 * (`Ctrl+W` closes the tab and no page can veto it).
 */
export const BROWSER_HOGGED_KEYS: readonly string[] = [
  'Tab',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Slash',
  'Quote',
  'Backquote',
  'F1',
  'F2',
  'F3',
  'F4',
  'F6',
  'F7',
  'F8',
  'F9',
  'F10',
];

const HOGGED = new Set(BROWSER_HOGGED_KEYS);

/** True for `<input>`, `<textarea>`, `<select>` and contenteditable targets. */
export function isTextTarget(target: EventTarget | null): boolean {
  const element = target as (HTMLElement & { tagName?: string }) | null;
  if (!element) return false;
  const tag = element.tagName;
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    element.isContentEditable === true
  );
}

export const DEFAULT_BINDINGS: Record<ActionName, KeyBinding> = {
  forward: { code: 'KeyW', alt: ['ArrowUp'] },
  back: { code: 'KeyS', alt: ['ArrowDown'] },
  left: { code: 'KeyA', alt: ['ArrowLeft'] },
  right: { code: 'KeyD', alt: ['ArrowRight'] },
  jump: { code: 'Space' },
  // Left Alt (as requested), with `C` kept as the alternate. Ctrl is still
  // unbound: in a browser `Ctrl+W` closes the tab, `Ctrl+D` bookmarks, `Ctrl+R`
  // reloads and no page can veto any of them, while crouch-walking means holding
  // the modifier down and hitting letter keys constantly. Alt has the same shape
  // of hazard (`Alt+Tab` switches windows and no page can stop it), so `C` stays
  // bound as the fallback that always works.
  crouch: { code: 'AltLeft', alt: ['KeyC'] },
  walk: { code: 'ShiftLeft', alt: ['ShiftRight'] },
  attack: { code: 'Mouse0' },
  attack2: { code: 'Mouse2' },
  reload: { code: 'KeyR' },
  use: { code: 'KeyE' },
  drop: { code: 'KeyG' },
  slot1: { code: 'Digit1' },
  slot2: { code: 'Digit2' },
  slot3: { code: 'Digit3' },
  slot4: { code: 'Digit4' },
  slot5: { code: 'Digit5' },
};

export interface PointerLockHost {
  requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
  exitPointerLock(): void;
}

export class InputSystem {
  /** Current view angles (radians). Mouse deltas are applied here. */
  yaw = 0;
  pitch = 0;
  sensitivity = 2.2;
  /** Multiplied on top when scoped (CS applies a per-weapon zoom sensitivity). */
  zoomSensitivityScale = 1;
  invertY = false;
  /** When true, the world keeps simulating but input is ignored (menus). */
  inputEnabled = true;

  readonly canvas: HTMLCanvasElement;
  locked = false;

  private readonly buttons: InputButtons = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    crouch: false,
    walk: false,
    attack: false,
    attack2: false,
    reload: false,
    use: false,
    drop: false,
    slot1: false,
    slot2: false,
    slot3: false,
    slot4: false,
    slot5: false,
  };

  private bindings: Record<ActionName, KeyBinding> = structuredClone(DEFAULT_BINDINGS);
  private readonly held = new Set<string>();
  private accumDX = 0;
  private accumDY = 0;
  private consumedDX = 0;
  private consumedDY = 0;
  private listeners: Array<() => void> = [];
  private readonly onLockChange?: (locked: boolean) => void;
  private readonly onKeyDown?: (code: string, event: KeyboardEvent) => boolean | void;
  private readonly onKeyUp?: (code: string, event: KeyboardEvent) => void;
  private readonly onMouseButton?: (button: number, down: boolean) => boolean | void;

  constructor(
    canvas: HTMLCanvasElement,
    hooks: {
      onLockChange?: (locked: boolean) => void;
      /** Return true to mark the key as consumed by the game (preventDefault). */
      onKeyDown?: (code: string, event: KeyboardEvent) => boolean | void;
      onKeyUp?: (code: string, event: KeyboardEvent) => void;
      /** Return true to mark the button as consumed. */
      onMouseButton?: (button: number, down: boolean) => boolean | void;
    } = {},
  ) {
    this.canvas = canvas;
    this.onLockChange = hooks.onLockChange;
    this.onKeyDown = hooks.onKeyDown;
    this.onKeyUp = hooks.onKeyUp;
    this.onMouseButton = hooks.onMouseButton;
    this.attach();
  }

  private attach(): void {
    const canvas = this.canvas;
    const doc = canvas.ownerDocument;

    const onPointerLockChange = () => {
      const locked = doc.pointerLockElement === canvas;
      if (locked === this.locked) return;
      this.locked = locked;
      if (!locked) {
        // Releasing the lock must not leave keys stuck down.
        this.held.clear();
        this.clearButtons();
      }
      this.onLockChange?.(locked);
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.locked) return;
      this.accumDX += e.movementX;
      this.accumDY += e.movementY;
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const consumed = this.onKeyDown?.(e.code, e) === true;
      // The game owns the keyboard: swallow the browser's own handling for every
      // key we listen to (and for the keys it would act on otherwise), including
      // auto-repeat — a held Space must not start scrolling the page.
      if (consumed || this.ownsKey(e)) e.preventDefault();
      if (e.repeat) return;
      this.held.add(e.code);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.held.delete(e.code);
      this.onKeyUp?.(e.code, e);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (!this.locked) return;
      this.held.add(`Mouse${e.button}`);
      const consumed = this.onMouseButton?.(e.button, true);
      if (consumed) e.preventDefault();
    };

    const onMouseUp = (e: MouseEvent) => {
      this.held.delete(`Mouse${e.button}`);
      this.onMouseButton?.(e.button, false);
    };

    const onContextMenu = (e: Event) => e.preventDefault();
    const onBlur = () => {
      this.held.clear();
      this.clearButtons();
    };

    doc.addEventListener('pointerlockchange', onPointerLockChange);
    doc.addEventListener('mousemove', onMouseMove);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    canvas.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    canvas.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);

    this.listeners = [
      () => doc.removeEventListener('pointerlockchange', onPointerLockChange),
      () => doc.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => canvas.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => canvas.removeEventListener('contextmenu', onContextMenu),
      () => window.removeEventListener('blur', onBlur),
    ];
  }

  dispose(): void {
    for (const off of this.listeners) off();
    this.listeners = [];
  }

  requestLock(): void {
    const host = this.canvas as unknown as PointerLockHost;
    try {
      const result = host.requestPointerLock({ unadjustedMovement: true });
      if (result && typeof (result as Promise<void>).catch === 'function') {
        // Chrome rejects unadjustedMovement on some platforms; retry vanilla.
        (result as Promise<void>).catch(() => {
          try {
            host.requestPointerLock();
          } catch {
            /* user gesture missing; the UI shows a click-to-play prompt */
          }
        });
      }
    } catch {
      /* ignore */
    }
  }

  releaseLock(): void {
    (this.canvas.ownerDocument as Document).exitPointerLock?.();
  }

  isHeld(action: ActionName): boolean {
    const b = this.bindings[action];
    if (this.held.has(b.code)) return true;
    if (b.alt) for (const c of b.alt) if (this.held.has(c)) return true;
    return false;
  }

  isHeldCode(code: string): boolean {
    return this.held.has(code);
  }

  /** True when `code` is bound to any action (primary or alternate). */
  isBound(code: string): boolean {
    for (const binding of Object.values(this.bindings)) {
      if (binding.code === code) return true;
      if (binding.alt?.includes(code)) return true;
    }
    return false;
  }

  /**
   * True when this keyboard event belongs to the game, so the browser's default
   * handling must be suppressed. Events aimed at a text field are never claimed,
   * so typing a player name still works.
   */
  private ownsKey(e: KeyboardEvent): boolean {
    if (isTextTarget(e.target)) return false;
    return HOGGED.has(e.code) || this.isBound(e.code);
  }

  private clearButtons(): void {
    for (const k of Object.keys(this.buttons) as ActionName[]) this.buttons[k] = false;
  }

  /** Raw mouse delta since the previous `sample()` call. */
  consumeMouseDelta(): { dx: number; dy: number } {
    const dx = this.accumDX;
    const dy = this.accumDY;
    this.accumDX = 0;
    this.accumDY = 0;
    return { dx, dy };
  }

  /**
   * Build the input command for one simulation tick. Applies the accumulated
   * mouse movement to the view angles at the tick boundary.
   */
  sample(tick: number): InputCommand {
    if (!this.inputEnabled) {
      for (const k of Object.keys(this.buttons) as ActionName[]) this.buttons[k] = false;
      return {
        tick,
        buttons: { ...this.buttons },
        yaw: this.yaw,
        pitch: this.pitch,
        mouseDX: 0,
        mouseDY: 0,
      };
    }

    for (const k of Object.keys(this.buttons) as ActionName[]) this.buttons[k] = this.isHeld(k);

    const { dx, dy } = this.consumeMouseDelta();
    this.consumedDX = dx;
    this.consumedDY = dy;

    // CS conversion: degrees per count = 0.022 * sensitivity, then to radians.
    const scale = (CAMERA.baseSensitivity * this.sensitivity * this.zoomSensitivityScale * Math.PI) / 180;
    this.yaw -= dx * scale;
    this.pitch += (this.invertY ? dy : -dy) * scale;

    // Keep yaw bounded so precision never degrades after long play sessions.
    if (this.yaw > Math.PI * 2 || this.yaw < -Math.PI * 2) {
      this.yaw = this.yaw % (Math.PI * 2);
    }
    this.pitch = clamp(this.pitch, -CAMERA.maxPitch, CAMERA.maxPitch);

    return {
      tick,
      buttons: { ...this.buttons },
      yaw: this.yaw,
      pitch: this.pitch,
      mouseDX: this.consumedDX,
      mouseDY: this.consumedDY,
    };
  }

  /** True when a key event arrived for a bound gameplay action. */
  isGameplayCode(code: string): boolean {
    for (const k of Object.keys(this.bindings) as ActionName[]) {
      const b = this.bindings[k];
      if (b.code === code) return true;
      if (b.alt?.includes(code)) return true;
    }
    return false;
  }

  setBinding(action: ActionName, code: string): void {
    this.bindings[action] = { code };
  }

  getBindings(): Record<ActionName, KeyBinding> {
    return this.bindings;
  }

  resetBindings(): void {
    this.bindings = structuredClone(DEFAULT_BINDINGS);
  }
}
