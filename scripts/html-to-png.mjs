#!/usr/bin/env node
/**
 * Renders a local HTML file (under the project root) to a PNG with the app's Chromium: used to make reproducible,
 * synthetic "screenshot of formatted text" test inputs for Sketch-to-Slides (examples/sketches/formatted-notes.html).
 *   node scripts/html-to-png.mjs examples/sketches/formatted-notes.html out.png [deviceScaleFactor=2]
 */
import { writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createServer } from 'vite';
import { launchElectron, startViteServer, stopElectron } from '../tests/test-ports.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [html, out, scaleArg] = process.argv.slice(2);
if (!html || !out) { console.error('usage: node scripts/html-to-png.mjs <file.html under the project> <out.png> [scale]'); process.exit(2); }
const profile = await mkdtemp(path.join(tmpdir(), 'mathslides-html2png-'));
const { server, url } = await startViteServer(createServer, { root, configLoader: 'runner', cacheDir: path.join(profile, 'vite'), logLevel: 'error' });
const wrapper = path.join(profile, 'main.cjs');
await (await import('node:fs/promises')).writeFile(wrapper, `const { app } = require('electron'); app.setPath('userData', ${JSON.stringify(profile)}); require(${JSON.stringify(path.join(root, 'electron/main.cjs'))});\n`);
const { child, debugPort } = await launchElectron(require('electron'), [wrapper], { cwd: root, env: { ...process.env, MATHSLIDES_TEST_HIDDEN: '1', ELECTRON_DEV_URL: url } });
let ws, id = 0; const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => { const k = ++id; pending.set(k, { res, rej }); ws.send(JSON.stringify({ id: k, method, params })); });
try {
  let target;
  for (let i = 0; i < 100 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json()).find((t) => t.type === 'page'); } catch {} await new Promise((r) => setTimeout(r, 200)); }
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => { const d = JSON.parse(e.data); const p = pending.get(d.id); if (p) { pending.delete(d.id); d.error ? p.rej(Error(d.error.message)) : p.res(d.result); } });
  await send('Page.enable');
  await send('Page.navigate', { url: `${url}/${html}` });
  await new Promise((r) => setTimeout(r, 1500));
  const scale = Number(scaleArg ?? 2);
  const { result } = await send('Runtime.evaluate', { expression: 'JSON.stringify([Math.ceil(document.body.getBoundingClientRect().width), Math.ceil(document.body.getBoundingClientRect().height)])', returnByValue: true });
  const [w, h] = JSON.parse(result.value);
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: scale, mobile: false });
  await new Promise((r) => setTimeout(r, 400));
  const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: w, height: h, scale: 1 } });
  await writeFile(out, Buffer.from(shot.data, 'base64'));
  console.log(`→ ${path.resolve(out)} (${w}×${h} css px, ×${scale})`);
} finally { ws?.close(); await stopElectron(child); await server.close(); }
