import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildRemoteBackendControl } from "./build-remote-backend-control.ts";
import { runArchive } from "./lib/remote-backend-control/archive.ts";
import {
  addonDestination,
  collectClosure,
  hashFile,
  parsePins,
  pinnedInputs,
  type ControlPins,
  type ClosureEntry,
} from "./lib/remote-backend-control/closure.ts";
import { verifyExtractedClosure } from "./lib/remote-backend-control/verify.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "bigbud-control-recipe-"));
  roots.push(root);
  const baselineRoot = join(root, "baseline");
  for (const path of Object.values(pinnedInputs)) {
    await mkdir(dirname(join(baselineRoot, path)), { recursive: true });
    await writeFile(join(baselineRoot, path), path);
  }
  const packageRoot = join(baselineRoot, "package");
  await mkdir(dirname(join(packageRoot, addonDestination)), { recursive: true });
  await writeFile(join(packageRoot, addonDestination), "original-bookworm-addon");
  await writeFile(join(packageRoot, "package.json"), "{}");
  await writeFile(join(packageRoot, "verify.mjs"), "must not be packaged");
  await chmod(join(packageRoot, "runtime/node"), 0o755);
  await mkdir(join(packageRoot, "node_modules/.bin"));
  await symlink(
    "../node-pty/build/Release/pty.node",
    join(packageRoot, "node_modules/.bin/fixture"),
  );
  await writeFile(join(packageRoot, "dist", `${"long-name-".repeat(15)}.mjs`), "long path");
  const pins = Object.fromEntries(
    await Promise.all(
      Object.entries(pinnedInputs).map(async ([key, path]) => [
        key,
        await hashFile(join(baselineRoot, path)),
      ]),
    ),
  ) as ControlPins;
  return { root, baselineRoot, packageRoot, pins, outputRoot: join(root, "output") };
}

describe("experimental remote backend control recipe", () => {
  it("reproduces archive bytes across paths/mtimes, installs the overlay and preserves inputs", async () => {
    const input = await fixture();
    const original = await hashFile(join(input.packageRoot, addonDestination));
    const first = await buildRemoteBackendControl(input);
    await utimes(join(input.packageRoot, "dist/bin.mjs"), 123, 456);
    const second = await buildRemoteBackendControl({
      ...input,
      outputRoot: join(input.root, "second"),
    });
    expect(first.archive.sha256).toBe(second.archive.sha256);
    expect(first.archive.sizeBytes).toBe(second.archive.sizeBytes);
    expect(await hashFile(join(input.packageRoot, addonDestination))).toBe(original);
    expect(await hashFile(join(input.outputRoot, "extracted", addonDestination))).toBe(
      input.pins.addon,
    );
    expect(await readdir(join(input.outputRoot, "extracted"))).not.toContain("verify.mjs");
    const provenance = JSON.parse(
      await readFile(join(input.outputRoot, "provenance.json"), "utf8"),
    );
    expect(provenance.shippingAcceptance).toBe(false);
    expect(provenance.linuxRuntimeSmoke).toBe("not-run");
    expect(provenance.extractionVerified).toBe(true);
    expect(JSON.stringify(provenance)).not.toContain(input.root);
    await expect(buildRemoteBackendControl(input)).rejects.toThrow("EEXIST");
    expect(await hashFile(join(input.outputRoot, first.archive.name))).toBe(first.archive.sha256);
  });

  it("refuses pin mismatch before output creation", async () => {
    const input = await fixture();
    await writeFile(join(input.baselineRoot, pinnedInputs.addon), "unexpected addon");
    await expect(buildRemoteBackendControl(input)).rejects.toThrow("Input pin mismatch: addon");
    expect(await readdir(input.root)).toEqual(["baseline"]);
  });

  it("refuses output inside evidence even through a parent symlink", async () => {
    const input = await fixture();
    const alias = join(input.root, "alias");
    await symlink(input.baselineRoot, alias);
    await expect(
      buildRemoteBackendControl({ ...input, outputRoot: join(alias, "output") }),
    ).rejects.toThrow("separate from protected baseline");
  });

  it("refuses a pinned input reached through a symlink", async () => {
    const input = await fixture();
    const source = join(input.packageRoot, "dist/bin.mjs");
    await writeFile(join(input.packageRoot, "dist/alias.mjs"), await readFile(source));
    await rm(source);
    await symlink("alias.mjs", source);
    await expect(collectClosure(input.baselineRoot, input.pins)).rejects.toThrow(
      "regular unlinked file",
    );
  });

  it.each(["escape", "excluded", "dangling"])("refuses %s closure links", async (kind) => {
    const input = await fixture();
    const target =
      kind === "escape"
        ? "../../../../outside"
        : kind === "excluded"
          ? "../../verify.mjs"
          : "../missing";
    await writeFile(join(input.root, "outside"), "not package data");
    await symlink(target, join(input.packageRoot, "node_modules/.bin/bad"));
    await expect(collectClosure(input.baselineRoot, input.pins)).rejects.toThrow();
  });

  it("refuses tampered extracted bytes and added files", async () => {
    const input = await fixture();
    await buildRemoteBackendControl(input);
    const { entries } = await collectClosure(input.baselineRoot, input.pins);
    const extracted = join(input.outputRoot, "extracted");
    await writeFile(join(extracted, "dist/bin.mjs"), "corrupt");
    await expect(verifyExtractedClosure(extracted, entries)).rejects.toThrow("file mismatch");
    await writeFile(
      join(extracted, "dist/bin.mjs"),
      await readFile(join(input.packageRoot, "dist/bin.mjs")),
    );
    await writeFile(join(extracted, "surprise"), "unexpected");
    await expect(verifyExtractedClosure(extracted, entries)).rejects.toThrow(
      "Unexpected extracted entry",
    );
  });

  it("rejects missing, invalid and unknown input pins", () => {
    expect(() => parsePins({})).toThrow("Missing or invalid input pin");
    expect(() => parsePins(null)).toThrow("Expected input SHA-256 pins");
    expect(() =>
      parsePins({
        ...Object.fromEntries(Object.keys(pinnedInputs).map((key) => [key, "a".repeat(64)])),
        extra: "a".repeat(64),
      }),
    ).toThrow("Unexpected input pin");
  });
});

