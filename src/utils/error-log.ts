/**
 * Central internal-error logging for CLI and MCP surfaces.
 *
 * Product rule: stderr never receives a raw stack trace or Error object by
 * default — users get one sanitized line; operators opt into stacks with
 * DOCRELAY_DEBUG=1. Several call sites used to inline this pattern (or
 * worse, pass the raw Error to console.error, dumping the whole stack);
 * centralizing it keeps the behavior uniform and auditable.
 */

/** True when DOCRELAY_DEBUG requests verbose diagnostics (stack traces). */
export const DOCRELAY_DEBUG =
  process.env.DOCRELAY_DEBUG === '1' || process.env.DOCRELAY_DEBUG === 'true';

/**
 * Log an internal error with context: `DocRelay: <context>: <message>` on
 * one line, plus the stack as a second line only under DOCRELAY_DEBUG.
 * Non-Error throws are stringified defensively.
 */
export function logInternalError(context: string, err: unknown): void {
  console.error(`DocRelay: ${context}:`, err instanceof Error ? err.message : String(err));
  if (DOCRELAY_DEBUG && err instanceof Error && err.stack) {
    console.error(`DocRelay: ${context} (debug stack):`, err.stack);
  }
}
