import crypto from 'node:crypto';

export function symbolId(language: string, fqn: string, kind: string): string {
  const normalized = `${language.trim().toLowerCase()}:${fqn.trim()}:${kind.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function docSectionId(file: string, anchor: string): string {
  const normalized = `${file.trim()}#${anchor.trim()}`;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

export function contentHash(content: string): string {
  if (content == null) content = '';
  return crypto.createHash('sha256').update(content).digest('hex');
}
