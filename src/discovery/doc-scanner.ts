// src/discovery/doc-scanner.ts — Walk doc directories and parse with plugable parsers
import fs from 'node:fs';
import path from 'node:path';
import { getParser, type ParsedDocSection } from './doc-parser.js';

export interface DocScanReport {
  totalSections: number;
  totalFiles: number;
  failedFiles: string[];
}

const MAX_FILES = 5000;

/**
 * Walk doc directories, pick the right parser by file extension,
 * parse all doc files, and return a flat list of sections.
 */
export async function scanDocs(
  docDirs: string[],
  projectRoot: string,
): Promise<{ sections: ParsedDocSection[]; report: DocScanReport }> {
  const sections: ParsedDocSection[] = [];
  const failedFiles: string[] = [];
  let totalFiles = 0;

  for (const docDir of docDirs) {
    const absDir = path.resolve(projectRoot, docDir);

    // Containment check: ensure resolved path stays within projectRoot.
    // Without this, config.yaml can specify doc_dirs: ['../../../etc'] to
    // walk arbitrary filesystem directories.
    const root = path.resolve(projectRoot);
    if (!absDir.startsWith(root + path.sep) && absDir !== root) {
      failedFiles.push(docDir);
      continue;
    }
    // Resolve symlinks and re-verify containment to prevent symlink bypass
    // (e.g. docs -> /etc would pass the lexical check above)
    let realDir: string;
    try {
      realDir = fs.realpathSync(absDir);
    } catch {
      failedFiles.push(docDir);
      continue;
    }
    if (!realDir.startsWith(root + path.sep) && realDir !== root) {
      failedFiles.push(docDir);
      continue;
    }

    // It might be a single file (e.g. README.md)
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absDir);
    } catch {
      failedFiles.push(docDir);
      continue;
    }

    if (stat.isFile()) {
      totalFiles++;
      const parsed = parseFile(absDir, projectRoot);
      if (parsed) {
        sections.push(...parsed);
      }
      continue;
    }

    if (!stat.isDirectory()) continue;

    // Recursively walk directory
    const files = collectDocFiles(absDir);
    for (const file of files) {
      if (totalFiles >= MAX_FILES) break;
      totalFiles++;
      const parsed = parseFile(file, projectRoot);
      if (parsed) {
        sections.push(...parsed);
      } else {
        failedFiles.push(path.relative(projectRoot, file));
      }
    }
  }

  return {
    sections,
    report: { totalSections: sections.length, totalFiles, failedFiles },
  };
}

const MAX_DOC_FILE_SIZE = 10 * 1024 * 1024; // 10 MB, matches inline/standalone limits

function parseFile(absPath: string, projectRoot: string): ParsedDocSection[] | null {
  const ext = path.extname(absPath).toLowerCase();
  const parser = getParser(ext);
  if (!parser) return null;

  let content: string;
  let fd: number | undefined;
  try {
    fd = fs.openSync(absPath, 'r');
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_DOC_FILE_SIZE) return null;
    content = fs.readFileSync(fd, 'utf-8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }

  const relativePath = path.relative(projectRoot, absPath);
  return parser.parse(relativePath, content);
}

/** Collect all doc files recursively. Skips hidden dirs and common non-doc dirs. */
function collectDocFiles(dir: string): string[] {
  const result: string[] = [];
  const supportedExts = new Set([
    '.md', '.mdx', '.rst', '.adoc', '.asciidoc', '.html', '.htm',
  ]);

  const stack: string[] = [dir];
  while (stack.length > 0 && result.length < MAX_FILES) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (result.length >= MAX_FILES) break;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules' ||
            entry.name === 'dist' || entry.name === 'build' || entry.name === '.git') {
          continue;
        }
        stack.push(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (supportedExts.has(ext)) {
          result.push(fullPath);
        }
      }
    }
  }

  return result;
}
