// Sketch-to-Slides: Electron main-process side (provider settings, API key storage, model calls over IPC, run logging).
// Providers: 'ollama' (default; local server, no key, no cost) and 'anthropic' (Claude API, optional).
// The renderer never sees the API key: it only learns whether one is configured and where it comes from.
const { app, ipcMain, safeStorage, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { recognize, review, DEFAULT_MODEL } = require('./sketch-ai.cjs');
const { ollamaStatus, LOCAL_IMAGE_PIXELS, DEFAULT_OLLAMA_HOST, DEFAULT_OLLAMA_MODEL } = require('./sketch-ollama.cjs');

// Automated tests only: MATHSLIDES_SKETCH_FAKE=<IR json> answers recognition with that file (no network, no key)
// and the review with "no problems". The dialog shows the model as "fake" so it can never be mistaken for a real run.
const FAKE = process.env.MATHSLIDES_SKETCH_FAKE ? path.resolve(process.env.MATHSLIDES_SKETCH_FAKE) : null;

const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

/** Where the key comes from: the environment wins, then the encrypted key saved from the settings dialog. */
function keySource() {
  if (FAKE) return 'fake';
  if (process.env.ANTHROPIC_API_KEY) return 'env';
  return fs.existsSync(keyFile()) ? 'stored' : null;
}
function readKey() {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    return safeStorage.decryptString(fs.readFileSync(keyFile()));
  } catch {
    return null;
  }
}
// ---------- provider settings: userData/ai-settings.json, overridden by environment variables ----------
const settingsFile = () => path.join(app.getPath('userData'), 'ai-settings.json');
function savedSettings() {
  try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')); } catch { return {}; }
}
function settings() {
  const s = savedSettings();
  const provider = process.env.MATHSLIDES_SKETCH_PROVIDER || (s.provider === 'anthropic' ? 'anthropic' : 'ollama');
  return {
    provider,
    ollamaHost: process.env.OLLAMA_HOST ? (/^https?:/.test(process.env.OLLAMA_HOST) ? process.env.OLLAMA_HOST : `http://${process.env.OLLAMA_HOST}`) : s.ollamaHost || DEFAULT_OLLAMA_HOST,
    ollamaModel: process.env.MATHSLIDES_OLLAMA_MODEL || s.ollamaModel || DEFAULT_OLLAMA_MODEL,
    anthropicModel: process.env.MATHSLIDES_SKETCH_MODEL || DEFAULT_MODEL,
  };
}
function model() {
  if (FAKE) return 'fake (test fixture)';
  const s = settings();
  return s.provider === 'ollama' ? `ollama/${s.ollamaModel}` : s.anthropicModel;
}
/** Arguments for sketch-ai.cjs for the current provider (or an error result). */
function providerArgs() {
  const s = settings();
  if (s.provider === 'ollama') return { provider: 'ollama', host: s.ollamaHost, model: s.ollamaModel };
  const apiKey = readKey();
  if (!apiKey) return { error: { ok: false, error: 'No API key configured.', code: 'no-key' } };
  return { provider: 'anthropic', apiKey, model: s.anthropicModel };
}

// ---------- optional run log (MATHSLIDES_SKETCH_LOG=<dir>): every request/response/report of a conversion ----------
const logRoot = process.env.MATHSLIDES_SKETCH_LOG ? path.resolve(process.env.MATHSLIDES_SKETCH_LOG) : null;
function log(runId, name, data) {
  if (!logRoot || typeof runId !== 'string' || !/^[\w-]{1,64}$/.test(runId) || !/^[\w.-]{1,80}$/.test(name)) return;
  try {
    const dir = path.join(logRoot, runId);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (Buffer.isBuffer(data)) fs.writeFileSync(file, data);
    else fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('sketch log failed', e);
  }
}
const png = (b64) => Buffer.from(b64, 'base64');

const MAX_IMAGE_B64 = 7 * 1024 * 1024; // the renderer downsizes; this only guards against abuse
const validImage = (img) =>
  img && typeof img.base64 === 'string' && img.base64.length < MAX_IMAGE_B64 && /^image\/(png|jpeg|webp|gif)$/.test(img.mime) &&
  Number.isFinite(img.width) && Number.isFinite(img.height);

function errorResult(e) {
  return { ok: false, error: String(e?.message || e), code: e?.code || 'unknown' };
}

