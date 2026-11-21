import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CLIAdapter } from '../src/adapters/adapter-interface';
import { PTYSession } from '../src/pty-session';

const question = 'Which seat count should the booking retain?';
const footer = '\n\n✻ Cooked for 1s\n❯ \n';
const logger = { debug() {}, info() {}, warn() {}, error() {} };

type Internals = {
  _status: string;
  outputBuffer: string;
  processOutputBuffer(): void;
  onStallTimerFired(): void;
  ptyProcess: { write: ReturnType<typeof vi.fn>; kill(): void };
};

// The adapter contract separates semantic parsing from the end-of-turn signal.
// A newline/question mark alone is deliberately not completion evidence.
function setup() {
  const adapter: CLIAdapter = {
    adapterType: 'test',
    displayName: 'Test',
    autoResponseRules: [],
    getCommand: () => 'unused',
    getArgs: () => [],
    getEnv: () => ({}),
    detectLogin: () => ({ required: false }),
    detectReady: () => false,
    detectExit: () => ({ exited: false }),
    detectBlockingPrompt: () => ({ detected: false }),
    detectTaskComplete: (output) => output.endsWith(footer),
    parseOutput: (output) =>
      output.trim()
        ? {
            type: 'response',
            content: output.replace(footer, '').trim(),
            isComplete: output.includes('\n'),
            isQuestion: output.includes(question),
          }
        : null,
    getPromptPattern: () => /❯\s*$/,
    formatInput: (input) => input,
    validateInstallation: async () => ({ installed: true }),
  };
  const session = new PTYSession(
    adapter,
    { name: 'test', type: 'test' },
    logger,
    false,
  );
  const state = session as unknown as Internals;
  state._status = 'busy';
  state.ptyProcess = { write: vi.fn(), kill() {} };
  const events = {
    complete: vi.fn(),
    question: vi.fn(),
    message: vi.fn(),
    blocking: vi.fn(),
    auth: vi.fn(),
    ready: vi.fn(),
  };
  session.on('task_complete', events.complete);
  session.on('question', events.question);
  session.on('message', events.message);
  session.on('blocking_prompt', events.blocking);
  session.on('auth_required', events.auth);
  session.on('ready', events.ready);
  const output = (text: string) => {
    state.outputBuffer = text;
    state.processOutputBuffer();
  };
  return { session, state, adapter, events, output };
}

const endings = {
  debounce: (x: ReturnType<typeof setup>) => {
    x.output(question + footer);
    vi.advanceTimersByTime(1501);
  },
  stall: (x: ReturnType<typeof setup>) => {
    x.state.outputBuffer = question + footer;
    x.state.onStallTimerFired();
  },
  hook: (x: ReturnType<typeof setup>) => {
    x.state.outputBuffer = question + '\n';
    x.session.notifyHookEvent('task_complete');
  },
  classifier: (x: ReturnType<typeof setup>) => {
    x.state.outputBuffer = question + '\n';
    x.session.handleStallClassification({ state: 'task_complete' });
  },
};

