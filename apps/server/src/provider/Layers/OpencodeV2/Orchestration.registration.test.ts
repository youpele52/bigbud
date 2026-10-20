import { expect, it } from "vitest";
import { makeV2ThreadPluginFixture } from "./Orchestration.plugin.fixture.ts";
import { makeV2ThreadPluginHost } from "./Orchestration.plugin.host.fixture.ts";
import { v2ThreadRegistration } from "./Orchestration.registration.ts";
import {
  V2_N2_BOOTSTRAP_COMPATIBILITY,
  V2_N2_COMPATIBILITY_DIGEST,
} from "./Orchestration.compatibility.legacy.ts";
import {
  knownV2BootstrapCompatibility,
  assertV2ImplementationCompatible,
} from "./Orchestration.compatibility.ts";
import { v2ThreadImplementation } from "./Orchestration.implementation.ts";
import { createHash } from "node:crypto";

it("freezes the exact previous descriptor and preserves canonical implementation identities", () => {
  expect(
    createHash("sha256").update(JSON.stringify(V2_N2_BOOTSTRAP_COMPATIBILITY)).digest("hex"),
  ).toBe(V2_N2_COMPATIBILITY_DIGEST);
  expect(
    knownV2BootstrapCompatibility(V2_N2_BOOTSTRAP_COMPATIBILITY, V2_N2_COMPATIBILITY_DIGEST),
  ).toBe(V2_N2_BOOTSTRAP_COMPATIBILITY);
  const implementation = v2ThreadImplementation();
  expect(implementation.bootstrapAbi).toBe("bigbud.thread.bootstrap.v1");
  expect(() => assertV2ImplementationCompatible(implementation)).not.toThrow();
  expect(() =>
    assertV2ImplementationCompatible({ ...implementation, schemaDigest: "foreign" }),
  ).toThrow();
});

