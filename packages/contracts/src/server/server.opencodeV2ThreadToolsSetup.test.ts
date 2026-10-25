import * as Schema from "effect/Schema";
import { expect, it } from "vitest";
import {
  ServerOpencodeV2ThreadToolsSetupInput,
  ServerOpencodeV2ThreadToolsSetupResult,
} from "./server.opencodeV2ThreadToolsSetup";

it("legacy refresh still decodes as setup, while status/cancellation are discriminated even with default excess-field stripping", () => {
  const decode = Schema.decodeUnknownSync(ServerOpencodeV2ThreadToolsSetupInput);
  expect(decode({})).toEqual({ refresh: false });
  expect(decode({ refresh: true })).toEqual({ refresh: true });
  const jobId = "a".repeat(32),
    interestId = "b".repeat(32);
  expect(decode({ operation: "status", jobId, refresh: true })).toEqual({
    operation: "status",
    jobId,
  });
  expect(decode({ operation: "cancel-interest", jobId, interestId, refresh: true })).toEqual({
    operation: "cancel-interest",
    jobId,
    interestId,
  });
  expect(() => decode({ operation: "status", jobId: "unknown" })).toThrow();
  expect(() => decode({ operation: "install-anything", refresh: true })).toThrow();
});

it("runtime-checked setup can be ready with an unqualified warning and no completed-evidence identity", () => {
  const value = Schema.decodeUnknownSync(ServerOpencodeV2ThreadToolsSetupResult)({
    status: "ready",
    directory: "/fixture/worktree",
    artifactDirectoryUri: "file:///fixture/artifact",
    artifactDigest: "a".repeat(64),
    issuerKeyId: "fixture-issuer",
    configAddition: { plugins: [] },
    message: "Runtime checks passed; semantic qualification incomplete.",
    severity: "warning",
    activationState: "ready",
    qualificationState: "unqualified",
  });
  expect(value.qualificationState).toBe("unqualified");
  expect(value).not.toHaveProperty("qualificationRecordId");
});
