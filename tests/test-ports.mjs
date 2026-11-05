/**
 * Port and process handling for the Electron GUI tests, so several test runs (e.g. two Claude Code sessions, or
 * `npm test` next to a single test) can run at the same time without colliding.
 *
 * - The Vite dev server listens on port 0: the OS assigns a free port atomically at bind time, and the test reads the
 *   port the server actually bound (no "find a free port, close it, then hope it is still free" race).
 * - Electron is started with --remote-debugging-port=0: Chromium binds a free port itself and prints
 *   "DevTools listening on ws://127.0.0.1:<port>/…" on stderr; the test reads that line.
 * - Electron runs in its own process group and is stopped as a group (SIGTERM, then SIGKILL after a timeout); the
 *   group and the Vite server are also cleaned up when the test exits, throws, or is interrupted.
 */
import { spawn } from 'node:child_process';

/** Starts a Vite server (createServer from 'vite') on an OS-assigned port. Returns the server, its port and URL. */
export async function startViteServer(createServer, config) {
  const server = await createServer({ ...config, server: { ...(config.server ?? {}), host: '127.0.0.1', port: 0, strictPort: true } });
  await server.listen();
  const port = server.httpServer.address().port;
  track(() => server.close());
  return { server, port, url: `http://127.0.0.1:${port}` };
}

/**
 * Spawns Electron with --remote-debugging-port=0 in its own process group and resolves once Chromium reports the
 * DevTools port it bound. `args` must not contain another --remote-debugging-port. Returns { child, debugPort }.
 */
export async function launchElectron(electronPath, args, options = {}, timeoutMs = 30000) {
  const child = spawn(electronPath, [...args, '--remote-debugging-port=0'], { stdio: ['ignore', 'pipe', 'pipe'], ...options, detached: true });
  children.add(child);
  child.once('exit', () => children.delete(child));
  child.stdout?.on('data', () => {});
  let buf = '';
  const debugPort = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stopElectronSync(child); reject(new Error('Electron did not report its DevTools port:\n' + buf.slice(-2000))); }, timeoutMs);
    const onData = (d) => {
      if (buf.length < 100000) buf += d;
      const m = /DevTools listening on ws:\/\/[^:\s]+:(\d+)\//.exec(buf);
      if (m) { clearTimeout(timer); resolve(Number(m[1])); }
    };
    child.stderr.on('data', onData);
    child.once('exit', (code, signal) => { clearTimeout(timer); reject(new Error(`Electron exited before reporting its DevTools port (${code ?? signal}):\n` + buf.slice(-2000))); });
  });
  return { child, debugPort };
}

/** Stops Electron and its helper processes (whole process group); resolves when the main process has exited. */
export async function stopElectron(child, timeoutMs = 8000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  killGroup(child, 'SIGTERM');
  const timer = setTimeout(() => killGroup(child, 'SIGKILL'), timeoutMs);
  await exited;
  clearTimeout(timer);
  killGroup(child, 'SIGKILL'); // helpers that outlived the main process
}

function killGroup(child, signal) {
  try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} }
}
function stopElectronSync(child) {
  if (child && child.exitCode === null && child.signalCode === null) killGroup(child, 'SIGKILL');
}

// ---------- cleanup on any exit ----------
const children = new Set();
const closers = new Set();
const track = (fn) => closers.add(fn);
let installed = false;
function install() {
  if (installed) return;
  installed = true;
  // Normal exit / uncaught error: kill what is left (synchronous only at 'exit').
  process.on('exit', () => { for (const c of children) stopElectronSync(c); });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, async () => {
      for (const c of children) stopElectronSync(c);
      await Promise.allSettled([...closers].map((f) => f()));
      process.exit(130);
    });
  }
}
install();
