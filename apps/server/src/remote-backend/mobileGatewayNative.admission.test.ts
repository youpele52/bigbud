import "../remote-agent/mobileGatewayLifecycle.native.test-boundaries.ts";
import { afterEach, expect, it, vi } from "vitest";
import {
  exitedReply,
  refusedReply,
} from "../remote-agent/remoteAgentServiceLease.successor.fixture.ts";
import { spawnedReply } from "./mobileGatewayActivation.native.fixture.ts";
import { MobileGatewayAdmissionRevoked } from "./mobileGatewayOwner.read.ts";
import {
  editAttempt,
  setConsent,
  withNativeAdmission,
} from "./mobileGatewayNative.admission.fixture.ts";

/** The same original scope reported live at a different (successor) generation. */
const successorGeneration = {
  state: "spawned",
  generation: 3,
  bootstrap: [],
  previousController: undefined,
} as const;
const statusFrames = (wire: () => string[]) => wire().filter((kind) => kind === "status").length;
const refused = async (read: Promise<unknown>) => {
  const cause = await read.then(
    () => Error("Native admission unexpectedly admitted."),
    (error: unknown) => error,
  );
  expect(cause).toBeInstanceOf(Error);
  expect(cause).not.toBeInstanceOf(MobileGatewayAdmissionRevoked);
  return cause as Error;
};
afterEach(() => {
  vi.restoreAllMocks();
});

it("admits a live original lease at its generation and batches concurrent reads", async () => {
  await withNativeAdmission({ status: [spawnedReply, spawnedReply] }, async (f) => {
    const [first, second] = await Promise.all([f.admission.read(), f.admission.read()]);
    expect(first).toEqual(second);
    expect(first.backendExternalOrigin).toBe("https://fixture.example");
    expect(first.consentRevision).toBe(1);
    expect(statusFrames(f.wire)).toBe(1);
    await f.admission.read();
    expect(statusFrames(f.wire)).toBe(2);
  });
});

it("revokes a native generation change instead of admitting the successor grant", async () => {
  await withNativeAdmission({ status: [successorGeneration] }, async (f) => {
    await expect(f.admission.read()).rejects.toBeInstanceOf(MobileGatewayAdmissionRevoked);
  });
});

it("refuses an exited or uncertain native scope without admitting", async () => {
  await withNativeAdmission({ status: [exitedReply, refusedReply] }, async (f) => {
    await refused(f.admission.read());
    await refused(f.admission.read());
    expect(statusFrames(f.wire)).toBe(2);
  });
});

it("treats the owner client's own IO timeout as uncertain, never admitted", async () => {
  await withNativeAdmission({ status: ["lost"] }, async (f) => {
    const deadline = new AbortController();
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) =>
      ms === 20_000 ? deadline.signal : timeout(ms),
    );
    const read = f.admission.read();
    await vi.waitFor(() => expect(statusFrames(f.wire)).toBe(1));
    deadline.abort();
    expect((await refused(read)).message).toMatch(/original acceptance remains unresolved/);
  });
});

it("refuses a journal row that is not attempted, both at capture and after a change", async () => {
  const capture = await withNativeAdmission({ skipInvoked: true }, async () => {}).then(
    () => undefined,
    (cause: unknown) => cause as { readonly cause?: unknown },
  );
  expect(capture?.cause).toEqual(Error("Original attempted native gateway admission unavailable."));
  await withNativeAdmission({ status: [spawnedReply] }, async (f) => {
    await f.mirror((state) =>
      editAttempt(state, (attempt) => ({
        phase: "exit-confirmed",
        exitedAtUnixMs: attempt.attemptedAtUnixMs,
        completionEvidence: { kind: "native-cancel" },
      })),
    );
    expect((await refused(f.admission.read())).message).toMatch(/admission ended/);
    expect(statusFrames(f.wire)).toBe(0);
  });
});

it("refuses durable consent off and revokes a changed consent revision", async () => {
  await withNativeAdmission({ status: [spawnedReply] }, async (f) => {
    await f.mirror((state) => setConsent(state, false));
    expect((await refused(f.admission.read())).message).toMatch(/consent ended/);
    // Re-enabled consent is a new revision: the old admission is revoked, never resurrected.
    await f.mirror((state) => setConsent(setConsent(state, false), true));
    await expect(f.admission.read()).rejects.toBeInstanceOf(MobileGatewayAdmissionRevoked);
    expect(statusFrames(f.wire)).toBe(0);
  });
});

it("refuses every read once the admission is closed", async () => {
  await withNativeAdmission({}, async (f) => {
    await f.admission.close();
    await refused(f.admission.read());
    expect(statusFrames(f.wire)).toBe(0);
  });
});
