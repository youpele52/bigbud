import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import {
  assertV2ImplementationCompatible,
  knownV2BootstrapCompatibility,
} from "./Orchestration.compatibility.ts";
import {
  V2_N6_BOOTSTRAP_COMPATIBILITY,
  V2_N6_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import { validateV2PreparedBody } from "./Orchestration.implementation.boundary.ts";

it("keeps the historical closure/descriptor frozen and admits HTML only through the new ABI", () => {
  const retained = v2ThreadImplementation("v1");
  expect(retained.implementationDigest).toBe(
    "e0cebb961e8dffc6184318d7b4d66acbb586c14f2668ddada547be878dbc2bf2",
  );
  expect(
    knownV2BootstrapCompatibility(V2_N6_BOOTSTRAP_COMPATIBILITY, V2_N6_COMPATIBILITY_DIGEST),
  ).toBe(V2_N6_BOOTSTRAP_COMPATIBILITY);
  expect(() =>
    assertV2ImplementationCompatible(retained, V2_N6_BOOTSTRAP_COMPATIBILITY),
  ).not.toThrow();
  expect(() => assertV2ImplementationCompatible(retained)).toThrow();
  const current = v2ThreadImplementation();
  expect(current.bootstrapAbi).toBe("bigbud.thread.bootstrap.v5");
  const input = { title: "Chart", html: "<p>Chart</p>" };
  expect(
    validateV2PreparedBody(
      "render_html",
      current.prepare({ action: "render_html", input, callerThreadId: "owner" }),
      "owner",
    ),
  ).toEqual({ action: "render_html", htmlArguments: input });
  expect(() =>
    current.prepare({
      action: "render_html",
      input: { ...input, threadId: "foreign" },
      callerThreadId: "owner",
    }),
  ).toThrow();
  expect(() =>
    retained.prepare({ action: "render_html", input, callerThreadId: "owner" }),
  ).toThrow();
});

it("publishes the sixth native tool only to its enrolled session and carries trusted invocation context", async () => {
  const app = await makeV2ThreadPluginFixture();
  try {
    const owner = app.bind("html-session", app.root);
    const host = makeV2ThreadPluginHost(owner);
    const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
    const cleanup = await plugin.setup(host.context);
    try {
      await host.call("enroll", app.envelope("enroll", 1, Date.now() + 40000));
      const name = v2ThreadRegistration(app.artifact).tool("render_html");
      expect((await host.request("foreign-session")).tools[name]).toBeUndefined();
      expect((await host.request(owner.nativeSessionId)).tools[name]).toBeDefined();
      await host.tools.get(name)!.execute(
        { title: "Chart", html: "<p>Chart</p>" },
        {
          sessionID: owner.nativeSessionId,
          messageID: "native-message",
          id: "native-call",
          agent: "build",
          signal: new AbortController().signal,
        },
      );
      expect(app.state.invocations[0]).toMatchObject({
        action: "render_html",
        messageID: "native-message",
        callID: "native-call",
      });
      expect(
        v2ThreadRegistration({ issuer: owner.issuer, compatibility: V2_N6_BOOTSTRAP_COMPATIBILITY })
          .tools,
      ).not.toContain(name);
    } finally {
      await cleanup();
    }
  } finally {
    await app.close();
  }
});
