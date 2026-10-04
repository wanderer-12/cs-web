// =============================================================================
// StartMenu.ts — the pre-engine mode picker.
//
// This is the one piece of UI that cannot live inside the HUD, because the HUD
// belongs to an `Engine` and the engine is built *from* the choice made here
// (the mode decides the map, the team layout and the ruleset). It is plain DOM
// in the HUD's own stylesheet idiom, so it looks like the in-game menu.
// =============================================================================

import { MODES } from '../core/config';
import type { MatchModeId } from '../core/config';
import { injectStyles } from './styles';

/** What the player asked for. The host/join cases are served by the LAN layer. */
export type LaunchChoice =
  | { kind: 'solo'; mode: MatchModeId }
  | { kind: 'host' }
  | { kind: 'join'; address: string };

export interface StartMenuOptions {
  /** Where to mount. Defaults to `document.body`. */
  root?: HTMLElement;
  /** The LAN address the page was opened with (`?join=`), if any. */
  addressHint?: string;
  /** Player name typed into the name field (defaults to the launch name). */
  playerName?: string;
  onChoose: (choice: LaunchChoice) => void;
}

export class StartMenu {
  private readonly doc: Document;
  private readonly rootEl: HTMLDivElement;
  private readonly addressEl: HTMLInputElement;
  private readonly nameEl: HTMLInputElement;
  private readonly options: StartMenuOptions;

  constructor(doc: Document, options: StartMenuOptions) {
    this.doc = doc;
    this.options = options;
    injectStyles(doc);

    this.rootEl = doc.createElement('div');
    this.rootEl.className = 'overlay hud-menu hud-startmenu';
    this.rootEl.setAttribute('role', 'dialog');
    this.rootEl.setAttribute('aria-label', '模式选择');

    const frame = doc.createElement('div');
    frame.className = 'frame card';
    this.rootEl.appendChild(frame);

    const inner = doc.createElement('div');
    inner.className = 'hud-menu-inner';
    frame.appendChild(inner);

    const hero = doc.createElement('div');
    hero.className = 'menu-hero';
    inner.appendChild(hero);

    const title = doc.createElement('h1');
    title.className = 'menu-title';
    title.textContent = 'CSP';
    hero.appendChild(title);

    const sub = doc.createElement('div');
    sub.className = 'menu-sub';
    sub.textContent = 'COUNTER-STRIKE PROTOTYPE';
    hero.appendChild(sub);

    const nameRow = doc.createElement('div');
    nameRow.className = 'start-row';
    hero.appendChild(nameRow);
    const nameLabel = doc.createElement('label');
    nameLabel.className = 'start-label';
    nameLabel.textContent = '名字';
    nameRow.appendChild(nameLabel);
    this.nameEl = doc.createElement('input');
    this.nameEl.className = 'start-input mono';
    this.nameEl.type = 'text';
    this.nameEl.maxLength = 16;
    this.nameEl.value = options.playerName ?? '';
    nameRow.appendChild(this.nameEl);

    const btns = doc.createElement('div');
    btns.className = 'menu-btns';
    hero.appendChild(btns);

    const duel = MODES.duel;
    const duelBtn = this.button(
      btns,
      `单挑模式 · 1v3 人机`,
      `小地图 ${duel.mapName} · ${duel.phases
        .map((p) => `${p.rounds} 回合${p.label}`)
        .join(' / ')} · 先到 ${duel.roundsToWin} 回合`,
      () => this.choose({ kind: 'solo', mode: 'duel' }),
    );
    duelBtn.classList.add('btn-primary');

    const classic = MODES.classic;
    const classicBtn = this.button(
      btns,
      '经典模式 · 5v5 人机',
      `de_dust2 · 先到 ${classic.roundsToWin} 回合（MR${classic.roundsToWin - 1}）· 有炸弹`,
      () => this.choose({ kind: 'solo', mode: 'classic' }),
    );
    classicBtn.classList.add('hud-ghost');

    const lanTitle = doc.createElement('div');
    lanTitle.className = 'panel-title';
    lanTitle.textContent = '局域网 1v1（主机在浏览器里当服务器）';
    hero.appendChild(lanTitle);

    const lanBtns = doc.createElement('div');
    lanBtns.className = 'menu-btns';
    hero.appendChild(lanBtns);

    const host = this.button(
      lanBtns,
      '创建房间',
      '本机跑权威模拟，把下面的地址发给朋友；对方在同一局域网内打开它。',
      () => this.choose({ kind: 'host' }),
    );
    host.classList.add('btn-primary');

    const join = this.button(lanBtns, '加入房间', '填主机页面上显示的局域网地址。', () =>
      this.choose({ kind: 'join', address: this.addressEl.value.trim() }),
    );
    join.classList.add('hud-ghost');

    const addrRow = doc.createElement('div');
    addrRow.className = 'start-row';
    hero.appendChild(addrRow);
    const addrLabel = doc.createElement('label');
    addrLabel.className = 'start-label';
    addrLabel.textContent = '主机地址';
    addrRow.appendChild(addrLabel);
    this.addressEl = doc.createElement('input');
    this.addressEl.className = 'start-input mono';
    this.addressEl.type = 'text';
    this.addressEl.placeholder = '例如 192.168.1.23:5174';
    this.addressEl.value = options.addressHint ?? '';
    addrRow.appendChild(this.addressEl);

    const foot = doc.createElement('div');
    foot.className = 'menu-foot mono';
    foot.textContent = '匕首有效距离 1.4 m · 蹲伏左 ALT · E 使用/换枪 · G 丢弃';
    hero.appendChild(foot);

    const right = doc.createElement('div');
    right.className = 'menu-col';
    inner.appendChild(right);

    const about = doc.createElement('div');
    about.className = 'panel-title';
    about.textContent = '怎么打';
    right.appendChild(about);

    const list = doc.createElement('ol');
    list.className = 'howto';
    for (const line of [
      '单挑模式：地图小、箱子多、两条斜坡上高台，中间长通道留给狙击。',
      '前 8 回合只有手枪，第 9 回合起每回合免费发步枪，第 24 回合起换狙击枪。',
      '先赢 17 回合的一方直接获胜（最多 33 回合）。',
      '局域网：一台机器「创建房间」，另一台在同一 WiFi 下「加入房间」填地址。',
    ]) {
      const li = doc.createElement('li');
      li.textContent = line;
      list.appendChild(li);
    }
    right.appendChild(list);

    (options.root ?? doc.body).appendChild(this.rootEl);
  }

  private button(parent: HTMLElement, label: string, hint: string, onClick: () => void): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = 'btn start-btn';
    const strong = this.doc.createElement('span');
    strong.className = 'start-btn-label';
    strong.textContent = label;
    btn.appendChild(strong);
    const small = this.doc.createElement('span');
    small.className = 'start-btn-hint';
    small.textContent = hint;
    btn.appendChild(small);
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
    return btn;
  }

  private choose(choice: LaunchChoice): void {
    const name = this.nameEl.value.trim();
    if (name) this.options.playerName = name;
    this.hide();
    this.options.onChoose(choice);
  }

  /** The player name as typed (the engine wants it at construction time). */
  get playerName(): string {
    return this.nameEl.value.trim() || (this.options.playerName ?? '');
  }

  show(): void {
    this.rootEl.classList.remove('hud-hidden');
  }

  hide(): void {
    this.rootEl.classList.add('hud-hidden');
  }

  dispose(): void {
    this.rootEl.remove();
  }
}