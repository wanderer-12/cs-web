// =============================================================================
// ui/Hud.ts — the complete 2D HUD overlay.
//
// One class owns every DOM node and both 2D canvases, attaches to the typed
// EventBus, and is driven once per rendered frame by `setState(dynamic)` plus
// `setActors(blips)`. See src/ui/HUD.md for the exact integration contract.
//
// Hard rules honoured here:
//   * NOTHING is ever written with innerHTML — every dynamic string (player
//     names, announcements, weapon names) goes through textContent.
//   * every node is created in the constructor as a child of `this.root` and
//     removed as a whole in `dispose()`; the only outside-the-root side effects
//     are one document keydown listener, one click listener on the game canvas
//     and a canvas CSS filter, all removed in dispose().
//   * `attach` / `detach` are idempotent, so two Hud instances on one page can
//     never double-register document listeners.
// =============================================================================

import { bus as defaultBus } from '../core/events';
import type { EventBus } from '../core/events';
import { MATCH, PERF } from '../core/config';
import type { Brush, MapData, Team, Vec3 } from '../core/types';
import { WEAPONS } from '../combat/weaponDefs';
import type {
  AnnounceKind,
  HudFrameState,
  HudOptions,
  KillFeedEntry,
  RadarBlip,
  ScoreRow,
} from './pure';
import {
  announceAlpha,
  announceColor,
  arrowPoints,
  blipRadius,
  clamp,
  crosshairPixels,
  damageIndicatorState,
  feedAlpha,
  flashEnvelope,
  formatBombClock,
  formatClock,
  formatMoney,
  healthColor,
  hitMarkerAlpha,
  mapLabel,
  projectToRadar,
  scoreLine,
  teamColor,
  toFinite,
  weaponLabel,
} from './pure';
import { BuyMenu } from './BuyMenu';
import { Scoreboard } from './Scoreboard';
import { injectStyles, ROOT_CLASS } from './styles';

export type {
  HudFrameState,
  HudOptions,
  KillFeedEntry,
  RadarBlip,
  ScoreRow,
} from './pure';

// ---------------------------------------------------------------------------
// Internal record types and constants
// ---------------------------------------------------------------------------

interface FeedRecord {
  el: HTMLDivElement;
  born: number;
}

interface DamageRecord {
  el: HTMLDivElement;
  angle: number;
  born: number;
}

/** Per-frame effect timers owned by the HUD, not by the simulation. */
interface Effects {
  now: number;
  hit: number;
  /** Reload progress is tracked locally from the `reload` bus event. */
  reloadStart: number;
  reloadDuration: number;
  /** Absolute time the current flashbang started (0 = inactive). */
  flashStart: number;
  flashAmount: number;
  lastFlashSeen: number;
}

const FLASH_LIFETIME = 1.8;
const FLASH_WATCHDOG = 0.08;

const BLIP_COLOR_TEAM = '#5aa9ff';
const BLIP_COLOR_LOCAL = '#ffffff';
const BLIP_COLOR_UNKNOWN = '#8b98a9';
const BOMB_COLOR = '#ff3b3b';

const MAX_FEED = 5;
const MAX_DAMAGE_ARROWS = 6;

// ---------------------------------------------------------------------------
// Hud
// ---------------------------------------------------------------------------

export class Hud {
  readonly root: HTMLElement;
  readonly playerName: string;

  /** Optional hooks; also settable after construction. */
  onBuy: (itemId: string) => void = () => {};
  onRequestPointerLock: () => void = () => {};
  onMenuAction: (action: string) => void = () => {};
  /** Set false to stop the HUD claiming TAB / B / ESC (the engine then owns them). */
  handleGlobalKeys = true;
  /** Crosshair colour (classic CS green by default). */
  crosshairColor = '#4dff7a';

  private readonly doc: Document;
  private readonly map: MapData;
  private readonly buy: BuyMenu;
  private readonly score: Scoreboard;

  private attached = false;
  private disposed = false;
  private offs: (() => void)[] = [];
  private keyHandler: ((e: KeyboardEvent) => void) | null = null;
  private canvasClickHandler: ((e: MouseEvent) => void) | null = null;
  private gameCanvas: HTMLCanvasElement | null = null;

  // ---- DOM ----
  private vignette!: HTMLDivElement;
  private radarCanvas!: HTMLCanvasElement;
  private radarCtx: CanvasRenderingContext2D | null = null;
  private radarBase: HTMLCanvasElement | null = null;
  private radarBaseMap: MapData | null = null;
  private moneyEl!: HTMLDivElement;
  private clockEl!: HTMLDivElement;
  private scoreEl!: HTMLDivElement;
  private roundNoEl!: HTMLDivElement;
  private bombEl!: HTMLDivElement;
  private bombTimerEl!: HTMLDivElement;
  private bombSiteEl!: HTMLDivElement;
  private defuseEl!: HTMLDivElement;
  private defuseFill!: HTMLDivElement;
  private announceEl!: HTMLDivElement;
  private feedEl!: HTMLDivElement;
  private crosshairEl!: HTMLDivElement;
  private crosshairLines: HTMLDivElement[] = [];
  private crosshairDot!: HTMLDivElement;
  private hitMarkerEl!: HTMLDivElement;
  private dmgLayer!: HTMLDivElement;
  private flashEl!: HTMLDivElement;
  private dmgFlashEl!: HTMLDivElement;
  private deadEl!: HTMLDivElement;
  private healthEl!: HTMLDivElement;
  private armorEl!: HTMLDivElement;
  private armorIcon!: HTMLSpanElement;
  private defuseKitEl!: HTMLSpanElement;
  private weaponEl!: HTMLDivElement;
  private magEl!: HTMLDivElement;
  private reserveEl!: HTMLDivElement;
  private reloadEl!: HTMLDivElement;
  private reloadFill!: HTMLDivElement;
  private debugEl!: HTMLDivElement;
  private menuRoot!: HTMLDivElement;
  private menuResumeBtn!: HTMLButtonElement;

  // ---- frame state ----
  private state: HudFrameState = makeDefaultState();
  private blips: RadarBlip[] = [];
  private spotted = new Set<number>();
  private feed: FeedRecord[] = [];
  private dmgIndicators: DamageRecord[] = [];
  private eff: Effects = {
    now: 0,
    hit: -1,
    reloadStart: -1,
    reloadDuration: 0,
    flashStart: 0,
    flashAmount: 0,
    lastFlashSeen: 0,
  };
  private readonly blipRadiusPx = blipRadius(PERF.radarSize);
  private lastPhase = '';

