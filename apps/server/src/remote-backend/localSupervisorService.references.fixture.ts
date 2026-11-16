import * as fs from "node:fs/promises";
import { join } from "node:path";
import { vi } from "vitest";
import type { LocalSupervisorControl } from "./localSupervisorControl.ts";
import {
  encodeLocalSupervisorServiceConfig,
  type LocalSupervisorServiceConfig,
} from "./localSupervisorService.config.ts";
import {
  emptyRemoteAgentRegistry,
  parseRemoteAgentRegistry,
} from "../remote-agent/remoteAgentInstall.registry.ts";
import { remoteAgentBuildId, type RemoteAgentRuntime } from "../remote-agent/remoteAgentRuntime.ts";

export const quoteServiceFixturePath = (value: string) =>
  `"${value.replace(/[\\"%$]/g, (character) => (character === "%" || character === "$" ? character + character : `\\${character}`))}"`;

export async function serviceReferenceFixture() {
  const home = await fs.realpath(await fs.mkdtemp("/tmp/bb-sref-"));
  const root = join(home, ".bigbud/agent");
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const runtime = (number: number): RemoteAgentRuntime => {
    const sha256 = String(number).repeat(64);
    const statePath = join(root, "runtimes", `g-${number}`);
    return {
      generation: `g-${number}`,
      version: "1.0.0",
      sha256,
      buildDigest: `fixture-${number}`,
      targetTriple: "aarch64-unknown-linux-gnu",
      binaryPath: join(root, "bin/1.0.0", sha256, "bigbud-remote-agent"),
      statePath,
      socketPath: join(statePath, "supervisor.sock"),
      logPath: join(statePath, "supervisor.log"),
      origin: "managed",
    };
  };
  const runtimes = [runtime(1), runtime(2), runtime(3)];
  const registry = parseRemoteAgentRegistry(
    JSON.stringify({
      ...emptyRemoteAgentRegistry(),
      builds: runtimes.map((runtime) => ({
        id: remoteAgentBuildId(runtime),
        runtime,
        health: "staged",
        promotion: 0,
        binary: "present",
        authenticated: true,
      })),
    }),
  );
  const target = `remote-backend:${"a".repeat(32)}`;
  const control: LocalSupervisorControl = {
    targetId: target,
    homeDir: home,
    root,
    run: vi.fn(async () => {
      throw new Error("Unexpected live systemctl");
    }),
    openControl: async () => ({
      root,
      run: async () => "",
      registry: {
        read: async () => registry,
        update: async () => {
          throw new Error("Read-only references");
        },
      },
    }),
  };
  const write = async (path: string, text: string, mode = 0o600) => {
    await fs.mkdir(join(path, ".."), { recursive: true, mode: 0o700 });
    await fs.writeFile(path, text, { mode });
    await fs.chmod(path, mode);
  };
  const configPath = (authority: string) =>
    join(home, ".bigbud/backend-services", authority, "config-v1");
  const config = async (authority = "a".repeat(32), selected = runtimes[1]!) => {
    const value: LocalSupervisorServiceConfig = {
      version: "1",
      authority,
      home,
      backend_home: join(home, "backend"),
      rust_binary: selected.binaryPath,
      rust_sha256: selected.sha256,
      rust_state: selected.statePath,
      node_binary: "/fixture/node",
      node_sha256: "a".repeat(64),
      backend_entry: "/fixture/backend.mjs",
      backend_sha256: "b".repeat(64),
      receipt_sha256: "c".repeat(64),
      restart: "yes",
      launch_attempt: "fixture-attempt",
      expected_installation_fingerprint: `sha256:${"c".repeat(64)}`,
      authority_reservation_sha256: "d".repeat(64),
      prior_epoch: "fresh",
      launch_boot: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    };
    await write(configPath(authority), encodeLocalSupervisorServiceConfig(value));
    return value;
  };
  const unitPath = (name: string) => join(home, ".config/systemd/user", name);
  const unit = async (
    authority = "a".repeat(32),
    selected = runtimes[0]!,
    role: "rust" | "backend" = "rust",
  ) => {
    const name = `bigbud-${role}-${authority}.service`;

    await write(
      unitPath(name),
      `# bigbud account-service v1; ${role === "rust" ? "independent Rust terminal owner" : "user scope only"}\n[Service]\nType=exec\nExecStart=${quoteServiceFixturePath(selected.binaryPath)} --backend-service run ${quoteServiceFixturePath(configPath(authority))} ${role}\nKillMode=control-group\n`,
    );
    return { name, fragmentPath: unitPath(name) };
  };
  return {
    home,
    root,
    target,
    control,
    runtimes,
    registry,
    write,
    config,
    configPath,
    unit,
    unitPath,
    close: () => fs.rm(home, { recursive: true, force: true }),
  };
}
