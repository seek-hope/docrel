// Shared shell-metacharacter and control-character command validation.
// Used by both generated.ts (shell-based execution) and client.ts
// (spawn-based execution) for consistent defense-in-depth.

/** Block shell metacharacters and all ASCII control characters (0x00-0x1F).
 *  The `[\x00-\x1f]` range covers \n, \r, \t, \x00, \x0b (vertical tab),
 *  \x0c (form feed), and all other control characters that could be used
 *  for command injection or argument smuggling.
 *
 *  `maxLength` defaults to 1024 (the lenient limit used by generated.ts);
 *  client.ts passes 256 for a stricter bound. */
export function validateCommandSafety(cmd: string, maxLength = 1024): boolean {
  if (typeof cmd !== 'string') return false;
  if (cmd.length > maxLength) return false;
  if (/[;&|`$()<>!]/.test(cmd) || /[\x00-\x1f]/.test(cmd)) return false;
  return true;
}
