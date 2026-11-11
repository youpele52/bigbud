import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { validateV2PreparedBody } from "./Orchestration.implementation.boundary.ts";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  knownV2BootstrapCompatibility,
  assertV2ImplementationCompatible,
} from "./Orchestration.compatibility.ts";
import {
  V2_N8_BOOTSTRAP_COMPATIBILITY,
  V2_N8_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.n8.ts";

it("v5 admits only its own summary while retained handlers and ABI4 remain frozen", () => {
  expect(
    createHash("sha256").update(JSON.stringify(V2_N8_BOOTSTRAP_COMPATIBILITY)).digest("hex"),
  ).toBe(V2_N8_COMPATIBILITY_DIGEST);
  expect(
    knownV2BootstrapCompatibility(V2_N8_BOOTSTRAP_COMPATIBILITY, V2_N8_COMPATIBILITY_DIGEST),
  ).toBe(V2_N8_BOOTSTRAP_COMPATIBILITY);
  const current = v2ThreadImplementation();
  expect(current.bootstrapAbi).toBe("bigbud.thread.bootstrap.v5");
  expect(() => assertV2ImplementationCompatible(current)).not.toThrow();
  const prepared = current.prepare({
    action: "set_elevator_summary",
    input: { summary: "Own summary" },
    callerThreadId: "owner",
  });
  expect(validateV2PreparedBody("set_elevator_summary", prepared, "owner")).toEqual({
    action: "set_elevator_summary",
    threadId: "owner",
    summary: "Own summary",
  });
  for (const input of [
    { summary: "Own summary", threadId: "foreign" },
    { summary: "Own summary", targetThreadId: "foreign" },
    { summary: "Own summary", callerThreadId: "foreign" },
    { summary: " " },
    { summary: 1 },
    {},
  ])
    expect(() =>
      current.prepare({ action: "set_elevator_summary", input, callerThreadId: "owner" }),
    ).toThrow();
  expect(() =>
    validateV2PreparedBody("set_elevator_summary", { ...prepared, threadId: "foreign" }, "owner"),
  ).toThrow();
  for (const version of ["v1", "v2", "v3", "v4"] as const) {
    expect(() =>
      v2ThreadImplementation(version).prepare({
        action: "set_elevator_summary" as never,
        input: { summary: "Own summary" },
        callerThreadId: "owner",
      }),
    ).toThrow();
  }
  expect(() =>
    assertV2ImplementationCompatible(v2ThreadImplementation("v4"), V2_N8_BOOTSTRAP_COMPATIBILITY),
  ).not.toThrow();
});

it("ABI5 exposes seven issuer-scoped tools only to the enrolled session with trusted summary identity", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("summary-session", app.root);
    const host = makeV2ThreadPluginHost(owner);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    const cleanup = await plugin.setup(host.context);
    try {
      const registration = v2ThreadRegistration(app.artifact);
      expect(registration.tools).toHaveLength(7);
      const name = registration.tool("set_elevator_summary");
      expect(
        v2ThreadRegistration({ issuer: owner.issuer, compatibility: V2_N8_BOOTSTRAP_COMPATIBILITY })
          .tools,
      ).not.toContain(name);
      expect((await host.request("unowned")).tools[name]).toBeUndefined();
      await host.call("enroll", app.envelope("enroll", 1, Date.now() + 40000));
      expect((await host.request(owner.nativeSessionId)).tools[name]).toBeDefined();
      const context = {
        sessionID: owner.nativeSessionId,
        messageID: "message",
        id: "call",
        agent: "build",
        signal: new AbortController().signal,
      };
      await expect(
        host.tools
          .get(name)!
          .execute({ summary: "Own summary" }, { ...context, sessionID: "foreign" }),
      ).rejects.toThrow();
      await host.tools.get(name)!.execute({ summary: "Own summary" }, context);
      expect(app.state.invocations).toHaveLength(1);
      expect(app.state.invocations[0]).toMatchObject({
        action: "set_elevator_summary",
        input: { summary: "Own summary" },
        messageID: "message",
        callID: "call",
      });
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});
