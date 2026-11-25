import { execFile, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";

const run = promisify(execFile);
const optedIn = process.env.BIGBUD_TEST_AGENT_REPLACEMENT === "approved-disposable";
const entry = fileURLToPath(
  new URL("./remoteAgentReplacement.acceptance.fixture.ts", import.meta.url),
);
const image = "sha256:fbfb4059d2127120aa05b6e6064523d2102552f0cf0026ddf0701c12f1f8f3e0";
const requesterEnvironment = { PATH: "/usr/bin:/bin" };

type BackendResult = {
  readonly backendPid: number;
  readonly resourceId: string;
  readonly cursor: number;
  readonly epoch: string;
  readonly instance: string;
  readonly stdout?: string;
};

function waitForSupervisor(child: ChildProcess) {
  const exited = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Supervisor process exited with ${code ?? signal}`));
    });
  });
  // Observe an early exit even if the caller is still waiting for readiness.
  void exited.catch(() => undefined);
  return exited;
}

function requireSetting(key: string): string {
  const value = process.env[key];
  if (!value || !path.isAbsolute(value)) throw new Error(`Expected an absolute ${key}`);
  return value;
}

it.skipIf(!optedIn)(
  "fences an old mutation and its cursor across backend and real Linux supervisor replacement",
  async () => {
    const agent = await realpath(requireSetting("BIGBUD_TEST_AGENT_REPLACEMENT_BIN"));
    const socket = await realpath(requireSetting("BIGBUD_TEST_AGENT_REPLACEMENT_DOCKER_SOCKET"));
    // OrbStack dispatches this executable by argv[0]. Keep the docker symlink name.
    const docker = (await run("/usr/bin/which", ["docker"])).stdout.trim();
    expect(path.isAbsolute(docker)).toBe(true);
    const bun = await realpath((await run("/usr/bin/which", ["bun"])).stdout.trim());
    const sha256 = process.env.BIGBUD_TEST_AGENT_REPLACEMENT_SHA256 ?? "";
    expect(sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await stat(socket).then((status) => status.isSocket())).toBe(true);
    expect(agent).toMatch(/^\/private\/tmp\/bb-agent-replacement\.[^/]+\/bigbud-remote-agent$/);
    const digest = createHash("sha256");
    for await (const buffer of createReadStream(agent)) digest.update(buffer);
    expect(digest.digest("hex")).toBe(sha256);

    const root = await mkdtemp("/private/tmp/bb-agent-replacement-run.");
    const dockerConfig = path.join(root, "docker");
    const dockerHost = `unix://${socket}`;
    const global = ["--config", dockerConfig, "--host", dockerHost];
    const command = (args: readonly string[], timeout = 5_000) =>
      run(docker, [...global, ...args], { timeout, env: requesterEnvironment });
    const containerArgs = ["exec", "--env", "BIGBUD_AGENT_STATE_DIR=/proof/state"];
    const cidFile = path.join(root, "container-id");
    let container: string | undefined;
    const agents: Array<{ child: ChildProcess; exited: Promise<void> }> = [];
    try {
      await mkdir(dockerConfig, { mode: 0o700 });
      const imageArch = await command(["image", "inspect", "--format", "{{.Architecture}}", image]);
      expect(imageArch.stdout.trim()).toBe("arm64");
      container = (
        await command([
          "run",
          "--detach",
          "--rm",
          "--cidfile",
          cidFile,
          "--pull",
          "never",
          "--label",
          `bigbud.test.remote-agent-replacement=${randomUUID()}`,
          "--network",
          "none",
          "--user",
          "65534:65534",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--read-only",
          "--tmpfs",
          "/proof:rw,noexec,nosuid,size=16m,mode=0700,uid=65534,gid=65534",
          "--mount",
          `type=bind,source=${agent},target=/agent,readonly`,
          "--entrypoint",
          "/usr/bin/sleep",
          image,
          "infinity",
        ])
      ).stdout.trim();
      expect(container).toMatch(/^[a-f0-9]{64}$/);
      const id = container;
      const agentCommand = (arg: string) => command([...containerArgs, id, "/agent", arg], 12_000);
      expect((await agentCommand("--check")).stdout).toMatch(/\t1\t9\t[^\t]+\tlinux\taarch64/);
      await command(["exec", id, "/usr/bin/mkdir", "-m", "700", "/proof/workspace"]);
      const start = async () => {
        const child = spawn(docker, [...global, ...containerArgs, id, "/agent", "--supervisor"], {
          env: requesterEnvironment,
          stdio: "ignore",
        });
        const exited = waitForSupervisor(child);
        agents.push({ child, exited });
        await vi.waitFor(
          () => command(["exec", id, "/usr/bin/test", "-S", "/proof/state/supervisor.sock"]),
          { timeout: 6_000, interval: 100 },
        );
        return { exited };
      };
      const backend = async (stage: "original" | "replacement") => {
        const { stdout } = await run(bun, ["run", "--no-env-file", entry], {
          cwd: root,
          env: {
            ...requesterEnvironment,
            HOME: root,
            BB_REPLACEMENT_STAGE: stage,
            BB_REPLACEMENT_CONTAINER: id,
            BB_REPLACEMENT_DOCKER: docker,
            BB_REPLACEMENT_DOCKER_CONFIG: dockerConfig,
            BB_REPLACEMENT_DOCKER_HOST: dockerHost,
            BB_REPLACEMENT_AGENT_SHA: sha256,
            BB_REPLACEMENT_DB: path.join(root, "backend.sqlite"),
          },
          timeout: 15_000,
        });
        return JSON.parse(stdout) as BackendResult;
      };
      const firstAgent = await start();
      const first = await backend("original");
      expect(first.cursor).toBeGreaterThan(0);
      expect((await agentCommand("--restart-supervisor")).stdout.trim()).toBe("restart-accepted");
      await firstAgent.exited;
      // A dead process or a responsive endpoint is not by itself a usable replay route.
      // Start a new process at exactly the same slot and keep the backend database inode.
      const database = path.join(root, "backend.sqlite");
      const originalDb = await stat(database);
      const secondAgent = await start();
      const second = await backend("replacement");
      expect(second).toMatchObject({
        resourceId: first.resourceId,
        cursor: first.cursor,
        stdout: "original\nfresh\n",
      });
      expect(second.backendPid).not.toBe(first.backendPid);
      expect(second.instance).not.toBe(first.instance);
      expect(second.epoch).not.toBe(first.epoch);
      expect(await stat(database)).toMatchObject({ ino: originalDb.ino, dev: originalDb.dev });
      expect((await agentCommand("--shutdown-supervisor")).stdout.trim()).toBe("shutdown-accepted");
      await secondAgent.exited;
    } finally {
      try {
        // The daemon may have allocated the fixture even if its client's response was lost.
        const cleanupId = container ?? (await readFile(cidFile, "utf8").catch(() => "")).trim();
        if (/^[a-f0-9]{64}$/.test(cleanupId)) await command(["rm", "--force", cleanupId]);
      } finally {
        for (const { child } of agents) {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }
        await Promise.allSettled(agents.map(({ exited }) => exited));
        await rm(root, { recursive: true, force: true });
      }
    }
  },
  60_000,
);
