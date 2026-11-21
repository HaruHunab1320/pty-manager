import { execFileSync, spawn } from 'node:child_process';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
function signal(pid, name) {
  try { process.kill(pid, name); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
}

// The parent owns cleanup: a timed-out/signal-killed Node child cannot execute
// its async finally. PTYs can also create new sessions, so process-group kill
// alone does not cover them. Discover descendants and verify IPC-reported PIDs.
export class QualificationProcesses {
  records = [];

  snapshot(record) {
    const rows = execFileSync('ps', ['-axo', 'pid=,ppid='], {
      encoding: 'utf8', timeout: 2000,
    }).trim().split('\n').map((row) => row.trim().split(/\s+/).map(Number));
    let changed;
    do {
      changed = false;
      for (const [pid, ppid] of rows) {
        if (record.pids.has(ppid) && !record.pids.has(pid)) {
          record.pids.add(pid);
          changed = true;
        }
      }
    } while (changed);
  }

  async cleanup(record) {
    if (pidAlive(record.pid)) this.snapshot(record);
    const descendants = () => [...record.pids].filter((pid) => pid !== record.pid && pidAlive(pid));
    // Leave the Node parent alive long enough to reap its native PTY child.
    for (const pid of descendants().reverse()) signal(pid, 'SIGTERM');
    if (descendants().length) await delay(200);
    for (const pid of descendants().reverse()) signal(pid, 'SIGKILL');
    for (let round = 0; round < 40 && descendants().length; round++) await delay(50);
    if (pidAlive(record.pid)) signal(record.pid, 'SIGTERM');
    for (let round = 0; round < 20 && pidAlive(record.pid); round++) await delay(50);
    if (pidAlive(record.pid)) signal(record.pid, 'SIGKILL');
    for (let round = 0; round < 40 && [...record.pids].some(pidAlive); round++) await delay(50);
    const remaining = [...record.pids].filter(pidAlive);
    if (remaining.length) throw new Error(`Unreaped owned PIDs: ${remaining.join(', ')}`);
  }

  async run(command, args, { cwd, env, timeout, abortSignal, ipc = false, onMessage, controlTimeout = false }) {
    abortSignal?.throwIfAborted();
    const child = spawn(command, args, {
      cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe', ...(ipc ? ['ipc'] : [])],
    });
    if (!child.pid) await new Promise((_, reject) => child.once('error', reject));
    const record = { pid: child.pid, pids: new Set([child.pid]), command, cleanup: 'pending' };
    this.records.push(record);
    let output = '', stderr = '', timer, poll, failure;
    child.stdout.on('data', (data) => { output = (output + data).slice(-1048576); });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-1048576); });
    let interrupt;
    const interrupted = new Promise((_, reject) => { interrupt = reject; });
    const abort = () => interrupt(abortSignal.reason ?? new Error('Cancelled'));
    const armTimeout = (ms) => {
      clearTimeout(timer);
      timer = setTimeout(() => interrupt(new Error(`Command timed out: ${command}`)), ms);
    };
    abortSignal?.addEventListener('abort', abort, { once: true });
    if (abortSignal?.aborted) abort();
    child.on('message', (message) => {
      try {
        if (message.type === 'owned-pid') {
          this.snapshot(record);
          if (!record.pids.has(message.pid)) throw new Error('Child reported a PID outside its owned process tree');
        }
        if (message.type === 'control-ready' && controlTimeout) armTimeout(100);
        onMessage?.(message);
      } catch (error) { interrupt(error); }
    });
    armTimeout(timeout);
    poll = setInterval(() => {
      try { if (pidAlive(record.pid)) this.snapshot(record); }
      catch (error) { interrupt(error); }
    }, 200);
    try {
      const code = await Promise.race([
        new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code, signal) => resolve(code ?? signal));
        }),
        interrupted,
      ]);
      if (code !== 0) throw new Error(`Command failed (${code}): ${command}\n${stderr}`);
    } catch (error) { failure = error; }
    finally {
      clearTimeout(timer); clearInterval(poll);
      abortSignal?.removeEventListener('abort', abort);
      try { await this.cleanup(record); record.cleanup = 'complete'; }
      catch (error) { record.cleanup = 'incomplete'; failure = new AggregateError([failure, error].filter(Boolean), `${failure?.message ?? ''}; ${error.message}`); }
    }
    if (failure) throw failure;
    return output;
  }

  async cleanupAll() {
    const errors = [];
    for (const record of this.records) {
      try { await this.cleanup(record); record.cleanup = 'complete'; }
      catch (error) { record.cleanup = 'incomplete'; errors.push(String(error.message)); }
    }
    return {
      state: errors.length ? 'incomplete' : 'complete', errors,
      processes: this.records.map((record) => ({
        pid: record.pid, ownedPids: [...record.pids], remainingPids: [...record.pids].filter(pidAlive), cleanup: record.cleanup,
      })),
    };
  }
}
