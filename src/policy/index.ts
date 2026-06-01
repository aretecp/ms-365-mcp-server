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

interface NormalizedPolicy {
  defaultAllow: Set<string>;
  perUser: Map<string, { allow: Set<string>; deny: Set<string> }>;
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
  return { defaultAllow, perUser, sourcePath };
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
    return { defaultAllow, users };
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
