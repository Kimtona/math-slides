#!/usr/bin/env node
/**
 * Renders the first slide of a .mslides file to a PNG with the real app renderer (Electron, disposable profile,
 * hidden window). Used to look at Sketch-to-Slides results outside the GUI.
 *   node scripts/render-mslides.mjs <file.mslides> <out.png>
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createServer as netServer } from 'node:net';
import { createRequire } from 'node:module';
import { createServer } from 'vite';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [input, output] = process.argv.slice(2);
if (!input || !output) { console.error('usage: node scripts/render-mslides.mjs <file.mslides> <out.png>'); process.exit(2); }
const text = await readFile(input, 'utf8');
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-render-'));
const free = async () => { const s = netServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p; };
const debugPort = await free(), vitePort = await free();
const server = await createServer({ root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error', server: { host: '127.0.0.1', port: vitePort, strictPort: true } });
await server.listen();
const wrapper = path.join(profile, 'main.cjs');
await writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);
const electron = spawn(require('electron'), [wrapper, `--remote-debugging-port=${debugPort}`], {
  cwd: root, stdio: 'ignore', env: { ...process.env, MATHSLIDES_TEST_HIDDEN: '1', ELECTRON_DEV_URL: `http://127.0.0.1:${vitePort}` },
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
let socket, id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((resolve, reject) => { const k = ++id; pending.set(k, { resolve, reject }); socket.send(JSON.stringify({ id: k, method, params })); });
const evaluate = async (expression) => { const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
async function until(fn, msg, timeout = 30000) { const t = Date.now(); while (Date.now() - t < timeout) { try { const v = await fn(); if (v) return v; } catch {} await pause(150); } throw new Error(msg); }
try {
  const target = await until(async () => (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'), 'debug target');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.reject(Error(d.error.message)) : p.resolve(d.result); } });
  await send('Runtime.enable');
  await until(() => evaluate(`!!document.querySelector('.propsbar')`), 'app mount');
  await evaluate(`import('/src/store/persistence.ts').then((m) => m.openFromText(${JSON.stringify(text)}, null))`);
  await evaluate(`(async () => { const { useStore } = await import('/src/store/store.ts'); useStore.setState({ currentSlideId: useStore.getState().deck.slides[0].id, selection: [] }); })()`);
  await pause(800);
  // Render the slide alone at 1280×720 on top of everything, then screenshot that region.
  const rect = await evaluate(`(() => {
    const src = document.querySelector('.stage .slide');
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;left:0;top:0;width:1280px;height:720px;z-index:99999;background:#fff;overflow:hidden';
    const copy = src.cloneNode(true); copy.style.transform = 'none'; copy.classList.remove('editable');
    copy.querySelectorAll('[data-placeholder]').forEach((n) => n.removeAttribute('data-placeholder')); // editor-only hints
    box.appendChild(copy); document.body.appendChild(box);
    return { x: 0, y: 0, width: 1280, height: 720 };
  })()`);
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await pause(500);
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { ...rect, scale: 1 } });
  await writeFile(output, Buffer.from(shot.data, 'base64'));
  console.log(`→ ${path.resolve(output)}`);
} finally {
  socket?.close();
  electron.kill('SIGTERM');
  await server.close();
}
