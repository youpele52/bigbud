import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import { afterEach, expect, it, vi } from "vitest";
import type { RemoteMobileNativeInputsValue } from "./mobileGatewayActivation.inputs.ts";
import {
  runNativeMobileActivation,
  type NativeMobileActivationOutcome,
} from "./mobileGatewayActivation.launch.ts";
import {
  NativeMobileGatewaySessionError,
  type NativeMobileGatewaySessionSignals,
} from "./mobileGatewayNative.session.ts";

// Recorded seams only: authority, journal, publisher, selection CAS and the native session.
const script = vi.hoisted(() => ({
  events: [] as string[],
  authority: true,
  journal: {} as unknown,
  selection: undefined as Error | undefined,
  session: undefined as unknown,
  sessionSignals: undefined as NativeMobileGatewaySessionSignals | undefined,
  lifetime: new AbortController(),
}));
vi.mock("./mobileGatewayActivation.authority.ts", async () => {
  const { Effect } = await import("effect");
  return {
    acquireMobileGatewayActivationAuthority: Effect.suspend(() => {
      script.events.push(script.authority ? "authority" : "authority:failed");
      if (!script.authority) return Effect.fail(Error("not Linux"));
      return Effect.succeed({
        registry: () => ({
          read: async () => (script.events.push("journal"), script.journal),
        }),
      });
    }),
  };
});
vi.mock("../remote-agent/mobileOptionalPublication.ts", async () => {
  const { Effect, Data } = await import("effect");
  const proof = Object.freeze({ proof: true });
  const publisher = {
    publish: async (request: { gatewayBytes: Uint8Array; consentRevision: number }) => {
      script.events.push(`publish:${request.consentRevision}:${request.gatewayBytes.length}`);
      return proof;
    },
    remint: async (stageId: string, revision: number) => {
      script.events.push(`remint:${stageId}:${revision}`);
      return proof;
    },
  };
  class PublicationFixtureError extends Data.TaggedError("PublicationFixtureError")<{
    readonly cause: unknown;
  }> {}
  return {
    withMobileOptionalPublisher: (_keys: unknown, operation: Function) =>
      Effect.tryPromise({
        try: () => operation(publisher, script.lifetime.signal),
        catch: (cause) => new PublicationFixtureError({ cause }),
      }),
  };
});
vi.mock("./mobileGatewayActivation.selection.ts", async () => {
  const { Effect } = await import("effect");
  return {
    commitMobileGatewayDesiredSelection: (_proof: unknown, requestId: string) =>
      Effect.suspend(() => {
        script.events.push(`select:${requestId}`);
        return script.selection ? Effect.fail(script.selection) : Effect.succeed({});
      }),
  };
});
vi.mock("./mobileGatewayNative.session.ts", async (importOriginal) => {
  const { Effect } = await import("effect");
  return {
    ...(await importOriginal<object>()),
    runNativeMobileGatewaySession: (
      _proof: unknown,
      _configuration: unknown,
      signals: NativeMobileGatewaySessionSignals,
    ) =>
      Effect.suspend(() => {
        script.events.push("session");
        script.sessionSignals = signals;
        return script.session as Effect.Effect<unknown, Error>;
      }),
  };
});

const requestId = "00000000-0000-4000-8000-000000000001";
const request = { requestId, configuration: { externalOrigin: "https://f.ts.net", port: 49322 } };
const journal = (enabled = true, phase = "artifact-bytes-verified") => ({
  schemaVersion: 3,
  mobile: { consent: { revision: 2, enabled }, stages: [{ id: "s1", consentRevision: 2, phase }] },
});
const inputs = (dir = "/nonexistent"): RemoteMobileNativeInputsValue => ({
  trustedKeys: { k: "pem" },
  artifacts: {
    stageId: "s1",
    gateway: {},
    assets: {},
    gatewayPath: join(dir, "gateway"),
    assetsPath: join(dir, "assets"),
  },
});
const completed = (disposition: string) =>
  Effect.succeed({ kind: "completed", disposition, value: undefined });
async function launch(value = inputs()) {
  const signals = { detach: new AbortController(), stop: new AbortController() };
  const outcome = await Effect.runPromise(
    runNativeMobileActivation(
      value,
      request,
      { detach: signals.detach.signal, stop: signals.stop.signal },
      () => script.events.push("selected"),
    ) as Effect.Effect<NativeMobileActivationOutcome>,
  );
  return { outcome, signals };
}
afterEach(() => {
  script.events.length = 0;
  script.authority = true;
  script.selection = undefined;
  script.lifetime = new AbortController();
});

it("publishes the input pair, commits selection, acknowledges, then runs the session", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "bigbud-activation-"));
  try {
    await fs.writeFile(join(dir, "gateway"), "abc");
    await fs.writeFile(join(dir, "assets"), "defg");
    script.journal = journal();
    script.session = completed("exit-recorded");
    expect((await launch(inputs(dir))).outcome).toEqual({ kind: "exit-recorded" });
    expect(script.events).toEqual([
      "authority",
      "journal",
      "publish:2:3",
      `select:${requestId}`,
      "selected",
      "session",
    ]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it("remints an already-published stage of the current consent without reading files", async () => {
  script.journal = journal(true, "files-published");
  script.session = completed("detached");
  expect((await launch()).outcome).toEqual({ kind: "detached" });
  expect(script.events.slice(0, 3)).toEqual(["authority", "journal", "remint:s1:2"]);
});

it("is unavailable without the activation authority and disabled without durable consent", async () => {
  script.authority = false;
  expect((await launch()).outcome).toEqual({ kind: "unavailable" });
  expect(script.events).toEqual(["authority:failed"]);
  script.authority = true;
  script.events.length = 0;
  script.journal = journal(false);
  expect((await launch()).outcome).toEqual({ kind: "disabled" });
  expect(script.events).toEqual(["authority", "journal"]);
});

it("a selection failure never reaches the session and is not repair-required", async () => {
  script.journal = journal(true, "files-published");
  script.selection = Error("stale P4 binding");
  const { outcome } = await launch();
  expect(outcome).toMatchObject({ kind: "failed", repairRequired: false });
  expect(script.events).not.toContain("selected");
  expect(script.events).not.toContain("session");
});

it("keeps the session's repair classification and treats defects as repair-required", async () => {
  script.journal = journal(true, "files-published");
  for (const [session, repairRequired] of [
    [
      Effect.fail(new NativeMobileGatewaySessionError({ message: "x", repairRequired: true })),
      true,
    ],
    [
      Effect.fail(new NativeMobileGatewaySessionError({ message: "x", repairRequired: false })),
      false,
    ],
    [Effect.die(Error("defect")), true],
  ] as const) {
    script.session = session;
    expect((await launch()).outcome).toMatchObject({ kind: "failed", repairRequired });
  }
});

it("losing the publication lifetime detaches the session, never stops it", async () => {
  script.journal = journal(true, "files-published");
  script.session = completed("detached");
  await launch();
  script.lifetime.abort();
  expect(script.sessionSignals!.detach.aborted).toBe(true);
  expect(script.sessionSignals!.stop.aborted).toBe(false);
});
