## [2.6.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.5.0...v2.6.0) (2026-06-01)

### New Features

* **prod:** expose full tool surface (MS365_MCP_TOOLSETS=all) ([#24](https://github.com/aretecp/ms-365-mcp-server/issues/24)) ([ff18c38](https://github.com/aretecp/ms-365-mcp-server/commit/ff18c3870ee9f5acb3f751e0594feb35bd1a6b58))

## [2.5.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.4.1...v2.5.0) (2026-06-01)

### New Features

* **oauth:** broker OAuth with Dynamic Client Registration (point-and-connect) ([#23](https://github.com/aretecp/ms-365-mcp-server/issues/23)) ([bc63d0b](https://github.com/aretecp/ms-365-mcp-server/commit/bc63d0b272b6c0513aaf7b295d5c197de5454a74))

## [2.4.1](https://github.com/aretecp/ms-365-mcp-server/compare/v2.4.0...v2.4.1) (2026-06-01)

### Bug Fixes

* declare @eslint/js as direct devDependency ([#20](https://github.com/aretecp/ms-365-mcp-server/issues/20)) ([74a6b02](https://github.com/aretecp/ms-365-mcp-server/commit/74a6b02fdcbad6d586d8c43bcd9038b027ac663d))
* never return a silent partial from fetchAllPages in TOON mode ([#19](https://github.com/aretecp/ms-365-mcp-server/issues/19)) ([8c9e1bc](https://github.com/aretecp/ms-365-mcp-server/commit/8c9e1bc857f96ce34f5039c0557885663a44f692))

## [2.4.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.3.0...v2.4.0) (2026-06-01)

### New Features

* **instructions:** per-toolset instruction scoping (U7) ([ac0321c](https://github.com/aretecp/ms-365-mcp-server/commit/ac0321cfa17ceea06ab719ea622ddc4d31ef95d8))
* **runtime:** per-tool path-resolver seam (U2a) ([94399ba](https://github.com/aretecp/ms-365-mcp-server/commit/94399ba68f55d9284ac5a794b171b96d82ea8df9))
* **runtime:** server-side response shaping (U1) ([e2e59fc](https://github.com/aretecp/ms-365-mcp-server/commit/e2e59fcbfbca3ff7f8cf01f09bb06c6b42f06d38))
* **runtime:** static toolset tags + registration filter (U6) ([ad85a01](https://github.com/aretecp/ms-365-mcp-server/commit/ad85a01b2cb925c28bbbc4f23b16d3f299056de6))
* **tools:** consolidate mail list tools into mail-message-list (U3) ([05d72fd](https://github.com/aretecp/ms-365-mcp-server/commit/05d72fd6226b603bd5871002a084d96f2a1ec22f))
* **tools:** consolidate OneDrive + SharePoint drive reads (U4) ([8b13a67](https://github.com/aretecp/ms-365-mcp-server/commit/8b13a676bb8a28085eb449b8ad54ec89b202e723))
* **tools:** online-meeting-find + conservative calendar-view (U5) ([f1f1f54](https://github.com/aretecp/ms-365-mcp-server/commit/f1f1f54ba48088c662cde91c8998a3ff70f6196c))

### Bug Fixes

* **review:** address ce-code-review findings ([2956714](https://github.com/aretecp/ms-365-mcp-server/commit/2956714e6b85999c7c94c61dc0ae61052f636c69))

### Improvements

* apply 2026 MCP best practices to the tool surface ([#18](https://github.com/aretecp/ms-365-mcp-server/issues/18)) ([f1487c1](https://github.com/aretecp/ms-365-mcp-server/commit/f1487c17baeaf86f73abd09272127ecc7565c4ad))
* **tools:** adopt service-resource-action naming (U2b) ([b395659](https://github.com/aretecp/ms-365-mcp-server/commit/b395659b742f37db4a61a3f9aac8ed93408e6355))

## [2.3.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.2.4...v2.3.0) (2026-05-28)

### New Features

* admin dashboard landing page with tool call log table ([8ba3c50](https://github.com/aretecp/ms-365-mcp-server/commit/8ba3c507e037029723ac23079a8e4ba5deece217))
* CSRF-protected POST /admin/logout, replace GET with 405 ([5c52f0b](https://github.com/aretecp/ms-365-mcp-server/commit/5c52f0b6272e3fb2cf7f818b4fb61571024959ca))
* policy summary card on admin dashboard ([235c523](https://github.com/aretecp/ms-365-mcp-server/commit/235c5231f07716ede9cb6e837959ae75442eb71c))
* ring buffer instrumentation for tool call logging ([818890e](https://github.com/aretecp/ms-365-mcp-server/commit/818890e5c14882bf4fb9e234c22dc49f6a5b2b78))

## [2.2.4](https://github.com/aretecp/ms-365-mcp-server/compare/v2.2.3...v2.2.4) (2026-05-28)

### Bug Fixes

* **admin:** allow login.microsoftonline.com in CSP form-action ([7eb6d8e](https://github.com/aretecp/ms-365-mcp-server/commit/7eb6d8eacf8dda0d796eda0b6bc217738a17e220))
* **admin:** use sameSite lax on admin session cookie ([e997831](https://github.com/aretecp/ms-365-mcp-server/commit/e997831d6ab700572af93eb368c8d8df9c2d4e2b))

## [2.2.3](https://github.com/aretecp/ms-365-mcp-server/compare/v2.2.2...v2.2.3) (2026-05-28)

### Bug Fixes

* **admin:** make sign-in button POST to /admin/login so OAuth actually starts ([4c4197c](https://github.com/aretecp/ms-365-mcp-server/commit/4c4197c0ee321c52cd835157b70be21664138803))

## [2.2.2](https://github.com/aretecp/ms-365-mcp-server/compare/v2.2.1...v2.2.2) (2026-05-28)

### Bug Fixes

* **ci:** create bind-mount dirs owned by uid 1000 before docker compose up ([c8c1175](https://github.com/aretecp/ms-365-mcp-server/commit/c8c117595d61f309bfeffbe9bdf9bd42c35a8e3b))
* **deploy:** seed /policy/policy.yaml from example on first container start ([a32bf07](https://github.com/aretecp/ms-365-mcp-server/commit/a32bf0777cfa58311f430b03e6ba225b7faaa56b))
* **deploy:** use named docker volumes for /data and /policy ([f862cc6](https://github.com/aretecp/ms-365-mcp-server/commit/f862cc6b5f9d55db986abc518124aae6c0bf9171))

## [2.2.1](https://github.com/aretecp/ms-365-mcp-server/compare/v2.2.0...v2.2.1) (2026-05-28)

### Bug Fixes

* **ci:** load shared Infisical secrets before app secrets in deploy workflows ([69517e2](https://github.com/aretecp/ms-365-mcp-server/commit/69517e23e3e774bff04bc15c5dca41eaa862f43c))

## [2.2.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.1.0...v2.2.0) (2026-05-27)

### New Features

* **runtime:** assertIsOrganizer precondition on calendar write tools ([8fa98e8](https://github.com/aretecp/ms-365-mcp-server/commit/8fa98e84ab74da41e263d56f29fdd8ff92f9a71d))

## [2.1.0](https://github.com/aretecp/ms-365-mcp-server/compare/v2.0.0...v2.1.0) (2026-05-27)

### New Features

* **runtime:** server-enforced preconditions on mail write tools ([3574526](https://github.com/aretecp/ms-365-mcp-server/commit/35745260c3b65236d953171fbf57531888b3015a))

## [2.0.0](https://github.com/aretecp/ms-365-mcp-server/compare/v1.0.0...v2.0.0) (2026-05-27)

### ⚠ BREAKING CHANGES

* **mail:** send-draft-message tool removed. Any policy file that
referenced it in users.<upn>.allow should drop the line; the policy
loader does not validate tool names against the live surface so stale
entries are silently ignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>

### New Features

* **mail:** drop send-draft-message tool + Mail.Send scope ([f6fd6a6](https://github.com/aretecp/ms-365-mcp-server/commit/f6fd6a657230989792b43edc92109627f9cf9149)), closes [#9](https://github.com/aretecp/ms-365-mcp-server/issues/9)

## [1.0.0](https://github.com/aretecp/ms-365-mcp-server/compare/v0.112.2...v1.0.0) (2026-05-27)

### ⚠ BREAKING CHANGES

* PR 3 — per-user SQLite sessions, OAuth pass-through, policy gate (#3)
* PR 2 — hand-written tool definitions, drop generator (#2)

### New Features

* PR 2 — hand-written tool definitions, drop generator ([#2](https://github.com/aretecp/ms-365-mcp-server/issues/2)) ([e4fc582](https://github.com/aretecp/ms-365-mcp-server/commit/e4fc5822fe4917f5bed46de0a4786b8f7aae8aea)), closes [#245](https://github.com/aretecp/ms-365-mcp-server/issues/245) [issue-#245](https://github.com/aretecp/issue-/issues/245)
* PR 3 — per-user SQLite sessions, OAuth pass-through, policy gate ([#3](https://github.com/aretecp/ms-365-mcp-server/issues/3)) ([d3ef7a3](https://github.com/aretecp/ms-365-mcp-server/commit/d3ef7a355ea66b275971aa18695fa1765df2f13e))
* PR 4 — write tools for mail drafts and calendar events ([#4](https://github.com/aretecp/ms-365-mcp-server/issues/4)) ([fbf170f](https://github.com/aretecp/ms-365-mcp-server/commit/fbf170f70d3d23e027c5034bde1ad0e9f725ade3))
* PR 5 — SIGHUP policy reload + admin UI ([#5](https://github.com/aretecp/ms-365-mcp-server/issues/5)) ([dbc7b26](https://github.com/aretecp/ms-365-mcp-server/commit/dbc7b2644795c88c2aa9a0f2635f5b1f6e85a138))
* PR 6 — Teams read + write tools ([#6](https://github.com/aretecp/ms-365-mcp-server/issues/6)) ([6b9f80f](https://github.com/aretecp/ms-365-mcp-server/commit/6b9f80f50a3c2967f9a949fee288042c433219a7))
* PR 7 — list-users + SharePoint reads ([#7](https://github.com/aretecp/ms-365-mcp-server/issues/7)) ([5d79ced](https://github.com/aretecp/ms-365-mcp-server/commit/5d79cedda8cdaf93ada487d0af5d778bf4505f74))

### Bug Fixes

* **release:** add conventional-changelog-conventionalcommits devDep ([05236a9](https://github.com/aretecp/ms-365-mcp-server/commit/05236a9db178d9a549be0d322805aae90318ff31))
