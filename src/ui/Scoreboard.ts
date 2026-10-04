// =============================================================================
// ui/Scoreboard.ts — the TAB scoreboard plus the round-end and match-end
// screens.
//
// The scoreboard is two team tables side by side (T left, CT right), sorted by
// kills desc / deaths asc / name asc within each team by the pure helper
// `sortedScoreRows`. Dead players are dimmed, the local player is highlighted.
// =============================================================================

import { RULES } from '../core/config';
import type { Team } from '../core/types';
import type { ScoreRow } from './pure';
import { formatMoney, scoreLine, sortedScoreRows, teamRows, teamTotals, winnerShort } from './pure';
import { ROOT_CLASS } from './styles';

const COLUMNS = ['Player', 'K', 'D', 'A', '$', 'Ping'] as const;

export class Scoreboard {
  /** Hidden/shown with TAB. */
  readonly root: HTMLDivElement;
  /** Big centred text shown between rounds. */
  readonly resultRoot: HTMLDivElement;
  /** Full-screen match summary. */
  readonly matchRoot: HTMLDivElement;

  private readonly doc: Document;

  private scoreTitleEl!: HTMLElement;
  private scoreModeEl!: HTMLElement;
  private scoreHeadEl!: HTMLElement;
  private tBody!: HTMLTableSectionElement;
  private ctBody!: HTMLTableSectionElement;
  private tTitleEl!: HTMLElement;
  private ctTitleEl!: HTMLElement;

  private resultWinnerEl!: HTMLElement;
  private resultReasonEl!: HTMLElement;
  private resultScoreEl!: HTMLElement;

  private matchWinnerEl!: HTMLElement;
  private matchScoreEl!: HTMLElement;
  private matchGridEl!: HTMLElement;
  private matchBtnsEl!: HTMLElement;

  private rows: ScoreRow[] = [];
  private scoreT = 0;
  private scoreCT = 0;
  private open = false;
  private resultVisible = false;
  private matchVisible = false;

  onMenuAction: (action: string) => void = () => {};

  constructor(doc: Document) {
    this.doc = doc;
    this.root = doc.createElement('div');
    this.root.className = `overlay ${ROOT_CLASS} hud-scoreboard-wrap hud-hidden`;
    this.root.setAttribute('aria-label', 'Scoreboard');
    this.resultRoot = doc.createElement('div');
    this.resultRoot.className = `${ROOT_CLASS} hud-result hud-hidden`;
    this.matchRoot = doc.createElement('div');
    this.matchRoot.className = `overlay ${ROOT_CLASS} hud-matchend hud-hidden`;
    this.matchRoot.setAttribute('aria-label', 'Match summary');
    this.buildScoreboard();
    this.buildResult();
    this.buildMatchEnd();
  }

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  private buildScoreboard(): void {
    const frame = this.doc.createElement('div');
    frame.className = 'frame card';

    const head = this.doc.createElement('div');
    head.className = 'sb-head';
    this.scoreTitleEl = this.doc.createElement('div');
    this.scoreTitleEl.className = 'mtitle';
    this.scoreTitleEl.textContent = 'Scoreboard';
    this.scoreModeEl = this.doc.createElement('div');
    this.scoreModeEl.className = 'mmode';
    // RULES.roundsToWin is 13, i.e. a 12-round half — labelled MR12 as required.
    this.scoreModeEl.textContent = `MR${RULES.roundsToWin - 1}`;
    this.scoreHeadEl = this.doc.createElement('div');
    this.scoreHeadEl.className = 'mscore mono';
    head.appendChild(this.scoreTitleEl);
    head.appendChild(this.scoreModeEl);
    head.appendChild(this.scoreHeadEl);

    const grid = this.doc.createElement('div');
    grid.className = 'sb-grid';

    const t = this.buildSide('T');
    this.tTitleEl = t.title;
    this.tBody = t.body;
    const ct = this.buildSide('CT');
    this.ctTitleEl = ct.title;
    this.ctBody = ct.body;

    grid.appendChild(t.side);
    grid.appendChild(ct.side);
    frame.appendChild(head);
    frame.appendChild(grid);

    const note = this.doc.createElement('div');
    note.className = 'sb-note';
    note.textContent = `First to ${RULES.roundsToWin} rounds · half at ${Math.ceil(RULES.maxRounds / 2)} rounds`;
    frame.appendChild(note);

    this.root.appendChild(frame);
  }

