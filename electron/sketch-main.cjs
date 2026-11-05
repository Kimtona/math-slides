// Sketch-to-Slides: Electron main-process side (API key storage, model calls over IPC, optional run logging).
// The renderer never sees the API key: it only learns whether one is configured and where it comes from.
const { app, ipcMain, safeStorage, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');
const { recognize, review, DEFAULT_MODEL } = require('./sketch-ai.cjs');

const keyFile = () => path.join(app.getPath('userData'), 'ai-key.bin');

/** Where the key comes from: the environment wins, then the encrypted key saved from the settings dialog. */
function keySource() {
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
const model = () => process.env.MATHSLIDES_SKETCH_MODEL || DEFAULT_MODEL;

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
  ipcMain.handle('sketch:status', () => ({
    keySource: keySource(),
    canStore: safeStorage.isEncryptionAvailable(),
    model: model(),
    logging: !!logRoot,
  }));

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
    const apiKey = readKey();
    if (!apiKey) return { ok: false, error: 'No API key configured.', code: 'no-key' };
    if (!validImage(image)) return { ok: false, error: 'Invalid image.', code: 'image' };
    log(runId, '00-input.png', png(image.base64));
    try {
      const r = await recognize({ apiKey, model: model(), image, schema });
      log(runId, '01-recognize.json', { model: r.model, ms: r.ms, usage: r.usage, stopReason: r.stopReason, image: { width: image.width, height: image.height }, output: r.data });
      return { ok: true, data: r.data, model: r.model, ms: r.ms, usage: r.usage };
    } catch (e) {
      log(runId, '01-recognize-error.json', errorResult(e));
      return errorResult(e);
    }
  });

  ipcMain.handle('sketch:review', async (_e, { runId, round, original, rendering, ir, issues, schema }) => {
    const apiKey = readKey();
    if (!apiKey) return { ok: false, error: 'No API key configured.', code: 'no-key' };
    if (!validImage(original) || !validImage(rendering)) return { ok: false, error: 'Invalid image.', code: 'image' };
    log(runId, `1${round}-rendering.png`, png(rendering.base64));
    try {
      const r = await review({ apiKey, model: model(), original, rendering, ir, issues, schema });
      log(runId, `1${round}-review.json`, { model: r.model, ms: r.ms, usage: r.usage, ir, issues, output: r.data });
      return { ok: true, data: r.data, model: r.model, ms: r.ms, usage: r.usage };
    } catch (e) {
      log(runId, `1${round}-review-error.json`, errorResult(e));
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
