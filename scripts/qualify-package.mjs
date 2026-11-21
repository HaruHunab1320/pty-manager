// Clean-consumer qualification for an exact npm tarball. No model, GitHub or
// operator credentials are needed; all created consumers are removed on exit.
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { QualificationProcesses } from './qualification-process.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--'))
    throw new Error(`Required: ${name} PATH`);
  return resolve(args[index + 1]);
}
const receiptPath = option('--receipt');
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const processes = new QualificationProcesses();
const cancellation = new AbortController();
const cancel = (signal) => cancellation.abort(new Error(`Cancelled by ${signal}`));
const sigterm = () => cancel('SIGTERM');
const sigint = () => cancel('SIGINT');
process.on('SIGTERM', sigterm); process.on('SIGINT', sigint);
let scratch;
const receipt = {
  schemaVersion: 2,
  startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, arch: process.arch,
  status: 'running', checks: [], cleanup: 'pending',
};
try {
  const tarball = option('--tarball');
  const bytes = readFileSync(tarball); // Validate before allocating resources.
  receipt.artifact = {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  };
  const control = args.includes('--control') ? args[args.indexOf('--control') + 1] : null;
  if (control && !['timeout', 'cancel'].includes(control)) throw new Error('Invalid negative-test control');
  scratch = mkdtempSync(join(tmpdir(), 'pty-package-qualification-'));
  receipt.scratch = scratch;
  const consumer = join(scratch, 'consumer');
  const home = join(scratch, 'home');
  mkdirSync(consumer); mkdirSync(home);
  writeFileSync(join(scratch, 'npmrc'), 'registry=https://registry.npmjs.org/\n');
  const env = {
    PATH: process.env.PATH,
    HOME: home, TMPDIR: scratch, CI: 'true',
    npm_config_userconfig: join(scratch, 'npmrc'),
    npm_config_cache: join(scratch, 'npm-cache'),
  };
  if (args.includes('--node-headers')) env.npm_config_nodedir = option('--node-headers');
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ name: 'pty-clean-consumer', private: true, version: '1.0.0' }));
  await processes.run('npm', ['install', '--no-audit', '--no-fund', '--save-exact', tarball], {
    cwd: consumer, env, timeout: 180000, abortSignal: cancellation.signal,
  });
  const lock = JSON.parse(readFileSync(join(consumer, 'package-lock.json'), 'utf8'));
  receipt.dependencies = Object.fromEntries(Object.entries(lock.packages).filter(([path]) => path).map(([path, value]) => [path, { version: value.version, integrity: value.integrity ?? null }]));
  copyFileSync(join(root, 'tests/build-output/installed-smoke.cjs'), join(consumer, 'installed-smoke.cjs'));
  for (const mode of control ? ['cjs'] : ['cjs', 'esm']) {
    const output = await processes.run(process.execPath, ['installed-smoke.cjs', mode, ...(control ? ['stall'] : [])], {
      cwd: consumer, env, timeout: 45000, abortSignal: cancellation.signal, ipc: true,
      controlTimeout: control === 'timeout',
      onMessage(message) {
        if (message.type === 'control-ready' && control === 'cancel')
          console.log(JSON.stringify({ event: 'control-ready', qualifierPid: process.pid }));
      },
    });
    receipt.checks.push(JSON.parse(output.trim()));
  }
  receipt.status = 'passed';
} catch (error) {
  receipt.status = cancellation.signal.aborted ? 'cancelled' : 'failed';
  receipt.error = String(error.message);
  process.exitCode = 1;
} finally {
  const cleanup = await processes.cleanupAll();
  receipt.processes = cleanup.processes;
  receipt.cleanup = cleanup.state;
  receipt.cleanupErrors = cleanup.errors;
  if (scratch && cleanup.state === 'complete') {
    try { rmSync(scratch, { recursive: true, force: true }); }
    catch (error) { receipt.cleanup = 'incomplete'; receipt.cleanupErrors.push(String(error.message)); }
  }
  if (receipt.cleanup !== 'complete') { receipt.status = 'failed'; process.exitCode = 1; }
  receipt.finishedAt = new Date().toISOString();
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  process.removeListener('SIGTERM', sigterm); process.removeListener('SIGINT', sigint);
}
console.log(JSON.stringify(receipt, null, 2));
