import crypto from 'node:crypto';

export function symbolId(language: string, fqn: string, kind: string): string {
  // Return empty string for invalid input instead of throwing, so a single
  // bad symbol (e.g., from a codegraph output format change) does not abort
  // the entire directory scan. The caller can check and skip empty results.
  if (language == null || fqn == null || kind == null) {
    console.warn(`DocRelay: symbolId received null/undefined argument — skipping`);
    return '';
  }
  const normalized = `${language.trim().toLowerCase()}:${fqn.trim()}:${kind.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function docSectionId(file: string, anchor: string): string {
  // Return empty string for invalid input instead of throwing, so a single
  // bad doc section (e.g., from a malformed mapping) does not abort the
  // operation. Callers can check and skip empty results.
  // This matches the behavior of symbolId() for consistency.
  if (file == null || anchor == null) {
    console.warn(`DocRelay: docSectionId received null/undefined argument — skipping`);
    return '';
  }
  // Encode '#' in both components so the '#' separator character is
  // unambiguous. Without this, docSectionId('README.md#Section', '1') and
  // docSectionId('README.md', 'Section#1') would produce the same hash.
  const normalized = `${file.trim().replace(/#/g, '%23')}#${anchor.trim().replace(/#/g, '%23')}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function contentHash(content: string): string {
  if (content == null) content = '';
  if (typeof content !== 'string') content = String(content);
  return crypto.createHash('sha256').update(content).digest('hex');
}
