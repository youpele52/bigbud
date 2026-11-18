import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  cleanupGraphFixtures,
  privateBase,
  writeTree,
} from "./build-remote-backend-graph.fixture.ts";
import {
  crateClosure,
  linkedCrateNoticeEntries,
  linkedRuntimeNotes,
  rustCrateLicenses,
  rustLicenseInventory,
  type CargoMetadata,
} from "./rust-dependency-licenses.logic.ts";

afterEach(cleanupGraphFixtures);
const io = "registry+https://github.com/rust-lang/crates.io-index";
const dep = (pkgId: string, kind: string | null = null) => ({ pkg: pkgId, dep_kinds: [{ kind }] });

async function fixture(): Promise<CargoMetadata> {
  const root = await privateBase("bb-rust-licenses-");
  await writeTree(root, {
    LICENSE: "MIT bigbud",
    "crates/agent/Cargo.toml": "",
    "registry/lib-1.0.0/Cargo.toml": "",
    "registry/lib-1.0.0/LICENSE-MIT": "MIT lib",
    "registry/lib-1.0.0/LICENSE-APACHE": "Apache lib",
    "registry/bare-0.1.0/Cargo.toml": "",
    "registry/custom-2.0.0/Cargo.toml": "",
    "registry/custom-2.0.0/legal/TERMS.txt": "custom terms",
    "registry/macro-1.0.0/Cargo.toml": "",
    "registry/macro-1.0.0/LICENSE": "macro",
    "registry/buildy-1.0.0/Cargo.toml": "",
    "registry/test-only-1.0.0/Cargo.toml": "",
  });
  const pkg = (
    id: string,
    dir: string,
    extra: Partial<CargoMetadata["packages"][number]> = {},
  ) => ({
    id,
    name: id.split("@")[0]!,
    version: id.split("@")[1]!,
    license: "MIT",
    license_file: null,
    source: io,
    repository: null,
    manifest_path: join(root, dir, "Cargo.toml"),
    targets: [{ kind: ["lib"] }],
    ...extra,
  });
  return {
    workspace_root: root,
    workspace_members: ["agent@0.1.0"],
    packages: [
      pkg("agent@0.1.0", "crates/agent", { source: null }),
      pkg("lib@1.0.0", "registry/lib-1.0.0", { license: "MIT OR Apache-2.0" }),
      pkg("bare@0.1.0", "registry/bare-0.1.0", { license: null }),
      pkg("custom@2.0.0", "registry/custom-2.0.0", {
        license: null,
        license_file: "legal/TERMS.txt",
        source: "git+https://example.invalid/custom#abc",
      }),
      pkg("macro@1.0.0", "registry/macro-1.0.0", { targets: [{ kind: ["proc-macro"] }] }),
      pkg("buildy@1.0.0", "registry/buildy-1.0.0"),
      pkg("test-only@1.0.0", "registry/test-only-1.0.0"),
    ],
    resolve: {
      nodes: [
        {
          id: "agent@0.1.0",
          deps: [
            dep("lib@1.0.0"),
            dep("macro@1.0.0"),
            dep("custom@2.0.0"),
            dep("test-only@1.0.0", "dev"),
          ],
        },
        { id: "lib@1.0.0", deps: [dep("bare@0.1.0"), dep("buildy@1.0.0", "build")] },
        { id: "macro@1.0.0", deps: [dep("lib@1.0.0")] },
      ],
    },
  };
}

it("rust_licenses_follow_shipped_and_build_edges_only", async () => {
  const metadata = await fixture();
  expect(
    crateClosure(metadata, "agent")
      .map(({ pkg, use }) => `${pkg.name}:${use}`)
      .toSorted(),
  ).toEqual([
    "agent:linked",
    "bare:linked",
    "buildy:build-time",
    "custom:linked",
    "lib:linked",
    "macro:build-time",
  ]);
  expect(() => crateClosure(metadata, "missing")).toThrow("is not resolved");
});

it("rust_licenses_record_evidence_and_render_notices", async () => {
  const metadata = await fixture();
  const { crates, sources } = await rustCrateLicenses(metadata, "agent");
  const view = Object.fromEntries(
    crates.map((c) => [c.name, [c.source, c.evidence, c.files.map((f) => f.path)]]),
  );
  expect(view).toEqual({
    agent: ["workspace", "file", ["workspace/LICENSE"]],
    bare: ["crates.io", "missing", []],
    buildy: ["crates.io", "declared", []],
    custom: ["git+https://example.invalid/custom#abc", "file", ["custom@2.0.0/legal/TERMS.txt"]],
    lib: ["crates.io", "file", ["lib@1.0.0/LICENSE-APACHE", "lib@1.0.0/LICENSE-MIT"]],
    macro: ["crates.io", "file", ["macro@1.0.0/LICENSE"]],
  });
  expect(sources.get("custom@2.0.0/legal/TERMS.txt")).toBe(
    join(metadata.workspace_root, "registry/custom-2.0.0/legal/TERMS.txt"),
  );
  const inventory = rustLicenseInventory({
    root: "agent",
    target: "x86_64-unknown-linux-musl",
    cargoLockSha256: "0".repeat(64),
    crates,
  });
  expect(inventory.summary).toMatchObject({
    crates: 6,
    byUse: { "build-time": 2, linked: 4 },
    byEvidence: { declared: 1, file: 4, missing: 1 },
    withoutLicenseFiles: ["bare@0.1.0", "buildy@1.0.0"],
  });
  // No build-machine paths leak into the inventory.
  expect(JSON.stringify(inventory)).not.toContain(metadata.workspace_root);
  expect(linkedCrateNoticeEntries(crates).map((e) => `${e.kind}:${e.name}`)).toEqual([
    "project:agent",
    "package:bare",
    "package:custom",
    "package:lib",
  ]);
  expect(linkedRuntimeNotes("x86_64-unknown-linux-musl").join(" ")).toContain("musl libc");
  expect(linkedRuntimeNotes("aarch64-unknown-linux-gnu").join(" ")).toContain("not shipped");
});
