import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import logger from '../logger.js';

/**
 * Per-user, per-tool authorization policy that runs in front of every
 * Graph call. Sits on top of (not in place of) Entra's own scope checks.
 *
 * Precedence:
 *   user.deny  ➜ deny
 *   user.allow ➜ allow
 *   defaults.allow ➜ allow
 *   otherwise  ➜ deny (fail-closed)
 *
 * Users are looked up by userPrincipalName (UPN, email-shaped). Unknown
 * users fall through to defaults.allow.
 */

/**
 * Same-domain guard for outbound mail (`mail-draft-send`). Sits in front of the
 * Graph `messages/{id}/send` action: even a user the policy allows to send is
 * refused unless the sender and EVERY recipient share one email domain.
 *
 * Configured under the `mailSend` key of the policy document so admins can tune
 * it without a code change. Enforced in code by the tool precondition (see
 * `src/tools/mail.ts`), not by the tool description.
 */
export interface MailSendPolicyConfig {
  /**
   * When true (the fail-safe default), `mail-draft-send` is allowed only if the
   * sender and all recipients are in the same domain. Set false to disable the
   * domain guard entirely (the per-tool allow/deny policy still applies).
   */
  requireSameDomain: boolean;
  /**
   * If non-empty, the shared domain MUST be one of these (e.g. `aretepartners.com`),
   * so even an internal-only message from an unlisted domain is refused. Empty
   * means "any single domain the sender belongs to" — the sender's own domain.
   * Stored lowercased with any leading `@` stripped.
   */
  allowedDomains: string[];
}

/** Result of a {@link evaluateMailSend} / {@link PolicyChecker.checkMailSend} call. */
export type MailSendDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * Fail-safe default applied when no `mailSend` block is present in the policy
 * (and as the fallback when a tool runs without a policy at all): require the
 * sender and every recipient to share a domain, but don't pin which domain.
 */
export const DEFAULT_MAIL_SEND_CONFIG: MailSendPolicyConfig = {
  requireSameDomain: true,
  allowedDomains: [],
};

/**
 * Structured summary of the active policy for display in the admin dashboard.
 * Returned by {@link Policy.summary} / {@link PolicyManager.summary}.
 */
export interface PolicySummary {
  /** Tools allowed for any user not covered by a per-user entry. */
  defaultAllow: string[];
  /** Per-user overrides, sorted by UPN. */
  users: Array<{
    upn: string;
    /** Tools explicitly allowed for this user (beyond defaults). */
    allow: string[];
    /** Tools explicitly denied for this user (overrides defaults). */
    deny: string[];
  }>;
  /** Active same-domain send guard configuration. */
  mailSend: MailSendPolicyConfig;
}

export interface PolicyDocument {
  defaults?: {
    allow?: string[];
  };
  users?: Record<
    string,
    {
      allow?: string[];
      deny?: string[];
    }
  >;
  mailSend?: {
    requireSameDomain?: boolean;
    allowedDomains?: string[];
  };
}

/**
 * Anything that can resolve a per-call policy decision. The runtime depends
 * only on this shape, so both the immutable {@link Policy} (used in tests
 * via {@link Policy.fromDocument}) and the hot-reloading {@link PolicyManager}
 * (used in production via {@link PolicyManager.fromFile}) plug in cleanly.
 */
export interface PolicyChecker {
  check(args: { userPrincipalName: string | null; toolName: string }): boolean;
  /** Optional structured view of the policy (Policy/PolicyManager implement it). */
  summary?(): PolicySummary;
  /**
   * Same-domain send guard. Returns the allow/deny decision for sending a draft
   * to the given recipients as the given sender. Implemented by Policy /
   * PolicyManager; callers that may receive a bare checker should fall back to
   * {@link evaluateMailSend} with {@link DEFAULT_MAIL_SEND_CONFIG}.
   */
  checkMailSend?(args: { senderUpn: string | null; recipients: string[] }): MailSendDecision;
}

/** Lowercased domain part after the last `@`, or null when the address has none. */
function domainOf(address: string | null | undefined): string | null {
  if (typeof address !== 'string') return null;
  const at = address.lastIndexOf('@');
  if (at < 0 || at === address.length - 1) return null;
  return address
    .slice(at + 1)
    .trim()
    .toLowerCase();
}

/**
 * Pure same-domain decision. Allows the send only when the sender resolves to a
 * domain, every recipient is in that exact domain, and (if `allowedDomains` is
 * configured) that domain is on the allow-list. Returns a structured reason on
 * denial so the runtime can surface it to the model.
 */
