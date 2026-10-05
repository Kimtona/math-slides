/**
 * Academic identifier providers. Each provider recognizes URLs in pasted/typed text and
 * fetches metadata for its identifier. Only arXiv for now; a DOI provider would be another
 * entry in PROVIDERS with the same shape.
 */
export interface PaperMeta {
  title: string;
  authors: string[]; // "Given Family" as published
  year: number;
}

export interface Match {
  citationId: string; // stable dedupe key, e.g. "arxiv:1706.03762"
  sourceId: string; // "1706.03762"
  url: string; // canonical URL
  raw: string; // the matched text
}

export interface Provider {
  type: 'arxiv';
  find(text: string): Match[];
  fetch(sourceId: string): Promise<PaperMeta>;
}

// New-style ids (1706.03762, 2401.12345) and old-style (hep-th/9901001); versions/".pdf" stripped.
const ARXIV_URL = /(?:https?:\/\/)?(?:www\.|export\.)?arxiv\.org\/(?:abs|pdf|html)\/((?:[a-z-]+(?:\.[A-Z]{2})?\/\d{7})|(?:\d{4}\.\d{4,5}))(?:v\d+)?(?:\.pdf)?\/?/gi;

/** Transport: the desktop app fetches through the main process (arXiv sends no CORS headers);
 *  the dev server proxies /arxiv-api. */
async function fetchText(url: string): Promise<string> {
  const native = (window as any).native?.fetchText as ((u: string) => Promise<{ ok: boolean; status: number; text: string }>) | undefined;
  if (native) {
    const r = await native(url);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.text;
  }
  const r = await fetch(url.replace('https://export.arxiv.org', '/arxiv-api'));
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

export const arxiv: Provider = {
  type: 'arxiv',
  find(text) {
    const out: Match[] = [];
    for (const m of text.matchAll(ARXIV_URL)) {
      const sourceId = m[1];
      out.push({ citationId: `arxiv:${sourceId}`, sourceId, url: `https://arxiv.org/abs/${sourceId}`, raw: m[0] });
    }
    return out;
  },
  async fetch(sourceId) {
    const xml = await fetchText(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(sourceId)}`);
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    const entry = doc.getElementsByTagName('entry')[0];
    const pick = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
    const title = entry ? pick(entry, 'title') : '';
    const published = entry ? pick(entry, 'published') : '';
    const authors = entry ? [...entry.getElementsByTagName('author')].map((a) => pick(a, 'name')).filter(Boolean) : [];
    const year = parseInt(published.slice(0, 4), 10);
    // A missing id yields an entry titled "Error" with no authors.
    if (!title || title === 'Error' || !authors.length || !year) throw new Error('arXiv: paper not found');
    return { title, authors, year };
  },
};

export const PROVIDERS: Provider[] = [arxiv];

export function findCitations(text: string): Match[] {
  const seen = new Set<string>();
  return PROVIDERS.flatMap((p) => p.find(text)).filter((m) => !seen.has(m.citationId) && !!seen.add(m.citationId));
}
