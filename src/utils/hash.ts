import crypto from 'node:crypto';

export function symbolId(language: string, fqn: string, kind: string): string {
  // Return empty string for invalid input instead of throwing, so a single
  // bad symbol (e.g., from a codegraph output format change) does not abort
  // the entire directory scan. The caller can check and skip empty results.
  if (language == null || fqn == null || kind == null) {
    console.warn(`DocRel: symbolId received null/undefined argument — skipping`);
    return '';
  }
  const normalized = `${language.trim().toLowerCase()}:${fqn.trim()}:${kind.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function docSectionId(file: string, anchor: string): string {
  if (file == null || anchor == null) {
    throw new Error('docSectionId: file and anchor are required');
  }
  const normalized = `${file.trim()}#${anchor.trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function contentHash(content: string): string {
  if (content == null) content = '';
  if (typeof content !== 'string') content = String(content);
  return crypto.createHash('sha256').update(content).digest('hex');
}
