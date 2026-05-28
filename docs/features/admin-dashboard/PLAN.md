# Plan: Admin Dashboard Redesign

**Status**: In Progress
**Created**: 2026-05-28
**Last updated**: 2026-05-28

## Summary

Replace the single-textarea `/admin/policy` page with a real landing dashboard for the two human operators (`slyon@aretepartners.com`, `dgiordano@aretepartners.com`). v1 ships three things: recent tool-call log (last ~200 in-process), policy summary card, and a header bar with the signed-in UPN + Logout. The existing YAML editor stays intact, just one click away. Success = operators can see at a glance what the server is doing, who's hitting denied tools, and which user has what allowed — without tailing logs.

## Approach

- Server-side HTML only. Reuse `shell()` + the `STYLE` block in `src/admin/templates.ts`; add new templates alongside `policyEditorPage`.
- New landing route `GET /admin` (currently 302s to `/admin/policy`). Keep `/admin/policy` reachable for the editor; landing dashboard becomes the default post-login.
- Tool-call log sourced from an in-process ring buffer (no DB). Instrumentation hook lives in `src/tool-runtime.ts::executeTool` and the utility-tool wrapper `registerUtilityToolWithMcp`.
- Sort + filter via query params (`?sort=ts&order=desc&status=denied_by_policy`). No client JS — keeps the current CSP (`default-src 'none'; ... style-src 'unsafe-inline'`) untouched.
- All new POSTs (Logout button) carry CSRF tokens generated via `src/admin/csrf.ts`.

No brainstorm/research doc exists for this feature — direction came from a 1:1 with the user (captured in the prompt).

## Affected Files / Components

| File / Component                          | Change                                                                                                                                                                                                                                                                          | Why                                                                                      |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `src/admin/tool-call-log.ts` (new)        | Ring buffer class + module-level singleton; `record(entry)`, `snapshot()`, `clear()`                                                                                                                                                                                            | Owns the bounded in-memory log. Single source of truth.                                  |
| `src/tool-runtime.ts`                     | Wrap `executeTool` end (success + error) and the utility-tool handler with `toolCallLog.record(...)`. Capture tool name, UPN from `getRequestContext()`, status enum, latency ms, truncated args, response excerpt, error text.                                                 | This is where the policy check + Graph call already happen — the natural choke point.    |
| `src/admin/templates.ts`                  | Add `dashboardPage(state)`, `headerBar(upn, csrfToken)`, `toolCallTable(rows, sortQuery)`, `policySummaryCard(summary)`. Extend `STYLE` (table, card, header). Reuse `escapeHtml`.                                                                                              | Keep all HTML building in one file (existing convention).                                |
| `src/admin/router.ts`                     | New `GET /admin/dashboard` (guarded). Change `GET /` to render the dashboard instead of redirecting to `/policy`. New `POST /admin/logout` (CSRF-checked) replacing the link-style GET logout. Keep `GET /admin/logout` for back-compat during rollout, then delete in phase 4. | Dashboard is the new landing; logout becomes a real form to satisfy CSRF posture.        |
| `src/policy/index.ts`                     | Add `Policy.summary()` returning `{ defaultAllow: string[]; users: Array<{ upn: string; allow: string[]; deny: string[] }> }`. Expose via `PolicyManager.summary()`.                                                                                                            | Dashboard needs a structured view of the policy without re-parsing YAML in the template. |
| `test/admin-dashboard.test.ts` (new)      | Supertest coverage: unauthed → 401, non-admin → 403, admin GET renders table + summary, sort/filter query params, logout POST clears cookie + revokes session.                                                                                                                  | Mirrors existing `test/admin-policy-edit.test.ts` patterns.                              |
| `test/tool-call-log.test.ts` (new)        | Ring buffer eviction, ordering, redaction of long args / known sensitive keys.                                                                                                                                                                                                  | Unit-level, no Express.                                                                  |
| `test/tool-runtime-logging.test.ts` (new) | `executeTool` records one entry per call with correct status enum for: allowed, denied_by_policy, precondition refusal, graph error, unknown UPN.                                                                                                                               | Verifies the instrumentation point is wired correctly.                                   |

## Implementation Steps

### Phase 1 — Ring buffer + tool-runtime instrumentation (no UI changes)

