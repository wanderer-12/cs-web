// =============================================================================
// ui/BuyMenu.ts — the counter-strike style buy menu.
//
// Rendered from BUY_MENU / WEAPONS / EQUIPMENT_PRICE, so the shop and the
// simulation can never disagree about prices. The panel is pure DOM and fully
// keyboard operable; it is the only HUD node (besides the menus and the
// scoreboard) that takes `pointer-events: auto`.
//
// Key handling is owned by the caller (Hud) via `handleKeyDown`, so there is
// exactly ONE keydown listener per document no matter how many HUDs exist.
// =============================================================================

import { BUY_MENU, WEAPONS } from '../combat/weaponDefs';
import type { BuyCategory } from './pure';
import {
  affordabilityNote,
  buyKeyIndex,
  canAfford,
  equipmentDescription,
  equipmentLabel,
  formatClock,
  formatMoney,
  itemPrice,
  weaponLabel,
} from './pure';
import { ROOT_CLASS } from './styles';

interface ItemRef {
  id: string;
  el: HTMLButtonElement;
  priceEl: HTMLElement;
}

/** Number keys 1..9 buy an item of the focused category; 1..6 select a category. */
export type BuyFocusMode = 'category' | 'item';

export class BuyMenu {
  readonly root: HTMLDivElement;

  /** Fired with the purchased item id. Endless-buy is the simulation's call. */
  onBuy: (itemId: string) => void = () => {};

  private readonly doc: Document;
  private readonly categories: BuyCategory[] = BUY_MENU as BuyCategory[];
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly cols: HTMLDivElement[] = [];
  private readonly items = new Map<string, ItemRef>();
  private readonly owned = new Set<string>();

  private moneyEl!: HTMLElement;
  private buyTimerEl!: HTMLElement;
  private modeEl!: HTMLElement;

  private open = false;
  private mode: BuyFocusMode = 'item';
  private category = 0;
  private money = 0;
  private timeLeft = 0;
  private phase = 'freeze';

