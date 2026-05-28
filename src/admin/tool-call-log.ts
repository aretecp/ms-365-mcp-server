/**
 * In-process ring buffer for recent tool call events.
 *
 * Node is single-threaded JS: array push/shift is safe without a mutex.
 * Do NOT make this async — the ALS scope of each MCP request is synchronous
 * at the record() call site. Adding async here would lose the context.
 *
 * The singleton `toolCallLog` is the single source of truth; import it
 * anywhere you need to record or read.
 */

const REDACT_KEY_RE = /password|secret|token|authorization/i;
const EXCERPT_MAX = 512;

/** Outcome of a single tool invocation. */
export type ToolCallStatus =
  | 'allowed'
  | 'denied_by_policy'
  | 'precondition_failed'
  | 'graph_error'
  | 'unauthorized';

/** One row in the ring buffer. */
export interface ToolCallEntry {
  id: string;
  ts: number;
  /** UPN from request context. Null when called outside an MCP session (utility pre-auth). */
  upn: string | null;
  toolName: string;
  status: ToolCallStatus;
  latencyMs: number;
  argsExcerpt: string;
  responseExcerpt: string | null;
  errorText: string | null;
}

/**
 * Redact sensitive keys from a params object, then truncate to EXCERPT_MAX chars.
 * Accepts unknown input — stringify handles the rest.
 */
export function redactArgs(params: unknown): string {
  let obj: unknown = params;
  if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) {
    const cleaned: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (REDACT_KEY_RE.test(k)) {
        cleaned[k] = '[REDACTED]';
      } else {
        cleaned[k] = v;
      }
    }
    obj = cleaned;
  }
  const raw = JSON.stringify(obj) ?? '';
  return raw.length > EXCERPT_MAX ? raw.slice(0, EXCERPT_MAX) + '…' : raw;
}

/**
 * Truncate a response/error string to EXCERPT_MAX chars.
 * No key stripping — Graph responses are already serialized JSON strings,
 * not structured objects at this point.
 */
export function redactResponse(text: string | null | undefined): string | null {
  if (text == null) return null;
  return text.length > EXCERPT_MAX ? text.slice(0, EXCERPT_MAX) + '…' : text;
}

/** Bounded in-memory ring buffer for tool call entries. */
export class ToolCallLog {
  private readonly entries: ToolCallEntry[] = [];

  constructor(private readonly capacity: number = 200) {}

  /**
   * Record a new entry. If the buffer is at capacity, evicts the oldest entry
   * (index 0, which is the oldest given we push to the end).
   */
  record(entry: ToolCallEntry): void {
    if (this.entries.length >= this.capacity) {
      this.entries.shift();
    }
    this.entries.push(entry);
  }

  /**
   * Returns a newest-first snapshot copy of the buffer.
   * Callers receive a copy — mutations do not affect the ring buffer.
   */
  snapshot(): ToolCallEntry[] {
    return [...this.entries].reverse();
  }

  /** Clears all entries. Primarily useful in tests. */
  clear(): void {
    this.entries.length = 0;
  }

  /** Current number of entries. */
  get size(): number {
    return this.entries.length;
  }
}

/** Module-level singleton — import this everywhere. */
export const toolCallLog = new ToolCallLog();