- [x] Create `src/admin/tool-call-log.ts`: `ToolCallLog` class with `capacity` (default 200), `record(entry)`, `snapshot()` (returns newest-first copy). Module-level singleton `toolCallLog`.
- [x] Define `ToolCallEntry` type: `{ id: string; ts: number; upn: string | null; toolName: string; status: ToolCallStatus; latencyMs: number; argsExcerpt: string; responseExcerpt: string | null; errorText: string | null }`.
- [x] Define `ToolCallStatus = 'allowed' | 'denied_by_policy' | 'precondition_failed' | 'graph_error' | 'unauthorized'`.
  - `allowed`: tool ran, no `isError`.
  - `denied_by_policy`: `policy.check` returned false.
  - `precondition_failed`: `tool.precondition` threw.
  - `graph_error`: `executeTool`'s outer catch fired OR `response.isError === true`.
  - `unauthorized`: reserved for future use when we tag 401s from upstream Graph.
  - **Note**: no `validation_error`. Zod validation runs inside `McpServer.tool()` _before_ our handler is invoked, so a schema rejection never reaches `executeTool` — the SDK returns the error to the client directly. Confirmed by trace at `src/tool-runtime.ts:427-437`.
- [x] Implement redaction helper `redactArgs(params)`: stringify, drop keys matching `/password|secret|token|authorization/i`, then truncate to 512 chars. `redactResponse(text)`: truncate to 512 chars, strip nothing else (already JSON-serialized Graph response).
- [x] In `src/tool-runtime.ts::executeTool`, wrap the body with `const startedAt = Date.now()`. At each terminal return (policy denied, precondition failed, success, outer catch), call `toolCallLog.record({...})`. Pass the resolved status enum. Use `getRequestContext()?.userPrincipalName ?? null` for UPN.
- [x] Mirror the instrumentation in `registerUtilityToolWithMcp`'s wrapped handler.
- [x] Write `test/tool-call-log.test.ts` (ring eviction at capacity+1, ordering newest-first, redaction strips sensitive keys, truncates long values).
- [x] Write `test/tool-runtime-logging.test.ts` using existing test harness patterns from `test/policy-manager.test.ts` + `test/write-tools.test.ts`. One assertion per status path.
- [x] Confirm: nothing user-visible changes. Deployable on its own.

**Files touched**: `src/admin/tool-call-log.ts` (new), `src/tool-runtime.ts`, two new test files.
**Rough size**: ~200 LOC prod + ~250 LOC tests. Half a day.

### Phase 2 — Dashboard landing page with log table

- [x] Add `dashboardPage({ upn, csrfToken, rows, sort, order, filterStatus })` to `src/admin/templates.ts`. Renders header bar + table only (summary card lands in phase 3 — stub the section with a placeholder div).
- [x] Add `toolCallTable(rows, currentSort, currentOrder, currentFilter)` builder. Columns: ts (relative + absolute on hover via `title` attr), UPN, tool name, status (color-coded span via inline class), latency ms, expand toggle.
- [x] Expand-in-row: use `<details><summary>` semantics — pure HTML, no JS, no CSP impact. Body shows `argsExcerpt` + `responseExcerpt` / `errorText` in `<pre>`.
- [x] Sortable columns rendered as `<a href="?sort=COL&order=…">` links. Filter via status dropdown wrapped in a `<form method="get">` — CSP `form-action 'self'` already allows this.
- [x] Extend `STYLE`: `.table { width: 100%; border-collapse: collapse; ... }`, `.status-allowed/.status-denied/.status-error`, `.header-bar { display: flex; ... }`.
- [x] `GET /admin/dashboard` handler in `src/admin/router.ts` (guarded by `requireAdmin`): read `toolCallLog.snapshot()`, apply server-side sort + filter, render `dashboardPage`.
- [x] Change `GET /admin/` (currently redirects to `/admin/policy`) → redirect to `/admin/dashboard`.
- [x] Update the post-login redirect in `GET /admin/callback` from `/admin/policy` to `/admin/dashboard`.
- [x] Add a "Edit policy YAML" button on the dashboard linking to `/admin/policy` (existing editor untouched).
- [x] Write `test/admin-dashboard.test.ts`: anonymous → 401, mortal user → 403, admin sees table, sort/filter query params reorder/restrict rows, expanded `<details>` content present in HTML.

**Files touched**: `src/admin/templates.ts`, `src/admin/router.ts`, one new test file.
**Rough size**: ~250 LOC prod + ~150 LOC tests. Half to full day.

### Phase 3 — Policy summary card

- [ ] Add `Policy.summary()` + `PolicyManager.summary()` returning structured data (see Affected Files table). Test in `test/policy.test.ts`.
- [ ] Add `policySummaryCard(summary)` template: defaults section listing allowed tools, then per-user rows showing UPN + their allow/deny diffs relative to defaults.
- [ ] Wire `opts.policyManager.summary()` through dashboard handler into `dashboardPage`.
- [ ] Replace the placeholder div in `dashboardPage` with the rendered card. "Edit YAML" button stays on this card.
- [ ] Test: card renders default allow list, per-user diffs displayed correctly, no users → only defaults shown.

