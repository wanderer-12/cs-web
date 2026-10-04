// =============================================================================
// tests/input.spec.ts — key bindings and browser-key capture.
//
// The bug these tests pin down: the game ran inside a browser page, bound crouch
// to Ctrl and never called preventDefault, so crouch-walking pressed Ctrl+W /
// Ctrl+D / Ctrl+R — closing the tab, bookmarking and reloading mid-round.
// =============================================================================

import { describe, expect, it } from 'vitest';
import {
  BROWSER_HOGGED_KEYS,
  DEFAULT_BINDINGS,
  InputSystem,
  isTextTarget,
} from '../src/player/input';

type Handler = (event: unknown) => void;

interface KeyEventLike {
  code: string;
  repeat: boolean;
  target?: unknown;
  prevented: boolean;
  preventDefault(): void;
}

function keyEvent(code: string, extra: { repeat?: boolean; target?: unknown } = {}): KeyEventLike {
  const event: KeyEventLike = {
    code,
    repeat: extra.repeat ?? false,
    prevented: false,
    preventDefault() {
      event.prevented = true;
    },
  };
  if (extra.target !== undefined) event.target = extra.target;
  return event;
}

/** Minimal DOM stand-in: the InputSystem only needs add/removeEventListener. */
function makeHost(): {
  canvas: unknown;
  window: unknown;
  fire: (type: string, event: unknown) => void;
} {
  const listeners = new Map<string, Set<Handler>>();
  const add = (type: string, handler: Handler): void => {
    let set = listeners.get(type);
    if (!set) {
      set = new Set();
      listeners.set(type, set);
    }
    set.add(handler);
  };
  const remove = (type: string, handler: Handler): void => {
    listeners.get(type)?.delete(handler);
  };
  const document = { addEventListener: add, removeEventListener: remove, pointerLockElement: null };
  const canvas = { ownerDocument: document, addEventListener: add, removeEventListener: remove };
  const window = { addEventListener: add, removeEventListener: remove };
  return {
    canvas,
    window,
    fire: (type: string, event: unknown) => {
      for (const handler of listeners.get(type) ?? []) handler(event);
    },
  };
}

/** Run `body` with a fake `window` installed, then restore the global. */
function withHost(body: (host: ReturnType<typeof makeHost>) => void): void {
  const host = makeHost();
  const global = globalThis as { window?: unknown };
  const previous = global.window;
  global.window = host.window;
  try {
    body(host);
  } finally {
    if (previous === undefined) delete global.window;
    else global.window = previous;
  }
}

