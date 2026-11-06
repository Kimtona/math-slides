/**
 * Convert to Editable Slide: progress, side-by-side preview (original sketch | converted slide), review list,
 * validation results, and Apply / Cancel. State and pipeline live in src/sketch/session.ts.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Slide } from '../model/types';
import { SLIDE_W } from '../model/types';
import { useStore } from '../store/store';
import { SlideView } from '../render/ElementView';
import { applySketch, closeSketch, editElement, MAX_REVIEW_ROUNDS, refreshStatus, runSketch, saveKey, saveSettings, useSketch } from '../sketch/session';
import { sketchNative } from '../sketch/bridge';
import type { IRElement, IRIssue } from '../sketch/ir';

const PREVIEW_W = 720;
const PREVIEW_SCALE = PREVIEW_W / SLIDE_W;
// requestAnimationFrame does not fire while the window is hidden or covered (macOS occlusion, background throttling):
// a timer fallback keeps the conversion from waiting until the user looks at the window again (layout is still
// computed synchronously when measured). Same approach as the export code.
const nextFrame = () => new Promise<void>((r) => {
  const done = () => { clearTimeout(t); r(); };
  const t = setTimeout(done, 100);
  requestAnimationFrame(done);
});

function SettingsForm() {
  const status = useSketch((s) => s.status);
  const error = useSketch((s) => s.error);
  const [provider, setProvider] = useState<'ollama' | 'anthropic'>(status?.provider === 'anthropic' ? 'anthropic' : 'ollama');
  const [ollamaModel, setOllamaModel] = useState(status?.ollama.model ?? 'qwen2.5vl:7b');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = (e: React.KeyboardEvent) => e.stopPropagation();
  const save = async () => {
    setBusy(true);
    if (provider === 'anthropic' && key.trim() && !(await saveKey(key.trim()))) { setBusy(false); return; }
    const st = await saveSettings({ provider, ollamaModel });
    setBusy(false);
    if (st?.ready) { setKey(''); runSketch(); }
  };
  const o = status?.ollama;
  return (
    <div className="sk-key">
      <label className="sk-check"><input type="radio" name="sk-prov" checked={provider === 'ollama'} disabled={status?.envLocked.provider} onChange={() => setProvider('ollama')} />
        <b>Local model (Ollama)</b> — free, runs on this computer; the image never leaves it.</label>
      {provider === 'ollama' && (
        <div className="sk-indent">
          <div className="sk-row">
            <span>Model</span>
            <input value={ollamaModel} disabled={status?.envLocked.ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} onKeyDown={stop} />
          </div>
          <p className="sk-muted">
            {o?.running ? `Ollama is running at ${o.host}. Installed: ${o.models.join(', ') || 'none'}.` : `Ollama is not reachable at ${o?.host}. Install it from ollama.com and start it.`}
            {o?.running && !o.models.includes(ollamaModel) && <> The model is not installed: run <code>ollama pull {ollamaModel}</code>.</>}
          </p>
        </div>
      )}
      <label className="sk-check"><input type="radio" name="sk-prov" checked={provider === 'anthropic'} disabled={status?.envLocked.provider} onChange={() => setProvider('anthropic')} />
        <b>Claude (Anthropic API)</b> — more accurate, paid; needs an API key.</label>
      {provider === 'anthropic' && (
        <div className="sk-indent">
          <input type="password" placeholder={status?.keySource ? `Key configured (${status.keySource}); enter a new one to replace it` : 'sk-ant-...'} value={key}
            onChange={(e) => setKey(e.target.value)} onKeyDown={stop} />
          <p className="sk-muted">
            Stored encrypted on this computer (OS keychain via Electron safeStorage) and used only by the app's main process.
            <code>ANTHROPIC_API_KEY</code> in the environment takes precedence.
            {!status?.canStore && ' Secure storage is not available here, so use the environment variable.'}
          </p>
          {status?.keySource === 'stored' && <button className="sk-btn" onClick={() => saveKey(null)}>Remove saved key</button>}
        </div>
      )}
      <div className="sk-row">
        <button className="sk-btn primary" disabled={busy || (provider === 'anthropic' && !key.trim() && !status?.keySource)} onClick={save}>Save and convert</button>
        <button className="sk-btn" disabled={busy} onClick={() => refreshStatus()}>Check again</button>
      </div>
      {error && <p className="sk-error">{error}</p>}
    </div>
  );
}

/** Seconds since the run started (local models take a minute or two). */
function Elapsed() {
  const startedAt = useSketch((s) => s.startedAt);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  return <>{Math.round((performance.now() - startedAt) / 1000)} s</>;
}

const sevClass = (s: IRIssue['severity']) => `sk-issue ${s}`;