describe("control archive extraction refuses unsafe tar members before writing payloads", () => {
  it.each([
    "traversal",
    "absolute",
    "backslash",
    "drive",
    "hardlink",
    "device",
    "duplicate",
    "symlink",
    "size",
    "missing",
  ])("rejects %s", async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "bigbud-control-unsafe-"));
    roots.push(root);
    const archive = join(root, "unsafe.tar.gz");
    const canary = join(root, "canary");
    await writeFile(canary, "unchanged");
    const result = spawnSync(
      process.platform === "win32" ? "python" : "python3",
      [
        "-c",
        String.raw`
import io, sys, tarfile
archive, kind, canary = sys.argv[1:]
with tarfile.open(archive, 'w:gz') as tar:
    if kind != 'missing':
        name = {'traversal': '../canary', 'absolute': canary, 'backslash': '..\\canary', 'drive': 'C:/canary'}.get(kind, 'payload')
        member = tarfile.TarInfo(name)
        member.mode = 0o644
        member.size = 1
        if kind in ('hardlink', 'device', 'symlink'):
            member.type = {'hardlink': tarfile.LNKTYPE, 'device': tarfile.CHRTYPE, 'symlink': tarfile.SYMTYPE}[kind]
            member.linkname = canary
            member.size = 0
        if kind == 'size': member.size = 2
        tar.addfile(member, io.BytesIO(b'xx'))
        if kind == 'duplicate': tar.addfile(member, io.BytesIO(b'x'))
`,
        archive,
        kind,
        canary,
      ],
      { encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    const entries: ClosureEntry[] = [
      {
        path: "payload",
        kind: "file",
        mode: 0o644,
        size: 1,
        sha256: "a".repeat(64),
        source: "unused",
      },
    ];
    const destination = join(root, "extracted");
    expect(() => runArchive({ action: "extract", entries, archive, destination })).toThrow();
    expect(await readFile(canary, "utf8")).toBe("unchanged");
    expect(await readdir(destination)).toEqual([]);
  });
});
