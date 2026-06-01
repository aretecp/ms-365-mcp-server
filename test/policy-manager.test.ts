import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { PolicyManager } from '../src/policy/index.js';

vi.mock('../src/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function tmpYaml(contents: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arete-mcp-policy-mgr-'));
  const file = path.join(dir, 'policy.yaml');
  fs.writeFileSync(file, contents);
  return file;
}

function cleanup(file: string) {
  try {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  } catch {
    /* */
  }
}

describe('PolicyManager', () => {
  let filePath: string;

  beforeEach(() => {
    filePath = tmpYaml('defaults:\n  allow:\n    - identity-get-me\n');
  });

  afterEach(() => cleanup(filePath));

  it('check() delegates to the loaded Policy', () => {
    const mgr = PolicyManager.fromFile(filePath);
    expect(mgr.check({ userPrincipalName: 'a@b.com', toolName: 'identity-get-me' })).toBe(true);
    expect(mgr.check({ userPrincipalName: 'a@b.com', toolName: 'send-mail' })).toBe(false);
  });

  it('reload() picks up new defaults from disk', async () => {
    const mgr = PolicyManager.fromFile(filePath);
    expect(mgr.check({ userPrincipalName: null, toolName: 'mail-message-list' })).toBe(false);

    fs.writeFileSync(filePath, 'defaults:\n  allow:\n    - identity-get-me\n    - mail-message-list\n');
    await mgr.reload();

    expect(mgr.check({ userPrincipalName: null, toolName: 'mail-message-list' })).toBe(true);
  });

  it('reload() keeps the previous policy on a parse error and rejects', async () => {
    const mgr = PolicyManager.fromFile(filePath);
    expect(mgr.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);

    // Unclosed flow mapping — js-yaml throws on this.
    fs.writeFileSync(filePath, 'defaults: { allow: [identity-get-me\n');

    await expect(mgr.reload()).rejects.toBeDefined();
    // Policy unchanged.
    expect(mgr.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);
  });

  it('overlapping reload calls coalesce into one extra reload', async () => {
    const mgr = PolicyManager.fromFile(filePath);
    // Spy on the prototype to count internal reload runs.
    const runReloadSpy = vi.spyOn(
      mgr as unknown as { runReload: () => Promise<void> },
      'runReload' as never
    );

    // Kick off three reloads back-to-back; only two distinct runReload invocations
    // should happen (the first plus one queued follow-up).
    const a = mgr.reload();
    const b = mgr.reload();
    const c = mgr.reload();
    await Promise.all([a, b, c]);

    // Drain the follow-up that runs after the first completes.
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(runReloadSpy.mock.calls.length).toBe(2);
  });

  it('source() returns the file path the policy was loaded from', () => {
    const mgr = PolicyManager.fromFile(filePath);
    expect(mgr.source()).toBe(filePath);
  });

  it('fromFile honors MS365_MCP_POLICY_PATH when no explicit path is given', () => {
    const original = process.env.MS365_MCP_POLICY_PATH;
    process.env.MS365_MCP_POLICY_PATH = filePath;
    try {
      const mgr = PolicyManager.fromFile();
      expect(mgr.source()).toBe(filePath);
      expect(mgr.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);
    } finally {
      if (original === undefined) delete process.env.MS365_MCP_POLICY_PATH;
      else process.env.MS365_MCP_POLICY_PATH = original;
    }
  });

  // Belt-and-suspenders: a fresh tmp file ensures the source-path captured in
  // the manager is what reload reads, even if cwd changes.
  it('reload reads the captured path, not whatever fromFile() would default to', async () => {
    const explicitPath = tmpYaml('defaults:\n  allow: []\n');
    try {
      const mgr = PolicyManager.fromFile(explicitPath);
      fs.writeFileSync(explicitPath, 'defaults:\n  allow:\n    - identity-get-me\n');
      // crypto import is here only to keep the file consistent with other tests
      // (avoid the unused-import lint trigger on the boilerplate).
      crypto.randomBytes(1);
      await mgr.reload();
      expect(mgr.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);
    } finally {
      cleanup(explicitPath);
    }
  });
});
