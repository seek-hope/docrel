import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, validateConfig, CONFIG_SCHEMA_VERSION } from '../../src/utils/config.js';

describe('loadConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-config-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(yaml: string): void {
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), yaml);
  }

  it('returns defaults when config.yaml is missing', () => {
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.project).toBe(path.basename(tmpDir));
    expect(config.doc_dirs).toEqual(['docs', 'README.md']);
    expect(config.code_dirs).toEqual(['src']);
    expect(config.strategies.architecture).toBe('mark_stale');
  });

  it('merges user config over defaults', () => {
    writeConfig('project: my-app\ncode_dirs:\n  - lib\n  - app\n');
    const config = loadConfig(tmpDir);
    expect(config.project).toBe('my-app');
    expect(config.code_dirs).toEqual(['lib', 'app']);
    // Untouched fields keep defaults
    expect(config.doc_dirs).toEqual(['docs', 'README.md']);
  });

  it('merges partial strategies without losing defaults', () => {
    writeConfig('strategies:\n  standalone: prompt\n');
    const config = loadConfig(tmpDir);
    expect(config.strategies.standalone).toBe('prompt');
    expect(config.strategies.inline).toBe('auto_update');
    expect(config.strategies.architecture).toBe('mark_stale');
  });

  it('throws for a missing or empty projectRoot', () => {
    expect(() => loadConfig('')).toThrow(/projectRoot is required/);
    expect(() => loadConfig(path.join(tmpDir, 'does-not-exist'))).toThrow(/does not exist/);
  });

  it('falls back to defaults on invalid YAML', () => {
    writeConfig('project: [unclosed\n  : : :\n');
    const config = loadConfig(tmpDir);
    expect(config.doc_dirs).toEqual(['docs', 'README.md']);
  });

  it('falls back to defaults on schema-invalid config', () => {
    writeConfig('strategies:\n  inline: explode\n');
    const config = loadConfig(tmpDir);
    expect(config.strategies.inline).toBe('auto_update');
  });

  it('migrates configs with an older schema version instead of discarding them', () => {
    writeConfig('version: 0\nproject: old-app\ncode_dirs:\n  - lib\n');
    const config = loadConfig(tmpDir);
    expect(config.project).toBe('old-app');
    expect(config.code_dirs).toEqual(['lib']);
    expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('preserves a future schema version so validateConfig can warn', () => {
    writeConfig(`version: ${CONFIG_SCHEMA_VERSION + 1}\nproject: future-app\n`);
    const config = loadConfig(tmpDir);
    expect(config.version).toBe(CONFIG_SCHEMA_VERSION + 1);
  });
});

describe('validateConfig', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-configval-'));
    fs.mkdirSync(path.join(tmpDir, 'src'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('passes a sane default-shaped config', () => {
    const config = loadConfig(tmpDir);
    config.doc_dirs = [];
    const issues = validateConfig(config, tmpDir);
    expect(issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('errors when a code dir does not exist', () => {
    const config = loadConfig(tmpDir);
    config.code_dirs = ['missing-dir'];
    const issues = validateConfig(config, tmpDir);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('missing-dir'))).toBe(true);
  });

  it('rejects paths escaping the project root', () => {
    const config = loadConfig(tmpDir);
    config.code_dirs = ['../../../etc'];
    const issues = validateConfig(config, tmpDir);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('outside project root'))).toBe(true);
  });

  it('warns (not errors) on missing doc dirs', () => {
    const config = loadConfig(tmpDir);
    config.doc_dirs = ['no-such-docs'];
    const issues = validateConfig(config, tmpDir);
    const issue = issues.find((i) => i.message.includes('no-such-docs'));
    expect(issue?.severity).toBe('warning');
  });

  it('errors when no code_dirs are configured', () => {
    const config = loadConfig(tmpDir);
    config.code_dirs = [];
    const issues = validateConfig(config, tmpDir);
    expect(issues.some((i) => i.severity === 'error' && i.field === 'code_dirs')).toBe(true);
  });

  it('warns on a future schema version', () => {
    const config = loadConfig(tmpDir);
    config.version = CONFIG_SCHEMA_VERSION + 5;
    const issues = validateConfig(config, tmpDir);
    expect(issues.some((i) => i.field === 'version' && i.severity === 'warning')).toBe(true);
  });
});

describe('loadConfig guards', () => {
  let tmpDir: string;
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-config-guard-'));
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('throws when projectRoot is a file, not a directory', () => {
    const file = path.join(tmpDir, 'plain-file');
    fs.writeFileSync(file, 'x');

    expect(() => loadConfig(file)).toThrow(/projectRoot is not a directory/);
  });

  it('falls back to defaults when config.yaml exceeds 1 MB', () => {
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: 1\n' + '# '.repeat(600 * 1024));

    const config = loadConfig(tmpDir);

    expect(config.code_dirs).toEqual(['src']);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('exceeds 1048576 bytes'));
  });

  it('warns and strips a non-numeric schema version, keeping other fields', () => {
    fs.mkdirSync(path.join(tmpDir, '.docrelay'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.docrelay', 'config.yaml'), 'version: abc\ncode_dirs:\n  - custom-src\n');

    const config = loadConfig(tmpDir);

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('not a valid number'));
    expect(config.version).toBe(CONFIG_SCHEMA_VERSION);
    expect(config.code_dirs).toEqual(['custom-src']);
  });
});

describe('validateConfig doc_dirs', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docrelay-config-val-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rejects doc dirs escaping the project root', () => {
    const config = loadConfig(tmpDir);
    config.doc_dirs = ['../../../etc'];
    const issues = validateConfig(config, tmpDir);
    expect(issues.some((i) => i.severity === 'error' && i.field === `doc_dirs.${'../../../etc'}` && i.message.includes('outside project root'))).toBe(true);
  });
});
