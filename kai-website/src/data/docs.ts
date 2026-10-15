import docsData from './docs.json';
import type { DocEntry } from '../components/DocView';

type GeneratedDocs = { generatedAt: string; docs: DocEntry[] };

const data = docsData as GeneratedDocs;

export const DOCS_GENERATED_AT = data.generatedAt;
export const DOCS: DocEntry[] = data.docs;

export function getDoc(slug: string): DocEntry | null {
  return DOCS.find((d) => d.slug === slug) ?? null;
}
