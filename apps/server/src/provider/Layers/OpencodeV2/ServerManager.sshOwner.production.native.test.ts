import path from "node:path";
import { expect, it } from "vitest";

import type { ProofOpencodeState } from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import type { SshOwnerTargetDescriptor } from "../../../ssh/sshOwnerProductionClient.launch.ts";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import {
  makeProductionV2OwnerSource,
  startSelectedV2OwnerProcess,
} from "./ServerManager.ownerV2.selected.ts";
import {
  info,
  readExternalV2Target,
  recording,
  refused,
  withProductionV2Owner,
} from "./ServerManager.sshOwner.production.native.fixture.ts";

// Disposable Linux host only, non-root, inside a fresh loopback-only namespace,
// with target/debug/bigbud-ssh-owner built and the pinned OpenCode v2 CLI:
// BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY=/absolute/opencode BIGBUD_TEST_OPENCODE_V2_PRODUCTION=1 \
//   bwrap --unshare-net --die-with-parent --bind / / --dev /dev -- bun run --cwd apps/server \
//   vitest run src/provider/Layers/OpencodeV2/ServerManager.sshOwner.production.native.test.ts
const executable = process.env.BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY;
// Cross-host variant (for example macOS initiator, disposable Linux VM sshd):
// BIGBUD_TEST_OPENCODE_V2_EXTERNAL_TARGET='{"host":…,"port":…,"user":…,"identityFile":…,
//   "knownHostsFile":…,"cwd":…,"remoteBinary":…}'
const external = readExternalV2Target(process.env.BIGBUD_TEST_OPENCODE_V2_EXTERNAL_TARGET);
const enabled =
  process.platform === "linux" &&
  executable !== undefined &&
  process.env.BIGBUD_TEST_OPENCODE_V2_PRODUCTION === "1";

it.skipIf(!enabled)(
  "serves real OpenCode v2 on two targets through one target-free production owner",
  async () => {
    await withProductionV2Owner(executable!, 2, async ({ handle, targets }) => {
      expect(handle.opencodeV2Service).toBeDefined();
      const states = new Map<string, ProofOpencodeState[]>();
      const byId = new Map<string, SshOwnerTargetDescriptor>();
      for (const target of targets) {
        byId.set(target.descriptor.targetId, target.descriptor);
        states.set(target.descriptor.targetId, []);
        const bound = handle.target(target.descriptor);
        const trust = await bound.inspectTrust();
        if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      }
      const recordingHandle = Object.assign(Object.create(handle) as typeof handle, {
        target: (descriptor: SshOwnerTargetDescriptor) =>
          recording(handle.target(descriptor), states.get(descriptor.targetId)!),
      });
      const source = makeProductionV2OwnerSource(recordingHandle, async (id) => byId.get(id)!);

      const started = [];
      for (const target of targets) {
        const baseline = await target.commandStarts();
        const process = await startSelectedV2OwnerProcess(
          {
            runtimeTargetId: target.descriptor.targetId,
            binaryPath: "/host/opencode",
            profileRoot: path.join(target.cwd, "..", "host-profile-unused"),
            workspaceRoot: target.cwd,
          },
          source,
        );
        const ready = states.get(target.descriptor.targetId)!.find((s) => s.phase === "ready");
        if (ready?.phase !== "ready") throw new Error("no ready production lease");
        expect(ready.password).toMatch(/^[0-9a-f]{64}$/);
        expect((await info(ready.localPort)).status).toBe(401);
        const authorized = await info(ready.localPort, ready.password);
        expect(authorized.status).toBe(200);
        expect(await authorized.json()).toMatchObject({ version: OPENCODE_V2_CLIENT_VERSION });
        expect(await target.commandStarts()).toBe(baseline + 1);
        started.push({ target, process, ready });
      }
      const [first, second] = started;
      expect(first!.ready.localPort).not.toBe(second!.ready.localPort);
      expect(first!.ready.password).not.toBe(second!.ready.password);

      // Closing one target's lease leaves the other target's server serving.
      await first!.process.close();
      expect(first!.process.isRunning()).toBe(false);
      await expect(refused(first!.ready.localPort)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
      expect((await info(second!.ready.localPort, second!.ready.password)).status).toBe(200);
      await second!.process.close();
      await expect(refused(second!.ready.localPort)).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
      for (const { target } of started) expect(await target.commandStarts()).toBe(1);
    });
  },
  120_000,
);

it.skipIf(
  external === undefined || (process.platform !== "darwin" && process.platform !== "linux"),
)(
  "serves real OpenCode v2 on an external Linux target through this host's production owner",
  async () => {
    await withProductionV2Owner(external!, 1, async ({ handle, targets }) => {
      const [target] = targets;
      const bound = handle.target(target!.descriptor);
      const trust = await bound.inspectTrust();
      if (trust.state === "approvalRequired") await bound.approveTrust(trust.challenge);
      const states: ProofOpencodeState[] = [];
      const recordingHandle = Object.assign(Object.create(handle) as typeof handle, {
        target: (descriptor: SshOwnerTargetDescriptor) =>
          recording(handle.target(descriptor), states),
      });
      const source = makeProductionV2OwnerSource(recordingHandle, async () => target!.descriptor);
      const process = await startSelectedV2OwnerProcess(
        {
          runtimeTargetId: target!.descriptor.targetId,
          binaryPath: "/host/opencode",
          profileRoot: "/nonexistent/host-profile-unused",
          workspaceRoot: target!.cwd,
        },
        source,
      );
      const ready = states.find((state) => state.phase === "ready");
      if (ready?.phase !== "ready") throw new Error("no ready production lease");
      expect((await info(ready.localPort)).status).toBe(401);
      const authorized = await info(ready.localPort, ready.password);
      expect(authorized.status).toBe(200);
      expect(await authorized.json()).toMatchObject({ version: OPENCODE_V2_CLIENT_VERSION });
      await process.close();
      expect(process.isRunning()).toBe(false);
      await expect(refused(ready.localPort)).rejects.toMatchObject({ code: "ECONNREFUSED" });
    });
  },
  120_000,
);
