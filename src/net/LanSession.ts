// =============================================================================
// net/LanSession.ts — one LAN duel, from either end.
//
// The host is authoritative: it runs the normal 128 Hz `Match`, feeds the guest's
// inputs in through `Match.setRemoteCommand`, and publishes
//
//  * a binary snapshot of every pose at 20 Hz, and
//  * the JSON rules state (round, stage, clock, score, both players) at 10 Hz.
//
// The guest runs a `mirror` match that simulates only its own body and adopts
// everything else from those two channels. Nothing here touches the DOM; the HUD
// only receives `onStatus` callbacks.
//
// Why a relay rather than host-to-host: a browser tab cannot listen on a port,
// so a dumb TCP/WebSocket forwarder (`server/lan-relay.mjs`) sits between the two
// machines. It holds no game state at all — swapping it for a real server later
// changes no line of this file.
// =============================================================================

import { EMPTY_BUTTONS, type InputButtons, type InputCommand } from '../core/types';
import type { Match, NetRoundState } from '../game/game';
import {
  LAN_INPUT_HZ,
  LAN_ROOM_DEFAULT,
  LAN_SNAPSHOT_HZ,
  LAN_STATE_HZ,
  LAN_WIRE_VERSION,
  applySnapshotTo,
  parseControl,
  snapshotFor,
  stateFor,
  type LanHello,
  type LanRole,
  type LanState,
} from './LanProtocol';
import { decodeInput, decodeSnapshot, encodeInput, encodeSnapshot } from './Protocol';
import { WsTransport } from './WsTransport';

/** Where a session is in its life: dial, wait for the peer, play, or lost. */
export type LanPhase = 'connecting' | 'waiting' | 'playing' | 'disconnected';

export interface LanStatus {
  readonly role: LanRole;
  readonly phase: LanPhase;
  readonly room: string;
  /** The other player's name, once the relay has introduced them. */
  readonly peerName: string;
  readonly url: string;
  /** One short line the HUD can print verbatim. */
  readonly message: string;
}

export interface LanSessionOptions {
  /** Authoritative match on the host, `mirror: true` match on the guest. */
  match: Match;
  /** Full relay URL, built by `relayUrl()` in `WsTransport`. */
  url: string;
  role: LanRole;
  /** This player's display name, sent to the other end. */
  name: string;
  room?: string;
  /**
   * Host only: the address to read out to the other player ("把 … 发给朋友").
   * Shown in the connection line while the room waits for a peer.
   */
  shareHint?: string;
  /** Called on every state change (and once from the constructor). */
  onStatus?: (status: LanStatus) => void;
}

export class LanSession {
  readonly role: LanRole;

  private readonly match: Match;
  private readonly transport: WsTransport;
  private readonly room: string;
  private readonly name: string;
  private readonly shareHint: string;
  private readonly onStatus: ((status: LanStatus) => void) | undefined;
  /** Scratch button sets, so the hot path never allocates. */
  private readonly wireButtons: InputButtons = { ...EMPTY_BUTTONS };
  private status: LanStatus;

  private hostId: number;
  private guestId: number;
  private snapshotTick = 0;
  private lastSnapshotAt = Number.NEGATIVE_INFINITY;
  private lastStateAt = Number.NEGATIVE_INFINITY;
  private lastInputAt = Number.NEGATIVE_INFINITY;
  private closed = false;

