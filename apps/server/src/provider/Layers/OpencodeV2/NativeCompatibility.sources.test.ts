import { expect, it } from "vitest";
import type { OpencodeV2Client } from "./Client.ts";
import { validateV2NativeConfigSources } from "./NativeCompatibility.sources.ts";

type Entries = Awaited<ReturnType<OpencodeV2Client["config"]["get"]>>;
const directory = (path: string) => ({ type: "directory", path });
const document = (path: string, info: unknown = {}) => ({ type: "document", path, info });
const check = (
  entries: unknown[],
  profile: "v2-global-config-v1" | "v2-system-global-config-v1" = "v2-global-config-v1",
) =>
  validateV2NativeConfigSources(entries as Entries, "/fixture/user-global", profile, {
    platform: "darwin",
  });

it.each(["opencode.json", "opencode.jsonc"])(
  "accepts native global %s before its discovery directory",
  (filename) => {
    expect(
      check([
        document(`/fixture/user-global/${filename}`, { plugins: [] }),
        directory("/fixture/user-global"),
        directory("/fixture/home/.opencode"),
        directory("/fixture/project/.opencode"),
      ]).size,
    ).toBe(0);
  },
);

it("a leading global document cannot substitute for or misidentify the global directory", () => {
  const global = document("/fixture/user-global/opencode.json");
  for (const entries of [
    [global],
    [global, directory("/fixture/project/.opencode"), directory("/fixture/user-global")],
    [document("/fixture/project/opencode.json"), directory("/fixture/user-global")],
    [document("/fixture/user-global/other.json"), directory("/fixture/user-global")],
  ]) {
    expect(() => check(entries)).toThrow("source ordering");
  }
});

it("only the qualified ordered user-global candidate is writable, never a matching later project directory", () => {
  expect(
    check([directory("/fixture/user-global"), directory("/fixture/project/.opencode")]).size,
  ).toBe(0);
  expect(() =>
    check([directory("/fixture/other-global"), directory("/fixture/user-global")]),
  ).toThrow("source ordering");
  expect(() =>
    check([directory("/fixture/project/.opencode"), directory("/fixture/user-global")]),
  ).toThrow("source ordering");
});

it("the system profile returns machine policy paths for native-only projection handling, without reading them", () => {
  const system = "/Library/Application Support/opencode",
    managed = "/Library/Managed Preferences/ai.opencode.managed.plist";
  expect([
    ...check(
      [
        directory(system),
        document(`${system}/opencode.json`, {
          permissions: [{ action: "*", resource: "*", effect: "deny" }],
        }),
        document(managed, { plugins: ["-bigbud.thread.v1"] }),
        directory("/fixture/user-global"),
        directory("/fixture/project/.opencode"),
      ],
      "v2-system-global-config-v1",
    ),
  ]).toEqual([`${system}/opencode.json`, managed]);
  expect(() => check([directory(system), directory("/fixture/user-global")])).toThrow();
});

it.each(
  [
    [directory("/fixture/user-global"), directory("/fixture/user-global")],
    [directory("/fixture/user-global/../user-global")],
    [directory("/fixture/user-global"), directory("/Library/Application Support/opencode")],
    [document("/unknown/native-policy.json"), directory("/fixture/user-global")],
    [{ type: "unknown", path: "/fixture/user-global" }],
    [
      directory("/fixture/user-global"),
      document("/Library/Managed Preferences/ai.opencode.managed.plist"),
    ],
    [
      directory("/fixture/user-global"),
      document("/fixture/user-global/opencode.json", { permission: "allow" }),
    ],
    [
      directory("/fixture/user-global"),
      document("/fixture/user-global/opencode.json", {
        permissions: [{ action: "*", resource: "*", effect: "future" }],
      }),
    ],
    [
      directory("/fixture/user-global"),
      document("/fixture/user-global/opencode.json", {
        permissions: [{ action: "*", resource: "*", effect: "allow", required: false }],
      }),
    ],
  ].map((entries) => ({ entries })),
)("ambiguous/unsupported source or policy evidence stays blocked: $entries", ({ entries }) => {
  expect(() => check(entries, "v2-system-global-config-v1")).toThrow("no machine files");
});
