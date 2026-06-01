# Plan: Fix broken `npm run lint` — undeclared `@eslint/js` dependency (#20)

Date: 2026-06-01
Branch: `fix/eslint-js-dep-20`
Package manager of record: **npm** (`.github/workflows/ci.yml` runs `npm ci` + `npm run lint`; `package-lock.json` is the tracked lockfile).

## Confirmed root cause (verified first-hand)

`eslint.config.js` (flat config) directly imports four packages at the top:

```js
import js from '@eslint/js'; // line 1
import globals from 'globals'; // line 2
import tseslint from '@typescript-eslint/eslint-plugin'; // line 3
import tsparser from '@typescript-eslint/parser'; // line 4
```

Cross-checking each against `package.json` devDependencies:

| import     | package                            | declared in package.json? |
| ---------- | ---------------------------------- | ------------------------- |
| `js`       | `@eslint/js`                       | **NO (missing)**          |
| `globals`  | `globals`                          | yes (`^16.3.0`)           |
| `tseslint` | `@typescript-eslint/eslint-plugin` | yes (`^8.38.0`)           |
| `tsparser` | `@typescript-eslint/parser`        | yes (`^8.38.0`)           |

`@eslint/js` is **not declared anywhere**. It currently resolves only because it is a _transitive_ dependency of `eslint`:

```
npm ls @eslint/js
└─┬ eslint@9.39.4
  └── @eslint/js@9.39.4
```

This is a phantom/implicit dependency. The flat node_modules layout hoists the transitive copy to top-level, so `import '@eslint/js'` happens to resolve in a fully-populated tree — but this is not guaranteed. When the hoisted copy is absent (the dependency tree shape changes, eslint stops re-exporting it, or a pruned/clean install resolves differently), `eslint .` dies with `ERR_MODULE_NOT_FOUND: Cannot find package '@eslint/js'`, exactly as reported in #20. That failure cascades into `npm run verify` (`lint && format:check && build && test`).

The correct fix is to declare `@eslint/js` as a direct devDependency so the project no longer relies on a phantom dependency, keeping `package.json` and `package-lock.json` in sync (CI uses `npm ci`, which fails on drift).

### Note on reproduction in this worktree

In THIS worktree, `npm run lint` currently exits 0 (2 warnings, 0 errors) because `@eslint/js@9.39.4` is hoisted from the transitive install. This does not contradict the root cause — it confirms the dependency is phantom. The fix makes the dependency explicit and the build robust regardless of tree shape; it is not a behavior change visible in the happy-path local tree.

## Chosen approach (simplest honest fix)

Declare `@eslint/js` as a direct devDependency, version-matched to the installed/declared eslint major.

- eslint is declared `^9.31.0` and installed at `9.39.4`. `@eslint/js` versions in lockstep with eslint, currently `9.39.4`.
- Use `^9.31.0` for `@eslint/js` to mirror eslint's declared range (keeps the two aligned and avoids a tighter/looser pin that could drift from eslint).

### Decision: how to add it

Run the install so `package.json` AND `package-lock.json` update atomically:

```
npm install --save-dev @eslint/js@^9.31.0
```

Do NOT hand-edit `package.json` alone — that would desync the lockfile and break `npm ci` in CI. (Alternative considered and rejected: pinning to the exact installed `9.39.4`. Rejected because every other eslint-family dep here uses a caret range; `^9.31.0` matches the existing convention and the eslint range it must track.)

### Out of scope / must NOT do

- Do NOT add the untracked `pnpm-lock.yaml` / `pnpm-workspace.yaml` (abandoned experiment; absent from this worktree). npm is the manager of record.
- Do NOT change any other dependency versions.
- The other three flat-config imports are already declared — no further dependency additions needed.

## Files to change

1. `package.json` — add `"@eslint/js": "^9.31.0"` to `devDependencies` (alphabetically this lands at the top of the block, before `@semantic-release/*`). Done automatically by `npm install --save-dev`.
2. `package-lock.json` — updated automatically by the same `npm install` (promotes `@eslint/js` to a declared dependency entry while keeping the resolved `9.39.4`).

No source-code changes are expected. `eslint.config.js` is already correct and stays as-is.

## Test plan / regression verification

There is no unit test for lint. The regression test is the lint gate itself on a synced dependency tree.

1. **Primary regression assertion** — run from the worktree root:

   ```
   npm run lint   # i.e. `eslint .`
   ```

   ASSERT: exit code `0`. Current state: 2 `@typescript-eslint` **warnings** (`no-explicit-any` in `src/graph-client.ts:109`, unused `__dirname` in `src/logger.ts:7`) and **0 errors**. Warnings do not fail `eslint .`, so no code changes are required to reach exit 0. (If any of these were ERROR-level, they would already fail today; they are not.)

2. **Lockfile/CI sync assertion** — simulate CI's clean install:

   ```
   npm ci && npm run lint   # mirrors .github/workflows/ci.yml
   ```

   ASSERT: `npm ci` succeeds (no package.json↔lock drift) and `npm run lint` exits 0. This is the meaningful "fails-without-the-fix" check: without `@eslint/js` declared, a clean `npm ci` is not guaranteed to hoist it, and lint can throw `ERR_MODULE_NOT_FOUND`. With it declared, resolution is guaranteed.

3. **Downstream gates** — confirm nothing regressed:

   ```
   npm run build   # tsup
   npm test        # vitest run
   ```

   ASSERT: both exit 0 (green).

4. **Full gate** (optional but matches `verify`):
   ```
   npm run verify  # lint && format:check && build && test
   ```
   ASSERT: exit 0.

Capture the exact command + exit code for assertion (1) and (2) in the implementer's result.

## Implementer checklist

- [ ] `npm install --save-dev @eslint/js@^9.31.0` (updates package.json + package-lock.json together)
- [ ] Re-verify all four `eslint.config.js` imports are declared in package.json
- [ ] `npm run lint` → exit 0 (record exit code)
- [ ] `npm ci && npm run lint` → both succeed (record exit code)
- [ ] `npm run build` → green; `npm test` → green
- [ ] Do NOT stage `pnpm-lock.yaml` / `pnpm-workspace.yaml`; do NOT touch unrelated deps
