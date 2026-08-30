export const CLIENT_STYLE_ID = '@nobei/dsh-phase1/client'

export const CLIENT_CSS = `
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
  min-height: 100%;
  padding: clamp(18px, 3vw, 44px);
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
.nobei-client__review { display: grid; grid-template-columns: minmax(190px, 0.72fr) minmax(320px, 1fr) minmax(360px, 1.15fr); gap: 16px; align-items: start; }
.nobei-client__candidate-nav, .nobei-client__candidate-card, .nobei-client__evidence-reader { border: 1px solid var(--nobei-line); border-radius: 16px; background: var(--nobei-surface); }
.nobei-client__candidate-nav { display: grid; gap: 6px; padding: 14px; }
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
.nobei-client__empty-result { margin-block: 26px; padding: 18px; border-inline-start: 3px solid var(--nobei-evidence); background: var(--nobei-paper); }
.nobei-client__live-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (prefers-color-scheme: dark) {
  .nobei-client { --nobei-paper: #111722; --nobei-surface: #1A2230; --nobei-ink: #EDF2FA; --nobei-muted: #A8B1C2; --nobei-line: #354055; --nobei-action: #7C9BFF; --nobei-accepted: #69C6A0; --nobei-evidence: #E3A84B; --nobei-rejected: #E47B78; }
}
@media (max-width: 1000px) {
  .nobei-client__review { grid-template-columns: minmax(190px, 0.65fr) minmax(0, 1.35fr); }
  .nobei-client__evidence-reader { grid-column: 2; }
}
@media (max-width: 680px) {
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
  .nobei-client *, .nobei-client *::before, .nobei-client *::after { scroll-behavior: auto; transition-duration: 0.01ms; }
}
`

export function ensureClientStyles(doc: Document): void {
  if (doc.querySelector(`style[data-plugin-css="${CLIENT_STYLE_ID}"]`)) return
  const style = doc.createElement('style')
  style.setAttribute('data-plugin-css', CLIENT_STYLE_ID)
  style.textContent = CLIENT_CSS
  doc.head.appendChild(style)
}
