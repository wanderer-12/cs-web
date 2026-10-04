// =============================================================================
// server/lan-relay-check.mjs — a smoke test for `lan-relay.mjs`.
//
// The relay is the one piece of the LAN path that is neither TypeScript nor part
// of the unit tests (it is a process, not a module), so this script is how you
// prove it still works: it spawns the relay on a scratch port and drives a real
// host + guest pair through it, checking the handshake, the peer pairing, byte
// transparency in both directions, and the "peer gone" notice.
//
//   node server/lan-relay-check.mjs
//   LAN_RELAY_PORT=5199 node server/lan-relay-check.mjs
//
// Exits 0 when every check passes, 1 otherwise. No dependencies: Node's own
// WebSocket client (Node 22+) is all it needs.
// =============================================================================

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LAN_RELAY_PORT ?? 5185);
const base = `ws://127.0.0.1:${port}/lan`;

let failures = 0;
function check(ok, label, detail = '') {
  if (ok) {
    console.log(`  [ok] ${label}`);
  } else {
    failures += 1;
    console.log(`  [xx] ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Read messages in order without ever racing the socket.
 *
 * The relay answers a join with `welcome` and `peer` back to back, so a listener
 * attached per-read (the obvious `once` pattern) drops whichever message lands
 * first: this keeps a queue instead.
 */
function reader(socket) {
  const pending = [];
  const waiters = [];
  socket.addEventListener('message', (event) => {
    const waiter = waiters.shift();
    if (waiter) waiter(event.data);
    else pending.push(event.data);
  });
  return (ms = 5000) =>
    new Promise((resolve, reject) => {
      if (pending.length > 0) {
        resolve(pending.shift());
        return;
      }
      const timer = setTimeout(() => reject(new Error('timeout waiting for a message')), ms);
      waiters.push((data) => {
        clearTimeout(timer);
        resolve(data);
      });
    });
}

function open(url) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.binaryType = 'arraybuffer';
    socket.addEventListener('open', () => resolve({ socket, next: reader(socket) }), { once: true });
    socket.addEventListener('error', () => reject(new Error(`cannot open ${url}`)), { once: true });
  });
}

const relay = spawn(process.execPath, [join(here, 'lan-relay.mjs')], {
  env: { ...process.env, LAN_RELAY_PORT: String(port) },
  stdio: ['ignore', 'ignore', 'inherit'],
});

let host = null;
let guest = null;

try {
  // The relay prints nothing, so poll its status endpoint until it answers.
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/status`);
      if (response.ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('relay never started');
    await new Promise((r) => setTimeout(r, 100));
  }
  check(true, `relay listening on ${port}`);

  const hostConn = await open(`${base}?room=duel&role=host&name=%E4%B8%BB%E6%9C%BA`);
  host = hostConn.socket;
  const hostNext = hostConn.next;
  const welcomeHost = JSON.parse(await hostNext());
  check(welcomeHost.t === 'welcome' && welcomeHost.role === 'host', 'host gets its welcome', JSON.stringify(welcomeHost));

  const guestConn = await open(`${base}?room=duel&role=guest&name=guest`);
  guest = guestConn.socket;
  const guestNext = guestConn.next;
  const welcomeGuest = JSON.parse(await guestNext());
  check(welcomeGuest.t === 'welcome' && welcomeGuest.role === 'guest', 'guest gets its welcome');

  const peer = JSON.parse(await hostNext());
  check(peer.t === 'peer' && peer.role === 'guest', 'host is told about the guest', JSON.stringify(peer));
  const seen = JSON.parse(await guestNext());
  check(seen.t === 'peer' && seen.role === 'host', 'guest is told about the host');

  // Binary transparency: a snapshot must arrive byte-identical.
  const payload = new Uint8Array([0, 1, 2, 250, 251, 255, 17, 42]);
  host.send(payload);
  const echoed = new Uint8Array(await guestNext());
  check(
    echoed.length === payload.length && echoed.every((v, i) => v === payload[i]),
    'binary frames pass through unchanged',
    `${payload.length} vs ${echoed.length} bytes`,
  );

  // Text transparency, both ways.
  guest.send(JSON.stringify({ t: 'buy', itemId: 'ak47' }));
  check(String(await hostNext()) === '{"t":"buy","itemId":"ak47"}', 'guest → host text passes through');
  host.send(JSON.stringify({ t: 'state', round: 1 }));
  check(String(await guestNext()) === '{"t":"state","round":1}', 'host → guest text passes through');

  // A second guest replaces the first one (one duel per room).
  const otherConn = await open(`${base}?room=duel&role=guest&name=other`);
  const other = otherConn.socket;
  check(JSON.parse(await otherConn.next()).t === 'welcome', 'a second guest still gets a welcome');
  const replaced = JSON.parse(await guestNext());
  check(replaced.t === 'replaced', 'the first guest is told it was replaced', JSON.stringify(replaced));
  guest.close();
  other.close();
  await new Promise((r) => setTimeout(r, 200));

  const gone = JSON.parse(await hostNext());
  check(gone.t === 'peer-gone', 'host is told when the room empties', JSON.stringify(gone));

  const status = await (await fetch(`http://127.0.0.1:${port}/status`)).json();
  check(status.ok === true && Array.isArray(status.rooms), 'status endpoint reports rooms');
} catch (error) {
  failures += 1;
  console.log(`  [xx] ${error instanceof Error ? error.message : String(error)}`);
} finally {
  host?.close();
  guest?.close();
  relay.kill();
}

console.log(failures === 0 ? '\n  LAN relay: all checks passed.\n' : `\n  LAN relay: ${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);