import { it, expect, vi } from "vitest";
import type { RemoteAgentConnection } from "./remoteAgentConnection.ts";
import type { RemoteAgentFrame } from "./remoteAgentProtocol.ts";
import type {
  RemoteAgentServiceLeaseResponse as Response,
  RemoteAgentServiceLeaseStart as Start,
} from "./remoteAgentProtocol.serviceLease.ts";
import {
  connectNativeServiceLeaseClient,
  type NativeServiceLeaseClient,
  assertOriginalNativeServiceLeaseClient,
} from "./remoteAgentServiceLeaseClient.ts";
import {
  launch,
  stateDir,
  response,
  retainedReference,
} from "./remoteAgentServiceLease.test.fixture.ts";
vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    readFile: async (path: string) => {
      if (path === `/proc/${process.pid}/stat`)
        return `${process.pid} (node) ${["S", ...Array<string>(18).fill("0"), "123"].join(" ")}`;
      if (path === "/proc/sys/kernel/random/boot_id") return "fixture-boot\n";
      throw Error("Unexpected synthetic controller fixture read.");
    },
  };
});
/** Protocol rejection/loss fixture only; real native unit authentication is separate. */
function fixture(capabilityMinor = 2) {
  let retained: Start | undefined,
    closed = false,
    starts = 0;
  let mode: "normal" | "lost" | "wrong-controller" | "malformed-cancel" = "normal";
  const waiters: Array<{
    matches?: (frame: RemoteAgentFrame) => boolean;
    resolve: (frame: RemoteAgentFrame) => void;
    reject: (error: Error) => void;
  }> = [];
  const raw = {
    handshake: async () => ({
      agentEpoch: "epoch",
      protocolMinor: 8,
      capabilities: [{ name: "service.lease", major: 1, minor: capabilityMinor }],
    }),
    supportsCapability: () => true,
    nextFrame: (matches?: (frame: RemoteAgentFrame) => boolean) =>
      new Promise<RemoteAgentFrame>((resolve, reject) =>
        waiters.push({ ...(matches ? { matches } : {}), resolve, reject }),
      ),
    send: async (frame: RemoteAgentFrame) => {
      if (!frame.type.startsWith("serviceLease") || !("requestId" in frame.value))
        throw Error("Unexpected fixture request.");
      const value = frame.value;
      if (!("capability" in value)) throw Error("Unexpected response.");
      if (frame.type === "serviceLeaseStartRequest") {
        retained = structuredClone(frame.value);
        starts++;
        if (mode === "lost") return;
      }
      let answer: Response = {
        ...response(retained ?? launch()),
        requestId: value.requestId,
        originalController: { pid: process.pid, boot: "fixture-boot", started: "123" },
        currentController: {
          pid: process.pid + (mode === "wrong-controller" ? 1 : 0),
          boot: "fixture-boot",
          started: "123",
        },
      };
      if (frame.type === "serviceLeaseStatusRequest" && !value.binding)
        answer = {
          ...answer,
          generation: 0,
          state: retained ? "spawned" : "empty",
          binding: retained?.binding,
        };
      if (frame.type === "serviceLeaseControlRequest") {
        if (frame.value.action === "cancel-pending")
          answer = { ...answer, accepted: false, state: "refused" };
        if (frame.value.action === "stop-original")
          answer = { ...answer, state: "exited", generation: 0 };
        if (frame.value.action === "detach") answer = { ...answer, state: "detached" };
      }
      if (mode === "malformed-cancel") answer = { ...answer, state: "cancelled", generation: 2 };
      const type =
        frame.type === "serviceLeaseStartRequest"
          ? "serviceLeaseStartResponse"
          : frame.type === "serviceLeaseResumeRequest"
            ? "serviceLeaseResumeResponse"
            : frame.type === "serviceLeaseControlRequest"
              ? "serviceLeaseControlResponse"
              : "serviceLeaseStatusResponse";
      const reply: RemoteAgentFrame = { type, value: answer };
      queueMicrotask(() => {
        const index = waiters.findIndex((waiter) => !waiter.matches || waiter.matches(reply));
        if (index >= 0) waiters.splice(index, 1)[0]?.resolve(reply);
      });
    },
    closeConfirmed: async () => {
      closed = true;
      for (const waiter of waiters.splice(0))
        waiter.reject(Error("Original fixture proxy closed."));
    },
  };
  return {
    connection: raw as unknown as RemoteAgentConnection,
    reconnect: () => ({ ...raw }) as unknown as RemoteAgentConnection,
    setMode: (value: typeof mode) => {
      mode = value;
    },
    starts: () => starts,
    closed: () => closed,
  };
}
function prepare(client: NativeServiceLeaseClient) {
  const attempt = client.beginAttempt();
  return client.prepareStart(attempt, launch(client.attemptNonce(attempt)));
}
it("lost Start acknowledgement stays uncertain, reconciles original binding and never fabricates cancel", async () => {
  const f = fixture(),
    client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
    });
  assertOriginalNativeServiceLeaseClient(client);
  expect(() => assertOriginalNativeServiceLeaseClient({ ...client })).toThrow(/Original/);
  expect(() => assertOriginalNativeServiceLeaseClient(new Proxy(client, {}))).toThrow(/Original/);
  try {
    const token = prepare(client),
      abort = new AbortController();
    f.setMode("lost");
    const pending = client.start(token, abort.signal);
    const rejected = expect(pending).rejects.toThrow(/unresolved/);
    expect((await client.inventory()).binding?.nonce).toBe(client.binding(token).nonce);
    abort.abort();
    await rejected;
    expect(() => client.originalNeverInvoked(token)).toThrow();
    await expect(client.cancelPending(token)).rejects.toThrow();
    const reconciled = await client.reconcile(token);
    expect(reconciled.state).toBe("live");
    expect(f.starts()).toBe(1);
    const stopped = await client.stopOriginal(token);
    expect(stopped.state).toBe("exited");
    if (stopped.state === "exited")
      expect(client.evidence(stopped.exit).binding.nonce).toBe(client.binding(token).nonce);
  } finally {
    await client.dispose();
    expect(f.closed()).toBe(true);
  }
});
it("denies replayed restored Start, wrong controller and late activation after local cancellation", async () => {
  const f = fixture(),
    client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
    });
  try {
    await expect(client.start(client.restorePending(retainedReference(launch())))).rejects.toThrow(
      /reconciliation/,
    );
    const cancelled = prepare(client);
    client.originalNeverInvoked(cancelled);
    await expect(client.start(cancelled)).rejects.toThrow(/cancelled/);
    f.setMode("wrong-controller");
    await expect(client.start(prepare(client))).rejects.toThrow(/controller/);
    expect(f.starts()).toBe(1);
  } finally {
    await client.dispose();
  }
});
it("detaches bootstrap without stopping original scope and requires explicit correlated teardown", async () => {
  const f = fixture(),
    client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
    });
  try {
    const token = prepare(client),
      lease = await client.start(token);
    expect(client.withBootstrap(lease, (env) => env[0]?.value)).toBe("memory-only-secret");
    await client.detach(lease);
    expect(() => client.withBootstrap(lease, () => true)).toThrow();
    expect(f.starts()).toBe(1);
    expect((await client.stopOriginal(token)).state).toBe("exited");
  } finally {
    await client.dispose();
  }
});

