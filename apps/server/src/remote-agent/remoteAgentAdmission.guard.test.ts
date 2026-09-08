import { describe, expect, it } from "vitest";
import {
  RemoteAgentAdmissionRateLimitError,
  withRemoteAgentAdmissionGuard,
} from "./remoteAgentAdmission.guard.ts";

describe("remote-agent admission guard", () => {
  it("evicts completed target windows instead of permanently exhausting target capacity", async () => {
    const prefix = `completed-${crypto.randomUUID()}`;
    for (let index = 0; index < 1_024; index += 1) {
      await withRemoteAgentAdmissionGuard(`${prefix}-${index}`, "request", async () => undefined);
    }

    await expect(
      withRemoteAgentAdmissionGuard(`${prefix}-1024`, "request", async () => "admitted"),
    ).resolves.toBe("admitted");
  });

  it("does not evict active admissions to admit a new target", async () => {
    const prefix = `active-${crypto.randomUUID()}`;
    let release!: () => void;
    const active = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admissions = Array.from({ length: 1_024 }, (_, index) =>
      withRemoteAgentAdmissionGuard(`${prefix}-${index}`, "request", () => active),
    );

    await expect(
      withRemoteAgentAdmissionGuard(`${prefix}-overflow`, "request", async () => undefined),
    ).rejects.toBeInstanceOf(RemoteAgentAdmissionRateLimitError);

    release();
    await Promise.all(admissions);
  });
});
