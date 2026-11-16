import { emptyRemoteAgentRegistry } from "../remote-agent/remoteAgentInstall.registry.ts";
import { remoteAgentBuildId } from "../remote-agent/remoteAgentRuntime.ts";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";
import { makeLocalSupervisorControl } from "./localSupervisorControl.ts";
import { encodeLocalSupervisorServiceConfig } from "./localSupervisorService.config.ts";
import { makeLocalSupervisorServiceLauncher } from "./localSupervisorService.launch.ts";

const homes: string[] = [];
afterEach(async () => {
  for (const home of homes.splice(0)) await fs.rm(home, { recursive: true, force: true });
});

async function fixture(
  capability: boolean,
  options: {
    readonly startFailure?: boolean;
    readonly reservation?: "present" | "missing" | "deleting" | "retiring";
    readonly abort?: AbortController;
    readonly nativeRefusal?: boolean;
  } = {},
) {
  const { startFailure = false, reservation = "present", abort, nativeRefusal = false } = options;
  const homeDir = await fs.realpath(await fs.mkdtemp("/tmp/bs-"));
  homes.push(homeDir);
  const authority = "a".repeat(32);
  const bytes = "fixture-only nonexecutable content";
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const statePath = join(homeDir, ".bigbud/agent/runtimes/g1");
  const runtime: RemoteAgentRuntime = {
    generation: "g1",
    version: "0.3.3",
    sha256,
    buildDigest: "fixture",
    origin: "managed",
    targetTriple: "aarch64-unknown-linux-musl",
    statePath,
    binaryPath: join(homeDir, `.bigbud/agent/bin/0.3.3/${sha256}/bigbud-remote-agent`),
    socketPath: join(statePath, "supervisor.sock"),
    logPath: join(statePath, "supervisor.log"),
  };
  await fs.mkdir(dirname(runtime.binaryPath), { recursive: true, mode: 0o700 });
  await fs.mkdir(statePath, { recursive: true, mode: 0o700 });
  await fs.writeFile(runtime.binaryPath, bytes, { mode: 0o700 });
  const configPath = join(homeDir, ".bigbud/backend-services", authority, "config-v1");
  await fs.mkdir(dirname(configPath), { recursive: true, mode: 0o700 });
  const boot = "12345678-1234-1234-1234-123456789abc";
  await fs.writeFile(join(statePath, "launch.boot"), boot, { mode: 0o600 });
  await fs.writeFile(
    configPath,
    encodeLocalSupervisorServiceConfig({
      expected_installation_fingerprint: `sha256:${"c".repeat(64)}`,
      authority_reservation_sha256: "f".repeat(64),
      version: "1",
      authority,
      home: homeDir,
      backend_home: join(homeDir, "backend"),
      rust_binary: runtime.binaryPath,
      rust_sha256: sha256,
      rust_state: statePath,
      node_binary: join(homeDir, "node"),
      node_sha256: "b".repeat(64),
      backend_entry: join(homeDir, "server.mjs"),
      backend_sha256: "c".repeat(64),
      receipt_sha256: "d".repeat(64),
      restart: "no",
      launch_attempt: "prior",
      prior_epoch: "fresh",
      launch_boot: boot,
    }),
    { mode: 0o600 },
  );
  const commands: string[] = [];
  const control = makeLocalSupervisorControl({
    targetId: `remote-backend:${authority}`,
    homeDir,
    execute: async (_binary, args) => {
      const script = args[1]!;
      commands.push(script);
      if (script.includes("--check --capabilities")) abort?.abort();
      if (nativeRefusal && script.includes("--backend-service render"))
        throw new Error("native account reservation mismatch");
      if (startFailure && script.includes("--backend-service start-rust"))
        throw new Error("manager acknowledgment lost");
      return {
        code: 0,
        timedOut: false,
        signal: null,
        stdout: script.includes("--check --capabilities")
          ? capability
            ? "backend-service=2"
            : "protocol=1"
          : "",
        stderr: "",
      };
    },
  });
  const ownedControl = {
    ...control,
    openControl: async (target: string) => {
      const opened = await control.openControl(target);
      return {
        ...opened,
        registry: {
          ...opened.registry,
          update: async (transition: Parameters<typeof opened.registry.update>[0]) =>
            transition({
              ...emptyRemoteAgentRegistry(),
              builds: [
                {
                  id: remoteAgentBuildId(runtime),
                  runtime,
                  health: "staged",
                  promotion: 0,
                  binary: reservation === "deleting" ? "deleting" : "present",
                  authenticated: true,
                },
              ],
              retirementReservations:
                reservation === "retiring"
                  ? [
                      {
                        id: "retiring",
                        buildId: remoteAgentBuildId(runtime),
                        generation: runtime.generation,
                        phase: "reserved",
                      },
                    ]
                  : [],
              launches:
                reservation === "missing"
                  ? []
                  : [
                      {
                        id: runtime.generation,
                        buildId: remoteAgentBuildId(runtime),
                        attemptId: "attempt",
                        phase: "spawn-uncertain",
                        epoch: "pending",
                      },
                    ],
            }),
        },
      };
    },
  };
  return {
    runtime,
    commands,
    launcher: makeLocalSupervisorServiceLauncher({
      control: ownedControl,
      configPath,
      ...(abort ? { signal: abort.signal } : {}),
    }),
  };
}

