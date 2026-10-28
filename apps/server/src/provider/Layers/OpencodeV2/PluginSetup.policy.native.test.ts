import { expect, it } from "vitest";
import {
  assertV2RequiredToolPolicies,
  assertV2RawPolicyProjection,
  v2NativePolicyDecision,
  v2NativePolicyMatches,
  v2NativePolicyStatements,
} from "./PluginSetup.policy.native.ts";
import type { V2ConfigPolicy } from "./NativeCompatibility.sources.controls.ts";

const name = "bb2_fixture_list_threads";
const rule = (
  effect: "allow" | "deny",
  resource = `${name}:*`,
  action: V2ConfigPolicy["action"] = "tool.use",
) => ({ action, resource, effect });
const info = (...policies: V2ConfigPolicy[]) => ({ policies });
const inspect = (...documents: Record<string, unknown>[]) =>
  assertV2RequiredToolPolicies(documents, [name]);

it("managed > unattributed leading virtual > user/project precedence reverses documents, not statements", () => {
  const deny = info(rule("deny")),
    allow = info(rule("allow"));
  expect(() => inspect(deny, allow, allow)).toThrow("policy-denied");
  expect(() => inspect(allow, deny, deny)).not.toThrow();
  expect(() => inspect({}, deny, allow)).toThrow("policy-denied");
  expect(() => inspect(info(rule("deny"), rule("allow")), deny)).not.toThrow();
  expect(() => inspect(info(rule("allow"), rule("deny")), allow)).toThrow("policy-denied");
  const policies = v2NativePolicyStatements([deny, allow]);
  expect(policies.map((policy) => policy.effect)).toEqual(["allow", "deny"]);
});

it("native tool.use matches permission action:resource, never policy action globs or permission grants", () => {
  expect(
    v2NativePolicyDecision([rule("deny", "edit:/workspace/*")], "tool.use", "edit:/workspace/file"),
  ).toBe("deny");
  expect(
    v2NativePolicyDecision([rule("deny", "edit:/workspace/*")], "tool.use", "read:/workspace/file"),
  ).toBe("allow");
  expect(v2NativePolicyDecision([rule("deny", "*")], "provider.use", "native-provider")).toBe(
    "allow",
  );
  expect(() => inspect(info(rule("deny", "*")))).toThrow("policy-denied");
  expect(() => inspect(info(rule("deny", "*:*")))).toThrow("policy-denied");
  expect(() => inspect(info(rule("deny", "bb2_*:*")))).toThrow("policy-denied");
  expect(() => inspect(info(rule("deny", "other_tool:*")))).not.toThrow();
  expect(() =>
    inspect({
      permissions: [{ action: name, resource: "*", effect: "allow" }],
      policies: [rule("deny")],
    }),
  ).toThrow("policy-denied");
  expect(() => inspect(info({ ...rule("allow"), action: "*" } as never))).toThrow(
    "policy-unsupported",
  );
});

it("relevant unprovable resource cases block but unrelated native policies do not", () => {
  for (const resource of [
    `${name}:private`,
    `${name}:?`,
    `${name}:C:\\private`,
    "*threads:private",
    "*:*private",
  ])
    expect(() => inspect(info(rule("deny", resource)))).toThrow("policy-unsupported");
  for (const resource of [
    "read:/workspace/*",
    "shell:git *",
    "different_tool:private",
    "unrelated",
    "unrelated*",
    "provider.use",
    "read:C:\\private",
  ])
    expect(() => inspect(info(rule("deny", resource)))).not.toThrow();
  for (const action of ["provider.use", "integration.use"] as const)
    expect(() => inspect(info(rule("deny", "*", action)))).not.toThrow();
  // An allow cannot safely establish input-resource authority either.
  expect(() => inspect(info(rule("allow", `${name}:private`)))).toThrow("policy-unsupported");
});

it("uses actual native wildcard details independently of permission matching", () => {
  expect(v2NativePolicyMatches("shell:git", "shell:git *")).toBe(true);
  expect(v2NativePolicyMatches("shell:git status\n--short", "shell:git *")).toBe(true);
  expect(v2NativePolicyMatches("read:C:\\Work\\a.txt", "read:c:/work/?.txt", true)).toBe(true);
  expect(v2NativePolicyMatches("read:C:\\Work\\a.txt", "read:c:/work/?.txt", false)).toBe(false);
  expect(v2NativePolicyMatches("tool:x[y]", "tool:x[y]")).toBe(true);
});

it("cross-delimiter wildcard relevance does not establish universal resource coverage", () => {
  expect(v2NativePolicyMatches(`${name}:private:secret`, "*private:*")).toBe(true);
  for (const resource of ["*private:*", "*?private:*", "bb2_*private:*", "*:*private:*"]) {
    expect(v2NativePolicyMatches(`${name}:xprivate:secret`, resource)).toBe(true);
    for (const effect of ["allow", "deny"] as const)
      expect(() => inspect(info(rule(effect, resource)))).toThrow("policy-unsupported");
  }
  // These globs really can consume the fixed prefix and then extend their final star for any resource.
  for (const resource of ["*threads:*", "bb2_*:*", "bb2_*", "*:*", `${name}:*`]) {
    expect(v2NativePolicyMatches(`${name}:`, resource)).toBe(true);
    expect(() => inspect(info(rule("deny", resource)))).toThrow("policy-denied");
    expect(() => inspect(info(rule("allow", resource)))).not.toThrow();
  }
  expect(() => inspect(info(rule("deny", "other_*private:*")))).not.toThrow();
});

it("a native optional trailing command glob is not a proof of resource independence", () => {
  const resource = `${name}: *`;
  expect(v2NativePolicyMatches(`${name}:`, resource)).toBe(true);
  expect(v2NativePolicyMatches(`${name}:private`, resource)).toBe(false);
  expect(() => inspect(info(rule("deny", resource)))).toThrow("policy-unsupported");
  expect(() =>
    assertV2RequiredToolPolicies(
      [info(rule("allow", "*private:*"))],
      ["bb2_private_threads", name],
    ),
  ).toThrow("policy-unsupported");
});

it("reconciles normalized raw suffixes without merging documents or silently dropping controls", () => {
  const allow = rule("allow"),
    deny = rule("deny");
  const raw = { experimental: { policies: [deny] }, policies: [allow] };
  expect(() => assertV2RawPolicyProjection(raw, info(deny, allow))).not.toThrow();
  // Native normalization may prepend legacy provider-list controls, never unexplained tool/integration rules.
  expect(() =>
    assertV2RawPolicyProjection(raw, info(rule("deny", "*", "provider.use"), deny, allow)),
  ).not.toThrow();
  expect(() => assertV2RawPolicyProjection({ policies: [allow] }, info(deny, allow))).toThrow(
    "policy-unsupported",
  );
  expect(() => assertV2RawPolicyProjection(raw, info(allow, deny))).toThrow("policy-unsupported");
  expect(() => assertV2RawPolicyProjection({ policies: [] }, info(allow))).toThrow(
    "policy-unsupported",
  );
  expect(() => assertV2RawPolicyProjection({}, info(allow))).toThrow("policy-unsupported");
  expect(() =>
    assertV2RawPolicyProjection({}, info(rule("deny", "*", "provider.use"))),
  ).not.toThrow();
  expect(() =>
    assertV2RawPolicyProjection({ policies: [rule("allow", "{env:PRIVATE}")] }, info(allow)),
  ).toThrow("policy-unsupported");
});
