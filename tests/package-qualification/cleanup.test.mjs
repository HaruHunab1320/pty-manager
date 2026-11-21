import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { pidAlive } from '../../scripts/qualification-process.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const archive = process.env.PTY_QUALIFICATION_TARBALL;
assert.ok(archive, 'Set PTY_QUALIFICATION_TARBALL to the exact release archive');
const evidence = process.env.PTY_QUALIFICATION_EVIDENCE;

async function qualify(name, control, expectedStatus) {
  const owned = mkdtempSync(join(tmpdir(), 'pty-qualification-test-'));
  const receiptPath = evidence ? join(evidence, `${name}.json`) : join(owned, 'receipt.json');
  mkdirSync(dirname(receiptPath), { recursive: true });
  const args = [join(root, 'scripts/qualify-package.mjs'), '--tarball',
    name === 'missing-archive' ? join(owned, 'missing.tgz') : resolve(archive), '--receipt', receiptPath];
  if (control) args.push('--control', control);
  if (process.env.PTY_QUALIFICATION_NODE_HEADERS) args.push('--node-headers', process.env.PTY_QUALIFICATION_NODE_HEADERS);
  const child = spawn(process.execPath, args, { env: { ...process.env, TMPDIR: owned }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '', cancelled = false;
  child.stdout.on('data', (data) => {
    stdout += data;
    if (control === 'cancel' && !cancelled && stdout.includes('"event":"control-ready"')) {
      cancelled = true;
      child.kill('SIGTERM');
    }
  });
  child.stderr.on('data', (data) => { stderr += data; });
  const deadline = setTimeout(() => child.kill('SIGTERM'), 210000);
  let receipt;
  try {
    const exit = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    assert.equal(exit.signal, null, stderr);
    assert.equal(exit.code, expectedStatus === 'passed' ? 0 : 1, stdout + stderr);
    receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
    assert.equal(receipt.status, expectedStatus, JSON.stringify(receipt));
    assert.equal(receipt.cleanup, 'complete', JSON.stringify(receipt));
    assert.deepEqual(receipt.cleanupErrors, []);
    assert.equal(receipt.scratch && existsSync(receipt.scratch), receipt.scratch ? false : undefined);
    for (const record of receipt.processes) {
      assert.equal(record.cleanup, 'complete');
      assert.deepEqual(record.remainingPids, []);
      for (const pid of record.ownedPids) assert.equal(pidAlive(pid), false, `Owned PID still exists: ${pid}`);
    }
    if (control) {
      const smoke = receipt.processes.at(-1);
      assert.ok(smoke.ownedPids.length >= 2, 'Parent tracked both Node child and real PTY shell');
      assert.match(receipt.error, control === 'timeout' ? /timed out/ : /Cancelled by SIGTERM/);
      if (control === 'cancel') assert.ok(cancelled, 'Cancellation happened after real PTY became ready');
    }
    if (name === 'missing-archive') {
      assert.equal(receipt.scratch, undefined);
      assert.deepEqual(receipt.processes, []);
      assert.match(receipt.error, /ENOENT/);
    }
    assert.deepEqual(readdirSync(owned).filter((file) => file !== 'receipt.json'), [], 'No scratch consumers remain');
  } finally {
    clearTimeout(deadline);
    // Failed cleanup retains its directory and receipt for diagnosis.
    if (receipt?.cleanup === 'complete') rmSync(owned, { recursive: true, force: true });
  }
}

test('missing archive produces failed receipt without allocating scratch', () => qualify('missing-archive', null, 'failed'));
test('timeout reaps a real PTY without depending on child finally', () => qualify('timeout', 'timeout', 'failed'));
test('parent SIGTERM reaps a real PTY and reports cancellation', () => qualify('cancel', 'cancel', 'cancelled'));
test('exact archive passes real CJS and ESM lifecycle checks', () => qualify('positive', null, 'passed'));