  constructor(opts: HudOptions) {
    this.doc = opts.root?.ownerDocument ?? (typeof document === 'undefined' ? (null as unknown as Document) : document);
    this.map = opts.map;
    this.playerName = opts.playerName ?? MATCH.playerName;
    if (opts.onBuy) this.onBuy = opts.onBuy;
    if (opts.onRequestPointerLock) this.onRequestPointerLock = opts.onRequestPointerLock;
    if (opts.onMenuAction) this.onMenuAction = opts.onMenuAction;

    injectStyles(this.doc);

    this.root = this.doc.createElement('div');
    this.root.className = `${ROOT_CLASS} hud-live`;

    this.buildRadar();
    this.buildTop();
    this.buildBomb();
    this.buildAnnounce();
    this.buildFeed();
    this.buildCrosshair();
    this.buildDamageLayer();
    this.buildMenu();
    this.buildBands();
    this.buildDebug();

    this.deadEl = this.el('div', 'hud-dead hud-hidden', this.root);
    const deadTitle = this.el('div', 't', this.deadEl);
    deadTitle.textContent = 'YOU ARE DEAD';
    const deadSub = this.el('div', 's mono', this.deadEl);
    deadSub.textContent = 'Spectating · click to look around · next round starts shortly';

    const vignette = this.el('div', 'hud-vignette', this.root);
    this.vignette = vignette;

    this.buy = new BuyMenu(this.doc);
    this.buy.onBuy = (id) => this.onBuy(id);
    this.score = new Scoreboard(this.doc);
    this.score.onMenuAction = (action) => this.onMenuAction(action);
    this.root.appendChild(this.buy.root);
    this.root.appendChild(this.score.root);
    this.root.appendChild(this.score.resultRoot);
    this.root.appendChild(this.score.matchRoot);
    this.root.appendChild(this.menuRoot);

    (opts.root ?? this.doc.body ?? this.doc.documentElement).appendChild(this.root);

    this.updateCrosshair();
    this.applyState();
  }

  // -------------------------------------------------------------------------
  // DOM construction
  // -------------------------------------------------------------------------

