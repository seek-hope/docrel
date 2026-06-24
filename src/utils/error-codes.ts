/**
 * Structured error codes for DocRelay operations.
 *
 * Every user-facing error should carry a code so operators can grep logs,
 * configure alerting thresholds, and diagnose issues without reading source.
 *
 * Codes are grouped by system:
 *   E001–E009  Database
 *   E010–E019  Filesystem
 *   E020–E029  Codegraph / symbol extraction
 *   E030–E039  Doc generators
 *   E040–E049  Sync engine
 *   E050–E059  Git hooks
 *   E060–E069  Input validation
 *   E070–E079  MCP / CLI boundary
 *   E080–E089  Configuration
 *   E090–E099  Internal / unexpected
 */

export const ErrorCode = {
  // ── Database ─────────────────────────────────────────────────
  DB_CONNECTION_FAILED:    'DOCRELAY_E001',
  DB_CLOSED:               'DOCRELAY_E002',
  DB_BUSY:                 'DOCRELAY_E003',
  DB_CORRUPT:              'DOCRELAY_E004',
  DB_MIGRATION_FAILED:     'DOCRELAY_E005',
  DB_QUERY_FAILED:         'DOCRELAY_E006',

  // ── Filesystem ───────────────────────────────────────────────
  FS_READ_FAILED:          'DOCRELAY_E010',
  FS_WRITE_FAILED:         'DOCRELAY_E011',
  FS_PERMISSION_DENIED:    'DOCRELAY_E012',
  FS_PATH_TRAVERSAL:       'DOCRELAY_E013',
  FS_FILE_TOO_LARGE:       'DOCRELAY_E014',
  FS_SYMLINK_BYPASS:       'DOCRELAY_E015',
  FS_ATOMIC_WRITE_FAILED:  'DOCRELAY_E016',

  // ── Codegraph / extraction ──────────────────────────────────
  CG_UNAVAILABLE:          'DOCRELAY_E020',
  CG_TIMEOUT:              'DOCRELAY_E021',
  CG_INVALID_RESPONSE:     'DOCRELAY_E022',
  CG_BINARY_REJECTED:      'DOCRELAY_E023',
  EXTRACTOR_FAILED:        'DOCRELAY_E024',
  SYMBOL_MALFORMED:        'DOCRELAY_E025',

  // ── Doc generators ──────────────────────────────────────────
  GEN_COMMAND_REJECTED:    'DOCRELAY_E030',
  GEN_EXECUTION_FAILED:    'DOCRELAY_E031',
  GEN_TIMEOUT:             'DOCRELAY_E032',
  GEN_NO_GENERATOR_FOUND:  'DOCRELAY_E033',

  // ── Sync engine ─────────────────────────────────────────────
  SYNC_INLINE_FAILED:      'DOCRELAY_E040',
  SYNC_STANDALONE_FAILED:  'DOCRELAY_E041',
  SYNC_GENERATED_FAILED:   'DOCRELAY_E042',
  SYNC_DOCSTRING_MISSING:  'DOCRELAY_E043',
  SYNC_SIGNATURE_AMBIGUOUS:'DOCRELAY_E044',
  SYNC_PARTIAL:            'DOCRELAY_E045',

  // ── Git hooks ───────────────────────────────────────────────
  HOOK_INSTALL_FAILED:     'DOCRELAY_E050',
  HOOK_PRE_COMMIT_BLOCKED: 'DOCRELAY_E051',
  HOOK_POST_COMMIT_FAILED: 'DOCRELAY_E052',
  HOOK_PRE_PUSH_BLOCKED:   'DOCRELAY_E053',

  // ── Input validation ────────────────────────────────────────
  VALIDATION_INVALID_INPUT: 'DOCRELAY_E060',
  VALIDATION_TOO_MANY:      'DOCRELAY_E061',
  VALIDATION_PATH_TOO_LONG: 'DOCRELAY_E062',

  // ── MCP / CLI boundary ──────────────────────────────────────
  MCP_TOOL_ERROR:           'DOCRELAY_E070',
  CLI_COMMAND_FAILED:       'DOCRELAY_E071',
  INIT_FAILED:              'DOCRELAY_E072',

  // ── Configuration ───────────────────────────────────────────
  CONFIG_INVALID:           'DOCRELAY_E080',
  CONFIG_MISSING:           'DOCRELAY_E081',
  CONFIG_PARSE_FAILED:      'DOCRELAY_E082',

  // ── Internal ────────────────────────────────────────────────
  INTERNAL_UNEXPECTED:      'DOCRELAY_E090',
  INTERNAL_SHUTDOWN_FAILED: 'DOCRELAY_E091',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface DocRelayError {
  code: ErrorCode;
  message: string;
  detail?: string;
  recoverable: boolean;
}

/**
 * Create a structured DocRelay error.
 * @param code — one of the DOCRELAY_E* codes above
 * @param message — human-readable summary (safe for MCP/CLI clients)
 * @param detail — optional internal detail (logged, not returned to clients)
 * @param recoverable — whether the operation can be retried
 */
export function docrelayError(
  code: ErrorCode,
  message: string,
  detail?: string,
  recoverable = false,
): DocRelayError {
  return { code, message, detail, recoverable };
}

/** Map of error codes to one-line descriptions for health dashboards. */
export const ERROR_CODE_DESCRIPTIONS: Record<ErrorCode, string> = {
  [ErrorCode.DB_CONNECTION_FAILED]:     'Database connection failed — check .docrelay/ permissions',
  [ErrorCode.DB_CLOSED]:                'Database connection was closed — re-initialize',
  [ErrorCode.DB_BUSY]:                  'Database is locked by another process — retry',
  [ErrorCode.DB_CORRUPT]:               'Database may be corrupted — run docrelay reset',
  [ErrorCode.DB_MIGRATION_FAILED]:      'Schema migration failed — database may be in an inconsistent state',
  [ErrorCode.DB_QUERY_FAILED]:          'Database query failed — check server logs',
  [ErrorCode.FS_READ_FAILED]:           'File read failed — check permissions and disk health',
  [ErrorCode.FS_WRITE_FAILED]:          'File write failed — check disk space and permissions',
  [ErrorCode.FS_PERMISSION_DENIED]:     'Permission denied — check file/directory permissions',
  [ErrorCode.FS_PATH_TRAVERSAL]:        'Path traversal blocked — file path escapes project root',
  [ErrorCode.FS_FILE_TOO_LARGE]:        'File exceeds size limit',
  [ErrorCode.FS_SYMLINK_BYPASS]:        'Symlink bypass blocked — symlink target outside project root',
  [ErrorCode.FS_ATOMIC_WRITE_FAILED]:   'Atomic write failed — data was not modified',
  [ErrorCode.CG_UNAVAILABLE]:           'Codegraph is not available — falling back to builtin extractor',
  [ErrorCode.CG_TIMEOUT]:               'Codegraph request timed out — retry or check codegraph process',
  [ErrorCode.CG_INVALID_RESPONSE]:      'Codegraph returned an unexpected response format',
  [ErrorCode.CG_BINARY_REJECTED]:       'Codegraph binary rejected by security validation',
  [ErrorCode.EXTRACTOR_FAILED]:         'Symbol extraction failed — no symbols were discovered',
  [ErrorCode.SYMBOL_MALFORMED]:         'Malformed symbol skipped — possibly corrupted codegraph output',
  [ErrorCode.GEN_COMMAND_REJECTED]:     'Generator command rejected by security validation',
  [ErrorCode.GEN_EXECUTION_FAILED]:     'Documentation generator failed to execute',
  [ErrorCode.GEN_TIMEOUT]:              'Documentation generator timed out',
  [ErrorCode.GEN_NO_GENERATOR_FOUND]:   'No documentation generator found for this file type',
  [ErrorCode.SYNC_INLINE_FAILED]:       'Inline doc sync failed — see detail for symbol name',
  [ErrorCode.SYNC_STANDALONE_FAILED]:   'Standalone doc sync failed — section may have been restructured',
  [ErrorCode.SYNC_GENERATED_FAILED]:    'Generated doc sync failed — generator returned an error',
  [ErrorCode.SYNC_DOCSTRING_MISSING]:   'Docstring not found — skipping sync to avoid data loss',
  [ErrorCode.SYNC_SIGNATURE_AMBIGUOUS]: 'Signature ambiguous — multiple matches in source file',
  [ErrorCode.SYNC_PARTIAL]:             'Sync partially completed — some docs updated, some failed',
  [ErrorCode.HOOK_INSTALL_FAILED]:      'Git hook installation failed — check .git/hooks/ permissions',
  [ErrorCode.HOOK_PRE_COMMIT_BLOCKED]:  'Pre-commit blocked — documentation is stale',
  [ErrorCode.HOOK_POST_COMMIT_FAILED]:  'Post-commit scan failed — docs may be stale',
  [ErrorCode.HOOK_PRE_PUSH_BLOCKED]:    'Pre-push blocked — documentation is stale',
  [ErrorCode.VALIDATION_INVALID_INPUT]: 'Invalid input — check parameter values',
  [ErrorCode.VALIDATION_TOO_MANY]:      'Too many items — reduce batch size',
  [ErrorCode.VALIDATION_PATH_TOO_LONG]: 'Path exceeds maximum length',
  [ErrorCode.MCP_TOOL_ERROR]:           'MCP tool returned an error — check server logs',
  [ErrorCode.CLI_COMMAND_FAILED]:       'CLI command failed — check output above',
  [ErrorCode.INIT_FAILED]:              'DocRelay initialization failed — check configuration',
  [ErrorCode.CONFIG_INVALID]:           'Configuration is invalid — check .docrelay/config.yaml',
  [ErrorCode.CONFIG_MISSING]:           'Configuration file not found — run docrelay init',
  [ErrorCode.CONFIG_PARSE_FAILED]:      'Configuration file could not be parsed — check YAML syntax',
  [ErrorCode.INTERNAL_UNEXPECTED]:      'Unexpected internal error — check server logs',
  [ErrorCode.INTERNAL_SHUTDOWN_FAILED]: 'Shutdown failed — WAL may not have checkpointed',
};

/**
 * Log a structured error to stderr. Prefixes the error code for grep-ability.
 * Detail is always logged; only code + message are returned to clients.
 */
export function logError(err: DocRelayError): void {
  const detailPart = err.detail ? ` (${err.detail})` : '';
  const recoverableTag = err.recoverable ? ' [recoverable]' : '';
  console.error(`[${err.code}]${recoverableTag} ${err.message}${detailPart}`);
}
