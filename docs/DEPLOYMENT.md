# Deployment Guide

Self-hosted Areté Microsoft 365 MCP server. Single instance, single Entra tenant, persistent state on disk.

- **Public hostname:** `m365.mcp.areteintelligence.ai`
- **Tenant:** Areté Capital Partners (`aretepartners.com`) — same tenant as every other app under terraform management.
- **Day-one users:** Spencer + 1–2 power users (all listed in `MS365_MCP_POLICY_ADMINS`)
- **Recommended host:** shared Areté VPS via docker-compose + Traefik, deployed by GitHub Actions over Tailscale. Same pattern as areteos, arilearn-phx, contact-intelligence. Fly.io is documented as an alternative (§6).
- **Out of scope here:** multi-region, multi-pod, blue/green. The architecture (per-pod SQLite, in-process policy reload) is single-pod by design — see [PR 5 plan §Concurrent edits](#).

---

## 1. Architecture at a glance

```
   Public DNS (Route 53)
      m365.mcp.areteintelligence.ai  →  178.156.139.78 (shared VPS)
                                                │
                                                ▼
                          ┌──────────────────────────────────┐
                          │ Traefik (websecure / Let's Encrypt) │
                          │   security-headers@file              │
                          │   rate-limit@file                    │
                          └──────────────────┬──────────────────┘
                                             │  aichat_openwebui-network
                                             ▼
            ┌─────────────────────────────────────────────────┐
            │ m365-mcp container  (port 3000)                 │
            │                                                 │
            │  /.well-known/oauth-authorization-server        │
            │  /.well-known/oauth-protected-resource          │
            │  /authorize  /token  /revoke                    │
            │  /admin/...   ← cookie-auth, policy YAML editor │
            │  /mcp        ← Streamable HTTP MCP, bearer auth │
            └────────┬────────────────────────────────────────┘
                     │ delegated OAuth (PKCE, two-leg)
                     ▼
              login.microsoftonline.com (Areté tenant)
                     │
                     ▼
              graph.microsoft.com

   On-disk state (bind-mounted from the VPS, never shared across pods):
     /data/sessions.db        SQLite, AES-256-GCM encrypted token blobs
     /policy/policy.yaml      YAML, hot-reloaded via SIGHUP / admin UI
```

Three things must persist across restarts:

1. **`/data/sessions.db`** — refresh tokens. Lose it, every user re-OAuths.
2. **`/policy/policy.yaml`** — the per-user allow/deny rules.
3. **`MS365_MCP_SESSION_KEY`** — the AES-256 key used to encrypt session blobs. Rotate it and every existing session is unreadable; the server will not refuse to start, but every session will need to be re-established. Treat it like a database master key.

---

## 2. Prerequisites

| Item                                                                      | Where it lives                                                                                                                       | Notes                                                                                                                                                        |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Entra app registration                                                    | Terraform: [`aretecp/microsoft-entra-terraform-infrastructure`](https://github.com/aretecp/microsoft-entra-terraform-infrastructure) | A new `m365_mcp.tf` file in that repo. **All Entra config goes in terraform** — do not hand-create the app in the Entra portal. See §3.                      |
| DNS `m365.mcp.areteintelligence.ai`                                       | Terraform: [`aretecp/arete-terraform-infrastructure`](https://github.com/aretecp/arete-terraform-infrastructure)                     | A new `m365-mcp/` folder following the `contact-intelligence/` pattern. Single Route 53 A record → shared VPS. TLS is handled by Traefik, not ACM. See §3.5. |
| `MICROSOFT_CLIENT_ID` / `MICROSOFT_CLIENT_SECRET` / `MICROSOFT_TENANT_ID` | Infisical at `/m365-mcp/` in the **internal** project                                                                                | Pushed automatically by the `infisical_entra_secrets` module call. Consumed by the deploy from there.                                                        |
| `MS365_MCP_SESSION_KEY`                                                   | Infisical at `/m365-mcp/` (manual entry, not terraform-managed)                                                                      | AES-256 master key for session blobs. Generate once with `openssl rand -base64 32`.                                                                          |
| `MS365_MCP_POLICY_ADMINS`                                                 | Infisical at `/m365-mcp/` (manual entry)                                                                                             | Comma-separated UPNs allowed to use the admin UI.                                                                                                            |
| Access to the shared VPS at `178.156.139.78`                              | SSH + sudo                                                                                                                           | Same host that runs contact-intelligence, areteos, arilearn-phx, etc. Traefik + Infisical already installed.                                                 |
| GitHub repo access                                                        | `aretecp/ms-365-mcp-server`                                                                                                          | The VPS checks out this repo at the target tag to deploy.                                                                                                    |

---

## 3. Entra app registration (terraform-managed)

**The Entra app for this server is configured in [`aretecp/microsoft-entra-terraform-infrastructure`](https://github.com/aretecp/microsoft-entra-terraform-infrastructure).** Do not click-create it in the Entra portal — every other Areté app in the tenant is terraform-managed and this one should be too. The PR-merge-and-apply flow gives us audit, peer review, and automatic Infisical secret sync.

### 3.1 Why a new module (not reuse an existing app)

A dedicated app registration gives us:

- A clean audit trail (every consent and token grant is tagged with this app).
- A single revocation point (delete the app → every session dies).
- Independent secret rotation from any other Areté backend.

### 3.2 Add `m365_mcp.tf` to the terraform repo

Following the conventions in `arete_mail_manager.tf` and `arilearn.tf`: each app is one `.tf` file with two module calls — `app_registration` for the Entra side, `infisical_entra_secrets` for pushing the resulting credentials.

Create `m365_mcp.tf` in the root of the terraform repo:

```hcl
##############################
#       M365 MCP Server      #
##############################

module "m365_mcp" {
  source   = "./modules/app_registration"
  app_name = "M365 MCP Server"
  app_slug = "m365-mcp"

  # Confidential client (we hold a client secret on the server side).
  # `web` redirect_uris below place the URIs under the Entra "Web" platform.
  manage_secret = true

  redirect_uris = [
    # Admin UI (server's own browser-cookie OAuth leg). Both prod and dev
    # hosts are pre-registered so the same Entra app serves both deploys.
    { uri = "https://m365.mcp.areteintelligence.ai/admin/callback",     type = "web" },
    { uri = "https://m365.mcp.dev.areteintelligence.ai/admin/callback", type = "web" },

    # Pass-through redirect targets for MCP clients. Microsoft requires
    # an exact match against this list, so every client redirect_uri an
    # operator wants to use must be listed here.
    { uri = "https://claude.ai/api/mcp/auth_callback", type = "web" },

    # Local MCP clients (Claude Code, Claude Desktop, MCP Inspector).
    # Loopback http is permitted by Entra under the Web platform.
    # Confirm the port observed at first sign-in and add more rows as needed.
    { uri = "http://localhost:33418/callback",   type = "web" },
    { uri = "http://127.0.0.1:33418/callback",   type = "web" },
  ]

  # Delegated Graph permissions. Names resolve to UUIDs via the data sources
  # already configured in the repo's locals.tf (`local.graph_delegated`).
  # Bold-equivalents below need admin consent — they're flagged with ★ in
  # the comments and listed again under §3.3.
  api_permissions = [{
    resource_app_id = local.graph_app_id
    resource_access = [
      { id = local.graph_delegated["User.Read"],       type = "Scope" },
      { id = local.graph_delegated["offline_access"],  type = "Scope" },
      { id = local.graph_delegated["openid"],          type = "Scope" },
      { id = local.graph_delegated["profile"],         type = "Scope" },
      { id = local.graph_delegated["email"],           type = "Scope" },

      # Mail — drafts only, no send. Mail.Send is deliberately omitted
      # so the LLM can never send mail unilaterally. The send-draft-message
      # tool does not exist on the server. Human reviews drafts in Outlook
      # and clicks Send themselves. Tracked for future re-add (with
      # approved-recipient guardrails) in ms-365-mcp-server#9.
      { id = local.graph_delegated["Mail.Read"],       type = "Scope" },
      { id = local.graph_delegated["Mail.ReadWrite"],  type = "Scope" },

      # Calendar
      { id = local.graph_delegated["Calendars.Read"],      type = "Scope" },
      { id = local.graph_delegated["Calendars.ReadWrite"], type = "Scope" },

      # Files / OneDrive
      { id = local.graph_delegated["Files.Read"],          type = "Scope" },

      # Directory  ★ admin consent
      { id = local.graph_delegated["User.ReadBasic.All"],  type = "Scope" },

      # SharePoint  ★ admin consent
      { id = local.graph_delegated["Sites.Read.All"],      type = "Scope" },

      # Teams chats
      { id = local.graph_delegated["Chat.Read"],           type = "Scope" },
      { id = local.graph_delegated["ChatMessage.Send"],    type = "Scope" },

      # Teams channels  ★ admin consent (all four)
      { id = local.graph_delegated["Team.ReadBasic.All"],     type = "Scope" },
      { id = local.graph_delegated["Channel.ReadBasic.All"],  type = "Scope" },
      { id = local.graph_delegated["ChannelMessage.Read.All"], type = "Scope" },
      { id = local.graph_delegated["ChannelMessage.Send"],    type = "Scope" },

      # Online meetings + transcripts (transcripts ★ admin consent)
      { id = local.graph_delegated["OnlineMeetings.Read"],          type = "Scope" },
      { id = local.graph_delegated["OnlineMeetings.ReadWrite"],     type = "Scope" },
      # OnlineMeetingTranscript.Read.All — verify this key exists in
      # docs/graph-permissions.md before merging. If absent, add it to the
      # delegated section of that doc + locals.tf and reference here.
    ]
  }]

  # Initial rollout: only slyon + dgiordano get the Admin role (the 1-2
  # starter users from the deployment plan). Additional power users are
  # unblocked via the server's policy.yaml allow-list — no Entra role
  # assignment changes needed unless we expand beyond the starter pair.
  owners = [for u in data.azuread_user.m365_mcp_owners : u.object_id]

  roles = ["Admin"]
  assigned_users = [
    { email = "slyon@aretepartners.com", role = "Admin" },
    { email = "dgiordano@aretepartners.com", role = "Admin" },
  ]
}

# Owners block — matches arilearn.tf's pattern.
data "azuread_user" "m365_mcp_owners" {
  for_each            = toset(["slyon@aretepartners.com", "dgiordano@aretepartners.com"])
  user_principal_name = each.value
}

module "m365_mcp_secrets" {
  source = "./modules/infisical_entra_secrets"

  app_slug      = "m365-mcp"
  client_id     = module.m365_mcp.client_id
  client_secret = module.m365_mcp.client_secret
  tenant_id     = var.microsoft_tenant_id
  environment   = var.environment
  workspace_id  = var.infisical_internal_project_id
}
```

> **Two things to double-check before PR-ing this:**
>
> 1. `OnlineMeetingTranscript.Read.All` is not in the current `docs/graph-permissions.md` delegated section in the terraform repo. Confirm Microsoft Graph still exposes it as a delegated scope (it does, as of 2026), then either add the key to the docs and rely on the data-source resolution, or fall back to a literal UUID in this module call.
> 2. The loopback ports `33418` are illustrative. Some MCP clients pick a fixed port; some pick at random within a range. Observe the actual port from the first failed sign-in (it appears in the consent screen URL) and add a single matching row per client.

### 3.3 PR + apply + admin consent

1. Open a PR in `aretecp/microsoft-entra-terraform-infrastructure` adding `m365_mcp.tf`.
2. Get review, merge. Terraform Cloud's `arete-entra-apps` workspace plan + apply runs automatically (or manually if that workspace is configured for VCS+manual-apply).
3. After apply, **a tenant admin grants consent** for the ★ scopes — terraform creates the app and lists the permissions but cannot grant tenant-wide admin consent itself:
   - Entra admin center → App registrations → "M365 MCP Server" → API permissions.
   - Click **"Grant admin consent for Areté"**. Every ★ scope above must show the green ✓ before the server is usable.
4. Confirm the Infisical sync ran: in Infisical's internal project, the path `/m365-mcp/` should contain `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`. The Fly/compose deploy reads these at start.

### 3.4 Adding non-terraform-managed secrets to Infisical

Two values aren't terraform-managed and must be entered by hand into the Infisical path `/m365-mcp/` **in both the `prod` and `dev` environments**:

| Key                       | Value                                      | How to generate                                                                                                                  |
| ------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `MS365_MCP_SESSION_KEY`   | base64-encoded 32-byte AES master key      | `openssl rand -base64 32` (separate key per environment so dev session blobs can't be decrypted by prod operators or vice versa) |
| `MS365_MCP_POLICY_ADMINS` | comma-separated UPNs of admin-UI operators | e.g. `slyon@aretepartners.com,dgiordano@aretepartners.com`                                                                       |

The server fails fast on startup if either is missing.

### 3.5 DNS — Route 53 in [`aretecp/arete-terraform-infrastructure`](https://github.com/aretecp/arete-terraform-infrastructure)

The `areteintelligence.ai` zone is managed in the AWS terraform repo's `foundation/` workspace. Per-app subdomains live in per-app workspaces that read foundation's outputs over remote state. Same pattern as `contact-intelligence/`.

Create a new folder `m365-mcp/` in the AWS terraform repo with five files:

**`m365-mcp/providers.tf`** — workspace + provider boilerplate, tagged for the `m365-mcp` workspace pair:

```hcl
terraform {
  cloud {
    organization = "arete-intelligence"
    workspaces {
      tags = ["m365-mcp"]
    }
  }

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = var.aws_region

  default_tags {
    tags = local.tags
  }
}
```

**`m365-mcp/variables.tf`** — same shape as `contact-intelligence/variables.tf`:

```hcl
variable "aws_region"     { type = string; default = "us-east-1" }
variable "aws_account_id" { type = string }
variable "environment"    { type = string }
variable "product"        { type = string; default = "m365-mcp" }
variable "project"        { type = string; default = "arete-internal" }

variable "vps_public_ip" {
  description = "Public IP of the VPS hosting the M365 MCP server"
  type        = string
  default     = "178.156.139.78"   # same VPS as contact-intelligence et al.
}
```

**`m365-mcp/data.tf`** — read the foundation zone id over remote state:

```hcl
data "terraform_remote_state" "foundation" {
  backend = "remote"
  config = {
    organization = "arete-intelligence"
    workspaces = {
      name = "arete-foundation-${var.environment}"
    }
  }
}
```

**`m365-mcp/locals.tf`**:

```hcl
locals {
  foundation = data.terraform_remote_state.foundation.outputs

  tags = merge(local.foundation.base_tags, {
    Product = var.product
  })

  # foundation.domain_name already encodes environment:
  #   prod → areteintelligence.ai
  #   dev  → dev.areteintelligence.ai
  domain_name = local.foundation.domain_name
  hostname    = "m365.mcp.${local.domain_name}"
}
```

**`m365-mcp/route53.tf`**:

```hcl
##############################
#       M365 MCP DNS         #
##############################

# A record routing m365.mcp.areteintelligence.ai (or dev.areteintelligence.ai)
# to the shared VPS. Traefik on the VPS handles TLS via Let's Encrypt — no ACM
# certificate is needed at the AWS layer.
resource "aws_route53_record" "m365_mcp" {
  zone_id = local.foundation.route53_zone_id
  name    = local.hostname
  type    = "A"
  ttl     = 300
  records = [var.vps_public_ip]
}
```

**`m365-mcp/README.md`** — one-pager mirroring `contact-intelligence/README.md`. Tagline: "M365 MCP server — DNS only. App runs on the shared VPS via Docker Compose + Traefik."

PR, get review, merge. Manual apply via TFC (per repo convention). Two workspaces required:

- `arete-m365-mcp-dev` → produces `m365.mcp.dev.areteintelligence.ai`
- `arete-m365-mcp-prod` → produces `m365.mcp.areteintelligence.ai`

Set workspace variables `aws_account_id` and `environment` per workspace; `vps_public_ip` defaults to the shared VPS.

> **TLS posture:** Traefik on the VPS terminates TLS with the `letsencrypt` certresolver and the same wildcard pattern every other app uses. There is **no AWS ACM certificate** in this flow — the only AWS resource for the M365 MCP is the Route 53 A record above.

### 3.6 What the deploy actually reads

The Fly/compose process needs these env vars at runtime; sourcing them from Infisical is the contract:

| Server env var            | Infisical key             |
| ------------------------- | ------------------------- |
| `MS365_MCP_CLIENT_ID`     | `MICROSOFT_CLIENT_ID`     |
| `MS365_MCP_TENANT_ID`     | `MICROSOFT_TENANT_ID`     |
| `MS365_MCP_CLIENT_SECRET` | `MICROSOFT_CLIENT_SECRET` |
| `MS365_MCP_SESSION_KEY`   | `MS365_MCP_SESSION_KEY`   |
| `MS365_MCP_POLICY_ADMINS` | `MS365_MCP_POLICY_ADMINS` |

Either:

- **Fly path:** pull from Infisical (CLI: `infisical export --env prod --path /m365-mcp`) and pipe into `fly secrets set`. One-time at first deploy, plus on rotation.
- **Compose path:** the host runs `infisical run --env prod --path /m365-mcp -- docker compose up -d` so env vars are injected at container start. Avoids writing secrets to a `.env` file on disk.

---

## 4. Secrets to generate (one-time)

```bash
# AES-256 master key for the session store. 32 bytes, base64-encoded.
openssl rand -base64 32        # → set as MS365_MCP_SESSION_KEY in Infisical
```

Store it in Infisical at `/m365-mcp/MS365_MCP_SESSION_KEY` (see §3.4). Lose it → every session is unrecoverable; rotate it intentionally only when you've planned for everyone to re-sign-in.

---

## 5. The container image

The repo ships a production-shaped multi-stage [`Dockerfile`](../Dockerfile) at the root. It:

- Builds with `node:24-bookworm-slim` + the C++ toolchain (for `better-sqlite3` native compile when no prebuilt is available).
- Produces a runtime stage that copies only the built `dist/`, prod-only `node_modules`, and the `policy.yaml.example` template — no source, no devDependencies, no toolchain.
- Sets `MS365_MCP_SESSION_DB_PATH=/data/sessions.db` and `MS365_MCP_POLICY_PATH=/policy/policy.yaml` so the mountpoints are conventional.
- Runs as the non-root `node` user.

The `.dockerignore` already excludes the right things (node_modules, .env, .token-cache.json, etc.) so the build context stays small.

Build locally to sanity-check before any cloud deploy:

```bash
docker build -t areteintelligence/m365-mcp-server:dev .

docker run --rm -p 3000:3000 \
  -e MS365_MCP_CLIENT_ID=... \
  -e MS365_MCP_TENANT_ID=... \
  -e MS365_MCP_CLIENT_SECRET=... \
  -e MS365_MCP_SESSION_KEY=... \
  -e MS365_MCP_POLICY_ADMINS=slyon@aretepartners.com \
  -v "$PWD/policy:/policy" \
  -v m365-mcp-data:/data \
  areteintelligence/m365-mcp-server:dev
```

`curl localhost:3000/.well-known/oauth-authorization-server` should return JSON.

The compose path (§7) consumes the same Dockerfile via [`docker-compose.prod.yml`](../docker-compose.prod.yml) (and [`docker-compose.dev.yml`](../docker-compose.dev.yml) for the dev slot) at the repo root. The Fly path (§6) uses the same Dockerfile via `fly.toml`'s `[build] dockerfile = "Dockerfile"` directive.

---

## 6. Path A — Fly.io (alternative)

> Most Areté apps run on the shared VPS via Path B (§7) — that's the convention and matches contact-intelligence, areteos, arilearn-phx. **Use Path A (Fly.io) only if you need an isolated environment** (capacity headroom, prod-blast-radius testing, or because the VPS is unavailable). For day-one launch on the shared VPS, skip ahead to §7.

### 6.1 `fly.toml`

Drop in the repo root:

```toml
app = "arete-m365-mcp"
primary_region = "iad"   # pick the region closest to most users
kill_signal    = "SIGINT"
kill_timeout   = 30      # SIGHUP shouldn't be confused; default term still applies

[build]
  dockerfile = "Dockerfile"

[env]
  MS365_MCP_PUBLIC_URL          = "https://m365.mcp.areteintelligence.ai"
  MS365_MCP_CORS_ORIGIN         = "https://claude.ai"
  MS365_MCP_ALLOWED_REDIRECT_URIS = "https://claude.ai/api/mcp/auth_callback"
  MS365_MCP_OUTPUT_FORMAT       = "toon"
  NODE_ENV                      = "production"

[mounts]
  source      = "m365_mcp_data"
  destination = "/data"
  initial_size = "1gb"

[[services]]
  internal_port = 3000
  protocol      = "tcp"
  auto_stop_machines  = false   # session refresh must happen; don't sleep
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    handlers = ["tls", "http"]
    port     = 443
    force_https = true

  [services.concurrency]
    type        = "connections"
    hard_limit  = 200
    soft_limit  = 150

[[vm]]
  cpu_kind   = "shared"
  cpus       = 1
  memory_mb  = 512   # better-sqlite3 + node baseline ≈ 150MB
```

> **Why `auto_stop_machines = false`:** the server holds refresh tokens that need periodic exchange; a fly-sleeping machine combined with `SameSite=Strict` admin cookies makes the wake-up + redirect path fragile. Keep one machine warm.

### 6.2 Deploy

```bash
fly apps create arete-m365-mcp --org areteintelligence
fly volumes create m365_mcp_data --region iad --size 1 --app arete-m365-mcp

# Secrets — pulled from Infisical, never from .env in the repo.
# Requires Infisical CLI authenticated to the internal project.
infisical export --env prod --path /m365-mcp --format dotenv | \
  while IFS='=' read -r k v; do
    case "$k" in
      MICROSOFT_CLIENT_ID)     echo "MS365_MCP_CLIENT_ID=$v" ;;
      MICROSOFT_CLIENT_SECRET) echo "MS365_MCP_CLIENT_SECRET=$v" ;;
      MICROSOFT_TENANT_ID)     echo "MS365_MCP_TENANT_ID=$v" ;;
      MS365_MCP_SESSION_KEY|MS365_MCP_POLICY_ADMINS) echo "$k=$v" ;;
    esac
  done | xargs fly secrets set --app arete-m365-mcp

# Initial deploy. The policy/ folder ships in the image; the volume is empty
# but `Policy.fromFile` falls back to a sane default until you upload one.
fly deploy --app arete-m365-mcp

# Custom hostname + Fly-issued cert.
fly certs create m365.mcp.areteintelligence.ai --app arete-m365-mcp
# Add the CNAME (or A/AAAA) records Fly shows you to Areté DNS, then:
fly certs check  m365.mcp.areteintelligence.ai --app arete-m365-mcp
```

When `fly certs check` reports "Configured", browse `https://m365.mcp.areteintelligence.ai/.well-known/oauth-authorization-server`. You should see JSON with the right issuer.

### 6.3 Updating policy on Fly

Two options:

1. **Admin UI** (the path you'll use day-to-day): `https://m365.mcp.areteintelligence.ai/admin/login` → sign in → edit YAML → save. Writes to `/policy/policy.yaml` on the Fly volume and hot-reloads.
2. **File on the volume** (rare): `fly ssh console -a arete-m365-mcp`, edit `/policy/policy.yaml` with vim, then `kill -HUP 1` from inside the container. PID 1 is the node process.

### 6.4 Backups

```bash
# Snapshot the volume on a cron. Fly snapshots volumes daily by default;
# verify in the dashboard. The sessions DB is the load-bearing piece —
# losing it forces every user to re-OAuth, which is recoverable but rude.
fly volumes snapshots list  -a arete-m365-mcp
```

---

## 7. Path B — shared VPS via docker-compose + Traefik (recommended)

This is how every other Areté app ships: docker-compose on the shared VPS at `178.156.139.78`, Traefik handling ingress + TLS via Let's Encrypt, services attached to the external `aichat_openwebui-network` docker network. **Deploys are CI-driven** via `.github/workflows/deploy-prod.yml` and `deploy-dev.yml`, which mirror the areteos / arilearn-phx workflows.

### 7.1 What's already there

The VPS already runs:

- Traefik with the `letsencrypt` certresolver, `websecure` entrypoint, and file-provider middlewares `security-headers@file` + `rate-limit@file`.
- The external docker network `aichat_openwebui-network` that Traefik watches for new services.
- A Tailscale node, reachable from GitHub Actions runners via the `tailscale-connect@v1` shared action.

No new infrastructure on the VPS — just a new checkout of this repo at `$HOME/ms-365-mcp-server` and a new compose stack alongside the others.

### 7.2 Repository layout

| File                                  | Purpose                                                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docker-compose.prod.yml`             | Prod stack: `m365_mcp` container, prod hostname, `data/` + `policy/` bind mounts                                                                                                     |
| `docker-compose.dev.yml`              | Dev stack: `m365_mcp_dev` container, dev hostname, `data-dev/` + `policy-dev/` bind mounts                                                                                           |
| `Dockerfile`                          | Multi-stage Node 24 build, non-root runtime, mounts `/data` and `/policy`                                                                                                            |
| `.github/workflows/ci.yml`            | Lint + build + test on push/PR to `main` + `develop`                                                                                                                                 |
| `.github/workflows/release.yml`       | `aretecp/github-actions/.github/workflows/release-shared.yml@v1` shim — cuts a tag + GH Release on push to main                                                                      |
| `.github/workflows/deploy-prod.yml`   | On release publish or `v*.*.*` tag push, SSH to VPS via Tailscale, write `.env`, `git checkout` the tag, `docker compose -f docker-compose.prod.yml up -d --build`, wait for healthy |
| `.github/workflows/deploy-dev.yml`    | Same shape, on push to `develop`. Uses `docker-compose.dev.yml`. Clones the repo on first run; subsequent runs just `git fetch + checkout + pull`                                    |
| `.github/workflows/rollback-prod.yml` | Manual workflow_dispatch with `version` input. Re-deploys an earlier tag.                                                                                                            |

### 7.3 Traefik wiring

`docker-compose.prod.yml` declares the service with no published ports and these labels (already committed; for reference):

```yaml
labels:
  - 'traefik.enable=true'
  - 'traefik.http.routers.m365-mcp.rule=Host(`${PUBLIC_HOSTNAME:-m365.mcp.areteintelligence.ai}`)'
  - 'traefik.http.routers.m365-mcp.entrypoints=websecure'
  - 'traefik.http.routers.m365-mcp.tls=true'
  - 'traefik.http.routers.m365-mcp.tls.certresolver=letsencrypt'
  - 'traefik.http.routers.m365-mcp.middlewares=security-headers@file,rate-limit@file'
  - 'traefik.http.services.m365-mcp.loadbalancer.server.port=3000'
  - 'traefik.docker.network=aichat_openwebui-network'
```

Traefik discovers the service on `aichat_openwebui-network`, fetches a Let's Encrypt cert on first request to the hostname, and reverse-proxies to the container's port 3000.

### 7.4 Secret flow (CI → .env → docker compose)

GitHub Actions deploys load secrets two ways:

1. **App-specific secrets** at `/m365-mcp/` in the **internal** Infisical project — pulled via the `load-infisical-secrets@v1` shared action using **OIDC** (no static credentials).
2. **Shared infra secrets** at `/` recursive in the `arete-shared` Infisical project — provides `TAILSCALE_AUTHKEY`, `VPS_TAILSCALE_IP`, `VPS_SSH_KEY` (these never appear in this repo).

The runner SSH's to the VPS over the Tailnet, writes a `chmod 600 .env` file on the VPS, then `docker compose --env-file .env -f docker-compose.prod.yml up -d --build`. The `${MICROSOFT_CLIENT_ID:?...}` interpolation in the compose file fails loudly if any required key is missing — belt-and-suspenders against partial Infisical contents.

GitHub Actions workspace prerequisites (set once per environment via the GH UI or the org's IaC):

| Variable                               | Where                                                        | Used by               |
| -------------------------------------- | ------------------------------------------------------------ | --------------------- |
| `vars.INFISICAL_OIDC_IDENTITY_ID`      | repo-level GH variable                                       | both deploy workflows |
| `vars.INFISICAL_INTERNAL_PROJECT_SLUG` | repo-level GH variable                                       | both deploy workflows |
| `vars.VPS_USER`                        | environment-level GH variable (`production` / `development`) | both deploy workflows |

### 7.5 First-time bootstrap (manual)

Prod refuses to clone — the first deploy is hand-driven by an operator. After that, CI takes over.

```bash
# Prerequisite: §3.5 terraform apply ran successfully and
# `dig +short m365.mcp.areteintelligence.ai` returns the VPS IP.

ssh <vps-tailscale-ip>

# Clone the repo at $HOME (matches deploy-prod.yml's expectation).
git clone https://github.com/aretecp/ms-365-mcp-server.git ~/ms-365-mcp-server
cd ~/ms-365-mcp-server
git checkout v0.1.0   # or whatever the first release tag is

mkdir -p data policy
chown -R 1000:1000 data policy

# Bootstrap the policy file once.
install -m 0644 policy.yaml.example policy/policy.yaml

# First-deploy secrets: pull from Infisical manually since CI hasn't run yet.
infisical login
infisical run --env prod --path /m365-mcp -- bash -c \
  'cat > .env <<EOF
MICROSOFT_CLIENT_ID=$MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET=$MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID=$MICROSOFT_TENANT_ID
MS365_MCP_SESSION_KEY=$MS365_MCP_SESSION_KEY
MS365_MCP_POLICY_ADMINS=$MS365_MCP_POLICY_ADMINS
PUBLIC_HOSTNAME=m365.mcp.areteintelligence.ai
ENVIRONMENT=production
VERSION=v0.1.0
EOF'
chmod 600 .env

docker compose --env-file .env -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f m365-mcp
```

Traefik picks the service up immediately and provisions the cert on the first HTTPS request. From this point forward, `deploy-prod.yml` reuses the same checkout, overwrites `.env`, and rolls forward — no more manual SSH.

For dev, the bootstrap is automatic — `deploy-dev.yml` clones the repo on first run if `~/ms-365-mcp-server` doesn't exist.

### 7.6 SIGHUP path on the VPS

```bash
ssh <vps-tailscale-ip>
docker compose -f docker-compose.prod.yml kill -s HUP m365-mcp
```

Or just use the admin UI from your browser — same result, no SSH needed.

### 7.7 Backups

```bash
# Nightly cron on the VPS
0 3 * * *  cd /home/<vps-user>/ms-365-mcp-server && \
  tar -czf /backups/m365-mcp-$(date +\%Y\%m\%d).tar.gz data policy && \
  find /backups -name 'm365-mcp-*.tar.gz' -mtime +30 -delete
```

Send the tarballs offsite (S3, Backblaze, etc.). The sessions.db is small (KB per user); the policy is plain text — total backup size is trivial.

---

## 8. Initial policy bootstrap

```bash
cp policy/policy.yaml.example policy/policy.yaml
```

The example file already enables the full read surface in `defaults.allow`. **All writes are off.** Before you ship, decide which UPNs need write capability and add a `users.<upn>.allow` block, either:

- through the admin UI after first deploy (easier, no SSH), or
- by editing `policy/policy.yaml` in-place before first deploy.

A reasonable day-one shape for Spencer:

```yaml
defaults:
  allow: [... full read surface from policy.yaml.example ...]

users:
  slyon@aretepartners.com:
    allow:
      # Mail writes (drafts only — no send tool exists)
      - create-draft-email
      - update-mail-message
      - add-mail-attachment
      - delete-mail-message
      # Calendar writes
      - create-calendar-event
      - update-calendar-event
      - delete-calendar-event
      # Teams writes
      - send-chat-message
      - send-channel-message
      - send-channel-message-reply
      - create-online-meeting
      - update-online-meeting
      - delete-online-meeting
```

Power user #2/#3 get the same block, scoped to whatever they actually need.

---

## 9. First-user verification (do this before inviting anyone)

In this order:

1. **Discovery endpoints answer.**

   ```bash
   curl -s https://m365.mcp.areteintelligence.ai/.well-known/oauth-authorization-server | jq .
   curl -s https://m365.mcp.areteintelligence.ai/.well-known/oauth-protected-resource    | jq .
   ```

   Both 200, both with `issuer`/`authorization_endpoint` pointing at the public URL.

2. **Admin UI loads.** Browse `https://m365.mcp.areteintelligence.ai/admin/login`. Microsoft consent screen appears. Approve. Land on `/admin/policy` with the YAML in a textarea.

3. **Edit + save.** Add a harmless comment to the YAML, save, see "Saved" banner. Check the server logs for `policy.saved` with your UPN and the new SHA-256.

4. **Connect an MCP client.** See §10. Run `list-mail-messages` with `$top=5`. Confirm hits come back.

5. **Confirm a write path is gated.** Run a `create-draft-email` before opening your write opt-in. Expect a "not authorized by policy" error. Add the opt-in via the admin UI; retry; expect success without restart.

6. **Confirm SIGHUP works.** From outside the box, edit `policy/policy.yaml` directly, send SIGHUP (Fly: `fly ssh console` + `kill -HUP 1`; compose: `docker compose kill -s HUP m365-mcp`). Logs should print `Policy reloaded from /policy/policy.yaml`.

Once all six pass, send the URL to power user #2.

---

## 10. Connecting MCP clients

### 10.1 Claude.ai (web)

Settings → Integrations → "Add integration" → paste `https://m365.mcp.areteintelligence.ai/mcp`. Claude.ai handles the OAuth dance and stores the bearer token in your account. The allowed redirect URI is `https://claude.ai/api/mcp/auth_callback`, which is already in the `MS365_MCP_ALLOWED_REDIRECT_URIS` env var above.

### 10.2 Claude Code (CLI)

```bash
claude mcp add --transport http areté-m365 https://m365.mcp.areteintelligence.ai/mcp
```

Claude Code uses a loopback redirect URI (`http://127.0.0.1:<port>/...`). The server's default validation allows loopback http when no `MS365_MCP_ALLOWED_REDIRECT_URIS` is set — but we set it explicitly above to lock down web clients. **To support Claude Code as well, expand the allowlist:**

```bash
fly secrets set --app arete-m365-mcp \
  MS365_MCP_ALLOWED_REDIRECT_URIS="https://claude.ai/api/mcp/auth_callback,http://127.0.0.1:33418/callback,http://localhost:33418/callback"
```

The loopback port Claude Code picks is stable per install — observe the actual port from the redirect URL in the consent screen the first time, then add it. If users routinely switch machines, consider dropping the allowlist entirely (the default rules already block non-loopback http, and reject `javascript:` / `data:` / `file:`); the tradeoff is that any https origin becomes acceptable as a redirect target. For Areté's threat model (closed user set, Entra tenant scoped), that's a defensible posture.

### 10.3 Claude Desktop

Same redirect-URI story as Claude Code. The Desktop config file (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS) gets:

```json
{
  "mcpServers": {
    "arete-m365": {
      "url": "https://m365.mcp.areteintelligence.ai/mcp"
    }
  }
}
```

---

## 11. Day-two operations

### 11.1 Logs

- **Compose (Path B, primary):** `docker compose logs -f m365-mcp` on the VPS. Structured JSON via pino (default level `info`). Pipe to Loki/Datadog if useful — same pattern as the other VPS apps.
- **Fly (Path A):** `fly logs -a arete-m365-mcp`. Same pino output.

Look for:

- `policy.saved` — every admin-UI / SIGHUP reload.
- `Policy reloaded from <path>` — on SIGHUP after a successful disk read.
- Refresh-on-skew warnings — token close to expiry, refreshed silently. Normal at the 5-minute mark before expiration.
- `Rejected /authorize request with disallowed redirect_uri` — means a client tried a URI not in the allowlist. Add it or push back on the client.

### 11.2 Upgrades

**Prod**: merge a `develop → main` PR; `release.yml` cuts a new `v*.*.*` tag + GH Release; `deploy-prod.yml` fires on the release. Hands-off.

For a fast-path manual deploy (skipping the release shim):

```bash
gh workflow run deploy-prod.yml -f version=v1.2.3
```

**Dev**: push to `develop` — `deploy-dev.yml` fires automatically.

Upgrades preserve the sessions DB and the policy file because both live on the bind-mounted `./data` and `./policy` (prod) or `./data-dev` and `./policy-dev` (dev) directories, not in the image. The first request after restart triggers a refresh-on-skew if the access token aged past 5 minutes during the bounce.

### 11.3 Rollback

```bash
# Manual workflow_dispatch — takes seconds.
gh workflow run rollback-prod.yml -f version=v1.2.2
```

The workflow SSH's to the VPS, checks out the named tag, writes a fresh `.env`, and re-`docker compose up -d --build`s. The sessions DB and policy file are untouched (they live in the bind mount).

Sessions survive a rollback. Policy survives a rollback. Only the code changes.

### 11.4 Rotating secrets

| Secret                    | How to rotate                                                                                                                                                                                                                                                                                                | Blast radius                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| `MS365_MCP_CLIENT_SECRET` | In the entra terraform repo: `terraform taint 'module.m365_mcp.azuread_application_password.this[0]' && terraform apply`. The new secret pushes to Infisical automatically. Redeploy on the VPS (`infisical run -- docker compose up -d`) — or `fly deploy` for Path A — so the running process picks it up. | None — only used server↔Microsoft; user sessions unaffected. |
| `MS365_MCP_SESSION_KEY`   | Rotate **only** with downtime planning. Generate a new key with `openssl rand -base64 32`, update Infisical, redeploy. Existing encrypted blobs become unreadable; every user re-signs in.                                                                                                                   | All sessions invalidated.                                    |
| `MS365_MCP_POLICY_ADMINS` | Update Infisical, redeploy (admin allowlist is start-time only).                                                                                                                                                                                                                                             | Admin UI access list changes; MCP users unaffected.          |
| Entra app itself          | Worst case: terraform destroy + recreate the module. Users must re-consent.                                                                                                                                                                                                                                  | Everyone re-OAuths.                                          |

### 11.5 What to monitor

Minimal viable monitoring:

- **Uptime probe** against `https://m365.mcp.areteintelligence.ai/.well-known/oauth-authorization-server` every minute. Anything non-200 pages.
- **Disk usage** on the `/data` volume. SQLite + WAL grows slowly; alert at 80%.
- **Error-rate spike** on Graph 4xx/5xx in logs — see [issue #8](https://github.com/aretecp/ms-365-mcp-server/issues/8) for the throttling work that will eventually emit retry metrics.

---

## 12. When to deploy

**Don't deploy before:**

- The Entra app has admin consent for the starred scopes (§3.3). MCP clients will succeed against the discovery endpoints but fail on first tool call.
- `MS365_MCP_SESSION_KEY` is in Infisical at `/m365-mcp/`. If only one operator has the key locally and the Infisical entry is lost, the production state becomes opaque.
- `policy/policy.yaml` is sane. The example file is fine for day one.
- DNS for `m365.mcp.areteintelligence.ai` is resolving to the deploy target.

**Plausible day-one schedule (Tuesday/Wednesday is better than Friday):**

| Day          | Action                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Day 0 (T-10) | Two terraform PRs open in parallel: (1) `m365_mcp.tf` in `microsoft-entra-terraform-infrastructure` for the Entra app, (2) `m365-mcp/` folder in `arete-terraform-infrastructure` for Route 53. Review + merge + apply both. Tenant admin grants consent for ★ scopes. Infisical sync confirmed at `/m365-mcp/` for both `prod` and `dev`. `MS365_MCP_SESSION_KEY` and `MS365_MCP_POLICY_ADMINS` entered by hand into Infisical in both envs. |
| Day 0 (T-9)  | GH Actions repo + environment variables set (`INFISICAL_OIDC_IDENTITY_ID`, `INFISICAL_INTERNAL_PROJECT_SLUG`, `VPS_USER`). The `production` and `development` GH environments configured. Push to `develop` so `deploy-dev.yml` runs end-to-end against `m365.mcp.dev.areteintelligence.ai` — confirm Traefik picks it up.                                                                                                                    |
| Day 1 (T-7)  | `dig m365.mcp.areteintelligence.ai` returns the VPS IP. SSH to the VPS, manually bootstrap the prod checkout at `~/ms-365-mcp-server` (§7.5). First prod deploy succeeds. Tag `v0.1.0` so `deploy-prod.yml` takes over future deploys. Spencer runs §9 verification, leaves it warm for 24h.                                                                                                                                                  |
| Day 2        | Spencer enables their own writes via admin UI. Exercises mail draft + calendar create. Watches logs.                                                                                                                                                                                                                                                                                                                                          |
| Day 3–5      | Bake. No new users. Just use it daily, find rough edges.                                                                                                                                                                                                                                                                                                                                                                                      |
| Day 7        | Invite power user #2. They sign in, get an `allow` block with the same writes Spencer has, run §9.                                                                                                                                                                                                                                                                                                                                            |
| Day 7–14     | Same for #3 if applicable. After this, the surface is proven; opening up to the broader team becomes a policy edit, not a deployment.                                                                                                                                                                                                                                                                                                         |

**Hard stops that delay deploy:**

- A failing `npm run verify` on `main`. Don't ship code the smoke tests reject.
- Any unresolved high-severity item from the issue tracker that touches auth or sessions.
- A pending breaking change to the Entra app config — finish the change, then deploy.

---

## 13. Troubleshooting

| Symptom                                                                  | Likely cause                                                            | First check                                                                                                                    |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| "AADSTS65001: The user or administrator has not consented"               | Missing admin consent on a starred scope.                               | Entra → App registrations → API permissions → Grant admin consent.                                                             |
| `redirect_uri is not allowed` in server logs                             | Client URI not in `MS365_MCP_ALLOWED_REDIRECT_URIS`.                    | Add it, redeploy.                                                                                                              |
| Admin UI returns 401 immediately after sign-in                           | Cookie `Secure` flag set but request was http (broken TLS termination). | Confirm Traefik (or Fly) is forwarding `X-Forwarded-Proto: https`.                                                             |
| Admin UI returns 403                                                     | UPN not in `MS365_MCP_POLICY_ADMINS`.                                   | Update the env var, redeploy (admin allowlist is start-time only).                                                             |
| `/mcp` returns 401 with `WWW-Authenticate: Bearer`                       | Session expired or revoked.                                             | Client re-runs OAuth. Expected after `revoke` or after `MS365_MCP_SESSION_KEY` rotation.                                       |
| Server refuses to start: "MS365_MCP_POLICY_ADMINS is required"           | Env var missing or empty.                                               | Set it; this is fail-fast by design.                                                                                           |
| Server refuses to start: "MS365_MCP_SESSION_KEY must decode to 32 bytes" | Key is wrong length.                                                    | Regenerate with `openssl rand -base64 32`.                                                                                     |
| `policy.saved` log line followed by 500s on `/mcp`                       | Bad YAML accepted but tool reference invalid.                           | The policy validator caught it before save — re-check the YAML; the previous policy stays live until the next successful save. |
| Tool call returns 429 with no retry                                      | No throttling/backoff yet.                                              | Tracked in [issue #8](https://github.com/aretecp/issues/8); ride it out and back off client-side for now.                      |
| `deploy-prod.yml` fails with "REPO_DIR does not exist"                   | Prod refuses to clone — the first deploy is manual (§7.5).              | Bootstrap the prod checkout once by hand, then re-run the workflow.                                                            |
| Tailscale step fails with "node already exists"                          | Stale auth key reuse.                                                   | Rotate the auth key in `arete-shared` Infisical (`TAILSCALE_AUTHKEY`).                                                         |
| Workflow can't read Infisical secrets                                    | OIDC identity not bound to this repo.                                   | Confirm `vars.INFISICAL_OIDC_IDENTITY_ID` matches the identity that has access to `/m365-mcp` in the internal project.         |

---

## 14. References

- Plan that produced the current surface: `~/.claude/plans/sorted-swinging-wind.md`
- Throttling backlog: [`aretecp/ms-365-mcp-server#8`](https://github.com/aretecp/ms-365-mcp-server/issues/8)
- Entra terraform repo: [`aretecp/microsoft-entra-terraform-infrastructure`](https://github.com/aretecp/microsoft-entra-terraform-infrastructure)
- AWS terraform repo (Route 53, foundation): [`aretecp/arete-terraform-infrastructure`](https://github.com/aretecp/arete-terraform-infrastructure)
- Shared CI/CD building blocks: [`aretecp/github-actions`](https://github.com/aretecp/github-actions) — `load-infisical-secrets`, `tailscale-connect`, `wait-for-healthy.sh`, `release-shared.yml`
- Reference compose stacks on the shared VPS:
  - [`aretecp/areteos`](https://github.com/aretecp/areteos/blob/main/docker-compose.prod.yml) — closest match (Phoenix instead of Node, but identical deploy pipeline)
  - [`aretecp/arilearn-phx`](https://github.com/aretecp/arilearn-phx/blob/main/docker-compose.yml)
- Microsoft Graph permission reference: <https://learn.microsoft.com/en-us/graph/permissions-reference>
- Microsoft Graph throttling guidance: <https://learn.microsoft.com/en-us/graph/throttling>
