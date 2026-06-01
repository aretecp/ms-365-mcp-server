# Plan: Fix `fetchAllPages` silently returning only page 1 in TOON output mode (#19)

Date: 2026-06-01
Branch: `fix/toon-fetchallpages-19`

## Confirmed root cause (verified first-hand)

In `src/tool-runtime.ts`, `executeTool` runs a `fetchAllPages` merge block (lines ~411–456). The
very first thing it does is:

```ts
const combined = JSON.parse(response.content[0].text); // line 414
```

The whole merge — following `@odata.nextLink`, concatenating page `value` arrays, deleting
`@odata.nextLink` — lives inside one `try` whose `catch` only logs:

```ts
} catch (e) {
  logger.error(`Error during pagination: ${e}`);          // line 454 — swallowed
}
```

In TOON output mode the response text is **not JSON**. The format is decided at
construction time: `src/server.ts:72` does `new GraphClient(this.options.toon ? 'toon' : 'json')`,
and `--toon` / `MS365_MCP_OUTPUT_FORMAT=toon` set `options.toon` in `src/cli.ts:41`. `GraphClient`
stores the format in a private readonly field `outputFormat` (`src/graph-client.ts:70`) and
`serializeData` (line 182) emits TOON via `toonEncode` for every response.

So in TOON mode `JSON.parse(response.content[0].text)` throws on line 414, the `catch` logs and
falls through, and `executeTool` returns the **single first page unchanged** with
`isError: false`. The model believes it has the complete result set — a silent
data-completeness failure. This directly violates the module's own contract documented at
`src/tool-runtime.ts:81–100` ("never return a partial result as success"; the same doc already
notes the merge "assumes JSON" and "In TOON output mode the text is not JSON").

Note `fetchAllPages` is only offered on GET list tools (`buildMcpParamSchema`, line 529-538) and
`isListTool` requires a `top` param, so the affected calls are always list-shaped — there is no
secondary non-list path to worry about.

## Chosen approach: refuse `fetchAllPages` in TOON mode + stop swallowing

Two independent honesty bugs must both be fixed:

1. **TOON mode + `fetchAllPages` is unsupported** → return `isError: true` with a clear message
   (issue suggestion 1b), rather than attempting a parse that is guaranteed to fail.
2. **The merge `catch` must not return silent partial success** (issue suggestion 2) → if the
   JSON merge throws for any reason (in JSON mode), surface an explicit `isError: true` instead of
   falling through to a single-page "success".

### Why 1b (refuse) over 1a (re-request as JSON + re-encode as TOON)

- **Simpler and lower-risk.** 1a means threading a per-request format override through
  `graphRequest` → `makeRequest` → `formatJsonResponse`/`serializeData`, re-fetching every page as
  JSON, merging, then re-encoding the merged object as TOON — a much larger change touching the
  serialization core, with new failure modes (re-encode failure, ceiling interaction).
- **Honest and sufficient.** The cardinal rule (lines 81–100) is "never return a partial result as
  success." Refusing with a clear `isError` satisfies that and tells the operator exactly how to
  proceed (drop `--toon` for this export, or page manually). TOON's purpose is token reduction on
  routine reads; a full multi-page export is the one case where the JSON path is appropriate.
- 1a can be a future enhancement; it is not required to make the behavior honest.

### Detecting the active format

`GraphClient.outputFormat` is `private readonly` with no accessor. Add a minimal public getter:

```ts
get format(): 'json' | 'toon' {
  return this.outputFormat;
}
```

(Public getter, not exposing the field, keeps it read-only.) `executeTool` already holds the
`graphClient` instance, so it can branch on `graphClient.format === 'toon'`. Do **not** read the
env var directly in `executeTool` — the constructed client is the single source of truth (env and
`--toon` are already collapsed into it at construction), and a getter is what the existing
mock-based tests can stub.

## Files to change

1. **`src/graph-client.ts`** — add the `format` getter on `GraphClient`.

