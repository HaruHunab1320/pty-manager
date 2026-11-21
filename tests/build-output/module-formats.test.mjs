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

for (const format of ['esm', 'cjs']) {
  test(`${format} build actually spawns the native PTY`, () => {
    const load = format === 'esm'
      ? "import { PTYSession, ShellAdapter } from './dist/index.mjs';"
      : "const { PTYSession, ShellAdapter } = require('./dist/index.js');";
    const script = `${load}
      const adapter = new ShellAdapter({ shell: '/bin/bash' });
      adapter.getArgs = () => ['--noprofile', '--norc', '-c', 'printf native-pty-ok'];
      const logger = { debug() {}, info() {}, warn() {}, error() {} };
      const session = new PTYSession(adapter, {
        id: 'dist-native-smoke', name: 'dist-native-smoke', type: 'shell',
        inheritProcessEnv: false, env: { PATH: '/usr/bin:/bin' }
      }, logger);
      let output = '';
      const timer = setTimeout(() => { session.kill('SIGKILL'); process.exitCode = 1; }, 5000);
      session.on('output', data => { output += data; });
      session.on('exit', code => {
        clearTimeout(timer);
        if (code !== 0 || !output.includes('native-pty-ok')) process.exitCode = 1;
        else console.log('native-pty-ok');
      });
      session.start().catch(error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
    `;
    const out = run([...(format === 'esm' ? ['--input-type=module'] : []), '-e', script]);
    assert.match(out, /native-pty-ok/);
  });
}
