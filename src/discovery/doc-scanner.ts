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

function parseFile(absPath: string, projectRoot: string): ParsedDocSection[] | null {
  const ext = path.extname(absPath).toLowerCase();
  const parser = getParser(ext);
  if (!parser) return null;

  let content: string;
  try {
    content = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return null;
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
