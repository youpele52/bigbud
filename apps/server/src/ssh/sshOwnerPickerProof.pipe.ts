import { spawn } from "node:child_process";
import { createConnection, Socket } from "node:net";
import type { Readable, Writable } from "node:stream";

import { decodeOwnerFrame, PickerProofOwnerError } from "./sshOwnerPickerProof.codec.ts";
import { readPickerProofStartupConfigDiagnostic } from "./sshOwnerPickerProof.startupDiagnostic.ts";

const CLIENT_TO_OWNER_MAX = 64 * 1024;
const OWNER_TO_CLIENT_MAX = 8 * 1024 * 1024;
const EXCHANGE_TIMEOUT_MS = 20_000;
const WORKSPACE_EXCHANGE_TIMEOUT_MS = 40_000;
const EXIT_TIMEOUT_MS = 2_000;

type OwnerFrame = ReturnType<typeof decodeOwnerFrame>;

interface Exchange {
  readonly resolve: (frame: OwnerFrame) => void;
  readonly reject: (error: PickerProofOwnerError) => void;
  readonly timer: NodeJS.Timeout;
}

export interface PickerProofSpawnOptions {
  /** Cleared environment plus an explicit allowlist; never the caller's environment. */
  readonly environment?: Readonly<Record<string, string>>;
  /**
   * Re-exec through the fixed system `env -i` helper so a runtime that merges
   * ambient `.env` values into `spawn({ env })` cannot leak them to the owner.
   */
  readonly clearEnvironment?: boolean;
  /** Bounds the whole handshake; expiry kills the child and rejects the exchange. */
  readonly startupDeadlineMs?: number;
}

/** No inbox: an owner frame must answer the single in-flight exchange. */
export function makePickerProofPipe(input: Writable, output: Readable, stop: () => Promise<void>) {
  const header = Buffer.alloc(4);
  let headerOffset = 0;
  let body: Buffer | undefined;
  let bodyOffset = 0;
  let pending: Exchange | undefined;
  let failure: PickerProofOwnerError | undefined;
  const lostListeners = new Set<() => void>();

  const takePending = () => {
    const exchange = pending;
    pending = undefined;
    if (exchange) clearTimeout(exchange.timer);
    return exchange;
  };
  const retire = (error = new PickerProofOwnerError("ownerUnavailable")) => {
    failure ??= error;
    takePending()?.reject(failure);
    body = undefined;
  };
  const fail = (error: PickerProofOwnerError) => {
    if (failure) return;
    retire(error);
    for (const listener of lostListeners) listener();
    void stop();
  };
  const lost = () => fail(new PickerProofOwnerError("ownerUnavailable"));

  input.on("error", lost);
  if (!Object.is(output, input)) output.on("error", lost);
  output.on("close", lost);
  output.on("end", () => {
    if (headerOffset > 0 || body !== undefined) fail(new PickerProofOwnerError("protocolError"));
    else lost();
  });
  output.on("data", (chunk: Buffer) => {
    if (failure) return;
    try {
      if (!pending) throw new PickerProofOwnerError("protocolError");
      let offset = 0;
      if (!body) {
        offset = chunk.copy(header, headerOffset, 0, header.length - headerOffset);
        headerOffset += offset;
        if (headerOffset < header.length) return;
        const size = header.readUInt32BE(0);
        if (size === 0 || size > OWNER_TO_CLIENT_MAX)
          throw new PickerProofOwnerError("protocolError");
        body = Buffer.alloc(size);
        headerOffset = 0;
      }
      const copied = chunk.copy(body, bodyOffset, offset);
      bodyOffset += copied;
      if (bodyOffset < body.length) return;
      if (offset + copied < chunk.length) {
        throw new PickerProofOwnerError("protocolError");
      }
      const frame = decodeOwnerFrame(body);
      body = undefined;
      bodyOffset = 0;
      takePending()?.resolve(frame);
    } catch {
      fail(new PickerProofOwnerError("protocolError"));
    }
  });

  return {
    exchange(payload: Uint8Array, purpose?: "workspace" | number): Promise<OwnerFrame> {
      if (failure) return Promise.reject(failure);
      if (pending) return Promise.reject(new PickerProofOwnerError("ownerUnavailable"));
      if (payload.length === 0 || payload.length > CLIENT_TO_OWNER_MAX) {
        return Promise.reject(new PickerProofOwnerError("invalidOperands"));
      }
      const framed = Buffer.alloc(4 + payload.length);
      framed.writeUInt32BE(payload.length);
      framed.set(payload, 4);
      return new Promise((resolve, reject) => {
        const timeout =
          purpose === "workspace"
            ? WORKSPACE_EXCHANGE_TIMEOUT_MS
            : (purpose ?? EXCHANGE_TIMEOUT_MS);
        pending = { resolve, reject, timer: setTimeout(lost, timeout) };
        input.write(framed, (error) => {
          if (error) lost();
        });
      });
    },
    close() {
      retire();
      return stop();
    },
    retire,
    lost,
    failed: () => failure !== undefined,
    onLost(listener: () => void) {
      if (failure) {
        listener();
        return () => {};
      }
      lostListeners.add(listener);
      return () => {
        lostListeners.delete(listener);
      };
    },
  };
}

export type PickerProofPipe = Pick<
  ReturnType<typeof makePickerProofPipe>,
  "exchange" | "close" | "onLost"
>;

