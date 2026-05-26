import { describe, it, expect, vi } from 'vitest';
import MicrosoftGraphServer from '../src/server.js';
import { Policy, PolicyManager } from '../src/policy/index.js';
import type { SessionManager } from '../src/sessions/manager.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Guards the PR 1 invariant that stdio mode has been removed. Without --http the
// server must refuse to start so a misconfiguration cannot silently fall back to
// a transport that PR 3's per-user session auth does not support.
describe('server HTTP-only guard', () => {
  const stubManager = {} as SessionManager;
  const policy = new PolicyManager(
    Policy.fromDocument({ defaults: { allow: [] } }),
    '/tmp/policy.yaml'
  );
  const policyAdmins = new Set<string>();
  const secrets = { clientId: 'x', tenantId: 'common' };

  function build() {
    const server = new MicrosoftGraphServer({
      options: {},
      secrets,
      sessionManager: stubManager,
      policy,
      policyAdmins,
    });
    server.initialize('0.0.0');
    return server;
  }

  it('throws when --http is not provided', async () => {
    const server = build();
    await expect(server.start()).rejects.toThrow(/only runs over HTTP/);
  });

  it('throws with a message that names the --http flag so the operator can act on it', async () => {
    const server = build();
    await expect(server.start()).rejects.toThrow(/--http/);
  });
});
