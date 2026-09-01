export const CLIENT_STYLE_ID = '@nobei/dsh-phase1/client'

export const CLIENT_CSS = `
.betterlearn-floating-root {
  --nobei-paper: #F6F8FC;
  --nobei-surface: #FFFFFF;
  --nobei-ink: #172033;
  --nobei-muted: #657087;
  --nobei-line: #DDE3EE;
  --nobei-action: #315EFB;
  position: fixed;
  inset: 0;
  z-index: 12000;
  pointer-events: none;
  color: var(--nobei-ink);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
}
.betterlearn-floating-launcher {
  position: absolute;
  top: 50%;
  right: 0;
  display: grid;
  place-items: center;
  width: 44px;
  min-height: 132px;
  border: 1px solid #2448C7;
  border-inline-end: 0;
  border-radius: 14px 0 0 14px;
  padding: 14px 10px;
  transform: translateY(-50%);
  pointer-events: auto;
  color: #FFFFFF;
  background: var(--nobei-action);
  box-shadow: 0 14px 36px rgb(23 32 51 / 0.22);
  font: 700 0.76rem/1 ui-monospace, "SFMono-Regular", Consolas, monospace;
  letter-spacing: 0.1em;
  writing-mode: vertical-rl;
  cursor: pointer;
}
.betterlearn-floating-launcher:hover { background: #2448C7; }
.betterlearn-floating-launcher:focus-visible, .betterlearn-floating-header button:focus-visible { outline: 3px solid color-mix(in srgb, var(--nobei-action) 34%, transparent); outline-offset: 3px; }
.betterlearn-floating-panel {
  --betterlearn-history-width: 260px;
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  flex-direction: column;
  width: var(--betterlearn-user-width);
  height: var(--betterlearn-user-height);
  max-width: calc(100vw - 32px);
  max-height: calc(100dvh - 32px);
  overflow: hidden;
  pointer-events: auto;
  container-type: inline-size;
  border: 1px solid var(--nobei-line);
  border-radius: 18px;
  color: var(--nobei-ink);
  background: var(--nobei-paper);
  box-shadow: 0 24px 70px rgb(23 32 51 / 0.2);
  transition: width 180ms ease, height 180ms ease;
}
.betterlearn-floating-panel[data-resizing="true"] { transition: none; user-select: none; }
.betterlearn-resize-handle { position: absolute; z-index: 5; touch-action: none; }
.betterlearn-resize-handle--left { inset: 12px auto 12px -5px; width: 10px; cursor: ew-resize; }
.betterlearn-resize-handle--bottom { inset: auto 12px -5px 12px; height: 10px; cursor: ns-resize; }
.betterlearn-resize-handle--corner { left: -7px; bottom: -7px; width: 18px; height: 18px; cursor: nesw-resize; }
.betterlearn-floating-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  min-height: 48px;
  padding: 8px 12px 8px 18px;
  border-block-end: 1px solid var(--nobei-line);
  background: var(--nobei-surface);
}
.betterlearn-floating-header strong { color: var(--nobei-action); font: 750 0.8rem/1 ui-monospace, "SFMono-Regular", Consolas, monospace; letter-spacing: 0.09em; text-transform: uppercase; }
.betterlearn-floating-header__leading { display: flex; align-items: center; gap: 10px; }
.betterlearn-floating-header button { border: 0; border-radius: 8px; padding: 7px 10px; color: var(--nobei-muted); background: transparent; font: inherit; cursor: pointer; }
.betterlearn-floating-header__leading button[aria-expanded="true"] { color: var(--nobei-action); background: color-mix(in srgb, var(--nobei-action) 10%, transparent); }
.betterlearn-floating-header button:hover { color: var(--nobei-ink); background: color-mix(in srgb, var(--nobei-action) 8%, transparent); }
.betterlearn-floating-empty { margin: 0; padding: 28px; color: var(--nobei-muted); background: var(--nobei-paper); line-height: 1.65; }
.betterlearn-floating-panel > .nobei-client-layout { flex: 1 1 auto; min-height: 0; overflow: hidden; }
.nobei-client-layout {
  display: grid;
  position: relative;
  grid-template-columns: minmax(0, 1fr);
  width: 100%;
  min-height: 0;
  container-type: inline-size;
  color: var(--nobei-ink);
  background: var(--nobei-paper);
}
.nobei-client-layout[data-history-open="true"] > .nobei-history {
  position: absolute;
  z-index: 4;
  inset: 0 auto 0 0;
  width: min(var(--betterlearn-history-width), 100%);
  box-shadow: 18px 0 38px rgb(23 32 51 / 0.18);
}
.nobei-history {
  display: flex;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  overflow: hidden;
  border-inline-end: 1px solid var(--nobei-line);
  color: var(--nobei-ink);
  background: var(--nobei-surface);
}
.nobei-history__header { display: grid; gap: 14px; padding: 18px 16px 14px; border-block-end: 1px solid var(--nobei-line); }
.nobei-history__header p { margin: 0; color: var(--nobei-action); font: 700 0.7rem/1 ui-monospace, "SFMono-Regular", Consolas, monospace; letter-spacing: 0.1em; text-transform: uppercase; }
.nobei-history__header h2 { margin: 5px 0 0; font: 700 1.2rem/1.2 ui-serif, "Songti SC", "STSong", Georgia, serif; }
.nobei-history__header button, .nobei-history__state button { border: 1px solid var(--nobei-line); border-radius: 9px; padding: 8px 11px; color: var(--nobei-action); background: var(--nobei-paper); font: inherit; font-weight: 700; cursor: pointer; }
.nobei-history__body { display: grid; align-content: start; min-height: 0; overflow: auto; padding: 8px; }
.nobei-history__state { margin: 8px; padding: 16px 10px; color: var(--nobei-muted); line-height: 1.55; }
.nobei-history__state p { margin: 0 0 10px; }
.nobei-history__item { display: grid; gap: 7px; width: 100%; border: 1px solid transparent; border-radius: 11px; padding: 12px; text-align: start; color: var(--nobei-ink); background: transparent; font: inherit; cursor: pointer; }
.nobei-history__item:hover { background: var(--nobei-paper); }
.nobei-history__item[aria-current="true"] { border-color: color-mix(in srgb, var(--nobei-action) 32%, var(--nobei-line)); background: color-mix(in srgb, var(--nobei-action) 8%, var(--nobei-surface)); }
.nobei-history__item-heading { display: flex; align-items: start; justify-content: space-between; gap: 8px; }
.nobei-history__item-heading strong { min-width: 0; overflow-wrap: anywhere; font-size: 0.88rem; }
.nobei-history__item-heading em { flex: 0 0 auto; color: var(--nobei-muted); font-size: 0.68rem; font-style: normal; }
.nobei-history__item-heading em[data-status="review_pending"] { color: var(--nobei-evidence); }
.nobei-history__item-heading em[data-status="completed"] { color: var(--nobei-accepted); }
.nobei-history__item-heading em[data-status="failed_retryable"], .nobei-history__item-heading em[data-status="failed_terminal"] { color: var(--nobei-rejected); }
.nobei-history__counts, .nobei-history__item time { color: var(--nobei-muted); font: 0.68rem/1.35 ui-monospace, "SFMono-Regular", Consolas, monospace; }
.nobei-client {
  --nobei-paper: #F6F8FC;
  --nobei-surface: #FFFFFF;
  --nobei-ink: #172033;
  --nobei-muted: #657087;
  --nobei-line: #DDE3EE;
  --nobei-action: #315EFB;
  --nobei-accepted: #2F8F6B;
  --nobei-evidence: #D99024;
  --nobei-rejected: #B94A48;
  box-sizing: border-box;
  min-height: 0;
  max-height: none;
  overflow: auto;
  container-type: inline-size;
  padding: clamp(16px, 2.4vw, 28px);
  color: var(--nobei-ink);
  background: var(--nobei-paper);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
  line-height: 1.6;
}
.nobei-client *, .nobei-client *::before, .nobei-client *::after { box-sizing: inherit; }
.nobei-client h1, .nobei-client h2, .nobei-client h3 { margin: 0; font-family: ui-serif, "Songti SC", "STSong", Georgia, serif; line-height: 1.22; letter-spacing: -0.02em; }
.nobei-client p { margin-block: 0; }
.nobei-client button, .nobei-client input, .nobei-client textarea { font: inherit; }
.nobei-client button { cursor: pointer; }
.nobei-client button:disabled { cursor: not-allowed; opacity: 0.52; }
.nobei-client button:focus-visible, .nobei-client input:focus-visible, .nobei-client textarea:focus-visible { outline: 3px solid color-mix(in srgb, var(--nobei-action) 32%, transparent); outline-offset: 2px; }
.nobei-client__masthead { display: flex; align-items: end; justify-content: space-between; gap: 24px; max-width: 1480px; margin: 0 auto 24px; padding-block-end: 18px; border-block-end: 1px solid var(--nobei-line); }
.nobei-client__brand, .nobei-client__eyebrow { color: var(--nobei-action); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
.nobei-client__masthead h1 { margin-block-start: 4px; font-size: clamp(1.45rem, 3vw, 2.45rem); }
.nobei-client__source-identity { display: grid; justify-items: end; color: var(--nobei-muted); font-size: 0.8rem; }
.nobei-client__source-identity strong { max-width: 32ch; overflow-wrap: anywhere; color: var(--nobei-ink); font-size: 0.95rem; }
.nobei-client__workspace { max-width: 1480px; margin: 0 auto; }
.nobei-client__import, .nobei-client__progress, .nobei-client__result { max-width: 820px; margin: 0 auto; padding: clamp(22px, 4vw, 44px); border: 1px solid var(--nobei-line); border-radius: 18px; background: var(--nobei-surface); box-shadow: 0 18px 46px rgb(23 32 51 / 0.07); }
.nobei-client__import header > p:last-child { max-width: 58ch; margin-block-start: 10px; color: var(--nobei-muted); }
.nobei-client__tabs { display: flex; gap: 6px; margin-block: 28px 20px; padding: 4px; border-radius: 12px; background: var(--nobei-paper); }
.nobei-client__tabs button { flex: 1; padding: 10px 16px; border: 0; border-radius: 9px; color: var(--nobei-muted); background: transparent; }
.nobei-client__tabs button[aria-selected="true"] { color: var(--nobei-ink); background: var(--nobei-surface); box-shadow: 0 2px 9px rgb(23 32 51 / 0.08); }
.nobei-client__input-panel { display: grid; gap: 10px; }
.nobei-client__input-panel label, .nobei-client__candidate-card label { font-size: 0.85rem; font-weight: 700; }
.nobei-client__input-panel input, .nobei-client__input-panel textarea, .nobei-client__candidate-card input, .nobei-client__candidate-card textarea { width: 100%; border: 1px solid var(--nobei-line); border-radius: 10px; padding: 11px 13px; color: var(--nobei-ink); background: var(--nobei-surface); }
.nobei-client__input-panel textarea { min-height: 250px; resize: vertical; }
.nobei-client__input-panel output { color: var(--nobei-muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.78rem; }
.nobei-client__file-preview { display: grid; gap: 7px; margin-block-start: 12px; padding: 16px; border-inline-start: 3px solid var(--nobei-action); background: var(--nobei-paper); }
.nobei-client__file-preview pre { max-height: 220px; margin: 0; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--nobei-muted); }
.nobei-client__primary, .nobei-client__result > button, .nobei-client__review-actions button:first-child { margin-block-start: 20px; padding: 11px 18px; border: 1px solid var(--nobei-action); border-radius: 10px; color: #FFFFFF; background: var(--nobei-action); font-weight: 700; }
.nobei-client__error { margin-block-start: 12px; color: var(--nobei-rejected); }
.nobei-client__steps { display: grid; gap: 0; margin: 30px 0 0; padding: 0; list-style: none; }
.nobei-client__steps li { position: relative; display: flex; align-items: center; gap: 13px; min-height: 58px; color: var(--nobei-muted); }
.nobei-client__steps li::after { content: ""; position: absolute; inset-inline-start: 15px; inset-block: 43px -15px; width: 1px; background: var(--nobei-line); }
.nobei-client__steps li:last-child::after { display: none; }
.nobei-client__steps li > span { display: grid; z-index: 1; place-items: center; width: 31px; height: 31px; border: 1px solid var(--nobei-line); border-radius: 50%; background: var(--nobei-surface); font-size: 0.78rem; }
.nobei-client__steps li[data-state="done"] { color: var(--nobei-accepted); }
.nobei-client__steps li[data-state="current"] { color: var(--nobei-ink); font-weight: 700; }
.nobei-client__steps li[data-state="current"] > span { border-color: var(--nobei-action); color: #FFFFFF; background: var(--nobei-action); }
.nobei-client__notice { margin-block-start: 22px; padding: 16px; border: 1px solid var(--nobei-line); border-radius: 12px; background: var(--nobei-paper); }
.nobei-client__notice p { color: var(--nobei-muted); }
.nobei-client__notice button { margin-block-start: 10px; border: 0; padding: 0; color: var(--nobei-action); background: transparent; font-weight: 700; }
.nobei-client__review { display: grid; grid-template-columns: minmax(0, 0.72fr) minmax(0, 1fr) minmax(0, 1.15fr); gap: 16px; align-items: start; }
.nobei-client__candidate-nav, .nobei-client__candidate-card, .nobei-client__evidence-reader { border: 1px solid var(--nobei-line); border-radius: 16px; background: var(--nobei-surface); }
.nobei-client__candidate-nav { display: grid; gap: 6px; padding: 14px; max-height: min(50vh, 600px); overflow: auto; }
.nobei-client__candidate-nav > p { padding: 6px 8px 10px; }
.nobei-client__candidate-nav button { display: grid; gap: 3px; width: 100%; padding: 11px; border: 1px solid transparent; border-radius: 10px; text-align: start; color: var(--nobei-ink); background: transparent; }
.nobei-client__candidate-nav button[aria-current="true"] { border-color: var(--nobei-evidence); background: color-mix(in srgb, var(--nobei-evidence) 10%, var(--nobei-surface)); }
.nobei-client__candidate-nav small { color: var(--nobei-muted); }
.nobei-client__candidate-card { display: grid; gap: 10px; padding: clamp(20px, 3vw, 32px); }
.nobei-client__candidate-card textarea { min-height: 170px; resize: vertical; }
.nobei-client__candidate-card input[readonly], .nobei-client__candidate-card textarea[readonly] { border-color: transparent; padding-inline: 0; background: transparent; }
.nobei-client__review-actions { display: flex; flex-wrap: wrap; gap: 9px; margin-block-start: 8px; }
.nobei-client__review-actions button { margin-block-start: 0; padding: 9px 13px; border: 1px solid var(--nobei-line); border-radius: 9px; color: var(--nobei-ink); background: var(--nobei-surface); }
.nobei-client__review-actions button:last-child { color: var(--nobei-rejected); }
.nobei-client__evidence-reader { overflow: hidden; border-inline-start: 4px solid var(--nobei-evidence); }
.nobei-client__evidence-reader header { padding: 20px 22px 0; }
.nobei-client__evidence-cards { display: flex; flex-wrap: wrap; gap: 7px; padding: 14px 22px; }
.nobei-client__evidence-cards button { padding: 7px 10px; border: 1px solid color-mix(in srgb, var(--nobei-evidence) 35%, var(--nobei-line)); border-radius: 99px; color: var(--nobei-ink); background: transparent; }
.nobei-client__evidence-cards button[aria-pressed="true"] { color: #5A3600; background: color-mix(in srgb, var(--nobei-evidence) 24%, #FFFFFF); }
.nobei-client__source-text { max-height: min(62vh, 760px); margin: 0; padding: 20px 22px 28px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; border-block-start: 1px solid var(--nobei-line); }
.nobei-client__source-text mark { scroll-margin-block: 40%; padding-block: 2px; color: inherit; background: color-mix(in srgb, var(--nobei-evidence) 26%, transparent); box-shadow: inset 3px 0 var(--nobei-evidence); }
.nobei-client__source-text mark.nobei-client__evidence-flash { background: color-mix(in srgb, var(--nobei-evidence) 45%, transparent); }
.nobei-client__result-counts { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-block: 26px; }
.nobei-client__result-counts div { padding: 15px; border: 1px solid var(--nobei-line); border-radius: 12px; }
.nobei-client__result-counts dt { color: var(--nobei-muted); font-size: 0.8rem; }
.nobei-client__result-counts dd { margin: 0; font-family: ui-serif, "Songti SC", serif; font-size: 1.8rem; }
.nobei-client__knowledge-list { display: grid; gap: 12px; }
.nobei-client__knowledge-list article { padding: 18px; border-inline-start: 3px solid var(--nobei-accepted); background: var(--nobei-paper); }
.nobei-client__knowledge-list article > p:first-child { color: var(--nobei-muted); font-family: ui-monospace, "SFMono-Regular", Consolas, monospace; font-size: 0.75rem; }
.nobei-client__knowledge-heading { display: flex; align-items: start; justify-content: space-between; gap: 12px; }
.nobei-client__knowledge-heading button, .nobei-client__knowledge-actions button { flex: none; margin: 0; padding: 6px 10px; border: 1px solid var(--nobei-line); border-radius: 8px; color: var(--nobei-action); background: var(--nobei-surface); }
.nobei-client__knowledge-editor { display: grid; gap: 10px; }
.nobei-client__knowledge-editor label { display: grid; gap: 5px; color: var(--nobei-muted); font-size: 0.8rem; }
.nobei-client__knowledge-editor input, .nobei-client__knowledge-editor textarea { width: 100%; color: var(--nobei-ink); background: var(--nobei-surface); }
.nobei-client__knowledge-editor textarea { min-height: 120px; resize: vertical; }
.nobei-client__knowledge-actions { display: flex; gap: 8px; }
.nobei-client__knowledge-actions button:disabled { cursor: not-allowed; opacity: 0.55; }
.nobei-client__knowledge-edit-error { color: var(--nobei-rejected); }
.nobei-client__empty-result { margin-block: 26px; padding: 18px; border-inline-start: 3px solid var(--nobei-evidence); background: var(--nobei-paper); }
.nobei-client__live-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  .betterlearn-floating-root { --nobei-paper: #111722; --nobei-surface: #1A2230; --nobei-ink: #EDF2FA; --nobei-muted: #A8B1C2; --nobei-line: #354055; --nobei-action: #7C9BFF; }
  .nobei-client { --nobei-paper: #111722; --nobei-surface: #1A2230; --nobei-ink: #EDF2FA; --nobei-muted: #A8B1C2; --nobei-line: #354055; --nobei-action: #7C9BFF; --nobei-accepted: #69C6A0; --nobei-evidence: #E3A84B; --nobei-rejected: #E47B78; }
}
@media (max-width: 1000px) {
  .nobei-client__review { grid-template-columns: minmax(190px, 0.65fr) minmax(0, 1.35fr); }
  .nobei-client__evidence-reader { grid-column: 2; }
}
@media (max-width: 680px) {
  .betterlearn-floating-panel { inset: 0; width: 100%; height: 100dvh; max-width: none; max-height: 100dvh; border-radius: 0; }
  .betterlearn-resize-handle { display: none; }
  .nobei-client { padding: 14px; }
  .nobei-client__masthead { display: grid; gap: 12px; }
  .nobei-client__source-identity { justify-items: start; }
  .nobei-client__import, .nobei-client__progress, .nobei-client__result { padding: 20px 16px; border-radius: 13px; }
  .nobei-client__review { grid-template-columns: minmax(0, 1fr); }
  .nobei-client__candidate-nav { display: flex; flex-wrap: wrap; }
  .nobei-client__candidate-nav > p { flex-basis: 100%; }
  .nobei-client__candidate-nav button { width: auto; flex: 1 1 150px; }
  .nobei-client__evidence-reader { grid-column: 1; }
  .nobei-client__result-counts { grid-template-columns: 1fr; }
}
@media (prefers-reduced-motion: reduce) {
  .betterlearn-floating-panel { transition-duration: 0.01ms; }
  .nobei-client *, .nobei-client *::before, .nobei-client *::after { scroll-behavior: auto; transition-duration: 0.01ms; }
}
@container (max-width: 900px) {
  .nobei-client__review { grid-template-columns: minmax(150px, 0.65fr) minmax(0, 1.35fr); }
  .nobei-client__evidence-reader { grid-column: 2; }
}
@container (max-width: 580px) {
  .nobei-client__review { grid-template-columns: minmax(0, 1fr); }
  .nobei-client__evidence-reader { grid-column: 1; }
  .nobei-client__candidate-nav { max-height: 200px; }
}
@container (min-width: 720px) {
  .nobei-client-layout[data-history-open="true"] { grid-template-columns: var(--betterlearn-history-width) minmax(0, 1fr); }
  .nobei-client-layout[data-history-open="true"] > .nobei-history { position: static; width: auto; box-shadow: none; }
}
@container (max-width: 480px) {
  .nobei-client { padding: 14px; font-size: 14px; line-height: 1.55; }
  .nobei-client__masthead { display: grid; gap: 10px; margin-block-end: 16px; padding-block-end: 13px; }
  .nobei-client__masthead h1 { font-size: 1.7em; }
  .nobei-client__source-identity { justify-items: start; }
  .nobei-client__import, .nobei-client__progress, .nobei-client__result { padding: 18px 15px; border-radius: 13px; }
  .nobei-client__tabs { margin-block: 18px 14px; }
  .nobei-client__tabs button { padding: 8px 10px; }
  .nobei-client__input-panel input, .nobei-client__input-panel textarea, .nobei-client__candidate-card input, .nobei-client__candidate-card textarea { padding: 9px 10px; }
  .nobei-client__result-counts { gap: 7px; margin-block: 18px; }
  .nobei-client__result-counts div { padding: 11px 9px; }
  .nobei-client__result-counts dd { font-size: 1.55em; }
  .nobei-client__knowledge-list { gap: 9px; }
  .nobei-client__knowledge-list article { padding: 14px; }
}
@container (max-width: 400px) {
  .nobei-client { padding: 11px; font-size: 13px; }
  .nobei-client__masthead h1 { font-size: 1.55em; }
  .nobei-client__import, .nobei-client__progress, .nobei-client__result { padding: 15px 12px; }
  .nobei-client__result-counts div { padding: 9px 7px; }
  .nobei-client__knowledge-list article { padding: 12px; }
}
`

export function ensureClientStyles(doc: Document): void {
  if (doc.querySelector(`style[data-plugin-css="${CLIENT_STYLE_ID}"]`)) return
  const style = doc.createElement('style')
  style.setAttribute('data-plugin-css', CLIENT_STYLE_ID)
  style.textContent = CLIENT_CSS
  doc.head.appendChild(style)
}
