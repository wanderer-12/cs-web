// =============================================================================
// main.ts — browser entry point.
//
// Responsibilities, and nothing else:
//   1. fetch the canvas + HUD mount point from index.html,
//   2. read launch options off the query string (handy for testing a difficulty
//      or a team without touching code),
//   3. construct and start the `Engine`,
//   4. fail loudly in the boot curtain if WebGL (or anything else) is missing.
//
// Everything the game does lives behind `Engine`; this file is deliberately
// disposable, which is why the whole simulation stays headless and unit-testable.
// =============================================================================

import { Engine, type EngineStats } from './core/engine';
import { MATCH } from './core/config';
import type { BotDifficulty } from './ai/Bot';
import type { Team } from './core/types';

/** Kept in sync with `BOT_SKILLS` in src/ai/Bot.ts (the query string picks one). */
const DIFFICULTY_NAMES: readonly BotDifficulty[] = ['easy', 'normal', 'hard', 'expert'];

interface LaunchOptions {
  humanName: string;
  humanTeam?: Team;
  difficulty?: BotDifficulty;
  seed?: number;
  /** Log an fps/draw-call line every 5 s (used by the perf pass). */
  stats: boolean;
}

function readLaunchOptions(search: string): LaunchOptions {
  const params = new URLSearchParams(search);

  const diffRaw = (params.get('bot') ?? params.get('difficulty') ?? '').toLowerCase();
  const difficulty = DIFFICULTY_NAMES.find((d) => d === diffRaw);

  const teamRaw = (params.get('team') ?? '').toUpperCase();
  const humanTeam: Team | undefined =
    teamRaw === 'T' ? 'T' : teamRaw === 'CT' ? 'CT' : undefined;

  const seedRaw = Number(params.get('seed'));
  const seed = Number.isFinite(seedRaw) && params.has('seed') ? Math.trunc(seedRaw) : undefined;

  return {
    humanName: params.get('name')?.trim() || MATCH.playerName,
    humanTeam,
    difficulty,
    seed,
    stats: params.get('stats') === '1' || params.get('perf') === '1',
  };
}

function boot(curtain: HTMLElement | null, html: string): void {
  if (!curtain) return;
  curtain.classList.remove('hidden');
  curtain.innerHTML = `<div class="err">${html}</div>`;
}

/** Periodic counters so the perf report can quote measured numbers. */
function watchStats(engine: Engine): void {
  let worstFrameMs = 0;
  let last = performance.now();
  const sample = (): void => {
    const now = performance.now();
    worstFrameMs = Math.max(worstFrameMs, now - last);
    last = now;
    requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);

  setInterval(() => {
    const s: EngineStats = engine.stats();
    // eslint-disable-next-line no-console
    console.log(
      `[fps] ${s.fps.toFixed(1)} | sim ${s.simMs.toFixed(2)} ms | render ${s.renderMs.toFixed(2)} ms` +
        ` | draws ${s.drawCalls} (map ${s.mapDrawCalls}) | tris ${s.triangles} (map ${s.mapTriangles})` +
        ` | programs ${s.programs} | textures ${s.textures} | geoms ${s.geometries}` +
        ` | players ${s.players} | worstFrame ${worstFrameMs.toFixed(1)} ms | dropped ${s.droppedSteps}`,
    );
    if (engine.loop.fps > 0) {
      document.title = `${engine.loop.fps.toFixed(0)} fps — WEB-FPS`;
    }
  }, 5000);
}

function main(): void {
  const curtain = document.getElementById('boot');
  const canvas = document.getElementById('game');

  if (!(canvas instanceof HTMLCanvasElement)) {
    boot(curtain, '启动失败：页面里找不到 <code>&lt;canvas id="game"&gt;</code>。');
    return;
  }

  const hudRoot = document.getElementById('hud-root');

  const options = readLaunchOptions(window.location.search);

  let engine: Engine;
  try {
    engine = new Engine({
      canvas,
      hudRoot: hudRoot ?? undefined,
      humanName: options.humanName,
      humanTeam: options.humanTeam,
      difficulty: options.difficulty,
      seed: options.seed,
    });
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    boot(
      curtain,
      'WebGL 初始化失败，游戏无法运行。<br />请确认浏览器已启用硬件加速（chrome://gpu）。' +
        `<br /><br /><code>${detail}</code>`,
    );
    return;
  }

  engine.start();
  curtain?.classList.add('hidden');

  // Debug handle: lets the console drive perf runs and level probes
  // (`__engine.placeLocal({x:0,y:0,z:0}); __engine.stats()`).
  (window as unknown as { __engine: Engine }).__engine = engine;

  if (options.stats) watchStats(engine);

  // F3 prints the same line on demand.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F3') return;
    event.preventDefault();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(engine.stats(), null, 2));
  });

  // eslint-disable-next-line no-console
  console.log(
    `WEB-FPS ready — 人机模式 | 队伍 ${engine.match.local.team} | 难度 ${options.difficulty ?? 'normal'}` +
      ` | 玩家 ${engine.match.players.length} | seed ${options.seed ?? 'default'}`,
  );
}

main();