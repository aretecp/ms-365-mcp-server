import { describe, expect, it } from 'vitest';
import {
  Policy,
  evaluateMailSend,
  DEFAULT_MAIL_SEND_CONFIG,
  collectReferencedToolNames,
  findUnknownPolicyTools,
} from '../src/policy/index.js';
import type { PolicySummary } from '../src/policy/index.js';

describe('Policy.check', () => {
  it('allows tools in defaults.allow', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['mail-message-list', 'identity-get-me'] },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'mail-message-list' })).toBe(true);
    expect(policy.check({ userPrincipalName: 'u@example.com', toolName: 'identity-get-me' })).toBe(
      true
    );
  });

  it('denies tools missing from defaults.allow when there is no user entry (fail-closed)', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['identity-get-me'] } });
    expect(
      policy.check({ userPrincipalName: 'u@example.com', toolName: 'mail-message-delete' })
    ).toBe(false);
  });

  it("user.allow grants tools the user wouldn't get from defaults", () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'spencer@example.com': { allow: ['mail-draft-create'] },
      },
    });
    expect(
      policy.check({ userPrincipalName: 'spencer@example.com', toolName: 'mail-draft-create' })
    ).toBe(true);
    expect(
      policy.check({ userPrincipalName: 'other@example.com', toolName: 'mail-draft-create' })
    ).toBe(false);
  });

  it('user.deny wins over both user.allow and defaults.allow', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['download-bytes'] },
      users: {
        'contractor@example.com': {
          allow: ['download-bytes'],
          deny: ['download-bytes'],
        },
      },
    });
    expect(
      policy.check({ userPrincipalName: 'contractor@example.com', toolName: 'download-bytes' })
    ).toBe(false);
  });

  it('UPN lookup is case-insensitive', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: [] },
      users: { 'CASE@EXAMPLE.COM': { allow: ['identity-get-me'] } },
    });
    expect(
      policy.check({ userPrincipalName: 'case@example.com', toolName: 'identity-get-me' })
    ).toBe(true);
    expect(
      policy.check({ userPrincipalName: 'Case@Example.Com', toolName: 'identity-get-me' })
    ).toBe(true);
  });

  it('falls through to defaults when the user is unknown', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: { 'known@example.com': { allow: ['extra-tool'] } },
    });
    expect(
      policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'identity-get-me' })
    ).toBe(true);
    expect(policy.check({ userPrincipalName: 'unknown@example.com', toolName: 'extra-tool' })).toBe(
      false
    );
  });

  it('treats a null UPN as anonymous and only consults defaults', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: { 'someone@example.com': { allow: ['mail-message-list'] } },
    });
    expect(policy.check({ userPrincipalName: null, toolName: 'identity-get-me' })).toBe(true);
    expect(policy.check({ userPrincipalName: null, toolName: 'mail-message-list' })).toBe(false);
  });

  it('an empty document denies everything', () => {
    const policy = Policy.fromDocument({});
    expect(
      policy.check({ userPrincipalName: 'anyone@example.com', toolName: 'identity-get-me' })
    ).toBe(false);
  });
});

describe('Policy.summary', () => {
  it('returns defaultAllow sorted alphabetically', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['z-tool', 'a-tool', 'm-tool'] },
    });
    const summary: PolicySummary = policy.summary();
    expect(summary.defaultAllow).toEqual(['a-tool', 'm-tool', 'z-tool']);
  });

  it('returns an empty defaultAllow when no defaults are set', () => {
    const policy = Policy.fromDocument({});
    expect(policy.summary().defaultAllow).toEqual([]);
  });

  it('returns per-user entries sorted by UPN', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'z@example.com': { allow: ['tool-z'] },
        'a@example.com': { allow: ['tool-a'] },
      },
    });
    const summary = policy.summary();
    expect(summary.users[0].upn).toBe('a@example.com');
    expect(summary.users[1].upn).toBe('z@example.com');
  });

  it('returns allow and deny arrays sorted alphabetically per user', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: ['identity-get-me'] },
      users: {
        'u@example.com': {
          allow: ['z-allowed', 'a-allowed'],
          deny: ['y-denied', 'b-denied'],
        },
      },
    });
    const user = policy.summary().users[0];
    expect(user.allow).toEqual(['a-allowed', 'z-allowed']);
    expect(user.deny).toEqual(['b-denied', 'y-denied']);
  });

  it('returns empty users array when no per-user entries exist', () => {
    const policy = Policy.fromDocument({ defaults: { allow: ['identity-get-me'] } });
    expect(policy.summary().users).toEqual([]);
  });

  it('per-user UPN is normalized to lowercase (matches check() behaviour)', () => {
    const policy = Policy.fromDocument({
      defaults: { allow: [] },
      users: { 'UPPER@EXAMPLE.COM': { allow: ['identity-get-me'] } },
    });
    const user = policy.summary().users[0];
    expect(user.upn).toBe('upper@example.com');
  });

  it('surfaces the normalized mailSend config', () => {
    const policy = Policy.fromDocument({
      mailSend: { requireSameDomain: true, allowedDomains: ['@AretePartners.com', 'b.com', ''] },
    });
    expect(policy.summary().mailSend).toEqual({
      requireSameDomain: true,
      allowedDomains: ['aretepartners.com', 'b.com'],
    });
  });

  it('defaults mailSend to same-domain-required when omitted (fail-safe)', () => {
    expect(Policy.fromDocument({}).summary().mailSend).toEqual({
      requireSameDomain: true,
      allowedDomains: [],
    });
  });
});