export function evaluateMailSend(
  config: MailSendPolicyConfig,
  args: { senderUpn: string | null; recipients: string[] }
): MailSendDecision {
  if (!config.requireSameDomain) return { allowed: true };

  const senderDomain = domainOf(args.senderUpn);
  if (!senderDomain) {
    return {
      allowed: false,
      reason: 'could not determine the sender domain from the signed-in identity.',
    };
  }
  if (config.allowedDomains.length > 0 && !config.allowedDomains.includes(senderDomain)) {
    return {
      allowed: false,
      reason: `sender domain '${senderDomain}' is not in the policy's allowed send domains (${config.allowedDomains.join(', ')}).`,
    };
  }
  if (args.recipients.length === 0) {
    return { allowed: false, reason: 'the message has no recipients to validate.' };
  }
  const offenders = args.recipients.filter((r) => domainOf(r) !== senderDomain);
  if (offenders.length > 0) {
    return {
      allowed: false,
      reason: `every recipient must be in the sender's domain '${senderDomain}'. Out-of-domain recipient(s): ${offenders.join(', ')}.`,
    };
  }
  return { allowed: true };
}

/**
 * Collect every tool name referenced anywhere in a policy document:
 * `defaults.allow` plus every user's `allow` and `deny` lists. Deduplicated,
 * order preserved by first appearance, blanks/non-strings skipped.
 *
 * Used by the admin policy editor to reject a saved policy that names a tool
 * that doesn't exist (almost always a typo) before it's written to disk.
 */
export function collectReferencedToolNames(doc: PolicyDocument): string[] {
  const seen = new Set<string>();
  const add = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const v of list) if (typeof v === 'string' && v !== '') seen.add(v);
  };
  add(doc.defaults?.allow);
  if (doc.users) {
    for (const entry of Object.values(doc.users)) {
      add(entry?.allow);
      add(entry?.deny);
    }
  }
  return [...seen];
}

/**
 * Return the tool names a policy references that are NOT in `validToolNames`,
 * in first-appearance order. An empty array means every referenced tool exists.
 *
 * The valid set is injected rather than imported so this module stays decoupled
 * from the tool registry — `src/tools` already depends on the policy types, and
 * importing it back here would be a circular dependency.
 */
export function findUnknownPolicyTools(
  doc: PolicyDocument,
  validToolNames: ReadonlySet<string> | Iterable<string>
): string[] {
  const valid = validToolNames instanceof Set ? validToolNames : new Set<string>(validToolNames);
  return collectReferencedToolNames(doc).filter((name) => !valid.has(name));
}

const POLICY_PATH_ENV = 'MS365_MCP_POLICY_PATH';
const DEFAULT_POLICY_PATH = path.join(process.cwd(), 'policy', 'policy.yaml');

function resolvePolicyPath(): string {
  const env = process.env[POLICY_PATH_ENV]?.trim();
  return env && env !== '' ? env : DEFAULT_POLICY_PATH;
}

function normalizeList(arr: unknown): Set<string> {
  if (!Array.isArray(arr)) return new Set();
  const out = new Set<string>();
  for (const v of arr) if (typeof v === 'string' && v !== '') out.add(v);
  return out;
}

/** Lowercase domains, strip a leading `@`, drop blanks, and de-dup (sorted). */
function normalizeDomains(arr: unknown): string[] {
  if (!Array.isArray(arr)) return [];
  const out = new Set<string>();
  for (const v of arr) {
    if (typeof v !== 'string') continue;
    const d = v.trim().toLowerCase().replace(/^@/, '');
    if (d !== '') out.add(d);
  }
  return [...out].sort();
}

function normalizeMailSend(raw: PolicyDocument['mailSend']): MailSendPolicyConfig {
  return {
    // Default ON: a missing/partial mailSend block must not silently open up
    // unrestricted sending.
    requireSameDomain: raw?.requireSameDomain ?? DEFAULT_MAIL_SEND_CONFIG.requireSameDomain,
    allowedDomains: normalizeDomains(raw?.allowedDomains),
  };
}

interface NormalizedPolicy {
  defaultAllow: Set<string>;
  perUser: Map<string, { allow: Set<string>; deny: Set<string> }>;
  mailSend: MailSendPolicyConfig;
  sourcePath: string;
}

function normalize(raw: PolicyDocument, sourcePath: string): NormalizedPolicy {
  const defaultAllow = normalizeList(raw.defaults?.allow);
  const perUser = new Map<string, { allow: Set<string>; deny: Set<string> }>();
  if (raw.users) {
    for (const [upn, entry] of Object.entries(raw.users)) {
      perUser.set(upn.toLowerCase(), {
        allow: normalizeList(entry?.allow),
        deny: normalizeList(entry?.deny),
      });
    }
  }
  const mailSend = normalizeMailSend(raw.mailSend);
  return { defaultAllow, perUser, mailSend, sourcePath };
}

export class Policy implements PolicyChecker {
  constructor(private readonly doc: NormalizedPolicy) {}