describe("independent account service launch bridge", () => {
  it("refuses unsupported signed artifacts before preparing an intent or invoking new service flags", async () => {
    const f = await fixture(false);
    await expect(f.launcher.launch(f.runtime, "attempt")).rejects.toThrow("does not support");
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toContain("--check --capabilities");
  });
  it("rejects another managed root before filesystem preparation or service execution", async () => {
    const f = await fixture(true);
    await expect(
      f.launcher.launch({ ...f.runtime, statePath: "/other/agent/runtimes/g1" }, "attempt"),
    ).rejects.toThrow("this account");
    expect(f.commands).toEqual([]);
  });
  it.each(["missing", "deleting", "retiring"] as const)(
    "refuses %s canonical reservations before preparing state",
    async (reservation) => {
      const f = await fixture(true, { reservation });
      await expect(f.launcher.launch(f.runtime, "attempt")).rejects.toThrow("P4 reservation");
      expect(f.commands).toEqual([]);
    },
  );
  it("does not publish a launch intent after the finite scope is aborted during capability verification", async () => {
    const abort = new AbortController();
    const f = await fixture(true, { abort });
    await expect(f.launcher.launch(f.runtime, "attempt")).rejects.toBeDefined();
    expect(f.commands).toHaveLength(1);
    expect(f.commands[0]).toContain("--check --capabilities");
    await expect(fs.lstat(join(f.runtime.statePath, "launch.intent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("refuses native account/config mismatch before publishing an intent", async () => {
    const f = await fixture(true, { nativeRefusal: true });
    await expect(f.launcher.launch(f.runtime, "attempt")).rejects.toThrow(
      "native account reservation mismatch",
    );
    expect(f.commands).toHaveLength(2);
    await expect(fs.lstat(join(f.runtime.statePath, "launch.intent"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("never converts a failed real manager invocation into a launch acknowledgment", async () => {
    const f = await fixture(true, { startFailure: true });
    await expect(f.launcher.launch(f.runtime, "attempt")).rejects.toThrow(
      "manager acknowledgment lost",
    );
    expect(f.commands).toHaveLength(5);
    expect(f.commands[1]).toContain("--backend-service render");
    expect(f.commands[2]).not.toContain("nohup");
    expect(f.commands[3]).toContain("flock -n -x 8");
    expect(f.commands[4]).toContain("--backend-service start-rust");
  });
  it("protocol2-only support authorizes only the independent Rust/P4 launch", async () => {
    const f = await fixture(true);
    await expect(f.launcher.launch(f.runtime, "attempt")).resolves.toBe("launch-reserved");
    expect(f.commands).toHaveLength(5);
    expect(f.commands[4]).toContain("--backend-service start-rust");
    expect(
      f.commands.some((command) => /--backend-service (?:stage|enable|run)\b/.test(command)),
    ).toBe(false);
  });
});
