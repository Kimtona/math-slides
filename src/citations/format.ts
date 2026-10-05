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

/** References slide, APA-like: "Vaswani, A., Shazeer, N., … & Polosukhin, I. (2017). Title. arXiv:1706.03762." */
export function fullCitation(m: PaperMeta, sourceId: string): string {
  const names = m.authors.map(apaName);
  let authors: string;
  if (names.length === 1) authors = names[0];
  else if (names.length <= 20) authors = `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}`;
  else authors = `${names.slice(0, 19).join(', ')}, … ${names[names.length - 1]}`; // APA 7: first 19, …, last
  const title = m.title.replace(/[.\s]+$/, '');
  return `${authors} (${m.year}). ${title}. arXiv:${sourceId}.`;
}
