# MCP Server Design — Best Practices (2026) and a Plan for This Server

**Date:** 2026-05-30
**Author:** Generated for Areté (SGL) via a multi-agent research workflow (19 agents, 84 findings, 10 claims independently fact-checked).
**Scope:** How to design an ergonomic MCP tool surface in 2026, and a concrete, critique-hardened plan to shrink this server from **48 endpoint-mirrored tools** to a smaller, workflow-shaped set — without breaking its per-user policy gating.

> **One-line takeaway:** Tool *count* is a symptom; the disease is **endpoint-shaped tools + unbounded responses**. The two highest-leverage fixes for *this* read-heavy server — **server-side response shaping** and **deferring the read-heavy long tail** — are independent of how many tools we cut. Do those first. Consolidate second, and only where telemetry and the policy boundary both allow it.

---

## Part 1 — The design principles

Ranked, most important first. Confidence and sources noted. Claims that did **not** survive fact-checking are quarantined in [Part 4](#part-4--contested-or-weak-claims-do-not-over-trust).

### 1. Design tools around agent *workflows*, not API endpoints
One tool per Graph endpoint produces many narrow, overlapping tools that create ambiguous decision points and burn schema tokens before any work starts. Collapse chained calls into intent-shaped tools, and merge `create`/`update` pairs into a single "upsert" keyed on the presence/absence of an id (Linear ships exactly one `create-or-update issue`).
*Anthropic "Writing effective tools for agents" (2025-09-11); Linear MCP changelog (2025-05-01). High confidence.*

### 2. Don't front-load every schema — defer the long tail
Tool schemas load into context *before* any work; large sets can eat 30–50% of the window, and degradation past a threshold is a cliff, not a slope. GitHub trimmed Copilot from 40→13 core tools for a 2–5pp accuracy gain and ~400ms lower latency; their 162-tool server ships only **3** discovery tools by default. Anthropic's Tool Search Tool cut tool-definition tokens ~85% and raised selection accuracy (49%→74% on Opus 4). Keep a small always-on **core**; gate the rest.
*GitHub Blog "fewer tools" (2025-11-19); Anthropic "Advanced tool use" (2025-11-24). High confidence.*

### 3. Filter and cap responses server-side — the #1 win for a read-heavy server
Response bloat degrades agents up to **91%** even when it fits in context; Microsoft observed single tool calls averaging 557K tokens. Stripping a 50-field payload to 3–5 fields cuts ~80–90% of tokens. Anthropic caps Claude Code tool responses at **25,000 tokens** and recommends pagination + filtering + truncation with sane defaults. **Truncation must be marked** and tell the agent how to get more.
*Anthropic "Writing effective tools"; Microsoft Research "Tool-Space Interference" (2025-09-11); MCP Pagination spec (2025-03-26). High confidence.*

### 4. Enforce read/write/destructive policy deterministically, per call, at the server
A capable model can reason around instructions in its context; annotations are self-reported hints a buggy or malicious server can lie about, and do nothing against prompt injection. A valid session must **not** become a blanket tunnel. (The Kiro incident — an agent that deleted and recreated an AWS environment, 13h outage — is what missing deterministic gates cost.) **This server already does this correctly** with fail-closed, per-user, per-tool YAML. The design rule that follows: *when you merge tools, the merged tool's risk class = the max of its parts; never merge a read into a write.*
*PolicyLayer/TrueFoundry "Enterprise MCP Governance"; GitGuardian "OAuth for MCP". High confidence.*

### 5. Keep tools narrow with strict typed schemas — never a free-form omnibus tool
The "one tool that takes a string and picks the operation at runtime" (Lokka-style raw Graph passthrough) looks elegant but is a privilege-escalation primitive: maximal blast radius, per-tool authorization becomes impossible, and audit logs become uninterpretable. Schema rigor (enums over strings, validated IDs, host allow-lists) is what makes a *fatter* consolidated tool safe rather than confusing.
*Underlying least-privilege principle: high confidence. The specific "omnibus" framing is from a vendor blog — directionally right, not gospel.*

### 6. Invest in description, parameter-name, and disambiguation hygiene
Small description refinements yield outsized gains. Front-load the key fact (including prerequisites); name params `user_id` not `user`; document every param like a prompt; and for confusable tools, add an explicit **"when NOT to use this — use X instead"** note. An audit found 72% of params in Anthropic's own reference Filesystem server had *zero* descriptions.
*Anthropic "Writing effective tools"; arXiv "MCP Tool Descriptions Are Smelly!". High confidence.*

### 7. Name and namespace by `service` + `resource` + consistent verb
Namespacing reduces wrong-tool selection and prevents collisions (Microsoft found `search` across 32 servers; `get_user` in 10–11). `service_resource_action` clustering groups operations under alphabetical sort and makes policy/toolset boundaries legible. Stay within `[a-zA-Z0-9_-]`, ≤64 chars (MCP + OpenAI client compatibility); don't rely on dots/slashes. **Prefix-vs-suffix is eval-driven, not assumed.**
*Anthropic; AWS Prescriptive Guidance; Microsoft Research. High confidence — but see the renaming risk in Part 3.*

### 8. Pick the right primitive: Tools for actions/queries, Resources for static reference
Tools are model-controlled (auto-invoked, may have side effects); Resources are application-controlled read-only context. Wrapping static reference data in `get_*` tools wastes a call and blurs the trust boundary. But anything whose retrieval depends on a **model-derived parameter** (search a mailbox, filter messages) is inherently a Tool, even if read-only.
*MCP spec 2025-06-18. High confidence.*

### 9. Ship a concise server `instructions` manual — scoped to the enabled toolset
Instructions are injected once at init, before tool schemas, and carry cross-cutting guidance descriptions can't (ordering, which tool first). GitHub measured 85% optimal-workflow adherence *with* instructions vs 60% without (GPT-4-mini: 20%→80%). Rule of thumb: **no instructions beat bad instructions**; scope them to active toolsets.
*MCP blog "Using server instructions" (2025-11-03). High confidence.*

### 10. Use elicitation for human-in-the-loop confirmation of writes — as UX, not the gate
Elicitation (spec 2025-06-18) lets the server pause a destructive call and request a structured confirm/decline. Client support is uneven, so it must **layer on top of** deterministic server-side enforcement, never replace it. Never collect secrets/PII via elicitation.
*Glama elicitation; MCP spec 2025-06-18. High confidence — but the "echoed opaque-token" embellishment is NOT supported; see Part 4.*

### 11. Develop tools empirically — instrument, then refactor against real transcripts
It's hard to *predict* which tools agents find ergonomic. Anthropic's method: capture per-call metrics (call count, runtime, tokens, errors) and let Claude refactor the tool set against real transcripts. Match each fix to its bottleneck (bloated definitions → Tool Search; large results → response shaping; param errors → better examples). Use real services, not toy sandboxes.
*Anthropic "Writing effective tools" / "Advanced tool use". High confidence.*

### 12. Per-user identity + structured per-call audit are the foundation
"If you can't say who invoked this tool, when, with what scope, you have a confused deputy." Shared tokens make per-user audit impossible and fail HIPAA/SOC2/GDPR. Use per-user downstream tokens; never pass the client's inbound token through to Graph. **This server already has per-user SQLite OAuth + an admin tool-call log** — preserve and harden it (append-only, redaction, retention) through any redesign. Consolidation must not erase the stable tool identity each audit row keys on.
*ByteBridge/Red Hat/Aembit audit guidance; GitGuardian. High confidence.*

### 13. Consider a code-execution path for heavy data movement — later, and sandboxed
Code execution keeps intermediate data out of model context (a Drive→Salesforce workflow dropped 150K→2K tokens, 98.7%). Powerful, but it needs a sandbox and it *sidesteps per-tool policy/audit* unless you re-impose them — a real tension for a security-gated server. Low priority here; revisit only if bulk export/cross-resource workflows emerge.
*Anthropic "Code execution with MCP"; Cloudflare "Code Mode". High confidence.*

---

## Part 2 — How this maps to our 48 tools

Current surface (mostly 1:1 with Graph): **Mail 8 · Calendar 6 · Teams 18 · SharePoint 8 · Files 3 · Users 2 · Utility 2 · Identity 1**.

What the codebase already gets right (don't regress these):
- **Fail-closed per-user, per-tool YAML policy** with admin UI (`policy/index.ts` keys on `tool.name`). This is principle #4, done correctly.
- **Per-user OAuth sessions + admin tool-call log** (principle #12).
- **`buildMcpServerInstructions`** already carries the right cross-cutting guidance (principle #9).
- **`download-bytes`** is the correct single-tool consolidation for *all* binary reads — the model the rest should follow.

What's **not** built yet (despite assumptions to the contrary):
- **No response shaping.** `clampTopQueryParam` only *clamps* `$top` and returns early when it's absent — there is **no default page size and no field projection**. The model is merely *told* to pass `$select`. (Principle #3 — our biggest gap.)
- **No progressive disclosure.** `registerTools` registers `ALL_TOOLS` unconditionally — there is no `--discovery`/`--preset`/`--enabled-tools` machinery in this rewrite. (Principle #2.)

---

## Part 3 — The plan (critique-hardened)

A full consolidation plan was generated and then adversarially reviewed. The review caught several items where consolidation **hurts the agent or quietly coarsens policy**. The recommendations below are the *post-critique* version — they differ from the raw plan in the places marked ⚠️.

### The load-bearing constraint
`policy.check` **and** the preconditions (`assertIsDraft`, `assertIsOrganizer`) both key on a stable `tool.name`, with **no param-level gating**. Therefore:
1. **Never merge across read/write risk classes.** A merged tool's risk = max(parts).
2. **Never merge two writes of different blast radius** (chat DM vs channel broadcast) — it destroys the operator's ability to allow one and deny the other.
3. **Keep every `delete` standalone** — "allow create, deny delete" is a real operator need.

### Do these first (highest leverage, independent of tool count)

| # | Change | Why |
|---|--------|-----|
| **M0** | **Instrument before cutting.** Mine the existing admin tool-call log for co-used reads and for which writes operators actually split in deployed `policy.yaml`. | Anthropic's empirical method (#11). Lets telemetry, not intuition, drive the rest. |
| **M2** | **Response shaping.** Default `$select` projections per resource (`Minimal*` field allow-lists) + default `$top` (~15) + a ~25K-token ceiling with a **marked** truncation object `{truncated, nextCursor, hint}` + a `response_format: minimal\|detailed` enum. | The single biggest token win for a read-heavy server (#3). **Ship even if zero consolidation lands.** |

`Minimal*` starting projections:
- **mail:** `id, subject, from, toRecipients, receivedDateTime, bodyPreview, isRead, hasAttachments`
- **event:** `id, subject, start, end, organizer, attendees, isAllDay, onlineMeeting`
- **driveItem:** `id, name, size, folder, file, webUrl, lastModifiedDateTime`
- **user:** `id, displayName, userPrincipalName, mail, jobTitle, department`

### Safe consolidations (all-reads, same risk class, no policy break)

These collapse confusable read tools via an optional id. The committed `policy.yaml` already lists each set together in `defaults.allow`, so there's no gating loss.

- **`mail-message-list`** ← `list-mail-messages` + `list-mail-folder-messages` (optional `folder-id`).
- **`calendar-view`** ← `get-calendar-view` + `list-calendar-events`. ⚠️ **Ship the conservative version only:** rename `get-calendar-view`, drop `list-calendar-events`. Do **not** build the `/me/events` series-master fallback — two result shapes behind one tool (expanded instances vs unexpanded masters) is a silent-wrong-answer footgun.
- **`drive-children-list`** ← `list-folder-files` + `list-drive-root-children` + `list-drive-folder-children` (optional `drive-id`, `item-id`).
- **`drive-item-get`** ← `get-drive-item` + `get-drive-item-by-id` + `get-drive-root-item`.
- **`online-meeting-find`** ← `find-online-meeting` + `get-online-meeting` (lookup by `meeting-id` *or* `join-web-url`; build the `$filter` in code so the model never hand-writes OData).

**Implementation note (critique-corrected):** do **not** build a generic `pathResolver`. The runtime already substitutes any `{placeholder}`. For each read merge, use a *tiny per-tool resolver that returns a fully-substituted path* and a unit test asserting **no unsubstituted `{brace}` survives**. Scope this to merges that survive M0 telemetry.

### Write consolidations — proceed with caution, gated on M0

- **`mail-draft-upsert`** ← `create-draft-email` + `update-mail-message`, and **`calendar-event-upsert`** ← `create-` + `update-calendar-event`.
  ⚠️ **The precondition collision is real, not a doc tweak.** `assertIsDraft`/`assertIsOrganizer` currently *require* the id and throw when absent — they'd reject the create branch. Merging forces the precondition to no-op when the id is absent, which means **the create path has zero server-side guard while sharing one policy entry with the guarded update path.** Recommendation: **keep these split** unless M0 shows (a) operators never allow-create-deny-update and (b) the team accepts an explicit "create branch is unguarded by design" test. The upsert saves exactly one tool per pair at the cost of touching the most safety-critical code in the repo.
- **`online-meeting-upsert`** ← `create-` + `update-online-meeting`. Lower risk (no draft/organizer precondition), but same one-policy-entry consideration.
- ⚠️ **Teams send — do NOT build the `teams-message-send` omnibus.** A `target` enum collapsing chat DM + channel broadcast into one tool coarsens policy (loses allow-DM-deny-broadcast) **and** creates conditional-required params Zod can't enforce (the model guesses, the precondition rejects *after*). **Instead:** keep `send-chat-message` and `send-channel-message` separate (distinct blast radius, distinct policy identity); at most merge `send-channel-message` + `send-channel-message-reply` (a reply is structurally a child of a channel post). Net 3→2, no enum, policy split preserved.

### Defer the long tail (progressive disclosure)

⚠️ **Critique: skip dynamic discovery tools.** For an operator-gated server, a second orthogonal enable/disable layer largely duplicates `policy.yaml`. Use **static, deployment-time toolset selection**: a `toolset` tag on `Tool` + an env/config allowlist filtering registration at `registerTools`. Keep the genuinely valuable part — **per-toolset instruction scoping** (a Mail-only session shouldn't carry Teams HTML guidance). Default-load a CORE toolset of always-needed reads; defer **SharePoint** (`list-sites`/`get-site`/`list-site-*`), **Teams channel internals**, **transcripts**, and **all writes**.

### Things to NOT do (yet)

- ⚠️ **Defer the `service_resource_action` rename indefinitely.** It's the lowest-value, highest-blast-radius item: it breaks every deployed `policy.yaml`. **And the alias approach in the raw plan is an auth bug** — matching "name OR any alias" at *check* time means a `deny` on one spelling doesn't block the other (allow/deny are separate exact-string sets). If you ever rename, **normalize old→new at policy *load* time** so `check()` stays single-key and fail-closed.
- **No Lokka-style omnibus Graph tool** (#5).
- **No code-execution path** yet (#13).

### Suggested order
**M0** (instrument) → **M2** (response shaping — ship alone) → safe read merges → *(only if M0 justifies)* write merges → static toolsets + per-toolset instructions → Resources for static reference (OData/KQL rules, scope map) → optional elicitation preview+confirm on writes.

**Drop the "48→26" hard target.** A fixed number pressures consolidations through where telemetry would veto them. Let the count fall out of "remove confusable duplicate reads where telemetry shows co-use and the policy boundary allows it."

---

## Part 4 — Contested or weak claims (do not over-trust)

These were quoted in the raw research but **failed or only partly survived** fact-checking:

- **Empirical tool-count thresholds** ("40–50 onset," "~30–80 confusion," "~5-server ceiling") come from *anecdotal practitioner comments* in MCP GitHub Discussions, **not controlled benchmarks**. Use as a directional range, not a hard limit.
- **The dry-run + confirm + echoed-opaque-token destructive-action pattern** is only partly supported. The `dry_run` preview is fine; the "opaque token / hash of previewed args so confirm provably matches" piece is in **no cited source**. Use plain preview + explicit confirm.
- **"Description quality is independent of tool count"** — an extrapolation the source doesn't make. Both are real levers; don't assume orthogonality.
- **Sub-agent context isolation** — real technique, but Claude Code requires MCP tools enabled at the *main-agent* level, so the orchestrator still pays full token cost. Verify your host before relying on it.
- **CSV-over-JSON ~29–58% savings** — real benchmark, but the cited source advocates TOON/positional tuples, **not CSV**; and it's not an Anthropic recommendation. CSV is brittle with embedded commas/quotes.
- **Microsoft "Agent 365 / Work IQ SharePoint" remote MCP** — preview-stage signal ("coming soon"), not shipped fact.
- **OTel MCP semantic conventions "merged Jan 2026"** — medium confidence, vendor-sourced. Verify the span/attribute schema against the OpenTelemetry spec before building on it.

---

## Sources (primary, high-confidence)

- Anthropic — *Writing effective tools for agents* (2025-09-11); *Advanced tool use* / Tool Search Tool (2025-11-24); *Code execution with MCP*.
- MCP specification (2025-06-18): tools, resources, elicitation; Pagination spec (2025-03-26).
- GitHub Blog — *Fewer, better tools* (2025-11-19); `github-mcp-server` toolsets & dynamic discovery.
- Linear MCP changelog (2025-05-01) — create-or-update keyed on id.
- Microsoft Research — *Tool-Space Interference in the MCP Era* (2025-09-11).
- MCP blog — *Using server instructions* (2025-11-03).
- GitGuardian — *OAuth for MCP*; PolicyLayer/TrueFoundry — *Enterprise MCP Governance*.

*Generated by the `mcp-tool-redesign` workflow. The companion Claude skill (`mcp-server-design`) and agent (`sglyon-mcp-reviewer`) in the `sgldev` plugin operationalize these principles for planning, building, and reviewing.*
