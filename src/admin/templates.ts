/**
 * HTML string builders for the admin UI. The admin UI ships zero
 * client-side JavaScript (form submission only) so XSS surface is limited
 * to whatever escapes through these templates.
 *
 * Every user-controlled value MUST pass through {@link escapeHtml}. The
 * Content-Security-Policy below also rules out inline script execution,
 * as a defense in depth.
 */
import type { ToolCallEntry, ToolCallStatus } from './tool-call-log.js';

/** Returned by every admin handler. */
// form-action allows the POST /admin/login → 302 to login.microsoftonline.com
// to actually navigate. With just 'self' the browser silently blocks the
// redirect after the form submission. (Government clouds would need their
// own host added here; Areté is on the standard worldwide cloud.)
export const ADMIN_CSP =
  "default-src 'none'; form-action 'self' https://login.microsoftonline.com; style-src 'unsafe-inline'";

/** Escape the five characters that matter inside an HTML element or attribute. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const STYLE = `
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1100px; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  h1 { font-size: 1.5rem; border-bottom: 1px solid #d2d2d7; padding-bottom: 0.5rem; }
  h2 { font-size: 1.15rem; margin: 1.5rem 0 0.75rem; }
  .banner { padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; }
  .banner-ok { background: #e7f5e9; color: #1c5d2c; }
  .banner-err { background: #fde8e8; color: #8a1414; }
  textarea { width: 100%; min-height: 480px; font: 13px/1.4 ui-monospace, Menlo, monospace; padding: 0.75rem; box-sizing: border-box; border: 1px solid #c7c7cc; border-radius: 6px; }
  .row { display: flex; justify-content: space-between; align-items: center; margin: 1rem 0 0.5rem; }
  .row form { display: inline; }
  button { background: #0071e3; color: white; border: 0; padding: 0.5rem 1rem; border-radius: 6px; font-size: 0.9rem; cursor: pointer; }
  button.secondary { background: transparent; color: #0071e3; border: 1px solid #0071e3; }
  pre.error { background: #fff5f5; border: 1px solid #f3c1c1; padding: 0.75rem; border-radius: 6px; white-space: pre-wrap; }
  footer { margin-top: 2rem; color: #6e6e73; font-size: 0.85rem; }
  code { background: #f5f5f7; padding: 0.1rem 0.3rem; border-radius: 4px; }
  /* Header bar */
  .header-bar { display: flex; justify-content: space-between; align-items: center; background: #f5f5f7; border-radius: 8px; padding: 0.6rem 1rem; margin-bottom: 1.25rem; }
  .header-bar .title { font-weight: 600; font-size: 1rem; }
  .header-bar .meta { color: #6e6e73; font-size: 0.85rem; }
  .header-bar nav a { margin-left: 1rem; color: #0071e3; text-decoration: none; font-size: 0.9rem; }
  .header-bar nav a:hover { text-decoration: underline; }
  .header-bar .logout-form { display: inline; margin-left: 1rem; }
  .header-bar .logout-form button { background: transparent; color: #636366; border: 1px solid #c7c7cc; padding: 0.3rem 0.75rem; font-size: 0.85rem; }
  /* Tool call log table */
  .filter-bar { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
  .filter-bar label { font-size: 0.9rem; color: #3a3a3c; }
  .filter-bar select { padding: 0.3rem 0.5rem; border: 1px solid #c7c7cc; border-radius: 6px; font-size: 0.9rem; }
  .filter-bar button { padding: 0.3rem 0.75rem; font-size: 0.9rem; }
  table.log-table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
  table.log-table th { background: #f5f5f7; text-align: left; padding: 0.5rem 0.6rem; border-bottom: 2px solid #d2d2d7; white-space: nowrap; }
  table.log-table th a { color: #1d1d1f; text-decoration: none; }
  table.log-table th a:hover { text-decoration: underline; }
  table.log-table td { padding: 0.45rem 0.6rem; border-bottom: 1px solid #e5e5ea; vertical-align: top; }
  table.log-table tr:last-child td { border-bottom: none; }
  .status-badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.8rem; font-weight: 500; }
  .status-allowed { background: #e7f5e9; color: #1c5d2c; }
  .status-denied_by_policy { background: #fff0e0; color: #7a3800; }
  .status-precondition_failed { background: #fff0e0; color: #7a3800; }
  .status-graph_error { background: #fde8e8; color: #8a1414; }
  .status-unauthorized { background: #fde8e8; color: #8a1414; }
  details { margin: 0; }
  details summary { cursor: pointer; color: #0071e3; font-size: 0.8rem; }
  details pre { margin: 0.4rem 0 0; background: #f5f5f7; padding: 0.5rem; border-radius: 4px; white-space: pre-wrap; word-break: break-all; font-size: 0.8rem; max-width: 480px; }
  .empty-state { color: #6e6e73; padding: 2rem; text-align: center; }
  /* Policy summary card */
  .policy-card { background: #f5f5f7; border-radius: 8px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
  .policy-card .card-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
  .policy-card h2 { margin: 0; font-size: 1rem; }
  .policy-section { margin-bottom: 0.75rem; }
  .policy-section-label { font-size: 0.8rem; font-weight: 600; color: #6e6e73; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem; }
  .tool-pill { display: inline-block; background: #e5e5ea; padding: 0.1rem 0.45rem; border-radius: 4px; font-size: 0.8rem; margin: 0.1rem; }
  .tool-pill.allow { background: #e7f5e9; color: #1c5d2c; }
  .tool-pill.deny { background: #fde8e8; color: #8a1414; }
  .user-row { margin-bottom: 0.5rem; font-size: 0.875rem; }
  .user-row .upn { font-weight: 500; margin-right: 0.5rem; }
`;

function shell(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)} · Areté M365 MCP</title>
<style>${STYLE}</style>
</head>
<body>${body}</body>
</html>`;
}

export function loginPage(): string {
  return shell(
    'Sign in',
    `<h1>Areté M365 MCP — admin</h1>
     <p>Sign in with your Areté Microsoft 365 account to manage the policy.</p>
     <form method="post" action="/admin/login"><button>Sign in with Microsoft</button></form>`
  );
}

export interface PolicyEditorState {
  yaml: string;
  upn: string;
  csrfToken: string;
  policyPath: string;
  saved: boolean;
  error: string | null;
}

export function policyEditorPage(state: PolicyEditorState): string {
  const banner = state.error
    ? `<div class="banner banner-err"><strong>Save failed:</strong><pre class="error">${escapeHtml(
        state.error
      )}</pre></div>`
    : state.saved
      ? `<div class="banner banner-ok">Policy saved and reloaded.</div>`
      : '';

  return shell(
    'Policy editor',
    `${headerBar(state.upn, state.csrfToken)}
     <h1>Policy editor</h1>
     <p>File: <code>${escapeHtml(state.policyPath)}</code></p>
     ${banner}
     <form method="post" action="/admin/policy">
       <input type="hidden" name="csrf_token" value="${escapeHtml(state.csrfToken)}">
       <textarea name="yaml" spellcheck="false">${escapeHtml(state.yaml)}</textarea>
       <div class="row">
         <span></span>
         <button type="submit">Save and reload</button>
       </div>
     </form>
     <footer>
       Changes write to disk atomically and trigger a hot-reload — no process restart needed.
       SIGHUP also reloads the file (operator-side edits picked up automatically).
     </footer>`
  );
}

// ---------------------------------------------------------------------------
// Dashboard — tool call log table
// ---------------------------------------------------------------------------

export type SortColumn = 'ts' | 'upn' | 'toolName' | 'status' | 'latencyMs';
export type SortOrder = 'asc' | 'desc';

/** Columns users can sort by, with display labels. */
const SORTABLE_COLUMNS: Array<{ key: SortColumn; label: string }> = [
  { key: 'ts', label: 'Time' },
  { key: 'upn', label: 'User' },
  { key: 'toolName', label: 'Tool' },
  { key: 'status', label: 'Status' },
  { key: 'latencyMs', label: 'Latency' },
];

const ALL_STATUSES: ToolCallStatus[] = [
  'allowed',
  'denied_by_policy',
  'precondition_failed',
  'graph_error',
  'unauthorized',
];

function statusBadge(status: ToolCallStatus): string {
  return `<span class="status-badge status-${escapeHtml(status)}">${escapeHtml(status.replace(/_/g, ' '))}</span>`;
}

function relativeTime(ts: number): string {
  const diffSec = Math.floor((Date.now() - ts) / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  return `${diffHr}h ago`;
}

function absoluteTime(ts: number): string {
  return new Date(ts).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

function sortLink(
  col: SortColumn,
  currentSort: SortColumn,
  currentOrder: SortOrder,
  filterStatus: string
): string {
  const nextOrder = currentSort === col && currentOrder === 'desc' ? 'asc' : 'desc';
  const indicator = currentSort === col ? (currentOrder === 'desc' ? ' ▼' : ' ▲') : '';
  const params = new URLSearchParams({
    sort: col,
    order: nextOrder,
    ...(filterStatus ? { status: filterStatus } : {}),
  });
  return `<a href="?${params.toString()}">${SORTABLE_COLUMNS.find((c) => c.key === col)!.label}${indicator}</a>`;
}

export function toolCallTable(
  rows: ToolCallEntry[],
  currentSort: SortColumn,
  currentOrder: SortOrder,
  filterStatus: string
): string {
  const filterOptions = [
    `<option value=""${filterStatus === '' ? ' selected' : ''}>All statuses</option>`,
    ...ALL_STATUSES.map(
      (s) =>
        `<option value="${escapeHtml(s)}"${filterStatus === s ? ' selected' : ''}>${escapeHtml(s.replace(/_/g, ' '))}</option>`
    ),
  ].join('');

  const filterBar = `
    <form class="filter-bar" method="get" action="/admin/dashboard">
      <input type="hidden" name="sort" value="${escapeHtml(currentSort)}">
      <input type="hidden" name="order" value="${escapeHtml(currentOrder)}">
      <label for="status-filter">Filter by status:</label>
      <select id="status-filter" name="status">${filterOptions}</select>
      <button type="submit">Apply</button>
    </form>`;

  if (rows.length === 0) {
    return `${filterBar}<p class="empty-state">No tool calls recorded yet. In-memory log; cleared on restart.</p>`;
  }

  const headerCells = SORTABLE_COLUMNS.map(
    (col) => `<th>${sortLink(col.key, currentSort, currentOrder, filterStatus)}</th>`
  ).join('');

  const bodyRows = rows
    .map((row) => {
      const hasDetail = row.argsExcerpt || row.responseExcerpt || row.errorText;
      const detailContent = hasDetail
        ? `<details>
            <summary>details</summary>
            ${row.argsExcerpt ? `<pre>args: ${escapeHtml(row.argsExcerpt)}</pre>` : ''}
            ${row.responseExcerpt ? `<pre>response: ${escapeHtml(row.responseExcerpt)}</pre>` : ''}
            ${row.errorText ? `<pre>error: ${escapeHtml(row.errorText)}</pre>` : ''}
          </details>`
        : '';
      return `<tr>
        <td title="${escapeHtml(absoluteTime(row.ts))}">${escapeHtml(relativeTime(row.ts))}</td>
        <td>${escapeHtml(row.upn ?? '<anonymous>')}</td>
        <td><code>${escapeHtml(row.toolName)}</code></td>
        <td>${statusBadge(row.status)}</td>
        <td>${row.latencyMs}ms</td>
        <td>${detailContent}</td>
      </tr>`;
    })
    .join('');

  return `${filterBar}
    <table class="log-table">
      <thead><tr>${headerCells}<th>Details</th></tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>`;
}

// ---------------------------------------------------------------------------
// Dashboard page
// ---------------------------------------------------------------------------

export interface DashboardState {
  upn: string;
  csrfToken: string;
  rows: ToolCallEntry[];
  sort: SortColumn;
  order: SortOrder;
  filterStatus: string;
  /** Placeholder until Phase 3 wires in the policy summary card. */
  policySummaryHtml: string;
}

export function headerBar(upn: string, csrfToken: string): string {
  return `<div class="header-bar">
    <div>
      <span class="title">Areté M365 MCP</span>
      <nav>
        <a href="/admin/dashboard">Dashboard</a>
        <a href="/admin/policy">Edit policy YAML</a>
      </nav>
    </div>
    <div style="display:flex;align-items:center;gap:0.75rem">
      <span class="meta">Signed in as <code>${escapeHtml(upn)}</code></span>
      <form class="logout-form" method="post" action="/admin/logout">
        <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
        <button type="submit">Sign out</button>
      </form>
    </div>
  </div>`;
}

export function dashboardPage(state: DashboardState): string {
  const tableHtml = toolCallTable(state.rows, state.sort, state.order, state.filterStatus);

  return shell(
    'Dashboard',
    `${headerBar(state.upn, state.csrfToken)}
     <h1>Dashboard</h1>
     ${state.policySummaryHtml}
     <h2>Recent tool calls <span style="font-weight:normal;color:#6e6e73;font-size:0.9rem">(last ${state.rows.length} shown, in-memory — cleared on restart)</span></h2>
     ${tableHtml}
     <footer>In-memory log; cleared on restart. Showing up to 200 most recent calls.</footer>`
  );
}

// ---------------------------------------------------------------------------
// Error page
// ---------------------------------------------------------------------------

export function errorPage(status: number, message: string): string {
  return shell(`Error ${status}`, `<h1>Error ${status}</h1><p>${escapeHtml(message)}</p>`);
}
