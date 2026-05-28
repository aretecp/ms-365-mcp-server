/**
 * HTML string builders for the admin UI. The admin UI ships zero
 * client-side JavaScript (form submission only) so XSS surface is limited
 * to whatever escapes through these templates.
 *
 * Every user-controlled value MUST pass through {@link escapeHtml}. The
 * Content-Security-Policy below also rules out inline script execution,
 * as a defense in depth.
 */

/** Returned by every admin handler. */
export const ADMIN_CSP = "default-src 'none'; form-action 'self'; style-src 'unsafe-inline'";

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
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #1d1d1f; }
  h1 { font-size: 1.5rem; border-bottom: 1px solid #d2d2d7; padding-bottom: 0.5rem; }
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
    `<h1>Policy editor</h1>
     <p>Signed in as <code>${escapeHtml(state.upn)}</code> · file <code>${escapeHtml(
       state.policyPath
     )}</code></p>
     ${banner}
     <form method="post" action="/admin/policy">
       <input type="hidden" name="csrf_token" value="${escapeHtml(state.csrfToken)}">
       <textarea name="yaml" spellcheck="false">${escapeHtml(state.yaml)}</textarea>
       <div class="row">
         <a href="/admin/logout"><button type="button" class="secondary">Sign out</button></a>
         <button type="submit">Save and reload</button>
       </div>
     </form>
     <footer>
       Changes write to disk atomically and trigger a hot-reload — no process restart needed.
       SIGHUP also reloads the file (operator-side edits picked up automatically).
     </footer>`
  );
}

export function errorPage(status: number, message: string): string {
  return shell(`Error ${status}`, `<h1>Error ${status}</h1><p>${escapeHtml(message)}</p>`);
}
