import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, mkdtemp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { spawn, type IPty } from "node-pty";
import { Terminal } from "@xterm/headless";

interface QualificationOptions {
  startup?: Partial<Record<".zshenv" | ".zprofile" | ".zshrc" | ".zlogin", string>>;
  login?: boolean;
  cols?: number;
}

export interface ShellSnapshot {
  buffer: string;
  display: string;
  cursor: number;
  accepts: number;
  tabs: number;
  rights: number;
  revision: number;
  suspended: number;
  sequence: number;
  deadline: number;
  clock: number;
  revoked: number;
}

/** Local qualification only; not an adapter or a production control transport. */
export async function createZshQualification(options: QualificationOptions = {}) {
  const home = await mkdtemp(join(tmpdir(), "bigbud-zsh-qualification-"));
  await chmod(home, 0o700);
  const runtime = join(home, "runtime");
  await mkdir(runtime, { mode: 0o700 });
  const controlPath = join(runtime, "control");
  const statusPath = join(runtime, "status");
  const session = randomUUID();
  const lease = randomUUID();
  let pty: IPty | undefined;
  let exited = false;
  let control: Awaited<ReturnType<typeof open>> | undefined;
  let status: Awaited<ReturnType<typeof open>> | undefined;
  let sequence = 0;
  let controlClosed = false;
  const terminal = new Terminal({ cols: options.cols ?? 100, rows: 24, allowProposedApi: true });
  const dispose = async () => {
    if (pty && !exited) {
      // node-pty owns a separate POSIX session. Never signal the user's shell.
      process.kill(-pty.pid, "SIGKILL");
      await waitFor(async () => exited);
    }
    if (!controlClosed) await control?.close();
    await status?.close();
    terminal.dispose();
    await rm(home, { recursive: true, force: true });
  };
  try {
    execFileSync("/usr/bin/mkfifo", ["-m", "600", controlPath, statusPath]);
    const fixture = await readFile(
      new URL("./ZshSuggestions.prototype.zsh", import.meta.url),
      "utf8",
    );
    // Fixed trusted fixture bytes copied outside the workspace, not a workspace source command.
    // This is a controlled startup envelope, NOT the production ZDOTDIR chaining wrapper.
    for (const name of [".zshenv", ".zprofile", ".zshrc", ".zlogin"] as const) {
      const installHere = name === (options.login ? ".zlogin" : ".zshrc");
      await writeFile(
        join(home, name),
        `${options.startup?.[name] ?? ""}\n${installHere ? fixture : ""}`,
        {
          mode: 0o600,
        },
      );
    }
    await writeFile(join(home, "history"), "", { mode: 0o600 });
    // Controller RDWR opens avoid FIFO startup deadlock; shell holds only the proper direction.
    control = await open(controlPath, constants.O_RDWR | constants.O_NONBLOCK);
    status = await open(statusPath, constants.O_RDWR | constants.O_NONBLOCK);
    pty = spawn("/bin/zsh", options.login ? ["-l", "-i"] : ["-i"], {
      cwd: home,
      name: "xterm-256color",
      cols: options.cols ?? 100,
      rows: 24,
      env: {
        HOME: home,
        ZDOTDIR: home,
        PATH: "/usr/bin:/bin",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        BIGBUD_QUALIFICATION_SESSION: session,
        BIGBUD_QUALIFICATION_LEASE: lease,
      },
    });
    pty.onExit(() => {
      exited = true;
    });
    // Only synthetic disposable-home data reaches this test-local emulator; never log output.
    pty.onData((data) => terminal.write(data));
    const snapshot = async (): Promise<ShellSnapshot> => {
      const text = await readFile(join(home, "snapshot"), "utf8");
      // zsh counts Unicode code points; length framing also handles multiline/control buffers.
      const first = text.indexOf("\n");
      const second = text.indexOf("\n", first + 1);
      const bufferLength = Number(text.slice(0, first));
      const displayLength = Number(text.slice(first + 1, second));
      const content = Array.from(text.slice(second + 1));
      const buffer = content.slice(0, bufferLength).join("");
      const display = content.slice(bufferLength, bufferLength + displayLength).join("");
      const numbers = content
        .slice(bufferLength + displayLength)
        .join("")
        .trimEnd()
        .split("\n");
      if (first < 0 || second < 0 || numbers.length !== 10) {
        throw new Error("Incomplete fixture snapshot");
      }
      const [cursor, accepts, tabs, rights, revision, suspended, seq, deadline, clock, revoked] =
        numbers.map(Number);
      return {
        buffer,
        display,
        cursor: cursor!,
        accepts: accepts!,
        tabs: tabs!,
        rights: rights!,
        revision: revision!,
        suspended: suspended!,
        sequence: seq!,
        deadline: deadline!,
        clock: clock!,
        revoked: revoked!,
      };
    };
    const readStatus = async () => {
      const buffer = Buffer.alloc(512);
      try {
        const { bytesRead } = await status!.read(buffer, 0, buffer.length, null);
        return buffer.toString("utf8", 0, bytesRead);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") return "";
        throw error;
      }
    };
    let available = false;
    await waitFor(async () => {
      const outcome = await readFile(join(home, "qualification-status"), "utf8");
      available = outcome.trim() === "ready";
      return available || outcome.trim() === "unavailable";
    });
    if (available) {
      await waitFor(async () => (await readStatus()) === `v1 ${session} ${lease} ready\n`);
      await waitFor(async () => Boolean(await snapshot()));
    }
    return {
      home,
      available,
      isAlternateScreen() {
        return terminal.buffer.active.type === "alternate";
      },
      async screen() {
        await new Promise<void>((resolve) => terminal.write("", resolve));
        const buffer = terminal.buffer.active;
        return Array.from(
          { length: buffer.length },
          (_, row) => buffer.getLine(row)?.translateToString(true) ?? "",
        ).join("\n");
      },
      resize(cols: number) {
        terminal.resize(cols, 24);
        pty!.resize(cols, 24);
      },
      snapshot,
      readStatus,
      write(data: string) {
        if (exited) throw new Error("Qualification PTY exited");
        pty!.write(data);
      },
      async grant() {
        const deadline = (await snapshot()).clock + 0.9;
        const seq = ++sequence;
        await control!.write(`v1 ${session} ${lease} ${seq} grant ${deadline.toFixed(9)}\n`);
        // Test-local observation, not a production control acknowledgement.
        await waitFor(async () => (await snapshot()).sequence === seq);
        if ((await snapshot()).suspended) throw new Error("Fixture grant was rejected");
      },
      async frame(operation: "grant" | "suspend", deadline: number, seq = ++sequence) {
        await control!.write(`v1 ${session} ${lease} ${seq} ${operation} ${deadline.toFixed(9)}\n`);
        return seq;
      },
      async rawFrame(frame: string) {
        await control!.write(frame);
      },
      encodeFrame(operation: "grant" | "suspend", deadline: number, seq: number) {
        return `v1 ${session} ${lease} ${seq} ${operation} ${deadline.toFixed(9)}\n`;
      },
      async closeControl() {
        await control!.close();
        controlClosed = true;
      },
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}

async function waitFor(predicate: () => Promise<boolean>, timeout = 5000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) {
    try {
      if (await predicate()) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await delay(10);
  }
  throw new Error("Timed out waiting for isolated zsh fixture");
}