  static fromFile(filePath?: string): Policy {
    const resolved = filePath ?? resolvePolicyPath();
    if (!fs.existsSync(resolved)) {
      throw new Error(
        `Policy file not found at ${resolved}. ` +
          `Copy policy/policy.yaml.example to ${resolved} or set ${POLICY_PATH_ENV}.`
      );
    }
    const raw = fs.readFileSync(resolved, 'utf8');
    let parsed: unknown;
    try {
      parsed = yaml.load(raw);
    } catch (error) {
      throw new Error(`Failed to parse policy YAML at ${resolved}: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object') {
      throw new Error(`Policy file at ${resolved} must be a YAML mapping.`);
    }
    const normalized = normalize(parsed as PolicyDocument, resolved);
    logger.info(
      `Loaded policy from ${resolved}: ${normalized.defaultAllow.size} default-allow tools, ${normalized.perUser.size} per-user entries`
    );
    return new Policy(normalized);
  }

  /** Visible for tests; production code uses fromFile. */
  static fromDocument(doc: PolicyDocument): Policy {
    return new Policy(normalize(doc, '<inline>'));
  }

  check(args: { userPrincipalName: string | null; toolName: string }): boolean {
    const upn = args.userPrincipalName?.toLowerCase() ?? null;
    if (upn) {
      const entry = this.doc.perUser.get(upn);
      if (entry) {
        if (entry.deny.has(args.toolName)) return false;
        if (entry.allow.has(args.toolName)) return true;
      }
    }
    return this.doc.defaultAllow.has(args.toolName);
  }

  /** Active same-domain send guard configuration. */
  mailSendConfig(): MailSendPolicyConfig {
    return this.doc.mailSend;
  }

  /** Same-domain send decision for the configured {@link MailSendPolicyConfig}. */
  checkMailSend(args: { senderUpn: string | null; recipients: string[] }): MailSendDecision {
    return evaluateMailSend(this.doc.mailSend, args);
  }

  /** Mostly for diagnostics. Returns the file path the policy was loaded from. */
  source(): string {
    return this.doc.sourcePath;
  }

  /**
   * Returns a structured summary of the policy for the admin dashboard.
   * Arrays are sorted for stable rendering; the underlying Sets are unordered.
   */
  summary(): PolicySummary {
    const defaultAllow = [...this.doc.defaultAllow].sort();
    const users = [...this.doc.perUser.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([upn, entry]) => ({
        upn,
        allow: [...entry.allow].sort(),
        deny: [...entry.deny].sort(),
      }));
    return {
      defaultAllow,
      users,
      mailSend: {
        requireSameDomain: this.doc.mailSend.requireSameDomain,
        allowedDomains: [...this.doc.mailSend.allowedDomains],
      },
    };
  }
}

/**
 * Hot-reloadable wrapper around {@link Policy}. Production code holds a
 * single PolicyManager and the SIGHUP handler in `src/index.ts` calls
 * {@link PolicyManager.reload} to swap the underlying Policy without
 * restarting the process.
 *
 * Failure mode is intentionally soft: a parse error during reload logs and
 * keeps the previously-loaded Policy active. A typo in the YAML file should
 * not turn into a server outage.
 *
 * Overlapping reload calls coalesce: if a reload is in flight when another
 * arrives, the in-flight reload completes and exactly one extra reload runs
 * afterwards. Avoids both stampedes and starvation.
 */
export class PolicyManager implements PolicyChecker {
  private current: Policy;
  private pending: Promise<void> | null = null;
  private queued = false;

  constructor(
    initial: Policy,
    private readonly filePath: string
  ) {
    this.current = initial;
  }

  static fromFile(filePath?: string): PolicyManager {
    const initial = Policy.fromFile(filePath);
    return new PolicyManager(initial, initial.source());
  }

  check(args: { userPrincipalName: string | null; toolName: string }): boolean {
    return this.current.check(args);
  }

  /** Delegates to the currently-loaded Policy. */
  mailSendConfig(): MailSendPolicyConfig {
    return this.current.mailSendConfig();
  }

  /** Delegates to the currently-loaded Policy. */
  checkMailSend(args: { senderUpn: string | null; recipients: string[] }): MailSendDecision {
    return this.current.checkMailSend(args);
  }

  /** Visible for tests / diagnostics. */
  source(): string {
    return this.filePath;
  }

  /** Delegates to the currently-loaded Policy. */
  summary(): PolicySummary {
    return this.current.summary();
  }

  /**
   * Reload the policy from disk. Resolves once the (re)load completes; on a
   * parse / validation failure the existing Policy is kept and the promise
   * rejects so callers can log. Overlapping calls coalesce: while one reload
   * is in flight, a single follow-up reload is queued.
   */
  async reload(): Promise<void> {
    if (this.pending) {
      this.queued = true;
      await this.pending;
      // After the in-flight reload finished, if we queued, we already ran a
      // follow-up below; nothing more to do for this caller.
      return;
    }
    this.pending = this.runReload();
    try {
      await this.pending;
    } finally {
      this.pending = null;
      if (this.queued) {
        this.queued = false;
        // Fire-and-forget the follow-up; awaiting it would deadlock callers
        // that were waiting on the original `pending` resolution.
        void this.reload();
      }
    }
  }

  private async runReload(): Promise<void> {
    try {
      const next = Policy.fromFile(this.filePath);
      this.current = next;
      logger.info(`Policy reloaded from ${this.filePath}`);
    } catch (error) {
      const message = (error as Error).message;
      logger.error(`Policy reload failed; keeping previous policy active: ${message}`);
      throw error;
    }
  }
}
