import { writeFile } from "node:fs/promises";
import path from "node:path";
import { Effect } from "effect";
import { expect, it } from "vitest";

import { startupFailure } from "./sshOwnerDevPicker.errors.ts";
import { startPickerProofOwner } from "./sshOwnerPickerProof.client.ts";
import {
  pickerProofOptedIn,
  proofOptions,
  storageScope,
} from "./sshOwnerPickerProof.integration.ts";
import { PickerProofStartupConfigError } from "./sshOwnerPickerProof.startupDiagnostic.ts";
import { makeLoopbackPickerFixture } from "./sshPicker.loopback.fixture.ts";

it.skipIf(!pickerProofOptedIn).each([
  ["ProxyCommand", "/fixture/private/synthetic-private-value", undefined],
  ["ProxyJump", "first,synthetic-private-value:0", 2],
  ["ProxyJump", "first,second", undefined],
] as const)(
  "propagates only the owner’s redacted %s rejection before SSH launch",
  async (directive, operand, hop) => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const file = path.join(fixture.root, "policy-config");
      const marker = "synthetic-private-value";
      await writeFile(
        file,
        [
          "Host fixture-alias",
          `  ${directive} ${operand}`,
          `  HostName ${fixture.loopback}`,
          `  User ${fixture.user}`,
          `  Port ${fixture.port}`,
          `  IdentityFile ${fixture.identity}`,
          `  UserKnownHostsFile ${fixture.knownHosts}`,
          "",
        ].join("\n"),
        { mode: 0o600 },
      );
      await fixture.start();
      await storageScope(path.join(fixture.root, "config.sqlite"), (sql) =>
        Effect.promise(async () => {
          const error = await startPickerProofOwner({
            ...options,
            sql,
            aliasConfig: { file, alias: "fixture-alias" },
          }).then(
            async (owner) => {
              await owner.close();
              throw new Error("Rejected alias unexpectedly started");
            },
            (cause: unknown) => cause,
          );
          expect(error).toBeInstanceOf(PickerProofStartupConfigError);
          expect(error).toMatchObject({
            code: "configUnsupported",
            diagnostic: {
              location: { directive, source: "user_config", line: 2, ...(hop ? { hop } : {}) },
              remedy:
                directive === "ProxyCommand"
                  ? "Use ProxyCommand nc %h %p (or a qualified absolute nc with exactly %h %p), or a direct route."
                  : "Use a direct fixture route with no proxy.",
            },
          });
          const surfaced = startupFailure(error);
          expect(surfaced.message).toContain(
            `${directive}${hop ? ` hop ${hop}` : ""} in user config at line 2`,
          );
          for (const privateValue of [marker, file, "fixture-alias"]) {
            expect(surfaced.message).not.toContain(privateValue);
            expect(JSON.stringify(error)).not.toContain(privateValue);
          }
          expect(await fixture.launchNames()).toEqual([]);
          expect(fixture.connectionStarts()).toBe(0);
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
