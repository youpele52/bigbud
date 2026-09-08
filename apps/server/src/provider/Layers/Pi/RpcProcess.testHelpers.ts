import { EventEmitter } from "node:events";

import { vi } from "vitest";

type FakeStream = EventEmitter & { setEncoding: (encoding: string) => void };
type FakeStdin = EventEmitter & {
  writable: boolean;
  end: () => void;
  write: (data: string, callback?: (error?: Error | null) => void) => boolean;
};
export type FakeChildProcess = EventEmitter & {
  stdout: FakeStream;
  stderr: FakeStream;
  stdin: FakeStdin;
  exitCode: number | null;
  kill: () => void;
};

export function createFakeChildProcess(): FakeChildProcess {
  const stdout = new EventEmitter() as FakeStream;
  stdout.setEncoding = vi.fn();
  const stderr = new EventEmitter() as FakeStream;
  stderr.setEncoding = vi.fn();
  const stdin = Object.assign(new EventEmitter(), {
    writable: true,
    end: vi.fn(),
    write: vi.fn((_data: string, callback?: (error?: Error | null) => void) => {
      callback?.(null);
      return true;
    }),
  }) as FakeStdin;
  const child = new EventEmitter() as FakeChildProcess;
  child.stdout = stdout;
  child.stderr = stderr;
  child.stdin = stdin;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}
