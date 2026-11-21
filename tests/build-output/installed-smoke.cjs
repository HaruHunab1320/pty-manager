// Run only from an isolated consumer with the packed package installed.
// Exercises the exported manager/adapter API against a real native PTY.
const assert = require('node:assert/strict');
const { realpathSync } = require('node:fs');
const { join } = require('node:path');

const mode = process.argv[2];
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const pids = new Set();
const managers = new Set();
const cases = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};
async function until(predicate, label, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out: ${label}`);
    await delay(20);
  }
}

async function main() {
  assert.ok(['cjs', 'esm'].includes(mode));
  const entry = require.resolve('pty-manager');
  assert.ok(realpathSync(entry).startsWith(join(process.cwd(), 'node_modules', 'pty-manager')),
    'Package must resolve inside the isolated consumer, without workspace links');
  const api = mode === 'esm' ? await import('pty-manager') : require('pty-manager');
  api.ensurePty(() => {});
  async function start(id) {
    const manager = new api.PTYManager({ logger: quiet });
    managers.add(manager);
    const adapter = new api.ShellAdapter({ shell: '/bin/bash', prompt: '__QUALIFIED_PTY__ ' });
    // Avoid reading the operator's shell startup files.
    adapter.getArgs = () => ['--noprofile', '--norc', '-i'];
    manager.registerAdapter(adapter);
    const handle = await manager.spawn({
      id, name: id, type: 'shell', workdir: process.cwd(),
      inheritProcessEnv: false, skipAdapterAutoResponse: true,
      env: { PATH: '/usr/bin:/bin', HOME: process.cwd(), TERM: 'xterm-256color' },
    });
    assert.ok(Number.isInteger(handle.pid));
    pids.add(handle.pid);
    if (process.send) await new Promise((resolve, reject) =>
      process.send({ type: 'owned-pid', pid: handle.pid }, (error) => error ? reject(error) : resolve()));
    await until(() => manager.get(id)?.status === 'ready', 'shell ready');
    const terminal = manager.attachTerminal(id);
    assert.ok(terminal);
    let output = '';
    terminal.onData((data) => { output += data; });
    return { manager, handle, terminal, output: () => output };
  }

  const normal = await start(`${mode}-normal`);
  if (process.argv[3] === 'stall') {
    process.send?.({ type: 'control-ready' });
    await new Promise(() => {});
  }
  normal.manager.send(normal.handle.id, "printf '\\n__PTY_OUTPUT__%s\\n' 42");
  await until(() => /[\r\n]__PTY_OUTPUT__42\r?\n/.test(normal.output()), 'actual shell output');
  normal.terminal.resize(100, 35);
  normal.terminal.write("printf '\\n__PTY_INPUT_READY__\\n'; read -r reply; printf '\\n__PTY_REPLY__%s\\n' \"$reply\"\r");
  await until(() => /[\r\n]__PTY_INPUT_READY__\r?\n/.test(normal.output()), 'read waiting for input');
  normal.terminal.write('round-trip\r');
  await until(() => /[\r\n]__PTY_REPLY__round-trip\r?\n/.test(normal.output()), 'input round trip');
  normal.terminal.write('exit 0\r');
  await until(() => normal.manager.get(normal.handle.id)?.status === 'stopped', 'natural exit');
  await until(() => !alive(normal.handle.pid), 'natural PID reaped');
  await normal.manager.shutdown();
  assert.equal(normal.manager.list().length, 0);
  managers.delete(normal.manager);
  cases.push('spawn-output-input-resize-natural-exit');

  const cancelled = await start(`${mode}-cancel`);
  cancelled.terminal.write('exec /bin/sleep 30\r');
  await cancelled.manager.stop(cancelled.handle.id, { force: true, timeout: 1000 });
  await until(() => !alive(cancelled.handle.pid), 'cancelled PID reaped');
  assert.equal(cancelled.manager.get(cancelled.handle.id), null);
  await cancelled.manager.shutdown();
  managers.delete(cancelled.manager);
  cases.push('force-stop-and-reap');

  const shutdown = await start(`${mode}-shutdown`);
  await shutdown.manager.shutdown();
  await until(() => !alive(shutdown.handle.pid), 'shutdown PID reaped');
  assert.equal(shutdown.manager.list().length, 0);
  managers.delete(shutdown.manager);
  cases.push('manager-shutdown-and-reap');
}

(async () => {
  try {
    await main();
  } finally {
    for (const manager of managers) await manager.shutdown();
    // Only PIDs created by this process are eligible for emergency cleanup.
    for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
    for (const pid of pids) await until(() => !alive(pid), 'cleanup PID reaped');
  }
  console.log(JSON.stringify({ mode, cases, cleanup: 'complete', remainingPids: 0 }));
})().catch((error) => { console.error(error); process.exitCode = 1; });
