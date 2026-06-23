import crypto from 'node:crypto';

export function symbolId(language: string, fqn: string, kind: string): string {
  if (language == null || fqn == null || kind == null) {
    throw new Error('symbolId: language, fqn, and kind are all required');
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
