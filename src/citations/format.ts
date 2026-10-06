import type { Citation } from '../model/types';
import type { PaperMeta } from './providers';

const family = (name: string) => name.trim().split(/\s+/).pop() ?? name;
const initials = (name: string) =>
  name.trim().split(/\s+/).slice(0, -1)
    .map((g) => g.split('-').map((p) => (p ? p[0].toUpperCase() + '.' : '')).join('-'))
    .join(' ');

/** "Vaswani, A." / "Gomez, A. N." */
const apaName = (name: string) => {
  const i = initials(name);
  return i ? `${family(name)}, ${i}` : family(name);
};

/** Footer: "Paper Title, Smith, 2024" / "…, Smith & Lee, 2024" / "…, Smith et al., 2024". */
export function shortCitation(m: PaperMeta): string {
  const a = m.authors;
  const who = a.length === 1 ? family(a[0]) : a.length === 2 ? `${family(a[0])} & ${family(a[1])}` : `${family(a[0])} et al.`;
  return `${m.title}, ${who}, ${m.year}`;
}

/**
 * References slide, compact and presentation-oriented: 1 author "Vaswani, A. (2017)", 2 authors "Vaswani, A., & Shazeer, N. (2017)",
 * 3 or more "Vaswani, A. et al. (2017)". Followed by ". Title. arXiv:1706.03762."
 */
export function fullCitation(m: PaperMeta, sourceId: string): string {
  const names = m.authors.map(apaName);
  const authors = names.length <= 1 ? (names[0] ?? '') : names.length === 2 ? `${names[0]}, & ${names[1]}` : `${names[0]} et al.`;
  const title = m.title.replace(/[.\s]+$/, '');
  return `${authors} (${m.year}). ${title}. arXiv:${sourceId}.`;
}

/**
 * The text shown on the References slide. Derived from the structured metadata (authors, title, year, sourceId), so a
 * `fullCitation` string stored by an older format never goes stale; it is only the fallback when that metadata is missing.
 */
export function displayCitation(c: Citation): string {
  if (c.authors?.length && c.title && c.year) return fullCitation({ authors: c.authors, title: c.title, year: c.year }, c.sourceId);
  return c.fullCitation ?? c.url;
}
