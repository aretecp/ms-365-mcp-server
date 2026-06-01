import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import logger from '../logger.js';

/**
 * Microsoft OAuth tokens we hold for a user, kept encrypted at rest.
 * `scopes` is space-separated to match what Microsoft returns.
 */
export interface SessionTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch ms
  scopes: string;
}

export interface SessionIdentity {
  tenantId: string;
  userOid: string;
  userPrincipalName: string | null;
}

export interface Session extends SessionIdentity {
  sessionId: string;
  tokens: SessionTokens;
  createdAt: number;
}

const SESSION_KEY_ENV = 'MS365_MCP_SESSION_KEY';
const SESSION_DB_PATH_ENV = 'MS365_MCP_SESSION_DB_PATH';
const DEFAULT_DB_PATH = path.join(process.cwd(), 'data', 'sessions.db');
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 12;
const AES_TAG_BYTES = 16;

function loadSessionKey(): Buffer {
  const raw = process.env[SESSION_KEY_ENV];
  if (!raw || raw.trim() === '') {
    throw new Error(`${SESSION_KEY_ENV} is required. Generate a key with: openssl rand -base64 32`);
  }
  let key: Buffer;
  try {
    key = Buffer.from(raw.trim(), 'base64');
  } catch (error) {
    throw new Error(`${SESSION_KEY_ENV} must be base64-encoded: ${(error as Error).message}`);
  }
  if (key.length !== AES_KEY_BYTES) {
    throw new Error(
      `${SESSION_KEY_ENV} must decode to ${AES_KEY_BYTES} bytes (got ${key.length}). Generate a key with: openssl rand -base64 32`
    );
  }
  return key;
}

function resolveDbPath(): string {
  const env = process.env[SESSION_DB_PATH_ENV]?.trim();
  return env && env !== '' ? env : DEFAULT_DB_PATH;
}

/**
 * The SQLite file backing per-user sessions. Exported so sibling stores
 * (e.g. the OAuth client registry) can share the same database file.
 */
export function resolveSessionDbPath(): string {
  return resolveDbPath();
}

export class SessionStore {
  private readonly db: Database.Database;
  private readonly key: Buffer;

  // Prepared statements (lazy-instantiated for testability)
  private readonly stmts: {
    insert: Database.Statement;
    selectById: Database.Statement;
    updateTokens: Database.Statement;
    deleteById: Database.Statement;
    listByUser: Database.Statement;
  };

  constructor(opts: { dbPath?: string; key?: Buffer } = {}) {
    this.key = opts.key ?? loadSessionKey();
    const dbPath = opts.dbPath ?? resolveDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    // The OAuth client registry opens a second connection to this same file;
    // a busy timeout lets writers wait out each other's lock rather than
    // throwing SQLITE_BUSY.
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id          TEXT PRIMARY KEY,
        tenant_id           TEXT NOT NULL,
        user_oid            TEXT NOT NULL,
        user_principal_name TEXT,
        encrypted_tokens    BLOB NOT NULL,
        iv                  BLOB NOT NULL,
        auth_tag            BLOB NOT NULL,
        created_at          INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_user
        ON sessions(tenant_id, user_oid);
    `);

    this.stmts = {
      insert: this.db.prepare(
        `INSERT INTO sessions
           (session_id, tenant_id, user_oid, user_principal_name,
            encrypted_tokens, iv, auth_tag, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ),
      selectById: this.db.prepare(`SELECT * FROM sessions WHERE session_id = ?`),
      updateTokens: this.db.prepare(
        `UPDATE sessions
            SET encrypted_tokens = ?, iv = ?, auth_tag = ?
          WHERE session_id = ?`
      ),
      deleteById: this.db.prepare(`DELETE FROM sessions WHERE session_id = ?`),
      listByUser: this.db.prepare(
        `SELECT * FROM sessions
          WHERE tenant_id = ? AND user_oid = ?
          ORDER BY created_at DESC`
      ),
    };

    logger.info(`Session store ready at ${dbPath}`);
  }

  /** Mints a new opaque session id (32 random bytes, base64url). */
  static generateSessionId(): string {
    return crypto.randomBytes(32).toString('base64url');
  }

  private encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = crypto.randomBytes(AES_IV_BYTES);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    if (tag.length !== AES_TAG_BYTES) {
      throw new Error(`Unexpected GCM tag length ${tag.length}`);
    }
    return { ciphertext, iv, tag };
  }

  private decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  }

  create(identity: SessionIdentity, tokens: SessionTokens): Session {
    const sessionId = SessionStore.generateSessionId();
    const createdAt = Date.now();
    const { ciphertext, iv, tag } = this.encrypt(JSON.stringify(tokens));
    this.stmts.insert.run(
      sessionId,
      identity.tenantId,
      identity.userOid,
      identity.userPrincipalName,
      ciphertext,
      iv,
      tag,
      createdAt
    );
    return { sessionId, ...identity, tokens, createdAt };
  }

  get(sessionId: string): Session | null {
    const row = this.stmts.selectById.get(sessionId) as
      | {
          session_id: string;
          tenant_id: string;
          user_oid: string;
          user_principal_name: string | null;
          encrypted_tokens: Buffer;
          iv: Buffer;
          auth_tag: Buffer;
          created_at: number;
        }
      | undefined;
    if (!row) return null;

    let tokens: SessionTokens;
    try {
      tokens = JSON.parse(this.decrypt(row.encrypted_tokens, row.iv, row.auth_tag));
    } catch (error) {
      logger.error(`Failed to decrypt session ${sessionId}: ${(error as Error).message}`);
      return null;
    }

    return {
      sessionId: row.session_id,
      tenantId: row.tenant_id,
      userOid: row.user_oid,
      userPrincipalName: row.user_principal_name,
      tokens,
      createdAt: row.created_at,
    };
  }

  /** Re-encrypts and writes new tokens for an existing session. No-op if the session is gone. */
  updateTokens(sessionId: string, tokens: SessionTokens): void {
    const { ciphertext, iv, tag } = this.encrypt(JSON.stringify(tokens));
    this.stmts.updateTokens.run(ciphertext, iv, tag, sessionId);
  }

  delete(sessionId: string): boolean {
    const info = this.stmts.deleteById.run(sessionId);
    return info.changes > 0;
  }

  /** Lists sessions for a given user. Used for revoke-all-by-user flows; not on the hot path. */
  listByUser(tenantId: string, userOid: string): Session[] {
    const rows = this.stmts.listByUser.all(tenantId, userOid) as Array<{
      session_id: string;
      tenant_id: string;
      user_oid: string;
      user_principal_name: string | null;
      encrypted_tokens: Buffer;
      iv: Buffer;
      auth_tag: Buffer;
      created_at: number;
    }>;
    const sessions: Session[] = [];
    for (const row of rows) {
      try {
        const tokens = JSON.parse(this.decrypt(row.encrypted_tokens, row.iv, row.auth_tag));
        sessions.push({
          sessionId: row.session_id,
          tenantId: row.tenant_id,
          userOid: row.user_oid,
          userPrincipalName: row.user_principal_name,
          tokens,
          createdAt: row.created_at,
        });
      } catch (error) {
        logger.error(
          `Skipping un-decryptable session ${row.session_id}: ${(error as Error).message}`
        );
      }
    }
    return sessions;
  }

  close(): void {
    this.db.close();
  }
}

/** Convenience used at startup by index.ts to fail fast if the key is missing. */
export function assertSessionKeyAvailable(): void {
  loadSessionKey();
}
