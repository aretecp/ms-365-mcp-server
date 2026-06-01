---
title: 'Never return a partial result as success: swallowed parse errors hide data-completeness failures'
module: 'ms-365-mcp-server'
date: 2026-06-01
problem_type: bug_pattern
component: tooling
severity: high
applies_when: 'An aggregation/merge step (pagination, batching, joining) parses or re-serializes upstream data inside a try whose catch only logs, and the surrounding code returns a success result regardless of whether the merge actually ran.'
related_components:
  - serialization
tags:
  - data-completeness
  - error-handling
  - pagination
  - serialization
  - silent-failure
  - toon
---

# Never return a partial result as success: swallowed parse errors hide data-completeness failures

## Context

`fetchAllPages` on the MCP list tools is supposed to follow `@odata.nextLink` and merge every Graph page into one response. The merge began with `JSON.parse(response.content[0].text)` inside a `try` whose `catch` only logged (`logger.error(...)`). The output format, however, is fixed at `GraphClient` construction (`new GraphClient(this.options.toon ? 'toon' : 'json')`) from `--toon` / `MS365_MCP_OUTPUT_FORMAT`. In TOON mode the response text is **not JSON**, so the very first `JSON.parse` threw, the catch swallowed the error, and `executeTool` returned the single first page with `isError: false`.

The result was the worst kind of bug: the model received page 1 only, labeled as a complete success, and had no way to know the rest of the data set existed. This silently violated the module's own cardinal rule — _never return a partial result as a success_.

## Guidance

- **A `catch` that only logs is a decision to return whatever was built so far.** If "so far" can be empty or partial, that is a silent data-completeness failure. Make the catch set `isError: true` (or rethrow) unless you can prove the partial value is acceptable.
- **When an operation is impossible in the current mode, refuse explicitly — do not let it fall through.** Here, page merging is impossible in TOON mode because the payload is not JSON. Detect the mode up front (`graphClient.format === 'toon'`) and return an actionable `isError: true` message that tells the operator how to proceed (switch to JSON output, or narrow the request), and do **not** follow `nextLink`.
- **Expose the single source of truth for cross-cutting mode/config.** The output format already lived on the constructed `GraphClient`; a small public `format` getter let the caller branch honestly (and is stubbable by mock-based tests) instead of re-deriving it.
- **Preserve the happy path byte-for-byte.** The JSON merge was correct; the fix only guards around it (re-indent under an `else`), so the regression surface is the guards, not the merge.

## Why This Matters

Partial-as-success is far more dangerous than a loud failure. A downstream agent makes confident decisions on incomplete data — wrong totals, missed records, "no results" when there were more pages. Because `isError` was `false`, nothing upstream, no log scan, and no test caught it. Honest errors are recoverable; silent partials corrupt every decision built on top of them.

## When to Apply

Apply whenever code:

- parses or re-serializes upstream payloads inside a `try` to aggregate them (pagination, batch joins, fan-in merges), **and**
- the surrounding function returns a success-shaped result regardless of whether the aggregation completed, **or**
- a global/constructed mode (output format, encoding, feature flag) can make the aggregation step impossible.

Audit the `catch`: if it only logs, ask "what does the caller receive now, and is it complete?" If the answer is "a partial," convert it to an error or refuse up front.

## Examples

Refuse when the operation is impossible in the current mode, and error (don't swallow) on merge failure:

```ts
const fetchAllPages = params.fetchAllPages === true;
if (fetchAllPages && response?.content?.[0]?.text) {
  if (graphClient.format === 'toon') {
    // Pages cannot be merged in TOON mode — refuse instead of returning page 1 as success.
    response.content[0].text = JSON.stringify({
      error:
        'fetchAllPages is not supported in TOON output mode: pages cannot be merged. ' +
        'Re-run in JSON output format, or narrow the request with filter/search/top.',
    });
    response.isError = true;
  } else {
    try {
      const combined = JSON.parse(response.content[0].text);
      // ... follow @odata.nextLink and merge every page ...
      response.content[0].text = JSON.stringify(combined);
    } catch (e) {
      // A parse/merge failure means we cannot guarantee a complete result set.
      // Surface it instead of falling through to the (partial) first page.
      logger.error(`Error during pagination: ${e}`);
      response.content[0].text = JSON.stringify({
        error: 'Pagination failed; result is incomplete. Retry or narrow the request.',
      });
      response.isError = true;
    }
  }
}
```

Regression tests that genuinely fail without the fix:

- `format: 'toon'` + a single TOON page **with** `@odata.nextLink` → assert `isError === true` and that `graphRequest` was called exactly once (no `nextLink` follow).
- `format: 'json'`, page 1 valid with `nextLink`, page 2 **not JSON** → assert `isError === true` with an "incomplete" message (not a silent single page).
- `format: 'json'` two valid pages → assert merged length equals the sum and `@odata.nextLink` is absent (happy path preserved).
