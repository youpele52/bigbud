import { expect, it, vi } from "vitest";
import { sharedServiceNativeFixture } from "./SharedService.native.fixture.ts";
import { v2LocalToolPolicy } from "./Runtime.policy.ts";
import { v2SharedToolPolicy } from "./Runtime.policy.shared.ts";
import { v2PermissionEffect } from "./Runtime.policy.match.ts";
import { PROVIDER_SUBAGENT_CAPABILITIES } from "../../providerSubagents.capabilities.ts";

it("subagent probes cannot launch or inspect an executable without independently approved native isolation", async () => {
  let prepared = false;
  vi.stubEnv("BIGBUD_OPENCODE_V2_NATIVE_APPROVAL_ID", "unapproved-subagent-probe");
  try {
    await expect(
      sharedServiceNativeFixture("/never-read-or-execute/subagent-probe", async () => {
        prepared = true;
      }),
    ).rejects.toThrow("before any retail launch");
    expect(prepared).toBe(false);
  } finally {
    vi.unstubAllEnvs();
  }
});

it("native children remain denied on shared/local/remote/disabled paths in every mode, including named agents", () => {
  for (const mode of ["approval-required", "auto-accept-edits", "full-access"] as const) {
    for (const enabled of [false, true]) {
      const policies = [v2SharedToolPolicy(mode, undefined, enabled)];
      for (const nativeWorkspace of [false, true])
        for (const boundedFiles of [false, true])
          policies.push(
            v2LocalToolPolicy(mode, enabled, true, {
              nativeWorkspace,
              boundedFiles,
              profileRoot: "/owned/profile",
            }),
          );
      for (const policy of policies)
        for (const agent of ["*", "general", "explore", "custom-agent"])
          expect(v2PermissionEffect(policy, "subagent", agent)).toBe("deny");
    }
  }
  expect(PROVIDER_SUBAGENT_CAPABILITIES.opencodeV2).toMatchObject({ support: "gated", fields: [] });
});
