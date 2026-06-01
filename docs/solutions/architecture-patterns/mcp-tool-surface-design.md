---
title: 'Designing an ergonomic MCP tool surface without breaking authorization'
module: 'ms-365-mcp-server'
date: 2026-06-01
problem_type: architecture_pattern
component: tooling
severity: medium
applies_when: "Designing, consolidating, or shrinking an MCP server's tool surface — especially one that mirrors a backend API 1:1 and has per-tool authorization."
related_components:
  - authentication
tags:
  - mcp
  - tool-design
  - authorization
  - pagination
  - response-shaping
  - greenfield
---

# Designing an ergonomic MCP tool surface without breaking authorization

## Context

This server exposed **48 tools**, almost all 1:1 mirrors of Microsoft Graph endpoints — the classic "one tool per endpoint" surface that is hard for LLM agents to use: near-identical read tools cause wrong-tool selection, every session loads every schema, and list tools return Graph's full verbose payloads. We applied 2026 MCP best practices (response shaping, a path-resolver seam, read consolidations, a static toolset filter, per-toolset instruction scoping, and a `service-resource-action` rename). The durable lessons below are the ones that were non-obvious and cost real review/rework to get right.

## Guidance

### 1. The authorization invariant constrains every consolidation

If per-tool policy and preconditions key on a **stable `tool.name` with no param-level gating**, that fact dictates what you may merge:

- `Policy.check` resolves `deny → allow → defaults.allow → fail-closed` purely on `toolName`.
- Preconditions (`assertIsDraft`, `assertIsOrganizer`) run per tool and are the **real security boundary** — the tool description is advisory.

Therefore, when consolidating:

- **Never merge across read/write risk classes.** A merged tool's risk = max(parts); folding a read into a write forces the read to inherit write gating.
- **Never merge two writes of different blast radius** (e.g. a 1:1 chat DM and a team-wide channel broadcast) — the operator loses the ability to allow one and deny the other.
- **Never fold `delete` into another tool.** "Allow create, deny delete" is a real operator need.
- **Safe to merge:** reads of the same risk class differing only by an optional id (list-across vs list-in-folder, by-id vs root). These are the consolidations to reach for.

The optional-id merges are done with a per-tool `pathResolver(params) => string` plus a `resolverParams: string[]` list. The runtime **skips `resolverParams` in the param loop before the unknown-param fallback**, so a resolver-consumed `folder-id`/`drive-id` never leaks onto the query string.

### 2. A truncation/pagination envelope must not advertise a cursor it can't honor

When adding a response-size ceiling that drops list items, it is tempting to emit a `nextCursor` so the agent can "continue." A code review caught that ours was a **dead-end / wrong-offset contract**:

- **No tool consumed the cursor** — the model was told to "Pass nextCursor to continue" with no parameter to pass it to.
- **The cursor pointed past the dropped tail.** Truncation kept items `0..kept`, but the cursor was the page's original `@odata.nextLink` (`$skip=50`) — following it would skip the very items that were truncated.
- **It vanished after a full-pages merge.** The `fetchAllPages` block deletes `@odata.nextLink` _before_ the size-ceiling runs, so the cursor was always absent for merged exports anyway.

The honest contract is **narrow-only**: emit `{ value, truncated, returnedCount, totalCount, hint }` and have the hint steer the agent to narrow the request (`$filter`/`$search`/`$top`/`$select` or a tighter scope). Keep the backend's `value` key so the shape matches non-truncated responses and the merge logic.

### 3. Greenfield changes the playbook — apply best practices by design, not by telemetry

Anthropic's empirical method ("instrument, then refactor against transcripts") presumes traffic. For a **greenfield server with no production data, no deployed policy, no existing clients**, that scaffolding is the wrong frame — telemetry can't accrue, so "gate consolidation on usage" stalls forever. Apply the best practices by design instead. Greenfield also makes the otherwise-deferred `service-resource-action` rename **free**: there is no deployed `policy.yaml` to alias, so you rewrite the policy file directly instead of carrying a back-compat alias layer (which itself is an auth-bug risk if matched at check time rather than normalized at load time).

### 4. A toolset filter bounds the tool _surface_, not the OAuth scope

A static registration filter (a curated `CORE_TOOL_NAMES` set + an `MS365_MCP_TOOLSETS` env allowlist) is the biggest schema-token lever after response shaping. But be precise about what it controls: it changes which tools **register**, not what the access token **contains**. `resolveAuthScopes()` unions scopes over _all_ tools and consent happens once at login. Claiming "a core deployment never advertises `Sites.Read.All`" is false unless you _also_ make scope resolution toolset-aware and register the Entra app with only the core scopes. (An adversarial doc-review caught this exact false claim before implementation.)

## Why This Matters

These are the failure modes that don't show up in a passing test suite:

- A careless consolidation that merges a read into a write **silently coarsens authorization** — the operator can no longer gate them apart, and nothing fails loudly.
- A cursor that points at the wrong offset produces a **silent data gap**: the agent "continues" and skips items, confident it saw everything.
- Asserting scope reduction that the code doesn't deliver gives operators **false least-privilege confidence**.

## When to Apply

Any time you are designing or shrinking an MCP (or similar agent-tool) surface that (a) mirrors a backend 1:1, (b) has per-tool authorization keyed on tool name, or (c) returns large backend payloads. The greenfield-vs-traffic distinction applies whenever you're tempted to "gate this on usage data."

## Examples

**Safe optional-id read merge (path resolver + resolverParams):**

```ts
{
  name: 'mail-message-list',
  resolverParams: ['folder-id'],          // skipped in the param loop → never hits the query string
  pathResolver: (p) =>
    typeof p['folder-id'] === 'string' && p['folder-id'].length > 0
      ? `/me/mailFolders/${encodeURIComponent(p['folder-id'])}/messages`
      : '/me/messages',
  // ... shared OData params, mail projection
}
```

**Narrow-only truncation envelope (no cursor):**

```ts
envelope = {
  value: items.slice(0, kept),
  truncated: true,
  returnedCount: kept,
  totalCount: items.length,
  hint:
    `Response truncated to ${kept} of ${items.length} items to fit the context budget. ` +
    'Narrow the request ($filter/$search/$top/$select, or a tighter scope) — there is no continuation cursor.',
};
```

**Process that paid off:** research → plan → **two adversarial `document-review` rounds** → implement → `code-review`. The doc-review rounds caught, _before any code was written_, (a) the false OAuth-scope-reduction claim and (b) a drive-tool merge that would have folded `Sites.Read.All` SharePoint tools into a `Files.Read` OneDrive tool. Catching design errors at the plan stage is dramatically cheaper than catching them in implementation. The later `code-review` then caught the dead-end-cursor contract. Adversarial review at _both_ the plan and the diff stage is worth the cost on auth-touching work.