2. **`src/tool-runtime.ts`** — in `executeTool`, within the `if (fetchAllPages && response?.content?.[0]?.text)` block (lines ~411–456):
   - **Before** the `try`/`JSON.parse`: if `graphClient.format === 'toon'`, do **not** attempt the
     merge. Return an explicit error result (reuse the existing `JSON.stringify({ error, tip })`
     shape used elsewhere in this file, e.g. `policyDeniedResult`) with `isError: true` and a
     message like: _"fetchAllPages is not supported in TOON output mode: page merging requires JSON
     and would silently drop pages. Re-run without --toon / MS365_MCP_OUTPUT_FORMAT=toon to export
     all pages, or page manually."_ Record it in `toolCallLog` consistent with the other early
     returns. (A small `paginationUnavailableResult(tool, message)` helper mirroring
     `preconditionFailedResult` keeps this clean.)
   - **Change the `catch`** (line 453-455): on a merge/parse error in JSON mode, stop returning the
     untouched single page as success. Return `isError: true` with a clear message (e.g.
     _"Pagination failed while merging pages for tool '<name>': <err>. The result may be
     incomplete; not returning a partial page as success."_) and record it in `toolCallLog`.
     The merge must succeed fully or the call must error — never a silent partial.
   - Preserve the JSON happy path exactly (lines 414–452 unchanged): successful multi-page merge in
     JSON mode still concatenates pages, updates `@odata.count`, deletes `@odata.nextLink`, and
     re-serializes.

No changes to `serializeData`, `formatJsonResponse`, `cli.ts`, or `server.ts`.

## Test plan

New test file: **`test/toon-fetchallpages.test.ts`** (vitest), following the existing
`test/response-truncation.test.ts` pattern: import `executeTool` + `ALL_TOOLS`, mock
`../src/logger.js`, and drive `executeTool` against a mocked GraphClient. Use a real list tool such
as `mail-message-list` via `ALL_TOOLS.find(...)`.

Because `executeTool` now branches on `graphClient.format`, the mock GraphClient must expose a
`format` getter/property (the real getter is what production uses; the mock object provides the same
surface). Provide a small `makeGraphClient(format, pages)` helper whose `graphRequest` returns the
TOON or JSON text for each successive page and whose `format` returns `'json' | 'toon'`.

Assertions:

1. **`refuses fetchAllPages in TOON mode (no silent single page)`**
   - GraphClient with `format: 'toon'`; `graphRequest` returns a single TOON-encoded page that
     _contains_ an `@odata.nextLink` (i.e. more pages exist).
   - Call `executeTool(mailListTool, gc, { fetchAllPages: true })`.
   - Assert `result.isError === true` and the error text mentions TOON / not supported.
   - Assert the result is **not** the silent single page (no successful `value`-only payload with
     `isError: false`). `graphRequest` must have been called **exactly once** (no attempt to follow
     the nextLink, no re-fetch).
   - **This test FAILS without the fix**: today TOON mode hits `JSON.parse` → throws → `catch` logs →
     returns the single page with `isError: false` (or `undefined`), so the `isError === true`
     assertion fails. This is the core regression guard for #19.

2. **`merges all pages in JSON mode (regression: JSON behavior preserved)`**
   - GraphClient with `format: 'json'`; `graphRequest` returns page 1 (JSON, with an
     `@odata.nextLink` pointing to page 2) then page 2 (JSON, no nextLink).
   - Call with `{ fetchAllPages: true }`.
   - Assert `result.isError` is falsy, the merged `value` contains items from **both** pages
     (length === sum), `@odata.nextLink` is absent, and `graphRequest` was called twice.
   - Guards that the TOON refusal did not regress the JSON multi-page merge.

3. **`errors instead of silently returning a partial page when merge fails in JSON mode`**
   - GraphClient with `format: 'json'`; first `graphRequest` returns a valid JSON page-1 with an
     `@odata.nextLink`, but the second `graphRequest` (page 2) returns **non-JSON** text (simulating
     a mid-merge parse failure) — or page 1 itself is malformed JSON.
   - Assert `result.isError === true` with a "pagination failed / incomplete" style message.
   - **This test FAILS without the fix**: today the `catch` logs and returns the partial/first page
     with `isError: false`.

4. **(Optional sanity) `does not engage pagination when fetchAllPages is omitted`**
   - `format: 'toon'`, call with `{}` (no `fetchAllPages`).
   - Assert `result.isError` is falsy and the single TOON page is returned untouched — confirms the
     refusal is scoped strictly to `fetchAllPages: true` and normal TOON reads are unaffected.

Run: `pnpm test test/toon-fetchallpages.test.ts` plus the existing
`test/odata-nextlink.test.ts` and `test/response-truncation.test.ts` to confirm no regression, then
the full `pnpm test`.

## Out of scope / non-goals

- Implementing 1a (re-request-as-JSON-then-re-encode-as-TOON). Documented as a possible future
  enhancement; not needed for an honest fix.
- Any change to the response-size ceiling / `shapeResponseSize` behavior.
- Changing the default output format or CLI flags.
