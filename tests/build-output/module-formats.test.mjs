// Checks the published build, not the TypeScript sources: both module
// formats must load and run code paths that locate files relative to the
// package (node-pty lookup and the Bun worker path). Run after `pnpm build`.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

function run(args) {
  return execFileSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('ESM build runs ensurePty without a ReferenceError', () => {
  const out = run([
    '--input-type=module',
    '-e',
    "import { ensurePty } from './dist/index.mjs'; ensurePty(); console.log('esm-ok');",
  ]);
  assert.match(out, /esm-ok/);
});

test('CommonJS build runs ensurePty', () => {
  const out = run([
    '-e',
    "const { ensurePty } = require('./dist/index.js'); ensurePty(); console.log('cjs-ok');",
  ]);
  assert.match(out, /cjs-ok/);
});
