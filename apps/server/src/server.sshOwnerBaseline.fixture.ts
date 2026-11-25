import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_SERVER_SETTINGS } from "@bigbud/contracts/settings";

const sandbox = "/usr/bin/sandbox-exec";
const host = "127.0.0.1";
const entry = fileURLToPath(new URL("./bin.ts", import.meta.url));
const tools = ["ssh", "ssh-keygen", "ssh-keyscan", "ssh-add", "ssh-agent"];
export const alias = "ssh-owner-baseline.invalid";

interface Launch {
  readonly tool: string;
  readonly args: string[];
  readonly pid: number;
  readonly ppid: number;
  readonly cwd: string;
  readonly home: string;
  readonly path: string;
}

// Never interpret the remote command, access SSH config, or delegate to a real executable.
const recorder = String.raw`
import { appendFileSync } from "node:fs";
import { basename } from "node:path";
const [launcher, ...args] = process.argv.slice(2);
const tool = basename(launcher);
appendFileSync(process.env.BASELINE_LAUNCHES, JSON.stringify({
  tool, args, pid: process.pid, ppid: process.ppid, cwd: process.cwd(),
  home: process.env.HOME, path: process.env.PATH,
}) + "\n");
if (tool !== "ssh" || !args.includes("ssh-owner-baseline.invalid") ||
    !args.at(-1)?.includes("BIGBUD_REMOTE_FOLDERS_V1")) process.exit(91);
process.stdout.write("BIGBUD_REMOTE_FOLDERS_V1\0/fixture\0/fixture/selected\0g\tZ repo\0d\talpha\0");
`;

async function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const { port } = server.address() as net.AddressInfo;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

export async function makeBaselineFixture() {
  // Opting in on a host without the required isolation must fail, not run unsandboxed.
  if (process.platform !== "darwin" || process.getuid?.() === 0) {
    throw new Error("S0 V-B baseline requires non-root macOS with sandbox-exec and source Bun.");
  }
  const checkout = await realpath(path.resolve(path.dirname(entry), "../../.."));
  const bun = await realpath(
    execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8", timeout: 2_000 }).trim(),
  );
  const ambientHomes = new Set([userInfo().homedir, homedir()]);
  for (const home of ambientHomes) ambientHomes.add(await realpath(home));
  const root = await mkdtemp("/private/tmp/bigbud-ssh-owner-vb-");
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const base = path.join(root, "base");
  const state = path.join(base, "userdata");
  const log = path.join(root, "launches.jsonl");
  const program = path.join(root, "recorder.ts");
  const token = `synthetic-vb-${randomUUID()}`;
  try {
    await mkdir(home);
    await mkdir(bin);
    await mkdir(state, { recursive: true });
    await writeFile(log, "");
    await writeFile(program, recorder);
    const launchers = tools.map((name) => path.join(bin, name));
    for (const launcher of launchers) {
      await writeFile(
        launcher,
        '#!/bin/sh\nexec "$BASELINE_BUN" run --no-env-file "$BASELINE_RECORDER" "$0" "$@"\n',
        { mode: 0o700 },
      );
    }
    await writeFile(
      path.join(state, "settings.json"),
      JSON.stringify({
        providers: Object.fromEntries(
          Object.keys(DEFAULT_SERVER_SETTINGS.providers).map((provider) => [
            provider,
            { enabled: false },
          ]),
        ),
      }),
    );
    const port = await reservePort();
    const policy = path.join(root, "sandbox.sb");
    await writeFile(
      policy,
      [
        "(version 1)",
        "(allow default)",
        "(deny network*)",
        `(allow network-bind network-inbound (local ip "localhost:${port}"))`,
        "(deny file-write*)",
        `(allow file-write* (subpath ${JSON.stringify(root)}) (literal "/dev/null"))`,
        ...[...ambientHomes, "/etc/ssh", "/private/etc/ssh"].map(
          (dir) => `(deny file-read* (subpath ${JSON.stringify(dir)}))`,
        ),
        `(allow file-read* (subpath ${JSON.stringify(checkout)}) (literal ${JSON.stringify(bun)}))`,
        "(deny process-exec)",
        // macOS /bin/sh can exec /bin/bash as its built-in sh variant.
        `(allow process-exec ${[bun, "/bin/sh", "/bin/bash", ...launchers].map((file) => `(literal ${JSON.stringify(file)})`).join(" ")})`,
      ].join("\n"),
    );
    return {
      root,
      home,
      bin,
      db: path.join(state, "state.sqlite"),
      httpUrl: `http://${host}:${port}/ws`,
      wsUrl: `ws://${host}:${port}/ws?token=${token}`,
      readLaunches: async (): Promise<Launch[]> => {
        const events = (await readFile(log, "utf8")).trim();
        return events ? events.split("\n").map((line) => JSON.parse(line)) : [];
      },
      start: () =>
        spawn(
          sandbox,
          [
            "-f",
            policy,
            bun,
            "run",
            "--no-env-file",
            entry,
            "--mode",
            "desktop",
            "--host",
            host,
            "--port",
            String(port),
            "--base-dir",
            base,
            "--no-browser",
            "--auth-token",
            token,
          ],
          {
            cwd: root,
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              HOME: home,
              TMPDIR: root,
              PATH: bin,
              SHELL: "/bin/sh",
              LC_ALL: "C",
              GIT_CONFIG_NOSYSTEM: "1",
              BIGBUD_TELEMETRY_ENABLED: "false",
              BIGBUD_DISABLE_CLIPROXY: "1",
              BIGBUD_REMOTE_MOBILE_ENABLED: "false",
              BIGBUD_TERMINAL_HOST: "0",
              BASELINE_BUN: bun,
              BASELINE_RECORDER: program,
              BASELINE_LAUNCHES: log,
            },
          },
        ),
      dispose: () => rm(root, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

async function withDeadline<A>(promise: Promise<A>, ms: number, message: () => string): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message())), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function stopServer(
  child: ChildProcess,
  done: Promise<void>,
  getOutput: () => string,
  stopSignal: "SIGTERM" | "SIGKILL",
) {
  // Signal only the subprocess this fixture created, never a PID read from backend state.
  if (child.exitCode === null && child.signalCode === null) child.kill(stopSignal);
  try {
    await withDeadline(
      done,
      5_000,
      () => `V-B source backend did not stop on ${stopSignal}:\n${getOutput()}`,
    );
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await withDeadline(done, 5_000, () => `V-B source backend did not exit:\n${getOutput()}`);
    throw error;
  }
}

export async function withBaselineServer<A>(
  child: ChildProcess,
  run: (pid: number) => Promise<A>,
  stopSignal: "SIGTERM" | "SIGKILL" = "SIGTERM",
) {
  let output = "";
  const startup = Promise.withResolvers<void>();
  const done = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const record = (data: Buffer) => {
    output = (output + data.toString()).slice(-16_384);
    if (output.includes("[startup] status=error")) startup.reject(new Error(output));
    if (output.includes("[startup] status=ready")) startup.resolve();
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  child.on("error", (error) => startup.reject(error));
  child.once("close", (code, signal) => {
    startup.reject(
      new Error(`V-B source backend exited before readiness (${code ?? signal}):\n${output}`),
    );
  });
  const livePid = () => {
    if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`V-B source backend is no longer running:\n${output}`);
    }
    return child.pid;
  };
  try {
    await withDeadline(
      startup.promise,
      30_000,
      () => `V-B source backend never became ready:\n${output}`,
    );
    const result = await run(livePid());
    livePid();
    return result;
  } finally {
    await stopServer(child, done, () => output, stopSignal);
  }
}