it("never mints a cancel fence from malformed status or stop-original replies", async () => {
  const f = fixture(),
    client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
    });
  try {
    const token = prepare(client);
    await client.start(token);
    f.setMode("malformed-cancel");
    await expect(client.reconcile(token)).rejects.toThrow(/cancellation attestation/);
    await expect(client.stopOriginal(token)).rejects.toThrow(/cancellation attestation/);
  } finally {
    await client.dispose();
  }
});

it("restores teardown correlation without retaining old private bootstrap or inventing launch fields", async () => {
  const f = fixture(),
    first = await connectNativeServiceLeaseClient(f.connection, { nativeEpoch: "epoch", stateDir });
  const attempt = first.beginAttempt(),
    input = launch(first.attemptNonce(attempt));
  const original = retainedReference(input),
    pending = first.prepareStart(attempt, input);
  await first.start(pending);
  await first.dispose();
  const next = await connectNativeServiceLeaseClient(f.reconnect(), {
    nativeEpoch: "epoch",
    stateDir,
  });
  try {
    const retained = next.restorePending(original);
    expect(() => next.originalNeverInvoked(retained)).toThrow();
    await expect(next.start(retained)).rejects.toThrow(/reconciliation/);
    expect((await next.stopOriginal(retained)).state).toBe("exited");
  } finally {
    await next.dispose();
  }
});

it("refuses older lease1.0 before creating an assets-capable owner", async () => {
  const f = fixture(0);
  await expect(
    connectNativeServiceLeaseClient(f.connection, { nativeEpoch: "epoch", stateDir }),
  ).rejects.toThrow(/capability unavailable/);
  expect(f.closed()).toBe(true);
  expect(f.starts()).toBe(0);
});

it("keeps custody1.1 teardown available but denies fresh guard-v2 activation before side effects", async () => {
  const f = fixture(1),
    client = await connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
    });
  try {
    expect(() => client.assertActivationCapability()).toThrow(/guard-v2/);
    expect(() => client.beginAttempt()).toThrow(/guard-v2/);
    const pending = client.restorePending(retainedReference(launch()));
    expect(client.original(pending).binding.nonce).toBe("original-attempt");
    await expect(client.resume(pending)).rejects.toThrow(/guard-v2/);
    expect(f.starts()).toBe(0);
  } finally {
    await client.dispose();
  }
});

it("a managed acquisition rejects a hello outside its pinned runtime before client mint", async () => {
  const f = fixture();
  const { runtime } = await import("./remoteAgentRestart.test.helpers.ts");
  await expect(
    connectNativeServiceLeaseClient(f.connection, {
      nativeEpoch: "epoch",
      stateDir,
      expectedRuntime: runtime("g1"),
    }),
  ).rejects.toThrow("immutable binding");
  expect(f.closed()).toBe(true);
  expect(f.starts()).toBe(0);
});