  constructor(options: LanSessionOptions) {
    this.role = options.role;
    this.match = options.match;
    this.room = options.room ?? LAN_ROOM_DEFAULT;
    this.name = options.name;
    this.shareHint = options.shareHint ?? '';
    this.onStatus = options.onStatus;
    // Ids are stable for the whole session: the host is player 0's side, the
    // guest is the single remote human the composition reserves for it.
    this.hostId = this.match.local.id;
    this.guestId = this.match.remoteHumans[0]?.id ?? -1;
    this.status = {
      role: options.role,
      phase: 'connecting',
      room: this.room,
      peerName: '',
      url: options.url,
      message: options.role === 'host' ? '正在开房…' : '正在连接主机…',
    };

    this.transport = new WsTransport({
      url: options.url,
      onState: (socket, detail) => {
        if (socket === 'closed') {
          this.setPhase('disconnected', this.closed ? '已断开' : `连接断开（${detail}）`);
          return;
        }
        if (socket === 'open') {
          this.setPhase('waiting', this.waitingMessage());
        }
      },
      onText: (text) => this.onControl(text),
    });
    this.transport.onMessage((data) => this.onBinary(data));
    this.transport.onClose(() => {
      if (!this.closed) this.setPhase('disconnected', '对方已离开');
    });
    this.emit();
  }

  /** Current connection state, for the HUD's connection line. */
  get state(): LanStatus {
    return this.status;
  }

  /**
   * Drive the wire. Called from the engine once per simulated tick; all cadences
   * are measured against the match clock, so a paused match sends nothing.
   */
  update(cmd: InputCommand): void {
    if (this.closed || !this.transport.open || this.status.phase !== 'playing') return;
    const nowMs = this.match.now * 1000;

    if (this.role === 'host') {
      if (nowMs - this.lastSnapshotAt >= 1000 / LAN_SNAPSHOT_HZ) {
        this.lastSnapshotAt = nowMs;
        this.snapshotTick += 1;
        this.transport.send(encodeSnapshot(snapshotFor(this.match, this.snapshotTick, nowMs)));
      }
      if (nowMs - this.lastStateAt >= 1000 / LAN_STATE_HZ) {
        this.lastStateAt = nowMs;
        this.transport.sendText(JSON.stringify(stateFor(this.match, this.hostId, this.guestId)));
      }
      return;
    }

    if (nowMs - this.lastInputAt >= 1000 / LAN_INPUT_HZ) {
      this.lastInputAt = nowMs;
      this.transport.send(encodeInput(cmd, nowMs));
    }
  }

  /** Leave the room. Idempotent, and safe to call from `dispose()`. */
  close(): void {
    this.closed = true;
    this.transport.close();
    this.setPhase('disconnected', '已断开');
  }

  /**
   * A guest's purchase is applied locally (so the gun shows up at once) and also
   * forwarded: the host owns the wallet, and only its copy of the guest's money
   * and loadout is authoritative.
   */
  requestBuy(itemId: string): void {
    if (this.closed || this.role !== 'guest' || !this.transport.open) return;
    this.transport.sendText(JSON.stringify({ t: 'buy', itemId }));
  }

  // ---------------------------------------------------------------------------
  // the wire
  // ---------------------------------------------------------------------------

  private onControl(text: string): void {
    const message = parseControl(text);
    if (!message) return;
    switch (message.t) {
      case 'welcome':
        // The relay introduced itself. The relay only ever speaks for itself, so
        // the version on it must match this client's wire version.
        if (message.version !== LAN_WIRE_VERSION) {
          this.setMessage('中继版本不一致，请更新后重试');
        }
        this.setPhase('waiting', this.waitingMessage());
        break;
      case 'peer': {
        this.status = { ...this.status, peerName: message.name };
        if (this.role === 'host') {
          // The roster was built before the guest existed, so the placeholder name
          // becomes the real one here (the scoreboard reads `state.name`).
          const peer = this.match.remoteHumans[0];
          if (peer && message.name) peer.state.name = message.name;
          this.sendHello(message.name);
        } else this.emit();
        break;
      }
      case 'peer-gone':
        this.setPhase('waiting', `${message.name || '对手'}已离开，等待重新加入…`);
        break;
      case 'replaced':
        this.setPhase('disconnected', '同一角色已在别处连接，本页已让位');
        break;
      case 'relay-down':
        this.setPhase('disconnected', '中继已关闭');
        break;
      case 'hello':
        this.onHello(message);
        break;
      case 'state':
        this.onState(message);
        break;
      case 'buy':
        // Host side only: the guest asked for something.
        if (this.role === 'host' && this.guestId >= 0) this.match.buy(this.guestId, message.itemId);
        break;
      default:
        break;
    }
  }

