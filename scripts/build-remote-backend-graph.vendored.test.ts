import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupGraphFixtures,
  privateBase,
  vendoredLicenseFixture,
} from "./build-remote-backend-graph.fixture.ts";
import {
  noticeSummary,
  renderThirdPartyNotices,
  type GraphNoticeEntry,
} from "./build-remote-backend-graph.notices.ts";
import {
  applyVendoredLicenses,
  loadVendoredLicenses,
  VENDORED_LICENSES_DIRECTORY,
} from "./build-remote-backend-graph.vendored.ts";

afterEach(cleanupGraphFixtures);
const entry = (name: string, version: string, files: GraphNoticeEntry["files"] = []) =>
  ({
    kind: "package",
    name,
    version,
    license: "MIT",
    directory: `node_modules/${name}`,
    files,
  }) as const;

it("vendored_licenses_refuse_changed_missing_or_invalid_files", async () => {
  const root = await vendoredLicenseFixture(join(await privateBase(), "v"), {
    "@s/a@1.0.0": { LICENSE: "MIT a" },
  });
  await expect(loadVendoredLicenses(root)).resolves.toBeDefined();
  await writeFile(join(root, "@s+a@1.0.0/LICENSE"), "MIT a, edited");
  await expect(loadVendoredLicenses(root)).rejects.toThrow("@s/a@1.0.0/LICENSE hash mismatch");
  const missing = await vendoredLicenseFixture(join(await privateBase(), "v"), {
    "b@1.0.0": { LICENSE: "MIT b" },
  });
  await writeFile(
    join(missing, "manifest.json"),
    (await readFile(join(missing, "manifest.json"), "utf8")).replace('"LICENSE"', '"COPYING"'),
  );
  await expect(loadVendoredLicenses(missing)).rejects.toThrow(/hash mismatch|missing/);
  await writeFile(
    join(missing, "manifest.json"),
    JSON.stringify({ schemaVersion: 1, packages: [{ name: "b", version: "1", status: "maybe" }] }),
  );
  await expect(loadVendoredLicenses(missing)).rejects.toThrow("status for b@1 is unsupported");
});

it("vendored_licenses_attach_by_exact_version_and_render_with_source", async () => {
  const root = await vendoredLicenseFixture(
    join(await privateBase(), "v"),
    { "@s/a@1.0.0": { LICENSE: "MIT a upstream", "tool-LICENSE": "tool licence" } },
    ["gone@2.0.0"],
  );
  const vendored = await loadVendoredLicenses(root);
  const own = {
    path: "node_modules/@s/a/NOTICE",
    sha256: createHash("sha256").update("own").digest("hex"),
  };
  const entries = [entry("@s/a", "1.0.0", [own]), entry("@s/a", "1.0.1"), entry("gone", "2.0.0")];
  const applied = applyVendoredLicenses(entries, vendored);
  expect(applied.copies).toEqual([
    { from: join(root, "@s+a@1.0.0/LICENSE"), to: "notices/vendored/@s+a@1.0.0/LICENSE" },
    {
      from: join(root, "@s+a@1.0.0/tool-LICENSE"),
      to: "notices/vendored/@s+a@1.0.0/tool-LICENSE",
    },
  ]);
  const [a, other, gone] = applied.entries;
  expect(a!.files.map((file) => file.path)).toEqual([
    own.path,
    "notices/vendored/@s+a@1.0.0/LICENSE",
    "notices/vendored/@s+a@1.0.0/tool-LICENSE",
  ]);
  expect(a!.upstream).toMatchObject({
    status: "vendored",
    files: [{ graphPath: "notices/vendored/@s+a@1.0.0/LICENSE", ref: "v1.0.0" }, {}],
  });
  expect(other).toBe(entries[1]);
  expect(gone!.files).toEqual([]);
  expect(gone!.upstream?.status).toBe("no-license-file-upstream");
  expect(noticeSummary(applied.entries)).toMatchObject({
    withoutNoticeFiles: ["@s/a@1.0.1", "gone@2.0.0"],
    vendoredNoticeFiles: ["@s/a@1.0.0"],
  });
  const bytes: Record<string, Buffer> = {
    [own.path]: Buffer.from("own"),
    ...Object.fromEntries(
      applied.copies.map((copy) => [
        copy.to,
        Buffer.from(copy.from.endsWith("tool-LICENSE") ? "tool licence" : "MIT a upstream"),
      ]),
    ),
  };
  const render = () => renderThirdPartyNotices("T", applied.entries, async (path) => bytes[path]!);
  const text = await render();
  expect(text).toContain(
    "--- notices/vendored/@s+a@1.0.0/LICENSE (sha256 " +
      `${vendored.packages[0]!.status === "vendored" && vendored.packages[0]!.files[0]!.sha256}) ---\n` +
      "Vendored from https://example.test/@s/a/raw/v1.0.0/LICENSE (ref v1.0.0, commit " +
      `${"a".repeat(40)}), retrieved 2026-11-18.\n\nMIT a upstream\n`,
  );
  expect(text).toContain(
    "gone@2.0.0 (package)\nDeclared license: MIT\nLocation: node_modules/gone\n\n" +
      "No license or notice file is shipped for this component.\n" +
      `No license file upstream: checked https://example.test/none at ${"b".repeat(40)} (v1)`,
  );
  expect(await render()).toBe(text);
});