it.each([
  { legacy: false, reverse: false },
  { legacy: false, reverse: true },
  { legacy: true, reverse: false },
  { legacy: true, reverse: true },
  { legacy: true, reverse: false, sameIssuer: true },
  { legacy: true, reverse: true, sameIssuer: true },
])(
  "isolates registrations in one Location (legacy=$legacy, reverse=$reverse, sameIssuer=$sameIssuer)",
  async ({ legacy, reverse, sameIssuer }) => {
    const a = await makeV2ThreadPluginFixture({ legacyRegistration: legacy }),
      b = await makeV2ThreadPluginFixture(sameIssuer ? { stateRoot: a.root } : {});
    const ownerA = a.bind("native-a", "/workspace"),
      ownerB = b.bind("native-b", "/workspace");
    const hostA = makeV2ThreadPluginHost(ownerA),
      hostB = makeV2ThreadPluginHost(ownerB);
    const ra = v2ThreadRegistration(a.artifact),
      rb = v2ThreadRegistration(b.artifact);
    const handlers = new Map<
      string,
      Record<
        string,
        (input: unknown, ctx: { signal: AbortSignal }) => Promise<Record<string, unknown>>
      >
    >();
    const hooks = new Map<
      string,
      Set<(event: { sessionID: string; tools: Record<string, unknown> }) => Promise<void>>
    >();
    const context = {
      ...hostA.context,
      session: {
        get: async ({ sessionID }: { sessionID: string }) =>
          sessionID === ownerA.nativeSessionId
            ? hostA.context.session.get({ sessionID })
            : hostB.context.session.get({ sessionID }),
        hook: async (
          kind: string,
          hook: (event: { sessionID: string; tools: Record<string, unknown> }) => Promise<void>,
        ) => {
          const group = hooks.get(kind) ?? new Set();
          group.add(hook);
          hooks.set(kind, group);
          return {
            dispose: async () => {
              group.delete(hook);
            },
          };
        },
      },
      rpc: {
        register: async (
          definition: { id: string },
          methods: typeof handlers extends Map<string, infer V> ? V : never,
        ) => {
          if (handlers.has(definition.id)) throw new Error("RPC collision");
          handlers.set(definition.id, methods);
          return {
            dispose: async () => {
              if (handlers.get(definition.id) === methods) handlers.delete(definition.id);
            },
          };
        },
      },
    };
    const call = (id: string, method: string, value: unknown = {}) =>
      handlers.get(id)![method]!(value, { signal: new AbortController().signal });
    const request = async (sessionID: string, kind = "context") => {
      const event = {
        sessionID,
        tools: Object.fromEntries(
          [...hostA.tools].map(([name, tool]) => [
            name,
            { description: tool.description, input: tool.input },
          ]),
        ),
      };
      for (const hook of hooks.get(kind) ?? []) await hook(event);
      return Object.keys(event.tools).toSorted();
    };
    const disposers = new Map<string, () => Promise<void>>();
    try {
      for (const app of reverse ? [b, a] : [a, b]) {
        const plugin = (await import(/* @vite-ignore */ app.artifact.entryUri)).default;
        disposers.set(v2ThreadRegistration(app.artifact).id, await plugin.setup(context));
      }
      expect(handlers.size).toBe(2);
      expect(hostA.tools.size).toBe(10);
      expect(ra.tools.every((name) => name.length < 64)).toBe(true);
      await Promise.all([
        call(ra.id, "enroll", a.envelope("enroll", 1, Date.now() + 50000)),
        call(rb.id, "enroll", b.envelope("enroll", 1, Date.now() + 50000)),
      ]);
      expect(await request(ownerA.nativeSessionId)).toEqual(ra.tools.toSorted());
      expect(await request(ownerB.nativeSessionId)).toEqual(rb.tools.toSorted());
      expect(await request("unowned")).toEqual([]);
      expect(await request(ownerA.nativeSessionId, "generate")).toEqual([]);
      expect(await request(ownerB.nativeSessionId, "compaction")).toEqual([]);
      if (sameIssuer)
        await expect(call(rb.id, "inspect", a.envelope("inspect"))).resolves.toMatchObject({
          state: "missing",
        });
      else await expect(call(rb.id, "inspect", a.envelope("inspect"))).rejects.toThrow();
      await expect(
        call(rb.id, "enroll", a.envelope("enroll", 2, Date.now() + 50000)),
      ).rejects.toThrow();
      const tool = hostA.tools.get(ra.tool("list_threads"))!;
      await expect(
        tool.execute(
          {},
          {
            sessionID: ownerB.nativeSessionId,
            messageID: "m",
            id: "call",
            agent: "build",
            signal: new AbortController().signal,
          },
        ),
      ).rejects.toThrow();
      await expect(
        tool.execute(
          {},
          {
            sessionID: ownerA.nativeSessionId,
            messageID: "m",
            id: "call",
            agent: "build",
            signal: new AbortController().signal,
          },
        ),
      ).resolves.toHaveProperty("content");
      expect(a.state.invocations).toHaveLength(1);
      expect(b.state.invocations).toHaveLength(0);
      await call(ra.id, "detach", a.envelope("detach"));
      await expect(request(ownerA.nativeSessionId)).rejects.toThrow();
      expect(await request(ownerB.nativeSessionId)).toEqual(rb.tools.toSorted());
      await disposers.get(ra.id)!();
      disposers.delete(ra.id);
      expect(hostA.tools.size).toBe(5);
      expect(await request(ownerB.nativeSessionId)).toEqual(rb.tools.toSorted());
    } finally {
      for (const dispose of disposers.values()) await dispose();
      await Promise.all([a.close(), b.close()]);
    }
  },
);

it("full issuers remain distinct when bounded tool namespaces collide", () => {
  const compatibility = { bootstrapAbi: "bigbud.thread.bootstrap.v2" };
  const a = v2ThreadRegistration({ issuer: "a".repeat(64), compatibility });
  const b = v2ThreadRegistration({ issuer: "a".repeat(32) + "b".repeat(32), compatibility });
  expect(a.tools).toEqual(b.tools);
  expect(a.id).not.toBe(b.id);
  expect(a.filename).not.toBe(b.filename);
  expect(() => v2ThreadRegistration({ issuer: "../untrusted", compatibility })).toThrow();
});
