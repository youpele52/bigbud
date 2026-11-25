// Usage (from a package.json dev script): node ../../scripts/dev-supervise.ts 'name=command' ...
// See dev-supervise.lib.ts for why dev tasks need this under turbo.
import { execFileSync, spawn, type StdioOptions } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEV_SSH_OWNER_RETAIN_ENV, DEV_SSH_OWNER_RETAIN_MARKER } from "@bigbud/shared/DevLauncher";
import { launchRetainedDevSshOwner } from "./lib/dev-ssh-owner-supervisor.ts";
import {
  DevSupervisor,
  parseDevCommands,
  type DevCommand,
  type DevSupervisorHost,
  type SupervisedProcess,
} from "./dev-supervise.lib.ts";
import { killTreeWindows, processAlive, processTree } from "./lib/dev-process-tree.ts";

const windows = process.platform === "win32";
let retained: { bun: string; launcher: ReturnType<typeof launchRetainedDevSshOwner> } | undefined;

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

const host: DevSupervisorHost = {
  spawn(command: DevCommand, prefixOutput: boolean): SupervisedProcess {
    const env = { ...process.env };
    // Piped output is not a TTY; keep the colours the tools would print in the terminal.
    if (prefixOutput && process.stdout.isTTY && env.FORCE_COLOR === undefined)
      env.FORCE_COLOR = "1";
    const stdio: StdioOptions = prefixOutput ? ["inherit", "pipe", "pipe"] : "inherit";
    if (retained) env[DEV_SSH_OWNER_RETAIN_ENV] = "1";
    const child = retained
      ? spawn(retained.bun, ["run", "--no-env-file", "src/bin.ts"], { env, stdio, detached: true })
      : spawn(command.command, { shell: true, env, stdio });
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
        child.once(retained ? "close" : "exit", listener);
      },
    };
  },
  processTree,
  signal(pid, signal) {
    if (windows) {
      killTreeWindows(pid);
      return;
    }
    process.kill(pid, signal);
  },
  alive: processAlive,
  parentPid: () => process.ppid,
  onSignal(signal, listener) {
    process.on(signal, listener);
  },
  setTimer: (callback, ms) => setTimeout(callback, ms),
  setRepeating: (callback, ms) => setInterval(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as NodeJS.Timeout),
  log: (message) => process.stderr.write(`${message}\n`),
  exit(code) {
    if (!retained) process.exit(code);
    void retained.launcher.stop().then(
      () => process.exit(code),
      () => {
        host.log("dev-supervise: disposable SSH fixture retirement failed");
        process.exit(1);
      },
    );
  },
};

const commands = parseDevCommands(process.argv.slice(2));
const profile = process.env.BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE;
const binary = process.env.BIGBUD_SSH_OWNER_BIN;
const selected =
  profile && lstatSync(join(profile, DEV_SSH_OWNER_RETAIN_MARKER), { throwIfNoEntry: false });
if (selected) {
  if (
    process.platform !== "darwin" ||
    process.env.BIGBUD_SSH_OWNER !== "1" ||
    process.env.BIGBUD_SSH_OWNER_NORMAL_DEV_READY !== "1" ||
    !binary ||
    commands.length !== 1 ||
    commands[0]?.name !== "server" ||
    commands[0].command !== "bun run src/bin.ts"
  ) {
    throw new Error("SSH owner retention requires the isolated macOS Bun dev launcher.");
  }
  const parent = process.ppid;
  const bun = realpathSync(
    execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8", timeout: 2_000 }).trim(),
  );
  const launcher = launchRetainedDevSshOwner({ bun, profile, binary, home: process.env.HOME });
  retained = { bun, launcher };
  let startupInterrupted = false;
  const earlyStop = () => {
    startupInterrupted = true;
    void launcher.stop().catch(() => {});
  };
  const signals = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
  for (const signal of signals) process.once(signal, earlyStop);
  try {
    await launcher.ready;
    if (startupInterrupted || process.ppid !== parent)
      throw new Error("The dev launcher stopped before SSH fixture startup.");
  } catch {
    await launcher.stop().catch(() => {});
    throw new Error("The supervised SSH fixture failed to start; no backend was launched.");
  } finally {
    for (const signal of signals) process.off(signal, earlyStop);
  }
  const supervisor = new DevSupervisor(commands, host, undefined, 1);
  void launcher.exited.then(() => supervisor.stop("SIGTERM", 1));
  supervisor.start();
} else {
  new DevSupervisor(commands, host).start();
}
