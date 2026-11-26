import { existsSync } from "node:fs";
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

it.skipIf(process.platform !== "darwin" || !pickerProofOptedIn)(
  "surfaces a redacted Match startup refusal at the directive before any helper or SSH",
  async () => {
    const fixture = await makeLoopbackPickerFixture();
    try {
      const options = await proofOptions(fixture);
      const alias = "synthetic-private-target-alias";
      const predicate = "synthetic-private-account";
      const marker = path.join(fixture.root, "synthetic-helper-must-not-run");
      const command = `"/usr/bin/touch ${marker}"`;
      const file = path.join(fixture.root, "private-request-config");
      const systemFile = path.join(fixture.root, "private-system-config");
      const nested = "private-nested-policy";
      const active = [
        `Host ${alias}`,
        `  HostName ${fixture.loopback}`,
        `  Port ${fixture.port}`,
        `  User ${fixture.user}`,
        `  IdentityFile ${fixture.identity}`,
        `  UserKnownHostsFile ${fixture.knownHosts}`,
        "",
      ].join("\n");
      const put = (name: string, text: string) => writeFile(name, text, { mode: 0o600 });
      const include = `Include ${nested}\n`;
      await fixture.start();
      const before = fixture.connectionStarts();
      await storageScope(path.join(fixture.root, "match-startup.sqlite"), (sql) =>
        Effect.promise(async () => {
          const start = (withSystem = false) =>
            startPickerProofOwner({
              ...options,
              sql,
              aliasConfig: { file, alias, ...(withSystem ? { systemFile } : {}) },
            });
          const cases = [
            {
              user: `Match exec ${command} originalhost unrelated\n`,
              source: "user_config",
              line: 7,
            },
            {
              user: include,
              nested: `# no local fact\nMatch localuser ${predicate}\n`,
              source: "user_include",
              line: 2,
            },
            {
              user: "",
              system: include,
              nested: `# source marker\n\nMatch final originalhost ${predicate}\n`,
              source: "system_include",
              line: 3,
            },
          ] as const;
          for (const item of cases) {
            await put(file, active + item.user);
            const withSystem = "system" in item;
            if ("nested" in item) await put(path.join(fixture.root, nested), item.nested);
            if ("system" in item) await put(systemFile, item.system);
            const error = await start(withSystem).then(
              async (owner) => {
                await owner.close();
                throw new Error("Unsupported Match unexpectedly started");
              },
              (cause: unknown) => cause,
            );
            expect(error).toBeInstanceOf(PickerProofStartupConfigError);
            expect(error).toMatchObject({
              code: "configUnsupported",
              diagnostic: {
                location: { directive: "Match", source: item.source, line: item.line },
                remedy:
                  "Use supported host or user criteria. Match localuser needs a trusted initiating account; exec and final are not supported.",
              },
            });
            const visible = startupFailure(error);
            expect(visible.message).toContain(
              `Match in ${item.source.replace("_", " ")} at line ${item.line}`,
            );
            for (const leak of [
              fixture.root,
              alias,
              predicate,
              nested,
              path.basename(file),
              path.basename(systemFile),
              "/usr/bin/touch",
              path.basename(marker),
            ]) {
              expect(visible.message).not.toContain(leak);
              expect(JSON.stringify(error)).not.toContain(leak);
            }
            expect(existsSync(marker)).toBe(false);
            expect(fixture.connectionStarts()).toBe(before);
          }

          await put(file, `${active}Match originalhost unrelated exec ${command}\n`);
          const allowed = await start();
          await allowed.close();
          expect(existsSync(marker)).toBe(false);
          expect(fixture.connectionStarts()).toBe(before);
          expect(await fixture.launchNames()).toEqual([]);
        }),
      );
    } finally {
      await fixture.dispose();
    }
  },
  60_000,
);
