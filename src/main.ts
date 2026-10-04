// =============================================================================
// main.ts — browser entry point.
//
// Responsibilities, and nothing else:
//   1. fetch the canvas + HUD mount point from index.html,
//   2. read launch options off the query string (handy for testing a difficulty
//      or a team without touching code),
//   3. show the mode picker and, on a choice, construct and start the `Engine`,
//      tearing the previous engine down when the player goes back to the menu,
//   4. fail loudly in the boot curtain if WebGL (or anything else) is missing.
//
// Everything the game does lives behind `Engine`; this file is deliberately
// disposable, which is why the whole simulation stays headless and unit-testable.
// =============================================================================

import { Engine, type EngineStats } from './core/engine';
import { LAN_DUEL_TEAMS, MATCH, type MatchModeId } from './core/config';
import { LAN_ROOM_DEFAULT } from './net/LanProtocol';
import { StartMenu, type LaunchChoice } from './ui/StartMenu';
import type { BotDifficulty } from './ai/Bot';
import type { Team } from './core/types';

/** Kept in sync with `BOT_SKILLS` in src/ai/Bot.ts (the query string picks one). */
const DIFFICULTY_NAMES: readonly BotDifficulty[] = ['easy', 'normal', 'hard', 'expert'];

/** The dev server's port; must match `server.port` in vite.config.ts. */
const LAN_PAGE_PORT = 5174;

/**
 * Pull the host machine out of whatever the player typed.
 *
 * Empty means "the machine this page came from", which is the friend's case
 * exactly: they opened the host's address, so the relay is on that same box. A
 * port that is not the page's own is read as the relay port
 * (`192.168.1.23:5175`); the page's port (`…:5174`) means "the relay next to it".
 */
function parseJoinAddress(input: string, fallbackHost: string): { host: string; port?: number } {
  const value = input
    .trim()
    .replace(/^wss?:\/\//i, '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const colon = value.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(value.slice(colon + 1))) {
    const port = Number(value.slice(colon + 1));
    return {
      host: value.slice(0, colon) || fallbackHost,
      port: port === LAN_PAGE_PORT ? undefined : port,
    };
  }
  return { host: value || fallbackHost };
}

interface LaunchOptions {
  humanName: string;
  humanTeam?: Team;
  difficulty?: BotDifficulty;
  seed?: number;
  /** Log an fps/draw-call line every 5 s (used by the perf pass). */
  stats: boolean;
  /** `?mode=duel|classic` pre-selects a ruleset and skips the picker. */
  mode?: MatchModeId;
  /** `?join=<host>` pre-fills the LAN address field of the picker. */
  join?: string;
  /** `true` boots straight into a match; the picker is the default otherwise. */
  skipMenu: boolean;
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

  const modeRaw = (params.get('mode') ?? '').toLowerCase();
  const mode: MatchModeId | undefined =
    modeRaw === 'duel' ? 'duel' : modeRaw === 'classic' || modeRaw === 'rules' ? 'classic' : undefined;

  // Any gameplay parameter means "just start": the picker is for players who
  // arrived at the plain URL, and skipping it keeps every documented query
  // string (?bot=hard, ?stats=1, …) behaving exactly as before.
  const skipMenu =
    params.get('menu') === '0' ||
    mode !== undefined ||
    params.has('bot') ||
    params.has('difficulty') ||
    params.has('team') ||
    params.has('seed') ||
    params.has('name');

  return {
    humanName: params.get('name')?.trim() || MATCH.playerName,
    humanTeam,
    difficulty,
    seed,
    stats: params.get('stats') === '1' || params.get('perf') === '1',
    mode,
    join: params.get('join')?.trim() || undefined,
    skipMenu,
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

  let engine: Engine | null = null;
  let menu: StartMenu | null = null;

  /** Build and start a match for a launch choice; the picker owns the choice. */
  const launch = (choice: LaunchChoice): void => {
    menu?.hide();
    const name = menu?.playerName || options.humanName;
    const pageHost = window.location.hostname || '127.0.0.1';
    // A LAN duel is always the small map: the host is authoritative and plays T,
    // the guest mirrors and plays CT. One human per side, no bots — that is what
    // `LAN_DUEL_TEAMS` describes, and it is the only composition the wire handles.
    const guest = choice.kind === 'join' ? parseJoinAddress(choice.address, pageHost) : null;
    const lan =
      choice.kind === 'host'
        ? {
            role: 'host' as const,
            host: pageHost,
            name,
            room: LAN_ROOM_DEFAULT,
            shareHint: `http://${pageHost}:${LAN_PAGE_PORT}/?join=1`,
          }
        : guest
          ? { role: 'guest' as const, host: guest.host, port: guest.port, name, room: LAN_ROOM_DEFAULT }
          : null;
    const mode: MatchModeId = choice.kind === 'solo' ? choice.mode : 'duel';
    try {
      engine = new Engine({
        canvas,
        hudRoot: hudRoot ?? undefined,
        humanName: name,
        humanTeam: lan ? (lan.role === 'host' ? 'T' : 'CT') : options.humanTeam,
        difficulty: options.difficulty,
        seed: options.seed,
        mode,
        teams: lan ? LAN_DUEL_TEAMS : undefined,
        mirror: lan?.role === 'guest',
        remoteNames: lan ? [lan.role === 'host' ? '客机' : '主机'] : undefined,
        lan: lan ?? undefined,
        // Going back to the picker disposes the whole engine (renderer, HUD,
        // listeners) so a second match starts from a clean slate.
        onExitToMenu: () => {
          engine?.dispose();
          engine = null;
          showMenu();
        },
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

    // eslint-disable-next-line no-console
    console.log(
      `WEB-FPS ready — ${engine.modeRules.label} | 队伍 ${engine.match.local.team} | 难度 ${options.difficulty ?? 'normal'}` +
        ` | 玩家 ${engine.match.players.length} | 地图 ${engine.map.name} | seed ${options.seed ?? 'default'}`,
    );
    if (lan?.role === 'host') {
      // eslint-disable-next-line no-console
      console.log(`局域网主机：把这个地址发给朋友 → http://${pageHost}:${LAN_PAGE_PORT}/?join=1`);
    }
  };

  const showMenu = (): void => {
    if (!menu) {
      menu = new StartMenu(document, {
        root: hudRoot ?? undefined,
        addressHint: options.join ?? window.location.hostname ?? '127.0.0.1',
        playerName: options.humanName,
        onChoose: launch,
      });
    }
    menu.show();
  };

  if (options.skipMenu) launch({ kind: 'solo', mode: options.mode ?? 'classic' });
  // `?join=1` is the link the host hands out: opening it goes straight into the
  // duel as the guest; `?join=192.168.1.23` names the host explicitly.
  else if (options.join !== undefined) {
    const address = /^(1|auto|yes|self)$/i.test(options.join) ? '' : options.join;
    launch({ kind: 'join', address });
  } else showMenu();

  // F3 prints a stats line on demand.
  window.addEventListener('keydown', (event) => {
    if (event.code !== 'F3' || !engine) return;
    event.preventDefault();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(engine.stats(), null, 2));
  });
}

main();