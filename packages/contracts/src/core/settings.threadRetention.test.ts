import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { ServerSettings, ServerSettingsPatch } from "./settings";
import {
  FINITE_THREAD_RETENTION_POLICIES,
  THREAD_RETENTION_POLICIES,
  ThreadRetentionPolicy,
} from "./settings.threadRetention";
import {
  ServerSetThreadRetentionPolicyInput,
  ServerStartThreadRetentionInput,
  ThreadRetentionConsentChallenge,
} from "../server/threadRetention";

describe("thread retention settings", () => {
  it("decodes every stable policy and rejects milliseconds and unknown values", () => {
    for (const policy of THREAD_RETENTION_POLICIES) {
      expect(Schema.decodeUnknownSync(ThreadRetentionPolicy)(policy)).toBe(policy);
    }

    expect(() => Schema.decodeUnknownSync(ThreadRetentionPolicy)(604_800_000)).toThrow();
    expect(() => Schema.decodeUnknownSync(ThreadRetentionPolicy)("1-year")).toThrow();
  });

  it("keeps absent retention settings safe until rollout initialization persists a value", () => {
    expect(Schema.decodeUnknownSync(ServerSettings)({}).threadRetentionPolicy).toBe("never");
  });

  it("does not allow generic settings patches to change retention policy", () => {
    const patch = Schema.decodeUnknownSync(ServerSettingsPatch)({
      threadRetentionPolicy: "7-days",
    });
    expect(patch).not.toHaveProperty("threadRetentionPolicy");
  });

  it("requires a server-issued challenge for finite policy activation and manual start", () => {
    for (const policy of FINITE_THREAD_RETENTION_POLICIES) {
      expect(() =>
        Schema.decodeUnknownSync(ServerSetThreadRetentionPolicyInput)({ policy }),
      ).toThrow();
    }
    expect(() => Schema.decodeUnknownSync(ServerStartThreadRetentionInput)({})).toThrow();

    const challenge = Schema.decodeUnknownSync(ThreadRetentionConsentChallenge)({
      token: "single-use-token",
      trigger: "manual",
      policy: "7-days",
      cutoffAt: "2026-07-28T00:00:00.000Z",
      expiresAt: "2026-08-04T00:05:00.000Z",
      singleUse: true,
    });
    expect(challenge.policy).toBe("7-days");
  });
});
