import { expect, it } from "vitest";
import { createHash } from "node:crypto";
import { knownV2BootstrapCompatibility } from "./Orchestration.compatibility.ts";
import {
  V2_N5_BOOTSTRAP_COMPATIBILITY,
  V2_N5_COMPATIBILITY_DIGEST,
  V2_N7_BOOTSTRAP_COMPATIBILITY,
  V2_N7_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import { V2_NATIVE_POLICY_ACTIONS } from "./NativeCompatibility.policy.actions.ts";
import { validateV2ConfigControls } from "./NativeCompatibility.sources.controls.ts";
import { assertV2CanonicalNativeApi } from "./NativeCompatibility.api.ts";
import { v2CanonicalApiFixture } from "./NativeCompatibility.api.fixture.ts";
import { schemaObject } from "./SharedService.schema.ts";
import {
  assertV2RawPolicyProjection,
  v2NativePolicyDecision,
  v2NativePolicyStatements,
} from "./PluginSetup.policy.native.ts";
import { inspectV2PluginControls } from "./PluginSetup.policy.ts";

it.each([
  [V2_N5_BOOTSTRAP_COMPATIBILITY, V2_N5_COMPATIBILITY_DIGEST],
  [V2_N7_BOOTSTRAP_COMPATIBILITY, V2_N7_COMPATIBILITY_DIGEST],
])(
  "retains the exact prior descriptor without rewriting signed bootstrap evidence",
  (descriptor, digest) => {
    expect(createHash("sha256").update(JSON.stringify(descriptor)).digest("hex")).toBe(digest);
    expect(knownV2BootstrapCompatibility(descriptor, digest)).toBe(descriptor);
  },
);

it.each(V2_NATIVE_POLICY_ACTIONS)("preserves ordered allow/deny semantics for %s", (action) => {
  const deny = { action, resource: "*", effect: "deny" as const };
  const allow = { action, resource: "required", effect: "allow" as const };
  expect(() => validateV2ConfigControls({ policies: [deny, allow] })).not.toThrow();
  expect(
    v2NativePolicyDecision(
      v2NativePolicyStatements([{ policies: [deny, allow] }]),
      action,
      "required",
    ),
  ).toBe("allow");
  expect(
    v2NativePolicyDecision(
      v2NativePolicyStatements([{ policies: [deny] }, { policies: [allow] }]),
      action,
      "required",
    ),
  ).toBe("deny");
  expect(() =>
    assertV2RawPolicyProjection({ policies: [deny, allow] }, { policies: [deny, allow] }),
  ).not.toThrow();
  expect(() =>
    assertV2RawPolicyProjection({ policies: [deny, allow] }, { policies: [allow, deny] }),
  ).toThrow();
});

it("accepts the source-backed 2.2.6 action enum but not future security semantics", () => {
  const contract = v2CanonicalApiFixture();
  const policies = schemaObject(
    contract.components.schemas["Config.InfoEncoded"]!.properties.policies,
  );
  const action = schemaObject(schemaObject(schemaObject(policies.items).properties).action);
  action.enum = [...V2_NATIVE_POLICY_ACTIONS];
  expect(assertV2CanonicalNativeApi(contract, "2.2.6")).toMatch(/^[a-f0-9]{64}$/);
  action.enum = [...V2_NATIVE_POLICY_ACTIONS, "future.use"];
  expect(() => assertV2CanonicalNativeApi(contract, "2.2.6")).toThrow("incompatible");
  expect(() =>
    validateV2ConfigControls({
      policies: [{ action: "future.use", resource: "*", effect: "deny" }],
    }),
  ).toThrow();
});

it.each(["mcp", "skill", "plugin"] as const)(
  "reconciles only the native legacy %s prefix migration",
  (prefix) => {
    const raw = { action: "integration.use", resource: `${prefix}:required`, effect: "deny" };
    const canonical = { ...raw, action: `${prefix}.use`, resource: "required" };
    expect(() =>
      assertV2RawPolicyProjection({ policies: [raw] }, { policies: [canonical] }),
    ).not.toThrow();
    expect(() =>
      assertV2RawPolicyProjection(
        { policies: [raw] },
        { policies: [{ ...canonical, effect: "allow" }] },
      ),
    ).toThrow();
  },
);

it("does not reinterpret a bare integration wildcard as plugin authority", () => {
  expect(() =>
    assertV2RawPolicyProjection(
      { policies: [{ action: "integration.use", resource: "*", effect: "deny" }] },
      { policies: [{ action: "plugin.use", resource: "*", effect: "deny" }] },
    ),
  ).toThrow();
});

it("blocks canonical plugin denial before any raw file inspection or installation", async () => {
  const entries = [
    {
      type: "document",
      info: { policies: [{ action: "plugin.use", resource: "*", effect: "deny" }] },
    },
  ];
  await expect(
    inspectV2PluginControls(
      entries as unknown as Parameters<typeof inspectV2PluginControls>[0],
      "/fixture/global",
      { signal: new AbortController().signal, assertCurrent: () => {} },
      "/fixture/workspace",
    ),
  ).rejects.toMatchObject({ diagnostic: { code: "policy-denied" } });
});
