import { expect, it } from "vitest";
import {
  selectV2NativeConfigProfile,
  validateV2NativeConfigSources,
  projectV2NativeConfigSources,
} from "./NativeCompatibility.sources.ts";
import { v2UpgradeSources } from "./NativeCompatibility.upgrade.fixture.ts";
import type { V2ConfigSourcePlatform } from "./NativeCompatibility.sources.platform.ts";
import type { OpencodeV2Client } from "./Client.ts";

type Entries = Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;
const platforms = [
  { platform: "darwin", root: "/fixture/global" },
  { platform: "linux", root: "/fixture/global" },
  { platform: "win32", root: "C:\\fixture\\global", programData: "C:\\ProgramData" },
] as const;

it.each(platforms)(
  "$platform models official 2.1.4/2.2.0 pairs, virtuals and late discovery without authority expansion",
  (platform) => {
    for (const version of ["2.1.4", "2.2.0"] as const) {
      const entries = v2UpgradeSources(platform.root, version, platform);
      expect(selectV2NativeConfigProfile(entries, platform.root, platform)).toBe(
        "v2-system-global-config-v1",
      );
      const machine = validateV2NativeConfigSources(
        entries,
        platform.root,
        "v2-system-global-config-v1",
        platform,
      );
      expect(machine.size).toBe(platform.platform === "darwin" ? 2 : 1);
      const projected = projectV2NativeConfigSources(entries);
      expect(JSON.stringify(projected)).not.toContain("DO-NOT-CARRY");
      expect(
        projected
          .filter((entry) => entry.type === "document" && !entry.path)
          .every((entry) => !entry.path),
      ).toBe(true);
      expect(() =>
        validateV2NativeConfigSources(
          entries,
          "/substituted",
          "v2-system-global-config-v1",
          platform,
        ),
      ).toThrow();
    }
  },
);

const root = "/fixture/global";
const platform: V2ConfigSourcePlatform = { platform: "darwin" };
const check = (entries: unknown[]) =>
  validateV2NativeConfigSources(entries as Entries, root, "v2-system-global-config-v1", platform);
const dir = (path = root) => ({ type: "directory", path });
const doc = (path?: string, info: unknown = {}) => ({
  type: "document",
  ...(path ? { path } : {}),
  info,
});
const machine = "/Library/Application Support/opencode/opencode.json";
const policies = { policies: [{ action: "tool.use", resource: "*", effect: "deny" }] };

it("rejects root substitution, unsafe namespaces, unexplained duplicates and malformed phases with bounded codes", () => {
  const cases: Array<[string, unknown[]]> = [
    ["source-root", [doc(), doc(root + "/opencode.json")]],
    ["source-root", [doc(), dir("/project/.opencode"), dir()]],
    ["source-phase", [doc(root + "/opencode.json"), doc(), dir()]],
    ["source-duplicate", [dir(), dir()]],
    ["source-duplicate", [dir(), doc("/project/file.json"), doc("/project/file.json")]],
    ["source-phase", [doc(machine, policies), dir()]],
    ["source-duplicate", [doc(machine, policies), doc(machine, policies), dir()]],
    ["source-phase", [doc(machine, { plugins: [] }), dir()]],
    ["source-phase", [dir(), doc(machine, policies)]],
    ["source-duplicate", [dir(), doc(machine), doc(machine)]],
    [
      "source-phase",
      [dir(), dir("/Library/Application Support/opencode"), doc("/project/file.json")],
    ],
    ["source-phase", [dir(), doc(), dir("/project/.opencode")]],
    ["source-phase", [dir(), doc("/Library/other.json")]],
    ["source-shape", [dir(), dir("/")]],
    ["source-shape", [dir(), doc("/project/../file.json")]],
  ];
  for (const [code, entries] of cases) {
    try {
      check(entries);
      throw new Error("accepted invalid fixture");
    } catch (error) {
      expect(error).toMatchObject({ reasonCode: "config-source-unverified", diagnostic: { code } });
    }
  }
});

it("bounds source arrays/bytes and control rules without exposing inputs", () => {
  for (const entries of [
    Array.from({ length: 257 }, () => doc()),
    [doc(undefined, { private: "x".repeat(2097152) }), dir()],
  ])
    expect(() => check(entries)).toThrow("source-bounds");
  for (const info of [
    { policies: [{ action: "future", resource: "*", effect: "deny" }] },
    { policies: [{ action: "tool.use", resource: "*", effect: "ask" }] },
    { policies: [{ action: "tool.use", resource: "*", effect: "deny", message: "private" }] },
    { policies: [{ action: "tool.use", resource: "x".repeat(4097), effect: "deny" }] },
    { policies: Array.from({ length: 1001 }, () => policies.policies[0]) },
    { experimental: { policies: [] } },
  ])
    expect(() => check([doc(undefined, info), dir()])).toThrow("policy-unsupported");
});

it("Windows rejects aliases, roots, UNC/device/ADS paths and permits only the recognized case-folded split pair", () => {
  const windows = platforms[2];
  const entries = v2UpgradeSources(windows.root, "2.2.0", windows);
  const checkWindows = (input: Entries, root = windows.root as string) =>
    validateV2NativeConfigSources(input, root, "v2-system-global-config-v1", windows);
  for (const bad of [
    "C:\\",
    "\\\\host\\share",
    "\\\\?\\C:\\global",
    "C:\\global:stream",
    "C:/global",
  ])
    expect(() => checkWindows(entries, bad)).toThrow();
  expect(() =>
    checkWindows([...entries, { type: "directory", path: windows.root.toLowerCase() }]),
  ).toThrow("source-duplicate");
  const first = entries[0]!;
  expect(first.type).toBe("document");
  if (first.type === "document") first.path = first.path!.toLowerCase();
  expect(checkWindows(entries).size).toBe(2); // both spellings excluded from raw reads
});

it("accepts both system config filenames and MDM split pairs only in native reversed/late order", () => {
  const system = "/Library/Application Support/opencode";
  const json = `${system}/opencode.json`,
    jsonc = `${system}/opencode.jsonc`;
  const preference = "/Library/Managed Preferences/fixture/ai.opencode.managed.plist";
  const entries = [
    doc(preference, policies),
    doc(jsonc, policies),
    doc(json, policies),
    doc(),
    dir(),
    doc(json),
    doc(jsonc),
    dir(system),
    doc(preference),
  ];
  expect([...check(entries)]).toEqual([preference, jsonc, json]);
  const wrongPriority = [...entries];
  [wrongPriority[1], wrongPriority[2]] = [wrongPriority[2]!, wrongPriority[1]!];
  expect(() => check(wrongPriority)).toThrow("source-phase");
  expect(() =>
    check(entries.filter((entry) => entry.type !== "directory" || entry.path !== system)),
  ).toThrow("source-phase");
  expect(() => check([dir(system), ...entries])).toThrow("source-root");
  expect(() => check([...entries, doc(preference)])).toThrow("source-duplicate");
});
