import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { WS_METHODS } from "@bigbud/contracts/constants/websocket.constant.ts";
import { SshHostTrustChallenge } from "@bigbud/contracts/server/server.sshHostTrust";
import { Effect, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { expect, it, vi } from "vitest";

import { makeWsSshOwnerDevHandlers } from "../ws/wsSshOwnerDev.ts";
import { resolveProfileAliases } from "./sshConfigProfileAliases.ts";
import { activateDevSshOwner } from "./sshOwnerDevMode.ts";
import {
  DEV_OWNER_SSH_CONFIG,
  bindDevOwnerAlias,
  readDevOwnerProfileConfig,
} from "./sshOwnerDevRuntime.profileConfig.ts";
import { DevSshOwnerRuntime, makeDevSshOwnerRuntime } from "./sshOwnerDevRuntime.ts";
import { pickerProofOptedIn, storageScope } from "./sshOwnerPickerProof.integration.ts";
import { SSH_HOST_TRUST_REQUIRED_PREFIX } from "./sshTargetUnavailable.ts";

async function writePrivate(root: string, name: string, content: string) {
  const target = path.join(root, name);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await writeFile(target, content, { mode: 0o600 });
}

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "admits a real-shaped profile: wildcard defaults, negation, ordered includes and HostKeyAlias",
  async () => {
    const profile = await mkdtemp("/private/tmp/bigbud-ssh-owner-dev-");
    const alias = "dev-workbench";
    try {
      await writePrivate(
        profile,
        "ssh-config",
        [
          "# Personal development hosts",
          "Host *",
          "  ConnectTimeout 4",
          "  ServerAliveInterval 15",
          `Host !prod-* ${alias}`,
          "  Include host-key.conf",
          "  Include fixture-endpoint.conf",
          "  IdentitiesOnly yes",
          "Host prod-*",
          "  HostName 192.0.2.10",
          "",
        ].join("\n"),
      );
      await writePrivate(profile, "host-key.conf", "HostKeyAlias workbench-trust\n");
      vi.stubEnv("BIGBUD_SSH_OWNER_NORMAL_DEV_PROFILE", profile);
      vi.stubEnv(
        "BIGBUD_SSH_OWNER_BIN",
        process.env.BIGBUD_SSH_OWNER_PICKER_PROOF_BIN ??
          fileURLToPath(new URL("../../../../target/debug/bigbud-ssh-owner", import.meta.url)),
      );
      activateDevSshOwner();
      await storageScope(path.join(profile, "state.sqlite"), (sql) =>
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeDevSshOwnerRuntime();
            if (session?.kind !== "unix" || !("connectionStarts" in session.fixture))
              throw new Error("Expected the disposable macOS profile runtime");
            expect(session.alias).toBe(alias);
            expect(session.fixture.connectionStarts()).toBe(0);
            const selected = yield* makeWsSshOwnerDevHandlers().pipe(
              Effect.provideService(DevSshOwnerRuntime, { session }),
            );
            if (!selected) throw new Error("Expected the selected development handlers");
            const hosts = yield* selected.handlers[WS_METHODS.serverListSshConfigHosts]();
            expect(hosts.hosts).toEqual([
              {
                alias,
                sourcePath: path.join(session.fixture.root, "owner-alias.conf"),
                line: 5,
                hostName: session.fixture.loopback,
                user: session.fixture.user,
                port: String(session.fixture.port),
                hostKeyAlias: "workbench-trust",
                route: "direct",
                supported: true,
              },
            ]);
            expect(hosts.developmentOwnerTargetId).toBe(session.targetId);
            // Discovery never dials: no connection before the first explicit browse.
            expect(session.fixture.connectionStarts()).toBe(0);

            const input = { executionTargetId: session.targetId, path: session.fixture.folder };
            const first = yield* Effect.promise(() =>
              session.picker.listRemoteFolders(input).then(
                () => {
                  throw new Error("Expected a first-use trust challenge");
                },
                (error: Error) => error,
              ),
            );
            expect(first.message.startsWith(SSH_HOST_TRUST_REQUIRED_PREFIX)).toBe(true);
            const { challengeId } = Schema.decodeUnknownSync(SshHostTrustChallenge)(
              JSON.parse(first.message.slice(SSH_HOST_TRUST_REQUIRED_PREFIX.length)),
            );
            yield* Effect.promise(() =>
              session.picker.trustSshHost({ executionTargetId: session.targetId, challengeId }),
            );
            const listed = yield* Effect.promise(() => session.picker.listRemoteFolders(input));
            expect(listed.folders.map(({ name }) => name)).toEqual(["alpha", "Z repo"]);
            expect(yield* Effect.promise(session.fixture.launchNames)).toEqual([]);
          }),
        ).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      );
    } finally {
      vi.unstubAllEnvs();
      await rm(profile, { recursive: true, force: true });
    }
  },
  90_000,
);

