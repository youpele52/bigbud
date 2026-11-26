import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Schema } from "effect";
import { expect, it, vi } from "vitest";

import { makeWsSshOwnerDevHandlers } from "../ws/wsSshOwnerDev.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.fixture.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

const execute = promisify(execFile);

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "uses the advertised alias for native trust and browsing, then refuses a changed config",
  async () => {
    const root = await mkdtemp("/private/tmp/bigbud-alias-rpc-");
    try {
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(root, "state.sqlite"), () =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDevSshOwnerRuntime();
            if (session?.kind !== "unix") throw new Error("Expected a Unix fixture");
            expect(session.terminal).toBeDefined();
            const { fixture } = session;
            if (!("connectionStarts" in fixture)) throw new Error("Expected a macOS fixture");
            const selected = yield* makeWsSshOwnerDevHandlers().pipe(
              Effect.provideService(DevSshOwnerRuntime, { session }),
            );
            if (!selected) throw new Error("Expected the selected development handlers");
            const hosts = yield* selected.handlers[WS_METHODS.serverListSshConfigHosts]();
            expect(hosts.hosts).toEqual([expect.objectContaining({ alias: session.alias })]);
            expect(hosts.developmentOwnerTargetId).toBe(session.targetId);
            const config = path.join(fixture.root, "owner-alias.conf");
            const { stdout } = yield* Effect.promise(() =>
              execute(fixture.ssh, ["-G", "-T", "-F", config, "--", session.alias], {
                env: fixture.env,
                timeout: 5_000,
                maxBuffer: 64 * 1024,
              }),
            );
            expect(stdout.split("\n")).toEqual(
              expect.arrayContaining([
                `hostname ${fixture.loopback}`,
                `user ${fixture.user}`,
                `port ${fixture.port}`,
                `identityfile ${fixture.identity}`,
                `userknownhostsfile ${fixture.knownHosts}`,
              ]),
            );
            const input = { executionTargetId: session.targetId, path: fixture.folder };
            const list = () => selected.handlers[WS_METHODS.serverListRemoteFolders](input);
            const first = yield* Effect.flip(list());
            expect(first.message, first.message).toMatch(
              new RegExp(`^${SSH_HOST_TRUST_REQUIRED_PREFIX}`),
            );
            const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
              JSON.parse(first.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
            );
            yield* selected.handlers[WS_METHODS.serverTrustSshHost]({ ...input, challengeId });
            const listed = yield* list();
            expect(listed.folders.map(({ name }) => name)).toEqual(["alpha", "Z repo"]);
            const snapshot = (signal: AbortSignal) =>
              session.picker.withOwner(session.targetId, (owner) =>
                owner.snapshotProofWorkspaceDirectory(
                  {
                    executionTargetId: session.targetId,
                    workspaceRoot: fixture.folder,
                    relativeDir: "",
                  },
                  signal,
                ),
              );
            expect(yield* Effect.promise(snapshot)).toBeDefined();
            const attempts = fixture.connectionStarts();
            yield* Effect.promise(() => appendFile(config, "  ProxyJump blocked\n"));
            const refusal = yield* Effect.flip(list());
            expect(refusal).toMatchObject({ code: "sshConfigUnsupported" });
            yield* Effect.promise(async (signal) => {
              await expect(snapshot(signal)).rejects.toMatchObject({ code: "configUnsupported" });
            });
            expect(fixture.connectionStarts()).toBe(attempts);
            expect(yield* Effect.promise(fixture.launchNames)).toEqual([]);
          }),
        ),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(root, { recursive: true, force: true });
    }
  },
  60_000,
);
