import { expect, it, vi } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { V2ThreadRecords } from "./Orchestration.records.ts";
import { V2ThreadEnrollment } from "./Orchestration.enrollment.ts";
import { makeV2Client } from "./Client.ts";
import { runV2RequestContext } from "./Client.guard.ts";

it("retirement cannot issue detach after an inspect reply crosses its caller gate deadline", async () => {
  const app = await makeV2ThreadPluginFixture(),
    controller = new AbortController();
  try {
    const owner = app.bind("owned-deadline-session", app.root),
      envelope = app.envelope("enroll", 1, Date.now() + 30000);
    const records = await V2ThreadRecords.open(
      app.artifact.root,
      "enrollments",
      app.artifact.privateKey,
      app.artifact.publicKey,
    );
    let expiry = 0;
    const calls: string[] = [],
      fetch = Object.assign(
        vi.fn(async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
          const method = new URL(String(input)).pathname.split("/").at(-1)!;
          calls.push(method);
          if (method === "enroll") expiry = JSON.parse(String(init?.body)).input.leaseExpiresAt;
          if (method === "inspect") queueMicrotask(() => controller.abort());
          return Response.json({
            output: {
              ownerDigest: envelope.ownerDigest,
              enrollmentNonce: owner.enrollmentNonce,
              state: method === "detach" ? "revoked" : "active",
              revision: 1,
              expiry,
            },
          });
        }),
        { preconnect: () => {} },
      ) as unknown as typeof globalThis.fetch;
    const enrollment = new V2ThreadEnrollment({
      records,
      privateKey: app.artifact.privateKey,
      owner,
      transport: "owned-deadline-transport",
      assertCurrent: () => {},
      client: makeV2Client({
        endpoint: "http://127.0.0.1:49997",
        sharedTransport: "owned-deadline-transport",
        fetch,
      }),
    });
    await runV2RequestContext(
      {
        transport: "owned-deadline-transport",
        intent: "execute",
        permit: {
          revision: 1,
          signal: new AbortController().signal,
          assertCurrent: () => {},
          release: () => {},
        },
      },
      () => enrollment.start(),
    );
    calls.length = 0;
    const detach = enrollment.detach.bind(enrollment) as (signal: AbortSignal) => Promise<boolean>;
    await expect(detach(controller.signal)).rejects.toThrow();
    expect(calls).toEqual(["inspect"]);
    expect(await (await records.sibling("retirements")).entries()).toHaveLength(1);
  } finally {
    await app.close();
  }
});
