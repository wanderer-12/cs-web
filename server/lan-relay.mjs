// =============================================================================
// server/lan-relay.mjs — the one process a LAN duel needs besides the browser.
//
// A browser cannot accept an incoming socket, so the *host tab* cannot be dialled
// directly. This file is the smallest thing that fixes that: a room-based
// WebSocket relay that connects the two browsers and then gets out of the way.
//
// It is deliberately dumb. It owns no game state, judges nothing and invents
// nothing: the host tab stays authoritative (it simulates the 128 Hz match and
// decides every hit), and this process only forwards bytes between the two peers
// of a room. One room holds one host and one guest, which is exactly what a 1v1
// needs; a second guest in the same room replaces nobody and is refused.
//
// Run it on the machine that hosts the duel:
//
//     node server/lan-relay.mjs                 # port 5175
//     LAN_RELAY_PORT=6000 node server/lan-relay.mjs
//
// It has no dependencies on purpose (no `ws`, no `pnpm install`): the handshake
// and the frame codec are ~120 lines of Node built-ins, and Node >= 20 has
// everything needed (`node:crypto`, `node:http`).
// =============================================================================

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = Number(process.env.LAN_RELAY_PORT ?? 5175);
const HOST = process.env.LAN_RELAY_HOST ?? '0.0.0.0';

/** RFC 6455 handshake constant; the key is concatenated with it, then SHA-1'd. */
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** room code -> { host: Peer | null, guest: Peer | null } */
const rooms = new Map();

// -----------------------------------------------------------------------------
// WebSocket framing (RFC 6455): only what a browser actually sends us.
// Client frames are always masked; lengths below 64 KiB cover every message the
// game sends (a snapshot is < 1 KiB). Continuation frames are not expected.
// -----------------------------------------------------------------------------

const OP_CONT = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

function frame(opcode, payload) {
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.allocUnsafe(2);
    header[1] = len;
  } else if (len < 65536) {
    header = Buffer.allocUnsafe(4);
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  header[0] = 0x80 | opcode; // FIN + opcode; servers never mask
  return Buffer.concat([header, payload]);
}

function send(peer, opcode, payload) {
  if (!peer || peer.socket.destroyed || peer.closed) return;
  try {
    peer.socket.write(frame(opcode, payload));
  } catch {
    /* a torn-down socket is handled by the close path */
  }
}

function sendText(peer, value) {
  send(peer, OP_TEXT, Buffer.from(JSON.stringify(value), 'utf8'));
}

function peerName(peer) {
  return peer?.name ?? null;
}

function roomOf(code) {
  let room = rooms.get(code);
  if (!room) {
    room = { host: null, guest: null };
    rooms.set(code, room);
  }
  return room;
}

function other(room, role) {
  return role === 'host' ? room.guest : room.host;
}

/** Tell each side who is on the other end; the host needs the guest's name. */
function announce(room) {
  if (!room.host || !room.guest) return;
  sendText(room.host, { t: 'peer', role: 'guest', name: peerName(room.guest) });
  sendText(room.guest, { t: 'peer', role: 'host', name: peerName(room.host) });
  log(`room ${room.code}: ${peerName(room.host)} (host) <-> ${peerName(room.guest)} (guest) connected`);
}

function leave(room, peer) {
  if (!peer) return;
  peer.closed = true;
  if (room.host === peer) room.host = null;
  if (room.guest === peer) room.guest = null;
  const mate = other(room, peer.role);
  if (mate) sendText(mate, { t: 'peer-gone', role: peer.role, name: peerName(peer) });
  if (!room.host && !room.guest) rooms.delete(room.code);
  log(`room ${room.code}: ${peerName(peer)} (${peer.role}) left`);
}

const started = Date.now();

function log(message) {
  const elapsed = ((Date.now() - started) / 1000).toFixed(1).padStart(6);
  // eslint-disable-next-line no-console
  console.log(`[lan-relay ${elapsed}s] ${message}`);
}

// -----------------------------------------------------------------------------
// Upgrade handling
// -----------------------------------------------------------------------------

