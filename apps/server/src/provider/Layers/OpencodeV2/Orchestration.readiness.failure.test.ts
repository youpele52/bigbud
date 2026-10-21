import { expect, it, vi } from "vitest";
import { verifyV2ThreadTools } from "./Orchestration.readiness.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { V2_ENROLLMENT_PROTOCOL } from "./Orchestration.protocol.ts";
import { V2ReadinessError, v2ReadinessFailure } from "./Orchestration.readiness.failure.ts";
import type { V2NativeRuntimeProof } from "./NativeCompatibility.types.ts";
import type { OpencodeV2Client } from "./Client.ts";

const io = vi.hoisted(() => ({ rpc: vi.fn(), source: vi.fn() }));
vi.mock("./Client.guard.orchestration.ts", () => ({ callV2ThreadRpc: io.rpc }));
vi.mock("./Orchestration.readiness.source.ts", () => ({ assertV2NativeThreadSource: io.source }));
vi.mock("./NativeCompatibility.policy.ts", () => ({ assertV2NativeRuntimePolicy: async () => {} }));

it.each(["artifact", "rpc-info", "source"] as const)(
  "records actual %s verification phase without retaining SDK data",
  async (operation) => {
    const app = await makeV2ThreadPluginFixture();
    const secret = new Error(
      "request https://secret.invalid?token=credential contained a private prompt",
    );
    const registration = v2ThreadRegistration(app.artifact);
    io.rpc.mockResolvedValue({
      protocol: registration.id,
      issuer: app.artifact.issuer,
      artifactDigest: app.artifact.artifactDigest,
      bootstrapDigest: app.artifact.artifactDigest,
      bootstrapAbi: app.artifact.compatibility.bootstrapAbi,
      enrollmentProtocol: V2_ENROLLMENT_PROTOCOL,
      compatibilityDigest: app.artifact.compatibilityDigest,
      schemaDigest: v2ThreadImplementation().schemaDigest,
      setupInstanceId: "a".repeat(32),
      nativeVersion: "2.0.32",
      tools: registration.tools,
    });
    io.source.mockResolvedValue(undefined);
    const artifact = {
      ...app.artifact,
      verify:
        operation === "artifact"
          ? async () => {
              throw secret;
            }
          : app.artifact.verify,
    };
    if (operation === "rpc-info") io.rpc.mockRejectedValue(secret);
    if (operation === "source") io.source.mockRejectedValue(secret);
    const proof = { nativeVersion: "2.0.32", assertCurrent: () => {} } as V2NativeRuntimeProof;
    try {
      const error = await verifyV2ThreadTools(
        artifact,
        {} as OpencodeV2Client,
        app.root,
        undefined,
        undefined,
        async () => proof,
        app.root,
      ).catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(V2ReadinessError);
      expect(v2ReadinessFailure(error)).toEqual({ operation, reason: "unconfirmed" });
      expect(String(error)).not.toContain("secret.invalid");
      expect(String(error)).not.toContain("private prompt");
      expect((error as Error).cause).toBeUndefined();
    } finally {
      await app.close();
    }
  },
);