function ReviewItem({ e }: { e: IRElement }) {
  const field = e.kind === 'math' ? 'latex' : 'text';
  const value = (e[field] ?? '') as string;
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const r = e.review;
  const commit = (v: string) => { if (v !== value) editElement(e.id, { [field]: v } as Partial<IRElement>); };
  return (
    <div className={`sk-item${r?.needed ? ' flagged' : ''}`}>
      <div className="sk-item-head"><b>{e.id}</b> · {e.kind}{r?.needed && <span className="sk-tag">needs review</span>}</div>
      {r?.needed && r.reason && <div className="sk-muted">{r.reason}</div>}
      {r?.needed && (r.transcribed || r.inferred) && (
        <div className="sk-choices">
          {r.transcribed && <button className={`sk-chip${value === r.transcribed ? ' on' : ''}`} title="What is literally written" onClick={() => commit(r.transcribed!)}>As written: <code>{r.transcribed}</code></button>}
          {r.inferred && <button className={`sk-chip${value === r.inferred ? ' on' : ''}`} title="The model's reading from context — not what is written" onClick={() => commit(r.inferred!)}>Inferred: <code>{r.inferred}</code></button>}
        </div>
      )}
      {e.kind === 'table'
        ? <div className="sk-muted">Table {e.table?.rows.length}×{e.table?.rows[0]?.length}: edit the cells after Apply (they are ordinary table cells).</div>
        : <textarea rows={field === 'latex' ? 2 : Math.min(4, value.split('\n').length)} value={draft} spellCheck={false}
            onChange={(ev) => setDraft(ev.target.value)} onBlur={() => commit(draft)} onKeyDown={(ev) => ev.stopPropagation()} />}
      {e.blocks && <div className="sk-muted">Formatted text: editing it here replaces its formatting; better edit it after Apply.</div>}
    </div>
  );
}

