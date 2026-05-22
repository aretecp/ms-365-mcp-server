import crypto from 'node:crypto';
import logger from '../logger.js';

/**
 * Two-leg PKCE: the MCP client runs PKCE against us (`clientCodeChallenge`),
 * and we run a separate PKCE leg against Microsoft (`serverCodeVerifier`).
 * The store maps the two so we can use the right verifier on each side.
 */
interface PkceEntry {
  clientCodeChallenge: string;
  clientCodeChallengeMethod: string;
  serverCodeVerifier: string;
  createdAt: number;
}

const MAX_AGE_MS = 10 * 60 * 1000;
const MAX_ENTRIES = 1000;

export interface PkcePair {
  serverCodeVerifier: string;
  serverCodeChallenge: string;
}

export class PkceStore {
  private readonly entries = new Map<string, PkceEntry>();

  /**
   * Generates a server↔Microsoft PKCE pair, indexes the client challenge
   * under the OAuth state value. Returns the challenge to forward to
   * Microsoft. Throws when the store is full so callers can reply 503.
   */
  registerClientChallenge(args: {
    state: string;
    clientCodeChallenge: string;
    clientCodeChallengeMethod?: string;
  }): PkcePair {
    const now = Date.now();
    for (const [key, value] of this.entries) {
      if (now - value.createdAt > MAX_AGE_MS) this.entries.delete(key);
    }
    if (this.entries.size >= MAX_ENTRIES) {
      logger.warn(`PKCE store at capacity (${MAX_ENTRIES})`);
      throw new Error('pkce_store_full');
    }

    const serverCodeVerifier = crypto.randomBytes(32).toString('base64url');
    const serverCodeChallenge = crypto
      .createHash('sha256')
      .update(serverCodeVerifier)
      .digest('base64url');

    this.entries.set(args.state, {
      clientCodeChallenge: args.clientCodeChallenge,
      clientCodeChallengeMethod: args.clientCodeChallengeMethod ?? 'S256',
      serverCodeVerifier,
      createdAt: now,
    });

    return { serverCodeVerifier, serverCodeChallenge };
  }

  /**
   * Looks up the server-side verifier matching the client's verifier. The
   * lookup compares hashes because the token endpoint receives the
   * verifier, but we keyed by the challenge.
   */
  consumeForClientVerifier(clientVerifier: string): string | undefined {
    const expectedChallenge = crypto
      .createHash('sha256')
      .update(clientVerifier)
      .digest('base64url');
    for (const [state, entry] of this.entries) {
      if (entry.clientCodeChallenge === expectedChallenge) {
        this.entries.delete(state);
        return entry.serverCodeVerifier;
      }
    }
    return undefined;
  }

  /** Visible for tests. */
  size(): number {
    return this.entries.size;
  }
}
