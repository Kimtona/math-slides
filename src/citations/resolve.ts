import { get, set } from 'idb-keyval';
import type { Citation } from '../model/types';
import { useStore } from '../store/store';
import { findCitations, PROVIDERS, type Match } from './providers';
import { fullCitation, shortCitation } from './format';

// Resolved metadata is cached locally (per paper, across presentations) and stored in the deck,
// so reopening a presentation never re-fetches.
const cacheKey = (id: string) => `cite:${id}`;
const inFlight = new Map<string, Promise<void>>();

function pending(m: Match): Citation {
  return { id: m.citationId, type: 'arxiv', sourceId: m.sourceId, url: m.url, status: 'loading' };
}

/** Resolve one citation (no-op if already resolved). Failures keep the URL and allow retry. */
export function resolveCitation(id: string): Promise<void> {
  const existing = inFlight.get(id);
  if (existing) return existing;
  const run = (async () => {
    const st = useStore.getState();
    const c = st.deck.citations?.[id];
    if (!c || c.status === 'ok') return;
    if (c.status === 'error') st.applyCitation({ ...c, status: 'loading', error: undefined });
    try {
      let ok = (await get(cacheKey(id))) as Citation | undefined;
      if (!ok || ok.status !== 'ok') {
        const provider = PROVIDERS.find((p) => p.type === c.type)!;
        const meta = await provider.fetch(c.sourceId);
        ok = { ...c, status: 'ok', error: undefined, ...meta, shortCitation: shortCitation(meta), fullCitation: fullCitation(meta, c.sourceId) };
        set(cacheKey(id), ok).catch(() => {});
      }
      useStore.getState().applyCitation(ok);
    } catch (e) {
      useStore.getState().applyCitation({ ...c, status: 'error', error: String((e as Error)?.message ?? e) });
    } finally {
      inFlight.delete(id);
    }
  })();
  inFlight.set(id, run);
  return run;
}

/**
 * Pull academic URLs out of reference text: they become citations on the slide; the rest of
 * the text stays as typed. Returns the remaining manual text.
 */
export function extractCitations(slideId: string, text: string): string {
  const matches = findCitations(text);
  if (!matches.length) return text;
  let rest = text;
  for (const m of matches) rest = rest.split(m.raw).join(' ');
  rest = rest.replace(/\s*[;,]\s*(?=[;,]|$)/g, '').replace(/^\s*[;,]\s*/, '').replace(/\s+/g, ' ').trim();
  useStore.getState().addCitations(slideId, matches.map(pending));
  matches.forEach((m) => resolveCitation(m.citationId));
  return rest;
}

/** Resolve citations left pending (e.g. app closed while fetching). */
export function resumePendingCitations() {
  const cites = useStore.getState().deck.citations ?? {};
  Object.values(cites).filter((c) => c.status === 'loading').forEach((c) => resolveCitation(c.id));
}