  private el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    parent?: HTMLElement,
  ): HTMLElementTagNameMap[K] {
    const node = this.doc.createElement(tag);
    if (className) node.className = className;
    if (parent) parent.appendChild(node);
    return node;
  }

  private buildRadar(): void {
    const wrap = this.el('div', 'hud-radar', this.root);
    this.radarCanvas = this.el('canvas', undefined, wrap);
    this.radarCanvas.width = PERF.radarSize;
    this.radarCanvas.height = PERF.radarSize;
    this.radarCanvas.setAttribute('aria-label', 'Radar');
    this.radarCtx = this.radarCanvas.getContext('2d');
    this.rebuildRadarBase();
  }

  private buildTop(): void {
    const top = this.el('div', 'hud-top', this.root);
    const clockCard = this.el('div', 'card', top);
    this.clockEl = this.el('div', 'hud-clock mono', clockCard);
    this.clockEl.textContent = '0:00';
    const scoreCard = this.el('div', 'card', top);
    this.scoreEl = this.el('div', 'hud-score mono', scoreCard);
    this.scoreEl.textContent = '0 — 0';
    this.roundNoEl = this.el('div', 'hud-round-no mono', top);
    this.roundNoEl.textContent = 'Round 1 · MR12';
    this.moneyEl = this.el('div', 'hud-money mono', this.root);
  }

  private buildBomb(): void {
    this.bombEl = this.el('div', 'hud-bomb hud-hidden', this.root);
    const lbl = this.el('div', 'lbl mono', this.bombEl);
    lbl.textContent = 'BOMB PLANTED';
    this.bombTimerEl = this.el('div', 't mono', this.bombEl);
    this.bombTimerEl.textContent = '0:40.0';
    this.bombSiteEl = this.el('div', 'lbl', this.bombEl);
    this.bombSiteEl.textContent = 'Site A';

    this.defuseEl = this.el('div', 'hud-defuse hud-hidden', this.root);
    const dLbl = this.el('div', 'lbl mono', this.defuseEl);
    dLbl.textContent = 'DEFUSING';
    const track = this.el('div', 'track', this.defuseEl);
    this.defuseFill = this.el('div', 'fill', track);
  }

  private buildAnnounce(): void {
    this.announceEl = this.el('div', 'hud-announce hud-hidden', this.root);
  }

  private buildFeed(): void {
    this.feedEl = this.el('div', 'hud-feed', this.root);
  }

  private buildCrosshair(): void {
    this.crosshairEl = this.el('div', 'hud-xh', this.root);
    for (let i = 0; i < 4; i++) this.crosshairLines.push(this.el('div', 'hud-xh-line', this.crosshairEl));
    this.crosshairDot = this.el('div', 'hud-xh-dot hud-hidden', this.crosshairEl);

    this.hitMarkerEl = this.el('div', 'hud-hitmarker hud-off', this.root);
    for (let i = 0; i < 4; i++) this.el('div', `tk t${i}`, this.hitMarkerEl);
  }

  private buildDamageLayer(): void {
    this.dmgLayer = this.el('div', 'hud-dmg-layer', this.root);
    this.flashEl = this.el('div', 'hud-flash', this.root);
    this.dmgFlashEl = this.el('div', 'hud-dmgflash', this.root);
  }

  private buildMenu(): void {
    this.menuRoot = this.el('div', 'overlay hud-menu hud-hidden', this.root);
    const frame = this.el('div', 'frame card', this.menuRoot);
    const inner = this.el('div', 'hud-menu-inner', frame);

    const hero = this.el('div', 'menu-hero', inner);
    const title = this.el('h1', 'menu-title', hero);
    title.textContent = 'CSP';
    const sub = this.el('div', 'menu-sub', hero);
    sub.textContent = 'COUNTER-STRIKE PROTOTYPE';

    const btns = this.el('div', 'menu-btns', hero);
    const start = this.el('button', 'btn', btns);
    start.type = 'button';
    start.textContent = 'Start';
    start.addEventListener('click', () => this.resume());
    const resume = this.el('button', 'btn hud-ghost', btns);
    resume.type = 'button';
    resume.textContent = 'Resume';
    resume.addEventListener('click', () => this.resume());
    this.menuResumeBtn = resume;
    const restart = this.el('button', 'btn hud-ghost', btns);
    restart.type = 'button';
    restart.textContent = 'Restart match';
    restart.addEventListener('click', () => this.onMenuAction('restart'));
    const settings = this.el('button', 'btn hud-ghost', btns);
    settings.type = 'button';
    settings.textContent = 'Settings';
    settings.addEventListener('click', () => this.onMenuAction('settings'));
    const quit = this.el('button', 'btn hud-ghost', btns);
    quit.type = 'button';
    quit.textContent = 'Quit';
    quit.addEventListener('click', () => this.onMenuAction('quit'));

    const foot = this.el('div', 'menu-foot mono', hero);
    foot.textContent = `Map ${mapLabel(this.map?.name ?? 'de_dust2_lite')} · first to 13 rounds (MR12)`;

    const right = this.el('div', 'menu-col', inner);
    const ctrlTitle = this.el('div', 'panel-title', right);
    ctrlTitle.textContent = 'Controls';
    const ctrl = this.el('table', 'ctrl-table', right);
    for (const [keys, desc] of CONTROLS) {
      const tr = this.el('tr', undefined, ctrl);
      const k = this.el('td', 'k', tr);
      for (const key of keys.split(' / ')) {
        const kb = this.el('span', 'kbd', k);
        kb.textContent = key;
      }
      const d = this.el('td', 'd', tr);
      d.textContent = desc;
    }
    const howTitle = this.el('div', 'panel-title', right);
    howTitle.style.marginTop = '0.9em';
    howTitle.textContent = 'How to play';
    const how = this.el('ol', 'howto', right);
    for (const line of HOW_TO_PLAY) {
      const li = this.el('li', undefined, how);
      li.textContent = line;
    }
  }

  private buildBands(): void {
    const left = this.el('div', 'hud-left', this.root);

    const health = this.el('div', 'band card', left);
    const hRow = this.el('div', 'row', health);
    this.el('div', 'icon', hRow).appendChild(makeHealthGlyph(this.doc));
    this.healthEl = this.el('div', 'val mono', hRow);
    this.healthEl.textContent = '100';
    const hSub = this.el('div', 'sub', health);
    hSub.textContent = 'Health';

    const armor = this.el('div', 'band card', left);
    const aRow = this.el('div', 'row', armor);
    this.el('div', 'icon', aRow).appendChild(makeArmorGlyph(this.doc));
    this.armorEl = this.el('div', 'val mono', aRow);
    this.armorEl.textContent = '0';
    this.armorIcon = this.el('span', 'sub mono', aRow);
    this.armorIcon.textContent = 'NO HELMET';
    const aSub = this.el('div', 'row', armor);
    this.defuseKitEl = this.el('span', 'kit mono hud-off', aSub);
    this.defuseKitEl.textContent = 'KIT';

    const right = this.el('div', 'hud-right', this.root);
    const band = this.el('div', 'band card', right);
    this.weaponEl = this.el('div', 'hud-weapon', band);
    this.weaponEl.textContent = '—';
    const ammo = this.el('div', 'hud-ammo', band);
    this.magEl = this.el('div', 'mag mono', ammo);
    this.magEl.textContent = '0';
    this.el('div', 'slash mono', ammo).textContent = '/';
    this.reserveEl = this.el('div', 'res mono', ammo);
    this.reserveEl.textContent = '0';
    this.reloadEl = this.el('div', 'hud-reload hud-hidden', band);
    this.reloadFill = this.el('div', 'fill', this.reloadEl);
  }

  private buildDebug(): void {
    this.debugEl = this.el('div', 'hud-debug mono hud-hidden', this.root);
  }

  // -------------------------------------------------------------------------
  // attach / detach
  // -------------------------------------------------------------------------

  /** Subscribe to the simulation bus. Idempotent across repeated calls. */
  attach(bus: EventBus = defaultBus): void {
    if (this.attached || this.disposed) return;
    this.attached = true;

    this.offs.push(
      bus.on('death', (p) => {
        this.addKillFeed({
          killer: this.actorName(p.killerId),
          victim: this.actorName(p.victimId),
          weapon: p.weaponId,
          headshot: !!p.headshot,
          wallbang: !!p.wallbang,
          killerTeam: this.actorTeam(p.killerId),
          victimTeam: this.actorTeam(p.victimId),
        });
      }),
      bus.on('hit', (p) => {
        if (p.shooterId !== this.localBlipId()) return;
        this.showHitMarker(p.hitGroup === 'head', !!p.killed);
      }),
      bus.on('reload', (p) => {
        if (p.actorId !== this.localBlipId()) return;
        this.eff.reloadStart = this.now();
        this.eff.reloadDuration = Math.max(0.05, toFinite(p.duration, 2.5));
      }),
      bus.on('flash', (p) => this.applyFlash(toFinite(p.intensity, 1))),
      bus.on('announce', (p) => this.announce(p.text, p.kind)),
      bus.on('roundEnd', (p) => this.showRoundEnd(p)),
      bus.on('bombPlanted', (p) => this.announce(`Bomb planted at site ${p.site}`, 'info')),
      bus.on('bombDefused', () => this.announce('Bomb defused', 'round')),
      bus.on('bombExploded', (p) => this.announce(`Bomb exploded at site ${p.site}`, 'round')),
      bus.on('roundPhase', (p) => {
        if (p.phase === 'live' && this.lastPhase === 'freeze') this.announce(`Round ${p.roundNumber} — go`, 'round');
        else if (p.phase === 'freeze') this.announce(`Round ${p.roundNumber} — buy time`, 'info');
        this.lastPhase = p.phase;
      }),
    );

    this.keyHandler = (e: KeyboardEvent) => this.onKeyDown(e);
    this.doc.addEventListener('keydown', this.keyHandler, true);

    // Clicking the world resumes pointer lock while a cursor panel is open.
    this.canvasClickHandler = (e: MouseEvent) => {
      if (e.target !== this.gameCanvas) return;
      if (this.wantsCursor()) return;
      this.onRequestPointerLock();
    };
    this.doc.addEventListener('click', this.canvasClickHandler, true);
  }

  /** Unsubscribe and remove every external listener. Idempotent. */
  detach(): void {
    if (!this.attached) return;
    this.attached = false;
    for (const off of this.offs) {
      try {
        off();
      } catch {
        /* the bus may already have been cleared */
      }
    }
    this.offs = [];
    if (this.keyHandler) {
      this.doc.removeEventListener('keydown', this.keyHandler, true);
      this.keyHandler = null;
    }
    if (this.canvasClickHandler) {
      this.doc.removeEventListener('click', this.canvasClickHandler, true);
      this.canvasClickHandler = null;
    }
    this.lastPhase = '';
  }

  // -------------------------------------------------------------------------
  // Per-frame API
  // -------------------------------------------------------------------------

  /** Called once per rendered frame by the engine. */
  setState(s: HudFrameState): void {
    if (this.disposed) return;
    this.state = s;
    this.applyState();
  }

  /** Called once per simulation tick / frame with every actor. */
  setActors(actors: RadarBlip[]): void {
    if (this.disposed) return;
    this.blips = Array.isArray(actors) ? actors : [];
    this.applyState();
  }

  setSpotted(ids: number[]): void {
    this.spotted.clear();
    for (const id of ids ?? []) this.spotted.add(id);
    const local = this.localBlipId();
    if (local >= 0) this.spotted.add(local);
  }

  announce(text: string, kind: AnnounceKind = 'info'): void {
    if (this.disposed || !text) return;
    // textContent: announcements may embed player names — never innerHTML.
    this.announceEl.textContent = text;
    this.announceEl.style.color = announceColor(kind);
    this.announceEl.dataset['born'] = String(this.now());
    this.announceEl.style.opacity = '1';
    this.announceEl.classList.remove('hud-hidden');
  }

  addKillFeed(entry: KillFeedEntry): void {
    if (this.disposed) return;
    const row = this.el('div', 'hud-feed-row');

    const killer = this.el('span', 'nm', row);
    killer.textContent = entry.killer;
    killer.style.color = teamColor(entry.killerTeam);
    if (entry.killer === this.playerName) killer.classList.add('hud-local');

    const ic = this.el('span', 'ic', row);
    ic.textContent = entry.headshot ? '⌖' : '✕';
    if (entry.headshot) ic.classList.add('hs');

    const weapon = this.el('span', 'ic mono', row);
    weapon.textContent = weaponLabel(entry.weapon);

    if (entry.wallbang) {
      const wb = this.el('span', 'wb mono', row);
      wb.textContent = 'WB';
    }

    const victim = this.el('span', 'nm', row);
    victim.textContent = entry.victim;
    victim.style.color = teamColor(entry.victimTeam);
    if (entry.victim === this.playerName) victim.classList.add('hud-local');

    // Newest on top.
    this.feedEl.insertBefore(row, this.feedEl.firstChild);
    this.feed.unshift({ el: row, born: this.now() });
    while (this.feed.length > MAX_FEED) {
      const old = this.feed.pop();
      old?.el.remove();
    }
  }

  /** Damage indicator arc; `angle` is radians clockwise relative to the view. */
  addDamageIndicator(angle: number, damage: number): void {
    if (this.disposed) return;
    const el = this.el('div', 'hud-dmg', this.dmgLayer);
    const a = toFinite(angle, 0);
    el.style.transform = `rotate(${((a * 180) / Math.PI).toFixed(3)}deg)`;
    el.dataset['damage'] = String(Math.round(toFinite(damage, 0)));
    this.dmgIndicators.push({ el, angle: a, born: this.now() });
    while (this.dmgIndicators.length > MAX_DAMAGE_ARROWS) {
      const old = this.dmgIndicators.shift();
      old?.el.remove();
    }
  }

  /** Hit marker: red + bigger for a headshot, an extra burst when it killed. */
  showHitMarker(headshot: boolean, killed: boolean): void {
    if (this.disposed) return;
    this.eff.hit = 0;
    this.hitMarkerEl.classList.remove('hud-off');
    this.hitMarkerEl.classList.toggle('hud-hs', !!headshot);
    this.hitMarkerEl.classList.toggle('hud-kill', !!killed);
    // Restart the CSS pop deterministically (the animation is only a flourish;
    // the authoritative fade is applied per frame from `eff.hit`).
    this.hitMarkerEl.style.animation = 'none';
    void this.hitMarkerEl.offsetWidth;
    this.hitMarkerEl.style.animation = '';
  }

  setBuyMenuOpen(open: boolean): void {
    if (this.disposed) return;
    if (open) this.buy.show();
    else this.buy.hide();
  }

  getBuyMenuOpen(): boolean {
    return this.buy.isOpen;
  }

  /** True when the HUD currently wants the mouse cursor instead of pointer lock. */
  wantsCursor(): boolean {
    return this.buy.isOpen || this.score.isMatchVisible || this.isMainMenuOpen();
  }

  setScoreboardOpen(open: boolean): void {
    if (this.disposed) return;
    if (open) this.score.show();
    else this.score.hide();
  }

  getScoreboardOpen(): boolean {
    return this.score.isOpen;
  }

  /**
   * Roster snapshot for the in-game TAB scoreboard. The engine owns the match
   * state, so it pushes rows here (cheap enough to refresh while the board is
   * open, and pointless to build when it is closed).
   */
  setScoreRows(rows: readonly ScoreRow[]): void {
    if (this.disposed) return;
    this.score.setRows(rows);
  }

  /** Drop the round-result banner and the match-end panel (used on restart). */
  clearResults(): void {
    if (this.disposed) return;
    this.score.hideResult();
    this.score.hideMatchEnd();
  }

  showRoundEnd(payload: { winner: Team; reason: string; scoreT: number; scoreCT: number }): void {
    if (this.disposed) return;
    this.score.showResult(payload.winner, payload.reason, payload.scoreT, payload.scoreCT);
    this.announce(
      `${payload.winner === 'CT' ? 'Counter-Terrorists win' : payload.winner === 'T' ? 'Terrorists win' : 'Round over'} — ${payload.reason}`,
      'round',
    );
  }

  hideRoundEnd(): void {
    this.score.hideResult();
  }

  showMatchEnd(payload: { winner: Team; scoreT: number; scoreCT: number; scoreboard: ScoreRow[] }): void {
    if (this.disposed) return;
    this.score.hideResult();
    this.score.showMatchEnd(payload.winner, payload.scoreT, payload.scoreCT, payload.scoreboard ?? []);
  }

  showMainMenu(show: boolean): void {
    if (this.disposed) return;
    this.menuRoot.classList.toggle('hud-hidden', !show);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detach();
    this.setGameFilter(null);
    for (const rec of this.feed) rec.el.remove();
    this.feed = [];
    for (const rec of this.dmgIndicators) rec.el.remove();
    this.dmgIndicators = [];
    this.spotted.clear();
    this.buy.dispose();
    this.score.dispose();
    this.radarCtx = null;
    this.radarBase = null;
    this.radarBaseMap = null;
    this.root.remove();
  }

  // -------------------------------------------------------------------------
  // Keyboard (ONE listener, shared by buy menu / scoreboard / menu)
  // -------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (this.disposed) return;

    if (this.buy.isOpen) {
      if (this.buy.handleKeyDown(e)) {
        e.preventDefault();
        e.stopPropagation();
      }
      return;
    }

    if (!this.handleGlobalKeys) return;

    if (e.key === 'Escape') {
      if (this.score.isOpen) {
        this.score.hide();
      } else if (this.isMainMenuOpen()) {
        this.showMainMenu(false);
        this.onRequestPointerLock();
      } else {
        this.showMainMenu(true);
        this.onMenuAction('pause');
      }
      e.preventDefault();
      return;
    }

    if (e.key === 'Tab') {
      this.score.toggle();
      e.preventDefault();
      return;
    }

    if (e.key === 'b' || e.key === 'B') {
      this.setBuyMenuOpen(!this.buy.isOpen);
      e.preventDefault();
    }
  }

  private resume(): void {
    this.showMainMenu(false);
    this.onRequestPointerLock();
  }

  private now(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now() / 1000;
    return Date.now() / 1000;
  }

  // -------------------------------------------------------------------------
  // Frame application
  // -------------------------------------------------------------------------

  private applyState(): void {
    if (this.disposed) return;
    const now = this.now();
    const dt = this.eff.now > 0 ? Math.min(0.25, Math.max(0, now - this.eff.now)) : 0;
    this.eff.now = now;
    if (this.eff.hit >= 0) {
      this.eff.hit += dt;
      if (this.eff.hit > 2) this.eff.hit = -1;
    }

    const s = this.state;
    const bombOn = !!(s.bombPlanted || s.phase === 'bomb');

    // Flash watchdog: the engine keeps publishing `flashAmount`; when it jumps,
    // restart the envelope so the attack/decay is owned entirely by the HUD.
    const flash = clamp(toFinite(s.flashAmount, 0), 0, 1);
    if (flash > 0.02 && flash > this.eff.lastFlashSeen + FLASH_WATCHDOG) {
      this.eff.flashStart = now;
      this.eff.flashAmount = flash;
    }
    this.eff.lastFlashSeen = flash;
    if (this.eff.flashStart > 0 && now - this.eff.flashStart > FLASH_LIFETIME) this.eff.flashStart = 0;

    this.drawRadar();

    // ---- money ----------------------------------------------------------
    const money = formatMoney(s.money);
    if (this.moneyEl.textContent !== money) this.moneyEl.textContent = money;
    this.moneyEl.classList.toggle('hud-low', toFinite(s.money, 0) < 1000);

    // ---- round clock + score -------------------------------------------
    const clockText = formatClock(s.timeLeft);
    if (this.clockEl.textContent !== clockText) this.clockEl.textContent = clockText;
    this.clockEl.classList.toggle('hud-bomb', bombOn);
    this.clockEl.classList.toggle('hud-freeze', !bombOn && s.phase === 'freeze');
    this.clockEl.classList.toggle('hud-live', !bombOn && s.phase === 'live');
    this.clockEl.classList.toggle('hud-over', !bombOn && s.phase === 'over');
    const warn = !bombOn && s.phase === 'live' && toFinite(s.timeLeft, 0) <= 10;
    this.clockEl.style.color = warn ? '#ff8a3d' : bombOn ? '#ff4d4d' : '';

    const scoreText = scoreLine(s.scoreT, s.scoreCT);
    if (this.scoreEl.textContent !== scoreText) this.scoreEl.textContent = scoreText;
    const roundText = `Round ${Math.max(1, Math.floor(toFinite(s.roundNumber, 1)))} · MR12`;
    if (this.roundNoEl.textContent !== roundText) this.roundNoEl.textContent = roundText;

    // ---- health / armour -----------------------------------------------
    const hp = Math.max(0, Math.round(toFinite(s.health, 0)));
    const hpText = String(hp);
    if (this.healthEl.textContent !== hpText) this.healthEl.textContent = hpText;
    this.healthEl.style.color = healthColor(hp);
    this.healthEl.classList.toggle('hud-low', hp <= 25);

    const ap = Math.max(0, Math.round(toFinite(s.armor, 0)));
    const apText = String(ap);
    if (this.armorEl.textContent !== apText) this.armorEl.textContent = apText;
    this.armorEl.style.color = ap === 0 ? '#98a4b3' : healthColor(Math.max(ap, 26));
    this.armorIcon.textContent = s.helmet ? 'HELMET' : 'NO HELMET';
    this.armorIcon.style.color = s.helmet ? '#8affd1' : '#6d7787';
    this.defuseKitEl.classList.toggle('hud-off', !s.hasDefuseKit);

    // ---- weapon + ammo --------------------------------------------------
    const name = s.weaponName || weaponLabel(s.weaponId) || '—';
    if (this.weaponEl.textContent !== name) this.weaponEl.textContent = name;
    const mag = Math.max(0, Math.floor(toFinite(s.ammo, 0)));
    const magText = String(mag);
    if (this.magEl.textContent !== magText) this.magEl.textContent = magText;
    this.magEl.classList.toggle('hud-empty', mag === 0);
    const resText = String(Math.max(0, Math.floor(toFinite(s.reserve, 0))));
    if (this.reserveEl.textContent !== resText) this.reserveEl.textContent = resText;

    const reloading = !!s.isReloading;
    this.reloadEl.classList.toggle('hud-hidden', !reloading);
    if (reloading) {
      const dur = this.eff.reloadDuration > 0 ? this.eff.reloadDuration : 2.5;
      const elapsed = this.eff.reloadStart >= 0 ? now - this.eff.reloadStart : 0;
      const progress = clamp(elapsed / dur, 0, 1);
      this.reloadFill.style.width = `${(progress <= 0 ? 0.02 : progress) * 100}%`;
    } else {
      this.eff.reloadStart = -1;
      this.reloadFill.style.width = '0%';
    }

    // ---- bomb -----------------------------------------------------------
    this.bombEl.classList.toggle('hud-hidden', !bombOn);
    if (bombOn) {
      this.bombTimerEl.textContent = formatBombClock(s.bombTimer);
      this.bombSiteEl.textContent = s.bombSite ? `Site ${s.bombSite}` : '';
    }
    const defusing = !!(s.defusing && bombOn);
    this.defuseEl.classList.toggle('hud-hidden', !defusing);
    if (defusing) this.defuseFill.style.width = `${clamp(toFinite(s.defuseProgress, 0), 0, 1) * 100}%`;

    // ---- effects --------------------------------------------------------
    this.updateCrosshair();
    this.updateHitMarker();
    this.updateDamageIndicators();
    this.updateFlash();
    this.updateAnnounce();
    this.updateFeed();
    this.setStateDead(!!s.dead);

    // ---- fps ------------------------------------------------------------
    const fps = toFinite(s.fps, 0);
    this.debugEl.classList.toggle('hud-hidden', !(fps > 0));
    if (fps > 0) this.debugEl.textContent = `${Math.round(fps)} fps · ${mapLabel(this.map?.name ?? '')}`;

    // ---- panels ---------------------------------------------------------
    const owned = s.hasDefuseKit ? [s.weaponId, 'defusekit'] : [s.weaponId];
    this.buy.setOwned(owned);
    this.buy.update(s.money, s.timeLeft, s.phase);
    this.score.setScore(s.scoreT, s.scoreCT);
  }

  private updateCrosshair(): void {
    const s = this.state;
    const px = crosshairPixels(s?.crosshairGap, s?.crosshairLength, s?.crosshairThickness);
    const { length: len, thickness: thick, gap } = px;
    this.crosshairEl.style.setProperty('--xh-thick', `${thick}px`);
    this.crosshairEl.style.setProperty('--xh-outline', `${px.outline}px`);

    // arms: 0 = up, 1 = down, 2 = left, 3 = right (all rendered as rects)
    for (let i = 0; i < 4; i++) {
      const line = this.crosshairLines[i];
      const horizontal = i >= 2;
      line.style.width = `${horizontal ? len : thick}px`;
      line.style.height = `${horizontal ? thick : len}px`;
      const outward = i === 1 || i === 3 ? gap : -(gap + len);
      line.style.transform = horizontal
        ? `translate(${outward}px, ${-thick / 2}px)`
        : `translate(${-thick / 2}px, ${outward}px)`;
      line.style.background = this.crosshairColor;
    }
    this.crosshairDot.classList.toggle('hud-hidden', !s?.crosshairDot);
    this.crosshairDot.style.background = this.crosshairColor;
  }

  private updateHitMarker(): void {
    if (this.eff.hit < 0) {
      this.hitMarkerEl.classList.add('hud-off');
      return;
    }
    const alpha = hitMarkerAlpha(this.eff.hit, 0.25);
    if (alpha <= 0) {
      this.hitMarkerEl.classList.add('hud-off');
      this.eff.hit = -1;
      return;
    }
    this.hitMarkerEl.style.opacity = String(alpha);
  }

  private updateDamageIndicators(): void {
    if (this.dmgIndicators.length === 0) return;
    const keep: DamageRecord[] = [];
    for (const rec of this.dmgIndicators) {
      const st = damageIndicatorState(this.eff.now - rec.born, 1.5);
      if (st.progress >= 1) {
        rec.el.remove();
        continue;
      }
      rec.el.style.opacity = String(st.opacity);
      const deg = ((rec.angle * 180) / Math.PI).toFixed(3);
      rec.el.style.transform = `rotate(${deg}deg) scale(${(1 + 0.22 * st.progress).toFixed(3)})`;
      keep.push(rec);
    }
    this.dmgIndicators = keep;
  }

  private updateFlash(): void {
    const raw = clamp(toFinite(this.state?.flashAmount, 0), 0, 1);
    const age = this.eff.flashStart > 0 ? this.eff.now - this.eff.flashStart : 0;
    const env = flashEnvelope(raw, age);
    this.flashEl.style.opacity = String(clamp(env.opacity, 0, 1));
    this.dmgFlashEl.style.opacity = String(clamp(toFinite(this.state?.damageFlash, 0), 0, 1));
  }

  private updateAnnounce(): void {
    if (this.announceEl.classList.contains('hud-hidden')) return;
    const born = Number(this.announceEl.dataset['born'] ?? this.eff.now);
    const alpha = announceAlpha(this.eff.now - born, 2.5, 0.55);
    if (alpha <= 0) {
      this.announceEl.classList.add('hud-hidden');
      delete this.announceEl.dataset['born'];
      this.announceEl.style.opacity = '';
      return;
    }
    this.announceEl.style.opacity = alpha >= 1 ? '1' : String(alpha);
  }

  private updateFeed(): void {
    if (this.feed.length === 0) return;
    const keep: FeedRecord[] = [];
    for (const rec of this.feed) {
      const alpha = feedAlpha(this.eff.now - rec.born, 6, 1.3);
      if (alpha <= 0) {
        rec.el.remove();
        continue;
      }
      if (alpha < 1) rec.el.style.opacity = String(alpha);
      keep.push(rec);
    }
    this.feed = keep;
  }

  private setStateDead(dead: boolean): void {
    this.root.classList.toggle('hud-dead', dead);
    this.deadEl.classList.toggle('hud-hidden', !dead);
    this.setGameFilter(dead ? 'saturate(0.3) brightness(0.55)' : null);
  }

  /** Desaturate the WebGL canvas only — HUD panels keep their own colours. */
  private setGameFilter(filter: string | null): void {
    if (!this.gameCanvas && typeof this.doc.querySelector === 'function') {
      this.gameCanvas = this.doc.querySelector('canvas');
    }
    const canvas = this.gameCanvas;
    if (!canvas || !canvas.style) return;
    if (filter) canvas.style.filter = filter;
    else canvas.style.removeProperty('filter');
  }

  // -------------------------------------------------------------------------
  // Radar
  // -------------------------------------------------------------------------

  private rebuildRadarBase(): void {
    const size = PERF.radarSize;
    const canvas = this.doc.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const g = canvas.getContext('2d');
    if (!g) {
      this.radarBase = null;
      this.radarBaseMap = null;
      return;
    }
    this.radarBase = canvas;
    this.radarBaseMap = this.map;
    this.drawRadarBase(g, size);
  }

  /**
   * Bake the STATIC map layer once: every non-clip brush footprint as a filled
   * rectangle (floors lighter than walls), bomb sites tinted with an A/B
   * label, callout labels and a compass N. Per frame we only blit this bitmap
   * and draw blips on top — the base is re-baked only if `map` changes.
   */
  private drawRadarBase(g: CanvasRenderingContext2D, size: number): void {
    g.clearRect(0, 0, size, size);
    g.fillStyle = 'rgba(6,12,18,0.72)';
    g.fillRect(0, 0, size, size);

    const map = this.map;
    if (!map) return;

    g.strokeStyle = 'rgba(255,255,255,0.05)';
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      const p = (i / 8) * size;
      g.beginPath();
      g.moveTo(p, 0);
      g.lineTo(p, size);
      g.moveTo(0, p);
      g.lineTo(size, p);
      g.stroke();
    }

    const floors: [number, number, number, number][] = [];
    const walls: [number, number, number, number][] = [];
    for (const brush of map.brushes ?? []) {
      if (brush.clip) continue; // clip brushes are invisible collision volumes
      const box = this.brushFootprint(brush, size);
      if (!box) continue;
      if (toFinite(brush.size?.y, 0) <= 48) floors.push(box);
      else walls.push(box);
    }

    g.globalAlpha = 0.3;
    g.fillStyle = '#8fb0cf';
    for (const b of floors) g.fillRect(b[0], b[1], b[2], b[3]);
    g.globalAlpha = 0.92;
    g.fillStyle = '#2f3d4d';
    for (const b of walls) g.fillRect(b[0], b[1], b[2], b[3]);
    g.globalAlpha = 1;
    g.strokeStyle = 'rgba(190,215,240,0.2)';
    g.lineWidth = 1;
    for (const b of walls) g.strokeRect(b[0] + 0.5, b[1] + 0.5, Math.max(0, b[2] - 1), Math.max(0, b[3] - 1));

    for (const site of map.sites ?? []) {
      const poly = site.poly ?? [];
      if (poly.length < 3) continue;
      g.globalAlpha = 0.6;
      g.fillStyle = '#c0703a';
      g.beginPath();
      let cx = 0;
      let cy = 0;
      for (let i = 0; i < poly.length; i++) {
        const p = projectToRadar(map, { x: poly[i][0], y: 0, z: poly[i][1] });
        cx += p.u;
        cy += p.v;
        if (i === 0) g.moveTo(p.u * size, p.v * size);
        else g.lineTo(p.u * size, p.v * size);
      }
      g.closePath();
      g.fill();
      g.globalAlpha = 1;
      g.strokeStyle = 'rgba(255,214,150,0.75)';
      g.lineWidth = 2;
      g.stroke();

      g.fillStyle = 'rgba(10,10,10,0.9)';
      g.font = `bold ${Math.round(size * 0.062)}px ui-monospace, monospace`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(site.site, (cx / poly.length) * size, (cy / poly.length) * size);
    }

    g.font = `${Math.round(size * 0.029)}px ui-monospace, monospace`;
    g.fillStyle = 'rgba(226,236,247,0.45)';
    let shown = 0;
    for (const calloutName of Object.keys(map.callouts ?? {})) {
      if (shown >= 14) break;
      const at = map.callouts[calloutName];
      if (!at) continue;
      const p = projectToRadar(map, at);
      g.fillText(calloutName.toUpperCase(), p.u * size, p.v * size);
      shown++;
    }

    // compass
    g.fillStyle = 'rgba(230,240,250,0.8)';
    g.font = `bold ${Math.round(size * 0.05)}px ui-monospace, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('N', size - size * 0.075, size * 0.085);
    g.strokeStyle = 'rgba(230,240,250,0.5)';
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(size - size * 0.075, size * 0.115);
    g.lineTo(size - size * 0.075, size * 0.155);
    g.stroke();
  }

  /** Project a yaw-rotated brush box to its radar-space bounding rectangle. */
  private brushFootprint(brush: Brush, size: number): [number, number, number, number] | null {
    const hx = Math.abs(toFinite(brush.size?.x, 0)) / 2;
    const hz = Math.abs(toFinite(brush.size?.z, 0)) / 2;
    if (!(hx > 0) || !(hz > 0)) return null;
    const yaw = toFinite(brush.yaw, 0);
    const c = Math.abs(Math.cos(yaw));
    const s = Math.abs(Math.sin(yaw));
    const ex = hx * c + hz * s;
    const ez = hx * s + hz * c;
    const cx = toFinite(brush.pos?.x, 0);
    const cz = toFinite(brush.pos?.z, 0);
    const a = projectToRadar(this.map, { x: cx - ex, y: 0, z: cz - ez });
    const b = projectToRadar(this.map, { x: cx + ex, y: 0, z: cz + ez });
    const w = Math.abs(b.u - a.u) * size;
    const h = Math.abs(b.v - a.v) * size;
    if (w < 1 || h < 1) return null;
    return [Math.min(a.u, b.u) * size, Math.min(a.v, b.v) * size, w, h];
  }

  /** Per frame: blit the baked map, then draw every blip on top. */
  private drawRadar(): void {
    const g = this.radarCtx;
    if (!g) return;
    if (this.radarBaseMap !== this.map) this.rebuildRadarBase();
    const size = PERF.radarSize;

    if (this.radarBase) g.drawImage(this.radarBase, 0, 0);
    else {
      g.clearRect(0, 0, size, size);
      g.fillStyle = 'rgba(6,12,18,0.72)';
      g.fillRect(0, 0, size, size);
    }

    const r = this.blipRadiusPx;
    const localId = this.localBlipId();

    for (const blip of this.blips) {
      if (blip.hasBomb && blip.alive) this.drawBlip(g, blip, r, size, false, true);
    }
    for (const blip of this.blips) {
      if (blip.isLocal || blip.id === localId) continue;
      if (!blip.alive) continue;
      if (!this.isVisibleBlip(blip)) continue;
      this.drawBlip(g, blip, r, size, false, false);
    }
    for (const blip of this.blips) {
      if (!blip.isLocal && blip.id !== localId) continue;
      this.drawBlip(g, blip, r * 1.25, size, true, false);
    }
  }

  /** An enemy is only drawn when the local team has spotted them. */
  private isVisibleBlip(blip: RadarBlip): boolean {
    if (blip.team === 'SPEC') return false;
    if (blip.spotted || this.spotted.has(blip.id)) return true;
    // The simulation only marks enemies spotted; teammates are always visible.
    return blip.team === this.state.team;
  }

  private drawBlip(
    g: CanvasRenderingContext2D,
    blip: RadarBlip,
    r: number,
    size: number,
    local: boolean,
    bombMarker: boolean,
  ): void {
    const p = projectToRadar(this.map, blip.pos);
    if (!Number.isFinite(p.u) || !Number.isFinite(p.v)) return;
    if (p.u < -0.08 || p.u > 1.08 || p.v < -0.08 || p.v > 1.08) return;
    const x = p.u * size;
    const y = p.v * size;
    const dead = !blip.alive;

    g.save();
    g.globalAlpha = dead ? 0.28 : 1;

    if (local) {
      // White arrow rotated by yaw. Radar v grows south (+Z), so the standard
      // canvas rotation maps world yaw straight onto the screen.
      g.translate(x, y);
      g.rotate(toFinite(blip.yaw, 0));
      const pts = arrowPoints(0, 0, r * 1.5);
      g.beginPath();
      g.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
      g.closePath();
      g.fillStyle = BLIP_COLOR_LOCAL;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(0,0,0,0.9)';
      g.stroke();
    } else {
      const color = this.blipColor(blip);
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fillStyle = color;
      g.fill();
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(0,0,0,0.85)';
      g.stroke();
    }

    if (bombMarker || (blip.hasBomb && blip.alive)) {
      const pulse = 0.55 + 0.45 * Math.abs(Math.sin(this.eff.now * 4.2));
      g.globalAlpha = pulse;
      g.beginPath();
      g.arc(x, y - 0, r * 1.9, 0, Math.PI * 2);
      g.fillStyle = BOMB_COLOR;
      g.fill();
      g.globalAlpha = 1;
      g.lineWidth = 1.5;
      g.strokeStyle = 'rgba(255,255,255,0.85)';
      g.stroke();
    }
    g.restore();
  }

  private blipColor(blip: RadarBlip): string {
    const spotted = blip.spotted || this.spotted.has(blip.id);
    if (blip.team === 'T') {
      if (blip.team === this.state.team) return BLIP_COLOR_TEAM;
      return spotted ? '#ff6b3d' : BLIP_COLOR_UNKNOWN;
    }
    if (blip.team === 'CT') {
      if (blip.team === this.state.team) return BLIP_COLOR_TEAM;
      return spotted ? '#ff6b3d' : BLIP_COLOR_UNKNOWN;
    }
    return BLIP_COLOR_UNKNOWN;
  }

  private localBlipId(): number {
    for (const blip of this.blips) if (blip.isLocal) return blip.id;
    return -1;
  }

  private applyFlash(intensity: number): void {
    const value = clamp(intensity, 0, 1);
    this.eff.flashAmount = value;
    this.eff.flashStart = this.now();
    this.eff.lastFlashSeen = value;
  }

  private actorName(id: number): string {
    const blip = this.blipById(id);
    if (blip) return blip.isLocal ? this.playerName : `BOT-${blip.id}`;
    return id < 0 ? 'World' : `#${id}`;
  }

  private actorTeam(id: number): Team {
    const blip = this.blipById(id);
    return blip ? blip.team : 'SPEC';
  }

  private blipById(id: number): RadarBlip | undefined {
    for (const blip of this.blips) if (blip.id === id) return blip;
    return undefined;
  }

  private isMainMenuOpen(): boolean {
    return !this.menuRoot.classList.contains('hud-hidden');
  }
}