it("resolves IPv6, port 22 and ordered includes without dialing", async () => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "bigbud-user-profile-")));
  const source = path.join(root, "ssh-config");
  try {
    await writePrivate(
      root,
      "ssh-config",
      [
        "Include hosts.d/*.conf",
        "Host v6-workbench",
        "  HostName ::1",
        "  User picker",
        "  HostKeyAlias v6-trust",
        "",
      ].join("\n"),
    );
    await writePrivate(root, "hosts.d/a-default.conf", "Host defaults\n  Port 22\n");
    await writePrivate(root, "hosts.d/b-implicit.conf", "Host implicit\n");

    const resolved = await resolveProfileAliases({
      root,
      sourcePath: source,
      content: await readFile(source, "utf8"),
    });

    expect(resolved.hints.map((hint) => hint.alias)).toEqual([
      "defaults",
      "implicit",
      "v6-workbench",
    ]);
    expect(resolved.hints[0]?.port).toBe("22");
    expect(resolved.hints[1]?.port).toBe("22");
    expect(resolved.hints[2]).toMatchObject({
      hostName: "::1",
      user: "picker",
      port: "22",
      hostKeyAlias: "v6-trust",
      route: "direct",
    });
    expect(resolved.refusals).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.skipIf(process.platform !== "darwin")(
  "selects and binds one alias from a real-shaped profile without an owner or SSH",
  async () => {
    const profile = await mkdtemp("/private/tmp/bigbud-ssh-owner-dev-");
    const fixture = await mkdtemp("/private/tmp/bigbud-user-profile-fixture-");
    try {
      await writePrivate(
        profile,
        DEV_OWNER_SSH_CONFIG,
        [
          "Host *",
          "  ConnectTimeout 4",
          "Host !prod-* dev-workbench",
          "  Include host-key.conf",
          "  Include fixture-endpoint.conf",
          "  IdentitiesOnly yes",
          "",
        ].join("\n"),
      );
      await writePrivate(profile, "host-key.conf", "HostKeyAlias workbench-trust\n");

      const config = await readDevOwnerProfileConfig(profile);
      if (!config) throw new Error("Expected the profile config");
      expect(config.alias).toBe("dev-workbench");
      const { aliasConfig } = await bindDevOwnerAlias(
        {
          root: fixture,
          loopback: "127.0.0.1",
          port: 22222,
          user: "picker",
          identity: path.join(fixture, "id_ed25519"),
          knownHosts: path.join(fixture, "known_hosts"),
        },
        config.alias,
        config,
      );

      expect(aliasConfig).toEqual({
        file: path.join(fixture, "owner-alias.conf"),
        alias: "dev-workbench",
      });
      const copied = path.join(fixture, "host-key.conf");
      expect((await stat(copied)).mode & 0o077).toBe(0);
      expect(await readFile(copied, "utf8")).toBe("HostKeyAlias workbench-trust\n");
    } finally {
      await rm(profile, { recursive: true, force: true });
      await rm(fixture, { recursive: true, force: true });
    }
  },
);
