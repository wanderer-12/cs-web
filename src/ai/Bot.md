<!-- =============================================================================
ai/Bot.md — integration notes for the bot decision core.

`Bot.ts` is pure: no Three.js, no DOM, no timers, no `Math.random()`, no
per-tick allocation. It reads a `BotContext`, writes an `InputCommand`, and
returns. `BotController.ts` is the thin stateful wrapper that owns one bot's
senses/memory/follower and calls `perceive` → `chooseGoal` → `think`.
============================================================================= -->

# Bot AI — integration notes

## The think tick

Bots think on the same fixed step as the rest of the simulation (`TICK_RATE = 128`,
`TICK_DT = 1 / 128`). Call `BotController.update(...)` **exactly once per tick**,
before `Player.step` consumes the command:

```ts
// one command object per bot, owned by the game layer (`Match.botCmds`) and reused every tick
const cmd = controller.update({
  self, actors, weapon, ammo, reserve, magazineFull, reloading, canShoot, now,
  objective,
  senses: { underFire, heardAt, bombPlanted, bombPos, insideSite },
  cmd: match.botCommand(player), // this bot's own object; never share it between bots
});
player.step(cmd, dt);     // reads tick, yaw, pitch, buttons
```

Order matters: `update` runs `perceive` (refresh senses + memory) → `chooseGoal`
(goal with hysteresis) → `think` (movement, aim, buttons). One call is one tick;
calling it twice with the same `now` would double-advance the aim smoothing.

Contract details:

- **`cmd` is reused — but one per bot.** The game layer owns an `InputCommand`
  for each bot and passes the same object every tick; the bot mutates
  `cmd.buttons` field by field (and writes `cmd.yaw`/`cmd.pitch`/`cmd.mouseDX`/
  `cmd.mouseDY`) and never replaces the object, so any reference the caller holds
  stays valid. **Never hand the same object to two bots**: `think` writes only
  the fields it decides to change this tick, so with a shared object the last
  writer in a tick would decide everyone's buttons, and `shouldFire`'s check
  against `cmd.yaw` would measure another bot's aim. Before the call, reseed the
  fields the bot may leave untouched from its own state:
  `cmd.tick = 0; cmd.yaw = player.state.yaw; cmd.pitch = player.state.pitch;
  cmd.mouseDX = 0; cmd.mouseDY = 0;`. Pass `undefined` only if you have no
  command to reuse — the controller then falls back to its own scratch command.
- **`cmd.yaw` / `cmd.pitch` are absolute, and they are what the player applies.**
  `Player.step` copies them straight into `state.yaw/pitch` (`applyLook`), so a
  command seeded from the player's current angles is also what makes a bot turn
  smoothly instead of snapping.
- **`cmd.tick` belongs to the caller.** The bot fills it only when it is `0` or
  non-finite (the caller forgot); a `cmd.tick` you set is left alone.
- **`now` is monotonic match seconds**, the same clock the player uses. Memory
  aging (`6 s` contacts), goal hysteresis (`2 s`), the aim-error wander
  (`0.2–0.5 s`) and the spray burst gap (`0.4 s`) are all measured against it.
  Do not feed wall-clock time that jumps between rounds without calling
  `resetForRound()`.
- **`senses` fields are caller inputs too.** `underFire`, `heardAt`,
  `bombPlanted` and `bombPos` cannot be derived from `actors` alone, so you must
  supply them each tick; the bot overwrites those four of its `senses` object
  from your input and derives the rest itself.
- **Determinism.** Everything uses the controller's seeded `Rng`. Two
  controllers with the same seed and the same tick inputs produce byte-identical
  commands — useful for replays and for the determinism test.

## What the four skill knobs look like to the player

`BOT_SKILLS[difficulty]` gives the four design-doc knobs; the controller then
jitters **only `reactionTime` by ±20 %, once per spawn**, so bots of the same
difficulty still differ from each other.

| Knob | easy → expert | What the player observes |
| --- | --- | --- |
| `reactionTime` | 0.45 s → 0.12 s | Delay between an enemy becoming visible and the first shot. Below ~0.2 s the bot feels like it was already aiming at you. Continuous sight is required: ducking behind cover resets the clock. |
| `aimError` | deg(3) → deg(0.4) | Width of the miss cone. The offset is a **persistent wander** redrawn every 0.2–0.5 s, not per-tick noise, so misses read as a human drifting off the head rather than a vibrating robot. |
| `sprayControl` | 0 → 1 | How much of the weapon's recoil punch is cancelled. At 0 the bot eats the full climb after a few shots and must stop firing; at 1 it tracks the pattern and holds a long burst on target. |
| `preaimQuality` | 0 → 1 | Where the crosshair sits before contact. High values aim at the head (when in effective range), pre-aim a node 2–3 hops ahead on the path instead of the corridor centre, and enable the quiet walk-in. Low values walk in looking at nothing in particular. |