// ---------------------------------------------------------------------------
// Glyph helpers (pure DOM + CSS: no emoji / icon-font dependency)
// ---------------------------------------------------------------------------

function makeHealthGlyph(doc: Document): HTMLDivElement {
  const g = doc.createElement('div');
  g.style.position = 'relative';
  g.style.width = '1.05em';
  g.style.height = '1.05em';
  const bar = doc.createElement('div');
  bar.style.position = 'absolute';
  bar.style.left = '0';
  bar.style.top = '50%';
  bar.style.width = '100%';
  bar.style.height = '26%';
  bar.style.transform = 'translateY(-50%)';
  bar.style.background = '#ff4d6d';
  bar.style.borderRadius = '2px';
  const stem = doc.createElement('div');
  stem.style.position = 'absolute';
  stem.style.top = '0';
  stem.style.left = '50%';
  stem.style.height = '100%';
  stem.style.width = '26%';
  stem.style.transform = 'translateX(-50%)';
  stem.style.background = '#ff4d6d';
  stem.style.borderRadius = '2px';
  g.appendChild(bar);
  g.appendChild(stem);
  return g;
}

function makeArmorGlyph(doc: Document): HTMLDivElement {
  const g = doc.createElement('div');
  g.style.width = '1.05em';
  g.style.height = '1.05em';
  g.style.background = '#5aa9ff';
  g.style.opacity = '0.85';
  g.style.clipPath = 'polygon(50% 0%, 100% 22%, 100% 62%, 50% 100%, 0% 62%, 0% 22%)';
  return g;
}