describe('evaluateMailSend', () => {
  const cfg = (over: Partial<typeof DEFAULT_MAIL_SEND_CONFIG> = {}) => ({
    ...DEFAULT_MAIL_SEND_CONFIG,
    ...over,
  });

  it('allows when sender and every recipient share the sender domain', () => {
    const decision = evaluateMailSend(cfg(), {
      senderUpn: 'me@arete.com',
      recipients: ['a@arete.com', 'b@arete.com'],
    });
    expect(decision.allowed).toBe(true);
  });

  it('denies when any recipient is out of domain and names the offender', () => {
    const decision = evaluateMailSend(cfg(), {
      senderUpn: 'me@arete.com',
      recipients: ['a@arete.com', 'x@gmail.com'],
    });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) expect(decision.reason).toContain('x@gmail.com');
  });

  it('is case-insensitive on the domain comparison', () => {
    const decision = evaluateMailSend(cfg(), {
      senderUpn: 'Me@Arete.com',
      recipients: ['Friend@ARETE.COM'],
    });
    expect(decision.allowed).toBe(true);
  });

  it('enforces allowedDomains: the shared domain must be on the list', () => {
    const restricted = cfg({ allowedDomains: ['aretepartners.com'] });
    expect(
      evaluateMailSend(restricted, {
        senderUpn: 'me@aretepartners.com',
        recipients: ['a@aretepartners.com'],
      }).allowed
    ).toBe(true);
    expect(
      evaluateMailSend(restricted, {
        senderUpn: 'me@other.com',
        recipients: ['a@other.com'],
      }).allowed
    ).toBe(false);
  });

  it('denies when the sender UPN has no resolvable domain', () => {
    expect(evaluateMailSend(cfg(), { senderUpn: null, recipients: ['a@arete.com'] }).allowed).toBe(
      false
    );
    expect(
      evaluateMailSend(cfg(), { senderUpn: 'bogus', recipients: ['a@arete.com'] }).allowed
    ).toBe(false);
  });

  it('denies when there are no recipients to validate', () => {
    expect(evaluateMailSend(cfg(), { senderUpn: 'me@arete.com', recipients: [] }).allowed).toBe(
      false
    );
  });

  it('treats a recipient with no domain as out of domain', () => {
    expect(
      evaluateMailSend(cfg(), { senderUpn: 'me@arete.com', recipients: ['malformed'] }).allowed
    ).toBe(false);
  });

  it('short-circuits to allow when requireSameDomain is false', () => {
    const decision = evaluateMailSend(cfg({ requireSameDomain: false }), {
      senderUpn: 'me@arete.com',
      recipients: ['anyone@elsewhere.com'],
    });
    expect(decision.allowed).toBe(true);
  });
});

describe('Policy.checkMailSend', () => {
  it('delegates to the configured mailSend block', () => {
    const policy = Policy.fromDocument({
      mailSend: { requireSameDomain: true, allowedDomains: ['aretepartners.com'] },
    });
    expect(
      policy.checkMailSend({
        senderUpn: 'me@aretepartners.com',
        recipients: ['peer@aretepartners.com'],
      }).allowed
    ).toBe(true);
    expect(
      policy.checkMailSend({
        senderUpn: 'me@aretepartners.com',
        recipients: ['peer@external.com'],
      }).allowed
    ).toBe(false);
  });
});

describe('collectReferencedToolNames', () => {
  it('gathers names from defaults.allow and every user allow/deny, deduped', () => {
    const names = collectReferencedToolNames({
      defaults: { allow: ['mail-message-list', 'identity-get-me'] },
      users: {
        'a@example.com': { allow: ['mail-draft-create', 'mail-message-list'] },
        'b@example.com': { deny: ['download-bytes'] },
      },
    });
    expect(names).toEqual([
      'mail-message-list',
      'identity-get-me',
      'mail-draft-create',
      'download-bytes',
    ]);
  });

  it('skips blanks, non-strings, and missing sections', () => {
    const names = collectReferencedToolNames({
      defaults: { allow: ['mail-message-list', '', 42 as unknown as string] },
    });
    expect(names).toEqual(['mail-message-list']);
  });
});

describe('findUnknownPolicyTools', () => {
  const valid = new Set(['mail-message-list', 'mail-draft-create', 'download-bytes']);

  it('returns an empty array when every referenced tool is valid', () => {
    const unknown = findUnknownPolicyTools(
      {
        defaults: { allow: ['mail-message-list'] },
        users: { 'a@example.com': { allow: ['mail-draft-create'], deny: ['download-bytes'] } },
      },
      valid
    );
    expect(unknown).toEqual([]);
  });

  it('reports referenced tools that do not exist, in first-appearance order', () => {
    const unknown = findUnknownPolicyTools(
      {
        defaults: { allow: ['mail-message-list', 'create-draft-email'] },
        users: { 'a@example.com': { allow: ['send-chat-message'] } },
      },
      valid
    );
    expect(unknown).toEqual(['create-draft-email', 'send-chat-message']);
  });

  it('accepts an iterable of valid names, not just a Set', () => {
    const unknown = findUnknownPolicyTools(
      { defaults: { allow: ['mail-message-list', 'bogus-tool'] } },
      ['mail-message-list']
    );
    expect(unknown).toEqual(['bogus-tool']);
  });
});
