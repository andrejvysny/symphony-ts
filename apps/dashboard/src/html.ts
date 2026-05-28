/** Minimal observability dashboard — vanilla JS polling /api/v1/state. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Symphony</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; background: #0d1117; color: #e6edf3; }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 20px; border-bottom: 1px solid #21262d; }
  header h1 { font-size: 16px; margin: 0; font-weight: 600; }
  header .totals { margin-left: auto; color: #8b949e; font-size: 12px; }
  .board { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; padding: 20px; }
  .col { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 12px; min-height: 120px; }
  .col h2 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #8b949e; margin: 0 0 10px; display: flex; justify-content: space-between; }
  .card { background: #0d1117; border: 1px solid #30363d; border-radius: 6px; padding: 10px; margin-bottom: 8px; }
  .card .id { font-size: 11px; color: #58a6ff; font-family: ui-monospace, monospace; }
  .card .title { font-size: 13px; margin-top: 2px; }
  .card .meta { font-size: 11px; color: #8b949e; margin-top: 6px; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: 999px; font-size: 10px; background: #21262d; color: #8b949e; }
  .blocked .card { border-color: #f0883e; }
  .empty { color: #6e7681; font-size: 12px; font-style: italic; }
</style>
</head>
<body>
<header>
  <h1>🎼 Symphony</h1>
  <span id="gen" class="badge">connecting…</span>
  <span class="totals" id="totals"></span>
</header>
<div class="board">
  <section class="col" id="col-running"><h2>Running <span id="c-running">0</span></h2><div class="list"></div></section>
  <section class="col blocked" id="col-blocked"><h2>Blocked <span id="c-blocked">0</span></h2><div class="list"></div></section>
  <section class="col" id="col-retrying"><h2>Retrying <span id="c-retrying">0</span></h2><div class="list"></div></section>
  <section class="col" id="col-summary"><h2>Summary</h2><div class="list"></div></section>
</div>
<script>
function el(html) { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstChild; }
function esc(s) { return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function runningCard(r) {
  return '<div class="card" data-test="running-card"><div class="id">' + esc(r.issue_identifier) + '</div>' +
    '<div class="meta"><span class="badge">' + esc(r.state) + '</span> turn ' + (r.turn_count ?? 0) +
    ' · ' + (r.tokens ? r.tokens.total_tokens : 0) + ' tok</div></div>';
}
function blockedCard(b) {
  return '<div class="card" data-test="blocked-card"><div class="id">' + esc(b.issue_identifier) + '</div>' +
    '<div class="meta">' + esc(b.reason) + '</div></div>';
}
function retryCard(r) {
  return '<div class="card" data-test="retry-card"><div class="id">' + esc(r.issue_identifier) + '</div>' +
    '<div class="meta"><span class="badge">' + esc(r.delay_type) + '</span> attempt ' + r.attempt + '</div></div>';
}
function fill(colId, items, render) {
  const list = document.querySelector('#' + colId + ' .list');
  list.innerHTML = items.length ? items.map(render).join('') : '<div class="empty">none</div>';
}
async function refresh() {
  try {
    const res = await fetch('/api/v1/state');
    const s = await res.json();
    document.getElementById('gen').textContent = 'updated ' + new Date(s.generated_at).toLocaleTimeString();
    document.getElementById('c-running').textContent = s.counts.running;
    document.getElementById('c-blocked').textContent = s.counts.blocked;
    document.getElementById('c-retrying').textContent = s.counts.retrying;
    document.getElementById('totals').textContent =
      s.counts.completed + ' completed · ' + s.codex_totals.total_tokens + ' tokens · ' +
      Math.round(s.codex_totals.seconds_running) + 's agent-time';
    fill('col-running', s.running, runningCard);
    fill('col-blocked', s.blocked, blockedCard);
    fill('col-retrying', s.retrying, retryCard);
    const sum = document.querySelector('#col-summary .list');
    sum.innerHTML = '<div class="card"><div class="meta">running ' + s.counts.running +
      '<br/>blocked ' + s.counts.blocked + '<br/>retrying ' + s.counts.retrying +
      '<br/>completed ' + s.counts.completed + '</div></div>';
  } catch (e) {
    document.getElementById('gen').textContent = 'disconnected';
  }
}
refresh();
setInterval(refresh, 2000);
</script>
</body>
</html>`;
