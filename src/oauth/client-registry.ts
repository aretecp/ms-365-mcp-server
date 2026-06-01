import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import logger from '../logger.js';
import { resolveSessionDbPath } from '../sessions/store.js';
import { isAllowedRedirectUri } from '../lib/redirect-uri-validation.js';

/**
 * RFC 7591 Dynamic Client Registration store.
 *
 * The server is its own authorization server in front of Microsoft Entra, so
 * the client_id we hand out is meaningless to Microsoft — it exists only to
 * let MCP clients (Claude, MCP Inspector/Jam, Cursor, ...) complete the
 * standard discovery → register → authorize → token dance without any human
 * pre-registration. We persist registrations so an issued client_id survives
 * restarts; the redirect_uris recorded here are the source of truth for
 * redirect validation at /authorize.
 */
export interface OAuthClient {
  clientId: string;
  redirectUris: string[];
  clientName: string | null;
  createdAt: number;
}

export interface RegisterClientInput {
  redirectUris: string[];
  clientName?: string | null;
}

/** Raised when a registration request carries an unusable redirect_uri. */
export class InvalidRedirectUriError extends Error {
  constructor(public readonly redirectUri: string) {
    super(`redirect_uri is not acceptable: ${redirectUri}`);
    this.name = 'InvalidRedirectUriError';
  }
}

/**
 * Hard cap on stored registrations. DCR is open and unauthenticated (as the
 * spec intends), so without a bound an attacker could grow the table forever
 * (disk DoS). When the cap is exceeded we evict the OLDEST registrations —
 * clients re-register transparently via DCR on their next connect. Traefik
 * rate-limiting fronts this in prod; the cap is the in-app backstop.
 */
const MAX_CLIENTS = 10_000;

export class ClientRegistry {
  private readonly db: Database.Database;
  private readonly stmts: {
    insert: Database.Statement;
    selectById: Database.Statement;
    count: Database.Statement;
    deleteOldest: Database.Statement;
  };

  constructor(opts: { dbPath?: string } = {}) {
    const dbPath = opts.dbPath ?? resolveSessionDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    // We share the sessions DB file with SessionStore (a separate connection);
    // a busy timeout lets a writer wait out the other's lock instead of
    // throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_clients (
        client_id     TEXT PRIMARY KEY,
        redirect_uris TEXT NOT NULL,
        client_name   TEXT,
        created_at    INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_oauth_clients_created_at
        ON oauth_clients(created_at);
    `);
    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO oauth_clients (client_id, redirect_uris, client_name, created_at)
         VALUES (?, ?, ?, ?)`
      ),
      selectById: this.db.prepare(`SELECT * FROM oauth_clients WHERE client_id = ?`),
      count: this.db.prepare(`SELECT COUNT(*) AS n FROM oauth_clients`),
      deleteOldest: this.db.prepare(
        `DELETE FROM oauth_clients WHERE client_id IN (
           SELECT client_id FROM oauth_clients ORDER BY created_at ASC LIMIT ?
         )`
      ),
    };
    logger.info('OAuth client registry ready (oauth_clients table)');
  }

  /**
   * Registers a new public client. Every redirect_uri is validated with the
   * same baseline rules we apply at /authorize (https anywhere, http only on
   * loopback, no dangerous schemes) — passing `null` for the allowlist means
   * "no global allowlist", which is exactly the open registration we want.
   *
   * @throws InvalidRedirectUriError when any redirect_uri is unusable.
   */
  register(input: RegisterClientInput): OAuthClient {
    const redirectUris = input.redirectUris;
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      throw new InvalidRedirectUriError('(none provided)');
    }
    for (const uri of redirectUris) {
      if (!isAllowedRedirectUri(uri, null)) {
        throw new InvalidRedirectUriError(uri);
      }
    }

    // Enforce the cap before inserting, evicting the oldest rows if needed.
    const { n } = this.stmts.count.get() as { n: number };
    if (n >= MAX_CLIENTS) {
      const evict = n - MAX_CLIENTS + 1;
      this.stmts.deleteOldest.run(evict);
      logger.warn(
        `oauth_clients at capacity (${MAX_CLIENTS}); evicted ${evict} oldest registration(s)`
      );
    }

    const clientId = `mcp_${crypto.randomBytes(16).toString('hex')}`;
    const createdAt = Date.now();
    const clientName = input.clientName?.trim() || null;
    this.stmts.insert.run(clientId, JSON.stringify(redirectUris), clientName, createdAt);
    logger.info(`Registered OAuth client ${clientId} (${clientName ?? 'unnamed'})`, {
      redirect_uris: redirectUris,
    });
    return { clientId, redirectUris, clientName, createdAt };
  }

  get(clientId: string): OAuthClient | null {
    const row = this.stmts.selectById.get(clientId) as
      | { client_id: string; redirect_uris: string; client_name: string | null; created_at: number }
      | undefined;
    if (!row) return null;
    let redirectUris: string[] = [];
    try {
      const parsed = JSON.parse(row.redirect_uris);
      if (Array.isArray(parsed)) redirectUris = parsed.filter((u) => typeof u === 'string');
    } catch {
      /* corrupt row — treat as no registered URIs */
    }
    return {
      clientId: row.client_id,
      redirectUris,
      clientName: row.client_name,
      createdAt: row.created_at,
    };
  }

  /**
   * True when `clientId` is a known registration AND `redirectUri` exactly
   * matches one of its registered URIs. Unknown clients return false so the
   * caller can decide whether to fall back to the legacy env allowlist.
   */
  isRegisteredRedirectUri(clientId: string, redirectUri: string): boolean {
    const client = this.get(clientId);
    if (!client) return false;
    return client.redirectUris.includes(redirectUri);
  }

  close(): void {
    this.db.close();
  }
}