  private buildSide(team: Team): { side: HTMLDivElement; title: HTMLElement; body: HTMLTableSectionElement } {
    const side = this.doc.createElement('div');
    side.className = 'sb-side';
    const title = this.doc.createElement('div');
    title.className = `sb-side-title ${team === 'T' ? 't' : 'ct'}`;
    title.textContent = team === 'T' ? 'Terrorists' : 'Counter-Terrorists';

    const table = this.doc.createElement('table');
    table.className = 'sb-table';
    const thead = this.doc.createElement('thead');
    const hr = this.doc.createElement('tr');
    for (const col of COLUMNS) {
      const th = this.doc.createElement('th');
      th.textContent = col;
      if (col !== 'Player') th.className = 'num';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const body = this.doc.createElement('tbody');

    table.appendChild(thead);
    table.appendChild(body);
    side.appendChild(title);
    side.appendChild(table);
    return { side, title, body };
  }

  private buildResult(): void {
    this.resultWinnerEl = this.doc.createElement('div');
    this.resultWinnerEl.className = 'winner';
    this.resultReasonEl = this.doc.createElement('div');
    this.resultReasonEl.className = 'reason';
    this.resultScoreEl = this.doc.createElement('div');
    this.resultScoreEl.className = 'score mono';
    this.resultRoot.appendChild(this.resultWinnerEl);
    this.resultRoot.appendChild(this.resultReasonEl);
    this.resultRoot.appendChild(this.resultScoreEl);
  }

  private buildMatchEnd(): void {
    const frame = this.doc.createElement('div');
    frame.className = 'frame card';

    this.matchWinnerEl = this.doc.createElement('div');
    this.matchWinnerEl.className = 'mwinner';
    this.matchScoreEl = this.doc.createElement('div');
    this.matchScoreEl.className = 'msub mono';
    this.matchGridEl = this.doc.createElement('div');
    this.matchGridEl.className = 'mgrid';

    this.matchBtnsEl = this.doc.createElement('div');
    this.matchBtnsEl.className = 'mbtns';
    this.matchBtnsEl.appendChild(this.makeButton('Play again', 'restart', false));
    this.matchBtnsEl.appendChild(this.makeButton('Quit to menu', 'quit', true));

    frame.appendChild(this.matchWinnerEl);
    frame.appendChild(this.matchScoreEl);
    frame.appendChild(this.matchGridEl);
    frame.appendChild(this.matchBtnsEl);
    this.matchRoot.appendChild(frame);
  }

  private makeButton(label: string, action: string, ghost: boolean): HTMLButtonElement {
    const btn = this.doc.createElement('button');
    btn.type = 'button';
    btn.className = ghost ? 'btn hud-ghost' : 'btn';
    btn.textContent = label;
    btn.addEventListener('click', () => this.onMenuAction(action));
    return btn;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.open;
  }

  get isResultVisible(): boolean {
    return this.resultVisible;
  }

  get isMatchVisible(): boolean {
    return this.matchVisible;
  }

  show(): void {
    this.open = true;
    this.root.classList.remove('hud-hidden');
  }

  hide(): void {
    this.open = false;
    this.root.classList.add('hud-hidden');
  }

  toggle(): boolean {
    if (this.open) this.hide();
    else this.show();
    return this.open;
  }

  /** Replace the score rows (already-known data from the simulation). */
  setRows(rows: readonly ScoreRow[]): void {
    this.rows = rows.slice();
    this.renderTables();
  }

  setScore(scoreT: number, scoreCT: number): void {
    this.scoreT = Number.isFinite(scoreT) ? scoreT : 0;
    this.scoreCT = Number.isFinite(scoreCT) ? scoreCT : 0;
    this.scoreHeadEl.textContent = scoreLine(this.scoreT, this.scoreCT);
  }

  /** Big centred banner shown while the round is settling. */
  showResult(winner: Team, reason: string, scoreT: number, scoreCT: number): void {
    this.setScore(scoreT, scoreCT);
    this.resultVisible = true;
    this.resultRoot.classList.remove('hud-hidden');
    this.resultWinnerEl.classList.remove('t', 'ct');
    this.resultWinnerEl.classList.add(winner === 'CT' ? 'ct' : 't');
    this.resultWinnerEl.textContent =
      winner === 'T' ? 'Terrorists win' : winner === 'CT' ? 'Counter-Terrorists win' : 'Round over';
    this.resultReasonEl.textContent = reason || 'Round ended';
    this.resultScoreEl.textContent = scoreLine(scoreT, scoreCT);
  }

  hideResult(): void {
    this.resultVisible = false;
    this.resultRoot.classList.add('hud-hidden');
  }

  showMatchEnd(winner: Team, scoreT: number, scoreCT: number, rows: readonly ScoreRow[]): void {
    this.setScore(scoreT, scoreCT);
    this.rows = rows.slice();
    this.matchVisible = true;
    this.matchRoot.classList.remove('hud-hidden');
    this.matchWinnerEl.classList.remove('t', 'ct');
    this.matchWinnerEl.classList.add(winner === 'CT' ? 'ct' : 't');
    this.matchWinnerEl.textContent = `${winnerShort(winner)} WIN`;
    this.matchScoreEl.textContent = `${scoreLine(scoreT, scoreCT)} · final score`;
    this.matchGridEl.replaceChildren(this.buildGrid());
    this.renderTables();
  }

  hideMatchEnd(): void {
    this.matchVisible = false;
    this.matchRoot.classList.add('hud-hidden');
  }

  announce(): void {
    // Kept for API symmetry with Hud.announce; the scoreboard itself has no banner.
  }

  dispose(): void {
    this.root.remove();
    this.resultRoot.remove();
    this.matchRoot.remove();
    this.rows = [];
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private buildGrid(): HTMLDivElement {
    const grid = this.doc.createElement('div');
    grid.className = 'sb-grid';
    grid.appendChild(this.buildStaticSide('T'));
    grid.appendChild(this.buildStaticSide('CT'));
    return grid;
  }

  private buildStaticSide(team: Team): HTMLDivElement {
    const side = this.doc.createElement('div');
    side.className = 'sb-side';
    const title = this.doc.createElement('div');
    title.className = `sb-side-title ${team === 'T' ? 't' : 'ct'}`;
    title.textContent = team === 'T' ? 'Terrorists' : 'Counter-Terrorists';
    side.appendChild(title);

    const list = teamRows(this.rows, team);
    if (list.length === 0) {
      const empty = this.doc.createElement('div');
      empty.className = 'sb-empty';
      empty.textContent = 'No players';
      side.appendChild(empty);
      return side;
    }

    const table = this.doc.createElement('table');
    table.className = 'sb-table';
    const thead = this.doc.createElement('thead');
    const hr = this.doc.createElement('tr');
    for (const col of COLUMNS) {
      const th = this.doc.createElement('th');
      th.textContent = col;
      if (col !== 'Player') th.className = 'num';
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const body = this.doc.createElement('tbody');
    for (const row of list) body.appendChild(this.buildRow(row));
    table.appendChild(thead);
    table.appendChild(body);

    const totals = teamTotals(list, team);
    const foot = this.doc.createElement('div');
    foot.className = 'sb-note';
    foot.textContent = `Team ${totals.kills} K · ${totals.deaths} D · ${totals.assists} A`;
    side.appendChild(table);
    side.appendChild(foot);
    return side;
  }

  private buildRow(row: ScoreRow): HTMLTableRowElement {
    const tr = this.doc.createElement('tr');
    tr.classList.toggle('hud-dead', !row.alive);
    tr.classList.toggle('hud-local', !!row.isLocal);

    const name = this.doc.createElement('td');
    name.className = 'nm-cell';
    // Player names come from the network / config: textContent only, never HTML.
    name.textContent = row.name;
    tr.appendChild(name);

    for (const value of [row.kills, row.deaths, row.assists]) {
      tr.appendChild(this.numCell(value));
    }
    tr.appendChild(this.numCell(formatMoney(row.money)));
    tr.appendChild(this.numCell(`${Math.round(Number.isFinite(row.ping) ? row.ping : 0)}ms`));
    return tr;
  }

  private numCell(value: number | string): HTMLTableCellElement {
    const td = this.doc.createElement('td');
    td.className = 'num mono';
    td.textContent = String(value);
    return td;
  }

  private renderTables(): void {
    this.tBody.replaceChildren();
    this.ctBody.replaceChildren();
    const list = sortedScoreRows(this.rows);
    for (const row of list) {
      if (row.team === 'T') this.tBody.appendChild(this.buildRow(row));
      else if (row.team === 'CT') this.ctBody.appendChild(this.buildRow(row));
    }
    if (this.tBody.childElementCount === 0) {
      const tr = this.doc.createElement('tr');
      const td = this.doc.createElement('td');
      td.colSpan = COLUMNS.length;
      td.className = 'sb-empty';
      td.textContent = 'No players';
      tr.appendChild(td);
      this.tBody.appendChild(tr);
    }
    if (this.ctBody.childElementCount === 0) {
      const tr = this.doc.createElement('tr');
      const td = this.doc.createElement('td');
      td.colSpan = COLUMNS.length;
      td.className = 'sb-empty';
      td.textContent = 'No players';
      tr.appendChild(td);
      this.ctBody.appendChild(tr);
    }
    this.scoreHeadEl.textContent = scoreLine(this.scoreT, this.scoreCT);
    this.tTitleEl.textContent = `Terrorists · ${teamTotals(this.rows, 'T').kills} K`;
    this.ctTitleEl.textContent = `Counter-Terrorists · ${teamTotals(this.rows, 'CT').kills} K`;
  }
}
