import { readFileSync } from "node:fs";

import {
  COMPUTER_USE_POLICY_FORMAT,
  ComputerUsePolicyGroup,
  type ComputerUsePolicyBody,
} from "@bigbud/contracts/core/settings.computerUsePolicy";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { encodeCanonicalPolicy, MAX_CANONICAL_POLICY_BYTES } from "./policy.canonical";
import { sealPolicy, verifyPolicy } from "./policy.digest";

const golden = new Map(
  readFileSync(
    new URL("../../../../protocol/computer-use/policy.v1.golden", import.meta.url),
    "utf8",
  )
    .split("\n")
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map((line) => line.split("=") as [string, string]),
);
const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

const base: ComputerUsePolicyBody = {
  format: COMPUTER_USE_POLICY_FORMAT,
  authorityId: "authority-1",
  revision: "1",
  enabled: false,
  disallowedApps: [],
  defaultDeliveryMode: "foreground",
  checkInIntervalMs: 600_000,
  actionTimeoutMs: 900_000,
  diagnosticMetadataEnabled: false,
};
const policyFixtures: Record<string, ComputerUsePolicyBody> = {
  minimal: base,
  selectors: {
    ...base,
    authorityId: "owner.a:1",
    revision: "18446744073709551615",
    enabled: true,
    defaultDeliveryMode: "background",
    checkInIntervalMs: 60_000,
    actionTimeoutMs: 10_000,
    diagnosticMetadataEnabled: true,
    disallowedApps: [
      { platform: "macos", kind: "path", value: "/Applications/Zed.app", label: "Zed" },
      { platform: "linux", kind: "executable", value: "/usr/bin/zed" },
      { platform: "macos", kind: "bundle_id", value: "com.apple.Terminal" },
      { platform: "windows", kind: "aumid", value: "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App" },
    ],
  },
  utf8_order: {
    ...base,
    revision: "0",
    enabled: true,
    checkInIntervalMs: 3_600_000,
    actionTimeoutMs: 3_600_000,
    disallowedApps: [
      { platform: "macos", kind: "path", value: "/Apps/\u{1F600}.app" },
      { platform: "macos", kind: "path", value: "/Apps/～.app" },
      { platform: "macos", kind: "path", value: "/Apps/Café.app" },
    ],
  },
};

describe("canonical computer-use policy encoding", () => {
  it.each(Object.entries(policyFixtures))("matches the frozen golden vector %s", (name, body) => {
    const encoded = encodeCanonicalPolicy(body);
    expect(encoded.ok && hex(encoded.bytes)).toBe(golden.get(`${name}.canonical`));
    const sealed = sealPolicy(body);
    expect(sealed.ok && sealed.group.digest).toBe(golden.get(`${name}.sha256`));
  });

  it("is independent of selector input order and labels", () => {
    const reversed = {
      ...policyFixtures.selectors!,
      disallowedApps: [...policyFixtures.selectors!.disallowedApps]
        .toReversed()
        .map(({ label: _label, ...selector }) => selector),
    };
    const sealed = sealPolicy(reversed);
    expect(sealed.ok && sealed.group.digest).toBe(golden.get("selectors.sha256"));
  });

  it("refuses duplicates, bad revisions, framing text and oversized policies", () => {
    const app = { platform: "macos", kind: "path", value: "/A.app" } as const;
    const cases: Array<[Partial<ComputerUsePolicyBody>, string]> = [
      [{ disallowedApps: [app, { ...app, label: "other label" }] }, "duplicate_selector"],
      [{ revision: "01" }, "invalid_revision"],
      [{ revision: "18446744073709551616" }, "invalid_revision"],
      [{ revision: "-1" }, "invalid_revision"],
      [{ disallowedApps: [{ ...app, value: "/A\n.app" }] }, "invalid_text"],
      [{ disallowedApps: [{ ...app, value: "/A\t.app" }] }, "invalid_text"],
      [{ disallowedApps: [{ ...app, value: "/\uD800.app" }] }, "invalid_text"],
      [{ authorityId: "bad id" }, "invalid_text"],
      [{ defaultDeliveryMode: "auto" as "foreground" }, "invalid_text"],
      [
        {
          disallowedApps: [
            { platform: "__proto__", kind: "path", value: "x" } as unknown as typeof app,
            { platform: "constructor", kind: "path", value: "y" } as unknown as typeof app,
          ],
        },
        "invalid_text",
      ],
      [{ checkInIntervalMs: 1.5 }, "out_of_range"],
      [{ checkInIntervalMs: 59_999 }, "out_of_range"],
      [{ actionTimeoutMs: 3_600_001 }, "out_of_range"],
      [
        {
          disallowedApps: [
            { platform: "macos", kind: "aumid", value: "x" } as unknown as typeof app,
          ],
        },
        "invalid_text",
      ],
      [
        {
          disallowedApps: Array.from({ length: 70 }, (_, index) => ({
            ...app,
            value: `/${"x".repeat(1000)}${index}.app`,
          })),
        },
        "oversized",
      ],
    ];
    for (const [patch, refusal] of cases) {
      expect(encodeCanonicalPolicy({ ...base, ...patch })).toEqual({ ok: false, refusal });
    }
    expect(MAX_CANONICAL_POLICY_BYTES).toBe(64 * 1024);
  });

  it("verifies stored groups and never repairs a digest mismatch", () => {
    const sealed = sealPolicy(policyFixtures.selectors!);
    if (!sealed.ok) throw new Error("seal");
    const decoded = Schema.decodeUnknownSync(ComputerUsePolicyGroup)(
      JSON.parse(JSON.stringify(sealed.group)),
    );
    expect(verifyPolicy(decoded).ok).toBe(true);
    expect(verifyPolicy({ ...decoded, enabled: false })).toEqual({
      ok: false,
      refusal: "digest_mismatch",
    });
    const missing = { ...sealed.group } as Record<string, unknown>;
    delete missing.disallowedApps;
    expect(() => Schema.decodeUnknownSync(ComputerUsePolicyGroup)(missing)).toThrow();
  });
});
