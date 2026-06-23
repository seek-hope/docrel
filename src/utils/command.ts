// Shared shell-metacharacter and control-character command validation.
// Used by both generated.ts (shell-based execution) and client.ts
// (spawn-based execution) for consistent defense-in-depth.

// NOTE: Do NOT extract the metacharacter regex below into a module-level
// constant with the `g` or `y` flag — global regex objects retain lastIndex
// state between .test() calls and would produce alternating true/false for
// the same input. A stateless const without flags is safe.

/** Block shell metacharacters and all ASCII control characters including DEL.
 *  The range covers \x00-\x1F (C0 controls: \n, \r, \t, \x00, \x0b, \x0c,
 *  etc.) AND \x7F (DEL), per ISO 6429. While DEL is not a shell metacharacter
 *  in execFile contexts, blocking it provides defense-in-depth if this function
 *  is ever reused in shell-based execution paths.
 *
 *  `maxLength` defaults to 1024 (the lenient limit used by generated.ts);
 *  client.ts passes 256 for a stricter bound. */
export function validateCommandSafety(cmd: string, maxLength = 1024): boolean {
  if (typeof cmd !== 'string') return false;
  if (cmd.length > maxLength) return false;
  if (/[;&|`$()<>!]/.test(cmd) || /[\x00-\x1f\x7f]/.test(cmd)) return false;
  return true;
}
