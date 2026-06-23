// src/sync/standalone.ts
import fs from 'node:fs';

export interface StandaloneSyncInput {
  file: string;
  anchor: string;
  oldContent: string;
  newContent: string;
}

export function updateStandaloneDoc(input: StandaloneSyncInput): boolean {
  if (!fs.existsSync(input.file)) return false;

  let content = fs.readFileSync(input.file, 'utf-8');

  // Find the section by anchor (heading) and replace relevant content
  const headingRegex = new RegExp(
    `(#{1,6}\\s+${escapeRegex(input.anchor)}[^#]*?)(?=\n#{1,6}\\s|$)`,
    'is',
  );

  const match = content.match(headingRegex);
  if (!match) return false;

  const sectionContent = match[1];
  if (!sectionContent.includes(input.oldContent)) return false;

  const updatedSection = sectionContent.replace(input.oldContent, input.newContent);
  content = content.replace(sectionContent, updatedSection);

  fs.writeFileSync(input.file, content, 'utf-8');
  return true;
}

export function findSectionContent(file: string, anchor: string): string | null {
  if (!fs.existsSync(file)) return null;

  const content = fs.readFileSync(file, 'utf-8');
  const headingRegex = new RegExp(
    `(#{1,6}\\s+${escapeRegex(anchor)}[^#]*?)(?=\n#{1,6}\\s|$)`,
    'is',
  );

  const match = content.match(headingRegex);
  return match ? match[1] : null;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