  constructor(doc: Document) {
    this.doc = doc;
    this.root = doc.createElement('div');
    this.root.className = `overlay ${ROOT_CLASS} hud-buy hud-hidden`;
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Buy menu');
    this.build();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private build(): void {
    const frame = this.doc.createElement('div');
    frame.className = 'frame card';

    const head = this.doc.createElement('div');
    head.className = 'buy-head';

    const title = this.doc.createElement('div');
    title.className = 'title';
    title.textContent = 'Buy Menu';

    const stats = this.doc.createElement('div');
    stats.className = 'stats';

    this.buyTimerEl = this.doc.createElement('div');
    this.buyTimerEl.className = 'hint mono';

    this.moneyEl = this.doc.createElement('div');
    this.moneyEl.className = 'mny mono';

    stats.appendChild(this.buyTimerEl);
    stats.appendChild(this.moneyEl);
    head.appendChild(title);
    head.appendChild(stats);

    const tabs = this.doc.createElement('div');
    tabs.className = 'buy-cats';
    this.modeEl = this.doc.createElement('div');
    this.modeEl.className = 'buy-hint-bar';

    const cols = this.doc.createElement('div');
    cols.className = 'buy-cols';

    this.categories.forEach((cat, i) => {
      const tab = this.doc.createElement('button');
      tab.type = 'button';
      tab.className = 'buy-cat';
      const num = this.doc.createElement('span');
      num.className = 'kbd';
      num.textContent = String(i + 1);
      const label = this.doc.createElement('span');
      label.textContent = cat.category;
      tab.appendChild(num);
      tab.appendChild(label);
      tab.addEventListener('click', () => this.focusCategory(i));
      tabs.appendChild(tab);
      this.tabs.push(tab);

      const col = this.doc.createElement('div');
      col.className = 'buy-col';
      const colTitle = this.doc.createElement('div');
      colTitle.className = 'buy-col-title';
      colTitle.textContent = `${i + 1} · ${cat.category}`;
      col.appendChild(colTitle);
      for (const id of cat.items) col.appendChild(this.buildItem(id));
      this.cols.push(col);
      cols.appendChild(col);
    });

    const foot = this.doc.createElement('div');
    foot.className = 'buy-foot';
    foot.textContent =
      'Click an item, or press its number. [ / ] cycle categories, Tab switches the number keys, Esc closes.';

    frame.appendChild(head);
    frame.appendChild(tabs);
    frame.appendChild(cols);
    frame.appendChild(this.modeEl);
    frame.appendChild(foot);

    const foot2 = this.doc.createElement('div');
    foot2.className = 'buy-hint-bar';
    foot2.textContent = 'Purchases are only possible during freeze / buy time.';
    frame.appendChild(foot2);

    this.root.appendChild(frame);
    this.focusCategory(0);
  }

  private buildItem(id: string): HTMLDivElement {
    const row = this.doc.createElement('div');
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = 'buy-item';
    btn.dataset['item'] = id;

    const num = this.doc.createElement('span');
    num.className = 'num mono';
    num.textContent = String(buyKeyIndex(id));

    const name = this.doc.createElement('span');
    name.className = 'nm';
    name.textContent = this.itemName(id);
    name.title = this.itemDescription(id);

    const price = this.doc.createElement('span');
    price.className = 'pr mono';
    price.textContent = affordabilityNote(id, 0);

    btn.appendChild(num);
    btn.appendChild(name);
    btn.appendChild(price);
    btn.addEventListener('click', () => this.purchase(id));
    row.appendChild(btn);
    this.items.set(id, { id, el: btn, priceEl: price });
    return row;
  }

  private itemName(id: string): string {
    const def = WEAPONS[id];
    if (def) return weaponLabel(id);
    return equipmentLabel(id);
  }

  private itemDescription(id: string): string {
    const def = WEAPONS[id];
    if (!def) return equipmentDescription(id);
    const kind = def.kind.toUpperCase();
    const reward = def.killReward > 0 ? ` · $${def.killReward} per kill` : '';
    return `${kind} · ${def.damage} dmg · ${def.magazine}/${def.reserve}${reward}`;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.open;
  }

  /** Item ids currently known to be owned (rendered with a tick, still buyable). */
  setOwned(ids: readonly string[]): void {
    this.owned.clear();
    for (const id of ids) this.owned.add(id);
    this.refresh();
  }

  show(): void {
    this.open = true;
    this.root.classList.remove('hud-hidden');
    this.refresh();
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hud-hidden');
  }

  close(): void {
    this.hide();
  }

  toggle(): boolean {
    if (this.open) this.hide();
    else this.show();
    return this.open;
  }

  /** Called by Hud.setState; drives prices, affordability and the buy-time hint. */
  update(money: number, timeLeft: number, phase: string): void {
    this.money = Number.isFinite(money) ? money : 0;
    this.timeLeft = Number.isFinite(timeLeft) ? timeLeft : 0;
    this.phase = phase;
    this.refresh();
  }

  focusCategory(index: number): void {
    if (index < 0 || index >= this.categories.length) return;
    this.category = index;
    this.refresh();
  }

  /** Focused category index (0-based). */
  get focusedCategory(): number {
    return this.category;
  }

  get focusMode(): BuyFocusMode {
    return this.mode;
  }

  /**
   * Handle one keydown while the menu is open. Returns true when the key was
   * consumed so the caller can stopPropagation / skip its own bindings.
   *
   *  * `[` / `]` (or Left/Right) cycle categories
   *  * `Tab` toggles whether digits select a category or buy an item
   *  * in 'item' mode a digit buys from the focused category
   *  * in 'category' mode a digit jumps to that category
   *  * Up/Down move between items of the focused category
   *  * Enter buys the highlighted item, Escape closes
   */
  handleKeyDown(e: KeyboardEvent): boolean {
    if (!this.open) return false;
    const key = e.key;

    if (key === 'Escape') {
      this.hide();
      return true;
    }
    if (key === 'Tab') {
      this.mode = this.mode === 'item' ? 'category' : 'item';
      this.refresh();
      return true;
    }
    if (key === '[' || key === 'ArrowLeft') {
      this.focusCategory((this.category - 1 + this.categories.length) % this.categories.length);
      return true;
    }
    if (key === ']' || key === 'ArrowRight') {
      this.focusCategory((this.category + 1) % this.categories.length);
      return true;
    }

    const digit = /^[1-9]$/.test(key) ? Number(key) - 1 : -1;
    if (digit >= 0) {
      if (this.mode === 'category') {
        if (digit < this.categories.length) this.focusCategory(digit);
        return true;
      }
      const item = this.categories[this.category].items[digit];
      if (item) this.purchase(item);
      return true;
    }

    if (key === 'ArrowUp' || key === 'ArrowDown') {
      const list = this.categories[this.category].items;
      const cheap = list
        .slice()
        .sort((a, b) => itemPrice(a) - itemPrice(b))
        .filter((id) => canAfford(id, this.money));
      const target = (key === 'ArrowUp' ? cheap[cheap.length - 1] : cheap[0]) as string | undefined;
      if (target) this.purchase(target);
      return true;
    }

    if (key === 'Enter') {
      const list = this.categories[this.category].items;
      const affordable = list.filter((id) => canAfford(id, this.money));
      const pick = affordable[0];
      if (pick) this.purchase(pick);
      return true;
    }

    return false;
  }

  /** Buy an item if it is affordable; otherwise a no-op (dimmed row). */
  purchase(itemId: string): boolean {
    if (!canAfford(itemId, this.money)) return false;
    this.onBuy(itemId);
    return true;
  }

  /** Human-readable buy window hint, e.g. `Buy time 0:12`. */
  buyTimeText(): string {
    if (this.phase !== 'freeze' && this.phase !== 'warmup') return 'Buy time over';
    const t = Math.max(0, this.timeLeft);
    if (t <= 0) return 'Buy time over';
    return `Buy time ${formatClock(t)}`;
  }

  dispose(): void {
    this.root.remove();
    this.items.clear();
    this.tabs.length = 0;
    this.cols.length = 0;
    this.owned.clear();
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private refresh(): void {
    this.moneyEl.textContent = formatMoney(this.money);
    this.buyTimerEl.textContent = this.buyTimeText();
    this.buyTimerEl.classList.toggle('hud-warn', this.timeLeft <= 5 && this.phase === 'freeze');

    this.modeEl.textContent =
      this.mode === 'item'
        ? 'Number keys BUY · Tab switches to category keys'
        : 'Number keys SELECT CATEGORY · Tab switches to buy keys';

    for (let i = 0; i < this.tabs.length; i++) {
      this.tabs[i].classList.toggle('hud-active', i === this.category);
      this.cols[i].classList.toggle('hud-dim', i !== this.category);
    }

    for (const ref of this.items.values()) {
      const affordable = canAfford(ref.id, this.money);
      ref.el.classList.toggle('hud-poor', !affordable);
      ref.el.classList.toggle('hud-owned', this.owned.has(ref.id));
      ref.el.disabled = !affordable;
      ref.priceEl.textContent = affordabilityNote(ref.id, this.money);
      ref.el.title = `${this.itemDescription(ref.id)} — ${affordabilityNote(ref.id, this.money)}`;
    }
  }
}
