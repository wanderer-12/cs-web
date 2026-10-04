// =============================================================================
// net/WsTransport.ts — the one class `src/net/` was missing.
//
// The rest of the net layer (codec, interpolation, lag compensation, server
// clock) is real code with tests; the socket itself was always "someone else's
// job". This is that someone: a WebSocket wrapper that satisfies the existing
// `Transport` interface and nothing more. It knows nothing about the game.
//
// `binaryType = 'arraybuffer'` keeps every message an `ArrayBuffer`, which is
// exactly what `decodeSnapshot` / `decodeInput` expect, so no copies happen on
// the hot path.
// =============================================================================

import { LAN_RELAY_PORT } from './LanProtocol';
import type { Transport } from './NetClient';

export type WsState = 'connecting' | 'open' | 'closed';

export interface WsTransportOptions {
  /** Full URL, e.g. `ws://192.168.1.7:5175/lan?room=duel&role=guest`. */
  url: string;
  /** Socket state changes, for the HUD's connection line. */
  onState?: (state: WsState, detail: string) => void;
  /** Text messages (relay control). Binary frames go to `onMessage`. */
  onText?: (text: string) => void;
}

export class WsTransport implements Transport {
  private readonly socket: WebSocket;
  private messageHandler: ((data: ArrayBuffer) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private readonly url: string;
  private readonly options: WsTransportOptions;

  constructor(options: WsTransportOptions) {
    this.options = options;
    this.url = options.url;
    this.socket = new WebSocket(options.url);
    this.socket.binaryType = 'arraybuffer';
    this.report('connecting', options.url);

    this.socket.addEventListener('open', () => this.report('open', this.url));
    this.socket.addEventListener('close', (event) => {
      this.report('closed', event.reason || `code ${event.code}`);
      this.closeHandler?.();
    });
    this.socket.addEventListener('error', () => {
      // A failed LAN connect is a normal outcome (wrong IP, relay not running);
      // the HUD line says so and the player can try another address.
      this.report('closed', 'socket error');
    });
    this.socket.addEventListener('message', (event) => {
      const data = event.data;
      if (typeof data === 'string') {
        this.options.onText?.(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.messageHandler?.(data);
        return;
      }
      // Blob is possible if `binaryType` were left at its default; re-read it as
      // a buffer rather than dropping a snapshot on the floor.
      void (data as Blob).arrayBuffer().then((buf) => this.messageHandler?.(buf));
    });
  }

  send(data: ArrayBuffer): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(data);
  }

  /** Send a text frame (relay/control channel). */
  sendText(text: string): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(text);
  }

  onMessage(handler: (data: ArrayBuffer) => void): void {
    this.messageHandler = handler;
  }

  onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  get open(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  /** Still trying to reach the relay (or the peer behind it). */
  get connecting(): boolean {
    return this.socket.readyState === WebSocket.CONNECTING;
  }

  close(): void {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
  }

  private report(state: WsState, detail: string): void {
    this.options.onState?.(state, detail);
  }
}

/**
 * Build the relay URL both ends dial: one room, one role, the player's name.
 *
 * The relay lives on the host's machine, so `host` is the address the guest was
 * given in the start menu and the port is the relay's own (5175 by default).
 */
export function relayUrl(options: {
  host: string;
  port?: number;
  room?: string;
  role: 'host' | 'guest';
  name?: string;
  secure?: boolean;
}): string {
  const port = options.port ?? LAN_RELAY_PORT;
  const scheme = options.secure ? 'wss' : 'ws';
  // A bare IP is the common case; tolerate `ws://…` and `host:port` pastes too.
  let host = options.host.trim().replace(/^wss?:\/\//i, '').replace(/\/.*$/, '');
  let usePort = port;
  const colon = host.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) {
    usePort = Number(host.slice(colon + 1));
    host = host.slice(0, colon);
  }
  const params = new URLSearchParams({ room: options.room ?? 'duel', role: options.role });
  if (options.name) params.set('name', options.name);
  return `${scheme}://${host || '127.0.0.1'}:${usePort}/lan?${params.toString()}`;
}