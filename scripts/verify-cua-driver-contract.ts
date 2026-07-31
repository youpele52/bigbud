import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs";
import * as FSP from "node:fs/promises";
import * as OS from "node:os";
import * as Path from "node:path";

import { makeCuaDriverChildEnvironment } from "@bigbud/shared/cua-driver/childEnvironment";
import {
  cuaDriverEmbeddedEnvironment,
  cuaDriverMcpArguments,
  cuaDriverServeArguments,
} from "@bigbud/shared/cua-driver/invocation";
import {
  CUA_DRIVER_POLICY_YAML,
  CUA_DRIVER_REQUIRED_TOOLS,
} from "@bigbud/shared/cua-driver/policy";
import {
  cuaDriverReleaseUrl,
  resolveCuaDriverReleaseArtifact,
  type CuaDriverRuntimeArch,
  type CuaDriverRuntimePlatform,
} from "@bigbud/shared/cua-driver/release";

const ROOT = Path.resolve(import.meta.dirname, "..");
const FIXTURE_DIR = Path.join(ROOT, "scripts", "fixtures", "cua-driver", "0.9.1");
const REQUEST_TIMEOUT_MS = 30_000;
const CONTRACT_HOST_BUNDLE_ID = "ai.bigbud.desktop.contract-test";