  private onBinary(data: ArrayBuffer): void {
    if (this.role === 'host') {
      if (this.guestId < 0) return;
      const input = decodeInput(data, this.wireButtons);
      // The input's mouse deltas are not on the wire (the decoder drops them);
      // sway and view punch are cosmetic, so the host simply has none for it.
      this.match.setRemoteCommand(this.guestId, {
        tick: input.tick,
        buttons: { ...this.wireButtons },
        yaw: input.yaw,
        pitch: input.pitch,
        mouseDX: 0,
        mouseDY: 0,
      });
      return;
    }

    const snapshot = decodeSnapshot(data);
    // Skip the body this machine simulates: a 50 ms-old pose would fight the
    // local prediction. Health and round flow still arrive, via `state`.
    applySnapshotTo(
      this.match,
      snapshot,
      (actorId) => actorId === this.match.local.id,
      (actorId) => this.localIdFor(actorId),
    );
  }

  /**
   * Translate a host-side player id into the body it belongs to here.
   *
   * Both machines mint their own rosters, so an id only means something inside
   * the machine that made it: the host's own body is our opponent, and the host's
   * guest id is us. A body we do not have gets -1 and is dropped.
   */
  private localIdFor(hostSideId: number): number {
    if (hostSideId === this.guestId && this.guestId !== this.hostId) return this.match.local.id;
    if (hostSideId === this.hostId) return this.match.remoteHumans[0]?.id ?? -1;
    return -1;
  }

  private sendHello(guestName: string): void {
    const hello: LanHello = {
      t: 'hello',
      version: LAN_WIRE_VERSION,
      name: this.name,
      team: this.match.local.team,
      mode: this.match.mode.id,
      map: this.match.map.name,
      hostId: this.hostId,
      guestId: this.guestId,
    };
    this.transport.sendText(JSON.stringify(hello));
    this.setPhase('playing', `${guestName || '对手'}已加入，单挑开始`);
  }

  private onHello(hello: LanHello): void {
    this.hostId = hello.hostId;
    this.guestId = hello.guestId;
    const mismatched = hello.mode !== this.match.mode.id || hello.map !== this.match.map.name;
    this.status = { ...this.status, peerName: hello.name };
    this.setPhase(
      'playing',
      mismatched ? '双方的地图/模式不一致，画面可能不同步' : `${hello.name || '主机'}已加入，单挑开始`,
    );
  }

  private onState(state: LanState): void {
    this.hostId = state.hostId;
    this.guestId = state.guestId;
    const round: NetRoundState = {
      round: state.round,
      phase: state.phase,
      timeLeft: state.timeLeft,
      scoreT: state.scoreT,
      scoreCT: state.scoreCT,
      matchOver: state.matchOver,
      winner: state.winner,
      phaseIndex: state.phaseIndex,
      local: {
        hp: state.local.hp,
        armor: state.local.armor,
        alive: state.local.alive,
        money: state.local.money,
      },
    };
    this.match.applyNetState(round);
  }

  // ---------------------------------------------------------------------------
  // status plumbing
  // ---------------------------------------------------------------------------

  private setPhase(phase: LanPhase, message: string): void {
    if (this.status.phase === phase && this.status.message === message) return;
    this.status = { ...this.status, phase, message };
    this.emit();
  }

  /** The host's waiting line carries the address the friend has to open. */
  private waitingMessage(): string {
    const base = this.role === 'host' ? '房间已开，等待对手加入…' : '已连上中继，等待主机…';
    return this.shareHint ? `${base}（把 ${this.shareHint} 发给朋友）` : base;
  }

  private setMessage(message: string): void {
    if (this.status.message === message) return;
    this.status = { ...this.status, message };
    this.emit();
  }

  private emit(): void {
    this.onStatus?.(this.status);
  }
}