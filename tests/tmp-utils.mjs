/** Temporary folders of a test process: created through makeTempDir(), removed again when the process ends.
 *
 * Only paths this process created itself (and therefore tracks) are ever deleted — never a pattern such as
 * `$TMPDIR/mathslides-*`, so other tests, other worktrees and running processes are untouched. Before each delete the path
 * is re-checked: a real directory (not a symlink) owned by this user, directly inside the system temp dir, named mathslides-*.
 *
 * - Normal end, failed assertion, uncaught error: removed on process exit (an uncaught error is printed first, exit code 1).
 * - SIGINT / SIGTERM: this process's direct child processes (the Electron app) are stopped, then the folders are removed.
 * - MATHSLIDES_KEEP_TMP=1: nothing is removed and every kept path is printed (to debug a failure).
 * - A directory given by the user (e.g. MATHSLIDES_TEST_OUTPUT) is not created here, so it is never tracked or removed.
 * - SIGKILL, a crash of the machine or an out-of-memory kill cannot run any code: those folders stay behind (see docs/DEVELOPMENT.md).
 */
import { mkdtempSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const NAME = /^mathslides-[a-z0-9-]+-?[A-Za-z0-9]{6}$/;
const tracked = new Set();
const keep = () => process.env.MATHSLIDES_KEEP_TMP === '1';

/** True only for a folder this module may delete (see the header). */
export function isSafeTempDir(dir) {
  try {
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) return false;
    const st = lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return false;
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if (!NAME.test(path.basename(dir))) return false;
    return realpathSync(path.dirname(dir)) === realpathSync(tmpdir());
  } catch { return false; }
}

/** mkdtemp under the system temp dir, tracked for removal when this process ends. `prefix` must start with "mathslides-". */
export function makeTempDir(prefix) {
  if (!/^mathslides-[a-z0-9-]+-$/.test(prefix)) throw new Error(`Temp folder prefix must look like "mathslides-name-": ${prefix}`);
  const dir = mkdtempSync(path.join(realpathSync(tmpdir()), prefix));
  tracked.add(dir);
  return dir;
}

/** Paths that stay after this process (MATHSLIDES_KEEP_TMP=1) or that were supplied by the user: worth printing as OUTPUT. */
export const printOutput = (dir) => { if (!tracked.has(dir) || keep()) console.log('OUTPUT', dir); };

let cleaned = false;
function cleanup(code) {
  if (cleaned) return;
  cleaned = true;
  if (!tracked.size) return;
  if (keep()) {
    console.error(`MATHSLIDES_KEEP_TMP=1: kept ${tracked.size} temp folder(s):\n${[...tracked].map((d) => '  ' + d).join('\n')}`);
    return;
  }
  for (const dir of tracked) {
    if (!isSafeTempDir(dir)) { console.error('Not removing (failed the safety check):', dir); continue; }
    try { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
    catch (e) { console.error('Could not remove', dir, String(e?.message ?? e)); }
  }
  if (code) console.error(`The test failed (exit code ${code}); its temp folders were removed. Re-run with MATHSLIDES_KEEP_TMP=1 to keep them (profile, screenshots, PDF/PPTX) for debugging.`);
}

process.on('exit', (code) => cleanup(code));
// Node prints an uncaught error only AFTER the exit hooks ran: print it first so the failure is visible before the folders go.
process.on('uncaughtException', (error) => { console.error(error); process.exit(1); });
for (const [sig, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  process.on(sig, () => {
    // Another listener (e.g. rich-text --interactive waits for Ctrl-C and then shuts down itself): let it finish, the exit hook cleans.
    if (process.listenerCount(sig) > 1) return;
    // Stop only our own children (the Electron app) so nothing writes into the folders while they are removed.
    spawnSync('pkill', ['-TERM', '-P', String(process.pid)], { stdio: 'ignore' });
    cleanup(0);
    process.exit(code);
  });
}
