# AudioEngine — integration note

Everything is synthesised at runtime with the Web Audio API. No asset files, no
network, so audio works offline. `synth.ts` is pure DSP, `sfx.ts` is the
cache/voice budget, `AudioEngine.ts` owns the graph and the event wiring.

## Graph

```
voices -> lowpass(air, distance) -> lowpass(occlusion) -> PannerNode(HRTF, inverse)
       -> busGain[sfx|footstep|ui|ambience] -> master -> destination
```

## Constructor & lifecycle

```ts
new AudioEngine(weaponLookup: (id: string) => WeaponDef | undefined)
```

There is **no** `AudioContext` in the constructor (browsers require a gesture).
Call `await resume()` from the pointer-lock click handler; it is idempotent and
resolves harmlessly in a browser-less environment. `dispose()` stops every
voice, frees every buffer and closes the context. `ready` reports whether the
graph exists yet.

## Public API

| Method | Purpose |
| --- | --- |
| `resume(): Promise<void>` | Lazily create/resume the context. Call on first click. |
| `dispose(): void` | Tear down voices, buffers and context. |
| `setVolume(bus, v)`, `getVolume(bus)`, `setMasterMuted(boolean)` | Mixer. `bus` is `'master' \| 'sfx' \| 'footstep' \| 'ui' \| 'ambience'`. Nothing is persisted — the game owns localStorage. |
| `updateListener(pos, forward, up): void` | Once per rendered frame. Uses `positionX`/`forwardX` params, falling back to `setPosition`/`setOrientation`. |
| `setOcclusionTest(fn \| null)` | `fn(from, to) => 0..1` (1 = blocked). Wire a `world.trace()` raycast; it costs one ray per sounding voice. |
| `setActorPositionProvider(fn \| null)` | Positions for events that only carry actor ids. |
| `setLocalActorId(id)` | Suppresses the local player's own footsteps/hits; enables the hit marker. |
| `attach(bus: EventBus)` / `detach()` / `subscriptionCount` | Connect/disconnect all event handlers. |
| `playShot(def, position)` | Used by `attach`; also callable directly. |
| `playCue(cue, position \| null, opts?)` | `'hitmarker' \| 'headshot' \| 'shellDrop' \| 'whizz' \| 'roundStart' \| 'roundEnd' \| 'uiClick' \| 'bombPlant' \| 'defuseTick' \| 'bombExplode'`. |
| `playBombBeep(position \| null, pitch = 1200)` | C4 beeper; the game owns the cadence. |

## Events subscribed by `attach()`

`shot`, `hit`, `impact`, `footstep`, `reload`, `draw`, `jump`, `land`, `death`,
`buy`, `roundPhase`, `roundEnd`, `bombPlanted`, `bombExploded`, `bombDefused`,
`grenadeExplode`, `flash`, `announce`. `attach` returns nothing; keep every
returned unsubscribe via `detach()` (already tracked internally).

## Swapping in real `.ogg` samples

`play3D(buffer, position, opts)` takes any `AudioBuffer`, so a sample packs in
with no engine change: preload with `fetch`/`decodeAudioData`, key it
(`shot:ak47`, `step:wood`, ...) exactly as the synth cache does, and pass the
decoded buffer to `play3D`. The intended override is `public/sounds/<key>.ogg`
— probe once at boot and, when the file exists, use it instead of
`renderX(ctx, ...)`; keep the synth as the fallback so offline builds still work.
`SfxCache` already provides the LRU + voice-cap bookkeeping for either source.
