/** Store invariant: after commit/live (incl. structure reconciliation) currentSlideId refers to an existing slide.
 * Runs headless through Vite's SSR loader (no Electron). Run: node tests/current-slide.mjs
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const server = await createServer({ root, configLoader: 'runner', cacheDir: await mkdtemp(path.join(tmpdir(), 'mathslides-vite-')), server: { middlewareMode: true }, appType: 'custom', logLevel: 'error' });
try {
  const { useStore } = await server.ssrLoadModule('/src/store/store.ts');
  const st = () => useStore.getState();
  const ids = () => st().deck.slides.map((s) => s.id);
  const exists = () => ids().includes(st().currentSlideId);
  const fakeCites = (n) => st().commit((d) => {
    for (const id of Object.keys(d.citations ?? {})) if (id.startsWith('arxiv:9999.')) delete d.citations[id];
    for (const s of d.slides) if (s.citations) s.citations = s.citations.filter((id) => !id.startsWith('arxiv:9999.'));
    d.citations = d.citations ?? {}; d.slides[0].citations = d.slides[0].citations ?? [];
    for (let i = 0; i < n; i++) {
      const id = 'arxiv:9999.' + String(i).padStart(5, '0');
      d.citations[id] = { id, type: 'arxiv', sourceId: id.slice(6), url: 'https://arxiv.org/abs/' + id.slice(6), status: 'ok', year: 2020, authors: ['Ann Fam' + i, 'Bob B'],
        title: ('A long descriptive paper title about many things ' + i + ' ').repeat(5).trim() };
      d.slides[0].citations.push(id);
    }
  });
  const refIds = () => ids().filter((id) => id.startsWith('references'));

  // commit: a generated continuation slide that is the current slide gets removed by reconciliation.
  fakeCites(30);
  assert.ok(refIds().length >= 3, 'setup: continuation References slides exist: ' + refIds());
  const last = refIds().at(-1);
  st().goToSlide(last); assert.equal(st().currentSlideId, last);
  const oldIdx = ids().indexOf(last);
  fakeCites(0);
  assert.equal(refIds().length, 0, 'continuation slides removed');
  assert.ok(exists(), 'commit: current slide exists after reconciliation');
  assert.ok(!ids().includes(last) && st().currentSlideId !== last, 'commit: deleted slide id not retained');
  assert.equal(st().currentSlideId, ids()[Math.min(oldIdx, ids().length - 1)], 'commit: fallback = slide now at the old position (clamped)');
  assert.deepEqual(st().selection, [], 'selection cleared when the slide changed');

  // Surviving current slide is left untouched.
  fakeCites(30);
  const keep = refIds()[1]; st().goToSlide(keep);
  fakeCites(25); // still paginated; references-2 may or may not survive, so pin the check to survival
  const survived = ids().includes(keep);
  if (survived) assert.equal(st().currentSlideId, keep, 'commit: surviving current slide unchanged');
  const first = ids()[0]; st().goToSlide(first);
  st().commit((d) => { d.slides[0].notes = 'n'; });
  assert.equal(st().currentSlideId, first, 'unrelated commit keeps the current slide');
  st().live((d) => { d.slides[0].notes = 'm'; });
  assert.equal(st().currentSlideId, first, 'unrelated live keeps the current slide');

  // live: same invariant (live runs the same reconciliation).
  fakeCites(30);
  const lastB = refIds().at(-1); st().goToSlide(lastB);
  st().live((d) => { for (const s of d.slides) s.citations = []; });
  assert.equal(refIds().length, 0, 'live: continuation slides removed');
  assert.ok(exists() && st().currentSlideId !== lastB, 'live: current slide repaired');

  // Direct removal of the current slide through commit.
  const blank = (id) => ({ ...JSON.parse(JSON.stringify(st().deck.slides[0])), id, kind: undefined });
  st().commit((d) => { d.slides.splice(1, 0, blank('tmp-a'), blank('tmp-b')); });
  st().goToSlide('tmp-b');
  st().commit((d) => { d.slides = d.slides.filter((s) => s.id !== 'tmp-b'); });
  assert.ok(exists() && st().currentSlideId !== 'tmp-b', 'commit: removed current slide repaired');
  console.log('PASS current slide stays valid after commit/live reconciliation');
} finally {
  await server.close();
}
