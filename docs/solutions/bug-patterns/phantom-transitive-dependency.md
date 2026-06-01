---
title: 'Declare every package you import: phantom (transitive-only) dependencies break on clean installs'
module: 'ms-365-mcp-server'
date: 2026-06-01
problem_type: bug_pattern
component: build-tooling
severity: medium
applies_when: 'A module imports a package that is not listed in package.json dependencies/devDependencies and only resolves because npm hoisted a transitive copy into a flat node_modules.'
related_components:
  - ci
  - linting
tags:
  - dependencies
  - phantom-dependency
  - npm
  - node-modules-hoisting
  - eslint
  - flat-config
  - ci
---

# Declare every package you import: phantom (transitive-only) dependencies break on clean installs

## Context

`npm run lint` failed with `ERR_MODULE_NOT_FOUND: Cannot find package '@eslint/js'`
imported from `eslint.config.js` (issue #20). The ESLint flat config imports four
packages at the top:

```js
import js from '@eslint/js';
import globals from 'globals';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
```

Three of those four were declared in `package.json`. `@eslint/js` was not — it only
resolved because npm's flat `node_modules` hoisted a transitive copy that ships with
`eslint` itself (`npm ls @eslint/js` showed `eslint@9.39.4 -> @eslint/js@9.39.4`).
This is a **phantom dependency**: code that imports a package the project never
declared, relying on it being hoisted from some other dependency's subtree.

The bug is intermittent by nature. On a tree where the transitive copy happens to be
hoisted, `import '@eslint/js'` resolves and lint passes. On a clean / pruned / differently
shaped tree (different npm version, a future eslint that bundles its own private copy,
pnpm's strict non-hoisted layout, or `npm ci` resolving differently), the hoisted copy is
absent and the import throws `ERR_MODULE_NOT_FOUND` — which is exactly what CI hit while
the same command passed locally.

## Guidance

If a file `import`s or `require`s a package, that package MUST appear in the project's
own `package.json` (`dependencies` or `devDependencies`). Never depend on it being
hoisted as a transitive dependency of something else.

- Fix by declaring it directly: `npm install --save-dev @eslint/js@^9.31.0`. This
  updates `package.json` and `package-lock.json` atomically so they stay in sync (CI's
  `npm ci` fails on any drift).
- Pick a version range consistent with the rest of the family. `@eslint/js` ships in
  lockstep with `eslint`, so mirror eslint's declared range (`^9.31.0`) and the caret
  convention used by the other eslint-family deps rather than pinning the exact installed
  `9.39.4`.
- Prove the fix the way the bug manifests: run a **clean** install (`npm ci`) and then
  the failing command. Passing on the already-populated working tree is not proof — the
  hoisted copy is still there. To reproduce the original failure first-hand, temporarily
  move the hoisted copy out (`mv node_modules/@eslint/js /tmp`) and rerun; the
  `ERR_MODULE_NOT_FOUND` reappears.

## Why This Matters

Phantom dependencies are silent until the dependency tree reshapes, and then they fail
in CI or on a teammate's machine while working fine for whoever introduced them. They
make the build non-reproducible and are a common source of "works on my machine" bugs.
Declaring every imported package makes resolution guaranteed instead of luck-of-the-hoist,
and keeps the project portable across npm versions and package managers.

## When to Apply

- Any `ERR_MODULE_NOT_FOUND` / "Cannot find package" that only happens on clean installs
  or in CI but not in a long-lived local checkout.
- Config files (eslint, prettier, vitest, tsup, postcss) that import plugins/presets —
  these are the most common place a needed package is left undeclared because it tags
  along with the main tool.
- Reviewing a dependency-tree or lockfile change: cross-check every top-level `import` in
  config and source against `package.json`.

## Examples

Detect undeclared-but-imported packages before they bite:

```bash
# What pulls @eslint/js into node_modules today? If it's only transitive, it's phantom.
npm ls @eslint/js
# eslint@9.39.4 -> @eslint/js@9.39.4   <-- not a direct dep == phantom

# Declare it directly (updates package.json + lockfile together):
npm install --save-dev @eslint/js@^9.31.0

# Prove resolution is now guaranteed, not hoist luck:
npm ci && npm run lint   # both must exit 0
```

Tooling that surfaces this class of bug automatically: `depcheck`,
`eslint-plugin-import/no-extraneous-dependencies`, and pnpm's strict (non-hoisted)
`node_modules` layout, which fails fast on any undeclared import.