function run(command: string, args: readonly string[], env?: NodeJS.ProcessEnv): string {
  const result = ChildProcess.spawnSync(command, [...args], {
    env,
    encoding: "utf8",
    shell: false,
    timeout: REQUEST_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed: ${String(result.stderr || result.stdout).trim()}`,
    );
  }
  return String(result.stdout).trim();
}

class NdjsonClient {
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();

  constructor(readonly child: ChildProcess.ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    child.once("exit", (code, signal) => {
      const error = new Error(`MCP proxy exited (code=${code}, signal=${signal}).`);
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    });
  }

  notify(method: string): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
  }

  request(id: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request '${method}' timed out.`));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`,
      );
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const lineEnd = this.buffer.indexOf("\n");
      if (lineEnd < 0) return;
      const line = this.buffer.subarray(0, lineEnd).toString("utf8").trim();
      this.buffer = this.buffer.subarray(lineEnd + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      if (typeof message.id !== "number") continue;
      const request = this.pending.get(message.id);
      if (!request) continue;
      this.pending.delete(message.id);
      if (message.error) request.reject(new Error(JSON.stringify(message.error)));
      else request.resolve(message.result);
    }
  }
}

async function waitForDaemon(binaryPath: string, endpoint: string, env: NodeJS.ProcessEnv) {
  const deadline = Date.now() + REQUEST_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = ChildProcess.spawnSync(binaryPath, ["status", "--socket", endpoint], {
      env,
      shell: false,
      stdio: "ignore",
    });
    if (result.status === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Pinned CUA daemon did not become ready.");
}

function sanitizeFixture(value: unknown, temporaryDir: string, key?: string): unknown {
  if (key === "pid" || key === "responsible_ppid") return 0;
  if (typeof value === "string") {
    const realTemporaryDir = FS.realpathSync(temporaryDir);
    return value
      .replaceAll(temporaryDir, "<TEMP_DIR>")
      .replaceAll(realTemporaryDir, "<TEMP_DIR>")
      .replace(/bigbud-contract-[0-9a-f-]{36}/g, "bigbud-contract-session");
  }
  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeFixture(entry, temporaryDir));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        sanitizeFixture(entry, temporaryDir, entryKey),
      ]),
    );
  }
  return value;
}

async function writeJson(name: string, value: unknown, temporaryDir: string): Promise<void> {
  await FSP.writeFile(
    Path.join(FIXTURE_DIR, name),
    `${JSON.stringify(sanitizeFixture(value, temporaryDir), null, 2)}\n`,
  );
}

async function main(): Promise<void> {
  const platform = process.platform as CuaDriverRuntimePlatform;
  const arch = process.arch as CuaDriverRuntimeArch;
  if (!(["darwin", "linux", "win32"] as const).includes(platform)) {
    throw new Error(`Unsupported fixture platform '${process.platform}'.`);
  }
  if (!(["arm64", "x64"] as const).includes(arch)) {
    throw new Error(`Unsupported fixture architecture '${process.arch}'.`);
  }
  const artifact = resolveCuaDriverReleaseArtifact(platform, arch);
  const temporaryDir = await FSP.mkdtemp(Path.join(OS.tmpdir(), "bigbud-cua-contract-"));
  const archivePath = Path.join(temporaryDir, artifact.archiveName);
  const extractDir = Path.join(temporaryDir, "extract");
  const policyPath = Path.join(temporaryDir, "bigbud.yaml");
  const endpoint =
    platform === "win32"
      ? `\\\\.\\pipe\\bigbud-cua-contract-${Crypto.randomUUID()}`
      : Path.join(temporaryDir, "cua.sock");
  let daemon: ChildProcess.ChildProcess | null = null;
  let proxy: ChildProcess.ChildProcessWithoutNullStreams | null = null;
  try {
    run("curl", ["-fsSL", "-o", archivePath, cuaDriverReleaseUrl(artifact)]);
    const digest = Crypto.createHash("sha256")
      .update(await FSP.readFile(archivePath))
      .digest("hex");
    if (digest !== artifact.sha256) throw new Error("Pinned CUA artifact checksum mismatch.");
    await FSP.mkdir(extractDir, { recursive: true });
    if (platform === "win32") {
      run("powershell.exe", [
        "-NoProfile",
        "-Command",
        "Expand-Archive",
        "-LiteralPath",
        archivePath,
        "-DestinationPath",
        extractDir,
        "-Force",
      ]);
    } else {
      run("tar", ["-xf", archivePath, "-C", extractDir]);
    }
    const binaryPath = Path.join(extractDir, ...artifact.binaryPath);
    await FSP.writeFile(policyPath, CUA_DRIVER_POLICY_YAML);
    await FSP.mkdir(FIXTURE_DIR, { recursive: true });
    const embedded = cuaDriverEmbeddedEnvironment(endpoint, CONTRACT_HOST_BUNDLE_ID);
    const env = makeCuaDriverChildEnvironment(process.env, {
      ...embedded,
      CUA_DRIVER_POLICY_FILE: policyPath,
    });
    const version = run(binaryPath, ["--version"], env);
    const manifest = JSON.parse(run(binaryPath, ["manifest"], env)) as unknown;
    daemon = ChildProcess.spawn(
      binaryPath,
      [
        ...cuaDriverServeArguments(endpoint, CONTRACT_HOST_BUNDLE_ID),
        "--no-permissions-gate",
        "--no-overlay",
      ],
      { env, stdio: ["ignore", "ignore", "pipe"], shell: false },
    );
    await waitForDaemon(binaryPath, endpoint, env);
    proxy = ChildProcess.spawn(
      binaryPath,
      [...cuaDriverMcpArguments(endpoint, CONTRACT_HOST_BUNDLE_ID)],
      {
        env,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
      },
    );
    const client = new NdjsonClient(proxy);
    await client.request(1, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bigbud-contract-harness", version: "1.0.0" },
    });
    client.notify("notifications/initialized");
    const toolsList = await client.request(2, "tools/list");
    const toolNames = new Set(
      (toolsList as { tools?: Array<{ name?: string }> }).tools?.flatMap((tool) =>
        typeof tool.name === "string" ? [tool.name] : [],
      ) ?? [],
    );
    const missing = CUA_DRIVER_REQUIRED_TOOLS.filter((name) => !toolNames.has(name));
    if (missing.length > 0) throw new Error(`Pinned CUA artifact lacks: ${missing.join(", ")}.`);
    const health = await client.request(3, "tools/call", {
      name: "health_report",
      arguments: {},
    });
    const permissions = await client.request(4, "tools/call", {
      name: "check_permissions",
      arguments: { prompt: false },
    });
    const session = `bigbud-contract-${Crypto.randomUUID()}`;
    const startSession = await client.request(5, "tools/call", {
      name: "start_session",
      arguments: { session, capture_scope: "auto" },
    });
    const sessionState = await client.request(6, "tools/call", {
      name: "get_session_state",
      arguments: { session },
    });
    const endSession = await client.request(7, "tools/call", {
      name: "end_session",
      arguments: { session },
    });
    let denied: unknown;
    try {
      denied = await client.request(8, "tools/call", {
        name: "kill_app",
        arguments: { name: "bigbud-policy-probe" },
      });
    } catch (error) {
      denied = { jsonRpcError: error instanceof Error ? error.message : String(error) };
    }
    const deniedText = JSON.stringify(denied);
    if (
      (denied as { isError?: boolean }).isError !== true &&
      !deniedText.includes("Permission denied")
    ) {
      throw new Error("Pinned production policy failed to block kill_app.");
    }
    await writeJson("manifest.json", { version, manifest, artifactSha256: digest }, temporaryDir);
    await writeJson("tools-list.json", toolsList, temporaryDir);
    await writeJson(`health-report.${platform}.json`, health, temporaryDir);
    await writeJson(`check-permissions.${platform}.json`, permissions, temporaryDir);
    await writeJson(
      "action-outcomes.json",
      { startSession, sessionState, endSession, denied },
      temporaryDir,
    );
    await FSP.writeFile(
      Path.join(FIXTURE_DIR, "README.md"),
      `# cua-driver 0.9.1 contract\n\nCaptured by \`bun run scripts/verify-cua-driver-contract.ts\` on ${platform}/${arch}. The harness uses production release metadata, child environment, invocation arguments, and policy bytes.\n`,
    );
  } finally {
    proxy?.kill("SIGTERM");
    daemon?.kill("SIGTERM");
    if (platform !== "win32") FS.rmSync(endpoint, { force: true });
    await FSP.rm(temporaryDir, { recursive: true, force: true });
  }
}

await main();