**Files touched**: `src/policy/index.ts`, `src/admin/templates.ts`, `src/admin/router.ts`, `test/policy.test.ts`, `test/admin-dashboard.test.ts`.
**Rough size**: ~120 LOC prod + ~80 LOC tests. Half day.

### Phase 4 — Logout button + header polish

- [ ] Add `POST /admin/logout` handler in `src/admin/router.ts`: verify CSRF, revoke session, clear cookie, redirect to `/admin/login`. Mirror the existing GET logout's logic.
- [ ] Header bar template: signed-in UPN on the left, `<form method="post" action="/admin/logout">` with hidden CSRF token + Logout button on the right.
- [ ] Apply the header on both `/admin/dashboard` and `/admin/policy` (operators will hop between them).
- [ ] Replace `GET /admin/logout` with a `405 Method Not Allowed`. **Decided**: cleaner than a courtesy redirect; no external link relies on the GET today.
- [ ] Test: POST without CSRF → 403, POST with CSRF → 302 + cookie cleared + `sessionManager.revokeSession` called.

**Files touched**: `src/admin/router.ts`, `src/admin/templates.ts`, `test/admin-dashboard.test.ts` (extend) or new `test/admin-logout.test.ts`.
**Rough size**: ~80 LOC prod + ~60 LOC tests. Quarter day.

## Out of Scope

- Persistent log storage / SQLite tool-call table. Ring buffer only.
- Pagination beyond the in-memory N rows.
- Real-time tail / SSE / WebSockets. Refresh = page reload.
- Tool-call detail drawer with full request/response. `<details>` expand-in-row only.
- Per-tool counters, charts, time-series.
- Search box for the log (status filter only).
- CSV / JSON export of the log.
- Horizontal scaling — design assumes single pod / single instance.

## Risks / Tradeoffs

- **PII in args/response logging.** Highest-impact risk. Examples: `send_mail` body, calendar event subject, attachment filenames. Mitigation: (a) truncate args + response to 512 chars; (b) strip keys matching `password|secret|token|authorization`; (c) the log is admin-only (gated by `requireAdmin` + the same UPN allowlist as the policy editor). Residual risk: a truncated email body fragment is still a leak to an operator. **Accept** for v1 — the same operators already have full Graph access via their own sessions; the new exposure is "see what other admins are drafting." If we add non-admin viewers later this needs revisiting.
- **Restart wipes the log.** Acceptable for day-one; operators are warned via a footer note ("In-memory log; cleared on restart").
- **Memory.** 200 rows × ~1 KB = ~200 KB. Negligible.
- **Concurrency.** `ToolCallLog.record` runs inside the AsyncLocalStorage scope of each MCP call. Node is single-threaded JS so a plain array push + shift is safe; no mutex needed. Call out in code comment to avoid future "let's make it async" temptation.
- **Status enum drift.** Adding a new outcome later (e.g., `rate_limited`) requires updating both the recorder and the filter dropdown. Centralize the enum in `src/admin/tool-call-log.ts` and import everywhere — don't re-declare.
- **CSP loosening if we ever add JS.** Avoid in v1 via server-side sort/filter. If we add JS in v2 (search-as-you-type, etc.), use a nonce on the script tag and add `script-src 'nonce-…'` to ADMIN_CSP — do NOT add `'unsafe-inline'`.

## Open Questions

All six v1 questions resolved during plan review (2026-05-28):

1. **`validation_error` reachable?** No — traced `src/tool-runtime.ts:427-437`; SDK runs zod _before_ our handler. **Dropped from the enum.**
2. **Separate "viewer" UPN tier?** No — same `MS365_MCP_POLICY_ADMINS` allowlist gates both the log and policy edit. Revisit if a third UPN ever needs log-only access.
3. **Truncation length env-configurable?** No — hardcode 512 for v1.
4. **`GET /admin/logout`?** Replace with `405` (no courtesy redirect).
5. **Latency scope?** Full handler (`Date.now() - startedAt` at top of `executeTool`). Includes policy check, more useful for slow-path debugging.
6. **UPN for pre-identity utility calls?** Render `<anonymous>` in the table (hiding the row loses the "server got a hit" signal).

## Skills / Agents to Use

- **pre-impl-audit** (before phase 1): we're adding a hook at the tool-dispatch site. Grep every caller of `executeTool` + `registerUtilityToolWithMcp` to confirm we're not missing a code path that bypasses the instrumentation.
- **compounder** (post-phase-4): capture the pattern "thin server-side dashboard over an in-process ring buffer" — likely reusable for future admin views.
- Standard `/execute` flow for each phase. Each phase is shippable on its own; do not batch them into one PR.
