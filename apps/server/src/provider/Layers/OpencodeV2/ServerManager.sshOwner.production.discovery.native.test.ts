import path from "node:path";
import { expect, it } from "vitest";

import type { ProofOpencodeState } from "../../../ssh/sshOwnerPickerProof.codec.opencode.ts";
import type { SshOwnerProductionHandle } from "../../../ssh/sshOwnerProductionClient.ts";
import type { SshOwnerTargetDescriptor } from "../../../ssh/sshOwnerProductionClient.launch.ts";
import { OPENCODE_V2_CLIENT_VERSION } from "./Compatibility.ts";
import {
  makeProductionV2OwnerSource,
  startSelectedV2OwnerProcess,
} from "./ServerManager.ownerV2.selected.ts";
import {
  info,
  LIVE_ALIAS,
  readExternalV2Target,
  recording,
  refused,
  withProductionV2Owner,
  type LiveTarget,
} from "./ServerManager.sshOwner.production.native.fixture.ts";

// Disposable Linux host only, inside a fresh loopback-only namespace, with the
// pinned OpenCode v2 CLI on the remote account's LOGIN PATH (not in a known
// install location) and no configured remote path:
// BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY=/absolute/opencode BIGBUD_TEST_OPENCODE_V2_DISCOVERY=1 \
//   bun run --cwd apps/server vitest run <this file>
const executable = process.env.BIGBUD_TEST_OPENCODE_V2_OWNER_BINARY;
const enabled =
  process.platform === "linux" &&
  executable !== undefined &&
  process.env.BIGBUD_TEST_OPENCODE_V2_DISCOVERY === "1";
// Cross-host variant (macOS or Linux initiator, disposable Linux sshd prepared
// so the CLI is on the login PATH, only in a known install location, or absent):
// BIGBUD_TEST_OPENCODE_V2_EXTERNAL_TARGET='{…}' (see the production native test)
// BIGBUD_TEST_OPENCODE_V2_DISCOVERY_EXPECT=ready|unavailable
const external = readExternalV2Target(process.env.BIGBUD_TEST_OPENCODE_V2_EXTERNAL_TARGET);
const expectation = process.env.BIGBUD_TEST_OPENCODE_V2_DISCOVERY_EXPECT;
const externalEnabled =
  external !== undefined && (process.platform === "darwin" || process.platform === "linux");

async function trust(handle: SshOwnerProductionHandle, target: LiveTarget) {
  const bound = handle.target(target.descriptor);
  const state = await bound.inspectTrust();
  if (state.state === "approvalRequired") await bound.approveTrust(state.challenge);
}

function sourceFor(
  handle: SshOwnerProductionHandle,
  target: LiveTarget,
  states: ProofOpencodeState[],
) {
  const recordingHandle = Object.assign(Object.create(handle) as typeof handle, {
    target: (descriptor: SshOwnerTargetDescriptor) => recording(handle.target(descriptor), states),
  });
  return makeProductionV2OwnerSource(recordingHandle, async () => target.descriptor);
}

// An alias descriptor carries the bare alias; its runtime target is `ssh:<alias>`.
const configFor = (target: LiveTarget) => ({
  runtimeTargetId:
    target.descriptor.kind === "alias"
      ? `ssh:${target.descriptor.targetId}`
      : target.descriptor.targetId,
  binaryPath: "/host/opencode",
  profileRoot: path.join(target.cwd, "..", "host-profile-unused"),
  workspaceRoot: target.cwd,
});

async function discoversTwice(executableOrTarget: Parameters<typeof withProductionV2Owner>[0]) {
  await withProductionV2Owner(
    executableOrTarget,
    1,
    async ({ handle, targets }) => {
      const [target] = targets;
      expect(target!.descriptor).toMatchObject({ kind: "alias", targetId: LIVE_ALIAS });
      await trust(handle, target!);
      for (const round of [1, 2]) {
        const states: ProofOpencodeState[] = [];
        const process = await startSelectedV2OwnerProcess(
          configFor(target!),
          sourceFor(handle, target!, states),
        );
        const ready = states.find((state) => state.phase === "ready");
        if (ready?.phase !== "ready") throw new Error("no ready discovered lease");
        expect((await info(ready.localPort)).status).toBe(401);
        const authorized = await info(ready.localPort, ready.password);
        expect(authorized.status).toBe(200);
        expect(await authorized.json()).toMatchObject({ version: OPENCODE_V2_CLIENT_VERSION });
        await process.close();
        await expect(refused(ready.localPort)).rejects.toMatchObject({ code: "ECONNREFUSED" });
        // A closed lease frees this target's lane: round 2 starts again.
        const starts = await target!.commandStarts();
        if (starts !== -1) expect(starts).toBe(round);
      }
    },
    { binding: {}, aliasFirstTarget: true },
  );
}

it.skipIf(!enabled)(
  "discovers OpenCode v2 on the login PATH of an alias target, then restarts on the same target",
  () => discoversTwice(executable!),
  120_000,
);

it.skipIf(!externalEnabled || expectation !== "ready")(
  "discovers OpenCode v2 on an external Linux alias target from this host's production owner",
  () => discoversTwice(external!),
  120_000,
);

it.skipIf(!externalEnabled || expectation !== "unavailable")(
  "refuses an external Linux target with no discoverable OpenCode v2 and starts no server",
  async () => {
    await withProductionV2Owner(
      external!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        await trust(handle, target!);
        const states: ProofOpencodeState[] = [];
        const failure = await startSelectedV2OwnerProcess(
          configFor(target!),
          sourceFor(handle, target!, states),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: "providerExecutableUnavailable" });
        expect(states.some((state) => state.phase === "ready")).toBe(false);
      },
      { binding: {}, aliasFirstTarget: true },
    );
  },
  120_000,
);

it.skipIf(!enabled)(
  "refuses an unavailable remote executable with a typed reason and starts no server",
  async () => {
    await withProductionV2Owner(
      executable!,
      1,
      async ({ handle, targets }) => {
        const [target] = targets;
        await trust(handle, target!);
        const states: ProofOpencodeState[] = [];
        const failure = await startSelectedV2OwnerProcess(
          configFor(target!),
          sourceFor(handle, target!, states),
        ).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(failure).toMatchObject({ code: "providerExecutableUnavailable" });
        expect(states.some((state) => state.phase === "ready")).toBe(false);
      },
      { binding: { binaryPath: "/nonexistent/bigbud-test/opencode" } },
    );
  },
  120_000,
);
