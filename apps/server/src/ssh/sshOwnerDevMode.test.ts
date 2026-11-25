import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { scanPeerHostKeys } from "../peer-orchestration/peerCoordinator.transport.ts";
import {
  ensureCoordinatorPeerKey,
  PeerEnrollmentOwnerUnavailableError,
} from "../peer-orchestration/peerSshKey.ts";
import { makePeerRelaySshChannels } from "../remote-backend/peerRelay.ssh.ts";
import { makeLocalTerminalHostDirectSsh } from "../terminal-host/localTerminalHost.directSsh.ts";
import { remoteReadOnlyInvocation } from "../terminal/Layers/Manager.remote-inspection.ts";
import { buildRemoteTerminalShellCandidate } from "../terminal/Layers/Manager.remote.ts";
import { ensureLocalShellExecutable } from "../terminal/Layers/PtyShellExecutable.ts";
import { buildSshCommandInvocation } from "./sshCommand.ts";
import { inspectSshHostTrust } from "./sshHostTrust.ts";
import { runSshLocalCommand, runSshLocalCommandSync } from "./sshLocalCommand.ts";
import {
  activateDevSshOwner,
  isDevSshOwnerSelected,
  LegacySshDisabledError,
} from "./sshOwnerDevMode.ts";
import { runSshCommand } from "./sshProcess.ts";

const children = vi.hoisted(() => ({
  execFile: vi.fn(() => {
    throw new Error("unexpected execFile");
  }),
  spawn: vi.fn(() => {
    throw new Error("unexpected spawn");
  }),
  spawnSync: vi.fn(() => {
    throw new Error("unexpected spawnSync");
  }),
}));
vi.mock("node:child_process", async (load) => ({
  ...(await load<typeof import("node:child_process")>()),
  ...children,
}));

afterEach(() => vi.unstubAllEnvs());

const input = {
  executionTargetId: "ssh:host=fixture.invalid&transport=direct-ssh",
  command: "pwd",
};
const terminalInput = {
  executionTargetId: input.executionTargetId,
  shell: "ssh",
  cwd: "/",
  cols: 80,
  rows: 24,
  env: {},
};

it("does not infer activation from inherited flags without server admission", () => {
  vi.stubEnv("BIGBUD_SSH_OWNER", "1");
  vi.stubEnv("BIGBUD_SSH_OWNER_BIN", "/unused-owner");
  vi.stubEnv("VITE_DEV_SERVER_URL", "http://localhost:5173");
  expect(isDevSshOwnerSelected()).toBe(false);
  expect(buildSshCommandInvocation(input)).toMatchObject({ command: "ssh" });
});

describe("after the source-dev server activates the owner", () => {
  beforeAll(activateDevSshOwner);

  it("denies legacy command, trust, health and credential launch helpers", async () => {
    vi.stubEnv("BIGBUD_SSH_OWNER", undefined);
    expect(isDevSshOwnerSelected()).toBe(true);
    expect(() => buildSshCommandInvocation(input)).toThrow(LegacySshDisabledError);
    expect(() => remoteReadOnlyInvocation(input.executionTargetId, "true")).toThrow(
      LegacySshDisabledError,
    );
    await expect(runSshCommand(input)).rejects.toBeInstanceOf(LegacySshDisabledError);
    await expect(inspectSshHostTrust(input.executionTargetId)).rejects.toBeInstanceOf(
      LegacySshDisabledError,
    );
    for (const tool of ["ssh", "ssh-keygen", "ssh-add", "ssh-agent"]) {
      await expect(runSshLocalCommand(tool, [], { timeoutMs: 100 })).rejects.toBeInstanceOf(
        LegacySshDisabledError,
      );
      expect(() => runSshLocalCommandSync(tool, [], { timeoutMs: 100 })).toThrow(
        LegacySshDisabledError,
      );
    }
    expect(children.spawn).not.toHaveBeenCalled();
    expect(children.spawnSync).not.toHaveBeenCalled();
  });

  it("denies every peer launcher even with an overridden binary", async () => {
    const directory = await mkdtemp(join(tmpdir(), "bigbud-dev-ssh-fence-"));
    try {
      const channels = makePeerRelaySshChannels({
        target: {
          host: "fixture.invalid",
          port: 22,
          user: "fixture",
          workerAuthorityId: "a".repeat(32),
          pinnedHostKey: "ssh-ed25519 AAAA",
          identityFile: join(directory, "peer_ed25519"),
        },
        knownHostsDirectory: join(directory, "known"),
        sshBinary: "/unused-peer-client",
      });
      await expect(channels.openChannel(new AbortController().signal)).rejects.toBeInstanceOf(
        LegacySshDisabledError,
      );
      await expect(scanPeerHostKeys(undefined, "fixture.invalid", 22)).rejects.toBeInstanceOf(
        PeerEnrollmentOwnerUnavailableError,
      );
      await expect(ensureCoordinatorPeerKey(undefined)).rejects.toBeInstanceOf(
        PeerEnrollmentOwnerUnavailableError,
      );
      expect(children.execFile).not.toHaveBeenCalled();
      expect(children.spawn).not.toHaveBeenCalled();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps native candidate construction and local PTYs, but denies both legacy PTY paths", async () => {
    expect(
      buildRemoteTerminalShellCandidate({
        executionTargetId: input.executionTargetId,
        cwd: "/remote",
        runtimeEnv: null,
        runtimeGeneration: "fixture",
      }).shell,
    ).toBe("ssh");
    const localCheck = vi.fn(async () => true);
    const legacyFallback = vi.fn(() => Effect.die("Unexpected legacy spawn"));
    const unreachable = new Proxy({} as never, {
      get: () => undefined,
    });
    const adapter = makeLocalTerminalHostDirectSsh({
      controller: unreachable,
      pool: unreachable,
      runtime: unreachable,
      fallback: { spawn: legacyFallback },
      isClosed: () => false,
    });
    const denied = new LegacySshDisabledError().message;
    await expect(Effect.runPromise(adapter.spawn(terminalInput))).rejects.toThrow(denied);
    await expect(
      Effect.runPromise(ensureLocalShellExecutable("node-pty", terminalInput, 100, localCheck)),
    ).rejects.toThrow(denied);
    expect(legacyFallback).not.toHaveBeenCalled();
    expect(localCheck).not.toHaveBeenCalled();
    await Effect.runPromise(
      ensureLocalShellExecutable("node-pty", { shell: "sh", cwd: "/" }, 100, localCheck),
    );
    if (process.platform !== "win32") expect(localCheck).toHaveBeenCalledOnce();
  });
});