/** The checked-in vendored set: every file verifies, and the decisions it records hold. */
it("checked_in_vendored_licenses_verify", async () => {
  const vendored = await loadVendoredLicenses(
    join(import.meta.dirname, "..", VENDORED_LICENSES_DIRECTORY),
  );
  const byKey = new Map(vendored.packages.map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  for (const key of [
    "@opencode/client@2.1.4",
    "@opencode-ai/sdk@1.17.13",
    "@xterm/headless@6.1.0-beta.304",
    "@xterm/addon-serialize@0.15.0-beta.301",
    "@github/copilot-sdk@1.0.28",
    "@github/copilot-sdk-linux-arm64@1.0.28",
    "@github/copilot-sdk-linux-x64@1.0.28",
    ...["agent-core", "ai", "codemode", "coding-agent", "telemetry", "tui"].map(
      (name) => `@earendil-works/pi-${name}@1.4.0`,
    ),
    "@koromix/koffi-linux-arm64@3.2.1",
    "@koromix/koffi-linux-x64@3.2.1",
    "@aws-sdk/credential-provider-http@3.972.86",
    "@aws-sdk/credential-provider-login@3.972.92",
    "@aws-sdk/nested-clients@3.998.3",
    "standardwebhooks@1.3.0",
  ])
    expect(byKey.get(key)?.status, key).toBe("vendored");
  for (const key of ["data-uri-to-buffer@4.0.1", "proxy-agent-negotiate@1.1.0"])
    expect(byKey.get(key)?.status, key).toBe("no-license-file-upstream");
  const cli = "b9680937e10425bf19862908856c16ed274e6b81a1368bd62be7a757eab21628";
  for (const key of [
    "@github/copilot-sdk-linux-arm64@1.0.28",
    "@github/copilot-sdk-linux-x64@1.0.28",
  ]) {
    const pkg = byKey.get(key)!;
    if (pkg.status !== "vendored") throw new Error(key);
    expect(
      pkg.files.map((file) => [file.file, file.file.endsWith("CLI-LICENSE.md") ? file.sha256 : ""]),
    ).toEqual([
      ["GitHub-Copilot-CLI-LICENSE.md", cli],
      ["ripgrep-COPYING", ""],
      ["ripgrep-LICENSE-MIT", ""],
      ["ripgrep-UNLICENSE", ""],
      ["pcre2-LICENCE.md", ""],
      ["tgrep-LICENSE", ""],
    ]);
  }
});