function registerSketchIPC() {
  ipcMain.handle('sketch:status', async () => {
    const s = settings();
    const ollama = FAKE ? { running: true, models: [] } : s.provider === 'ollama' ? await ollamaStatus(s.ollamaHost) : null;
    return {
      provider: FAKE ? 'fake' : s.provider,
      ready: FAKE || (s.provider === 'ollama' ? !!ollama?.running && ollama.models.includes(s.ollamaModel) : !!keySource()),
      keySource: keySource(),
      canStore: safeStorage.isEncryptionAvailable(),
      model: model(),
      ollama: { host: s.ollamaHost, model: s.ollamaModel, running: !!ollama?.running, models: ollama?.models ?? [] },
      // Image size the provider works best with (renderer resizes before sending).
      image: s.provider === 'ollama' && !FAKE ? { pixels: LOCAL_IMAGE_PIXELS } : { maxEdge: 1600 },
      envLocked: { provider: !!process.env.MATHSLIDES_SKETCH_PROVIDER, ollamaModel: !!process.env.MATHSLIDES_OLLAMA_MODEL, ollamaHost: !!process.env.OLLAMA_HOST },
      logging: !!logRoot,
    };
  });

  ipcMain.handle('sketch:set-settings', (_e, next) => {
    try {
      const cur = savedSettings();
      const out = { ...cur };
      if (next?.provider === 'ollama' || next?.provider === 'anthropic') out.provider = next.provider;
      if (typeof next?.ollamaModel === 'string' && /^[\w.:/-]{1,100}$/.test(next.ollamaModel.trim())) out.ollamaModel = next.ollamaModel.trim();
      if (typeof next?.ollamaHost === 'string' && /^https?:\/\/[\w.:-]+\/?$/.test(next.ollamaHost.trim())) out.ollamaHost = next.ollamaHost.trim().replace(/\/$/, '');
      fs.writeFileSync(settingsFile(), JSON.stringify(out, null, 2));
      return { ok: true };
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('sketch:set-key', (_e, key) => {
    try {
      if (key === null) {
        fs.rmSync(keyFile(), { force: true });
        return { ok: true };
      }
      if (typeof key !== 'string' || !key.trim() || key.length > 400) return { ok: false, error: 'Invalid key.' };
      if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: 'Secure storage is not available on this system. Set ANTHROPIC_API_KEY instead.' };
      fs.writeFileSync(keyFile(), safeStorage.encryptString(key.trim()), { mode: 0o600 });
      return { ok: true };
    } catch (e) {
      return errorResult(e);
    }
  });

  ipcMain.handle('sketch:recognize', async (_e, { runId, image, schema }) => {
    if (!validImage(image)) return { ok: false, error: 'Invalid image.', code: 'image' };
    log(runId, '00-input.png', png(image.base64));
    if (FAKE) {
      const fake = JSON.parse(fs.readFileSync(FAKE, 'utf8'));
      // A recorded local-model output is replayed through the real local-format conversion.
      const { elements, notes } = fake.localOutput
        ? require('./sketch-local.cjs').localToModelIR(fake.localOutput, fake.sentImage.width, fake.sentImage.height)
        : fake;
      log(runId, '01-recognize.json', { model: model(), output: { elements, notes } });
      return { ok: true, data: { elements, notes }, model: model(), ms: 0 };
    }
    const args = providerArgs();
    if (args.error) return args.error;
    try {
      const r = await recognize({ ...args, image, schema });
      log(runId, '01-recognize.json', { provider: args.provider, model: r.model, ms: r.ms, usage: r.usage, stopReason: r.stopReason, image: { width: image.width, height: image.height }, ...(r.raw !== undefined ? { rawText: r.raw } : {}), ...(r.local ? { localOutput: r.local } : {}), output: r.data });
      return { ok: true, data: r.data, model: r.model, ms: r.ms, usage: r.usage };
    } catch (e) {
      log(runId, '01-recognize-error.json', { ...errorResult(e), rawText: e?.raw, usage: e?.usage });
      return errorResult(e);
    }
  });

  ipcMain.handle('sketch:review', async (_e, { runId, round, original, rendering, ir, issues, schema }) => {
    if (FAKE) {
      if (validImage(rendering)) log(runId, `1${round}-rendering.png`, png(rendering.base64));
      return { ok: true, data: { ok: true, summary: 'fake review (test fixture)', patches: [] }, model: model(), ms: 0 };
    }
    const args = providerArgs();
    if (args.error) return args.error;
    if (!validImage(original) || !validImage(rendering)) return { ok: false, error: 'Invalid image.', code: 'image' };
    log(runId, `1${round}-rendering.png`, png(rendering.base64));
    try {
      const r = await review({ ...args, original, rendering, ir, issues, schema });
      log(runId, `1${round}-review.json`, { provider: args.provider, model: r.model, ms: r.ms, usage: r.usage, ir, issues, ...(r.raw !== undefined ? { rawText: r.raw } : {}), output: r.data });
      return { ok: true, data: r.data, model: r.model, ms: r.ms, usage: r.usage };
    } catch (e) {
      log(runId, `1${round}-review-error.json`, { ...errorResult(e), rawText: e?.raw, usage: e?.usage });
      return errorResult(e);
    }
  });

  // Screenshot of a region of the window (the rendered preview), for the AI review. Returns PNG base64.
  ipcMain.handle('sketch:capture', async (event, rect) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || !rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) return null;
    const r = { x: Math.max(0, Math.round(rect.x)), y: Math.max(0, Math.round(rect.y)), width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)) };
    const img = await event.sender.capturePage(r);
    return { base64: img.toPNG().toString('base64'), mime: 'image/png', width: img.getSize().width, height: img.getSize().height };
  });

  ipcMain.handle('sketch:log', (_e, runId, name, data) => {
    log(runId, name, data);
    return !!logRoot;
  });
}

module.exports = { registerSketchIPC };
