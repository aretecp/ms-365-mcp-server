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