export function SketchDialog() {
  const phase = useSketch((s) => s.phase);
  const s = useSketch();
  const currentSlide = useStore((st) => st.deck.slides.find((x) => x.id === st.currentSlideId));
  const assets = useStore((st) => st.assets);
  const previewRef = useRef<HTMLDivElement>(null);
  const [capturing, setCapturing] = useState(false);

  // The pipeline asks the dialog for measured text heights and a screenshot of the rendered preview.
  useLayoutEffect(() => {
    useSketch.setState({
      measure: async () => {
        setCapturing(true);
        await nextFrame(); await nextFrame();
        const root = previewRef.current;
        const heights: Record<string, number> = {};
        root?.querySelectorAll<HTMLElement>('[data-el-id]').forEach((n) => { heights[n.dataset.elId!] = n.offsetHeight; });
        let shot = null;
        if (root) {
          const r = root.getBoundingClientRect();
          shot = await sketchNative()?.capture({ x: r.left, y: r.top, width: r.width, height: r.height }) ?? null;
        }
        setCapturing(false);
        return { heights, shot };
      },
    });
    return () => useSketch.setState({ measure: null });
  }, []);

  useEffect(() => {
    if (phase === 'idle') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); closeSketch(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  if (phase === 'idle' || !s.sourceId) return null;
  const busy = phase === 'recognizing' || phase === 'reviewing';
  // The result in place: the slide's other elements (unchanged) + the converted elements in the image's frame.
  // The AI-review screenshot shows the converted elements only.
  const previewSlide: Slide | null = s.conv && currentSlide
    ? { id: 'sketch-preview', background: currentSlide.background, elements: capturing ? s.conv.elements : [...s.others, ...s.conv.elements], notes: '' }
    : null;
  const issues = [...s.parseIssues, ...(s.report?.issues ?? [])].filter((i, k, all) => all.findIndex((j) => j.code === i.code && j.id === i.id && j.message === i.message) === k);
  const flaggedIds = new Set(issues.filter((i) => i.severity !== 'info' || i.code === 'review').map((i) => i.id).filter(Boolean) as string[]);
  const items = (s.ir?.elements ?? []).filter((e) => e.review?.needed || e.kind === 'math');
  const elBox = (id: string) => s.conv?.elements.find((x) => x.id === id);

  return (
    <div className="sk-backdrop" onMouseDown={(e) => e.stopPropagation()}>
      <div className="sk-dialog" role="dialog" aria-label="Convert to Editable Slide">
        <header className="sk-header">
          <b>Convert to Editable Slide</b>
          <span className="sk-muted">{s.model || s.status?.model}{s.status?.logging ? ' · run log on' : ''}</span>
          <span className="sk-spacer" />
          {phase !== 'settings' && <button className="sk-link" disabled={phase === 'recognizing' || phase === 'reviewing'} onClick={() => useSketch.setState({ phase: 'settings' })}>AI settings…</button>}
          <button className="sk-close" title="Cancel (Esc)" onClick={closeSketch}>×</button>
        </header>

        {phase === 'settings' ? <SettingsForm /> : (
          <div className="sk-body">
            <div className="sk-panes">
              <figure className="sk-pane">
                <figcaption>Original sketch</figcaption>
                <div className="sk-original">
                  {s.image && <img src={s.image.dataUrl} alt="" />}
                  {s.ir?.elements.filter((e) => flaggedIds.has(e.id)).map((e) => (
                    <div key={e.id} className="sk-hl" style={{ left: `${e.bbox.x / 10}%`, top: `${e.bbox.y / 10}%`, width: `${e.bbox.w / 10}%`, height: `${e.bbox.h / 10}%` }} title={e.id} />
                  ))}
                </div>
              </figure>
              <figure className="sk-pane">
                <figcaption>Editable result <span className="sk-muted">(on this slide; dashed = image area)</span> {busy && <span className="sk-muted">· {phase === 'recognizing' ? 'recognizing' : `AI review (≤${MAX_REVIEW_ROUNDS} rounds)`}… <Elapsed /></span>}</figcaption>
                <div className="sk-preview" style={{ width: PREVIEW_W, height: PREVIEW_W * 9 / 16 }}>
                  <div ref={previewRef} className="sk-preview-inner" style={{ width: PREVIEW_W, height: PREVIEW_W * 9 / 16 }}>
                    {previewSlide
                      ? <SlideView slide={previewSlide} assets={assets} index={0} total={1} className="sk-slide" />
                      : <div className="sk-wait">{phase === 'error' ? '' : 'Reading the sketch…'}</div>}
                  </div>
                  {!capturing && s.frame && <div className="sk-frame" title="Area of the original image" style={{ left: s.frame.x * PREVIEW_SCALE, top: s.frame.y * PREVIEW_SCALE, width: s.frame.w * PREVIEW_SCALE, height: s.frame.h * PREVIEW_SCALE }} />}
                  {!capturing && s.conv && Object.entries(s.conv.map).filter(([irId]) => flaggedIds.has(irId)).flatMap(([irId, ids]) => ids.map((id) => {
                    const b = elBox(id);
                    if (!b) return null;
                    return <div key={irId + id} className="sk-hl" title={irId} style={{ left: b.x * PREVIEW_SCALE, top: b.y * PREVIEW_SCALE, width: b.w * PREVIEW_SCALE, height: b.h * PREVIEW_SCALE }} />;
                  }))}
                </div>
              </figure>
            </div>

            <div className="sk-side">
              {phase === 'error' && <p className="sk-error">{s.error}</p>}
              {items.length > 0 && <section><h4>Check these</h4>{items.map((e) => <ReviewItem key={e.id} e={e} />)}</section>}
              {s.rounds.length > 0 && (
                <section><h4>AI review</h4>
                  {s.rounds.map((r) => (
                    <div key={r.round} className="sk-round">
                      Round {r.round}: {r.error ? <span className="sk-error">{r.error}</span> : r.skipped ? 'not needed' : r.ok ? 'no problems found' : `${r.patches.length} fix(es) applied`}
                      {r.summary && <div className="sk-muted">{r.summary}</div>}
                      {r.patches.map((p, i) => <div key={i} className="sk-muted">· {p.op} {p.id}: {p.reason}</div>)}
                    </div>
                  ))}
                </section>
              )}
              <section><h4>Checks</h4>
                {s.report ? (issues.length ? issues.map((i, k) => <div key={k} className={sevClass(i.severity)}>{i.id && <b>{i.id}</b>} [{i.code}] {i.message}</div>)
                  : <div className="sk-muted">No problems found.</div>) : <div className="sk-muted">—</div>}
              </section>
              {s.timings.total ? <div className="sk-muted" title={Object.entries(s.timings).map(([k, v]) => `${k}: ${(v / 1000).toFixed(1)} s`).join('\n')}>Time: {(s.timings.total / 1000).toFixed(1)} s (recognition {((s.timings.recognize ?? 0) / 1000).toFixed(1)} s{s.rounds.some((r) => !r.skipped) ? `, AI review ${(s.rounds.reduce((a, r) => a + r.ms, 0) / 1000).toFixed(1)} s` : ''}, other steps {(((s.timings.total ?? 0) - (s.timings.recognizeWall ?? 0) - Object.entries(s.timings).filter(([k]) => /^reviewWall/.test(k)).reduce((a, [, v]) => a + v, 0)) / 1000).toFixed(1)} s)</div> : null}
            </div>
          </div>
        )}

        {phase !== 'settings' && (
          <footer className="sk-footer">
            <label className="sk-check"><input type="checkbox" checked={s.aiReview} disabled={busy} onChange={(e) => useSketch.setState({ aiReview: e.target.checked })} /> AI review</label>
            <button className="sk-btn" disabled={busy} onClick={runSketch}>{phase === 'error' ? 'Try again' : 'Run again'}</button>
            <span className="sk-spacer" />
            <button className="sk-btn" onClick={closeSketch}>Cancel</button>
            <button className="sk-btn" disabled={busy || !s.conv} title="Add the elements and keep the image" onClick={() => applySketch(false)}>Apply, keep image</button>
            <button className="sk-btn primary" disabled={busy || !s.conv} title="Replace the image with the elements (⌘Z restores it)" onClick={() => applySketch(true)}>Apply</button>
          </footer>
        )}
      </div>
    </div>
  );
}