export function connectPickerProofPipe(socketPath: string): PickerProofPipe {
  const socket = createConnection({ path: socketPath });
  const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  return makePickerProofPipe(socket, socket, () => {
    socket.destroy();
    return closed;
  });
}

export function spawnPickerProofPipe(
  binary: string,
  args: readonly string[],
  cwd: string,
  enableAgentProxy: boolean,
  enablePickerCancellation = false,
  supervised = false,
  options: PickerProofSpawnOptions = {},
) {
  if (Number(enableAgentProxy) + Number(enablePickerCancellation) + Number(supervised) > 1)
    throw new PickerProofOwnerError("invalidOperands");
  const environment = options.environment ?? {
    BIGBUD_SSH_OWNER_PICKER_PROOF: "1",
    HOME: cwd,
    PATH: "/usr/bin:/bin",
  };
  const clear = options.clearEnvironment === true && process.platform !== "win32";
  const command = clear ? "/usr/bin/env" : binary;
  const commandArgs = clear
    ? [
        "-i",
        ...Object.entries(environment).map(([key, value]) => `${key}=${value}`),
        binary,
        ...args,
      ]
    : args;
  const child = spawn(command, commandArgs, {
    cwd,
    env: clear ? {} : { ...environment },
    stdio: [
      "pipe",
      "pipe",
      "pipe", // Drain startup diagnostics at FD 2; agent proxy remains at FDs 3–5.
      ...(enableAgentProxy
        ? (["pipe", "pipe", "pipe"] as const)
        : enablePickerCancellation || supervised
          ? (["pipe"] as const)
          : []),
    ],
  });
  const { stdin: controlInput, stdout: controlOutput, stderr: startupOutput } = child;
  // Node's declarations model only five stdio entries; the runtime accepts more.
  const streams: readonly (Readable | Writable | null | undefined)[] = child.stdio;
  const [, , , stdin, stdout, stderr] = streams;
  if (!controlInput || !controlOutput || !startupOutput) {
    child.on("error", () => {});
    child.kill("SIGKILL");
    throw new PickerProofOwnerError("ownerUnavailable");
  }
  const startupDiagnostic = readPickerProofStartupConfigDiagnostic(startupOutput);
  const closeAgentPipes = () => {
    stdin?.destroy();
    stdout?.destroy();
    stderr?.destroy();
  };
  let agentPipesTaken = false;
  let stopTimer: NodeJS.Timeout | undefined;
  let inputEnded: Promise<void> | undefined;
  let finished = false;
  const exited = new Promise<void>((resolve) => {
    child.once("close", () => {
      finished = true;
      if (stopTimer) clearTimeout(stopTimer);
      resolve();
    });
  });
  const endInput = () =>
    (inputEnded ??= new Promise<void>((resolve) => controlInput.end(() => resolve())));
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  };
  const pipe = makePickerProofPipe(controlInput, controlOutput, () => {
    closeAgentPipes();
    void endInput();
    if (!finished && !stopTimer) {
      stopTimer = setTimeout(kill, EXIT_TIMEOUT_MS);
      stopTimer.unref();
    }
    return exited;
  });
  child.on("error", pipe.lost);
  // Raw channel errors remain visible on the streams, including before a lease
  // is returned. Do not read or copy bytes here (including during acquisition).
  for (const stream of [stdin, stdout, stderr]) stream?.on("error", () => {});

  let startupTimedOut = false;
  let startupTimer: NodeJS.Timeout | undefined;
  const sealStartup = () => {
    if (startupTimer) clearTimeout(startupTimer);
    startupTimer = undefined;
  };
  if (options.startupDeadlineMs !== undefined) {
    startupTimer = setTimeout(() => {
      // A protocol failure already owns the shutdown path; do not mask its type.
      if (pipe.failed()) return;
      startupTimedOut = true;
      pipe.lost();
      kill();
    }, options.startupDeadlineMs);
    startupTimer.unref();
  }

  return {
    exchange: pipe.exchange,
    close: pipe.close,
    onLost: pipe.onLost,
    sealStartup,
    startupTimedOut: () => startupTimedOut,
    ...startupDiagnostic,
    sendPickerCancellation(id: Uint8Array) {
      if (
        enablePickerCancellation &&
        id.length === 16 &&
        stdin instanceof Socket &&
        !stdin.destroyed
      )
        stdin.write(Buffer.from(id), (error) => {
          if (error) pipe.lost();
        });
    },
    takeAgentProxyPipes() {
      if (agentPipesTaken) throw new PickerProofOwnerError("operationDenied");
      if (!(stdin instanceof Socket && stdout instanceof Socket && stderr instanceof Socket)) {
        throw new PickerProofOwnerError("ownerUnavailable");
      }
      agentPipesTaken = true;
      return { pipes: { stdin, stdout, stderr }, dispose: closeAgentPipes };
    },
    detach() {
      // Retire before EOF: closing inherited stdio must not arm the process kill timer.
      pipe.retire();
      if (!supervised) closeAgentPipes();
      return endInput();
    },
    async retireSupervised() {
      if (!supervised || !(stdin instanceof Socket))
        throw new PickerProofOwnerError("invalidOperands");
      pipe.retire();
      void endInput();
      stdin.end();
      const deadline = setTimeout(kill, 35_000);
      try {
        await exited;
        if (child.exitCode !== 0) throw new PickerProofOwnerError("ownerUnavailable");
      } finally {
        clearTimeout(deadline);
      }
    },
    killForTest() {
      pipe.retire();
      closeAgentPipes();
      kill();
      return exited;
    },
  };
}
