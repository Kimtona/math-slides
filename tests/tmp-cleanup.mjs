/** Temp-folder policy of the test suite (tests/tmp-utils.mjs): own folders are removed when a test process ends, however it ends.
 * Every scenario runs in a child process whose TMPDIR is a private sandbox, so the real temp dir is never touched.
 * Run: node tests/tmp-cleanup.mjs   (no Electron, a few seconds)
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { makeTempDir } from './tmp-utils.mjs';

const UTIL = new URL('./tmp-utils.mjs', import.meta.url).href;
const sandbox = makeTempDir('mathslides-tmpcleanup-');          // removed by this process's own exit hook
const decoy = fs.mkdtempSync(path.join(sandbox, 'mathslides-decoy-'));    // looks like a test folder, but no child created it
fs.writeFileSync(path.join(decoy, 'keep.txt'), 'someone else\'s');
const victim = path.join(sandbox, 'victim'); fs.mkdirSync(victim); fs.writeFileSync(path.join(victim, 'precious.txt'), 'data');

const CHILD = `
import { makeTempDir, printOutput, isSafeTempDir } from ${JSON.stringify(UTIL)};
import fs from 'node:fs'; import path from 'node:path'; import { spawn } from 'node:child_process';
const S = process.env.SCENARIO;
const mk = (p) => { const d = makeTempDir(p); fs.mkdirSync(path.join(d, 'sub'), { recursive: true }); fs.writeFileSync(path.join(d, 'sub', 'f.txt'), 'x'); return d; };
const say = (o) => console.log('JSON ' + JSON.stringify(o));
if (S === 'ok') say({ dirs: [mk('mathslides-a-'), mk('mathslides-b-')] });
else if (S === 'throw') { say({ dirs: [mk('mathslides-a-')] }); throw new Error('boom-uncaught'); }
else if (S === 'exitcode') { say({ dirs: [mk('mathslides-a-')] }); console.error('assertion text printed by the test'); process.exitCode = 1; }
else if (S === 'assert') { say({ dirs: [mk('mathslides-a-')] }); (await import('node:assert/strict')).default.equal(1, 2); }
else if (S === 'reject') { say({ dirs: [mk('mathslides-a-')] }); await Promise.reject(new Error('boom-rejected')); }
else if (S === 'output') { const d = mk('mathslides-a-'); say({ dirs: [d] }); printOutput(process.env.OUT); printOutput(d); }
else if (S === 'swap') { const d = mk('mathslides-a-'); fs.rmSync(d, { recursive: true }); fs.symlinkSync(process.env.VICTIM, d); say({ dirs: [d] }); }
else if (S === 'badprefix') { let r = []; for (const p of ['x-', 'mathslides-', '../mathslides-a-', 'mathslides-A-']) { try { makeTempDir(p); r.push('created ' + p); } catch { r.push('refused'); } } say({ r }); }
else if (S === 'unit') {
  const d = mk('mathslides-unit-'); const tmp = path.dirname(d);
  const link = path.join(tmp, 'mathslides-link-abcdef'); fs.symlinkSync(process.env.VICTIM, link);
  const file = path.join(tmp, 'mathslides-file-abcdef'); fs.writeFileSync(file, 'x');
  const badname = path.join(tmp, 'other-abcdef'); fs.mkdirSync(badname);
  const nested = path.join(d, 'mathslides-nested-abcdef'); fs.mkdirSync(nested);
  say({ ok: isSafeTempDir(d), tmpItself: isSafeTempDir(tmp), symlink: isSafeTempDir(link), file: isSafeTempDir(file), badName: isSafeTempDir(badname), nested: isSafeTempDir(nested),
        outside: isSafeTempDir('/usr'), relative: isSafeTempDir('mathslides-unit-abcdef'), missing: isSafeTempDir(path.join(tmp, 'mathslides-nope-abcdef')), nonString: isSafeTempDir(undefined) });
  fs.unlinkSync(link); fs.unlinkSync(file); fs.rmSync(badname, { recursive: true });
}
else if (S === 'hold' || S === 'hold-child') {
  const d = mk('mathslides-a-');
  const kid = S === 'hold-child' ? spawn('sleep', ['120'], { stdio: 'ignore' }) : null;   // stands in for the Electron app
  say({ dirs: [d], kid: kid?.pid, ready: true });
  process.stdin.on('data', (b) => { if (String(b).includes('go')) process.exit(0); });
  setInterval(() => {}, 1000);
}
`;

const baseEnv = () => { const e = { ...process.env, TMPDIR: sandbox + '/' }; delete e.MATHSLIDES_KEEP_TMP; return e; };
const json = (out) => JSON.parse(out.split('\n').find((l) => l.startsWith('JSON ')).slice(5));
const run = (scenario, env = {}) => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...baseEnv(), SCENARIO: scenario, ...env }, encoding: 'utf8' });
  return { ...r, info: r.stdout.includes('JSON ') ? json(r.stdout) : null };
};
function hold(scenario, env = {}) {
  const p = spawn(process.execPath, ['--input-type=module', '-e', CHILD], { env: { ...baseEnv(), SCENARIO: scenario, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '', err = '';
  p.stderr.on('data', (b) => { err += b; });
  const ready = new Promise((res, rej) => { p.stdout.on('data', (b) => { out += b; if (out.includes('"ready":true')) res(json(out)); }); p.once('exit', () => rej(new Error('exited before ready: ' + err))); });
  const exited = new Promise((res) => p.once('exit', (code, signal) => res({ code, signal, err: () => err })));
  return { p, ready, exited, go: () => p.stdin.write('go\n') };
}
const exists = (p) => fs.existsSync(p);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const until = async (fn, msg, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return; await new Promise((r) => setTimeout(r, 50)); } throw new Error(msg); };
const untouched = () => { assert.ok(exists(path.join(decoy, 'keep.txt')), 'a folder no child created is never touched'); assert.ok(exists(path.join(victim, 'precious.txt'))); };
const sandboxLeft = () => fs.readdirSync(sandbox).filter((n) => n !== path.basename(decoy) && n !== 'victim');

try {
  // 1. normal end
  let r = run('ok');
  assert.equal(r.status, 0); assert.equal(r.info.dirs.length, 2);
  r.info.dirs.forEach((d) => { assert.ok(d.startsWith(fs.realpathSync(sandbox)), 'created inside the (sandboxed) temp dir'); assert.ok(!exists(d), 'removed after a normal exit: ' + d); });
  assert.deepEqual(sandboxLeft(), []); untouched();
  console.log('PASS normal exit removes the folders a test created (with their contents)');

  // 2. failures: the error is printed first, then the folders go
  for (const [sc, text] of [['throw', 'boom-uncaught'], ['assert', 'AssertionError'], ['reject', 'boom-rejected'], ['exitcode', 'assertion text printed by the test']]) {
    r = run(sc);
    assert.notEqual(r.status, 0, sc);
    const iErr = r.stderr.indexOf(text), iHint = r.stderr.indexOf('temp folders were removed');
    assert.ok(iErr >= 0 && iHint > iErr, `${sc}: the failure is printed before the cleanup note`);
    assert.match(r.stderr, /MATHSLIDES_KEEP_TMP=1/, `${sc}: tells how to keep the folders`);
    r.info.dirs.forEach((d) => assert.ok(!exists(d), `${sc}: removed after a failure`));
    assert.deepEqual(sandboxLeft(), []); untouched();
  }
  console.log('PASS failures (uncaught error, failed assertion, rejection, exit code 1): message first, then cleanup');

  // 3. MATHSLIDES_KEEP_TMP=1
  r = run('ok', { MATHSLIDES_KEEP_TMP: '1' });
  assert.equal(r.status, 0);
  r.info.dirs.forEach((d) => { assert.ok(exists(path.join(d, 'sub', 'f.txt')), 'kept with contents'); assert.ok(r.stderr.includes(d), 'the kept path is printed'); });
  r = run('throw', { MATHSLIDES_KEEP_TMP: '1' });
  assert.ok(exists(r.info.dirs[0]) && r.stderr.includes(r.info.dirs[0]) && r.stderr.includes('boom-uncaught'), 'kept after a failure too, error still shown');
  assert.doesNotMatch(r.stderr, /were removed/);
  console.log('PASS MATHSLIDES_KEEP_TMP=1 keeps the folders and prints their paths');
  for (const n of sandboxLeft()) fs.rmSync(path.join(sandbox, n), { recursive: true, force: true });   // this test's own fixtures

  // 4. a directory the user supplied (MATHSLIDES_TEST_OUTPUT style) is never tracked, never removed, and is the one printed as OUTPUT
  const out = fs.mkdtempSync(path.join(sandbox, 'mathslides-useroutput-')); fs.writeFileSync(path.join(out, 'shot.png'), 'png');
  r = run('output', { OUT: out });
  assert.ok(exists(path.join(out, 'shot.png')), 'user-supplied output folder untouched');
  assert.ok(r.stdout.includes('OUTPUT ' + out) && !r.stdout.includes('OUTPUT ' + r.info.dirs[0]), 'OUTPUT lists only folders that still exist');
  assert.ok(!exists(r.info.dirs[0]));
  console.log('PASS a user-supplied output folder is neither tracked nor removed');
  fs.rmSync(out, { recursive: true, force: true });

  // 5. safety check: a tracked path swapped for a symlink is not followed
  r = run('swap', { VICTIM: victim });
  assert.match(r.stderr, /Not removing/); untouched();
  assert.ok(fs.lstatSync(r.info.dirs[0]).isSymbolicLink(), 'the symlink itself is left alone');
  fs.unlinkSync(r.info.dirs[0]);
  r = run('unit', { VICTIM: victim }); const u = r.info;
  assert.deepEqual(u, { ok: true, tmpItself: false, symlink: false, file: false, badName: false, nested: false, outside: false, relative: false, missing: false, nonString: false });
  r = run('badprefix'); assert.deepEqual(r.info.r, ['refused', 'refused', 'refused', 'refused']);
  console.log('PASS safety check: only real mathslides-* folders directly in the temp dir; symlinks, files, other names, nested and outside paths refused');

  // 6. signals: children (the Electron app) are stopped, folders removed
  for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]]) {
    const h = hold('hold-child'); const info = await h.ready;
    assert.ok(exists(info.dirs[0]) && alive(info.kid));
    h.p.kill(sig);
    const res = await h.exited;
    assert.equal(res.code, code, sig + ' exit code');
    assert.ok(!exists(info.dirs[0]), sig + ': folder removed');
    await until(() => !alive(info.kid), sig + ': the child process was stopped');
    untouched();
  }
  console.log('PASS SIGTERM / SIGINT: own child processes stopped, folders removed');

  // 7. several test processes at once: one ending never removes another's folders
  const A = hold('hold'), B = hold('hold');
  const [ia, ib] = [await A.ready, await B.ready];
  assert.notEqual(ia.dirs[0], ib.dirs[0]);
  A.go(); await A.exited;
  assert.ok(!exists(ia.dirs[0]), 'A cleaned its own folder');
  assert.ok(exists(path.join(ib.dirs[0], 'sub', 'f.txt')), 'B\'s folder is intact while A is gone');
  fs.writeFileSync(path.join(ib.dirs[0], 'still-usable.txt'), 'ok');
  untouched();
  B.go(); await B.exited;
  assert.ok(!exists(ib.dirs[0]), 'B cleaned its own folder when it ended');
  untouched();
  console.log('PASS parallel test processes only ever remove their own folders');

  // 8. documented limit: SIGKILL runs no code
  const K = hold('hold-child'); const ik = await K.ready;
  K.p.kill('SIGKILL'); await K.exited;
  assert.ok(exists(ik.dirs[0]), 'after SIGKILL the folder stays (cannot be cleaned; see docs/DEVELOPMENT.md)');
  try { process.kill(ik.kid, 'SIGTERM'); } catch {}
  console.log('PASS SIGKILL limit confirmed (folder is left behind, documented)');
  console.log('ALL PASS');
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