## Recoil: `cmd.yaw` / `cmd.pitch` are the TRUE aim

Recoil in this game is a pure **view punch**: after a shot `player.ts` calls
`camRig.addPunch(punch.x, punch.y)` and never folds the offset into
`state.yaw/pitch`. Those state angles stay the true aim, and the camera the
player sees is `trueAim + viewPunch`.

`cmd.yaw` / `cmd.pitch` are consumed exactly like `state.yaw/pitch`, so the bot
must pre-compensate: `sprayCompensation(weapon, shotIndex, skill)` returns the
**negated** punch (`yaw = -punch.x * sprayControl`, `pitch = -punch.y * sprayControl`)
and `think` **adds** it to the desired aim. The result is
`cmd.yaw + viewPunch ≈ target` — the same thing a human does by dragging the
mouse down-left through a spray. `shotIndex` is the 0-based index of the shot
about to be fired, taken from the bot's own burst counter; index 0 is always a
zero offset, because the camera has not been punched yet when the first shot
leaves the barrel. At `sprayControl: 0` the compensation is exactly zero and the
bot's stream climbs like an uncontrolled player's.

## `cmd.buttons.use`

`use` is an **intent**, not an action: the bot raises it only while it is
standing on the thing it wants to interact with and the game layer decides what
that means.

- Goal `'plant'`: the bot carries the bomb (`self.hasBomb`) and is inside the
  objective's site (within ~200 units of a nav node tagged with that site) →
  movement stops and `use` is held.
- Goal `'defuse'`: the bomb is planted, the bot is CT, and it is within 80 units
  of `senses.bombPos` → movement stops and `use` is held.
- Otherwise `use` is false.

The game layer therefore only has to check "is the player on a plant site with
the bomb / next to the bomb as CT" — the same predicate it already runs for a
human holding E. The bot never releases and re-presses `use`; holding it is the
signal.

## Building a `BotContext`

Create the mutable half once per bot and keep it: `createBotMemory()` and
`createBotCommand()` (or let `BotController` do it — it owns both). Each tick the
caller fills the per-tick fields and the controller assembles the context:

| Field | Supplied by | Notes |
| --- | --- | --- |
| `self` | game layer | Position, yaw/pitch, duck amount, health, `hasBomb`. |
| `actors` | game layer | **Every** actor, both teams, alive or not; `perceive` filters. |
| `team` | fixed per bot | Yours is never a target. |
| `weapon` | game layer | Current weapon; drives `preferredRange` and the spray table. |
| `ammo`, `reserve`, `magazineFull`, `reloading` | game layer | `0` requests a reload instead of a shot; both empty means the bot switches to its knife (`slot3`). |
| `canShoot` | game layer | False during freeze/buy time; no trigger pull. |
| `now` | game layer | Monotonic match seconds. |
| `nav`, `world` | fixed per map | For pathing and line-of-sight. |
| `memory` | bot (owned) | Persistent between ticks and rounds. |
| `follower` | bot (owned) | Path-following state; the bot repaths when the goal node changes. |
| `objective` | game layer | `{ kind, goalNode, site }`, derived from round state. |
| `cmd` | game layer | This bot's own reused `InputCommand`. |

`objective.kind` drives the whole plan: `attack`/`push`/`retake` advance, `defend`
holds, `post_plant` makes a T hold the site and a CT retake it, `hunt` chases
sound. `objective.site` selects the A/B node set for `pickGoalNode`, and
`objective.goalNode` overrides node selection when it is `>= 0` (use it when the
game layer wants a specific plan, e.g. a called strategy).

Rounds: call `resetForRound()` between rounds to clear contacts, sounds, the
burst counter and the follower; `repath(ctx)` forces a fresh path after a team
rotation or an objective change.

## What is deliberately not covered by `tests/bot.spec.ts`

The suite is pure logic against a synthetic map. These are exercised only once
the real game loop is wired up, so they are not asserted there:

- Frame timing with a real `player.step` (the tests call `think` directly).
- Damage and death handling, round end, buy time, and the round manager feeding
  `canShoot` / `now`.
- Bullet spread resolution — the bot only gates on angular error, it does not
  roll the actual shot.
- Grenades, defuse kits, and the scoreboard/threat heuristics that would let the
  bot choose a target by more than health and distance.
- Sound occlusion: `heardAt` is taken at face value, because the game layer
  decides whether a sound is audible.
- Real map layouts (the tests build a 5×5 grid with two sites and one wall).