describe('question-aware turn completion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  for (const [name, end] of Object.entries(endings)) {
    it(`${name}: delivers the question before clearing, without completing the task`, () => {
      const x = setup();
      end(x);
      expect(x.events.question.mock.calls).toEqual([[question]]);
      expect(x.events.message).toHaveBeenCalledWith(
        expect.objectContaining({ direction: 'outbound', content: question }),
      );
      expect(x.events.complete).not.toHaveBeenCalled();
      expect(x.events.ready).not.toHaveBeenCalled();
      expect(x.session.status).toBe('ready');
      expect(x.session.getOutputBuffer()).toBe('');
    });
  }

  it('treats a confirmed hook boundary as the end of an unterminated question line', () => {
    const x = setup();
    const parse = x.adapter.parseOutput;
    x.adapter.parseOutput = (output) =>
      output.includes('\n') ? parse(output) : null;
    x.state.outputBuffer = question;
    x.session.notifyHookEvent('task_complete');
    expect(x.events.question.mock.calls).toEqual([[question]]);
    expect(x.events.complete).not.toHaveBeenCalled();
  });

  it('allows a synchronous question handler to answer without retaining a stale pending flag', () => {
    const x = setup();
    x.session.on('question', () => x.session.send('4'));
    endings.debounce(x);
    vi.advanceTimersByTime(100);
    x.output('Fixed.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete).toHaveBeenCalledOnce();
  });

  it('does not parse a streamed question until the completion signal settles', () => {
    const x = setup();
    x.output(question + '\n');
    vi.advanceTimersByTime(2000);
    expect(x.events.question).not.toHaveBeenCalled();
    expect(x.events.complete).not.toHaveBeenCalled();
    expect(x.session.getOutputBuffer()).toBe(question + '\n');
    x.output(question + footer);
    vi.advanceTimersByTime(1499);
    expect(x.events.question).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(x.events.question).toHaveBeenCalledOnce();
  });

  it('deduplicates redraw and repeated completion until send answers the question', () => {
    const x = setup();
    endings.debounce(x);
    x.output(question + footer);
    x.session.notifyHookEvent('task_complete');
    vi.advanceTimersByTime(2000);
    expect(x.events.question).toHaveBeenCalledOnce();
    expect(x.events.complete).not.toHaveBeenCalled();
    x.session.send('Keep the requested seat count.');
    vi.advanceTimersByTime(100);
    expect(x.session.status).toBe('busy');
    x.output('Fixed the seat count.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete.mock.calls).toEqual([
      ['Fixed the seat count.' + footer],
    ]);
    x.session.send('Another task');
    vi.advanceTimersByTime(100);
    endings.debounce(x);
    expect(x.events.question).toHaveBeenCalledTimes(2);
  });

  for (const answer of ['write', 'raw', 'keys'] as const) {
    it(`resumes after a submitted ${answer} answer`, () => {
      const x = setup();
      endings.debounce(x);
      if (answer === 'write') x.session.write('4');
      if (answer === 'raw') x.session.writeRaw('4\r');
      if (answer === 'keys') {
        x.session.writeRaw('4');
        x.session.sendKeys('enter');
      }
      expect(x.session.status).toBe('busy');
      x.output('Fixed.' + footer);
      vi.advanceTimersByTime(1501);
      expect(x.events.complete).toHaveBeenCalledOnce();
    });
  }

  it('navigation and partial answer text do not release the unanswered question', () => {
    const x = setup();
    endings.debounce(x);
    x.session.writeRaw('4');
    x.session.sendKeys('left');
    x.session.notifyHookEvent('task_complete');
    expect(x.events.complete).not.toHaveBeenCalled();
    expect(x.session.status).toBe('ready');
  });

  for (const [name, end] of Object.entries(endings)) {
    for (const kind of ['permission', 'unknown'] as const) {
      it(`${name}: preserves ${kind} blocker priority over a parsed question`, () => {
        const x = setup();
        x.adapter.detectBlockingPrompt = () => ({
          detected: true,
          type: kind,
          prompt: 'Allow this action?',
          canAutoRespond: false,
        });
        end(x);
        x.session.notifyHookEvent('task_complete');
        expect(x.events.blocking).toHaveBeenCalledOnce();
        expect(x.events.question).not.toHaveBeenCalled();
        expect(x.events.complete).not.toHaveBeenCalled();
        expect(x.session.getOutputBuffer()).toContain(question);
      });
    }
    it(`${name}: preserves login priority even when blocking detection has no result`, () => {
      const x = setup();
      x.adapter.detectLogin = () => ({
        required: true,
        type: 'oauth',
        instructions: 'Sign in',
      });
      end(x);
      expect(x.events.auth).toHaveBeenCalledOnce();
      expect(x.events.question).not.toHaveBeenCalled();
      expect(x.events.complete).not.toHaveBeenCalled();
      expect(x.session.status).toBe('authenticating');
    });
  }

  it('retains normal nonquestion completion output and classifier ready contract', () => {
    const x = setup();
    x.output('Fixed.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete.mock.calls).toEqual([['Fixed.' + footer]]);
    x.state._status = 'busy';
    x.state.outputBuffer = 'Finished\n';
    x.session.handleStallClassification({ state: 'task_complete' });
    expect(x.events.ready).toHaveBeenCalledOnce();
    expect(x.events.complete).toHaveBeenCalledOnce();
  });
  for (const method of ['write', 'writeRaw', 'sendKeys', 'send'] as const) {
    it(`failed ${method} answer retains the unanswered question`, () => {
      const x = setup();
      endings.debounce(x);
      x.state.ptyProcess.write.mockImplementation(() => {
        throw Error('transport write failed');
      });
      expect(() => {
        if (method === 'write') x.session.write('4');
        if (method === 'writeRaw') x.session.writeRaw('4\r');
        if (method === 'sendKeys') x.session.sendKeys('enter');
        if (method === 'send') x.session.send('4');
      }).toThrow('transport write failed');
      x.session.notifyHookEvent('task_complete');
      expect(x.events.complete).not.toHaveBeenCalled();
    });
  }

  it('rejects duplicate old hooks before delayed Enter and before continuation output', () => {
    const x = setup();
    x.session.on('question', () => x.session.send('4'));
    endings.hook(x);
    x.session.notifyHookEvent('task_complete');
    expect(x.events.complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    x.session.notifyHookEvent('task_complete');
    expect(x.events.complete).not.toHaveBeenCalled();
    x.output('Fixed.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete).toHaveBeenCalledOnce();
  });

  it('fails closed when the delayed Enter write fails', () => {
    const x = setup();
    endings.debounce(x);
    const errors = vi.fn();
    x.session.on('error', errors);
    x.session.send('4');
    x.state.ptyProcess.write.mockImplementation(() => {
      throw Error('Enter failed');
    });
    vi.advanceTimersByTime(100);
    expect(errors).toHaveBeenCalledOnce();
    x.session.notifyHookEvent('task_complete');
    expect(x.events.complete).not.toHaveBeenCalled();
    x.state.ptyProcess.write.mockReset();
    x.session.send('4');
    vi.advanceTimersByTime(100);
    x.output('Fixed.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete).toHaveBeenCalledOnce();
  });

  it('retains synchronous continuation emitted by a successful Enter write', () => {
    const x = setup();
    endings.debounce(x);
    x.state.ptyProcess.write.mockImplementation((data: string) => {
      if (data === '\r') x.output('Fixed.' + footer);
    });
    x.session.send('4');
    vi.advanceTimersByTime(1700);
    expect(x.events.complete.mock.calls).toEqual([['Fixed.' + footer]]);
  });

  it('pasted multiline answer text does not count as submission before Enter', () => {
    const x = setup();
    endings.debounce(x);
    x.session.send('Keep 4 seats.\nPreserve the order.');
    x.session.notifyHookEvent('task_complete');
    expect(x.events.complete).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    x.output('Fixed.' + footer);
    vi.advanceTimersByTime(1501);
    expect(x.events.complete).toHaveBeenCalledOnce();
  });

  for (const method of ['write', 'writeRaw', 'sendKeys'] as const) {
    for (const fails of [false, true]) {
      it(`${method} retires stale permission text only on successful submission (fails=${fails})`, () => {
        const x = setup();
        x.adapter.detectBlockingPrompt = (output) =>
          output.includes('Allow tool access?')
            ? {
                detected: true,
                type: 'permission',
                prompt: 'Allow tool access?',
                canAutoRespond: false,
              }
            : { detected: false };
        x.output('Allow tool access?');
        expect(x.events.blocking).toHaveBeenCalledOnce();
        if (fails)
          x.state.ptyProcess.write.mockImplementation(() => {
            throw Error('write failed');
          });
        const send = () => {
          if (method === 'write') x.session.write('yes');
          if (method === 'writeRaw') x.session.writeRaw('yes\r');
          if (method === 'sendKeys') x.session.sendKeys('enter');
        };
        if (fails) expect(send).toThrow('write failed');
        else send();
        x.state.outputBuffer += '\nFixed.' + footer;
        x.session.notifyHookEvent('task_complete');
        expect(x.events.complete).toHaveBeenCalledTimes(fails ? 0 : 1);
      });
    }
  }
  for (const fails of [false, true]) {
    it(`navigation retires stale menu text only after a successful key write (fails=${fails})`, () => {
      const x = setup();
      x.adapter.detectBlockingPrompt = (output) =>
        output.includes('Menu: Esc to close')
          ? {
              detected: true,
              type: 'unknown',
              prompt: 'Menu: Esc to close',
              canAutoRespond: false,
            }
          : { detected: false };
      x.output('Menu: Esc to close');
      expect(x.events.blocking).toHaveBeenCalledOnce();
      if (fails)
        x.state.ptyProcess.write.mockImplementation(() => {
          throw Error('key failed');
        });
      if (fails)
        expect(() => x.session.sendKeys('escape')).toThrow('key failed');
      else x.session.sendKeys('escape');
      x.state.outputBuffer += '\nFixed.' + footer;
      x.session.notifyHookEvent('task_complete');
      expect(x.events.complete).toHaveBeenCalledTimes(fails ? 0 : 1);
    });
  }
});
