import { chmod, mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { SshOwnerProfile } from "./sshOwnerProductionArtifact.ts";
import {
  SSH_OWNER_PROFILE_BINDING_ENV,
  deriveSshOwnerProfileBinding,
  encodeSshOwnerProfileBinding,
  parseSshOwnerProfileBinding,
  SshOwnerProfileError,
  sshOwnerProfileDigest,
} from "./sshOwnerProductionProfile.ts";

const kinds: ReadonlyArray<SshOwnerProfile> = [
  "desktop-packaged",
  "desktop-dev",
  "standalone",
  "remote-backend",
];

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function stateDirectory() {
  const directory = await mkdtemp(join(await realpath(tmpdir()), "bigbud-profile-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const reasonOf = (run: () => unknown) => {
  try {
    run();
  } catch (error) {
    if (error instanceof SshOwnerProfileError) return error.reason;
    throw error;
  }
  throw new Error("expected a typed profile refusal");
};

describe("production SSH owner profile derivation", () => {
  it("matches the cross-language preimage vector", () => {
    expect(
      sshOwnerProfileDigest(
        "desktop-packaged",
        "/var/lib/bigbud",
        "16777220",
        "123456789",
      ).toString("hex"),
    ).toBe("4352f14d69f3d45c82c62495095c9cf90a216ccabf6845ffb23e0ed6cadbda78");
  });

  it("derives a stable, kind-scoped binding from the canonical state directory", async () => {
    const directory = await stateDirectory();
    const bindings = kinds.map((kind) =>
      deriveSshOwnerProfileBinding({ kind, stateDirectory: directory }),
    );
    for (const [index, binding] of bindings.entries()) {
      const kind = kinds[index]!;
      expect(binding.kind).toBe(kind);
      expect(binding.stateDirectory).toBe(directory);
      expect(binding.text).toBe(encodeSshOwnerProfileBinding(kind, directory, binding.digest));
      expect(binding.text.startsWith(`bbso1:${kind}:`)).toBe(true);
      expect(binding.digest).toHaveLength(32);
      expect(deriveSshOwnerProfileBinding({ kind, stateDirectory: directory })).toEqual(binding);
    }
    expect(new Set(bindings.map((binding) => binding.digest.toString("hex"))).size).toBe(
      kinds.length,
    );
  });

  it("parses only the exact versioned startup form", () => {
    const digest = Buffer.alloc(32, 7);
    const text = encodeSshOwnerProfileBinding("standalone", "/var/lib/bigbud", digest);
    expect(parseSshOwnerProfileBinding(text)).toEqual({ kind: "standalone", digest });
    for (const malformed of [
      "bbso1:standalone",
      "bbso2:standalone:" + digest.toString("hex"),
      "bbso1:unknown:" + digest.toString("hex"),
      "bbso1:standalone:" + "zz".repeat(32),
      text + ":extra",
    ]) {
      expect(parseSshOwnerProfileBinding(malformed)).toBeUndefined();
    }
  });

  it("refuses a missing or non-canonical state directory", async () => {
    const directory = await stateDirectory();
    expect(
      reasonOf(() =>
        deriveSshOwnerProfileBinding({
          kind: "desktop-packaged",
          stateDirectory: join(directory, "missing"),
        }),
      ),
    ).toBe("owner-profile-missing");
    expect(
      reasonOf(() =>
        deriveSshOwnerProfileBinding({
          kind: "desktop-packaged",
          stateDirectory: `${directory}/nested/..`,
        }),
      ),
    ).toBe("owner-profile-not-canonical");
    const linked = join(directory, "linked");
    const target = join(directory, "real");
    await mkdir(target, { mode: 0o700 });
    await symlink(target, linked);
    expect(
      reasonOf(() =>
        deriveSshOwnerProfileBinding({ kind: "desktop-packaged", stateDirectory: linked }),
      ),
    ).toBe("owner-profile-not-canonical");
  });

  it("refuses a non-directory and an unsafe directory", async () => {
    const directory = await stateDirectory();
    const file = join(directory, "file");
    await writeFile(file, "not a directory");
    const unsafe = join(directory, "unsafe");
    await mkdir(unsafe, { mode: 0o700 });
    await chmod(unsafe, 0o777);
    expect(
      reasonOf(() => deriveSshOwnerProfileBinding({ kind: "standalone", stateDirectory: file })),
    ).toBe("owner-profile-not-directory");
    expect(
      reasonOf(() => deriveSshOwnerProfileBinding({ kind: "standalone", stateDirectory: unsafe })),
    ).toBe("owner-profile-unsafe");
  });

  it("ignores an environment override in packaged and remote builds", async () => {
    const directory = await stateDirectory();
    const fixture = `bbso1:desktop-packaged:${"a".repeat(64)}`;
    for (const kind of ["desktop-packaged", "remote-backend", "standalone"] as const) {
      const derived = deriveSshOwnerProfileBinding({ kind, stateDirectory: directory });
      expect(
        deriveSshOwnerProfileBinding({
          kind,
          stateDirectory: directory,
          environment: { [SSH_OWNER_PROFILE_BINDING_ENV]: fixture },
        }),
      ).toEqual(derived);
    }
  });

  it("accepts a fixture binding only for a gated dev build", async () => {
    const directory = await stateDirectory();
    const override = `bbso1:desktop-dev:${"b".repeat(64)}`;
    const derived = deriveSshOwnerProfileBinding({
      kind: "desktop-dev",
      stateDirectory: directory,
    });
    expect(
      deriveSshOwnerProfileBinding({
        kind: "desktop-dev",
        stateDirectory: directory,
        environment: { [SSH_OWNER_PROFILE_BINDING_ENV]: override },
        devFixtureGate: false,
      }),
    ).toEqual(derived);
    const fixture = deriveSshOwnerProfileBinding({
      kind: "desktop-dev",
      stateDirectory: directory,
      environment: { [SSH_OWNER_PROFILE_BINDING_ENV]: override },
      devFixtureGate: true,
    });
    expect(fixture.digest).toEqual(Buffer.alloc(32, 0xbb));
    expect(fixture.text).toBe(
      encodeSshOwnerProfileBinding("desktop-dev", directory, fixture.digest),
    );
    // A gated packaged build still ignores the dev-only fixture value.
    expect(
      deriveSshOwnerProfileBinding({
        kind: "desktop-packaged",
        stateDirectory: directory,
        environment: { [SSH_OWNER_PROFILE_BINDING_ENV]: override },
        devFixtureGate: true,
      }).digest,
    ).not.toEqual(Buffer.alloc(32, 0xbb));
  });
});