function acceptUpgrade(req, socket, head) {
  const url = new URL(req.url ?? '/', 'http://relay');
  const key = req.headers['sec-websocket-key'];

  if (url.pathname !== '/lan' || typeof key !== 'string') {
    socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }

  const role = url.searchParams.get('role') === 'guest' ? 'guest' : 'host';
  const code = (url.searchParams.get('room') ?? 'duel').slice(0, 32);
  const name = (url.searchParams.get('name') ?? '').slice(0, 24);

  const accept = createHash('sha1')
    .update(key + WS_GUID)
    .digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );

  const room = roomOf(code);
  room.code = code;

  // Only one of each role per room: a reconnecting player takes the seat back.
  const stale = room[role];
  if (stale) {
    sendText(stale, { t: 'replaced', role });
    leave(room, stale);
  }

  /** @type {any} */
  const peer = { socket, role, name: name || role, room, closed: false, buffer: Buffer.alloc(0) };
  room[role] = peer;
  sendText(peer, { t: 'welcome', role, room: code, version: 1 });
  announce(room);
  log(`room ${code}: ${peer.name} (${role}) connected from ${socket.remoteAddress ?? '?'}`);

  if (head && head.length > 0) peer.buffer = Buffer.concat([peer.buffer, head]);

  socket.on('data', (chunk) => {
    peer.buffer = Buffer.concat([peer.buffer, chunk]);
    for (;;) {
      const parsed = parseFrame(peer.buffer);
      if (!parsed) return;
      peer.buffer = peer.buffer.subarray(parsed.bytes);
      if (parsed.opcode === OP_CLOSE) {
        socket.end(frame(OP_CLOSE, Buffer.alloc(0)));
        return;
      }
      if (parsed.opcode === OP_PING) {
        send(peer, OP_PONG, parsed.payload);
        continue;
      }
      if (parsed.opcode === OP_PONG || parsed.opcode === OP_CONT) continue;

      const mate = other(peer.room, peer.role);
      if (!mate) {
        // Still alone: nothing to forward to. The client is expected to retry.
        continue;
      }
      send(mate, parsed.opcode, parsed.payload);
    }
  });

  socket.on('error', () => leave(room, peer));
  socket.on('close', () => leave(room, peer));
}

/**
 * Decode one client frame. Returns `null` when the buffer holds only a partial
 * frame, otherwise `{ opcode, payload, bytes }` with `bytes` consumed.
 */
function parseFrame(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const opcode = b0 & 0x0f;
  const masked = (b1 & 0x80) !== 0;
  let length = b1 & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  let mask = null;
  if (masked) {
    if (buffer.length < offset + 4) return null;
    mask = buffer.subarray(offset, offset + 4);
    offset += 4;
  }
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  }
  return { opcode, payload, bytes: offset + length };
}

// -----------------------------------------------------------------------------
// Boot
// -----------------------------------------------------------------------------

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  if (url.pathname === '/status') {
    const body = {
      ok: true,
      port: PORT,
      rooms: [...rooms.values()].map((room) => ({
        room: room.code,
        host: peerName(room.host),
        guest: peerName(room.guest),
        ready: Boolean(room.host && room.guest),
      })),
    };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body, null, 2));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    `WEB-FPS LAN relay is up on port ${PORT}.\n` +
      'The game connects to ws://<this-host>:' + PORT + '/lan?room=duel&role=host|guest\n' +
      'Status: GET /status\n',
  );
});

server.on('upgrade', (req, socket, head) => acceptUpgrade(req, socket, head));

server.listen(PORT, HOST, () => {
  log(`listening on ${HOST}:${PORT} — point both browsers at ws://<host>:${PORT}/lan`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} — shutting down`);
    server.close(() => process.exit(0));
    for (const room of rooms.values()) {
      for (const peer of [room.host, room.guest]) {
        if (peer) sendText(peer, { t: 'relay-down' });
      }
    }
    // Do not wait for idle sockets: the launcher should be able to stop us.
    setTimeout(() => process.exit(0), 200).unref();
  });
}