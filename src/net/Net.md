# src/net — phase 3 (online play) interfaces

The shipped build is **single player vs bots**: `src/game/game.ts` runs the whole
authoritative simulation locally and nothing in `src/` imports `src/net`. This
folder exists because the plan (PLAN.md §"网络（三期）") commits to freezing the
network seam *before* the single-player game is finished, so that adding the
server later cannot force a rewrite of the simulation.

The design, in one paragraph: an authoritative Node + `ws` server ticks the same
fixed-step simulation at 128 Hz, broadcasts binary snapshots at 20 Hz, and keeps
one second of every actor's pose for lag compensation. Clients predict their own
movement locally at 128 Hz, render everyone else 100 ms in the past, and when a
snapshot arrives they snap their own actor back to the authoritative pose and
replay every unacknowledged input.

## What is implemented (and tested) today

| File | Status | What it covers |
| --- | --- | --- |
| `Protocol.ts` | **implemented** | Wire format. Snapshots (12 B header + 15 B/actor) and input commands (16 B), quantised to 0.25 units / 0.0001 rad, plus button bit packing. |
| `Interpolation.ts` | **implemented** | `SnapshotBuffer`: 100 ms playout, drops out-of-order datagrams, blends the bracketing snapshots, holds the last pose instead of extrapolating. |
| `LagCompensation.ts` | **implemented** | `PositionHistory`: 1 s rewind ring of actor poses for the server's fire handler. |
| `Prediction.ts` | partly | `InputHistory` and the wrapping tick arithmetic are implemented; the re-simulation loop is the `PredictedWorld` seam. |
| `NetClient.ts` | partly | `Transport`/`NetClient`/`NetStats` interfaces and the `ServerClock` (best-RTT one-way-delay estimate); the WebSocket transport is not written. |

Nothing here is a stub pretending to work: the unimplemented parts are declared
as *interfaces* with no body, and `tests/net.spec.ts` only tests the implemented
files.

## Why the wire format looks like this

* **15 bytes per actor.** id (1) + three quarter-unit int16 positions (6) + two
  1/10000-rad int16 angles (4) + flags/health/armor/weapon (4). 30 actors is
  `12 + 30*15 = 462 B` per snapshot, ~9 kB/s per client at 20 Hz — the ~400 B
  budget from the plan. `f32` positions would double an actor's cost for
  precision nobody can use: interpolation smooths 0.25 units and the rewind
  window only needs to place a hitbox on the pose the client saw.
* **Angles are absolute, not deltas.** `Player.applyLook` consumes absolute
  yaw/pitch, so the server can feed a client's command straight into `step`.
* **Mouse deltas stay client-side.** They only drive view punch and sway, which
  are cosmetic: the engine deliberately never folds punch into `state.yaw`, so
  sending deltas would reintroduce the class of bug where a bot's punch skewed
  its aim.
* **Input ticks are 16-bit and wrap.** `ticksAhead()` exists so a session longer
  than 8.5 minutes does not break reconciliation; the same helper is used by
  `InputHistory.ack`.
* **Rewind is clamped to the history, never interpolated.** A hitbox is a
  discrete box; blending two of them invents a box nobody occupied. Clamping is
  also what bounds the advantage a high-ping client can buy.

## What phase 3 still has to write

1. `Transport` over `WebSocket` (binary, `arraybuffer` mode) + reconnect.
2. A server loop: receive inputs into a per-client queue, run the 128 Hz tick,
   snapshot at 20 Hz, `PositionHistory.record` after each tick.
3. `PredictedWorld` for the client: a local simulation of *only* the local actor
   (the existing `stepMovement` + `CombatSystem` can be reused unchanged) plus
   `resetLocalTo`.
4. Server-side fire handling: on a fire event, rewind to
   `clientTimeMs + oneWayDelay`, rebuild hitboxes, resolve with the existing
   `fireBullet`, and re-send the correction in the next snapshot.
5. Netgraph HUD (rtt / jitter / snapshot rate) — `NetStats` is already the shape
   the HUD needs.