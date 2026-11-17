import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import {
  RemoteBackendDeploymentInput,
  RemoteBackendDeploymentResult,
} from "./remoteBackendDeployment";

it("accepts only an exact request nonce and an explicit boot choice", () => {
  const input = {
    executionTargetId: "ssh:host=vps.example&transport=agent",
    requestId: "11111111-2222-4333-8444-555555555555",
    enableBoot: false,
  };
  expect(Schema.decodeUnknownSync(RemoteBackendDeploymentInput)(input)).toEqual(input);
  for (const bad of [
    { ...input, requestId: "not-a-uuid" },
    { ...input, enableBoot: undefined },
    { ...input, executionTargetId: "" },
  ])
    expect(() => Schema.decodeUnknownSync(RemoteBackendDeploymentInput)(bad)).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(RemoteBackendDeploymentResult)({
      profileId: "rb-x",
      authority: {
        authorityId: "a".repeat(32),
        keyFingerprint: `sha256:${"b".repeat(64)}`,
        keyEpoch: 1,
      },
      status: "running",
    }),
  ).toThrow();
});
