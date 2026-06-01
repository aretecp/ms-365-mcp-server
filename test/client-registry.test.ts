import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientRegistry, InvalidRedirectUriError } from '../src/oauth/client-registry.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe('ClientRegistry (RFC 7591 DCR)', () => {
  let registry: ClientRegistry;

  beforeEach(() => {
    // In-memory SQLite so each test is isolated and nothing touches disk.
    registry = new ClientRegistry({ dbPath: ':memory:' });
  });

  afterEach(() => {
    registry.close();
  });

  it('registers a public client and returns a usable client_id', () => {
    const client = registry.register({
      redirectUris: ['http://127.0.0.1:6274/oauth/callback'],
      clientName: 'MCP Inspector',
    });
    expect(client.clientId).toMatch(/^mcp_[0-9a-f]{32}$/);
    expect(client.redirectUris).toEqual(['http://127.0.0.1:6274/oauth/callback']);
    expect(client.clientName).toBe('MCP Inspector');
  });

  it('persists the registration so it can be looked up by id', () => {
    const { clientId } = registry.register({
      redirectUris: ['https://app.example.com/cb'],
    });
    const fetched = registry.get(clientId);
    expect(fetched?.redirectUris).toEqual(['https://app.example.com/cb']);
  });

  it('accepts https redirect URIs on any host', () => {
    expect(() =>
      registry.register({ redirectUris: ['https://anywhere.example/cb'] })
    ).not.toThrow();
  });

  it('accepts http only on loopback', () => {
    expect(() => registry.register({ redirectUris: ['http://localhost:1234/cb'] })).not.toThrow();
  });

  it('rejects http on a non-loopback host', () => {
    expect(() => registry.register({ redirectUris: ['http://evil.example/cb'] })).toThrow(
      InvalidRedirectUriError
    );
  });

  it('rejects dangerous schemes', () => {
    expect(() => registry.register({ redirectUris: ['javascript:alert(1)'] })).toThrow(
      InvalidRedirectUriError
    );
  });

  it('rejects an empty redirect_uris list', () => {
    expect(() => registry.register({ redirectUris: [] })).toThrow(InvalidRedirectUriError);
  });

  it('matches a registered redirect_uri exactly', () => {
    const { clientId } = registry.register({
      redirectUris: ['https://app.example.com/cb'],
    });
    expect(registry.isRegisteredRedirectUri(clientId, 'https://app.example.com/cb')).toBe(true);
    expect(registry.isRegisteredRedirectUri(clientId, 'https://app.example.com/other')).toBe(false);
  });

  it('returns false for unknown client ids', () => {
    expect(registry.isRegisteredRedirectUri('mcp_unknown', 'https://app.example.com/cb')).toBe(
      false
    );
  });
});
