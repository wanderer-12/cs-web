// =============================================================================
// ui/styles.ts — the ONE stylesheet of the HUD.
//
// The whole UI is a vanilla DOM + CSS overlay on top of the WebGL canvas: no
// framework, no external images or fonts. Every rule below is injected into a
// single <style> element created by `injectStyles()`.
//
// Layout rules:
//   * every HUD node is `pointer-events: none`; only interactive panels opt
//     back in with `.hud-interactive { pointer-events: auto }`.
//   * sizes are expressed in rem / em / vh / vw / %, never in fixed px
//     positions, so the HUD holds up from 1280x720 to 3840x2160.
//   * the crosshair is centred with left/top 50% + translate(-50%,-50%) — only
//     the *thickness* and *length* of its arms are pixel values, because those
//     come from the simulation's spread model.
// =============================================================================

export const ROOT_CLASS = 'hud-root';
export const STYLE_ID = 'hud-styles';

export const CSS = `
/* ===================== root ===================== */
.hud-root{
  position:fixed; inset:0; z-index:100; overflow:hidden;
  pointer-events:none; user-select:none; -webkit-user-select:none;
  color:#eef3fb;
  font-family:"Segoe UI", system-ui, -apple-system, Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size:16px; line-height:1.35;
  text-shadow:0 1px 3px rgba(0,0,0,.85), 0 0 1px rgba(0,0,0,.9);
  contain:layout style;
}
.hud-root *{ box-sizing:border-box; }
.hud-hidden{ display:none !important; }
.hud-root .mono{
  font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
  font-variant-numeric:tabular-nums; letter-spacing:.01em;
}
.hud-interactive{ pointer-events:auto; }

.hud-vignette{
  position:absolute; inset:0; pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(0,0,0,0) 42%, rgba(0,0,0,.58) 100%);
}
.hud-desat{ filter:saturate(.32) brightness(.5); }

/* ===================== shared chrome ===================== */
.card{
  background:linear-gradient(180deg, rgba(12,16,22,.80), rgba(6,9,13,.86));
  border:1px solid rgba(255,255,255,.14);
  border-radius:.45rem;
  backdrop-filter:blur(2px);
}
.panel-title{
  font-size:.78rem; font-weight:700; letter-spacing:.22em; text-transform:uppercase;
  color:#ffd166; margin:0 0 .55rem 0;
}
.kbd{
  display:inline-block; min-width:1.5em; padding:.05em .32em; margin-left:.1em;
  font-family:ui-monospace, monospace; font-size:.82em; text-align:center;
  color:#cfe0f5; background:rgba(255,255,255,.10);
  border:1px solid rgba(255,255,255,.20); border-radius:.22rem; text-shadow:none;
}

/* ===================== radar (top-left) ===================== */
.hud-radar{
  position:absolute; left:1.1em; top:1.1em;
  width:13.2em; height:13.2em;
}
.hud-radar canvas{
  display:block; width:100%; height:100%; border-radius:.35rem;
  background:rgba(4,8,12,.58);
  border:1px solid rgba(255,255,255,.20);
  box-shadow:0 3px 12px rgba(0,0,0,.5);
}
.hud-money{
  position:absolute; left:1.1em; top:calc(1.1em + 13.2em + .35em);
  font-size:1.5rem; font-weight:800; color:#5ce39a; letter-spacing:.02em;
}
.hud-money.hud-low{ color:#ffd166; }

/* ===================== top centre: clock + score ===================== */
.hud-top{
  position:absolute; left:50%; top:.9em;
  transform:translateX(-50%);
  display:flex; align-items:stretch; gap:.55em; white-space:nowrap;
}
.hud-top .card{
  display:flex; align-items:center; gap:.5em; padding:.3em .8em;
}
.hud-score{ font-size:1.2rem; font-weight:800; letter-spacing:.06em; }
.hud-score .t{ color:#ffb14d; }
.hud-score .ct{ color:#5aa9ff; }
.hud-score .dash{ color:#6a7686; margin:0 .3em; }
.hud-clock{
  font-size:1.75rem; font-weight:800; min-width:3.7em; text-align:center;
  transition:color .25s linear;
}
.hud-clock.hud-bomb{ animation:hud-pulse .85s ease-in-out infinite; }
.hud-clock.hud-freeze{ color:#8fa3bf; }
.hud-clock.hud-live{ color:#ffffff; }
.hud-clock.hud-over{ color:#ffd166; }
@keyframes hud-pulse{ 0%,100%{ opacity:1; } 50%{ opacity:.42; } }
.hud-round-no{
  font-size:.72rem; letter-spacing:.2em; color:#8b98a9; align-self:center;
  text-transform:uppercase;
}

/* ===================== bomb state (top-centre, under the clock) ============ */
.hud-bomb{
  position:absolute; left:50%; top:5.1em; transform:translateX(-50%);
  display:flex; flex-direction:column; align-items:center; gap:.35em;
  animation:hud-pulse 1s ease-in-out infinite;
}
.hud-bomb .lbl{ font-size:.78rem; letter-spacing:.3em; color:#ff8080; }
.hud-bomb .t{ font-size:2.6rem; font-weight:900; color:#ff3b3b; }
.hud-defuse{ display:flex; align-items:center; gap:.5em; margin-top:.2em; }
.hud-defuse .lbl{ font-size:.72rem; letter-spacing:.22em; color:#7fe3ff; }
.hud-defuse .track{
  position:relative; width:11em; height:.5em;
  background:rgba(0,0,0,.6); border:1px solid rgba(255,255,255,.22); border-radius:.3em;
  overflow:hidden;
}
.hud-defuse .fill{
  position:absolute; inset:0 auto 0 0; width:0%;
  background:linear-gradient(90deg,#38d9ff,#8affd1);
}

/* ===================== world interaction prompt ============================ */
/* Just under the crosshair: it is about what the player is looking at, so it
   must never be confused with the health/ammo band in the corners. */
.hud-prompt{
  position:absolute; left:50%; top:57%; transform:translateX(-50%);
  display:flex; align-items:center; gap:.55em;
  padding:.22em .8em; border-radius:.3em;
  background:rgba(6,9,13,.55); border:1px solid rgba(255,255,255,.14);
}
.hud-prompt .key{
  font-size:.78rem; font-weight:800; color:#0b0f14; background:#ffd08a;
  border-radius:.22em; padding:.04em .45em;
}
.hud-prompt .lbl{ font-size:.84rem; letter-spacing:.1em; color:#e8eef7; }

/* ===================== announcement banner ===================== */
.hud-announce{
  position:absolute; left:50%; top:6.2em; transform:translateX(-50%);
  max-width:70vw; padding:.35em 1.1em;
  font-size:1.5rem; font-weight:800; letter-spacing:.06em; text-align:center;
  background:rgba(6,9,13,.62); border-left:.18em solid currentColor;
  border-radius:.2em; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
}

/* ===================== kill feed (top-right) ===================== */
.hud-feed{
  position:absolute; right:1.1em; top:1.1em;
  display:flex; flex-direction:column; align-items:flex-end; gap:.25em;
  max-width:38vw;
}
.hud-feed-row{
  display:flex; align-items:center; gap:.45em; padding:.22em .55em;
  background:linear-gradient(90deg, rgba(4,8,12,0), rgba(4,8,12,.72) 22%);
  border-radius:.2em; font-size:.95rem; font-weight:600; white-space:nowrap;
}
.hud-feed-row .nm.hud-local{ text-decoration:underline; }
.hud-feed-row .ic{ color:#dfe7f2; }
.hud-feed-row .sep{ color:#63707f; }
.hud-feed-row .hs{ color:#ff5c4d; font-weight:900; }
.hud-feed-row .wb{ color:#9ec7ff; font-size:.8em; }

/* ===================== crosshair ===================== */
.hud-xh{
  position:absolute; left:50%; top:50%; width:0; height:0;
}
.hud-xh-line{
  position:absolute; left:0; top:0;
  background:#4dff7a;
  box-shadow:0 0 0 var(--xh-outline,1px) rgba(0,0,0,.92);
  transform-origin:50% 50%;
}
.hud-xh-dot{
  position:absolute; left:0; top:0;
  width:calc(var(--xh-thick,2px) + 2px); height:calc(var(--xh-thick,2px) + 2px);
  background:#4dff7a; border-radius:50%;
  box-shadow:0 0 0 1px rgba(0,0,0,.92);
  transform:translate(-50%,-50%);
}
.hud-root.hud-dead .hud-xh, .hud-root.hud-dead .hud-hitmarker{ display:none; }

/* ===================== hit marker ===================== */
.hud-hitmarker{
  position:absolute; left:50%; top:50%; width:0; height:0;
}
.hud-hitmarker:not(.hud-off){ animation:hud-pop .25s ease-out forwards; }
.hud-hitmarker.hud-off{ display:none; }
.hud-hitmarker .tk{
  position:absolute; left:0; top:0; width:2px; height:9px; margin:-4.5px 0 0 -1px;
  background:#ffffff; box-shadow:0 0 0 1px rgba(0,0,0,.9);
}
.hud-hitmarker .tk.t0{ transform:rotate(45deg) translateY(-11px); }
.hud-hitmarker .tk.t1{ transform:rotate(135deg) translateY(-11px); }
.hud-hitmarker .tk.t2{ transform:rotate(225deg) translateY(-11px); }
.hud-hitmarker .tk.t3{ transform:rotate(315deg) translateY(-11px); }
.hud-hitmarker.hud-hs .tk{ background:#ff3b3b; width:3px; height:12px; margin:-6px 0 0 -1.5px; }
.hud-hitmarker.hud-kill .tk{ height:15px; margin-top:-7.5px; }
@keyframes hud-pop{
  0%{ opacity:1; transform:scale(.55); }
  45%{ opacity:1; transform:scale(1.18); }
  100%{ opacity:0; transform:scale(1.55); }
}

/* ===================== damage indicators ===================== */
.hud-dmg-layer{
  position:absolute; left:50%; top:50%; width:0; height:0;
}
.hud-dmg{
  position:absolute; left:0; top:0;
  width:6.5em; height:6.5em; margin:-3.25em 0 0 -3.25em;
  border-radius:50%;
  border:.42em solid transparent;
  border-top-color:#ff3b3b;
  will-change:transform,opacity;
}

/* ===================== flash + damage overlays ===================== */
.hud-flash{
  position:absolute; inset:0; background:#ffffff; opacity:0; pointer-events:none;
}
.hud-dmgflash{
  position:absolute; inset:0; opacity:0; pointer-events:none;
  background:radial-gradient(ellipse at center, rgba(255,0,0,0) 32%, rgba(180,0,0,.72) 100%);
}
.hud-dead{
  position:absolute; inset:0; display:flex; flex-direction:column;
  align-items:center; justify-content:center; gap:.6em;
  background:radial-gradient(ellipse at center, rgba(0,0,0,.18) 20%, rgba(0,0,0,.82) 100%);
}
.hud-dead .t{ font-size:2.6rem; font-weight:900; letter-spacing:.24em; color:#ff5252; }
.hud-dead .s{ font-size:.95rem; letter-spacing:.16em; color:#c6d0dc; }

/* ===================== bottom bands ===================== */
.hud-left{
  position:absolute; left:1.1em; bottom:1.1em;
  display:flex; align-items:flex-end; gap:.7em;
}
.band{ display:flex; flex-direction:column; gap:.15em; padding:.35em .7em; }
.band .row{ display:flex; align-items:center; gap:.45em; }
.band .val{
  font-size:2.9rem; font-weight:900; line-height:.95; color:#ffffff;
}
.band .val.hud-low{ color:#ff4d4d; }
.band .val.hud-mid{ color:#ffd166; }
.band .icon{
  width:1.05em; height:1.05em; flex:0 0 auto; opacity:.92;
}
.band .sub{ font-size:.72rem; letter-spacing:.18em; color:#98a4b3; text-transform:uppercase; }
.band .kit{
  font-size:.68rem; letter-spacing:.14em; padding:.05em .35em; border-radius:.2em;
  border:1px solid rgba(255,255,255,.28); color:#8affd1;
}
.band .kit.hud-off{ color:#6d7787; border-color:rgba(255,255,255,.14); }

.hud-right{
  position:absolute; right:1.1em; bottom:1.1em;
  display:flex; align-items:flex-end; text-align:right;
}
.hud-right .band{ align-items:flex-end; }
.hud-weapon{
  font-size:.92rem; font-weight:700; letter-spacing:.14em; color:#cfd8e4; text-transform:uppercase;
}
.hud-ammo{ display:flex; align-items:baseline; gap:.25em; justify-content:flex-end; }
.hud-ammo .mag{ font-size:2.9rem; font-weight:900; line-height:.95; color:#ffffff; }
.hud-ammo .mag.hud-empty{ color:#ff3b3b; }
.hud-ammo .slash{ font-size:1.5rem; color:#63707f; }
.hud-ammo .res{ font-size:1.5rem; font-weight:700; color:#98a4b3; }
.hud-reload{
  width:9em; height:.42em; margin-top:.22em;
  background:rgba(0,0,0,.6); border:1px solid rgba(255,255,255,.18); border-radius:.3em; overflow:hidden;
}
.hud-reload .fill{
  height:100%; width:0%;
  background:linear-gradient(90deg,#ffd166,#4dff9d);
}

.hud-debug{
  position:absolute; left:1.1em; bottom:.25em;
  font-size:.68rem; color:#9aa4b2; opacity:.5; letter-spacing:.08em;
}

/* ===================== overlays (buy / scoreboard / menus) ================= */
.overlay{
  position:absolute; inset:0; display:flex; align-items:center; justify-content:center;
  background:rgba(3,5,8,.62); pointer-events:auto;
}
.overlay .frame{
  max-width:92vw; max-height:92vh; overflow:auto; padding:1.1em 1.4em;
}

/* ---------- buy menu ---------- */
.hud-buy .frame{ width:min(96em,96vw); }
.buy-head{
  display:flex; align-items:baseline; justify-content:space-between; gap:1em;
  margin-bottom:.8em; flex-wrap:wrap;
}
.buy-head .title{ font-size:1.15rem; font-weight:800; letter-spacing:.24em; color:#ffd166; }
.buy-head .stats{ display:flex; gap:1.2em; align-items:baseline; font-size:.9rem; }
.buy-head .stats .mny{ font-size:1.25rem; font-weight:800; color:#5ce39a; }
.buy-head .stats .hint{ color:#98a4b3; letter-spacing:.1em; }
.buy-head .stats .hint.hud-warn{ color:#ffd166; }
.buy-cats{ display:flex; gap:.35em; flex-wrap:wrap; margin-bottom:.75em; }
.buy-cat{
  display:flex; align-items:center; gap:.4em; padding:.28em .7em; cursor:pointer;
  font-size:.85rem; font-weight:700; letter-spacing:.1em; text-transform:uppercase;
  color:#b9c4d2; background:rgba(255,255,255,.05);
  border:1px solid rgba(255,255,255,.12); border-radius:.25em;
}
.buy-cat:hover{ background:rgba(255,255,255,.11); color:#eef3fb; }
.buy-cat.hud-active{ color:#0b0f14; background:#ffd166; border-color:#ffd166; }
.buy-cols{ display:flex; gap:1.1em; align-items:flex-start; }
.buy-col{ flex:1 1 0; min-width:11em; }
.buy-col.hud-dim{ opacity:.42; }
.buy-col-title{
  font-size:.72rem; font-weight:700; letter-spacing:.2em; text-transform:uppercase;
  color:#8b98a9; border-bottom:1px solid rgba(255,255,255,.12);
  padding-bottom:.28em; margin-bottom:.4em;
}
.buy-item{
  display:flex; align-items:center; gap:.55em; width:100%; text-align:left;
  padding:.32em .45em; margin:0 0 .18em 0; cursor:pointer;
  font:inherit; font-size:.86rem; color:#e8eef7;
  background:rgba(255,255,255,.035); border:1px solid transparent; border-radius:.25em;
}
.buy-item:hover{ background:rgba(255,255,255,.12); border-color:rgba(255,255,255,.28); }
.buy-item .num{
  flex:0 0 auto; min-width:1.4em; text-align:center;
  font-family:ui-monospace, monospace; font-size:.82em; color:#0b0f14;
  background:#ffd166; border-radius:.18em; padding:.02em .1em;
}
.buy-item .nm{ flex:1 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.buy-item .pr{
  flex:0 0 auto; font-family:ui-monospace, monospace; font-size:.82em; color:#5ce39a;
}
.buy-item.hud-poor{ color:#6d7787; cursor:not-allowed; background:rgba(255,255,255,.02); }
.buy-item.hud-poor .num{ background:#3d444f; color:#98a4b3; }
.buy-item.hud-poor .pr{ color:#c9705f; }
.buy-item.hud-owned .nm::after{ content:" ✓"; color:#5ce39a; }
.buy-item:disabled{ pointer-events:none; }
.buy-foot{ margin-top:.8em; font-size:.75rem; color:#8b98a9; letter-spacing:.06em; }
.buy-foot .warn{ color:#ffd166; }
.buy-hint-bar{ margin-top:.5em; font-size:.72rem; color:#7d8797; letter-spacing:.08em; }

/* ---------- scoreboard ---------- */
.hud-scoreboard-wrap .frame{ width:min(92em,94vw); }
.sb-head{
  display:flex; align-items:baseline; justify-content:space-between; gap:1em;
  margin-bottom:.7em; flex-wrap:wrap;
}
.sb-head .mtitle{ font-size:1.05rem; font-weight:800; letter-spacing:.2em; color:#eef3fb; }
.sb-head .mmode{ font-size:.78rem; letter-spacing:.24em; color:#ffd166; }
.sb-head .mscore{ font-size:1.5rem; font-weight:900; letter-spacing:.08em; }
.sb-head .mscore .t{ color:#ffb14d; }
.sb-head .mscore .ct{ color:#5aa9ff; }
.sb-grid{ display:flex; gap:1.2em; align-items:flex-start; }
.sb-side{ flex:1 1 0; min-width:0; }
.sb-side-title{
  font-size:.82rem; font-weight:800; letter-spacing:.22em; text-transform:uppercase;
  padding:.22em .5em; border-radius:.2em; margin-bottom:.35em;
}
.sb-side-title.t{ color:#1a1206; background:#ffb14d; }
.sb-side-title.ct{ color:#04121f; background:#5aa9ff; }
.sb-table{ width:100%; border-collapse:collapse; font-size:.86rem; }
.sb-table th{
  text-align:left; font-size:.68rem; letter-spacing:.16em; text-transform:uppercase;
  color:#8b98a9; font-weight:700; padding:.18em .45em;
  border-bottom:1px solid rgba(255,255,255,.14);
}
.sb-table td{ padding:.2em .45em; border-bottom:1px solid rgba(255,255,255,.06); }
.sb-table .num{ text-align:right; font-family:ui-monospace,monospace; }
.sb-table tr.hud-dead td{ opacity:.42; }
.sb-table tr.hud-local td{ background:rgba(255,209,102,.16); color:#fff4d6; font-weight:700; }
.sb-table .nm-cell{ max-width:12em; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.sb-empty{ font-size:.8rem; color:#6d7787; padding:.3em .45em; }
.sb-note{ margin-top:.7em; font-size:.7rem; color:#7d8797; letter-spacing:.08em; }

/* ---------- round end / match end ---------- */
.hud-result{
  position:absolute; left:50%; top:50%; transform:translate(-50%,-50%);
  text-align:center; pointer-events:none;
}
.hud-result .winner{ font-size:3.2rem; font-weight:900; letter-spacing:.05em; }
.hud-result .winner.t{ color:#ffb14d; }
.hud-result .winner.ct{ color:#5aa9ff; }
.hud-result .reason{ font-size:1.05rem; letter-spacing:.16em; color:#cfd8e4; margin-top:.35em; }
.hud-result .score{ font-size:2rem; font-weight:800; margin-top:.4em; letter-spacing:.1em; }
.hud-result .score .t{ color:#ffb14d; }
.hud-result .score .ct{ color:#5aa9ff; }

.hud-matchend .frame{
  width:min(88em,92vw); text-align:center;
}
.hud-matchend .mwinner{
  font-size:2.8rem; font-weight:900; letter-spacing:.08em; margin-bottom:.1em;
}
.hud-matchend .mwinner.t{ color:#ffb14d; }
.hud-matchend .mwinner.ct{ color:#5aa9ff; }
.hud-matchend .msub{ font-size:.95rem; letter-spacing:.2em; color:#98a4b3; margin-bottom:.9em; }
.hud-matchend .mgrid{ text-align:left; }
.hud-matchend .mbtns{ display:flex; gap:.7em; justify-content:center; margin-top:1.1em; }

/* ---------- main menu ---------- */
.hud-menu{ background:rgba(3,5,8,.86); }
.hud-menu .frame{ width:min(74em,92vw); }
.hud-menu-inner{ display:flex; gap:2em; align-items:flex-start; }
.menu-col{ flex:1 1 0; min-width:0; }
.menu-hero{ flex:0 0 40%; text-align:center; }
.menu-title{
  font-size:2.6rem; font-weight:900; letter-spacing:.14em; color:#eef3fb; margin:0;
}
.menu-sub{
  font-size:.78rem; letter-spacing:.34em; color:#ffd166; margin:.15em 0 1.1em 0;
}
.ctrl-table{ width:100%; border-collapse:collapse; font-size:.85rem; }
.ctrl-table td{ padding:.16em .4em; vertical-align:top; }
.ctrl-table td.k{ width:9em; white-space:nowrap; }
.ctrl-table td.d{ color:#b9c4d2; }
.howto{ margin:0; padding-left:1.15em; font-size:.85rem; color:#b9c4d2; }
.howto li{ margin-bottom:.22em; }
.btn{
  font:inherit; font-size:.92rem; font-weight:700; letter-spacing:.14em; text-transform:uppercase;
  padding:.45em 1.4em; color:#0b0f14; background:#ffd166;
  border:1px solid #ffd166; border-radius:.25em; cursor:pointer;
}
.btn:hover{ background:#ffe19a; }
.btn.hud-ghost{ color:#cfd8e4; background:transparent; border-color:rgba(255,255,255,.3); }
.btn.hud-ghost:hover{ background:rgba(255,255,255,.12); }
.menu-btns{ display:flex; gap:.55em; flex-wrap:wrap; justify-content:center; margin-bottom:.9em; }
.menu-foot{ margin-top:.9em; font-size:.7rem; color:#7d8797; letter-spacing:.08em; }
`;

// ---------------------------------------------------------------------------
// Injection
// ---------------------------------------------------------------------------

let injected = false;

/**
 * Create (once per document) the <style> element holding `CSS`. Safe to call
 * repeatedly and from every Hud instance: the stylesheet is shared, and a
 * second Hud on the same page never adds a duplicate <style> tag.
 */
export function injectStyles(doc: Document | null = typeof document === 'undefined' ? null : document): void {
  if (!doc || injected) return;
  const existing = doc.getElementById(STYLE_ID);
  if (existing) {
    injected = true;
    return;
  }
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.setAttribute('data-hud', '1');
  style.textContent = CSS;
  (doc.head ?? doc.documentElement).appendChild(style);
  injected = true;
}

/** Test / teardown helper: forget that styles were injected. */
export function resetStyleInjection(): void {
  injected = false;
}
