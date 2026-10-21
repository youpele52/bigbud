// Usage (from a package.json dev script): node ../../scripts/dev-supervise.ts 'name=command' ...
// See dev-supervise.lib.ts for why dev tasks need this under turbo.
import { spawn, spawnSync } from "node:child_process";
import {
  DevSupervisor,
  parseDevCommands,
  type DevCommand,
  type DevSupervisorHost,
  type SupervisedProcess,
} from "./dev-supervise.lib.ts";

const windows = process.platform === "win32";

/** Prefix each output line with the command name, as `bun run --parallel` did. */
function pipeWithPrefix(
  source: NodeJS.ReadableStream | null,
  target: NodeJS.WriteStream,
  name: string,
): void {
  if (!source) return;
  let partial = "";
  source.setEncoding("utf8");
  source.on("data", (chunk: string) => {
    const lines = (partial + chunk).split("\n");
    partial = lines.pop() ?? "";
    if (lines.length > 0) target.write(lines.map((line) => `${name} | ${line}\n`).join(""));
  });
  source.on("end", () => {
    if (partial) target.write(`${name} | ${partial}\n`);
    partial = "";
  });
}

function processTree(root: number): number[] {
  if (windows) return [root];
  const listing = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of listing.stdout.split("\n")) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || ppid === undefined || Number.isNaN(ppid)) continue;
    children.set(ppid, [...(children.get(ppid) ?? []), pid]);
  }
  const tree: number[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const pid = pending.pop()!;
    if (tree.includes(pid)) continue;
    tree.push(pid);
    pending.push(...(children.get(pid) ?? []));
  }
  return tree;
}

const host: DevSupervisorHost = {
  spawn(command: DevCommand, prefixOutput: boolean): SupervisedProcess {
    const env = { ...process.env };
    // Piped output is not a TTY; keep the colours the tools would print in the terminal.
    if (prefixOutput && process.stdout.isTTY && env.FORCE_COLOR === undefined)
      env.FORCE_COLOR = "1";
    const child = spawn(command.command, {
      shell: true,
      env,
      stdio: prefixOutput ? ["inherit", "pipe", "pipe"] : "inherit",
    });
    if (prefixOutput) {
      pipeWithPrefix(child.stdout, process.stdout, command.name);
      pipeWithPrefix(child.stderr, process.stderr, command.name);
    }
    child.on("error", (error) => {
      process.stderr.write(`${command.name} | failed to start: ${error.message}\n`);
    });
    return {
      pid: child.pid,
      onExit: (listener) => {
        child.once("exit", listener);
      },
    };
  },
  processTree,
  signal(pid, signal) {
    if (windows) {
      // No POSIX signals or process groups: end the whole tree.
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
      return;
    }
    process.kill(pid, signal);
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      // ESRCH: gone. EPERM: the PID was reused by another user's process; not ours to wait on.
      return false;
    }
  },
  parentPid: () => process.ppid,
  onSignal(signal, listener) {
    process.on(signal, listener);
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  setRepeating: (callback, ms) => setInterval(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  log: (message) => process.stderr.write(`${message}\n`),
  exit: (code) => process.exit(code),
};

new DevSupervisor(parseDevCommands(process.argv.slice(2)), host).start();
