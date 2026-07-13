/**
 * send() paste-framing tests
 *
 * Multi-line / large payloads must be written with bracketed-paste
 * framing: kernel PTY chunking makes TUI apps (ink) treat each chunk as
 * a separate paste, and the trailing Enter lands between fragments —
 * the input never submits (observed live as "[Pasted text #1..#16]"
 * stuck in Claude Code's input box).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIAdapter } from '../src/types';
import { PTYSession } from '../src/pty-session';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function createMockAdapter(): CLIAdapter {
  return {
    adapterType: 'test',
    displayName: 'Test CLI',
    autoResponseRules: [],
    getCommand: () => 'echo',
    getArgs: () => [],
    getEnv: () => ({}),
    detectLogin: () => ({ required: false }),
    detectReady: () => false,
    detectExit: () => ({ exited: false }),
    detectBlockingPrompt: () => ({ detected: false }),
    parseOutput: () => null,
    getPromptPattern: () => /\$\s*$/,
    formatInput: (msg: string) => msg,
    validateInstallation: async () => ({ installed: true }),
  };
}

function createSession(): { session: PTYSession; write: ReturnType<typeof vi.fn> } {
  const session = new PTYSession(
    createMockAdapter(),
    { name: 'test', type: 'test' },
    silentLogger as never,
    false,
    5000
  );
  const write = vi.fn();
  (session as any).ptyProcess = {
    write,
    kill: vi.fn(),
    pid: 12345,
    resize: vi.fn(),
  };
  (session as any)._status = 'ready';
  return { session, write };
}

describe('PTYSession.send paste framing', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('writes short single-line messages without framing', () => {
    const { session, write } = createSession();

    session.send('run the tests');

    expect(write).toHaveBeenCalledWith('run the tests');
  });

  it('wraps multi-line messages in bracketed paste', () => {
    const { session, write } = createSession();
    const task = 'line one\nline two\nline three';

    session.send(task);

    expect(write).toHaveBeenCalledWith(`\x1b[200~${task}\x1b[201~`);
  });

  it('wraps large single-line messages in bracketed paste', () => {
    const { session, write } = createSession();
    const task = 'x'.repeat(500);

    session.send(task);

    expect(write).toHaveBeenCalledWith(`\x1b[200~${task}\x1b[201~`);
  });

  it('sends Enter after the paste, scaled to payload size', () => {
    const { session, write } = createSession();
    const task = `start\n${'x'.repeat(4000)}`;

    session.send(task);
    // Enter has not been sent yet
    expect(write).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(400);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith('\r');
  });
});