describe('input bindings', () => {
  it('never binds an action to a key the browser reserves', () => {
    for (const [action, binding] of Object.entries(DEFAULT_BINDINGS)) {
      const codes = [binding.code, ...(binding.alt ?? [])];
      for (const code of codes) {
        // Ctrl+W closes the tab, Ctrl+D bookmarks, Ctrl+R reloads: no page can
        // veto those, so no action may live on Ctrl (or Meta).
        expect(code.startsWith('Control'), `${action} must not use ${code}`).toBe(false);
        expect(code.startsWith('Meta'), `${action} must not use ${code}`).toBe(false);
        expect(code, `${action} must not use ${code}`).not.toBe('F5');
        expect(code, `${action} must not use ${code}`).not.toBe('F11');
        expect(code, `${action} must not use ${code}`).not.toBe('F12');
      }
    }
  });

  it('crouches on C, walks on Shift and reloads on R', () => {
    expect(DEFAULT_BINDINGS.crouch.code).toBe('KeyC');
    expect(DEFAULT_BINDINGS.crouch.alt ?? []).toHaveLength(0);
    expect(DEFAULT_BINDINGS.walk.code).toBe('ShiftLeft');
    expect(DEFAULT_BINDINGS.reload.code).toBe('KeyR');
    expect(DEFAULT_BINDINGS.jump.code).toBe('Space');
  });

  it('lists the keys the browser would steal', () => {
    for (const code of ['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'F1']) {
      expect(BROWSER_HOGGED_KEYS).toContain(code);
    }
    // preventDefault cannot stop these, so they are not claimed as game keys.
    expect(BROWSER_HOGGED_KEYS).not.toContain('F5');
    expect(BROWSER_HOGGED_KEYS).not.toContain('F11');
    expect(BROWSER_HOGGED_KEYS).not.toContain('F12');
    // Escape must stay free: the HUD turns it into the pause menu.
    expect(BROWSER_HOGGED_KEYS).not.toContain('Escape');
  });

  it('recognises a text field', () => {
    expect(isTextTarget(null)).toBe(false);
    expect(isTextTarget({ tagName: 'DIV' } as unknown as EventTarget)).toBe(false);
    expect(isTextTarget({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget({ tagName: 'SELECT' } as unknown as EventTarget)).toBe(true);
    expect(isTextTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
  });
});

describe('input keyboard capture', () => {
  it('claims game keys and browser keys, but not F5', () => {
    withHost((host) => {
      const input = new InputSystem(host.canvas as HTMLCanvasElement);
      try {
        for (const code of ['Space', 'Tab', 'ArrowDown', 'KeyW', 'KeyC', 'KeyR']) {
          const event = keyEvent(code);
          host.fire('keydown', event);
          expect(event.prevented, `${code} must be captured`).toBe(true);
        }
        // Auto-repeat keeps being captured: a held jump must not scroll the page.
        const repeated = keyEvent('Space', { repeat: true });
        host.fire('keydown', repeated);
        expect(repeated.prevented).toBe(true);
        // Reserved keys stay with the browser.
        const refresh = keyEvent('F5');
        host.fire('keydown', refresh);
        expect(refresh.prevented).toBe(false);
      } finally {
        input.dispose();
      }
    });
  });

  it('leaves typing in a text field alone', () => {
    withHost((host) => {
      const input = new InputSystem(host.canvas as HTMLCanvasElement);
      try {
        const typing = keyEvent('Space', { target: { tagName: 'INPUT' } });
        host.fire('keydown', typing);
        expect(typing.prevented).toBe(false);

        const walking = keyEvent('KeyW', { target: { tagName: 'INPUT' } });
        host.fire('keydown', walking);
        expect(walking.prevented).toBe(false);
        expect(input.isHeld('forward')).toBe(true); // held state is still tracked

        input.dispose();
        const after = keyEvent('Space');
        host.fire('keydown', after);
        expect(after.prevented).toBe(false); // no listeners left
      } finally {
        input.dispose();
      }
    });
  });

  it('crouches with C and ignores Ctrl', () => {
    withHost((host) => {
      const input = new InputSystem(host.canvas as HTMLCanvasElement);
      try {
        host.fire('keydown', keyEvent('ControlLeft'));
        expect(input.isHeld('crouch')).toBe(false);

        host.fire('keydown', keyEvent('KeyC'));
        expect(input.isHeld('crouch')).toBe(true);
        host.fire('keyup', keyEvent('KeyC'));
        expect(input.isHeld('crouch')).toBe(false);

        host.fire('keydown', keyEvent('KeyW'));
        host.fire('keydown', keyEvent('ArrowUp'));
        expect(input.isHeld('forward')).toBe(true);
        host.fire('keyup', keyEvent('KeyW'));
        expect(input.isHeld('forward')).toBe(true); // the alt binding still holds

        // Losing focus must not leave keys stuck down.
        host.fire('blur', {});
        expect(input.isHeld('forward')).toBe(false);
        expect(input.isHeld('crouch')).toBe(false);
      } finally {
        input.dispose();
      }
    });
  });

  it('calls the key hook and honours its verdict', () => {
    withHost((host) => {
      const seen: string[] = [];
      const input = new InputSystem(host.canvas as HTMLCanvasElement, {
        onKeyDown: (code) => {
          seen.push(code);
          return code === 'KeyB';
        },
      });
      try {
        const b = keyEvent('KeyB');
        host.fire('keydown', b);
        expect(b.prevented).toBe(true);
        expect(seen).toEqual(['KeyB']);

        const f5 = keyEvent('F5');
        host.fire('keydown', f5);
        expect(f5.prevented).toBe(false);
        expect(seen).toEqual(['KeyB', 'F5']);
      } finally {
        input.dispose();
      }
    });
  });
});