function makeDefaultState(): HudFrameState {
  return {
    health: 100,
    armor: 0,
    helmet: false,
    hasDefuseKit: false,
    ammo: 30,
    reserve: 90,
    magazine: 30,
    weaponName: '',
    weaponId: 'ak47',
    isReloading: false,
    money: 800,
    team: 'CT',
    phase: 'freeze',
    roundNumber: 1,
    timeLeft: 0,
    scoreT: 0,
    scoreCT: 0,
    bombPlanted: false,
    bombTimer: 0,
    bombSite: null,
    defusing: false,
    defuseProgress: 0,
    crosshairGap: 4,
    crosshairLength: 8,
    crosshairThickness: 2,
    crosshairDot: false,
    flashAmount: 0,
    damageFlash: 0,
    dead: false,
    fps: 0,
  };
}

// ---------------------------------------------------------------------------
// Static menu content (mirrors the binds documented in the game README)
// ---------------------------------------------------------------------------

const CONTROLS: [string, string][] = [
  ['W / A / S / D', 'Move'],
  ['Mouse', 'Look'],
  ['Left click', 'Fire'],
  ['Right click', 'Scope / special'],
  ['R', 'Reload'],
  ['E', 'Use — plant / defuse'],
  ['G', 'Drop weapon'],
  ['B', 'Buy menu'],
  ['TAB', 'Scoreboard'],
  ['1 / 2 / 3 / 4 / 5', 'Switch weapon slot'],
  ['SHIFT', 'Walk (slow, silent, accurate)'],
  ['CTRL', 'Crouch'],
  ['SPACE', 'Jump'],
  ['ESC', 'Pause menu'],
];

const HOW_TO_PLAY: string[] = [
  'Buy during freeze time with B — you start with a pistol and $800.',
  'Kills pay cash; save a round when you cannot afford a rifle.',
  'As Terrorist, carry the C4 to a bombsite and hold E to plant it.',
  'As Counter-Terrorist, hold E on the C4 to defuse — a kit halves the time.',
  'Standing still and crouching tightens the crosshair; running ruins accuracy.',
  'First team to 13 rounds wins the match (MR12).',
];

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createHud(opts: HudOptions): Hud {
  return new Hud(opts);
}
